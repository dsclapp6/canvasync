// storage.js — file persistence layer for canvas-sync bridge
// The data root is defined once in ../data-root.js; set CANVAS_SYNC_HOME to
// override it (the tests do).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataRoot as syncHome } from '../data-root.js';
import { withFilesIndexLock } from '../file-lock.js';
import { preserveUnreadable } from './store-safety.js';

export function slugifyCourseCode(code) {
  if (!code || typeof code !== 'string') return null;
  return code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export function classDirFor(courseId, slug) {
  return path.join(syncHome(), 'classes', `${courseId}-${slug}`);
}

// Atomic write: write to tmp file then rename.
async function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  await fs.writeFile(tmp, data, { encoding: 'utf8' });
  await fs.rename(tmp, filePath);
}

async function atomicWriteBinary(filePath, buffer) {
  const tmp = filePath + '.tmp.' + process.pid;
  await fs.writeFile(tmp, buffer);
  await fs.rename(tmp, filePath);
}

export async function writeCourse(payload) {
  const course = payload.course ?? {};
  const courseId = course.id ?? payload.courseId;
  if (!courseId) throw new Error('writeCourse: missing course.id');

  const rawSlug = slugifyCourseCode(course.course_code);
  const slug = rawSlug || `course-${courseId}`;
  const classDir = classDirFor(courseId, slug);

  await fs.mkdir(classDir, { recursive: true, mode: 0o700 });

  // Course fields that reach metadata.json. This is a whitelist, so a field
  // Canvas sends but nobody listed here is silently dropped — which is exactly
  // what happened to the grading fields below. Without
  // apply_assignment_group_weights there is no way to tell a course that
  // weights by assignment group from one that totals raw points, and the two
  // produce different grades from identical submissions. All three are default
  // fields on Canvas's Course object; no extra include[] or scope is needed.
  const metadataFields = [
    'id', 'name', 'course_code', 'sis_course_id', 'term',
    'start_at', 'end_at', 'time_zone', 'uuid',
    'apply_assignment_group_weights', 'grading_standard_id', 'hide_final_grades',
  ];
  const instructorFields = ['id', 'display_name', 'email', 'avatar_url'];
  const metadata = {
    ...Object.fromEntries(metadataFields.filter(k => k in course).map(k => [k, course[k]])),
    instructors: (payload.instructors ?? []).map(i =>
      Object.fromEntries(instructorFields.filter(k => k in i).map(k => [k, i[k]]))
    ),
  };

  // NOTE: `files_index.json` is intentionally NOT written here. As of v1.1 it
  // is the exclusive output of writeCourseFile (which tracks downloaded file
  // state + extraction status). If we overwrote it from the course payload's
  // `files_index`, we'd clobber the real per-file state — especially bad for
  // classes where the Canvas Files tab is locked and returns []. The two
  // endpoints run in this order: POST /ingest/course-file (many) → POST
  // /ingest/course (once). Only the first owns the index.
  // Each resource file is written only when its key is PRESENT in the
  // payload (the pattern external_tools/course_packs below always used). The
  // extension omits a resource it could not read this sync — a transient
  // Canvas 403 used to arrive here as [] and overwrite a cached
  // assignments.json holding real deadlines. An old extension sends every
  // key, so nothing changes for it.
  const RESOURCE_FILES = [
    ['assignments', 'assignments.json'],
    ['modules', 'modules.json'],
    ['announcements', 'announcements.json'],
    ['pages', 'pages.json'],
    ['quizzes', 'quizzes.json'],
    ['assignment_groups', 'assignment_groups.json'],
    ['discussions', 'discussions.json'],
    ['calendar_events', 'calendar_events.json'],
    ['enrollments', 'grades.json'],
    ['tabs', 'tabs.json'],
    ['groups', 'groups.json'],
  ];
  const writes = [
    atomicWrite(path.join(classDir, 'metadata.json'), JSON.stringify(metadata, null, 2)),
    ...RESOURCE_FILES
      .filter(([key]) => payload[key] !== undefined)
      .map(([key, file]) => atomicWrite(path.join(classDir, file), JSON.stringify(payload[key] ?? [], null, 2))),
  ];

  // Extension ≥ 1.3.0. Written only when present, so a payload from an older
  // extension cannot blank a file a newer one already wrote.
  if (payload.external_tools) {
    writes.push(atomicWrite(path.join(classDir, 'external_tools.json'), JSON.stringify(payload.external_tools, null, 2)));
  }
  if (payload.course_packs) {
    writes.push(atomicWrite(path.join(classDir, 'course_packs.json'), JSON.stringify(payload.course_packs, null, 2)));
  }

  if (course.syllabus_body) {
    writes.push(atomicWrite(path.join(classDir, 'syllabus.html'), course.syllabus_body));
  }

  // Raw snapshot: ~/Documents/CANVASync/raw/YYYY-MM-DD/<courseId>/payload.json
  const dateStr = new Date().toISOString().slice(0, 10);
  const rawDir = path.join(syncHome(), 'raw', dateStr, String(courseId));
  await fs.mkdir(rawDir, { recursive: true });
  writes.push(atomicWrite(path.join(rawDir, 'payload.json'), JSON.stringify(payload, null, 2)));

  await Promise.all(writes);
  return { classDir, slug };
}

