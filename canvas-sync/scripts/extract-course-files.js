// extract-course-files.js — per-class course-file text extractor.
//
// CLI: node scripts/extract-course-files.js <classDir>
//
// Iterates entries in <classDir>/files_index.json, extracts text for each
// (pptx/docx/xlsx/pdf/txt/md/html/images), writes materials/<name>.txt per
// file, dedupes by text-SHA-256, and rolls a materials/_combined.txt.
//
// OCR memory: tesseract.js workers can balloon for large scanned PDFs. We
// therefore keep at most ONE tesseract worker alive at a time and only use it
// when native PDF text extraction returns < 200 chars (or for standalone
// images). After each file we call `worker.terminate()` before moving on,
// trading per-file spin-up cost for bounded memory. Per the plan, true
// page-by-page streaming on scanned PDFs requires rendering PDF pages to
// images via pdfjs-dist + node-canvas, which is out of scope for v1.1; for
// now a scanned PDF is flagged low-confidence with whatever native text
// pdf-parse recovered. See `// OPEN:` below.
//
// Within a class: serial processing to cap peak memory. Across classes:
// bridge/trigger.js caps at 4 parallel scripts.

import { readFile, writeFile, unlink, mkdir, stat, readdir, rename } from 'node:fs/promises';
import { resolveFileVersions, diffSummary, describeDiff } from './file-versions.js';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, extname, basename } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  atomicWriteJson,
  atomicWriteText,
  readJsonSafe,
} from './_util.js';
import { extractTextFromHtml } from './parse-syllabus.js';
import { spawn } from 'node:child_process';
import { withFilesIndexLock } from '../file-lock.js';

// --- Optional LibreOffice → PDF conversion ---------------------------------

const SOFFICE_CANDIDATES = [
  process.env.CSYNC_SOFFICE,
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/local/bin/soffice',
  '/opt/homebrew/bin/soffice',
  '/usr/bin/soffice',
].filter(Boolean);

async function findSoffice() {
  for (const p of SOFFICE_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

function convertToPdf(soffice, srcPath, outDir) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(soffice,
      ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, srcPath],
      { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('conversion timeout')); }, 120000);
    // A pipeline cancel SIGTERMs this script — take the soffice child down
    // with us instead of orphaning a headless LibreOffice process.
    const onTerm = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } process.exit(143); };
    process.once('SIGTERM', onTerm);
    child.on('exit', (code) => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', onTerm);
      code === 0 ? resolvePromise() : reject(new Error(`soffice exited ${code}`));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', onTerm);
      reject(err);
    });
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const COMBINED_MAX_CHARS = 1_000_000;
const OCR_MIN_CHARS = 200;

const UNSUPPORTED_EXTS = new Set([
  'mp3', 'mp4', 'mov', 'wav', 'zip', 'rar', 'exe', 'dmg',
  'm4a', 'avi', 'mkv', 'tar', 'gz', '7z',
]);

