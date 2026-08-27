// index-progress.js — what has actually been indexed, and what is still running.
//
// The dashboard could already say "6 classes synced". That number is true and
// useless. At 18:12 on 2026-08-24 all six classes were "synced" while:
// econ-205 had no AI_CONTEXT directory at all, busi-380's correlation graph was
// built at 12:54 from data rewritten at 12:58, three mine-assignments jobs sat
// queued behind one 11.7 GB MLX model load, and .DS_Store was being enumerated
// as a seventh class. None of that was visible anywhere in the app.
//
// This module answers the question the count cannot: per class, per stage, what
// exists on disk, what is out of date, what is running right now, and what
// failed. It is strictly READ-ONLY — it never writes a byte, never spawns a
// pipeline stage, never invokes a model and never takes the model lock (it asks
// _util.js's modelLockStatus(), which is itself a pure stat+kill(pid,0) probe).
//
// GOVERNING RULE, the progress analogue of meeting-times.js's "no time beats a
// wrong time": NO STATE BEATS A FLATTERING STATE. Every place where the system
// genuinely cannot tell two situations apart gets a state that says so —
// 'running-or-interrupted' when a START has no END and nothing can confirm
// liveness, percent:null when the denominator is zero. A progress bar that
// reads 100% because it cannot see the remaining work is the exact failure this
// file exists to prevent, so a percentage is only ever emitted next to the
// denominator it was divided by.
//
// Three things are read to decide "is it running", in descending authority:
//   1. pipelineStatus() from bridge/trigger.js — in-memory, authoritative for
//      "still alive", but per-process: a bridge that did not spawn the children
//      reports idle even while they run, and it discards child.pid entirely.
//   2. the process table (`ps -axo pid=,args=`) — recovers the pid and the
//      classDir that trigger.js threw away, and is the only way to notice a
//      stage orphaned by a bridge restart. Optional; absent, we say so.
//   3. <home>/logs/trigger.log — append-only, ISO-stamped, gives startedAt to
//      the millisecond, exit codes and the OUTPUT block of a failure.
//
// Node builtins only, plus this repo's root modules and scripts/_util.js:
// bridge/, scripts/ and app/ have separate node_modules trees and the bridge
// imports this file directly.

import { readFile, readdir, stat, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRoot } from '../data-root.js';
import { readSyncScope, isInScope, courseIdOf, CLASS_DIR_RE } from '../scope.js';
import { modelLockStatus, anthropicKeyStatus, sha256File } from './_util.js';
import { compactCourseCode } from './cal-names.js';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Source lists, copied from the two orchestrators.
//
// These MUST stay in step with bridge/trigger.js:327 and
// scripts/sync-all-contexts.js:63. They are duplicated here rather than
// imported because importing trigger.js from scripts/ would pull the bridge's
// module-level pipeline state into a CLI process. See the integration note in
// the module docs: the right end state is one shared predicates module that all
// three import. Until then, `PREDICATE_NOTES` below reports every place the two
// orchestrators already disagree, so the page can never quietly claim a stage
// is stale that the pipeline would then decline to run.
// ---------------------------------------------------------------------------

const BUILD_SOURCES = [
  'metadata.json', 'assignments.json', 'assignment_groups.json', 'modules.json',
  'announcements.json', 'pages.json', 'quizzes.json', 'discussions.json',
  'calendar_events.json', 'grades.json', 'tabs.json', 'files_index.json',
  'syllabus_parsed.json', 'assignments_mined.json', 'readings_index.json',
  'materials/last_extracted.txt',
];

// grades/files_index/metadata/tabs are deliberately absent: a changed grade must
// not re-fire a 900-second AI job (sync-all-contexts.js:75).
const MINE_SOURCES = [
  'assignments.json', 'assignment_groups.json', 'modules.json', 'announcements.json',
  'pages.json', 'quizzes.json', 'discussions.json', 'calendar_events.json',
  'syllabus_parsed.json', 'readings_index.json', 'materials/last_extracted.txt',
];

const GRAPH_SOURCES = [
  'files_index.json', 'assignments.json', 'modules.json', 'pages.json',
  'quizzes.json', 'announcements.json', 'discussions.json', 'metadata.json',
  'syllabus.html', 'materials/last_extracted.txt',
];

const SYLLABUS_SOURCES = ['syllabus.pdf', 'syllabus.docx', 'syllabus.html'];

// correlation-graph.js exports GRAPH_FILE, but it is not on this module's
// import allowlist (bridge/ must be able to load us with builtins only), so the
// name is repeated here. If it ever changes there, change it here.
const GRAPH_FILE = 'correlation_graph.json';

/**
 * The pipeline, in dependency order. `counted` decides whether a stage is part
 * of the percentage denominator — see the two exclusions below, both of which
 * would otherwise park every class permanently short of 100% for reasons that
 * have nothing to do with the user's data.
 */
export const STAGES = [
  {
    key: 'parse', label: 'Syllabus', script: 'parse-syllabus.js', needsModel: true,
    inputs: SYLLABUS_SOURCES, anchor: 'syllabus_parsed.json',
    errorSidecar: 'syllabus_parsed.json.ERROR',
    // parse-syllabus.js:381 rm's the sidecar after a good parse precisely so a
    // stale one cannot read as a current failure — so presence alone is enough.
    sidecarClearedOnSuccess: true,
    orchestrators: ['bridge/trigger.js:331', 'scripts/sync-all-contexts.js:185'],
    counted: true, notCountedReason: null,
  },
  {
    key: 'extract', label: 'Course files', script: 'extract-course-files.js', needsModel: false,
    inputs: ['files_index.json'], dirInputs: ['files'],
    // Written last (extract-course-files.js:525). _combined.txt is absent in
    // split mode and files_index.json is rewritten by this stage itself, so
    // neither of those can anchor it.
    anchor: 'materials/last_extracted.txt', errorSidecar: null,
    orchestrators: ['bridge/trigger.js:336', 'scripts/sync-all-contexts.js:186'],
    counted: true, notCountedReason: null,
  },
  {
    key: 'index', label: 'Dated readings', script: 'index-readings.js', needsModel: false,
    inputs: [
      'metadata.json', 'syllabus_parsed.json', 'syllabus.html',
      'files_index.json', 'materials/last_extracted.txt',
    ],
    anchor: 'readings_index.json', errorSidecar: null,
    orchestrators: ['bridge/trigger.js:368', 'scripts/sync-all-contexts.js:193'],
    counted: true, notCountedReason: null,
  },
  {
    key: 'mine', label: 'Task mining', script: 'mine-assignments.js', needsModel: true,
    inputs: MINE_SOURCES, anchor: 'assignments_mined.json',
    errorSidecar: 'assignments_mined.json.ERROR',
    // mine-assignments.js:347 writes this sidecar and nothing ever removes it,
    // so one bad run would mark the class failed forever. Qualify it by mtime.
    sidecarClearedOnSuccess: false,
    orchestrators: ['bridge/trigger.js:342', 'scripts/sync-all-contexts.js:187'],
    counted: true, notCountedReason: null,
  },
  {
    key: 'graph', label: 'Correlation graph', script: 'build-graph.js', needsModel: false,
    inputs: GRAPH_SOURCES, anchor: GRAPH_FILE, errorSidecar: null,
    orchestrators: ['bridge/trigger.js', 'scripts/sync-all-contexts.js'],
    counted: true, notCountedReason: null,
  },
  {
    key: 'build', label: 'AI context', script: 'build-context.js', needsModel: true,
    inputs: BUILD_SOURCES,
    // Written last (build-context.js:680); its contents are the ISO stamp.
    anchor: 'AI_CONTEXT/last_built.txt', errorSidecar: null,
    orchestrators: ['bridge/trigger.js:350', 'scripts/sync-all-contexts.js:189'],
    counted: true, notCountedReason: null,
  },
  {
    key: 'pack2', label: 'Context pack v2', script: 'build-pack.js', needsModel: false,
    inputs: [], anchor: 'AI_CONTEXT/pack2/00-START-HERE.md', errorSidecar: null,
    // buildPack() is complete and tested and no orchestrator spawns it.
    orchestrators: [], wired: false,
    counted: false, notCountedReason: 'not-wired',
  },
];

const STAGE_BY_SCRIPT = new Map(STAGES.map(s => [s.script, s]));

/**
 * Which category reads the file a stage anchors on — so "the anchor exists and
 * is newer than its sources" can be cross-checked against "the anchor actually
 * parses".
 *
 * Without this the two halves of the same payload contradict each other: a
 * truncated syllabus_parsed.json newer than syllabus.pdf renders `parse done`
 * and `3/3 100%` three lines above `syllabus: error — invalid JSON`. That is
 * the flattering state this file exists to refuse. atomicWriteJson (tmp+rename,
 * _util.js:29) makes it rare — disk-full, a hand edit, an iCloud restore — but
 * "rare" is not "reported correctly".
 *
 * extract is deliberately absent: its category ('files') goes 'error' when ANY
 * single file failed to extract, which is a partial result, not an unreadable
 * output. Flipping the stage to 'failed' on one bad PDF would be the opposite
 * error — a pessimistic state that is also wrong.
 */
const ANCHOR_CATEGORY = new Map([
  ['parse', 'syllabus'],
  ['mine', 'minedTasks'],
  ['graph', 'correlationGraph'],
  ['build', 'contextPack'],
]);

// Every place the two orchestrators disagree about "is this stale". Reported in
// the payload so a user who sees 'stale' here and then watches the pipeline
// decline to run that stage has the reason in front of them rather than
// concluding the page lies.
const PREDICATE_NOTES = [
  {
    stage: 'parse',
    disagreement: "bridge/trigger.js:305 compares mtimes only; scripts/sync-all-contexts.js:25 additionally confirms with syllabus.hash.",
    implemented: 'sync-all-contexts.js (hash-confirmed)',
    why: 'the bridge rewrites syllabus.html byte-identically on every ingest, so the mtime-only predicate reports this AI stage stale forever.',
  },
  {
    stage: 'extract',
    disagreement: "bridge/trigger.js:336 also watches files/ one level deep; scripts/sync-all-contexts.js:92 watches only files_index.json.",
    implemented: 'the union (both)',
    why: 'a newly downloaded file that has not yet been folded into files_index.json is still unextracted work.',
  },
  {
    stage: 'build',
    disagreement: "scripts/sync-all-contexts.js:63 includes files_index.json in DATA_FILES; bridge/trigger.js:350 does not.",
    implemented: 'the union (both)',
    why: 'extract rewrites files_index.json, and a context built before that rewrite was built from fewer materials.',
  },
];

// The nine categories mine-assignments.js validates against (line 206). Listed
// so byCategory always reports all nine, including the zeroes — reading:0 is
// the finding, and a byCategory that omits empty keys hides it.
const MINED_CATEGORIES = [
  'homework', 'reading', 'quiz', 'exam', 'project', 'paper', 'presentation',
  'participation', 'other',
];