// Pick a canonical extension for the saved syllabus file based on content type
// first (most reliable), falling back to the source filename. Keeps syllabus.pdf
// / syllabus.docx / syllabus.html naming consistent regardless of what Canvas
// called the file.
function syllabusExtension(contentType, filename) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('pdf')) return '.pdf';
  if (ct.includes('word') || ct.includes('officedocument.wordprocessingml')) return '.docx';
  if (ct.includes('html')) return '.html';
  const name = (filename || '').toLowerCase();
  if (name.endsWith('.pdf'))              return '.pdf';
  if (/\.docx?$/.test(name))              return '.docx';
  if (/\.html?$/.test(name))              return '.html';
  const m = name.match(/\.([a-z0-9]+)$/);
  return m ? `.${m[1]}` : '.pdf';
}

export async function writeFile(payload = {}) {
  // Accept both legacy (`filename`/`dataBase64`) and the extension's actual
  // field names (`displayName`/`base64`). Either naming works.
  const { courseId, contentType, isSyllabus } = payload;
  const filename   = payload.filename   || payload.displayName;
  const dataBase64 = payload.dataBase64 || payload.base64;
  if (!courseId || !filename || !dataBase64) throw new Error('writeFile: missing required fields');

  const classesDir = path.join(syncHome(), 'classes');
  let classDir;
  try {
    const entries = await fs.readdir(classesDir);
    const match = entries.find(e => e.startsWith(`${courseId}-`));
    if (match) classDir = path.join(classesDir, match);
  } catch {
    // classesDir may not exist yet if writeCourse hasn't run
  }
  if (!classDir) throw new Error(`writeFile: no class dir found for courseId ${courseId}`);

  const buffer = Buffer.from(dataBase64, 'base64');
  const safeFilename = path.basename(filename);
  const destPath = path.join(classDir, safeFilename);
  await atomicWriteBinary(destPath, buffer);

  // `false` is authoritative. The extension ranks every syllabus-looking file,
  // marks the best candidate true and the remaining candidates false. Treating
  // every filename containing "syllabus" as canonical meant the *last*,
  // lowest-ranked candidate overwrote the best one. Only fall back to the
  // legacy filename heuristic when an older caller omitted isSyllabus.
  const nameHasSyllabus = /syllabus/i.test(safeFilename);
  const canonicalSyllabus = isSyllabus === true
    || (isSyllabus == null && nameHasSyllabus);
  if (canonicalSyllabus) {
    const ext = syllabusExtension(contentType, safeFilename);
    const syllabusPath = path.join(classDir, `syllabus${ext}`);
    await atomicWriteBinary(syllabusPath, buffer);

    // A professor can replace a PDF with a DOCX (or vice versa). The parser
    // prefers PDF, so leaving the old binary beside the new canonical file
    // silently keeps parsing the obsolete document forever. syllabus.html is
    // deliberately retained: Canvas's syllabus tab is a separate useful source.
    for (const obsoleteExt of ['.pdf', '.docx']) {
      if (obsoleteExt === ext) continue;
      await fs.rm(path.join(classDir, `syllabus${obsoleteExt}`), { force: true });
    }

    const hashPath = path.join(classDir, 'syllabus.hash');
    const newHash = crypto.createHash('sha256').update(buffer).digest('hex');
    let changed = false;
    try {
      const prev = (await fs.readFile(hashPath, 'utf8')).trim();
      changed = prev !== newHash;
    } catch {
      // no prior hash
    }
    await atomicWrite(hashPath, newHash);
    return { changed, syllabusPath: path.basename(syllabusPath) };
  }

  return {};
}

