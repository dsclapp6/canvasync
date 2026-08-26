// trigger.js — post-ingest job scheduler for canvas-sync bridge
// Spawns parse-syllabus and build-context scripts for each class dir.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataRoot } from '../data-root.js';
import { readSyncScope, isInScope } from '../scope.js';
import { indexClassReadings } from '../scripts/index-readings.js';

// One shared definition for every entry point — see ../data-root.js.
const syncHome = dataRoot;

// Class folders are always "<courseId>-<slug>" — anything else under classes/
// is not ours and must never have a pipeline spawned on it.
const CLASS_DIR_RE = /^[0-9]+-[a-z0-9-]+$/;

// How much of a failed stage's combined stdout+stderr to keep in trigger.log.
// Enough for a stack trace, small enough that a looping stage cannot fill the
// disk.
const STAGE_OUTPUT_TAIL_CHARS = 4000;

// canvas-sync/, the directory holding scripts/ — this file lives in
// bridge/, one level under it. Fixed, not searched: a walk-up loop used to
// sit here computing a candidate it threw away and returning this same
// expression regardless, so its comments described a search that never ran.
// If this file ever moves, change the '..' — nothing will discover it.
// fileURLToPath, never import.meta.url's raw pathname: a percent-encoded
// path (a space in a parent directory) silently resolves wrong otherwise.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Resource-adaptive job cap. Stage scripts are separate node processes, and
// the AI stages can each fall back to loading the ~20 GB local model — the
// machine-wide model lock in scripts/_util.js serializes those loads, but the
// job cap here keeps the rest (extraction, pdf conversion) from piling on top
// of a busy or small machine. CSYNC_MAX_JOBS overrides (clamped 1..8).

// The override can come from the process env OR the dashboard-managed
// settings.json ({ env: { CSYNC_MAX_JOBS } }). The Electron launcher spawns the
// bridge without folding settings.json into process.env, so reading the env
// alone made the UI's "max concurrent jobs" control silently do nothing — the
// exact knob a user on a small Mac reaches for to stop the AI stages thrashing.
// Synchronous + tiny; only ever called at module load or an idle refresh.
function settingsMaxJobs() {
  const fromEnv = parseInt(process.env.CSYNC_MAX_JOBS ?? '', 10);
  if (fromEnv >= 1) return fromEnv;
  try {
    const v = JSON.parse(readFileSync(path.join(syncHome(), 'settings.json'), 'utf8'))?.env?.CSYNC_MAX_JOBS;
    const n = parseInt(v ?? '', 10);
    if (n >= 1) return n;
  } catch { /* no settings file / unreadable — fall through to auto */ }
  return NaN;
}

function computeMaxConcurrent() {
  const envN = settingsMaxJobs();
  if (envN >= 1) return Math.min(envN, 8);
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  const freeGb = os.freemem() / (1024 ** 3);
  if (cores <= 4 || freeGb < 2) return 1;
  if (freeGb < 4 || cores <= 8) return 2;
  return 3;
}
const MAX_CONCURRENT = computeMaxConcurrent();

// Minimum gap between job launches so a big sync ramps up instead of
// slamming every process into existence at once.
const SPAWN_GAP_MS = 1500;
let lastSpawnAt = 0;

// In-memory state — safe for single-process bridge.
let running = false;
let rerunRequested = false;
let cancelRequested = false;
const queued = new Set();
const active = new Set();
const children = new Set();
let semaphoreSlots = MAX_CONCURRENT;
const waiters = [];

// Refresh the job cap from current free memory when the pipeline is idle —
// the module-load value reflects conditions at bridge startup, which may be
// days old by the time a pass actually runs.
function refreshSemaphore() {
  if (active.size > 0 || waiters.length > 0) return;
  // computeMaxConcurrent() now honors both the env and settings.json overrides,
  // so this picks up a UI concurrency change on the next idle pass.
  semaphoreSlots = computeMaxConcurrent();
}

function acquireSemaphore() {
  if (semaphoreSlots > 0) {
    semaphoreSlots--;
    return Promise.resolve();
  }
  return new Promise(resolve => waiters.push(resolve));
}

function releaseSemaphore() {
  if (waiters.length > 0) {
    waiters.shift()();
  } else {
    semaphoreSlots++;
  }
}

async function appendLog(line) {
  const logDir = path.join(syncHome(), 'logs');
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, 'trigger.log');
  const entry = `${new Date().toISOString()} ${line}\n`;
  // createWriteStream with 'a' is safe for append; no need for full atomic write on log.
  await fs.appendFile(logPath, entry, 'utf8');
}