const WORKLIST_KINDS = ['meeting', 'homework', 'reading', 'exam', 'checkpoint'];

// How much of trigger.log to read. The file is never rotated (86 KB and growing
// on this machine) and a poll every 3 s must not read megabytes; anything older
// than the window is reported as out-of-window rather than as "never ran".
const DEFAULT_LOG_TAIL_BYTES = 1024 * 1024;

// Above this, skip the content hash and say so. sha256 of a 700 KB syllabus is
// about a millisecond; sha256 of a 200 MB one on every 3 s poll is not.
const MAX_HASH_BYTES = 64 * 1024 * 1024;

// How long a lock may plausibly sit between mkdir and writeFile. Must match
// _acquireModelLock's own staleness window (scripts/_util.js:~168) — past it,
// that function reclaims the lock, so this report must not still be calling the
// holder "mid-acquire".
const MID_ACQUIRE_WINDOW_MS = 10_000;

// mtime comparisons run against APFS nanosecond stamps while the evidence
// string renders at millisecond resolution, so a 0.058 ms difference used to
// print as "X (…763.763Z) is newer than Y (…763.763Z)" — two identical
// timestamps offered as proof. A stage that writes two files inside the same
// millisecond is not evidence that anything is out of date.
const STALE_EPSILON_MS = 1;

// ---------------------------------------------------------------------------
// tiny fs helpers — every one of them swallows errors, because a half-synced or
// missing data root is the normal first-run state, not an exception
// ---------------------------------------------------------------------------

async function statSafe(p) {
  try { return await stat(p); } catch { return null; }
}

async function mtimeOf(p) {
  const s = await statSafe(p);
  return s ? s.mtimeMs : null;
}

function iso(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
}

/**
 * Read JSON, distinguishing "absent" from "corrupt".
 *
 * _util.js's readJsonSafe() returns null for both, which is right for a
 * consumer that just wants the data and wrong for this one: a class whose
 * assignments.json is truncated mid-write must render as an error, not as a
 * class that has no assignments.
 */