export async function updateLastSync(coursesSeen) {
  const dest = path.join(syncHome(), 'last_sync.json');
  await atomicWrite(dest, JSON.stringify({ timestamp: new Date().toISOString(), coursesSeen }, null, 2));
}

// --- v1.1: files_index helpers ---

// Read <classDir>/files_index.json. Missing is an empty first ingest; corrupt or
// otherwise unreadable is not, and a writer must preserve it rather than
// replacing an unknown snapshot with an empty one.
export async function readFilesIndex(classDir) {
  const indexPath = path.join(classDir, 'files_index.json');
  let raw;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { entries: [], unreadable: false };
    return { entries: [], unreadable: true, reason: err?.code ?? 'unreadable' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { entries: [], unreadable: true, reason: 'shape' };
    return { entries: parsed, unreadable: false };
  } catch {
    return { entries: [], unreadable: true, reason: 'parse' };
  }
}

// Atomic write of the files_index.json for a class dir.
export async function writeFilesIndex(classDir, entries) {
  const indexPath = path.join(classDir, 'files_index.json');
  await atomicWrite(indexPath, JSON.stringify(entries ?? [], null, 2));
}

// --- v1.1: writeCourseFile (per plan 1b) ---
// Payload: { courseId, fileId, displayName, filename, contentType, size,
//            canvasUpdatedAt, dataBase64 }
// Returns { changed: bool, localPath }.
export async function writeCourseFile(payload = {}) {
  const {
    courseId,
    fileId,
    displayName,
    filename,
    contentType,
    size,
    canvasUpdatedAt,
    dataBase64,
  } = payload;

  if (!courseId) throw new Error('writeCourseFile: missing courseId');
  if (fileId === undefined || fileId === null) throw new Error('writeCourseFile: missing fileId');
  if (!dataBase64) throw new Error('writeCourseFile: missing dataBase64');
  const chosenName = displayName || filename;
  if (!chosenName) throw new Error('writeCourseFile: missing displayName/filename');

  // Locate class dir: mirrors writeFile() guard at storage.js:111-120.
  const classesDir = path.join(syncHome(), 'classes');
  let classDir;
  try {
    const entries = await fs.readdir(classesDir);
    const match = entries.find(e => e.startsWith(`${courseId}-`));
    if (match) classDir = path.join(classesDir, match);
  } catch {
    // classesDir may not exist yet
  }
  if (!classDir) throw new Error(`writeCourseFile: no class dir found for courseId ${courseId}`);

  // Ensure files/ subdir exists.
  const filesDir = path.join(classDir, 'files');
  await fs.mkdir(filesDir, { recursive: true, mode: 0o700 });

  // Path-traversal guard: same pattern as writeFile() at line 123.
  const safeBase = path.basename(chosenName);
  let safeFilename = safeBase;

  // files_index.json is read here and written at the end of this function,
  // with a binary write in between — a read-modify-write across two awaits.
  // The in-process lock alone is not enough: the spawned extract stage rewrites
  // the same file from a DIFFERENT process, so there is no temp collision and
  // no error, just a write that silently is not there. withFilesIndexLock takes
  // both layers, in-process first. See file-lock.js and WRITE-SAFETY-AUDIT.md
  // "Site 1". The deadline is short on purpose: this serves an HTTP request,
  // and the extension retries a 503 rather than waiting on a held-open socket.
  return withFilesIndexLock(classDir, async () => {
    // Load existing index to detect collisions and skip-if-unchanged.
    const state = await readFilesIndex(classDir);
    await preserveUnreadable(state, path.join(classDir, 'files_index.json'));
    const index = state.entries;
    const existingEntry = index.find(e => e && e.canvasId === fileId);

    // Skip if size + canvasUpdatedAt match (plan 1b step 6).
    if (existingEntry
        && existingEntry.size === size
        && existingEntry.canvasUpdatedAt === canvasUpdatedAt) {
      return { changed: false, localPath: existingEntry.localPath };
    }

    // Collision with a different canvasId → append -<canvasId> before extension.
    const collision = index.find(e =>
      e && e.canvasId !== fileId &&
      path.basename(e.localPath || '') === safeBase
    );
    if (collision) {
      const ext = path.extname(safeBase);
      const stem = safeBase.slice(0, safeBase.length - ext.length);
      safeFilename = `${stem}-${fileId}${ext}`;
    }

    // Atomic binary write.
    const buffer = Buffer.from(dataBase64, 'base64');
    const destPath = path.join(filesDir, safeFilename);
    await atomicWriteBinary(destPath, buffer);

    // Upsert index entry with extraction pending.
    const localPath = path.join('files', safeFilename);
    const now = new Date().toISOString();
    const upserted = {
      canvasId: fileId,
      displayName: chosenName,
      filename: filename ?? chosenName,
      contentType: contentType ?? null,
      size: size ?? buffer.length,
      canvasUpdatedAt: canvasUpdatedAt ?? null,
      localPath,
      materialsPath: null,
      extractionStatus: 'pending',
      extractionError: null,
      textSha256: null,
      duplicateOf: null,
      skipped: null,
      lastSyncedAt: now,
    };

    const idx = index.findIndex(e => e && e.canvasId === fileId);
    if (idx >= 0) {
      // Preserve any fields the extractor may have set we don't want to clobber.
      // OPEN: on re-download we deliberately reset extractionStatus to 'pending'
      // so downstream extractor re-processes. Preserving materialsPath so the
      // old .txt isn't orphaned during the extract job.
      index[idx] = {
        ...index[idx],
        ...upserted,
        materialsPath: index[idx].materialsPath ?? null,
      };
    } else {
      index.push(upserted);
    }
    await writeFilesIndex(classDir, index);

    return { changed: true, localPath };
  });
}

