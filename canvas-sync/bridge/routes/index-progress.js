// index-progress.js — GET /api/index-progress.
//
// One HTTP surface for "what does this install actually hold, and what is the
// pipeline doing about it right now". The dashboard polls it every 3s while
// pipeline.running and every 30s idle.
//
// This file is TRANSPORT ONLY. The progress model itself — per-stage staleness,
// per-class artifact counts, trigger.log archaeology — belongs in
// scripts/index-progress.js and is injected here. That split is deliberate:
// the pipeline's own staleness predicates already disagree with each other in
// one place (trigger.js:305 checks syllabus mtime only, while
// sync-all-contexts.js:25-62 additionally confirms with syllabus.hash), and a
// THIRD copy of them living inside a route would guarantee the page reports
// "stale" for a stage the pipeline then declines to run, forever. If you find
// yourself writing a needsX() here, you are writing it in the wrong file.
//
// Auth: none of its own. The router is mounted ON dashRouter, which already
// carries requireSecret(config) (server.js:736), and middleware registered
// before a mount runs before it. A second timing-safe compare in this file
// would be a second thing to keep in step with server.js's.

import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSyncScope, isInScope, CLASS_DIR_RE } from '../../scope.js';
import { modelLockStatus, anthropicKeyStatus, resolveLocalModel } from '../../scripts/_util.js';

// A class directory is "<courseId>-<slug>" and nothing else. A bare readdir of
// classes/ returns SEVEN entries on this machine for six classes: .DS_Store is
// the seventh, and that is exactly how it ended up in the meeting-time recovery
// table as a class with `source=none`.
//
// Re-exported, not re-declared: this file used to keep a fifth private copy of
// the regex under a comment saying neither trigger.js nor server.js exported
// it. scope.js does now, and scripts/index-progress.js imports it from there,
// so a private copy here is just something left to drift.
export { CLASS_DIR_RE };

// Where the progress model lives when it exists. Resolved from this file rather
// than from cwd: the bridge is started from the repo root by the launcher but
// from bridge/ by hand, and `node bridge/server.js` vs `node server.js` must not
// change which module is found.
const MODEL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'index-progress.js',
);

// The model module is young and its export name is not frozen yet. Probe in
// preference order rather than hard-failing the whole page on a rename.
const MODEL_EXPORTS = ['buildIndexProgress', 'indexProgress', 'buildProgress', 'default'];

// Everything the contract says cannot be answered without a pipeline change.
// Shipped in the payload so the UI can render "not measurable yet" instead of a
// zero that reads as "measured, and it is zero".
const REQUIRES_NEW_WRITES = [
  'jobs[].pid',
  'jobs[].startedAt (in-memory; log-derivable today)',
  'pipeline.queued[]',
  'model.lock.holder.folder',
  "model.waiting[].basis='announced'",
  'classes[].canvasNewerThanIndex (files only today)',
];