async function readJsonAt(p) {
  let text;
  try {
    text = await readFile(p, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { present: false, value: null, error: null };
    return { present: false, value: null, error: `unreadable: ${String(err.message).slice(0, 160)}` };
  }
  try {
    return { present: true, value: JSON.parse(text), error: null };
  } catch (err) {
    return { present: true, value: null, error: `invalid JSON: ${String(err.message).slice(0, 160)}` };
  }
}

async function newestMtimeInDir(dir) {
  try {
    const names = await readdir(dir);
    let newest = 0;
    for (const name of names) {
      const s = await statSafe(path.join(dir, name));
      if (s && s.isFile() && s.mtimeMs > newest) newest = s.mtimeMs;
    }
    return newest;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// staleness — the pipeline's own predicates, not a second opinion
// ---------------------------------------------------------------------------

/**
 * The shared shape of both orchestrators' checks: is `anchorRel` older than any
 * of its sources? A missing anchor is stale only when at least one source
 * exists, which is what keeps an empty class dir out of the "needs work" pile.
 */
async function outputStale(classDir, anchorRel, sourceRels, dirRels = []) {
  const anchorAt = await mtimeOf(path.join(classDir, anchorRel));
  const sourceMtimes = await Promise.all(sourceRels.map(r => mtimeOf(path.join(classDir, r))));
  const dirMtimes = await Promise.all(dirRels.map(r => newestMtimeInDir(path.join(classDir, r))));
  const present = [];
  let newest = 0;
  let newestFrom = null;
  sourceRels.forEach((rel, i) => {
    const m = sourceMtimes[i];
    if (m == null) return;
    present.push(rel);
    if (m > newest) { newest = m; newestFrom = rel; }
  });
  dirRels.forEach((rel, i) => {
    const m = dirMtimes[i];
    if (!m) return;
    present.push(`${rel}/`);
    if (m > newest) { newest = m; newestFrom = `${rel}/`; }
  });
  const inputsPresent = present.length > 0;
  if (!inputsPresent) return { inputsPresent: false, anchorAt, stale: false, reason: null, newestSource: null };
  if (anchorAt == null) {
    return {
      inputsPresent: true, anchorAt: null, stale: true,
      reason: `${anchorRel} has never been written (${present.length} input(s) present)`,
      newestSource: iso(newest),
    };
  }
  if (newest - anchorAt >= STALE_EPSILON_MS) {
    return {
      inputsPresent: true, anchorAt, stale: true,
      reason: `${newestFrom} (${iso(newest)}) is newer than ${anchorRel} (${iso(anchorAt)})`,
      newestSource: iso(newest),
    };
  }
  return { inputsPresent: true, anchorAt, stale: false, reason: null, newestSource: iso(newest) };
}

/**
 * parse's predicate, in scripts/sync-all-contexts.js's stricter form: an mtime
 * that looks newer is confirmed against syllabus.hash before we call it stale.
 *
 * Without the hash step this stage reads as stale on every single sync forever,
 * because the bridge rewrites syllabus.html byte-identically each ingest — and
 * "stale" on an AI stage is what makes a user press the button that loads a
 * 20 GB model for no reason.
 */
async function parseStaleness(classDir) {
  const base = await outputStale(classDir, 'syllabus_parsed.json', SYLLABUS_SOURCES);
  if (!base.inputsPresent || !base.stale || base.anchorAt == null) return { ...base, hashChecked: false };

  const hashPath = path.join(classDir, 'syllabus.hash');
  let stored = null;
  try { stored = (await readFile(hashPath, 'utf8')).trim(); } catch { /* no stored hash */ }
  if (!stored) return { ...base, hashChecked: false };

  const hashes = [];
  for (const rel of SYLLABUS_SOURCES) {
    const abs = path.join(classDir, rel);
    const s = await statSafe(abs);
    if (!s || !s.isFile()) continue;
    if (s.size > MAX_HASH_BYTES) return { ...base, hashChecked: false };
    try { hashes.push(await sha256File(abs)); } catch { /* unreadable — fall back to the mtime signal */ }
  }
  if (hashes.length === 0) return { ...base, hashChecked: false };
  if (hashes.includes(stored)) {
    return {
      ...base, stale: false, hashChecked: true,
      reason: null,
      note: `mtime looks newer but syllabus.hash still matches a current source — the bridge rewrote the syllabus byte-identically`,
    };
  }
  return { ...base, hashChecked: true, reason: `${base.reason}; syllabus.hash matches none of the current sources` };
}

async function stageStaleness(classDir, stage) {
  if (stage.key === 'parse') return parseStaleness(classDir);
  return outputStale(classDir, stage.anchor, stage.inputs, stage.dirInputs ?? []);
}

// ---------------------------------------------------------------------------
// trigger.log
// ---------------------------------------------------------------------------

const LOG_HEAD_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z) (START|END|SKIP|ERROR|OUTPUT|CANCEL|RERUN)\b ?(.*)$/;

/**
 * Reconstruct per-(class, script) stage history from the append-only log.
 *
 * classDirs are matched by containment rather than by tokenising on whitespace:
 * a fixture root under mkdtemp on this machine contains a space, and a `(\S+)`
 * classDir capture silently drops every one of those lines.
 */
export async function readTriggerLog(root, { classDirs = [], maxBytes = DEFAULT_LOG_TAIL_BYTES } = {}) {
  const logPath = path.join(root, 'logs', 'trigger.log');
  const st = await statSafe(logPath);
  const out = {
    available: false, path: logPath, bytes: 0, truncated: false,
    byKey: new Map(), lastCancelAt: null, lastRerunAt: null,
  };
  if (!st || !st.isFile()) return out;

  let text = '';
  try {
    if (st.size <= maxBytes) {
      text = await readFile(logPath, 'utf8');
    } else {
      const buf = Buffer.alloc(maxBytes);
      const fh = await open(logPath, 'r');
      try { await fh.read(buf, 0, maxBytes, st.size - maxBytes); } finally { await fh.close(); }
      const raw = buf.toString('utf8');
      // Drop the first partial line so a half-line cannot parse as a real one.
      text = raw.slice(raw.indexOf('\n') + 1);
      out.truncated = true;
    }
  } catch {
    return out;
  }
  out.available = true;
  out.bytes = Buffer.byteLength(text);

  // Longest first: '12345-a' must not shadow '12345-abc'.
  const dirs = [...classDirs].sort((a, b) => b.length - a.length);
  const entryFor = (dir, script) => {
    const key = `${dir}\u0000${script}`;
    let e = out.byKey.get(key);
    if (!e) {
      e = { classDir: dir, script, lastStart: null, lastEnd: null, lastSkip: null, lastError: null, lastOutput: null, starts: 0 };
      out.byKey.set(key, e);
    }
    return e;
  };

  let pendingOutput = null;
  for (const line of text.split('\n')) {
    const m = LOG_HEAD_RE.exec(line);
    if (!m) {
      if (pendingOutput) {
        if (line.trim() === '--- end output ---') pendingOutput = null;
        else pendingOutput.text = `${pendingOutput.text}${pendingOutput.text ? '\n' : ''}${line}`;
      }
      continue;
    }
    pendingOutput = null;
    const [, at, verb, rest] = m;
    const atMs = Date.parse(at);
    if (verb === 'CANCEL') { out.lastCancelAt = at; continue; }
    if (verb === 'RERUN') { out.lastRerunAt = at; continue; }

    const sp = rest.indexOf(' ');
    const script = sp === -1 ? rest : rest.slice(0, sp);
    const tail = sp === -1 ? '' : rest.slice(sp + 1);
    const dir = dirs.find(d => tail.includes(d));
    if (!dir) continue; // a global job (sync-calendar on classes/) or a class we no longer hold
    const e = entryFor(dir, script);

    if (verb === 'START') { e.lastStart = { at, atMs }; e.starts += 1; continue; }
    if (verb === 'END') {
      const em = /exit=(\S+)\s*$/.exec(tail);
      const raw = em ? em[1] : null;
      const exit = raw == null || raw === 'null' ? null : Number.parseInt(raw, 10);
      e.lastEnd = { at, atMs, exit: Number.isNaN(exit) ? null : exit };
      continue;
    }
    if (verb === 'SKIP') { e.lastSkip = { at, atMs, reason: /\(cancelled\)/.test(tail) ? 'cancelled' : 'skipped' }; continue; }
    if (verb === 'ERROR') { e.lastError = { at, atMs, message: tail.slice(dir.length).trim().slice(0, 500) }; continue; }
    if (verb === 'OUTPUT') {
      e.lastOutput = { at, atMs, text: '' };
      if (!/\(no output\)\s*$/.test(tail)) pendingOutput = e.lastOutput;
      continue;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the process table — the pid and startedAt trigger.js throws away
// ---------------------------------------------------------------------------

/**
 * Find live stage processes by scanning `ps`.
 *
 * trigger.js keeps the live ChildProcess in a Set and the token in another, and
 * discards child.pid (trigger.js:181), so nothing in the running bridge can tie
 * a job to the model lock it is waiting on. Reading the process table recovers
 * exactly that, costs one ~10 ms exec, and is the only way to see a stage
 * orphaned by a bridge restart — which reports as idle from memory.
 *
 * Read-only and best-effort: any failure degrades to available:false, and every
 * state that depended on it then says "liveness unverifiable" rather than
 * guessing the flattering answer.
 */
/**
 * The model process itself, which the stage scan cannot see.
 *
 * localInvoke spawns scripts/local_generate.py, which loads MLX into a PYTHON
 * child; `ps` matched against STAGE_BY_SCRIPT finds the node stage above it and
 * never the ~12 GB process underneath. That matters because the lock and the
 * residency are different questions: a stage that has finished generating
 * releases the lock immediately, and MLX can stay resident in RAM afterwards.
 * "Is the local model still just running in the background?" is a question
 * about the second one, and until now nothing in this system could answer it.
 */
const MLX_ARGS_RE = /local_generate\.py|mlx_lm|mlx-community|mlx\.core/;

export async function scanModelProcesses({ self = process.pid } = {}) {
  const result = { available: false, error: null, present: false, procs: [], totalRssBytes: null };
  let stdout = '';
  try {
    ({ stdout } = await execFileP('ps', ['-axo', 'pid=,rss=,args='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    result.error = String(err && err.message).slice(0, 160);
    return result;
  }
  result.available = true;
  let total = 0;
  let sawRss = false;
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number.parseInt(m[1], 10);
    if (pid === self) continue;
    const args = m[3];
    if (!MLX_ARGS_RE.test(args)) continue;
    // `ps` reports rss in KiB on macOS and Linux alike.
    const rssBytes = Number.parseInt(m[2], 10) * 1024;
    if (Number.isFinite(rssBytes)) { total += rssBytes; sawRss = true; }
    result.procs.push({ pid, rssBytes: Number.isFinite(rssBytes) ? rssBytes : null, args: args.slice(0, 200) });
  }
  result.present = result.procs.length > 0;
  result.totalRssBytes = sawRss ? total : null;
  return result;
}

export async function scanStageProcesses(classesDir, { self = process.pid } = {}) {
  const result = { available: false, error: null, procs: [] };
  let stdout = '';
  try {
    ({ stdout } = await execFileP('ps', ['-axo', 'pid=,args='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    result.error = String(err && err.message).slice(0, 160);
    return result;
  }
  result.available = true;
  const prefix = classesDir.endsWith(path.sep) ? classesDir : classesDir + path.sep;
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number.parseInt(m[1], 10);
    const args = m[2];
    if (pid === self) continue;
    let script = null;
    for (const name of STAGE_BY_SCRIPT.keys()) {
      if (args.includes(`${path.sep}scripts${path.sep}${name}`)) { script = name; break; }
    }
    if (!script) continue;
    const i = args.indexOf(prefix);
    if (i === -1) continue;
    const after = args.slice(i + prefix.length);
    // Folder names are [0-9]+-[a-z0-9-]+, so the first character outside that
    // set ends the folder — safe even when the root path itself has a space.
    const fm = /^[0-9]+-[a-z0-9-]+/.exec(after);
    if (!fm) continue;
    result.procs.push({ pid, script, folder: fm[0], args: args.slice(0, 300) });
  }
  return result;
}

// ---------------------------------------------------------------------------
// categories — WHAT WE HOLD, never what Canvas has
// ---------------------------------------------------------------------------

/**
 * A Canvas "feature disabled" body: writeCourse() persists whatever the
 * extension forwarded (storage.js:71), so a course with the Pages tab switched
 * off lands a one-element array of {message} on disk. Five of the six real
 * classes hold exactly that, and a naive .length reports "1 page".
 */
function isDisabledSentinel(entry) {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.message === 'string' && entry.id === undefined
    && Object.keys(entry).length <= 2;
}

/**
 * tabs.json lists the tabs VISIBLE IN COURSE NAVIGATION, which is not the same
 * question as "is this feature enabled".
 *
 * BUSI 374's tabs.json holds no "assignments" entry, and assignments.json holds
 * seven real assignments; BUSI 396's holds eighteen. An instructor who hides a
 * tab from the nav does not delete the coursework behind it. Reporting
 * applicable:false there produced the flatly self-contradictory line
 * "Assignments 7 indexed · tab is off in Canvas".
 *
 * So the flag is only ever asserted NEGATIVELY when the data agrees with it.
 * The moment we hold items, the synced data outranks the nav list and the flag
 * goes to null (unknown) with the disagreement named. `tabHidden` keeps the raw
 * observation for anyone who wants it, under a name that claims only what
 * tabs.json can actually support.
 */
function tabApplicability(tabId, tabs, count) {
  if (tabId == null || tabs == null) return { applicable: null, tabHidden: null, note: null };
  const listed = tabs.includes(tabId);
  if (listed) return { applicable: true, tabHidden: false, note: null };
  if (count != null && count > 0) {
    return {
      applicable: null,
      tabHidden: true,
      note: `not in the course navigation, but ${count} item(s) were synced anyway — tabs.json lists visible NAV entries, not enabled features, so "off" cannot be asserted here`,
    };
  }
  return { applicable: false, tabHidden: true, note: 'not in the course navigation and nothing was synced' };
}

function listCategory(key, artifact, read, { tabId = null, tabs = null, filterSentinel = false, mtimeMs = null } = {}) {
  const base = {
    key, artifact, applicable: null, tabHidden: null, count: null, updatedAt: iso(mtimeMs),
    state: 'not-indexed', note: null,
  };
  const withTab = (fields, count) => {
    const t = tabApplicability(tabId, tabs, count);
    return {
      ...base, ...fields,
      applicable: t.applicable, tabHidden: t.tabHidden,
      note: fields.note ?? t.note ?? base.note,
    };
  };
  if (read.error) return { ...base, state: 'error', note: read.error };
  if (!read.present) {
    const t = tabApplicability(tabId, tabs, null);
    return {
      ...base, applicable: t.applicable, tabHidden: t.tabHidden,
      state: t.applicable === false ? 'n-a' : 'not-indexed',
      note: t.applicable === false ? 'course tab not enabled' : `${artifact} has not been written`,
    };
  }
  if (!Array.isArray(read.value)) return { ...base, state: 'error', note: `${artifact} is not an array` };
  const raw = read.value;
  if (filterSentinel) {
    const real = raw.filter(e => !isDisabledSentinel(e));
    if (real.length === 0 && raw.length > 0) {
      return withTab({ count: 0, state: 'unavailable', note: 'Canvas answered with a "feature disabled" body — 0 is the true count, not a failed index' }, 0);
    }
    return withTab({ count: real.length, state: real.length === 0 ? 'empty' : 'complete' }, real.length);
  }
  return withTab({ count: raw.length, state: raw.length === 0 ? 'empty' : 'complete' }, raw.length);
}

async function buildCategories(classDir, ctx) {
  const p = rel => path.join(classDir, rel);
  const [
    assignments, quizzes, modules, pages, announcements, discussions,
    filesIndex, grades, calendarEvents, mined, syllabusParsed, graph, contextJson,
  ] = await Promise.all([
    readJsonAt(p('assignments.json')), readJsonAt(p('quizzes.json')),
    readJsonAt(p('modules.json')), readJsonAt(p('pages.json')),
    readJsonAt(p('announcements.json')), readJsonAt(p('discussions.json')),
    readJsonAt(p('files_index.json')), readJsonAt(p('grades.json')),
    readJsonAt(p('calendar_events.json')), readJsonAt(p('assignments_mined.json')),
    readJsonAt(p('syllabus_parsed.json')), readJsonAt(p(GRAPH_FILE)),
    readJsonAt(p('AI_CONTEXT/context.json')),
  ]);
  const tabsRead = await readJsonAt(p('tabs.json'));
  const tabs = Array.isArray(tabsRead.value) ? tabsRead.value.map(t => t && t.id).filter(Boolean) : null;

  const mt = async rel => mtimeOf(p(rel));
  const out = [];

  out.push(listCategory('assignments', 'assignments.json', assignments, { tabId: 'assignments', tabs, mtimeMs: await mt('assignments.json') }));

  out.push(listCategory('quizzes', 'quizzes.json', quizzes, { tabId: 'quizzes', tabs, filterSentinel: true, mtimeMs: await mt('quizzes.json') }));

  const modulesCat = listCategory('modules', 'modules.json', modules, { tabId: 'modules', tabs, mtimeMs: await mt('modules.json') });
  if (Array.isArray(modules.value)) {
    modulesCat.itemCount = modules.value.reduce((n, m) => n + (Array.isArray(m?.items) ? m.items.length : 0), 0);
  }
  out.push(modulesCat);

  out.push(listCategory('pages', 'pages.json', pages, { tabId: 'pages', tabs, filterSentinel: true, mtimeMs: await mt('pages.json') }));
  out.push(listCategory('announcements', 'announcements.json', announcements, { tabId: 'announcements', tabs, mtimeMs: await mt('announcements.json') }));
  out.push(listCategory('discussions', 'discussions.json', discussions, { tabId: 'discussions', tabs, mtimeMs: await mt('discussions.json') }));

  // files ------------------------------------------------------------------
  const filesCat = {
    key: 'files', artifact: 'files_index.json', applicable: null, count: null,
    indexed: 0, failed: 0, pending: 0, skipped: 0, duplicates: 0, canvasNewer: 0,
    updatedAt: null, state: 'not-indexed',
    note: 'an entry exists only once the file has been downloaded, so the denominator is "files we received", not "files Canvas has"',
  };
  if (filesIndex.error) { filesCat.state = 'error'; filesCat.note = filesIndex.error; }
  else if (!filesIndex.present) { filesCat.state = 'not-indexed'; filesCat.note = 'files_index.json has not been written'; }
  else if (!Array.isArray(filesIndex.value)) { filesCat.state = 'error'; filesCat.note = 'files_index.json is not an array'; }
  else {
    const entries = filesIndex.value.filter(e => e && typeof e === 'object');
    const live = entries.filter(e => e.duplicateOf == null && e.supersededBy == null);
    filesCat.count = live.length;
    filesCat.duplicates = entries.length - live.length;
    for (const e of live) {
      if (e.extractionStatus === 'done') filesCat.indexed++;
      else if (e.extractionStatus === 'failed') filesCat.failed++;
      else if (e.extractionStatus === 'skipped') filesCat.skipped++;
      else filesCat.pending++;
      // The ONLY genuine Canvas-vs-us comparison in this system: writeCourseFile
      // stores both stamps per file (storage.js:255-266). Nothing else on disk
      // records what Canvas thinks is current.
      const cu = e.canvasUpdatedAt ? Date.parse(e.canvasUpdatedAt) : NaN;
      const ls = e.lastSyncedAt ? Date.parse(e.lastSyncedAt) : NaN;
      if (Number.isFinite(cu) && Number.isFinite(ls) && cu > ls) filesCat.canvasNewer++;
      if (e.lastSyncedAt && (!filesCat.updatedAt || e.lastSyncedAt > filesCat.updatedAt)) filesCat.updatedAt = e.lastSyncedAt;
    }
    filesCat.state = live.length === 0 ? 'empty'
      : filesCat.failed > 0 ? 'error'
      : filesCat.indexed === live.length ? 'complete'
      : filesCat.indexed === 0 ? 'not-indexed' : 'partial';
  }
  out.push(filesCat);

  // syllabus ----------------------------------------------------------------
  const sylCat = {
    key: 'syllabus', artifact: 'syllabus_parsed.json', applicable: null, count: 0,
    indexed: false, sourceFile: null, confidence: null, updatedAt: null,
    state: 'not-indexed', note: null,
  };
  const sourcePresent = [];
  for (const rel of SYLLABUS_SOURCES) {
    const s = await statSafe(p(rel));
    // parse-syllabus.js:262,272 ignores a pdf/docx of 1024 bytes or less — a
    // Canvas error page saved under the pdf name is not a syllabus.
    if (s && s.isFile() && (rel === 'syllabus.html' || s.size > 1024)) sourcePresent.push({ rel, size: s.size });
  }
  sylCat.sourcesOnDisk = sourcePresent.map(s => s.rel);
  if (sourcePresent.length === 0 && !syllabusParsed.present) {
    sylCat.state = 'n-a';
    sylCat.note = 'no syllabus.pdf / .docx / .html was ever delivered for this class';
  } else if (syllabusParsed.error) {
    sylCat.state = 'error';
    sylCat.note = syllabusParsed.error;
  } else if (!syllabusParsed.present) {
    sylCat.state = 'not-indexed';
  } else {
    const v = syllabusParsed.value ?? {};
    sylCat.count = 1;
    sylCat.confidence = v.extraction_confidence ?? null;
    sylCat.sourceFile = v.source_file ? path.basename(String(v.source_file)) : null;
    sylCat.updatedAt = v.extracted_at ?? iso(await mt('syllabus_parsed.json'));
    // "indexed" means the parse matches what is on disk NOW, not merely that a
    // parse exists — a re-uploaded syllabus with an old parse beside it is the
    // case this distinction exists for.
    let matched = null;
    const stored = typeof v.source_hash === 'string' ? v.source_hash.trim() : null;
    if (stored) {
      matched = false;
      for (const s of sourcePresent) {
        const abs = p(s.rel);
        if (s.size > MAX_HASH_BYTES) { matched = null; break; }
        try { if (await sha256File(abs) === stored) { matched = true; break; } } catch { /* unreadable */ }
      }
    }
    sylCat.indexed = matched === true;
    sylCat.hashChecked = matched !== null;
    sylCat.state = matched === false ? 'stale' : 'complete';
    if (matched === false) sylCat.note = 'source_hash matches none of the syllabus files currently on disk';
    if (matched === null) sylCat.note = 'no source_hash stored — freshness unverifiable by content';
  }
  const sylErr = await statSafe(p('syllabus_parsed.json.ERROR'));
  if (sylErr) { sylCat.state = 'error'; sylCat.note = 'syllabus_parsed.json.ERROR is present (parse-syllabus deletes it on success, so this is a current failure)'; }
  out.push(sylCat);

  // grades ------------------------------------------------------------------
  const gradesCat = listCategory('grades', 'grades.json', grades, { tabId: 'grades', tabs, mtimeMs: await mt('grades.json') });
  if (Array.isArray(grades.value)) {
    const withGrades = grades.value.filter(e => e && e.grades);
    gradesCat.count = withGrades.length;
    gradesCat.currentScore = withGrades[0]?.grades?.current_score ?? null;
    gradesCat.currentGrade = withGrades[0]?.grades?.current_grade ?? null;
    gradesCat.state = withGrades.length === 0 ? 'empty' : 'complete';
  }
  out.push(gradesCat);

  // calendar events ---------------------------------------------------------
  const calCat = listCategory('calendarEvents', 'calendar_events.json', calendarEvents, { mtimeMs: await mt('calendar_events.json') });
  if (calCat.count === 0 && calCat.state === 'empty') {
    calCat.state = 'none-published';
    calCat.note = 'Canvas returns no course events for any of the six synced classes — a correct empty, not a failed index. Render "none published", never 0%.';
  }
  out.push(calCat);

  // mined tasks -------------------------------------------------------------
  const minedCat = {
    key: 'minedTasks', artifact: 'assignments_mined.json', applicable: null,
    count: null, datedCount: 0, byCategory: Object.fromEntries(MINED_CATEGORIES.map(c => [c, 0])),
    updatedAt: null, state: 'not-indexed', note: null,
  };
  if (mined.error) { minedCat.state = 'error'; minedCat.note = mined.error; }
  else if (!mined.present) { minedCat.state = 'not-indexed'; }
  else {
    const items = Array.isArray(mined.value?.items) ? mined.value.items : null;
    if (!items) { minedCat.state = 'error'; minedCat.note = 'assignments_mined.json has no items array'; }
    else {
      minedCat.count = items.length;
      minedCat.updatedAt = mined.value?.mined_at ?? iso(await mt('assignments_mined.json'));
      for (const it of items) {
        const c = MINED_CATEGORIES.includes(it?.category) ? it.category : 'other';
        minedCat.byCategory[c] += 1;
        if (it?.due_date) minedCat.datedCount += 1;
      }
      minedCat.state = items.length === 0 ? 'empty' : 'complete';
      minedCat.note = 'byCategory is what makes the worklist\'s reading:0 legible — it shows how many mined items ever carried category "reading"';
    }
  }
  const mineErr = await statSafe(p('assignments_mined.json.ERROR'));
  const minedAt = await mt('assignments_mined.json');
  if (mineErr && (minedAt == null || mineErr.mtimeMs > minedAt)) {
    minedCat.state = 'error';
    minedCat.note = 'assignments_mined.json.ERROR is newer than the output — mine-assignments.js never removes this sidecar on success, so it is qualified by mtime';
  }
  out.push(minedCat);

  // context pack ------------------------------------------------------------
  const packCat = { key: 'contextPack', artifact: 'AI_CONTEXT/last_built.txt', applicable: null, count: 0, updatedAt: null, state: 'not-started', note: null };
  const aiDir = await statSafe(p('AI_CONTEXT'));
  if (!aiDir) {
    packCat.state = 'not-started';
    packCat.note = 'AI_CONTEXT/ does not exist yet';
  } else {
    try { packCat.count = (await readdir(p('AI_CONTEXT/pack'))).length; } catch { packCat.count = 0; }
    let stamp = null;
    try { stamp = (await readFile(p('AI_CONTEXT/last_built.txt'), 'utf8')).trim(); } catch { /* not built */ }
    packCat.updatedAt = stamp || ctx.orNull(contextJson.value?.last_synced) || iso(await mt('AI_CONTEXT/last_built.txt'));
    packCat.state = packCat.updatedAt ? (packCat.count > 0 ? 'complete' : 'partial') : 'not-started';
    if (contextJson.error) { packCat.state = 'error'; packCat.note = `AI_CONTEXT/context.json ${contextJson.error}`; }
  }
  out.push(packCat);

  // correlation graph -------------------------------------------------------
  const graphCat = { key: 'correlationGraph', artifact: GRAPH_FILE, applicable: null, count: null, updatedAt: null, state: 'not-started', note: null };
  if (graph.error) { graphCat.state = 'error'; graphCat.note = graph.error; }
  else if (!graph.present) { graphCat.state = 'not-started'; }
  else {
    const s = graph.value?.stats ?? {};
    graphCat.count = s.nodeCount ?? null;
    graphCat.edgeCount = s.edgeCount ?? null;
    graphCat.density = s.density ?? null;
    graphCat.medianDegree = s.medianDegree ?? null;
    graphCat.skipped = s.skipped ?? null;
    graphCat.updatedAt = graph.value?.builtAt ?? iso(await mt(GRAPH_FILE));
    graphCat.state = graphCat.count ? 'complete' : 'empty';
    graphCat.note = 'stats.skipped.unusable already counts the Canvas disabled-feature sentinels';
  }
  out.push(graphCat);

  // calendar ops ------------------------------------------------------------
  const opsCat = {
    key: 'calendarOps', artifact: 'calendar/worklist.json', applicable: null,
    count: null, byKind: Object.fromEntries(WORKLIST_KINDS.map(k => [k, 0])),
    updatedAt: ctx.worklist?.generated_at ?? null, state: 'not-started', note: null,
  };
  if (ctx.worklistError) { opsCat.state = 'error'; opsCat.note = ctx.worklistError; }
  else if (!ctx.worklist) { opsCat.state = 'not-started'; opsCat.note = 'no calendar/worklist.json yet'; }
  else {
    const ops = Array.isArray(ctx.worklist.ops) ? ctx.worklist.ops.filter(o => o && o.class === ctx.slug) : [];
    opsCat.count = ops.length;
    for (const o of ops) {
      const k = WORKLIST_KINDS.includes(o.kind) ? o.kind : null;
      if (k) opsCat.byKind[k] += 1;
    }
    opsCat.timedMeetings = ops.filter(o => o.kind === 'meeting' && !o.all_day && o.time).length;
    // The actionable half of "no time beats a wrong time": three of six classes
    // here have meeting ops carrying no hour at all, because no source states
    // one. Counted separately so the page can say "set it yourself" instead of
    // showing a meeting count that looks complete.
    opsCat.allDayMeetings = opsCat.byKind.meeting - opsCat.timedMeetings;
    opsCat.locatedMeetings = ops.filter(o => o.kind === 'meeting' && o.location).length;
    opsCat.state = ops.length === 0 ? 'empty' : 'complete';
  }
  out.push(opsCat);

  return { categories: out, tabs, filesIndexRead: filesIndex };
}

// ---------------------------------------------------------------------------
// stage state machine
// ---------------------------------------------------------------------------

/**
 * Evaluated in this fixed order. Every branch either proves its state from
 * something on disk / in memory, or names what it could not prove.
 *
 *   not-wired → n-a → running → running-or-interrupted → interrupted →
 *   cancelled → failed → not-started → queued → stale → done
 *
 * This is the design's order with 'interrupted' and 'cancelled' promoted above
 * 'failed' (they are more specific readings of the same END line) and
 * 'not-started' kept above 'stale', so a class that has never run a stage says
 * so rather than reporting the stage as merely out of date.
 */
function evaluateStageState({ stage, staleness, logEntry, pipelineActive, liveProc, procScanAvailable, sidecar, anchorPresent, anchorUnreadable }) {
  const ev = [];
  const dangling = !!logEntry?.lastStart && (!logEntry.lastEnd || logEntry.lastEnd.atMs < logEntry.lastStart.atMs);

  if (stage.wired === false) {
    return { state: 'not-wired', basis: 'orchestrators', evidence: 'no orchestrator spawns build-pack.js and no pack2/ is produced' };
  }
  if (!staleness.inputsPresent && !anchorPresent) {
    return { state: 'n-a', basis: 'filesystem', evidence: `none of this stage's inputs exist yet (${stage.inputs.length ? stage.inputs.slice(0, 3).join(', ') + (stage.inputs.length > 3 ? ', …' : '') : 'none declared'})` };
  }
  if (pipelineActive) {
    return { state: 'running', basis: 'pipelineStatus()', evidence: 'the bridge reports this token in pipelineStatus().active' };
  }
  if (liveProc) {
    return { state: 'running', basis: 'process-table', evidence: `pid ${liveProc.pid} is alive running ${stage.script} on this class (the bridge that spawned it may not be the one answering)` };
  }
  if (dangling) {
    if (!procScanAvailable) {
      return {
        state: 'running-or-interrupted', basis: 'trigger.log',
        evidence: `START at ${logEntry.lastStart.at} with no END, and liveness is unverifiable here (no pipeline status and no process table) — this is genuinely two situations that look identical from outside`,
      };
    }
    return {
      state: 'interrupted', basis: 'trigger.log + process-table',
      evidence: `START at ${logEntry.lastStart.at} with no END and no live process — a bridge restart orphaned it (pipelineStatus is per-process memory)`,
    };
  }
  if (logEntry?.lastSkip && (!logEntry.lastEnd || logEntry.lastSkip.atMs > logEntry.lastEnd.atMs)) {
    return { state: 'cancelled', basis: 'trigger.log', evidence: `SKIP (cancelled) at ${logEntry.lastSkip.at}` };
  }
  if (logEntry?.lastEnd?.exit === 143) {
    return { state: 'cancelled', basis: 'trigger.log', evidence: `END exit=143 at ${logEntry.lastEnd.at} — the user cancelled this, it did not fail` };
  }
  if (sidecar?.fresh) {
    return { state: 'failed', basis: 'error sidecar', evidence: sidecar.evidence };
  }
  if (logEntry?.lastEnd && logEntry.lastEnd.exit !== 0 && logEntry.lastEnd.exit !== null) {
    return { state: 'failed', basis: 'trigger.log', evidence: `END exit=${logEntry.lastEnd.exit} at ${logEntry.lastEnd.at}` };
  }
  // An anchor that exists and is newer than every source still proves nothing
  // if it does not parse. Checked here rather than left to the categories block
  // so the stage grid and the percentage cannot disagree with the detail lines
  // in the same report — see ANCHOR_CATEGORY.
  if (anchorPresent && anchorUnreadable) {
    return {
      state: 'failed', basis: 'anchor content',
      evidence: `${stage.anchor} exists and is newer than its sources, but does not read: ${anchorUnreadable}`,
    };
  }
  if (!anchorPresent) {
    if (!logEntry || logEntry.starts === 0) {
      return { state: 'not-started', basis: 'filesystem + trigger.log', evidence: `${stage.anchor} is absent and no START for this stage appears in the log window` };
    }
    return {
      state: 'failed', basis: 'trigger.log + filesystem',
      evidence: `last END was exit=${logEntry.lastEnd?.exit ?? 'unknown'} at ${logEntry.lastEnd?.at ?? 'unknown'} but ${stage.anchor} is absent — the stage returned without writing its output`,
    };
  }
  if (staleness.stale) {
    return { state: 'stale', basis: 'staleness predicate', evidence: staleness.reason ?? 'stale' };
  }
  ev.push(`${stage.anchor} @ ${iso(staleness.anchorAt)}`);
  if (staleness.note) ev.push(staleness.note);
  return { state: 'done', basis: 'staleness predicate', evidence: ev.join('; ') };
}

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

/**
 * Build the whole progress model for a data root.
 *
 * @param {string} root  data root; defaults to dataRoot()
 * @param {object} opts
 *   pipelineStatus  the bridge's pipelineStatus (function or already-called
 *                   object). Omitted from a CLI run — and its absence is
 *                   reported, never papered over.
 *   hostPid         pid of the process asking; the bridge's own pid when the
 *                   route serves this, which is how a class-chat lock holder is
 *                   told apart from a pipeline stage (class-chat.js runs
 *                   in-process, so localInvoke writes the BRIDGE's pid).
 *   scanProcesses   run the `ps` scan (default true).
 *   logBytes        how much of trigger.log to read from the tail.
 *
 * Never throws. A missing root, a half-synced class, a truncated JSON file and
 * an empty directory are all normal inputs.
 */
export async function indexProgress(root = dataRoot(), opts = {}) {
  const {
    pipelineStatus = null,
    // `bridgePid` is the name the bridge's route factory documents and sends;
    // accept it as the alias it always meant to be, or an out-of-process
    // mount mislabels the payload and the lock holder.
    hostPid = opts.bridgePid ?? process.pid,
    scanProcesses = true,
    logBytes = DEFAULT_LOG_TAIL_BYTES,
    now = Date.now(),
  } = opts;

  const warnings = [];
  const home = path.resolve(String(root ?? ''));
  const payload = {
    generatedAt: iso(now),
    home,
    hostPid,
    bridgePid: hostPid,
    scope: { courseIds: null, source: 'none', updatedAt: null, _from: 'scope.js readSyncScope(home)' },
    lastScrape: { at: null, coursesSeen: [], _from: '<home>/last_sync.json — GLOBAL, never per class' },
    pipeline: null,
    model: null,
    jobs: [],
    classes: [],
    global: null,
    predicateNotes: PREDICATE_NOTES,
    requiresNewWrites: [
      'pipeline.queued[] — trigger.js:243 reduces the queued Set to a count, so the page cannot name which class is waiting',
      'jobs[].pid and jobs[].startedAt from the pipeline itself — recovered here from `ps` + trigger.log; trigger.js:181 discards both',
      "model.waiting[].basis === 'announced' — _acquireModelLock (scripts/_util.js:140) leaves no trace of a waiter, so a 40-minute wait and active generation are indistinguishable",
      'classes[].canvasNewerThanIndex beyond course files — nothing records Canvas updated_at per course/assignment (bridge/storage.js:160)',
      'removal of assignments_mined.json.ERROR on success (scripts/mine-assignments.js:357) — until then the sidecar is qualified by mtime here',
    ],
    warnings,
    error: null,
  };

  try {
    const rootStat = await statSafe(home);
    if (!rootStat) {
      warnings.push(`data root does not exist: ${home}`);
    } else if (!rootStat.isDirectory()) {
      warnings.push(`data root is not a directory: ${home}`);
    }

    // scope + last scrape ---------------------------------------------------
    let scope = { courseIds: null, source: 'none', updatedAt: null };
    try { scope = readSyncScope(home); } catch { warnings.push('sync scope unreadable — treating every class as in scope'); }
    payload.scope = { ...scope, _from: 'scope.js readSyncScope(home)' };

    const lastSync = await readJsonAt(path.join(home, 'last_sync.json'));
    payload.lastScrape = {
      at: lastSync.value?.timestamp ?? null,
      coursesSeen: Array.isArray(lastSync.value?.coursesSeen) ? lastSync.value.coursesSeen.map(String) : [],
      _from: '<home>/last_sync.json — GLOBAL, never per class: nothing records when a given course was scraped',
    };
    if (lastSync.error) warnings.push(`last_sync.json ${lastSync.error}`);

    // class folders ---------------------------------------------------------
    const classesDir = path.join(home, 'classes');
    let entries = [];
    try {
      entries = await readdir(classesDir);
    } catch (err) {
      // Only ENOENT is the normal first-run state. EACCES, ENOTDIR and friends
      // used to be swallowed by the same bare catch, so a CANVAS_SYNC_HOME
      // pointed at any existing-but-wrong directory produced a confident,
      // warning-free "no classes" — indistinguishable from a fresh install.
      if (err && err.code === 'ENOENT') {
        if (rootStat && rootStat.isDirectory()) {
          warnings.push(`no classes/ directory under ${home} — either nothing has been synced yet, or this is not a canvas-sync data root`);
        }
      } else {
        warnings.push(`classes/ could not be listed (${err && err.code ? err.code : ''} ${String(err && err.message).slice(0, 120)}`.trim() + ') — every class is missing from this report, not absent from disk');
      }
    }
    // CLASS_DIR_RE is the pipeline's own matcher (scope.js), NOT a second rule.
    // A bare readdir here is how .DS_Store came to be enumerated as a class and
    // reported source=none in the meeting-time recovery.
    const rejected = entries.filter(n => !CLASS_DIR_RE.test(n));
    const folders = [];
    // A name that matches CLASS_DIR_RE but is not a usable directory used to be
    // dropped on the floor: no row, and no warning either, because only the
    // regex-reject path fed `rejected`. A class folder replaced by a file, or
    // made unreadable, then vanished from the report entirely instead of being
    // reported as the problem it is.
    const unreadable = [];
    for (const name of entries) {
      if (!CLASS_DIR_RE.test(name)) continue;
      const s = await statSafe(path.join(classesDir, name));
      if (s && s.isDirectory()) folders.push(name);
      else if (s) unreadable.push(`${name} (not a directory)`);
      else unreadable.push(`${name} (could not be stat'd)`);
    }
    folders.sort();
    if (unreadable.length) {
      warnings.push(`${unreadable.length} entr${unreadable.length === 1 ? 'y' : 'ies'} under classes/ look like a class but could not be read: ${unreadable.join(', ')}`);
    }
    const classDirs = folders.map(f => path.join(classesDir, f));

    // worklist (global, one file for every class) ---------------------------
    const worklistRead = await readJsonAt(path.join(home, 'calendar', 'worklist.json'));

    // live detection --------------------------------------------------------
    const ps = pipelineStatus == null ? null
      : (typeof pipelineStatus === 'function' ? safeCall(pipelineStatus, warnings) : pipelineStatus);
    const activeTokens = Array.isArray(ps?.active) ? ps.active.map(String) : [];
    payload.pipeline = ps
      ? {
        available: true,
        running: !!ps.running,
        activeCount: activeTokens.length,
        queuedCount: ps.queuedCount ?? null,
        maxConcurrent: ps.maxConcurrent ?? null,
        cancelRequested: typeof ps.cancelRequested === 'boolean' ? ps.cancelRequested : null,
        mode: ps.mode ?? null,
        requestedStages: Array.isArray(ps.requestedStages) ? ps.requestedStages : [],
        active: activeTokens,
        queued: [],
        _from: 'bridge/trigger.js pipelineStatus() — in-memory and per-process: a bridge that did not spawn the children reports idle',
        _gap: 'queued[] names are still reduced to a count at the API boundary',
      }
      : {
        available: false,
        running: null,
        activeCount: null,
        queuedCount: null,
        maxConcurrent: null,
        cancelRequested: null,
        mode: null,
        requestedStages: [],
        active: [],
        queued: [],
        _from: 'not supplied — this call has no bridge in-memory state (CLI run, or the route did not pass pipelineStatus)',
        _gap: 'running/queued are unknowable without it; job detection below falls back to the process table and trigger.log',
      };

    const proc = scanProcesses ? await scanStageProcesses(classesDir, { self: process.pid }) : { available: false, error: 'process scan disabled by caller', procs: [] };
    if (!proc.available && proc.error) warnings.push(`process table unavailable (${proc.error}) — "running" vs "interrupted" cannot be separated`);
    const modelProcs = scanProcesses ? await scanModelProcesses({ self: process.pid }) : { available: false, error: 'process scan disabled by caller', present: false, procs: [], totalRssBytes: null };

    const log = await readTriggerLog(home, { classDirs, maxBytes: logBytes });
    if (log.truncated) warnings.push(`trigger.log is larger than the ${Math.round(logBytes / 1024)} KB read window; stage history older than the window reads as "no START in the log window", never as "never ran"`);

    // model -----------------------------------------------------------------
    // modelLockStatus() and anthropicKeyStatus() both resolve their own paths
    // through dataRoot(), so when this report is asked about a DIFFERENT root
    // than the process is pointed at (a fixture, or `node index-progress.js
    // <other-root>`) they answer about the process's root, not the reported
    // one. Say that rather than quietly attributing one root's lock to another.
    const lock = await modelLockStatus().catch(() => ({ held: false, pid: null, alive: false, heldForMs: 0 }));
    const lockRootMismatch = path.resolve(dataRoot()) !== home;
    const key = lockRootMismatch
      ? { present: null, source: null, hint: null }
      : await anthropicKeyStatus().catch(() => ({ present: false, source: null, hint: null }));

    // jobs ------------------------------------------------------------------
    const jobs = buildJobs({ folders, classesDir, activeTokens, proc, log, lock, now });
    payload.jobs = jobs;

    const holder = jobs.find(j => lock.pid != null && j.pid === lock.pid) ?? null;
    let holderKind = null;
    if (lock.held && lock.pid != null) {
      if (lock.pid === hostPid) holderKind = 'class-chat';
      else if (holder) holderKind = 'pipeline-stage';
      else if (proc.available) holderKind = 'foreign';
      else holderKind = 'unknown';
    } else if (lock.held) {
      // 'mid-acquire' is the gap between mkdir and writeFile in
      // _acquireModelLock — sub-second, and _util.js gives up on it after 10 s.
      // Calling a two-hour-old pid-less lock "mid-acquire" produced the
      // self-contradicting line "HELD by pid ? (DEAD — stale lock) for 7313s,
      // holder mid-acquire". Past the window the honest word is abandoned.
      holderKind = lock.heldForMs > MID_ACQUIRE_WINDOW_MS ? 'abandoned' : 'mid-acquire';
    }

    payload.model = {
      backend: (process.env.CSYNC_AI_BACKEND || await settingEnv(home, 'CSYNC_AI_BACKEND') || 'auto').toLowerCase(),
      localModelId: process.env.CSYNC_LOCAL_MODEL || await settingEnv(home, 'CSYNC_LOCAL_MODEL') || 'mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit',
      anthropicKey: {
        ...key,
        _from: 'anthropicKeyStatus() — masked by construction, the value is never returned by any read path',
        _rootMismatch: lockRootMismatch,
        _note: lockRootMismatch ? 'not evaluated: the key lives in the PROCESS data root\'s config.json, which is not the root being reported on' : null,
      },
      lock: {
        ...lock,
        holderKind,
        holder: holder ? { folder: holder.folder, stage: holder.stage, script: holder.script } : null,
        _from: 'scripts/_util.js modelLockStatus() — pure stat + kill(pid,0); it never creates, reclaims or removes the lock',
        _rootMismatch: lockRootMismatch,
        _rootNote: lockRootMismatch
          ? `the lock reported is the one at this PROCESS's data root (${dataRoot()}), which is not the root being reported on (${home})`
          : null,
      },
      // Whether MLX is actually loaded, which the lock cannot tell you: a stage
      // releases the lock the moment it stops generating, and the model can
      // stay resident for a long time after. Machine-wide, never per data root.
      residentModel: {
        ...modelProcs,
        _from: '`ps -axo pid=,rss=,args=` matched against local_generate.py / mlx_lm / mlx-community',
        _note: modelProcs.available
          ? 'RSS is what the OS reports for the python process; MLX may still be holding unified memory that has not been returned'
          : 'the process table could not be read, so residency is unknown — not "no"',
      },
      // A stage blocked inside _acquireModelLock leaves no trace anywhere — only
      // the winner writes a pid file — so this list is inference, and says so.
      waiting: jobs
        .filter(j => j.needsModel && j.state === 'running' && !(lock.pid != null && j.pid === lock.pid))
        .map(j => ({ folder: j.folder, stage: j.stage, pid: j.pid, basis: 'inferred' })),
      _waiting_rule: "jobs whose stage needs the model and that do not hold the lock. basis is 'inferred' and cannot be anything else until a waiter announces itself (scripts/_util.js:140).",
    };
    if (lockRootMismatch) warnings.push(payload.model.lock._rootNote);

    // Which stages the user switched off in Settings (CSYNC_STAGE_*). An off
    // stage leaves the denominator and must never read as stale or queued —
    // no orchestrator will spawn it, so either state is a promise the
    // pipeline cannot keep. Same off-rule as scripts/_util.js STAGE_OFF_RE.
    const stageOffRe = /^(0|false|off|no)$/i;
    const disabledStages = new Set();
    for (const [stageKey, envKey] of [
      ['parse', 'CSYNC_STAGE_PARSE'], ['extract', 'CSYNC_STAGE_EXTRACT'],
      ['mine', 'CSYNC_STAGE_MINE'], ['graph', 'CSYNC_STAGE_GRAPH'],
      ['build', 'CSYNC_STAGE_CONTEXT'],
    ]) {
      const v = process.env[envKey] ?? await settingEnv(home, envKey);
      if (typeof v === 'string' && stageOffRe.test(v.trim())) disabledStages.add(stageKey);
    }

    // classes ---------------------------------------------------------------
    for (const folder of folders) {
      try {
        payload.classes.push(await buildClass({
          folder, classesDir, scope, log, proc, activeTokens, lock, now,
          worklist: worklistRead.value, worklistError: worklistRead.error,
          pipelineAvailable: !!ps, disabledStages,
          // 'queued' is only meaningful while a pass is actually running; with
          // no pipeline state we say 'stale' rather than invent a queue.
          pipelineRunning: !!ps?.running,
        }));
      } catch (err) {
        payload.classes.push({
          folder, courseId: courseIdOf(folder), slug: folder.replace(/^[0-9]+-/, ''),
          code: null, shortCode: null, name: folder, term: null, inScope: isInScope(scope, folder),
          overall: { done: 0, total: 0, percent: null, denominator: 'none — this class could not be read', state: 'error', blocked: null },
          stages: [], categories: [],
          error: `could not build progress for this class: ${String(err && err.message).slice(0, 200)}`,
        });
      }
    }

    // A class the user just ticked in the extension, whose folder has not
    // appeared yet, used to be completely invisible: this loop enumerates disk
    // folders and never looked at the scope, so the only trace of it anywhere
    // in the payload was its id inside scope.courseIds, and the header's
    // "21 courses seen · 6 in scope" left the user to do the arithmetic. That
    // newly added class is the one they are most likely watching this page for.
    const seenIds = new Set(payload.classes.map(c => c.courseId).filter(Boolean));
    const awaiting = (scope.courseIds ?? []).map(String).filter(id => !seenIds.has(id));
    for (const courseId of awaiting) {
      payload.classes.push({
        folder: null,
        courseId,
        slug: null,
        code: null,
        shortCode: null,
        name: `course ${courseId}`,
        term: null,
        inScope: true,
        metadataError: null,
        lastScrapedAt: null,
        awaitingFirstSync: true,
        overall: {
          done: 0, total: 0, percent: null,
          denominator: 'nothing has been written for this class yet, so there is no denominator',
          excluded: [],
          state: 'awaiting-first-sync',
          blocked: null,
        },
        stages: [],
        categories: [],
        note: `course ${courseId} is in the sync scope but has no folder under classes/ — the extension has not delivered it yet. Nothing here has failed; nothing has arrived.`,
      });
    }
    if (awaiting.length) {
      warnings.push(`${awaiting.length} course(s) in scope have no folder on disk yet: ${awaiting.join(', ')}`);
    }

    // global ----------------------------------------------------------------
    const w = worklistRead.value;
    const outOfScope = folders.filter(f => !isInScope(scope, f));
    const counted = payload.classes.flatMap(c => c.stages.filter(s => s.counted && s.state !== 'n-a'));
    const doneCount = counted.filter(s => s.state === 'done').length;
    payload.global = {
      calendar: {
        artifact: 'calendar/worklist.json',
        generatedAt: w?.generated_at ?? null,
        window: w?.window ?? null,
        counts: w?.counts ?? null,
        // The visible half of "why is reading 0 and homework 0 for two
        // classes". sync-calendar.js records every item it could NOT put on the
        // calendar and why (recurring / undated / out_of_window / done /
        // holiday); nothing read those fields, so the dashboard still showed a
        // bare 0 and the user had no way to tell "none exist" from "none could
        // be dated". Passed straight through — this module does not recompute
        // them, it just stops them being invisible.
        unscheduled: w?.unscheduled ?? null,
        unscheduledByKind: w?.unscheduled_by_kind ?? null,
        droppedCount: Array.isArray(w?.dropped) ? w.dropped.length : null,
        recurringNotes: Array.isArray(w?.recurring_notes) ? w.recurring_notes.length : null,
        holidays: Array.isArray(w?.holidays) ? w.holidays : null,
        miningInFlight: w?.mining_in_flight ?? null,
        script: 'scripts/sync-calendar.js',
        scope: 'GLOBAL — spawned once per pass with the classes/ dir, not per class (trigger.js:419-425)',
        state: worklistRead.error ? 'error' : w ? 'complete' : 'not-started',
        note: worklistRead.error ?? null,
      },
      unscopedClasses: {
        count: outOfScope.length,
        folders: outOfScope,
        totalBytes: null,
        _from: 'class folders on disk whose courseId is not in the sync scope',
        _gap: 'totalBytes needs a recursive walk of every folder, which has no business running on a 3-second poll; GET /api/classes/stale computes it for the cleanup flow and answers a DIFFERENT question (deletion candidates, and [] when the scope is unknown)',
      },
      rejectedDirEntries: rejected,
      progress: {
        stagesDone: doneCount,
        stagesTotal: counted.length,
        percent: counted.length === 0 ? null : Math.round((doneCount / counted.length) * 100),
        denominator: `${counted.length} counted stage(s) across ${payload.classes.length} class(es); a stage counts only when it is wired to the bridge orchestrator and its inputs exist`,
        classesComplete: payload.classes.filter(c => c.overall.state === 'done').length,
        classesTotal: payload.classes.length,
      },
    };
    if (rejected.length) {
      warnings.push(`ignored ${rejected.length} non-class entr${rejected.length === 1 ? 'y' : 'ies'} under classes/: ${rejected.join(', ')}`);
    }
  } catch (err) {
    // Belt and braces: the caller is a 3-second poll on a live dashboard, and a
    // report that throws is worse than a report that says what broke.
    payload.error = `index-progress failed: ${String(err && err.message).slice(0, 300)}`;
    warnings.push(payload.error);
  }
  return payload;
}

function safeCall(fn, warnings) {
  try { return fn(); } catch (err) { warnings.push(`pipelineStatus() threw: ${String(err && err.message).slice(0, 160)}`); return null; }
}

async function settingEnv(home, key) {
  const r = await readJsonAt(path.join(home, 'settings.json'));
  const v = r.value?.env?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * One record per stage process we believe exists right now, from all three
 * detectors joined on (folder, script).
 */
function buildJobs({ folders, classesDir, activeTokens, proc, log, lock, now }) {
  const byKey = new Map();
  const put = (folder, script, patch) => {
    const key = `${folder}\u0000${script}`;
    const cur = byKey.get(key) ?? {
      folder, script, stage: STAGE_BY_SCRIPT.get(script)?.key ?? null,
      classDir: path.join(classesDir, folder), pid: null,
      startedAt: null, elapsedSec: null,
      needsModel: STAGE_BY_SCRIPT.get(script)?.needsModel ?? false,
      holdsModelLock: false, detectedBy: [], state: 'unknown', evidence: null,
    };
    byKey.set(key, { ...cur, ...patch, detectedBy: [...new Set([...cur.detectedBy, ...(patch.detectedBy ?? [])])] });
  };

  // pipelineStatus() renders '<folder> · <script.js>' (trigger.js:236-243); the
  // calendar token is 'global:sync-calendar', which has no folder and no .js.
  for (const token of activeTokens) {
    const i = token.lastIndexOf(' · ');
    if (i === -1) continue;
    const folder = token.slice(0, i);
    let script = token.slice(i + 3);
    if (!script.endsWith('.js')) script += '.js';
    if (!folders.includes(folder)) continue;
    put(folder, script, { detectedBy: ['pipeline'], state: 'running', evidence: 'pipelineStatus().active' });
  }

  for (const p of proc.procs) {
    if (!folders.includes(p.folder)) continue;
    put(p.folder, p.script, { detectedBy: ['process-table'], pid: p.pid, state: 'running', evidence: `pid ${p.pid} alive` });
  }

  for (const [, e] of log.byKey) {
    const folder = path.basename(e.classDir);
    if (!folders.includes(folder)) continue;
    const dangling = !!e.lastStart && (!e.lastEnd || e.lastEnd.atMs < e.lastStart.atMs);
    if (!dangling) {
      // Still useful: gives startedAt to a job the other two detectors found.
      const key = `${folder}\u0000${e.script}`;
      if (byKey.has(key) && e.lastStart) put(folder, e.script, { detectedBy: ['trigger.log'], startedAt: e.lastStart.at });
      continue;
    }
    const live = proc.procs.some(p => p.folder === folder && p.script === e.script);
    const state = live ? 'running'
      : proc.available ? 'interrupted'
      : 'running-or-interrupted';
    put(folder, e.script, {
      detectedBy: ['trigger.log'], startedAt: e.lastStart.at, state,
      evidence: live ? null : proc.available
        ? 'START with no END and no live process — orphaned by a bridge restart'
        : 'START with no END and liveness unverifiable (no process table)',
    });
  }

  const jobs = [...byKey.values()].map(j => {
    const startedMs = j.startedAt ? Date.parse(j.startedAt) : NaN;
    return {
      ...j,
      elapsedSec: Number.isFinite(startedMs) ? Math.max(0, Math.round((now - startedMs) / 1000)) : null,
      holdsModelLock: lock.held && lock.pid != null && j.pid === lock.pid,
    };
  });
  jobs.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : a.script < b.script ? -1 : 1));
  return jobs;
}

async function buildClass(args) {
  const {
    folder, classesDir, scope, log, proc, activeTokens, lock, now,
    worklist, worklistError, pipelineAvailable,
  } = args;
  const classDir = path.join(classesDir, folder);
  const slug = folder.replace(/^[0-9]+-/, '');
  const metadata = await readJsonAt(path.join(classDir, 'metadata.json'));
  const metaMtime = await mtimeOf(path.join(classDir, 'metadata.json'));

  const termOf = m => {
    const t = m?.term ?? m?.course?.term;
    if (typeof t === 'string') return t;
    return t?.name ?? null;
  };

  const { categories } = await buildCategories(classDir, {
    slug, worklist, worklistError, orNull: v => (typeof v === 'string' && v ? v : null),
  });

  const stages = [];
  for (const stage of STAGES) {
    const staleness = await stageStaleness(classDir, stage);
    const anchorAt = await mtimeOf(path.join(classDir, stage.anchor));
    const logEntry = log.byKey.get(`${classDir}\u0000${stage.script}`) ?? null;
    const pipelineActive = activeTokens.includes(`${folder} · ${stage.script}`)
      || activeTokens.includes(`${folder} · ${stage.script.replace(/\.js$/, '')}`);
    const liveProc = proc.procs.find(p => p.folder === folder && p.script === stage.script) ?? null;

    let sidecar = null;
    if (stage.errorSidecar) {
      const s = await statSafe(path.join(classDir, stage.errorSidecar));
      if (s) {
        const fresh = stage.sidecarClearedOnSuccess ? true : (anchorAt == null || s.mtimeMs > anchorAt);
        sidecar = {
          present: true, at: iso(s.mtimeMs), fresh,
          evidence: stage.sidecarClearedOnSuccess
            ? `${stage.errorSidecar} exists, and this stage deletes it on success — a current failure`
            : fresh
              ? `${stage.errorSidecar} (${iso(s.mtimeMs)}) is newer than ${stage.anchor} — this sidecar is never removed on success, so it is qualified by mtime`
              : `${stage.errorSidecar} predates the current output — an old failure that has since been superseded`,
        };
      }
    }

    // The category that reads this stage's anchor already knows whether the
    // file parses; ask it rather than deciding 'done' from mtimes alone.
    const anchorCat = categories.find(c => c.key === ANCHOR_CATEGORY.get(stage.key)) ?? null;
    const anchorUnreadable = anchorCat && anchorCat.state === 'error' ? (anchorCat.note ?? 'unreadable') : null;

    let { state, basis, evidence } = evaluateStageState({
      stage, staleness, logEntry, pipelineActive, liveProc,
      // The ps scan ALONE proves absence. pipelineStatus is per-process
      // memory that cannot see orphans of a restarted bridge (see the module
      // header), so counting it as scan coverage let a dangling START read
      // 'interrupted' — inviting a re-run and a second 20 GB model load —
      // while buildJobs, keying the same decision on proc.available, said
      // 'running-or-interrupted' in the same payload.
      procScanAvailable: proc.available,
      sidecar, anchorPresent: anchorAt != null, anchorUnreadable,
    });

    // 'queued' is inference: the pipeline knows which tokens are waiting and
    // reports only how many (trigger.js:243).
    //
    // Gated on `counted`, because an uncounted stage is uncounted precisely
    // because no orchestrator the user can press spawns it. Telling a user an
    // unwired stage is queued promises work that will never happen.
    // A stage switched off in Settings is uncounted for the same reason a
    // unwired one is: nothing the user can press will spawn it.
    const offInSettings = args.disabledStages?.has(stage.key) === true;

    let queuedBasis = null;
    if (state === 'stale' && args.pipelineRunning && stage.counted !== false && !offInSettings) { state = 'queued'; queuedBasis = 'inferred'; }
    // An off stage must never read stale either (same reason as queued: a
    // promise no orchestrator will keep — the user re-enables nothing, waits,
    // and the pipeline correctly never touches it). Its anchor exists; that
    // is 'done', with the `stale` flag still carried for the detail view.
    if (state === 'stale' && offInSettings) { state = 'done'; basis = 'off-in-settings'; }

    stages.push({
      key: stage.key, label: stage.label, script: stage.script, needsModel: stage.needsModel,
      counted: offInSettings ? false : stage.counted,
      notCountedReason: offInSettings ? 'off-in-settings' : stage.notCountedReason,
      orchestrators: stage.orchestrators,
      anchor: stage.anchor, anchorAt: iso(anchorAt),
      inputsPresent: staleness.inputsPresent,
      stale: staleness.inputsPresent ? staleness.stale : false,
      staleReason: staleness.reason ?? null,
      state, stateBasis: basis, evidence, queuedBasis,
      startedAt: logEntry?.lastStart?.at ?? null,
      finishedAt: logEntry?.lastEnd?.at ?? null,
      exitCode: logEntry?.lastEnd?.exit ?? null,
      durationMs: logEntry?.lastStart && logEntry?.lastEnd && logEntry.lastEnd.atMs >= logEntry.lastStart.atMs
        ? logEntry.lastEnd.atMs - logEntry.lastStart.atMs : null,
      pid: liveProc?.pid ?? null,
      errorSidecar: sidecar,
      failureOutput: logEntry?.lastOutput?.text ? logEntry.lastOutput.text.slice(-4000) : null,
    });
  }

  const countedStages = stages.filter(s => s.counted && s.state !== 'n-a');
  const done = countedStages.filter(s => s.state === 'done').length;
  const total = countedStages.length;
  const PRECEDENCE = ['running', 'running-or-interrupted', 'interrupted', 'failed', 'cancelled', 'queued', 'stale', 'not-started', 'done'];
  let overallState = 'not-started';
  if (total === 0) {
    overallState = stages.some(s => s.state === 'running') ? 'running' : 'not-started';
  } else {
    for (const cand of PRECEDENCE) {
      if (countedStages.some(s => s.state === cand)) { overallState = cand; break; }
    }
  }

  const modelJobHere = stages.some(s => s.needsModel && s.state === 'running');
  const lockElsewhere = lock.held && lock.alive && lock.pid != null
    && !stages.some(s => s.pid != null && s.pid === lock.pid);

  return {
    folder,
    courseId: courseIdOf(folder),
    slug,
    code: metadata.value?.course_code ?? metadata.value?.course?.code ?? null,
    // "BUSI 374 001/002" -> "BUSI374". The status page lists several classes
    // on one line and a section list makes that line unreadable; deriving it
    // here keeps the rule in cal-names.js rather than re-implementing it in a
    // page that cannot import modules.
    shortCode: compactCourseCode(
      metadata.value?.course_code ?? metadata.value?.course?.code ?? '') || null,
    name: metadata.value?.name ?? metadata.value?.course?.name ?? null,
    term: termOf(metadata.value),
    inScope: isInScope(scope, folder),
    metadataError: metadata.error,
    // writeCourse writes all twelve Canvas JSONs in one Promise.all
    // (storage.js:67-78), so metadata.json's mtime is the whole class's scrape.
    lastScrapedAt: iso(metaMtime),
    overall: {
      done, total,
      percent: total === 0 ? null : Math.round((done / total) * 100),
      denominator: total === 0
        ? 'no stage of this class has inputs yet — nothing to be a fraction of, so percent is null rather than 100'
        : `${total} counted stage(s): ${countedStages.map(s => s.key).join(', ')}`,
      excluded: stages.filter(s => !s.counted || s.state === 'n-a')
        .map(s => ({ key: s.key, reason: s.notCountedReason ?? (s.state === 'n-a' ? 'no inputs' : 'excluded') })),
      state: overallState,
      blocked: modelJobHere && lockElsewhere ? 'model-lock' : null,
    },
    stages,
    categories,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Wide enough for the longest state this module can emit. It was 13, which is
// exactly one character too few for 'running-or-interrupted' — the flagship
// honesty state, introduced by name in this file's own header — so the grid
// printed 'running-or-in' butted against the next column: 'running-or-innot-started'.
const STATE_COL = Math.max(
  14,
  ...['not-wired', 'n-a', 'running', 'running-or-interrupted', 'interrupted', 'cancelled',
    'failed', 'not-started', 'queued', 'stale', 'done', 'awaiting-first-sync'].map(s => s.length + 2),
);

function pad(s, n) {
  const str = String(s ?? '');
  // Truncation is visible, never silent: a cell that had to be cut says so.
  return str.length > n ? str.slice(0, n - 1) + '…' : str + ' '.repeat(n - str.length);
}

/** A readable per-class summary — the way to see progress with the app shut. */
export function formatProgress(p) {
  const L = [];
  L.push(`canvas-sync index progress — ${p.home}`);
  L.push(`generated ${p.generatedAt}   pid ${p.hostPid}`);
  const sc = p.scope;
  L.push(`scope: ${sc.courseIds ? `${sc.courseIds.length} course(s) (${sc.source}${sc.updatedAt ? `, ${sc.updatedAt}` : ''})` : 'unknown — everything is in scope'}`);
  L.push(`last scrape: ${p.lastScrape.at ?? 'never'}${p.lastScrape.coursesSeen.length ? ` (${p.lastScrape.coursesSeen.length} course(s) seen — GLOBAL, not per class)` : ''}`);

  const pl = p.pipeline;
  L.push(pl.available
    ? `pipeline: ${pl.running ? 'RUNNING' : 'idle'} — ${pl.activeCount} active, ${pl.queuedCount} queued, max ${pl.maxConcurrent}`
    : 'pipeline: not observable from here (in-memory state lives in the bridge process; falling back to the process table and trigger.log)');

  const lk = p.model.lock;
  // The mismatch caveat used to live only in the WARNINGS block at the foot of
  // a hundred-line report, while this line made an unqualified claim about a
  // different root's lock. The anthropic key on the next line already
  // self-qualifies inline; so does this one now.
  const lkRoot = lk._rootMismatch ? '  [lock read from THIS PROCESS\'s data root, not the root reported above]' : '';
  L.push((lk.held
    ? `model lock: HELD by pid ${lk.pid ?? '?'} (${lk.alive ? 'alive' : 'DEAD — stale lock'}) for ${Math.round(lk.heldForMs / 1000)}s, holder ${lk.holderKind}${lk.holder ? ` = ${lk.holder.stage} on ${lk.holder.folder}` : ''}`
    : 'model lock: free') + lkRoot);
  if (lk.clockSkew) {
    L.push('  NOTE: the lock directory\'s mtime is in the FUTURE — its age cannot be computed, so "held for" and "alive" are both unreliable here.');
  }
  if (p.model.residentModel?.present) {
    const rm = p.model.residentModel;
    L.push(`local model resident in RAM: ${rm.totalRssBytes != null ? (rm.totalRssBytes / 1e9).toFixed(1) + ' GB' : 'size unknown'} across ${rm.procs.length} process(es) — ${rm.procs.map(x => `pid ${x.pid}`).join(', ')}`);
  } else if (p.model.residentModel?.available) {
    L.push('local model resident in RAM: no (no MLX process found in the process table)');
  }
  const keyState = p.model.anthropicKey.present == null ? 'not evaluated for this root'
    : p.model.anthropicKey.present ? `present (${p.model.anthropicKey.source})` : 'absent';
  L.push(`model: backend ${p.model.backend}, local ${p.model.localModelId}, anthropic key ${keyState}`);

  if (p.jobs.length) {
    L.push('');
    L.push('JOBS');
    for (const j of p.jobs) {
      L.push(`  ${pad(j.state, 22)} ${pad(j.folder, 32)} ${pad(j.stage ?? j.script, 10)} pid ${pad(j.pid ?? '?', 7)} ${j.elapsedSec != null ? `${j.elapsedSec}s` : 'age unknown'}  [${j.detectedBy.join('+')}]`);
    }
  } else {
    L.push('jobs: none detected');
  }

  L.push('');
  const header = pad('CLASS', 32) + STAGES.map(s => pad(s.key + (s.counted ? '' : '*'), STATE_COL)).join('') + 'PROGRESS';
  L.push(header);
  L.push('-'.repeat(header.length));
  for (const c of p.classes) {
    const cells = STAGES.map(s => {
      const st = c.stages.find(x => x.key === s.key);
      return pad(st ? st.state : '?', STATE_COL);
    }).join('');
    const pct = c.overall.percent == null ? 'n/a' : `${c.overall.percent}%`;
    // A scoped class with no folder yet has no name to print but must still
    // occupy a row — its absence is the thing worth seeing.
    const label = c.folder ?? `(no folder yet) ${c.courseId}`;
    L.push(pad(label, 32) + cells + `${c.overall.done}/${c.overall.total} ${pct} ${c.overall.state}${c.overall.blocked ? ` (blocked: ${c.overall.blocked})` : ''}`);
  }
  L.push('-'.repeat(header.length));
  L.push('* not counted toward PROGRESS: pack2 is not wired into an orchestrator.');

  for (const c of p.classes) {
    L.push('');
    L.push(`${c.folder ?? `(no folder yet) ${c.courseId}`}  ${c.code ?? '(no metadata)'}${c.term ? ` · ${c.term}` : ''}${c.inScope ? '' : '  [OUT OF SCOPE]'}`);
    if (c.note) L.push(`  ${c.note}`);
    if (c.metadataError) L.push(`  metadata.json ${c.metadataError} — the code, name and term are unavailable for that reason, not absent from Canvas`);
    L.push(`  progress ${c.overall.done}/${c.overall.total} — ${c.overall.denominator}`);
    L.push(`  last scraped ${c.lastScrapedAt ?? 'never'}`);
    if (c.awaitingFirstSync) continue;
    for (const s of c.stages) {
      if (s.state === 'done') continue;
      L.push(`  ${pad(s.key, 8)} ${pad(s.state, 22)} ${s.evidence ?? ''}`.trimEnd());
    }
    const cat = c.categories;
    const g = k => cat.find(x => x.key === k);
    // 'ERR' vs 'none' matters: readJsonAt was written specifically so a
    // truncated assignments.json renders as a failure and not as a class with
    // no assignments, and this line used to print '?' for both and throw that
    // distinction away on the way to the screen.
    const n = k => {
      const x = g(k);
      if (x == null) return '?';
      if (x.state === 'error') return 'ERR';
      if (x.state === 'unavailable') return 'disabled';
      if (x.state === 'n-a') return 'n/a';
      if (x.count == null) return 'not indexed';
      return x.tabHidden ? `${x.count} (tab hidden)` : x.count;
    };
    L.push(`  holdings: assignments ${n('assignments')} · quizzes ${n('quizzes')} · modules ${n('modules')}(${g('modules')?.itemCount ?? 0} items) · pages ${n('pages')} · announcements ${n('announcements')} · discussions ${n('discussions')}`);
    const f = g('files');
    L.push(`  files: ${f?.indexed ?? 0}/${f?.count ?? 0} extracted (${f?.state}), ${f?.pending ?? 0} pending, ${f?.failed ?? 0} failed, ${f?.duplicates ?? 0} dup, ${f?.canvasNewer ?? 0} newer on Canvas`);
    const m = g('minedTasks');
    if (m) {
      const by = Object.entries(m.byCategory).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ');
      L.push(`  mined: ${m.count ?? 0} task(s) (${m.state})${by ? ` — ${by}` : ''}; ${m.datedCount} dated`);
    }
    const o = g('calendarOps');
    if (o) L.push(`  calendar ops: ${o.count ?? 0} (${WORKLIST_KINDS.map(k => `${k} ${o.byKind[k]}`).join(', ')})`);
    const sy = g('syllabus');
    if (sy) L.push(`  syllabus: ${sy.state}${sy.confidence ? ` conf=${sy.confidence}` : ''}${sy.sourceFile ? ` from ${sy.sourceFile}` : ''}${sy.note ? ` — ${sy.note}` : ''}`);
    const gr = g('correlationGraph');
    if (gr) L.push(`  graph: ${gr.state}${gr.count != null ? ` ${gr.count} nodes / ${gr.edgeCount} edges @ ${gr.updatedAt}` : ''}`);
  }

  L.push('');
  const gp = p.global?.progress;
  if (gp) L.push(`TOTAL ${gp.stagesDone}/${gp.stagesTotal} stages (${gp.percent == null ? 'n/a' : gp.percent + '%'}) — ${gp.denominator}`);
  const cal = p.global?.calendar;
  if (cal) L.push(`calendar worklist: ${cal.state}${cal.generatedAt ? ` @ ${cal.generatedAt}` : ''}${cal.counts ? ` — ${Object.entries(cal.counts).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
  if (p.warnings.length) {
    L.push('');
    L.push('WARNINGS');
    for (const w of p.warnings) L.push(`  - ${w}`);
  }
  return L.join('\n');
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--json');
  const wantJson = process.argv.includes('--json');
  const root = args[0] ? path.resolve(args[0]) : dataRoot();
  const payload = await indexProgress(root);
  process.stdout.write(wantJson ? JSON.stringify(payload, null, 2) + '\n' : formatProgress(payload) + '\n');
}

// Only run main() when invoked directly, not when imported by bridge/.
// Compare DECODED paths: a raw import.meta.url comparison silently no-ops here,
// because the repo path has no space in it and the tmp path does.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