// --- v1.1: safe delete (per plan 3a) ---

export class DeleteValidationError extends Error {
  constructor(message, rule) {
    super(message);
    this.name = 'DeleteValidationError';
    this.rule = rule;
  }
}

const FOLDER_NAME_RE = /^[0-9]+-[a-z0-9-]+$/;

export function isValidFolderName(folderName) {
  return typeof folderName === 'string'
    && folderName.length > 0
    && FOLDER_NAME_RE.test(folderName);
}

// Recursively compute size + file count using sync APIs.
function enumerateDir(dir) {
  let bytes = 0;
  let files = 0;
  const st = fsSync.statSync(dir);
  if (st.isFile()) {
    return { bytes: st.size, files: 1 };
  }
  if (!st.isDirectory()) {
    return { bytes: 0, files: 0 };
  }
  const entries = fsSync.readdirSync(dir);
  for (const name of entries) {
    const full = path.join(dir, name);
    // Use lstat so we don't follow symlinks here — rule 6 already refused
    // any symlinked class dir itself; inner symlinks just count as 1 file.
    const lst = fsSync.lstatSync(full);
    if (lst.isDirectory()) {
      const inner = enumerateDir(full);
      bytes += inner.bytes;
      files += inner.files;
    } else {
      bytes += lst.size;
      files += 1;
    }
  }
  return { bytes, files };
}

// Read-only sibling of the rule-8 enumeration inside safeDeleteClass. The
// cleanup review panel has to tell the user how much disk a stale class is
// holding *before* they agree to delete it, and it must not go anywhere near
// the delete path to find out. Returns null for anything that is not a real
// class directory rather than throwing — a listing must not fail because one
// folder was removed underneath it.
export function measureClass(folderName) {
  if (!isValidFolderName(folderName)) return null;
  const target = path.join(syncHome(), 'classes', folderName);
  try {
    if (!fsSync.statSync(target).isDirectory()) return null;
    return enumerateDir(target);
  } catch {
    return null;
  }
}