const OFFICE_EXTS = new Set(['pptx', 'docx', 'xlsx']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif']);
const TEXT_EXTS = new Set(['txt', 'md']);
const HTML_EXTS = new Set(['html', 'htm']);

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function extOf(filename) {
  const e = extname(filename || '').toLowerCase().replace(/^\./, '');
  return e;
}

function stripExt(name) {
  const e = extname(name);
  return e ? name.slice(0, -e.length) : name;
}

function typeLabelFromExt(ext) {
  if (ext === 'pptx') return 'PPTX';
  if (ext === 'docx') return 'DOCX';
  if (ext === 'xlsx') return 'XLSX';
  if (ext === 'pdf')  return 'PDF';
  if (ext === 'md')   return 'MD';
  if (ext === 'txt')  return 'TXT';
  if (ext === 'html' || ext === 'htm') return 'HTML';
  if (IMAGE_EXTS.has(ext)) return 'IMG';
  return ext.toUpperCase() || 'FILE';
}

// --- Extractors ----------------------------------------------------------

async function extractPdf(absPath) {
  // Native text first.
  let text = '';
  let pageCount = null;
  let method = 'pdfparse';
  let lowConfidence = false;

  try {
    const pdfParse = (await import('pdf-parse')).default;
    const buf = await readFile(absPath);
    const data = await pdfParse(buf);
    text = (data.text || '').trim();
    pageCount = typeof data.numpages === 'number' ? data.numpages : null;
  } catch (err) {
    process.stderr.write(`pdf-parse error on ${basename(absPath)}: ${err.message}\n`);
  }

  if (text.length >= OCR_MIN_CHARS) {
    return { text, method, pageCount, lowConfidence };
  }

  // OCR fallback — scanned PDF. We cannot render pages without pdfjs-dist +
  // canvas; mark low-confidence and return whatever native text we got.
  // OPEN: to really OCR scanned PDFs, add a page-renderer (pdfjs-dist +
  // @napi-rs/canvas) and stream each page image through tesseract, calling
  // `worker.terminate()` between pages.
  process.stderr.write(`PDF ${basename(absPath)}: native text < ${OCR_MIN_CHARS} chars (likely scanned). OCR of scanned PDFs not implemented in v1.1.\n`);
  return { text, method: 'scanned-pdf', pageCount, lowConfidence: true };
}

async function extractOffice(absPath, ext) {
  const officeparser = await import('officeparser');
  const ast = await officeparser.parseOffice(absPath, { ignoreNotes: false });
  const text = (ast.toText?.() || '').trim();

  const result = { text, method: ext, lowConfidence: text.length < 50 };

  // pptx: count top-level 'slide' nodes.
  if (ext === 'pptx') {
    const slides = (ast.content || []).filter(n => n && n.type === 'slide');
    if (slides.length > 0) result.slideCount = slides.length;
  }
  // xlsx: count top-level 'sheet' nodes.
  if (ext === 'xlsx') {
    const sheets = (ast.content || []).filter(n => n && n.type === 'sheet');
    if (sheets.length > 0) result.sheetCount = sheets.length;
  }
  // docx: no native page concept in the AST; page count is layout-dependent
  // and not preserved. Leave pageCount unset.

  return result;
}

async function extractPlain(absPath) {
  const text = (await readFile(absPath, 'utf8')).trim();
  return { text, method: 'plain', lowConfidence: text.length < 20 };
}

async function extractImageOcr(absPath) {
  // Single short-lived tesseract worker per call.
  const { createWorker } = await import('tesseract.js');
  let worker;
  try {
    worker = await createWorker('eng');
    const { data } = await worker.recognize(absPath);
    const text = (data?.text || '').trim();
    const confidence = typeof data?.confidence === 'number' ? data.confidence : null;
    const low = text.length < 50 || (confidence !== null && confidence < 60);
    return { text, method: 'ocr', lowConfidence: low };
  } finally {
    try { if (worker) await worker.terminate(); } catch {}
  }
}

// Dispatch: returns { text, method, lowConfidence, pageCount?, slideCount?, sheetCount? }
// or throws on failure. Returns null when the file type is unsupported.
async function dispatchExtract(absPath, localName) {
  const ext = extOf(localName) || extOf(absPath);

  if (!ext || UNSUPPORTED_EXTS.has(ext)) {
    return { unsupported: true, ext };
  }

  if (ext === 'pdf') {
    return await extractPdf(absPath);
  }
  if (OFFICE_EXTS.has(ext)) {
    return await extractOffice(absPath, ext);
  }
  if (TEXT_EXTS.has(ext)) {
    return await extractPlain(absPath);
  }
  if (HTML_EXTS.has(ext)) {
    return await extractTextFromHtml(absPath);
  }
  if (IMAGE_EXTS.has(ext)) {
    return await extractImageOcr(absPath);
  }

  return { unsupported: true, ext };
}

// --- Combined.txt --------------------------------------------------------

function buildSection(entry, text) {
  const ext = extOf(entry.filename || entry.displayName || '');
  const label = typeLabelFromExt(ext);
  const display = entry.displayName || entry.filename || 'Untitled';
  const uploaded = entry.canvasUpdatedAt || 'unknown';
  const header = `=== [${label}] ${display} ===\n(Canvas updated: ${uploaded})\n\n`;
  return header + (text || '') + '\n\n';
}

// Remove _combined-NN.txt parts numbered above keepCount (0 = all), plus the
// split index when nothing is split. Without this, shrinking back under the
// split threshold (or a corpus shrink) leaves stale parts that downstream
// pack-building would happily copy alongside the fresh content.
async function pruneStaleParts(materialsDir, keepCount) {
  let names = [];
  try { names = await readdir(materialsDir); } catch { return; }
  for (const name of names) {
    const m = name.match(/^_combined-(\d+)\.txt$/);
    if (m && Number(m[1]) > keepCount) {
      try { await unlink(join(materialsDir, name)); } catch { /* best-effort */ }
    }
  }
  if (keepCount === 0 && names.includes('_combined-index.txt')) {
    try { await unlink(join(materialsDir, '_combined-index.txt')); } catch { /* best-effort */ }
  }
}

async function writeCombined(materialsDir, sections) {
  // sections: [{ entry, text }] — text excludes the section header.
  // If total > COMBINED_MAX_CHARS, split at section boundaries.
  const built = sections.map(s => buildSection(s.entry, s.text));
  const total = built.reduce((n, s) => n + s.length, 0);

  if (total <= COMBINED_MAX_CHARS) {
    await atomicWriteText(join(materialsDir, '_combined.txt'), built.join(''));
    await pruneStaleParts(materialsDir, 0);
    return { split: false, files: ['_combined.txt'], total };
  }

  // Split — greedy pack by size.
  const chunks = [];
  let cur = [];
  let curSize = 0;
  let curEntries = [];
  for (let i = 0; i < built.length; i++) {
    const sectionStr = built[i];
    // If a single section is bigger than the cap, it still goes alone in a chunk.
    if (curSize + sectionStr.length > COMBINED_MAX_CHARS && cur.length > 0) {
      chunks.push({ str: cur.join(''), entries: curEntries });
      cur = [];
      curSize = 0;
      curEntries = [];
    }
    cur.push(sectionStr);
    curSize += sectionStr.length;
    curEntries.push(sections[i].entry);
  }
  if (cur.length > 0) {
    chunks.push({ str: cur.join(''), entries: curEntries });
  }

  const files = [];
  const indexLines = [];
  for (let i = 0; i < chunks.length; i++) {
    const num = String(i + 1).padStart(2, '0');
    const name = `_combined-${num}.txt`;
    await atomicWriteText(join(materialsDir, name), chunks[i].str);
    files.push(name);
    indexLines.push(`${name}:`);
    for (const e of chunks[i].entries) {
      indexLines.push(`  - ${e.displayName || e.filename || 'Untitled'} (canvasId=${e.canvasId})`);
    }
    indexLines.push('');
  }
  await atomicWriteText(join(materialsDir, '_combined-index.txt'), indexLines.join('\n'));

  // Clean up a stale non-split _combined.txt if present, and any leftover
  // parts numbered beyond this run's chunk count.
  const legacy = join(materialsDir, '_combined.txt');
  if (existsSync(legacy)) {
    try { await unlink(legacy); } catch {}
  }
  await pruneStaleParts(materialsDir, chunks.length);

  return { split: true, files, total };
}

// --- main ----------------------------------------------------------------

async function main() {
  const classDirArg = process.argv[2];
  if (!classDirArg) {
    process.stderr.write('Usage: node extract-course-files.js <classDir>\n');
    process.exit(1);
  }
  const classDir = resolve(classDirArg);
  if (!existsSync(classDir)) {
    process.stderr.write(`Class dir not found: ${classDir}\n`);
    process.exit(1);
  }

  const indexPath = join(classDir, 'files_index.json');
  const index = await readJsonSafe(indexPath);
  if (!Array.isArray(index)) {
    process.stderr.write(`files_index.json missing or not an array at ${indexPath}. Nothing to do.\n`);
    process.exit(0);
  }
  if (index.length === 0) {
    process.stderr.write(`files_index.json is empty. Nothing to do.\n`);
    process.exit(0);
  }

  const materialsDir = join(classDir, 'materials');
  await mkdir(materialsDir, { recursive: true });

  process.stderr.write(`Extracting ${index.length} file(s) for ${basename(classDir)}\n`);

  // Pass 1 — per-file extract.
  for (const entry of index) {
    // Default nulls so consumers can rely on the shape.
    if (!('extractionStatus' in entry)) entry.extractionStatus = 'pending';
    if (!('extractionError' in entry)) entry.extractionError = null;
    if (!('textSha256' in entry)) entry.textSha256 = null;
    if (!('duplicateOf' in entry)) entry.duplicateOf = null;
    if (!('skipped' in entry)) entry.skipped = null;

    const localRel = entry.localPath;
    if (!localRel) {
      entry.extractionStatus = 'failed';
      entry.extractionError = 'no localPath in index entry';
      continue;
    }
    const absLocal = join(classDir, localRel);
    if (!existsSync(absLocal)) {
      entry.extractionStatus = 'failed';
      entry.extractionError = `source file not found: ${localRel}`;
      continue;
    }

    const displayName = entry.displayName || entry.filename || basename(absLocal);
    // Name the .txt after the FULL localPath basename (extension included), not
    // the stem: the bridge guarantees unique localPath basenames (it id-suffixes
    // only on full-name collisions), but two files that differ *only* by
    // extension — Lecture1.pdf and Lecture1.docx — share a stem, so stripExt
    // would collapse both to Lecture1.txt and the second would clobber the
    // first (dropping its text from the mining corpus). Keeping the extension
    // makes the .txt name as unique as the source: Lecture1.pdf.txt / .docx.txt.
    const textName = `${basename(localRel)}.txt`;
    const absText = join(materialsDir, textName);
    entry.materialsPath = `materials/${textName}`;

    // Skip if already done AND the text file still exists AND size unchanged
    // (we use presence + status as the cheap idempotency check).
    if (entry.extractionStatus === 'done' && existsSync(absText) && entry.duplicateOf === null) {
      continue;
    }

    let extracted;
    try {
      extracted = await dispatchExtract(absLocal, entry.filename || displayName);
    } catch (err) {
      process.stderr.write(`  [FAIL] ${displayName}: ${err.message}\n`);
      entry.extractionStatus = 'failed';
      entry.extractionError = err.message || String(err);
      continue;
    }

    if (extracted && extracted.unsupported) {
      entry.extractionStatus = 'skipped';
      entry.skipped = 'unsupported';
      entry.extractionError = null;
      // No materials/.txt for unsupported files.
      entry.materialsPath = null;
      continue;
    }

    const text = (extracted?.text || '').trim();
    try {
      await atomicWriteText(absText, text);
    } catch (writeErr) {
      // Partial write still counts as failed but shouldn't halt the run.
      entry.extractionStatus = 'failed';
      entry.extractionError = `write failed: ${writeErr.message}`;
      continue;
    }

    entry.extractionStatus = 'done';
    entry.extractionError = null;
    entry.textSha256 = text.length > 0 ? sha256Text(text) : null;
    if (extracted.pageCount != null) entry.pageCount = extracted.pageCount;
    if (extracted.slideCount != null) entry.slideCount = extracted.slideCount;
    if (extracted.sheetCount != null) entry.sheetCount = extracted.sheetCount;
    if (extracted.lowConfidence) entry.lowConfidence = true;

    process.stderr.write(`  [OK]  ${displayName} (${text.length} chars${extracted.method ? `, ${extracted.method}` : ''})\n`);
  }

  // Pass 1.5 — optional PDF conversion for Office formats. Text extraction
  // above is the always-on, Claude-friendly form; when LibreOffice is
  // installed we ADDITIONALLY render pptx/docx/xlsx to materials/pdf/ so
  // figure-heavy slides survive with their visuals (PDFs are natively
  // readable by Claude). Auto-detected; override binary with CSYNC_SOFFICE.
  const soffice = await findSoffice();
  if (soffice) {
    const pdfDir = join(materialsDir, 'pdf');
    for (const entry of index) {
      const ext = extOf(entry.filename || entry.displayName || '');
      if (!['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls'].includes(ext)) continue;
      if (!entry.localPath || entry.duplicateOf != null) continue;
      // Convert when text extraction succeeded (visual fidelity), was skipped
      // (legacy ppt/doc/xls that the extractor can't parse — the PDF is the
      // ONLY Claude-readable form of these), or failed (soffice can often
      // still render a file the text extractor choked on).
      if (!['done', 'skipped', 'failed'].includes(entry.extractionStatus)) continue;
      const src = join(classDir, entry.localPath);
      // soffice names its output <stem>.pdf, so two sources sharing a stem
      // (Notes.docx + Notes.pptx) would both render to Notes.pdf and clobber
      // each other. Rename to the full source basename (Notes.docx.pdf) so the
      // rendered PDF is as unique as the source file.
      const sofficeOut = join(pdfDir, stripExt(basename(entry.localPath)) + '.pdf');
      const finalPdf = join(pdfDir, `${basename(entry.localPath)}.pdf`);
      if (existsSync(finalPdf)) { entry.pdfPath = `materials/pdf/${basename(finalPdf)}`; continue; }
      try {
        await mkdir(pdfDir, { recursive: true });
        await convertToPdf(soffice, src, pdfDir);
        if (existsSync(sofficeOut)) {
          if (sofficeOut !== finalPdf) await rename(sofficeOut, finalPdf);
          entry.pdfPath = `materials/pdf/${basename(finalPdf)}`;
          process.stderr.write(`  [PDF] ${basename(finalPdf)}\n`);
        }
      } catch (err) {
        process.stderr.write(`  [PDF-FAIL] ${entry.displayName || entry.filename}: ${err.message}\n`);
      }
    }
  }

  // The verdict fields are recomputed from scratch every run: dedupe and
  // supersession both read the CURRENT index, so a preserved flag is a stale
  // claim — and a one-way one. Once wedged (a re-downloaded file re-ordering
  // a version pair set A→B and B→A simultaneously), both copies of a document
  // vanished from everything the AI reads with no code path ever clearing the
  // fields. Pass 1 has already re-extracted anything whose text was unlinked
  // while hidden, so a fresh verdict is always complete.
  for (const e of index) {
    if (!e) continue;
    e.duplicateOf = null;
    e.supersededBy = null;
    if ('versionAmbiguous' in e) delete e.versionAmbiguous;
  }

  // Pass 2 — dedupe by textSha256. For collisions, the later canvasUpdatedAt wins.
  const byHash = new Map();
  for (const entry of index) {
    if (entry.extractionStatus !== 'done' || !entry.textSha256) continue;
    const group = byHash.get(entry.textSha256) || [];
    group.push(entry);
    byHash.set(entry.textSha256, group);
  }

  for (const [, group] of byHash) {
    if (group.length < 2) continue;
    // Pick winner by latest canvasUpdatedAt (fallback: first in list).
    group.sort((a, b) => {
      const da = a.canvasUpdatedAt ? Date.parse(a.canvasUpdatedAt) : 0;
      const db = b.canvasUpdatedAt ? Date.parse(b.canvasUpdatedAt) : 0;
      return db - da;
    });
    const [winner, ...losers] = group;
    for (const loser of losers) {
      loser.duplicateOf = winner.canvasId;
      if (loser.materialsPath) {
        const absText = join(classDir, loser.materialsPath);
        try { if (existsSync(absText)) await unlink(absText); } catch {}
      }
      loser.materialsPath = null;
    }
  }

  // Pass 2b — supersession. Canvas does not version files: a professor who
  // re-uploads a corrected syllabus gets a NEW file id, and the old copy stays
  // in the course. BUSI 305 had exactly this on 2026-08-24 — two files named
  // `syllabus_Busi 305-Fall 2026.pdf`, uploaded four weeks apart, both
  // extracted, both concatenated into _combined.txt under the same heading. The
  // dedupe pass above cannot catch it, because it keys on textSha256 and the
  // whole point of a correction is that the text differs.
  //
  // The superseded copy keeps its download — it is evidence, and it is what
  // makes the diff below possible — but it stops feeding anything the AI reads.
  const versions = resolveFileVersions(index);
  const byId = new Map(index.map(e => [String(e.canvasId), e]));

  for (const s of versions.superseded) {
    const loser = byId.get(String(s.canvasId));
    const winner = byId.get(String(s.supersededBy));
    if (!loser || !winner) continue;
    loser.supersededBy = winner.canvasId;

    // What actually changed, computed here once, so the dashboard can answer
    // "what moved in the new syllabus" without re-reading two documents. Local
    // and deterministic — line counts, not a model call.
    if (loser.materialsPath && winner.materialsPath) {
      try {
        const [before, after] = await Promise.all([
          readFile(join(classDir, loser.materialsPath), 'utf8'),
          readFile(join(classDir, winner.materialsPath), 'utf8'),
        ]);
        const d = diffSummary(before, after);
        winner.supersedes = [
          ...(winner.supersedes ?? []).filter(x => String(x.canvasId) !== String(loser.canvasId)),
          {
            canvasId: loser.canvasId,
            displayName: loser.displayName ?? null,
            replacedAt: winner.canvasUpdatedAt ?? null,
            reason: s.reason,
            diff: d,
            summary: describeDiff(d),
          },
        ];
        process.stderr.write(`  [SUPERSEDED] ${loser.displayName}: ${describeDiff(d)}\n`);
      } catch (err) {
        process.stderr.write(`  [SUPERSEDED] ${loser.displayName}: could not diff (${err.message})\n`);
      }
    }
    // Its extracted text goes, the same way a duplicate's does — nothing
    // downstream globs materials/, they all walk materialsPath.
    if (loser.materialsPath) {
      const absText = join(classDir, loser.materialsPath);
      try { if (existsSync(absText)) await unlink(absText); } catch {}
      loser.materialsPath = null;
    }
  }

  // Two copies of one name that cannot be ordered are both kept and both fed —
  // hiding the one that turns out to be current is the worse failure — but the
  // ambiguity is recorded so the dashboard can say so out loud.
  for (const g of versions.ambiguous) {
    for (const id of g.canvasIds) {
      const e = byId.get(String(id));
      if (e) e.versionAmbiguous = g.canvasIds.filter(x => String(x) !== String(id));
    }
    process.stderr.write(`  [AMBIGUOUS] ${g.key}: ${g.canvasIds.length} copies, none provably newer\n`);
  }

  // Pass 3 — build combined. Include only done, non-dupe, non-superseded,
  // oldest first.
  const combinable = index
    .filter(e => e.extractionStatus === 'done' && e.duplicateOf === null
      && e.supersededBy == null && e.materialsPath)
    .sort((a, b) => {
      const da = a.canvasUpdatedAt ? Date.parse(a.canvasUpdatedAt) : 0;
      const db = b.canvasUpdatedAt ? Date.parse(b.canvasUpdatedAt) : 0;
      return da - db;
    });

  const sections = [];
  for (const entry of combinable) {
    try {
      const absText = join(classDir, entry.materialsPath);
      const text = await readFile(absText, 'utf8');
      sections.push({ entry, text });
    } catch (err) {
      process.stderr.write(`  combined: skipped ${entry.displayName || entry.filename}: ${err.message}\n`);
    }
  }

  if (sections.length > 0) {
    const result = await writeCombined(materialsDir, sections);
    process.stderr.write(`  combined: ${result.files.join(', ')} (${result.total} chars total${result.split ? ', split' : ''})\n`);
  } else {
    // Still write the (empty) combined file: downstream staleness checks key
    // off its mtime, and skipping the write would re-run this stage forever
    // for classes with no extractable files.
    await atomicWriteText(join(materialsDir, '_combined.txt'), '');
    await pruneStaleParts(materialsDir, 0);
    process.stderr.write(`  combined: no sections to combine (wrote empty _combined.txt)\n`);
  }

  // Finalize: write the index and the completion marker, ORDER DECIDING
  // whether this stage looks finished. trigger/sync-all use the marker's
  // mtime as this stage's output anchor (files_index.json is rewritten here
  // too, and in split mode _combined.txt doesn't exist, so neither can serve
  // as anchor). So: marker LAST on a clean pass — the stage is done — and
  // marker FIRST when the merge kept entries this pass never processed, so
  // the index stays newer and the next pass picks them up. See the branch
  // below; swapping it back strands every mid-run ingest as 'pending'.
  //
  // Merge, don't clobber: the bridge's /ingest/course-file appends to the
  // SAME file while this minutes-long pass holds its own copy in memory, and
  // whoever wrote last used to win — a file ingested mid-extraction vanished
  // from the index (invisible in the UI, never extracted) until the next
  // sync happened to re-upsert it. Disk entries this pass never saw are kept,
  // and an entry the bridge re-downloaded mid-pass (newer lastSyncedAt) keeps
  // the DISK copy — its 'pending' status is about the new bytes, which this
  // pass's results do not describe.
  // The merge below is a read-modify-write, and the bridge writes this same
  // file from another process. The merge alone narrowed that race but could not
  // close it: there is a real await between the disk read and the index write
  // (the marker write, in the leftoverPending branch), and a file ingested in
  // that window still vanished. The lock closes it; the merge STAYS as the
  // semantic guard, correct for any writer that predates the lock.
  //
  // Scoped to the finalize ONLY — never the extraction pass above, which runs
  // for minutes. A lock held that long would need a stale threshold that cannot
  // tell a slow holder from a dead one. See file-lock.js.
  const finalize = async () => {
    const mergedIndex = await (async () => {
      const diskNow = await readJsonSafe(indexPath);
      if (!Array.isArray(diskNow)) return index;
      const memById = new Map(index.map(e => [String(e?.canvasId), e]));
      const out = [];
      const seen = new Set();
      for (const d of diskNow) {
        const id = String(d?.canvasId);
        const m = memById.get(id);
        seen.add(id);
        if (!m) { out.push(d); continue; }
        const newerOnDisk = (d?.lastSyncedAt ?? '') > (m?.lastSyncedAt ?? '');
        out.push(newerOnDisk ? d : m);
      }
      for (const m of index) {
        if (!seen.has(String(m?.canvasId))) out.push(m);
      }
      return out;
    })();
    // Write ORDER decides whether a mid-run ingest ever gets extracted. Every
    // re-run gate (trigger.js isStale, sync-all needsExtract) is a pure mtime
    // comparison of files_index.json against the marker — so when the merge
    // kept entries this pass never processed, the marker must land FIRST and
    // the index after, leaving the stage stale and the next trigger pass to
    // pick the pending work up. Marker-last would stamp completion over
    // unprocessed work, and since neither the extension's diff nor the
    // bridge's skip-if-unchanged path ever rewrites an unchanged file, nothing
    // would re-fire the stage: the file would sit pending — invisible to
    // _combined, mining and the context pack — forever.
    const leftoverPending = mergedIndex.some(e => e && e.extractionStatus === 'pending');
    if (leftoverPending) {
      await atomicWriteText(join(materialsDir, 'last_extracted.txt'), new Date().toISOString());
      await atomicWriteJson(indexPath, mergedIndex);
      process.stderr.write(`Updated ${indexPath} (mid-run ingest detected — stage left stale so the next pass extracts it)\n`);
    } else {
      await atomicWriteJson(indexPath, mergedIndex);
      await atomicWriteText(join(materialsDir, 'last_extracted.txt'), new Date().toISOString());
      process.stderr.write(`Updated ${indexPath}\n`);
    }
  };
  try {
    // Generous: this is a batch job with nobody waiting on a socket.
    await withFilesIndexLock(classDir, finalize, { timeoutMs: 30000 });
  } catch (err) {
    // ONLY a lock timeout earns the unlocked fallback. This catch used to
    // surround finalize() as well, so a failure INSIDE the merge — a transient
    // EIO on the marker rename, a full disk — was swallowed here and the merge
    // retried with the lock released: a storage fault retried with the race
    // reopened, then exit 0 as though the pass had been clean. A fault is not
    // contention and must not be treated as it.
    if (err?.code !== 'ELOCKTIMEOUT') throw err;
    // A 30s wait for a lock held in milliseconds means something is wedged.
    // Finishing unlocked re-exposes the narrow race the merge already covers;
    // exiting would throw away a pass that costs minutes. Take the merge, and
    // say so loudly rather than letting it look like a clean run.
    process.stderr.write(`WARNING: files_index lock unavailable (${err.message}); `
      + 'finalizing with the merge alone — a concurrent ingest could still be lost.\n');
    await finalize();
  }
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err.stack || err.message || String(err)}\n`);
  process.exit(1);
});