// Pipeline env overrides set from the dashboard/desktop app — stored in
// <home>/settings.json as { env: { CSYNC_*: value } }. Read fresh per spawn
// so settings changes apply on the next job with no restart. Only CSYNC_*
// keys are honored (the dashboard enforces this too; double filter here).
async function loadEnvOverrides() {
  try {
    const raw = await fs.readFile(path.join(syncHome(), 'settings.json'), 'utf8');
    const env = JSON.parse(raw)?.env ?? {};
    const out = {};
    for (const [k, v] of Object.entries(env)) {
      if (/^CSYNC_[A-Z0-9_]+$/.test(k) && typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// Per-function switches from the dashboard's Functions card. Same env keys
// and off-values as scripts/_util.js STAGE_ENV / STAGE_OFF_RE (kept local so
// the bridge's orchestrator has no import into scripts/); read fresh per pass
// so flipping a switch applies to the very next trigger without a restart.
// A stage that is off is SKIPPED, never un-built: its outputs stay on disk
// and downstream stages keep reading them.
const STAGE_OFF_RE = /^(0|false|off|no)$/i;
async function stageToggles() {
  const stored = await loadEnvOverrides();
  const on = (key) => {
    const v = process.env[key] ?? stored[key];
    return !(typeof v === 'string' && STAGE_OFF_RE.test(v.trim()));
  };
  return {
    parse:    on('CSYNC_STAGE_PARSE'),
    extract:  on('CSYNC_STAGE_EXTRACT'),
    mine:     on('CSYNC_STAGE_MINE'),
    build:    on('CSYNC_STAGE_CONTEXT'),
    calendar: on('CSYNC_STAGE_CALENDAR'),
  };
}

async function spawnJob(scriptPath, classDir, token) {
  await acquireSemaphore();
  const scriptName = path.basename(scriptPath);
  if (cancelRequested) {
    queued.delete(token);
    releaseSemaphore();
    await appendLog(`SKIP ${scriptName} ${classDir} (cancelled)`).catch(() => {});
    return null;
  }
  // Pace launches: never start two jobs closer together than SPAWN_GAP_MS.
  // Claim a distinct spawn slot BEFORE sleeping (no await between read and
  // write, so concurrent waiters can't all compute the same wait and wake
  // together — each gets its own paced timestamp).
  const now = Date.now();
  const slot = Math.max(now, lastSpawnAt + SPAWN_GAP_MS);
  lastSpawnAt = slot;
  if (slot > now) await new Promise(r => setTimeout(r, slot - now));
  const envOverrides = await loadEnvOverrides();
  // Re-check after the awaits above — a cancel arriving during the pacing gap
  // must not launch a child it can no longer signal.
  if (cancelRequested) {
    queued.delete(token);
    releaseSemaphore();
    await appendLog(`SKIP ${scriptName} ${classDir} (cancelled)`).catch(() => {});
    return null;
  }
  active.add(token);
  queued.delete(token);
  // .catch: an unwritable log dir must not abort after the semaphore was
  // acquired — that would leak the slot and strand the token in `active`.
  await appendLog(`START ${scriptName} ${classDir}`).catch(() => {});
  return new Promise(resolve => {
    // Use the absolute path of whatever node binary is already running the
    // bridge. This avoids `spawn node ENOENT` under launchd where PATH is
    // minimal (/usr/bin:/bin only) and nvm-installed node isn't on it.
    const child = spawn(process.execPath, [scriptPath, classDir], {
      cwd: REPO_ROOT,
      // Capture, do not discard. With stdio:'ignore' a failed stage left only
      // "exit=1" in trigger.log — no message, no stack, nothing to act on. The
      // stage that reports "claude exited 1" because the CLI's OAuth expired
      // looked identical to one that crashed on a malformed PDF.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...envOverrides },
    });
    // Keep only the tail: a chatty stage (or a runaway loop) must not grow the
    // log without bound, and the end of the output is where the error is.
    const tail = [];
    let tailLen = 0;
    const collect = (chunk) => {
      const text = chunk.toString();
      tail.push(text);
      tailLen += text.length;
      while (tailLen > STAGE_OUTPUT_TAIL_CHARS && tail.length > 1) {
        tailLen -= tail.shift().length;
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    children.add(child);
    // A cancel can land during the awaited START log above — after the last
    // cancel check but before this child joined `children`, so cancelPipeline
    // couldn't signal it. Catch that window now that it's registered.
    if (cancelRequested) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    // A failed spawn emits BOTH 'error' and 'close', and each handler below
    // released the concurrency slot — so one failure handed out a spare
    // permit and the pipeline ran above MAX_CONCURRENT (several stages, each
    // able to take the machine-wide model lock). Release exactly once.
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      children.delete(child);
      active.delete(token);
      releaseSemaphore();
      return true;
    };
    child.on('close', async (code) => {
      if (!settle()) return;
      await appendLog(`END ${scriptName} ${classDir} exit=${code ?? 'null'}`).catch(() => {});
      if (code !== 0) {
        const out = tail.join('').slice(-STAGE_OUTPUT_TAIL_CHARS).trim();
        await appendLog(out
          ? `OUTPUT ${scriptName} ${classDir}\n${out}\n--- end output ---`
          : `OUTPUT ${scriptName} ${classDir} (no output)`).catch(() => {});
      }
      resolve(code);
    });
    child.on('error', async (err) => {
      if (!settle()) return;
      await appendLog(`ERROR ${scriptName} ${classDir} ${err.message}`).catch(() => {});
      resolve(null);
    });
  });
}

// Live pipeline state for the dashboard.
export function pipelineStatus() {
  const jobs = [...active].map(t => {
    const s = String(t);
    const i = s.lastIndexOf(':');
    return i > 0 ? `${path.basename(s.slice(0, i))} · ${s.slice(i + 1)}` : s;
  });
  // Report the LIVE cap (honors a settings.json override changed since launch),
  // not the module-load constant, so the dashboard reflects the real value.
  return { running, active: jobs, queuedCount: queued.size, maxConcurrent: computeMaxConcurrent() };
}

// Cancel everything: queued jobs are skipped as their turn comes up, live
// children get SIGTERM (each stage script forwards it to its own python/
// soffice child). The flag resets on the next runIfNeeded pass.
export async function cancelPipeline() {
  cancelRequested = true;
  const snapshot = [...children];
  const n = snapshot.length;
  for (const child of snapshot) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  // Escalate to SIGKILL for anything still alive after a grace period. A stage
  // that ignores SIGTERM (e.g. a wedged ~20GB model load) would otherwise keep
  // its slot and pin the pipeline in the 'running' state indefinitely, so the
  // user could never start a fresh pass. `children` is pruned on child close,
  // so anything still present here refused to die.
  if (n > 0) {
    const t = setTimeout(() => {
      for (const child of snapshot) {
        if (children.has(child)) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }
    }, 8000);
    t.unref?.();
  }
  await appendLog(`CANCEL requested — signalled ${n} running job(s), ${queued.size} queued job(s) will be skipped`).catch(() => {});
  return { signalled: n, queued: queued.size };
}

async function statMtime(filePath) {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

// Recursively find the newest mtime of any file directly inside a directory.
// Non-recursive by design: plan 1e only asks about files under files/, not
// nested subfolders (Canvas folder-listing is a separate OPEN item in the plan).
async function newestMtimeInDir(dir) {
  try {
    const entries = await fs.readdir(dir);
    let newest = 0;
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        const st = await fs.stat(full);
        if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* skip */ }
    }
    return newest;
  } catch {
    return 0;
  }
}

// Stale check: does outPath need rebuilding from these sources?
// sourcePaths are files; dirSources are directories scanned one level deep.
async function isStale(outPath, sourcePaths, dirSources = []) {
  const [outMtime, fileMtimes, dirMtimes] = await Promise.all([
    statMtime(outPath),
    Promise.all(sourcePaths.map(statMtime)),
    Promise.all(dirSources.map(newestMtimeInDir)),
  ]);
  const newestSource = Math.max(0, ...fileMtimes.map(m => m ?? 0), ...dirMtimes);
  return newestSource > 0 && (outMtime === null || outMtime < newestSource);
}

// Run one pipeline stage if its output is stale. The staleness check happens
// right before the spawn (not up front) so each stage sees the outputs the
// previous stage just wrote — parse feeds extract feeds mine feeds context in
// a single trigger pass instead of one stage per ingest.
async function runStageIfStale(classDir, scriptName, outPath, sourcePaths, dirSources = []) {
  if (!(await isStale(outPath, sourcePaths, dirSources))) return;
  const token = `${classDir}:${scriptName}`;
  if (queued.has(token) || active.has(token)) return;
  queued.add(token);
  await spawnJob(path.join(REPO_ROOT, 'scripts', scriptName), classDir, token);
}

async function processClassDir(classDir, fn) {
  const p = (...s) => path.join(classDir, ...s);

  // 1. Parse syllabus → syllabus_parsed.json
  if (fn.parse) await runStageIfStale(classDir, 'parse-syllabus.js',
    p('syllabus_parsed.json'),
    [p('syllabus.html'), p('syllabus.pdf'), p('syllabus.docx')]);

  // 2. Extract text from downloaded course files → materials/. The anchor is
  // last_extracted.txt (written after everything else): _combined.txt is
  // absent in split mode, and files_index.json is rewritten by extract itself.
  if (fn.extract) await runStageIfStale(classDir, 'extract-course-files.js',
    p('materials', 'last_extracted.txt'),
    [p('files_index.json')],
    [p('files')]);

  // Deterministic and cheap. This runs independently of the AI mining switch:
  // turning the model off must never turn explicit syllabus readings off too.
  // The writer is content-aware, so an unchanged pass does not bump mtimes or
  // make downstream stages stale.
  await indexClassReadings(classDir);

  // 4. Mine the exhaustive task list (AI) → assignments_mined.json
  if (fn.mine) await runStageIfStale(classDir, 'mine-assignments.js',
    p('assignments_mined.json'),
    [
      p('assignments.json'), p('assignment_groups.json'), p('quizzes.json'),
      p('syllabus_parsed.json'), p('modules.json'), p('pages.json'),
      p('announcements.json'), p('discussions.json'), p('calendar_events.json'),
      p('materials', 'last_extracted.txt'), p('readings_index.json'),
    ]);

  // 5. Build the context + uploadable pack → AI_CONTEXT/
  if (fn.build) await runStageIfStale(classDir, 'build-context.js',
    p('AI_CONTEXT', 'last_built.txt'),
    [
      p('metadata.json'), p('assignments.json'), p('assignment_groups.json'),
      p('modules.json'), p('announcements.json'), p('pages.json'),
      p('quizzes.json'), p('discussions.json'), p('calendar_events.json'),
      p('grades.json'), p('tabs.json'),
      p('syllabus_parsed.json'), p('assignments_mined.json'),
      p('readings_index.json'), p('materials', 'last_extracted.txt'),
    ]);
}

export async function runIfNeeded() {
  // Idempotent guard — fire-and-forget, never throws. A call while a pass is
  // already running (e.g. a sync finishing during a long mining stage) flags
  // a rerun so the fresh data is processed as soon as this pass ends, instead
  // of sitting untouched until the next external trigger.
  if (running) {
    rerunRequested = true;
    return;
  }
  running = true;
  cancelRequested = false;
  rerunRequested = false;
  refreshSemaphore();
  (async () => {
    try {
      const classesDir = path.join(syncHome(), 'classes');
      let entries;
      try {
        entries = await fs.readdir(classesDir);
      } catch {
        return; // classes dir doesn't exist yet
      }

      // Two filters, both load-bearing:
      //   - CLASS_DIR_RE: this loop used to accept any directory at all, so a
      //     stray folder under classes/ got a full AI pipeline spawned on it.
      //   - scope: Canvas keeps every past semester enrolled, so without this
      //     the expensive stages re-ran across two years of dead classes on
      //     every single sync. An unknown scope still processes everything.
      const scope = readSyncScope(syncHome());
      const classDirs = (await Promise.all(
        entries.map(async e => {
          if (!CLASS_DIR_RE.test(e)) return null;
          if (!isInScope(scope, e)) return null;
          const full = path.join(classesDir, e);
          try {
            const st = await fs.stat(full);
            return st.isDirectory() ? full : null;
          } catch {
            return null;
          }
        })
      )).filter(Boolean);

      // The Functions switches, read once per pass so all classes in the pass
      // agree about what is on.
      const fn = await stageToggles();
      const offNames = Object.entries(fn).filter(([, v]) => !v).map(([k]) => k);
      if (offNames.length) await appendLog(`SKIP (off in settings): ${offNames.join(', ')}`).catch(() => {});

      // Process all class dirs concurrently (each internally serialises
      // parse -> extract -> mine -> context).
      await Promise.all(classDirs.map(d => processClassDir(d, fn).catch(err =>
        appendLog(`ERROR processClassDir ${d} ${err.message}`).catch(() => {})
      )));

      // Rebuild the calendar worklist once per pass. Deterministic and cheap
      // (no AI unless CSYNC_CAL_AGENT=1) — the user's Claude routine consumes
      // <base>/calendar/worklist.md on its own schedule.
      if (fn.calendar && classDirs.length > 0) {
        const calToken = 'global:sync-calendar';
        if (!queued.has(calToken) && !active.has(calToken)) {
          queued.add(calToken);
          await spawnJob(path.join(REPO_ROOT, 'scripts', 'sync-calendar.js'), classesDir, calToken);
        }
      }
    } catch (err) {
      await appendLog(`ERROR runIfNeeded ${err.message}`).catch(() => {});
    } finally {
      running = false;
      if (rerunRequested && !cancelRequested) {
        await appendLog('RERUN — new data arrived during the last pass').catch(() => {});
        runIfNeeded();
      }
    }
  })();
}
