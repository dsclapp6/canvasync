import { readFile, writeFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { load as cheerioLoad } from 'cheerio';
import { aiInvoke, sha256File, atomicWriteJson, readJsonSafe } from './_util.js';

// OPEN: CLAUDE_SKIP=1 bypasses the external claude CLI call and returns a
// deterministic stub for testing. Set this env var in test environments.

const __dirname = dirname(fileURLToPath(import.meta.url));

async function extractTextFromPdf(pdfPath) {
  let pdfText = '';
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const buf = await readFile(pdfPath);
    const data = await pdfParse(buf);
    pdfText = data.text || '';
  } catch (err) {
    process.stderr.write(`pdf-parse error: ${err.message}\n`);
  }

  if (pdfText.length >= 200) {
    return { text: pdfText, method: 'pdfparse' };
  }

  // OPEN: OCR via tesseract.js on scanned PDFs requires rendered page images.
  // pdfjs-dist rendering is not available here (no canvas/browser). The approach
  // would be to render PDF pages to PNG buffers via a headless renderer and pass
  // them to tesseract. Without a renderer, we skip OCR and emit a low-confidence
  // result. To support scanned PDFs, install pdfjs-dist + canvas and implement
  // page rendering. For now, tesseract is listed as a dependency for future use.
  process.stderr.write('PDF text too short (likely scanned). OCR skipped — see OPEN comment in parse-syllabus.js.\n');
  return { text: pdfText, method: 'scanned', lowConfidence: true };
}

async function extractTextFromDocx(docxPath) {
  try {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ path: docxPath });
    const text = (result?.value || '').trim();
    if (text.length < 50) {
      return { text, method: 'docx', lowConfidence: true };
    }
    return { text, method: 'docx' };
  } catch (err) {
    process.stderr.write(`mammoth error: ${err.message}\n`);
    return { text: '', method: 'docx', lowConfidence: true };
  }
}

export async function extractTextFromHtml(htmlPath) {
  const html = await readFile(htmlPath, 'utf8');
  const $ = cheerioLoad(html);

  $('script, style, noscript').remove();

  const BLOCK_TAGS = new Set([
    'p', 'div', 'section', 'article', 'header', 'footer', 'nav', 'aside',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'tr', 'blockquote', 'pre',
  ]);

  const out = [];
  function walk(node) {
    if (!node) return;
    // Text node
    if (node.type === 'text') {
      out.push(node.data);
      return;
    }
    // Skip comments, directives, etc.
    if (node.type !== 'tag') return;

    const tag = (node.name || '').toLowerCase();
    if (tag === 'br') { out.push('\n'); return; }

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) out.push('\n');
    if (tag === 'h1')                   out.push('# ');
    else if (tag === 'h2')              out.push('## ');
    else if (tag === 'h3')              out.push('### ');
    else if (['h4', 'h5', 'h6'].includes(tag)) out.push('#### ');
    else if (tag === 'li')              out.push('- ');

    for (const child of node.children || []) walk(child);

    if (tag === 'td' || tag === 'th') out.push('\t');
    if (isBlock) out.push('\n');
  }

  const body = $('body')[0] ?? $.root()[0];
  for (const child of body.children || []) walk(child);

  // Collapse whitespace: preserve single newlines but cap repeats, trim trailing
  // spaces per line, drop lines that end up empty after trimming.
  const joined = out.join('');
  const lines = joined.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim());
  const compacted = [];
  let blank = 0;
  for (const line of lines) {
    if (line === '') { blank++; if (blank <= 1) compacted.push(''); continue; }
    blank = 0;
    compacted.push(line);
  }
  const text = compacted.join('\n').trim();
  const lowConfidence = text.length < 300;
  return { text, method: 'html', lowConfidence };
}

function buildStubResult(sourceFile, sourceHash, notes) {
  return {
    extracted_at: new Date().toISOString(),
    source_file: sourceFile,
    source_hash: sourceHash,
    course: {
      title: null,
      code: null,
      term: null,
      instructor: { name: null, email: null, office_hours: null },
      meeting_schedule: null
    },
    grading: {
      components: [],
      letter_scale: null,
      late_policy: null
    },
    schedule: [],
    policies: {
      attendance: null,
      academic_integrity: null,
      accommodations: null,
      other: []
    },
    extraction_confidence: 'low',
    extraction_notes: notes
  };
}