// Sole destructive entry point for class data. Enforces all 8 rules from
// plan 3a in the given order. Throws DeleteValidationError on any rule
// violation. Returns { folderName, sizeBytes, fileCount } on success.
export function safeDeleteClass(...args) {
  // Rule 1: arg type. One arg, non-empty string.
  if (args.length !== 1) {
    const rule = 'rule-1';
    const input = args.length === 0 ? '<empty>' : `<${args.length} args>`;
    // Use sync logging via appendFileSync so the audit line lands before throw.
    logDeleteFailSync(rule, input);
    throw new DeleteValidationError('safeDeleteClass: expected exactly one argument', rule);
  }
  const folderName = args[0];
  if (typeof folderName !== 'string' || folderName.length === 0) {
    const rule = 'rule-1';
    logDeleteFailSync(rule, JSON.stringify(folderName));
    throw new DeleteValidationError('safeDeleteClass: folderName must be a non-empty string', rule);
  }

  // Rule 2: regex.
  if (!FOLDER_NAME_RE.test(folderName)) {
    const rule = 'rule-2';
    logDeleteFailSync(rule, folderName);
    throw new DeleteValidationError(`safeDeleteClass: folderName failed regex (${FOLDER_NAME_RE})`, rule);
  }

  // Rule 3: path compose via syncHome() — respects CANVAS_SYNC_HOME.
  const root = syncHome();
  const classesDir = path.join(root, 'classes');
  const target = path.join(classesDir, folderName);

  // Rule 4: relative check.
  const rel = path.relative(classesDir, target);
  if (!rel || rel.startsWith('..') || rel.includes(path.sep)) {
    const rule = 'rule-4';
    logDeleteFailSync(rule, folderName);
    throw new DeleteValidationError('safeDeleteClass: relative path check failed', rule);
  }

  // Rule 5: existence check.
  if (!fsSync.existsSync(target)) {
    const rule = 'rule-5';
    logDeleteFailSync(rule, folderName);
    throw new DeleteValidationError(`safeDeleteClass: target does not exist: ${target}`, rule);
  }

  // Rule 6: realpath match — protect against symlink escape.
  // We resolve both the target and its expected parent so that on macOS
  // (where /tmp -> /private/tmp) a legitimate tmpdir fixture isn't falsely
  // refused. The security invariant we need: the real parent of the
  // real target equals the real classesDir, and the real target's leaf
  // basename still equals folderName.
  let realTarget, realParent;
  try {
    realTarget = fsSync.realpathSync(target);
    realParent = fsSync.realpathSync(classesDir);
  } catch (err) {
    const rule = 'rule-6';
    logDeleteFailSync(rule, folderName);
    throw new DeleteValidationError(`safeDeleteClass: realpath failed: ${err.message}`, rule);
  }
  if (path.dirname(realTarget) !== realParent || path.basename(realTarget) !== folderName) {
    const rule = 'rule-6';
    logDeleteFailSync(rule, folderName);
    throw new DeleteValidationError('safeDeleteClass: realpath mismatch (symlink escape?)', rule);
  }

  // Rule 7: sentinel check — metadata.json must exist in target.
  if (!fsSync.existsSync(path.join(target, 'metadata.json'))) {
    const rule = 'rule-7';
    logDeleteFailSync(rule, folderName);
    throw new DeleteValidationError('safeDeleteClass: sentinel metadata.json not found', rule);
  }

  // Rule 8: enumerate before delete.
  const { bytes: sizeBytes, files: fileCount } = enumerateDir(target);

  // Log start — synchronous append so order is deterministic around the delete.
  logDeleteSync(`DELETE_START folder=${folderName} path=${target} size=${sizeBytes} files=${fileCount}`);

  // Deletion: fs.rmSync only, no shell, no child_process.
  fsSync.rmSync(target, { recursive: true, force: false, maxRetries: 3 });

  logDeleteSync(`DELETE_COMPLETE folder=${folderName}`);
  return { folderName, sizeBytes, fileCount };
}

// Synchronous log writer for safeDeleteClass (which is sync).
function logDeleteSync(line) {
  try {
    const root = syncHome();
    const logDir = path.join(root, 'logs');
    fsSync.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'delete.log');
    const entry = `${new Date().toISOString()} ${line}\n`;
    fsSync.appendFileSync(logPath, entry, 'utf8');
  } catch {
    // Logging is best-effort. Never throw from the logger.
  }
}

function logDeleteFailSync(rule, input) {
  // Inputs may contain odd chars. Keep input readable, truncated.
  const clipped = typeof input === 'string'
    ? input.slice(0, 200)
    : String(input).slice(0, 200);
  logDeleteSync(`DELETE_FAILED reason=${rule} input=${JSON.stringify(clipped)}`);
}