async function readJsonOrNull(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

async function mtimeIsoOrNull(p) {
  try { return (await fs.stat(p)).mtime.toISOString(); } catch { return null; }
}

// metadata.json stores Canvas's enrollment_term verbatim, so `term` is an object
// ({id, name, start_at, …}) — rendering it straight put "[object Object]" in the
// sidebar. Older context-derived metadata stores a plain string. Same rule as
// server.js's termNameOf.
function termNameOf(metadata) {
  const t = metadata?.term ?? metadata?.course?.term;
  if (typeof t === 'string') return t;
  return t?.name ?? null;
}

// Which backend an AI stage would pick if it ran now. Jobs are spawned with
// settings.json's CSYNC_* folded OVER process.env (trigger.js:188), so the file
// wins here too — reading only process.env reported 'auto' for a user who had
// pinned 'local' in the dashboard.
async function resolveBackend(home) {
  const settings = await readJsonOrNull(path.join(home, 'settings.json'));
  const fromFile = settings?.env?.CSYNC_AI_BACKEND;
  const raw = (typeof fromFile === 'string' && fromFile.trim())
    ? fromFile
    : (process.env.CSYNC_AI_BACKEND || 'auto');
  return String(raw).toLowerCase();
}

// pipelineStatus() is per-process memory (trigger.js:84). A bridge that did not
// spawn the children — a restart mid-pass, or a second bridge process — reports
// running:false while three jobs are very much alive. Passing it through with
// its provenance is honest; inventing a state here would not be.
function pipelineBlock(pipelineStatus) {
  let st = null;
  try { st = typeof pipelineStatus === 'function' ? pipelineStatus() : null; } catch { st = null; }
  const active = Array.isArray(st?.active) ? st.active : [];
  return {
    running: st?.running ?? false,
    activeCount: active.length,
    queuedCount: st?.queuedCount ?? 0,
    maxConcurrent: st?.maxConcurrent ?? null,
    // pipelineStatus() does not return the cancel flag. null means "not
    // reported", which is not the same claim as false.
    cancelRequested: typeof st?.cancelRequested === 'boolean' ? st.cancelRequested : null,
    // Display strings, `<folder> · <script.js>` (trigger.js:236-243). Kept even
    // though they carry no pid: they are the only live signal that exists today,
    // and /api/ask/status already made the mistake of dropping the one field
    // (the lock holder's pid) its caller needed.
    active,
    queued: null,
    _from: 'trigger.pipelineStatus() — in-process memory; a restarted bridge cannot see its own orphans',
  };
}

async function modelBlock(home, bridgePid) {
  const [lock, key, localModelId, backend] = await Promise.all([
    // Machine-wide by intent, per data root in fact: modelLockStatus() reads
    // dataRoot()/locks/local-model.lock, not the home injected here. Pure read —
    // it never creates, reclaims or removes the lock (scripts/_util.js:191).
    modelLockStatus().catch(() => ({ held: false, pid: null, alive: false, heldForMs: 0 })),
    anthropicKeyStatus().catch(() => ({ present: false, source: null, hint: null })),
    resolveLocalModel().catch(() => null),
    resolveBackend(home),
  ]);

  // class-chat.js runs IN-PROCESS in the bridge (server.js:1089 dynamic import),
  // so when the chat takes the lock, localInvoke writes the BRIDGE's pid into it.
  // That is the one holder we can name with no pipeline change at all.
  const holderKind = lock.pid == null ? null
    : (bridgePid != null && lock.pid === bridgePid) ? 'class-chat'
    : null; // 'pipeline-stage' vs 'foreign' needs the pid→job map (F1).

  return {
    backend,
    localModelId,
    anthropicKey: key, // masked by construction in anthropicKeyStatus(); never the key
    lock: {
      ...lock,
      holderKind,
      holder: null,
      _from: 'scripts/_util.js modelLockStatus()',
      _gap: holderKind === null && lock.pid != null
        ? 'holder identity needs the pid→class map (F1); the lock file carries only a pid'
        : null,
    },
    waiting: null, // needs jobs[].pid to compute; see REQUIRES_NEW_WRITES
  };
}

async function classesBlock(home) {
  const classesDir = path.join(home, 'classes');
  let folders = [];
  try {
    folders = (await fs.readdir(classesDir)).filter(n => CLASS_DIR_RE.test(n)).sort();
  } catch {
    // No classes/ dir at all is the state of a fresh install between running
    // install.sh and the first sync. The page polls this route every 3s; a 500
    // here would paint a brand-new install permanently red.
    return [];
  }
  const scope = readSyncScope(home);
  const out = [];
  for (const folder of folders) {
    const dir = path.join(classesDir, folder);
    const metaPath = path.join(dir, 'metadata.json');
    const [metadata, lastScrapedAt] = await Promise.all([
      readJsonOrNull(metaPath),
      // Exact, not approximate: writeCourse writes all twelve Canvas JSONs in
      // one Promise.all (storage.js:67-78), so metadata.json's mtime is when
      // this course was last written to disk.
      mtimeIsoOrNull(metaPath),
    ]);
    out.push({
      folder,
      courseId: folder.split('-')[0],
      slug: folder.replace(/^[0-9]+-/, ''),
      code: metadata?.course_code ?? metadata?.course?.code ?? null,
      name: metadata?.name ?? metadata?.course?.name ?? folder,
      term: termNameOf(metadata),
      inScope: isInScope(scope, folder),
      lastScrapedAt,
      // Deliberately empty, not zeroed: a stage list of [] says "not measured",
      // where {done:0,total:5} would say "measured, nothing done" about a class
      // that may be fully indexed.
      overall: { done: 0, total: 0, percent: null, state: 'unknown', blocked: null },
      stages: [],
      categories: [],
    });
  }
  return out;
}

/**
 * The payload the route can build with no progress model present: identity,
 * scope, live pipeline and model state. Everything derived — stage states,
 * artifact counts, job pids — is left empty and named in `degraded`, because a
 * plausible-looking wrong percentage is worse than an absent one.
 */
export async function buildFallbackProgress(home, { pipelineStatus, bridgePid, reason } = {}) {
  const [classes, model, lastSync, worklist] = await Promise.all([
    classesBlock(home),
    modelBlock(home, bridgePid),
    readJsonOrNull(path.join(home, 'last_sync.json')),
    readJsonOrNull(path.join(home, 'calendar', 'worklist.json')),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    home,
    bridgePid: bridgePid ?? null,
    scope: { ...readSyncScope(home), _from: 'scope.js readSyncScope(home)' },
    lastScrape: {
      at: lastSync?.timestamp ?? null,
      coursesSeen: Array.isArray(lastSync?.coursesSeen) ? lastSync.coursesSeen.map(String) : [],
      // GLOBAL, never per class: the extension is the only thing that talks to
      // Canvas and it reports completion once per sync (storage.js:160). Say
      // "last scraped", never "up to date with Canvas".
      _from: '<home>/last_sync.json — GLOBAL, never per class',
    },
    pipeline: pipelineBlock(pipelineStatus),
    model,
    jobs: [],
    classes,
    global: {
      calendar: {
        artifact: 'calendar/worklist.json',
        generatedAt: worklist?.generated_at ?? null,
        window: worklist?.window ?? null,
        counts: worklist?.counts ?? null,
        script: 'scripts/sync-calendar.js',
        scope: 'GLOBAL — spawned once per pass with the classes/ dir, not per class',
      },
      unscopedClasses: null,
    },
    requiresNewWrites: REQUIRES_NEW_WRITES,
    degraded: {
      reason: reason ?? 'progress model unavailable',
      missing: ['classes[].stages', 'classes[].categories', 'classes[].overall', 'jobs', 'global.unscopedClasses'],
    },
  };
}

// Load scripts/index-progress.js on demand. Success is cached; failure is NOT,
// so a bridge that started before the model module landed picks it up on the
// next poll instead of staying degraded until someone restarts it.
let _cachedModelFn = null;
async function loadProgressModel() {
  if (_cachedModelFn) return _cachedModelFn;
  // pathToFileURL, not a string path: import() of a bare absolute path is not
  // portable, and any path component with a space would break a hand-built URL.
  const mod = await import(pathToFileURL(MODEL_PATH).href);
  for (const name of MODEL_EXPORTS) {
    if (typeof mod?.[name] === 'function') {
      _cachedModelFn = mod[name];
      return _cachedModelFn;
    }
  }
  const e = new Error(`scripts/index-progress.js exports none of ${MODEL_EXPORTS.join(', ')}`);
  e.code = 'PROGRESS_MODEL_SHAPE';
  throw e;
}

/**
 * Build the payload: the injected/loaded progress model if there is one, the
 * fallback envelope otherwise.
 */
async function buildPayload(home, { pipelineStatus, bridgePid, buildProgress }) {
  let fn = buildProgress;
  if (!fn) {
    try {
      fn = await loadProgressModel();
    } catch (err) {
      return buildFallbackProgress(home, {
        pipelineStatus, bridgePid,
        reason: `scripts/index-progress.js not loadable: ${err.message}`,
      });
    }
  }
  let payload;
  try {
    payload = await fn(home, { pipelineStatus, bridgePid });
  } catch (err) {
    // A model that throws must not take the page down with it. The user's live
    // bridge (one process, serving the whole dashboard) would otherwise die on
    // an unhandled rejection — Node has defaulted to --unhandled-rejections=throw
    // since v15, and this runs on v24.
    return buildFallbackProgress(home, {
      pipelineStatus, bridgePid,
      reason: `progress model threw: ${err.message}`,
    });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return buildFallbackProgress(home, {
      pipelineStatus, bridgePid,
      reason: 'progress model returned a non-object',
    });
  }
  return payload;
}

/**
 * Factory → express Router carrying GET /index-progress.
 *
 * Mount it on dashRouter (which already applies requireSecret), NOT on the app:
 *   dashRouter.use(indexProgressRouter({ syncHome, pipelineStatus }));
 *
 * @param {object}   opts
 * @param {function} opts.syncHome        () => absolute data root (server.js's syncHome)
 * @param {function} opts.pipelineStatus  trigger.js pipelineStatus
 * @param {function} [opts.buildProgress] (home, {pipelineStatus, bridgePid}) => payload.
 *                                        Defaults to scripts/index-progress.js.
 * @param {number}   [opts.bridgePid]     defaults to this process — the bridge itself.
 */
export function indexProgressRouter({
  syncHome,
  pipelineStatus,
  buildProgress = null,
  bridgePid = process.pid,
} = {}) {
  if (typeof syncHome !== 'function') {
    // Fail at mount time, not per request. A missing syncHome would resolve
    // 'classes' relative to the bridge's cwd — the repo root under the Electron
    // launcher, bridge/ when started by hand. Two different wrong answers, and
    // neither of them errors: the page would simply report zero classes.
    throw new TypeError('indexProgressRouter: syncHome must be a function returning the data root');
  }

  const router = express.Router();

  // One build at a time. Two dashboards (the Electron shell and a browser tab)
  // polling at 3s would otherwise run two full passes over ~100 files each,
  // three seconds apart, forever. Late arrivals join the build already running
  // rather than starting a second one.
  let inFlight = null;

  router.get('/index-progress', async (req, res) => {
    try {
      const home = syncHome();
      if (!inFlight) {
        inFlight = buildPayload(home, { pipelineStatus, bridgePid, buildProgress })
          .finally(() => { inFlight = null; });
      }
      const payload = await inFlight;
      // Polled data with no validators. Without no-store, Chrome's heuristic
      // freshness (10% of Date−Last-Modified) is free to answer a poll from
      // cache, which looks exactly like a pipeline that has stopped moving.
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    } catch (err) {
      // buildPayload swallows model failures already; anything reaching here is
      // the route's own fault. Shape-stable error, detail to the log only —
      // express 4 does not forward async rejections to server.js's terminal
      // handler, so without this catch the request hangs and the process dies.
      console.error('[bridge] /api/index-progress error:', err.message);
      res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}