function extractJsonFromResponse(raw) {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd !== -1) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }
  return trimmed;
}

// A local model that runs out of tokens mid-sentence leaves JSON that is
// correct right up to the cut. Throwing it away costs the whole syllabus over
// one unfinished trailing field, so close what is open and keep the rest.
//
// Walks the text tracking string state and the bracket stack, remembering the
// last position where a value had just finished (a comma, or a closing bracket)
// along with the closers needed there. Truncating to that point and appending
// them yields valid JSON containing every complete field.
//
// Returns null when nothing complete was found — an empty salvage is worse than
// an honest failure.
export function salvageTruncatedJson(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let cut = -1;
  let closers = '';

  const mark = (i) => { cut = i; closers = stack.slice().reverse().join(''); };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { stack.push('}'); continue; }
    if (ch === '[') { stack.push(']'); continue; }
    if (ch === '}' || ch === ']') { stack.pop(); mark(i + 1); continue; }
    // Truncate *before* the comma: what precedes it is a finished value.
    if (ch === ',') mark(i);
  }

  if (cut <= 0 || !closers) return null;
  const candidate = text.slice(0, cut) + closers;
  try {
    const obj = JSON.parse(candidate);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

// extractJsonFromResponse closes on the *last* `}`, which on a truncated
// response is some inner object — useless for salvage. Take everything from the
// first `{` to the end of the text and let the walker find the cut.
function salvageFromResponse(raw) {
  const text = String(raw || '');
  const fence = text.indexOf('```');
  const body = fence === -1 ? text : text.slice(text.indexOf('\n', fence) + 1);
  const start = body.indexOf('{');
  if (start === -1) return null;
  return salvageTruncatedJson(body.slice(start));
}

async function parseWithClaude(text, promptTemplate, sourceFile, sourceHash, lowConfidence) {
  const prompt = promptTemplate.replace('<SYLLABUS_TEXT>', () => text);
  // Model defaults to claude-opus-5 (see _util.js DEFAULT_MODEL). maxTokens
  // only affects the local backend, where the default 8192 is not enough for
  // a long syllabus schedule — the response truncates mid-JSON.
  const raw = await aiInvoke(prompt, { timeoutMs: 300000, maxTokens: 16384 });
  return raw;
}

async function repairJson(brokenRaw) {
  const repairPrompt = `The previous response was not valid JSON. Return valid JSON only.\n\nPrevious response:\n${brokenRaw}`;
  const raw = await aiInvoke(repairPrompt, { timeoutMs: 60000 });
  return raw;
}

/**
 * Is an existing parse already the answer for this exact source?
 *
 * Both halves matter: the hash proves the syllabus has not changed, and
 * parseHasContent proves the previous run actually produced something (an
 * empty scaffold must be re-parsed, not preserved).
 */
export function parseIsCurrent(previous, sourceHash) {
  return Boolean(sourceHash) && previous?.source_hash === sourceHash && parseHasContent(previous);
}

// Does a parse actually contain anything a downstream stage could use?
export function parseHasContent(p) {
  return Boolean(p?.course?.code || p?.course?.title)
    || (p?.grading?.components?.length ?? 0) > 0
    || (p?.schedule?.length ?? 0) > 0;
}

function validateResult(obj) {
  const required = ['extracted_at', 'source_file', 'source_hash', 'course', 'grading', 'schedule', 'policies', 'extraction_confidence', 'extraction_notes'];
  for (const key of required) {
    if (!(key in obj)) {
      obj[key] = key === 'schedule' || key === 'grading' ? (key === 'schedule' ? [] : {}) : null;
    }
  }
  if (!obj.course) obj.course = {};
  if (!obj.grading) obj.grading = {};
  if (!Array.isArray(obj.schedule)) obj.schedule = [];
  if (!obj.policies) obj.policies = {};
  if (!Array.isArray(obj.policies.other)) obj.policies.other = [];
  if (!Array.isArray(obj.grading.components)) obj.grading.components = [];
  return obj;
}

async function main() {
  const classDir = process.argv[2];
  if (!classDir) {
    process.stderr.write('Usage: node parse-syllabus.js <classDir>\n');
    process.exit(1);
  }

  const absClassDir = resolve(classDir);
  process.stderr.write(`Parsing syllabus for: ${absClassDir}\n`);

  const pdfPath  = join(absClassDir, 'syllabus.pdf');
  const docxPath = join(absClassDir, 'syllabus.docx');
  const htmlPath = join(absClassDir, 'syllabus.html');

  let sourcePath = null;
  let extracted = null;

  // Priority: PDF (most common) → DOCX → HTML.
  if (existsSync(pdfPath)) {
    try {
      const pdfStat = await stat(pdfPath);
      if (pdfStat.size > 1024) {
        process.stderr.write('Using syllabus.pdf\n');
        extracted = await extractTextFromPdf(pdfPath);
        sourcePath = pdfPath;
      }
    } catch {}
  }

  if (!sourcePath && existsSync(docxPath)) {
    try {
      const docxStat = await stat(docxPath);
      if (docxStat.size > 1024) {
        process.stderr.write('Using syllabus.docx\n');
        extracted = await extractTextFromDocx(docxPath);
        sourcePath = docxPath;
      }
    } catch {}
  }

  if (!sourcePath && existsSync(htmlPath)) {
    process.stderr.write('Using syllabus.html\n');
    extracted = await extractTextFromHtml(htmlPath);
    sourcePath = htmlPath;
  }

  if (!sourcePath) {
    process.stderr.write('No syllabus source found (syllabus.pdf / .docx / .html)\n');
    process.exit(1);
  }

  const sourceHash = await sha256File(sourcePath);
  const sourceFile = sourcePath.split('/').pop();

  const OUT_PATH = join(absClassDir, 'syllabus_parsed.json');

  if (process.env.CLAUDE_SKIP === '1') {
    // OPEN: CLAUDE_SKIP=1 skips the claude CLI call and writes a deterministic
    // stub result. Used in automated tests where no AI model is available.
    const stub = buildStubResult(sourceFile, sourceHash, 'CLAUDE_SKIP=1: stub result for testing');
    stub.extraction_confidence = 'low';
    stub.course = {
      title: 'Test Course',
      code: 'TEST 101',
      term: 'Spring 2026',
      instructor: { name: 'Test Instructor', email: 'test@example.edu', office_hours: 'MWF 2-3pm' },
      meeting_schedule: 'MWF 10:00-10:50am'
    };
    await atomicWriteJson(OUT_PATH, stub);
    process.stderr.write(`Written: ${OUT_PATH}\n`);
    process.exit(0);
  }

  // Has this exact syllabus already been parsed? Answered HERE rather than in
  // each orchestrator, because the answer lives in the parse's own output and
  // every caller needs it. The bridge rewrites syllabus.html byte-identically
  // on every /ingest/course, so a plain mtime check calls this stage stale on
  // every sync forever — and this is the most expensive stage there is:
  // minutes on the local model, holding the machine-wide lock, with mine and
  // build queued behind it. sync-all-contexts confirms with syllabus.hash,
  // but that file only exists for UPLOADED syllabi; the previous parse's
  // own source_hash covers HTML-only classes too. Re-stamp rather than just
  // exiting, so the output's mtime clears the source and the caller stops
  // asking. `--force` re-parses regardless.
  if (!process.argv.includes('--force')) {
    const previous = await readJsonSafe(OUT_PATH);
    if (parseIsCurrent(previous, sourceHash)) {
      await atomicWriteJson(OUT_PATH, previous);
      process.stderr.write(`Syllabus unchanged since the last parse (${sourceFile}) — kept it. Use --force to re-parse.\n`);
      process.exit(0);
    }
  }

  const promptTemplate = await readFile(join(__dirname, 'prompts', 'syllabus-extraction.md'), 'utf8');

  let parsed = null;
  let rawResponse = null;
  let truncated = false;

  try {
    rawResponse = await parseWithClaude(extracted.text, promptTemplate, sourceFile, sourceHash, extracted.lowConfidence);
    const jsonStr = extractJsonFromResponse(rawResponse);
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    process.stderr.write(`First parse attempt failed: ${err.message}\n`);

    // Salvage before re-asking. A truncated response re-sent to the same model
    // comes back truncated in the same place, and costs another few minutes of
    // the machine-wide model lock to learn that.
    parsed = salvageFromResponse(rawResponse || '');
    if (parsed) {
      truncated = true;
      process.stderr.write('Response was truncated; kept the fields that completed.\n');
    }

    let repairErr = null;
    if (!parsed) {
      try {
        rawResponse = await repairJson(rawResponse || '');
        parsed = JSON.parse(extractJsonFromResponse(rawResponse));
      } catch (err2) {
        repairErr = err2;
        process.stderr.write(`Repair attempt failed: ${err2.message}\n`);
      }
    }

    if (!parsed) {
      // Always leave something to read. When rawResponse is empty the AI call
      // itself failed, and the reason (expired auth, model error) is the only
      // evidence there is — dropping it is what made this stage fail silently
      // for every class with nothing on disk to explain why.
      const errorPath = join(absClassDir, 'syllabus_parsed.json.ERROR');
      const body = rawResponse && rawResponse.trim()
        ? rawResponse
        : `No response from the AI backend.\n\nfirst attempt: ${err.message}\n`
          + `repair attempt: ${repairErr ? repairErr.message : '(not attempted)'}\n`;
      await writeFile(errorPath, body, 'utf8');
      process.stderr.write(`Failure detail written to: ${errorPath}\n`);
      process.exit(1);
    }
  }

  parsed = validateResult(parsed);
  parsed.extracted_at = new Date().toISOString();
  parsed.source_file = sourceFile;
  parsed.source_hash = sourceHash;

  // A model reply of "{}" is valid JSON, so it sails past every guard above
  // and validateResult scaffolds it into a structurally correct parse with
  // nothing in it — which then OVERWRITES a good earlier extraction (this is
  // how BUSI 380's schedule vanished after a local-model run). An empty
  // result for a substantial syllabus is a failed extraction, not data.
  const REJECT_NOTE = 'A newer re-parse attempt returned an empty result and was discarded; this data is from the previous successful parse.';
  if (!parseHasContent(parsed) && extracted.text.length >= 2000) {
    const emptyOutPath = join(absClassDir, 'syllabus_parsed.json');
    await writeFile(emptyOutPath + '.ERROR', rawResponse ?? '(empty response)', 'utf8');
    const previous = await readJsonSafe(emptyOutPath);
    if (parseHasContent(previous)) {
      // Keep the good parse, but REWRITE it so its mtime advances past the
      // syllabus source — otherwise the trigger's staleness check re-runs
      // this stage (50 local-model minutes) on every sync forever.
      if (!(previous.extraction_notes || '').includes(REJECT_NOTE)) {
        previous.extraction_notes = ((previous.extraction_notes || '') + ' ' + REJECT_NOTE).trim();
      }
      await atomicWriteJson(emptyOutPath, previous);
      process.stderr.write('Empty parse rejected — kept previous syllabus_parsed.json (raw response in .ERROR)\n');
      process.exit(0);
    }
    process.stderr.write('Empty parse rejected, no previous parse to keep — failing (raw response in .ERROR)\n');
    process.exit(1);
  }

  if (truncated) {
    parsed.extraction_confidence = parsed.extraction_confidence === 'low' ? 'low' : 'medium';
    parsed.extraction_notes = (parsed.extraction_notes || '')
      + ' The model\'s response was cut off; fields after the truncation point are missing.';
  }

  if (extracted.lowConfidence && parsed.extraction_confidence === 'high') {
    parsed.extraction_confidence = 'medium';
    parsed.extraction_notes = (parsed.extraction_notes || '') + ' Source was likely scanned/OCR-limited.';
  }

  const outPath = OUT_PATH;
  await atomicWriteJson(outPath, parsed);
  // A failure sidecar left next to a good parse reads as a current failure.
  await rm(join(absClassDir, 'syllabus_parsed.json.ERROR'), { force: true });
  process.stderr.write(`Written: ${outPath}\n`);
  process.exit(0);
}

// Only run main() when invoked directly, not when imported as a module
// (extract-course-files.js reuses extractTextFromHtml via import).
// Compare decoded paths — a raw `file://${argv[1]}` comparison fails whenever
// the repo path contains spaces (URL-encoding), silently skipping main().
const isDirectInvocation = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  main();
}
