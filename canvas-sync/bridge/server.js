// server.js — canvas-sync local bridge
// Binds strictly to 127.0.0.1. Refuses to start if HOST/BIND env vars point non-loopback.
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  writeCourse,
  writeFile,
  writeCourseFile,
  updateLastSync,
  safeDeleteClass,
  DeleteValidationError,
  isValidFolderName,
  measureClass,
} from './storage.js';
import { runIfNeeded, pipelineStatus, cancelPipeline } from './trigger.js';
import { dataRoot } from '../data-root.js';
import { readSyncScope, readEnrolledCourses, isInScope, SCOPE_FILE, CLASS_DIR_RE } from '../scope.js';
import { readUserState, patchTask, UserStateError } from './user-state.js';
import { filesWithOrigins } from './file-origins.js';
import {
  KINDS as CAL_KINDS, KIND_LABELS as CAL_KIND_LABELS,
} from '../calendar-kinds.js';
import { canvasItemUrl, canvasSubmitUrl } from '../canvas-links.js';
import { tasksForClass } from '../canvas-tasks.js';
import { modelLockStatus, anthropicKeyStatus } from '../scripts/_util.js';
import { DEFAULT_PALETTE, COLORS_FILE, resolveColors, applyColorPatch } from '../class-colors.js';
import { countMeetings } from '../scripts/cal-meetings.js';
import { shortCourseCode } from '../scripts/cal-names.js';
import { classGrades } from '../scripts/grades.js';
import {
  recoverMeetingTimes, writeMeetingOverride, clearMeetingOverride,
  revertMeetingOverride, readMeetingRevert, describeRevertTarget, describeMeetingSource,
} from '../scripts/meeting-times.js';
import {
  readCustomItems, createCustomItem, patchCustomItem, deleteCustomItem,
  customItemOp, CustomItemError, ID_RE as CUSTOM_ID_RE,
} from '../custom-items.js';
import { indexProgressRouter } from './routes/index-progress.js';

// From the manifest, never a copy: this is the number the UI footer and
// /api/status report, and as a hardcoded literal it sat at 1.1.0 while
// package.json moved three releases past it. Nothing to keep in step.
const VERSION = JSON.parse(
  await fs.readFile(new URL('./package.json', import.meta.url), 'utf8'),
).version;
// OPEN: BRIDGE_PORT=0 is used by tests for ephemeral port; production always uses 3847.
const BIND_ADDR = '127.0.0.1';

// Resolve the canvas-sync repo root (one level up from bridge/).
// Used to spawn scripts/cleanup-class-calendar.js as a detached child.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One shared definition for every entry point — see ../data-root.js.
const syncHome = dataRoot;

// --- Startup guard: reject non-loopback HOST/BIND env vars ---
function assertLoopbackEnv() {
  for (const key of ['HOST', 'BIND']) {
    const val = process.env[key];
    if (!val) continue;
    if (val === '127.0.0.1' || val.startsWith('127.')) continue;
    console.error(`[bridge] Refusing to start: env ${key}=${val} is not a loopback address.`);
    process.exit(1);
  }
}

// --- Config ---
// Throws instead of exiting: loadConfig() is called at REQUEST time (ingest
// backstop, /config/untracked/*, /class/delete, /api/pair-token force), and a
// process.exit() there let one unreadable/corrupt config.json take the whole
// bridge down mid-request — a denial of service reachable from ordinary sync
// traffic. Startup keeps the fail-fast behaviour via loadConfigOrExit().
async function loadConfig() {
  const configPath = path.join(syncHome(), 'config.json');
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    const e = new Error(`config.json unreadable at ${configPath}: ${err.message}`);
    e.code = 'CONFIG_UNREADABLE';
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Distinct from "not found" — a corrupt file was previously misreported as
    // missing, sending users to re-run install.sh instead of fixing the JSON.
    const e = new Error(`config.json is not valid JSON at ${configPath}: ${err.message}`);
    e.code = 'CONFIG_CORRUPT';
    throw e;
  }
}

// Startup-only wrapper: a bridge that cannot read its own config has nothing
// useful to serve, so failing fast at boot is still correct.
async function loadConfigOrExit() {
  try {
    return await loadConfig();
  } catch (err) {
    console.error('[bridge]', err.message);
    console.error(err.code === 'CONFIG_CORRUPT'
      ? '[bridge] Fix or delete that file, then restart.'
      : '[bridge] Run install.sh to initialise the data directory.');
    process.exit(1);
  }
}

async function saveConfig(config) {
  const configPath = path.join(syncHome(), 'config.json');
  const tmp = configPath + '.tmp.' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.rename(tmp, configPath);
}

// Cap on how many course ids either side may push at us. A Canvas account
// with hundreds of enrollments is plausible; hundreds of thousands is not, and
// an unbounded list here would be an unbounded file write.
const MAX_SCOPE_IDS = 500;

// State the desktop app authors, kept out of config.json for the same reason
// as the scope mirror: config.json holds the pairing secret.
const DASHBOARD_STATE_FILE = 'dashboard-state.json';

async function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, filePath);
}

async function readDashboardState() {
  try {
    const raw = await fs.readFile(path.join(syncHome(), DASHBOARD_STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : { version: 1 };
  } catch {
    // Missing or corrupt: an empty state is always a safe reading of "the user
    // has not asked for anything", so this never needs to fail a request.
    return { version: 1 };
  }
}

async function writeDashboardState(state) {
  await atomicWriteJson(path.join(syncHome(), DASHBOARD_STATE_FILE), { version: 1, ...state });
}

// --- Constant-time secret compare ---
// Exported for unit testing.
export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Buffers must be same byte length for timingSafeEqual.
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// --- Middleware: validate secret ---
function requireSecret(config) {
  return (req, res, next) => {
    const header = req.headers['x-bridge-secret'] ?? '';
    const stored = config.bridgeSecret ?? '';
    if (!header || !stored || !timingSafeCompare(header, stored)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

// --- Middleware: CORS for chrome-extension origins ---
// Any chrome-extension://<id> origin gets CORS headers. They grant no access —
// requireSecret and requireOrigin decide that — they only let the caller READ
// the answer. Withholding them from an unpaired or wrong extension turned that
// extension's 403 into an opaque fetch() TypeError, which bridge-client
// rewrapped as a transient network fault and retried forever; a revoked
// extension retried in silence instead of prompting the user to re-pair.
function corsMiddleware(config) {
  const EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-z0-9]+$/;
  return (req, res, next) => {
    const origin = req.headers['origin'];
    if (origin && EXT_ORIGIN_RE.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Secret');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  };
}

// --- Middleware: validate Origin ---
// Guards the extension-only routes (/ingest/*, /files-index, /class, /config).
// The Electron app and the dashboard reach the bridge through /api/* and /app,
// which are deliberately exempt — browser and Electron requests carry no
// chrome-extension Origin, so enforcing this on them would 403 the whole UI.
function requireOrigin(config) {
  const EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-z0-9]+$/;
  return (req, res, next) => {
    const origin = req.headers['origin'] ?? '';
    if (config.extensionId) {
      if (origin !== `chrome-extension://${config.extensionId}`) {
        return res.status(403).json({ error: 'forbidden origin' });
      }
      return next();
    }
    // Nothing paired. A force-unpair (/api/pair-token {force:true}) clears
    // extensionId but leaves bridgeSecret in place so the desktop app and
    // dashboard keep working — which meant the just-unpaired extension, still
    // holding that same secret, sailed through both checks and kept ingesting.
    // "Unpaired" has to mean unpaired: reject extension traffic outright until
    // a handshake stores an id again.
    if (EXT_ORIGIN_RE.test(origin)) {
      return res.status(403).json({ error: 'not paired — pair this extension from the app first' });
    }
    next();
  };
}

// --- Kill-switch check for ingest routes ---
async function disabledCheck(req, res, next) {
  const disabledPath = path.join(syncHome(), 'DISABLED');
  try {
    await fs.access(disabledPath);
    const logDir = path.join(syncHome(), 'logs');
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(
      path.join(logDir, 'trigger.log'),
      `${new Date().toISOString()} DISABLED ${req.method} ${req.path}\n`,
      'utf8'
    ).catch(() => {});
    return res.status(503).json({ error: 'bridge disabled' });
  } catch {
    next();
  }
}

// --- Minimal structured logger ---
function logRequest(req, res, courseId) {
  const line = [
    new Date().toISOString(),
    req.method,
    req.path,
    res.statusCode,
    courseId ? `courseId=${courseId}` : '',
  ].filter(Boolean).join(' ');
  console.log(line);
}

// --- App factory (exported so tests can import without auto-starting) ---
export function buildApp(config) {
  const app = express();
  app.use(corsMiddleware(config));
  app.use(express.json({ limit: `${config.maxIngestMb ?? 200}mb` }));

  // Health
  app.get('/health', requireSecret(config), (req, res) => {
    res.json({ ok: true, version: VERSION });
    logRequest(req, res, null);
  });

  // Handshake — accepts missing Origin when no extensionId stored yet.
  app.post('/handshake', async (req, res) => {
    try {
      const { extensionId, installToken } = req.body ?? {};
      if (!extensionId || !installToken) {
        return res.status(400).json({ error: 'extensionId and installToken required' });
      }
      // Re-pairing the SAME extension is always allowed. Reloading an unpacked
      // extension wipes chrome.storage.local (including the bridge secret)
      // while config.extensionId still names that same id — the old code
      // rejected with 409 before even reading the token, so recovering the
      // secret required the secret you had just lost. A valid, unexpired,
      // single-use install token is already proof of local control, and the
      // dashboard/app is the only thing that can mint one.
      if (config.extensionId && config.extensionId !== extensionId) {
        return res.status(409).json({
          error: 'already paired to a different extension — generate a new token '
               + 'in the app (Settings → Pair a Chrome extension) to replace it',
          paired: true,
        });
      }

      const tokenPath = path.join(syncHome(), 'install-token.txt');
      let storedToken, tokenStat;
      try {
        [storedToken, tokenStat] = await Promise.all([
          fs.readFile(tokenPath, 'utf8').then(s => s.trim()),
          fs.stat(tokenPath),
        ]);
      } catch {
        return res.status(403).json({ error: 'no install token found' });
      }

      const ageSec = (Date.now() - tokenStat.mtimeMs) / 1000;
      if (ageSec > 600) {
        return res.status(403).json({ error: 'install token expired' });
      }

      // OPEN: tokens are variable-length; timingSafeCompare rejects unequal lengths.
      if (!timingSafeCompare(installToken, storedToken)) {
        return res.status(403).json({ error: 'invalid token' });
      }

      config.extensionId = extensionId;
      await saveConfig(config);
      await fs.unlink(tokenPath).catch(() => {});

      res.json({ ok: true, secret: config.bridgeSecret });
      logRequest(req, res, null);
    } catch (err) {
      console.error('[bridge] /handshake error:', err.message);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Ingest routes
  const ingestRouter = express.Router();
  ingestRouter.use(requireOrigin(config));
  ingestRouter.use(requireSecret(config));
  ingestRouter.use(disabledCheck);

  // Server-side backstop for the extension's untracked filter: a deleted
  // class must never be recreated by an ingest POST — not by a stale
  // extension, and not by the race where a class is deleted while a sync that
  // already fetched it is still in flight. Untracked entries are folder names
  // ("<courseId>-<slug>"), so matching on the courseId prefix covers every
  // ingest route without needing the slug.
  ingestRouter.use(async (req, res, next) => {
    const courseId = req.body?.course?.id ?? req.body?.courseId;
    if (courseId == null) return next();
    try {
      const fresh = await loadConfig();
      const untracked = Array.isArray(fresh.untracked) ? fresh.untracked : [];
      if (untracked.some(f => String(f).startsWith(`${courseId}-`))) {
        res.status(410).json({ error: 'course untracked', courseId });
        logRequest(req, res, courseId);
        return;
      }
    } catch { /* config unreadable — auth already passed, don't block ingest */ }
    next();
  });

  ingestRouter.post('/course', async (req, res) => {
    const courseId = req.body?.course?.id ?? req.body?.courseId;
    try {
      await writeCourse(req.body);
      res.json({ ok: true });
      logRequest(req, res, courseId);
    } catch (err) {
      console.error('[bridge] /ingest/course error:', err.message, 'courseId:', courseId);
      res.status(500).json({ error: 'write failed' });
      logRequest(req, res, courseId);
    }
  });

  ingestRouter.post('/file', async (req, res) => {
    const courseId = req.body?.courseId;
    try {
      const result = await writeFile(req.body);
      res.json({ ok: true, ...result });
      logRequest(req, res, courseId);
    } catch (err) {
      console.error('[bridge] /ingest/file error:', err.message, 'courseId:', courseId);
      res.status(500).json({ error: 'write failed' });
      logRequest(req, res, courseId);
    }
  });

  ingestRouter.post('/course-file', async (req, res) => {
    const courseId = req.body?.courseId;
    try {
      const result = await writeCourseFile(req.body);
      res.json({ ok: true, ...result });
      logRequest(req, res, courseId);
    } catch (err) {
      console.error('[bridge] /ingest/course-file error:', err.message, 'courseId:', courseId);
      res.status(500).json({ error: 'write failed' });
      logRequest(req, res, courseId);
    }
  });

  ingestRouter.post('/complete', async (req, res) => {
    const { coursesSeen } = req.body ?? {};
    try {
      await updateLastSync(coursesSeen ?? []);
      res.json({ ok: true });
      logRequest(req, res, null);
      runIfNeeded(); // fire-and-forget
    } catch (err) {
      console.error('[bridge] /ingest/complete error:', err.message);
      res.status(500).json({ error: 'update failed' });
      logRequest(req, res, null);
    }
  });

  app.use('/ingest', ingestRouter);

  // --- v1.1 routes ---
  // All share the same auth stack as /ingest/*: origin + secret + kill switch.
  const v11Router = express.Router();
  // Scope the auth stack to the paths this router actually serves. The router
  // is mounted at root, so bare `.use(requireOrigin(...))` would run the
  // extension-Origin check on EVERY request — which, once an extension is
  // paired, 403s the dashboard (/api/*, /app): browser requests carry no
  // chrome-extension Origin.
  const V11_PATHS = ['/files-index', '/class', '/config'];
  v11Router.use(V11_PATHS, requireOrigin(config));
  v11Router.use(V11_PATHS, requireSecret(config));
  v11Router.use(V11_PATHS, disabledCheck);

  // GET /files-index/:folderName — read per-class files_index.json
  v11Router.get('/files-index/:folderName', async (req, res) => {
    const { folderName } = req.params;
    if (!isValidFolderName(folderName)) {
      return res.status(400).json({ error: 'invalid folderName' });
    }
    const indexPath = path.join(syncHome(), 'classes', folderName, 'files_index.json');
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      res.json({ files: Array.isArray(parsed) ? parsed : [] });
      logRequest(req, res, null);
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.json({ files: [] });
        logRequest(req, res, null);
        return;
      }
      console.error('[bridge] /files-index error:', err.message);
      res.status(500).json({ error: 'read failed' });
      logRequest(req, res, null);
    }
  });

  // A deleted class used to need a cleanup job: a headless `claude -p` with
  // calendar MCP tools, which listed 150 days of events across two Google
  // calendars and deleted the ones belonging to the class — and emailed a
  // hard-coded address when it failed. None of that can be handed to someone
  // else, and none of it is needed any more. The calendar is an .ics file
  // regenerated from the worklist, so a class that leaves the worklist leaves
  // the file, and every subscriber drops its events on the next refresh.
  // Rebuilding the worklist IS the cleanup.

  // Rebuild <base>/calendar/worklist.json from what is already on disk. Pure
  // and AI-free — sync-calendar.js only reads JSON — so a plan change can
  // repopulate the worklist in a second without running the pipeline.
  let calRebuild = { running: false, at: null, ok: null };
  // A request that arrives mid-run is REMEMBERED, not dropped. sync-calendar
  // reads each class's state as it walks, so a run already in flight can bake
  // in the pre-change answer; returning false and forgetting left the change
  // out of worklist.json and all four .ics files until some unrelated trigger
  // fired — and CALENDAR-SPEC 7.5 promises the opposite. One re-spawn is
  // enough however many requests pile up: the next run reads current disk.
  let calRebuildAgain = false;
  function spawnWorklistRebuild() {
    if (calRebuild.running) { calRebuildAgain = true; return true; }
    try {
      const script = path.join(REPO_ROOT, 'scripts', 'sync-calendar.js');
      const child = spawn(process.execPath, [script], {
        cwd: REPO_ROOT, stdio: 'ignore', detached: false,
        // Never let a plan change trigger the optional calendar agent: this
        // path is a UI click, not a scheduled sync.
        env: { ...process.env, CSYNC_CAL_AGENT: '0' },
      });
      calRebuild = { running: true, at: new Date().toISOString(), ok: null };
      child.on('error', (err) => {
        console.error('[bridge] worklist rebuild spawn failed:', err.message);
        calRebuild = { ...calRebuild, running: false, ok: false };
      });
      child.on('exit', (code) => {
        calRebuild = { ...calRebuild, running: false, ok: code === 0 };
        if (calRebuildAgain) { calRebuildAgain = false; spawnWorklistRebuild(); }
      });
      return true;
    } catch (err) {
      console.error('[bridge] worklist rebuild spawn failed:', err.message);
      calRebuild = { ...calRebuild, running: false, ok: false };
      return false;
    }
  }

  // Editing a task changes the calendar: marking it done removes its event,
  // moving it moves the event, adding a checkpoint adds one. A burst of edits
  // (typing a note) must not spawn a rebuild per keystroke, and a rebuild that
  // is already running must not be lost — so coalesce into one trailing run
  // and remember whether another became due while it was in flight.
  let taskRebuildTimer = null;
  let taskRebuildPending = false;
  function scheduleWorklistRebuild(delayMs = 1500) {
    taskRebuildPending = true;
    clearTimeout(taskRebuildTimer);
    taskRebuildTimer = setTimeout(function run() {
      if (calRebuild.running) { taskRebuildTimer = setTimeout(run, 1000); return; }
      taskRebuildPending = false;
      spawnWorklistRebuild();
    }, delayMs);
  }

  // POST /class/delete — per plan 3c
  v11Router.post('/class/delete', async (req, res) => {
    const { folderName } = req.body ?? {};
    if (!isValidFolderName(folderName)) {
      return res.status(400).json({ error: 'invalid folderName', rule: 'rule-2' });
    }

    // Perform the delete. DeleteValidationError → 400 with rule; other → 500.
    try {
      safeDeleteClass(folderName);
    } catch (err) {
      if (err instanceof DeleteValidationError) {
        return res.status(400).json({ error: err.message, rule: err.rule });
      }
      console.error('[bridge] /class/delete error:', err.message);
      return res.status(500).json({ error: 'delete failed' });
    }

    // On success: push folderName into config.untracked (idempotent) + save.
    try {
      const freshConfig = await loadConfig();
      const untracked = Array.isArray(freshConfig.untracked) ? freshConfig.untracked : [];
      if (!untracked.includes(folderName)) untracked.push(folderName);
      freshConfig.untracked = untracked;
      await saveConfig(freshConfig);
      // Mutate in-memory config too so subsequent requests see it.
      config.untracked = untracked;
    } catch (err) {
      console.error('[bridge] /class/delete: config update failed:', err.message);
      // Don't fail the response — deletion already succeeded.
    }

    // The worklist (and with it every .ics file) is rebuilt below; that is
    // what removes this class's events from anyone subscribed.
    spawnWorklistRebuild();

    res.json({ ok: true, deleted: folderName });
    logRequest(req, res, null);
  });

  // GET /config/untracked
  v11Router.get('/config/untracked', async (req, res) => {
    try {
      const fresh = await loadConfig();
      res.json({ untracked: Array.isArray(fresh.untracked) ? fresh.untracked : [] });
      logRequest(req, res, null);
    } catch (err) {
      console.error('[bridge] /config/untracked GET error:', err.message);
      res.status(500).json({ error: 'read failed' });
    }
  });

  // POST /config/untracked/add
  v11Router.post('/config/untracked/add', async (req, res) => {
    const { folderName } = req.body ?? {};
    if (!isValidFolderName(folderName)) {
      return res.status(400).json({ error: 'invalid folderName' });
    }
    try {
      const fresh = await loadConfig();
      const untracked = Array.isArray(fresh.untracked) ? fresh.untracked : [];
      if (!untracked.includes(folderName)) untracked.push(folderName);
      fresh.untracked = untracked;
      await saveConfig(fresh);
      config.untracked = untracked;
      res.json({ ok: true });
      logRequest(req, res, null);
    } catch (err) {
      console.error('[bridge] /config/untracked/add error:', err.message);
      res.status(500).json({ error: 'write failed' });
    }
  });

  // POST /config/untracked/remove
  v11Router.post('/config/untracked/remove', async (req, res) => {
    const { folderName } = req.body ?? {};
    if (!isValidFolderName(folderName)) {
      return res.status(400).json({ error: 'invalid folderName' });
    }
    try {
      const fresh = await loadConfig();
      const untracked = Array.isArray(fresh.untracked) ? fresh.untracked : [];
      const filtered = untracked.filter(f => f !== folderName);
      fresh.untracked = filtered;
      await saveConfig(fresh);
      config.untracked = filtered;
      res.json({ ok: true });
      logRequest(req, res, null);
    } catch (err) {
      console.error('[bridge] /config/untracked/remove error:', err.message);
      res.status(500).json({ error: 'write failed' });
    }
  });

  // POST /config/scope — the extension tells the bridge which courses it is
  // actually syncing, plus everything the user is enrolled in. Without this
  // the bridge could only infer the scope from the *last completed* sync, so
  // the dashboard kept listing a class for a whole sync cycle after the user
  // unticked it in Manage Courses.
  //   { courseIds: [...], enrolled: [...] } → save that scope
  //   { courseIds: null }                   → clear it, fall back to last_sync
  v11Router.post('/config/scope', async (req, res) => {
    const raw = req.body?.courseIds;
    if (raw !== null && !Array.isArray(raw)) {
      return res.status(400).json({ error: 'courseIds must be an array or null' });
    }
    // Canvas ids are strings on the wire (the extension asks for
    // json+canvas-string-ids). Normalise and drop anything that is not an id,
    // so one malformed entry can never widen or corrupt the scope.
    const courseIds = raw === null ? null
      : [...new Set(raw.map(id => String(id).trim()).filter(id => /^[0-9]+$/.test(id)))];
    const enrolled = Array.isArray(req.body?.enrolled)
      ? req.body.enrolled
          .filter(c => c && /^[0-9]+$/.test(String(c.courseId ?? '').trim()))
          .slice(0, MAX_SCOPE_IDS)
          .map(c => ({
            courseId: String(c.courseId).trim(),
            code: typeof c.code === 'string' ? c.code.slice(0, 200) : null,
            name: typeof c.name === 'string' ? c.name.slice(0, 300) : null,
            term: typeof c.term === 'string' ? c.term.slice(0, 200) : null,
          }))
      : null;

    const scopePath = path.join(syncHome(), SCOPE_FILE);
    try {
      if (courseIds === null && enrolled === null) {
        await fs.rm(scopePath, { force: true });
        res.json({ ok: true, courseIds: null });
        return logRequest(req, res, null);
      }
      // Keep whichever half this request did not carry.
      let existing = null;
      try { existing = JSON.parse(await fs.readFile(scopePath, 'utf8')); } catch { /* first write */ }
      await atomicWriteJson(scopePath, {
        version: 1,
        updatedAt: new Date().toISOString(),
        courseIds: courseIds ?? existing?.courseIds ?? null,
        enrolled: enrolled ?? existing?.enrolled ?? [],
      });
      res.json({ ok: true, courseIds });
      logRequest(req, res, null);
    } catch (err) {
      console.error('[bridge] /config/scope error:', err.message);
      res.status(500).json({ error: 'write failed' });
    }
  });

  // GET /config/intent — a selection change the user made in the desktop app,
  // waiting for the extension to pick it up. The extension owns the selection
  // (it lives in chrome.storage and only the extension can talk to Canvas), so
  // the app cannot write it directly; it leaves this note instead.
  v11Router.get('/config/intent', async (req, res) => {
    const state = await readDashboardState();
    res.json({ intent: state.intent ?? null });
    logRequest(req, res, null);
  });

  // POST /config/intent/ack — the extension applied an intent. The id match
  // matters: if the user changed the selection again while the sync was
  // running, that newer intent must survive this ack instead of being dropped.
  // The id is a uuid rather than the timestamp because two saves inside the
  // same millisecond share a Date.now(), and the ack would clear the wrong one.
  v11Router.post('/config/intent/ack', async (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : null;
    try {
      const state = await readDashboardState();
      if (id && state.intent && state.intent.id === id) {
        state.intent = null;
        await writeDashboardState(state);
        return res.json({ ok: true, cleared: true });
      }
      res.json({ ok: true, cleared: false });
      logRequest(req, res, null);
    } catch (err) {
      console.error('[bridge] /config/intent/ack error:', err.message);
      res.status(500).json({ error: 'write failed' });
    }
  });

  app.use(v11Router);

  // --- Dashboard (desktop app / browser UI) ---
  // Static UI is served without auth (localhost-only, contains no secrets).
  // All /api/* data routes require the bridge secret but NOT the extension
  // Origin — they're called from http://127.0.0.1:3847/app or the Electron
  // shell, not from the extension.
  const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
  app.use('/app', express.static(PUBLIC_DIR));

  // --- Calendar subscription ------------------------------------------------
  // A calendar app cannot send an X-Bridge-Secret header, so the ics routes
  // carry their credential in the path instead. The token is derived from the
  // bridge secret rather than being a second secret to store and lose: it is a
  // one-way hash, so a leaked subscription URL cannot be turned back into the
  // secret, and it survives restarts, which a random token would not.
  //
  // This is the whole replacement for the Claude routine. Subscribe once and
  // the calendar refreshes itself; sync-calendar rewrites the files, and the
  // csync markers are the VEVENT UIDs, so a corrected lecture MOVES rather than
  // appearing twice.
  const icsToken = crypto.createHash('sha256')
    .update(`${config.bridgeSecret}:ics`).digest('hex').slice(0, 32);
  const ICS_FILE_RE = /^[a-z]+\.ics$/;

  app.get('/ics/:token/:file', async (req, res) => {
    // Constant-time compare: a subscription URL is fetched on a timer by a
    // process we do not control, which is the ideal shape for a timing oracle.
    const given = Buffer.from(String(req.params.token));
    const want = Buffer.from(icsToken);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return res.status(404).type('text/plain').send('not found');
    }
    if (!ICS_FILE_RE.test(req.params.file)) {
      return res.status(404).type('text/plain').send('not found');
    }
    try {
      const body = await fs.readFile(path.join(syncHome(), 'calendar', req.params.file), 'utf8');
      res.type('text/calendar; charset=utf-8');
      res.set('Cache-Control', 'no-cache');
      res.send(body);
    } catch {
      // Not yet generated is not an error the subscriber can act on, and an
      // empty calendar is a valid one — better than a 404 that some clients
      // remember as a dead subscription and stop retrying.
      res.type('text/calendar; charset=utf-8')
        .send('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//canvas-sync//CANVASync//EN\r\nEND:VCALENDAR\r\n');
    }
  });

  // One definition of what a class directory looks like, imported rather than
  // retyped. This was the fifth private copy of the same regex; they had already
  // drifted once, and a copy that drifts is a copy that lets a stray directory
  // through into the AI pipeline.
  const CLASS_RE = CLASS_DIR_RE;
  // Only these top-level entries of a class dir are servable to the UI.
  const SERVABLE_ROOTS = new Set(['files', 'materials', 'AI_CONTEXT']);
  const MIME = {
    '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8', '.json': 'application/json',
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };

  const readJsonOrNull = async (p) => {
    try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
  };

  // metadata.json stores Canvas's enrollment_term verbatim, so `term` is an
  // object ({id, name, start_at, ...}) — the sidebar was rendering it as
  // "[object Object]". Older context-derived metadata stores a plain string.
  const termNameOf = (metadata) => {
    const t = metadata?.term ?? metadata?.course?.term;
    if (typeof t === 'string') return t;
    return t?.name ?? null;
  };

  const dashRouter = express.Router();
  dashRouter.use(requireSecret(config));

  // GET /api/calendar/subscriptions — the URLs to paste into a calendar app,
  // and the files on disk for anyone who would rather import them.
  dashRouter.get('/calendar/subscriptions', async (req, res) => {
    const calDir = path.join(syncHome(), 'calendar');
    const base = `http://127.0.0.1:${config.bridgePort ?? 3847}/ics/${icsToken}`;
    // Every file icsFilesFor() writes gets a row. A calendar generated on disk
    // and never offered here is one a subscriber cannot reach at all — which
    // is what happened to personal.ics until this list was made to agree with
    // the writer.
    const files = [
      { file: 'canvasync.ics', name: 'Everything' },
      { file: 'deadlines.ics', name: 'Deadlines' },
      { file: 'checkpoints.ics', name: 'Prep blocks' },
      { file: 'classes.ics', name: 'Classes and office hours' },
      { file: 'personal.ics', name: 'Added by you' },
    ];
    const out = await Promise.all(files.map(async (f) => {
      const p = path.join(calDir, f.file);
      let events = null;
      let updated = null;
      try {
        const [body, st] = await Promise.all([fs.readFile(p, 'utf8'), fs.stat(p)]);
        events = (body.match(/BEGIN:VEVENT/g) ?? []).length;
        updated = st.mtime.toISOString();
      } catch { /* not generated yet */ }
      return { ...f, url: `${base}/${f.file}`, path: p, events, updated };
    }));
    res.json({ calendars: out, dir: calDir });
  });

  // How far along indexing is, per class and per category — and whether the
  // local model is working right now. Mounted on dashRouter, AFTER
  // requireSecret: on `app` it would publish the class list and the API-key
  // hint to anything on the box.
  dashRouter.use(indexProgressRouter({ syncHome, pipelineStatus, bridgePid: process.pid }));

  // GET /api/status — bridge + data-root overview
  dashRouter.get('/status', async (req, res) => {
    const home = syncHome();
    let classCount = 0;
    try {
      classCount = (await fs.readdir(path.join(home, 'classes'))).filter(n => CLASS_RE.test(n)).length;
    } catch {}
    res.json({
      ok: true, version: VERSION, home, classCount,
      paired: !!config.extensionId,
      disabled: await fs.access(path.join(home, 'DISABLED')).then(() => true, () => false),
      pipeline: pipelineStatus(),
    });
  });

  // The home cards want a headline, not the whole computation. Keeping the
  // trim here rather than in the browser means the card and the class detail
  // can never disagree about whether a grade is showable.
  function gradeCard(g) {
    return {
      mode: g.scheme.mode, source: g.scheme.source, assumed: g.scheme.assumed,
      current: g.current, floor: g.floor, ceiling: g.ceiling,
      graded: g.graded, counted: g.counted, hidden: g.hidden, missing: g.missing,
      earned: g.totals.earned, possible: g.totals.possible, remaining: g.totals.remaining,
      refusals: g.refusals.map(r => r.reason),
      // Enough of each bucket for the home card to draw the grade's shape —
      // which is the only thing worth showing before anything has been graded.
      buckets: g.buckets.map(b => ({
        name: b.name, weight: b.weight, graded: b.graded, total: b.total,
        pct: b.pct, possible: b.possible, remaining: b.remaining,
      })),
      // What the syllabus says the grade is made of, whether or not it could be
      // used for arithmetic. For a class Canvas holds no assignments for yet —
      // ECON 205 has none at all — this is the only thing there is to show, and
      // it is genuinely what the student wants to know in week one.
      stated: (g.scheme.stated ?? []).map(c => ({ name: c.name, weight: c.weight_pct })),
    };
  }

  // GET /api/classes — list every class with headline info.
  // Each entry carries inScope so the sidebar can default to the classes the
  // extension is actually syncing; the full list stays one toggle away.
  dashRouter.get('/classes', async (req, res) => {
    const classesDir = path.join(syncHome(), 'classes');
    let folders = [];
    try {
      folders = (await fs.readdir(classesDir)).filter(n => CLASS_RE.test(n)).sort();
    } catch {}
    const scope = readSyncScope(syncHome());
    const out = [];
    for (const folder of folders) {
      const dir = path.join(classesDir, folder);
      const [metadata, mined, filesIndex, grades, assignments, groups, syllabusParsed] = await Promise.all([
        readJsonOrNull(path.join(dir, 'metadata.json')),
        readJsonOrNull(path.join(dir, 'assignments_mined.json')),
        readJsonOrNull(path.join(dir, 'files_index.json')),
        readJsonOrNull(path.join(dir, 'grades.json')),
        readJsonOrNull(path.join(dir, 'assignments.json')),
        readJsonOrNull(path.join(dir, 'assignment_groups.json')),
        readJsonOrNull(path.join(dir, 'syllabus_parsed.json')),
      ]);
      let lastBuilt = null;
      try { lastBuilt = (await fs.readFile(path.join(dir, 'AI_CONTEXT', 'last_built.txt'), 'utf8')).trim(); } catch {}
      const enr = Array.isArray(grades) ? grades.find(e => e?.grades) : null;
      out.push({
        folder,
        // The same class has two names in this codebase: the folder
        // (`93903-busi-380-002`) and the id-stripped slug (`busi-380-002`) that
        // calendar ops and worklist rows carry. The browser was re-deriving the
        // strip itself in three places; shipping both here means the client can
        // join a calendar op to a class without owning a copy of the rule.
        slug: folder.replace(/^[0-9]+-/, ''),
        courseId: folder.split('-')[0],
        code: metadata?.course_code ?? metadata?.course?.code ?? null,
        name: metadata?.name ?? metadata?.course?.name ?? folder,
        term: termNameOf(metadata),
        // Through the sanctioned merge (invariant: one merge point) — the
        // card must agree with the detail view, which counts mined items PLUS
        // unclaimed dated Canvas rows, and an un-mined class still has work.
        taskCount: (() => {
          try {
            const { items } = tasksForClass({ mined, assignments });
            return items.length > 0 || mined || assignments ? items.length : null;
          } catch { return Array.isArray(mined?.items) ? mined.items.length : null; }
        })(),
        fileCount: Array.isArray(filesIndex) ? filesIndex.length : 0,
        currentScore: enr?.grades?.current_score ?? null,
        currentGrade: enr?.grades?.current_grade ?? null,
        // Grades are computed on read rather than derived into a file. The
        // arithmetic is a single pass over a few hundred assignments, and
        // deriving it would add a pipeline stage whose only job is to go stale
        // against the mirror it was computed from.
        grade: gradeCard(classGrades({ metadata, assignments, groups, syllabusParsed, enrollments: grades })),
        lastBuilt,
        inScope: isInScope(scope, folder),
      });
    }
    res.json({ classes: out, scope });
  });

  // GET /api/scope — everything the class picker needs: the courses the
  // extension last reported the user is enrolled in, which of them are in the
  // sync scope, and any change already waiting to be applied.
  dashRouter.get('/scope', async (req, res) => {
    const scope = readSyncScope(syncHome());
    const state = await readDashboardState();
    res.json({
      scope,
      enrolled: readEnrolledCourses(syncHome()),
      intent: state.intent ?? null,
    });
  });

  // POST /api/scope — record a selection change made in the app.
  // The extension owns the selection: it lives in chrome.storage, and only the
  // extension can ask Canvas what a course id means. So this does not change
  // the scope, it leaves a note the extension applies at the start of its next
  // sync. Saying so in the UI is part of the contract, not an apology for it.
  //   { courseIds: [...] } → sync exactly these
  //   { courseIds: null }  → clear the saved selection, back to current-term
  dashRouter.post('/scope', async (req, res) => {
    const raw = req.body?.courseIds;
    if (raw !== null && !Array.isArray(raw)) {
      return res.status(400).json({ error: 'courseIds must be an array or null' });
    }
    if (Array.isArray(raw) && raw.length > MAX_SCOPE_IDS) {
      return res.status(400).json({ error: `too many courseIds (max ${MAX_SCOPE_IDS})` });
    }
    const courseIds = raw === null ? null
      : [...new Set(raw.map(id => String(id).trim()).filter(id => /^[0-9]+$/.test(id)))];
    try {
      const state = await readDashboardState();
      state.intent = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        courseIds,
      };
      await writeDashboardState(state);
      res.json({ ok: true, intent: state.intent });
    } catch (err) {
      console.error('[bridge] /api/scope POST error:', err.message);
      res.status(500).json({ error: 'write failed' });
    }
  });

  // GET /api/classes/stale — classes on disk that the extension is no longer
  // syncing, with the disk they are holding. This is the review step: the user
  // sees exactly what would go before anything is deleted.
  dashRouter.get('/classes/stale', async (req, res) => {
    const classesDir = path.join(syncHome(), 'classes');
    const scope = readSyncScope(syncHome());
    // An unknown scope means "everything is current" — never offer to delete
    // a user's whole data folder because we could not read last_sync.json.
    if (!scope.courseIds) return res.json({ scope, stale: [], totalBytes: 0, reason: 'scope-unknown' });
    // An EMPTY allowlist means "sync nothing from now on" — it does NOT mean
    // every class ever synced is abandoned. Left to the rule below, an empty
    // selection put all six classes in this list, pre-checked, under a
    // `Delete 6 classes (1.4 GB)` button: two clicks from wiping the data
    // folder because the user unticked everything in the picker.
    if (scope.courseIds.length === 0) return res.json({ scope, stale: [], totalBytes: 0, reason: 'empty-selection' });

    let folders = [];
    try {
      folders = (await fs.readdir(classesDir)).filter(n => CLASS_RE.test(n)).sort();
    } catch {}
    const stale = [];
    for (const folder of folders) {
      if (isInScope(scope, folder)) continue;
      const metadata = await readJsonOrNull(path.join(classesDir, folder, 'metadata.json'));
      const size = measureClass(folder);
      stale.push({
        folder,
        courseId: folder.split('-')[0],
        code: metadata?.course_code ?? metadata?.course?.code ?? null,
        name: metadata?.name ?? metadata?.course?.name ?? folder,
        term: termNameOf(metadata),
        sizeBytes: size?.bytes ?? 0,
        fileCount: size?.files ?? 0,
      });
    }
    res.json({ scope, stale, totalBytes: stale.reduce((n, c) => n + c.sizeBytes, 0) });
  });

  // POST /api/classes/cleanup — delete the named stale classes.
  // Deliberately narrower than /class/delete: it refuses any folder that is
  // still in scope, and it does NOT add anything to config.untracked. An old
  // class is already excluded by the scope, and untracking it would silently
  // block the class from ever coming back if the user re-selects it.
  dashRouter.post('/classes/cleanup', disabledCheck, async (req, res) => {
    const folders = req.body?.folders;
    if (!Array.isArray(folders) || folders.length === 0) {
      return res.status(400).json({ error: 'folders must be a non-empty array' });
    }
    const scope = readSyncScope(syncHome());
    if (!scope.courseIds) {
      return res.status(409).json({ error: 'sync scope unknown — run a sync before cleaning up' });
    }
    // Same refusal for an empty allowlist: with nothing selected, EVERY class
    // is out of scope, so this route would happily delete the whole data
    // folder. "Sync nothing" is not "discard everything".
    if (scope.courseIds.length === 0) {
      return res.status(409).json({ error: 'your class selection is empty — select the classes you keep before cleaning up' });
    }

    const results = [];
    let freedBytes = 0;
    for (const folder of folders) {
      if (!isValidFolderName(folder)) {
        results.push({ folder, ok: false, error: 'invalid folderName' });
        continue;
      }
      if (isInScope(scope, folder)) {
        results.push({ folder, ok: false, error: 'still in your sync selection' });
        continue;
      }
      try {
        const { sizeBytes, fileCount } = safeDeleteClass(folder);
        freedBytes += sizeBytes;
        results.push({ folder, ok: true, sizeBytes, fileCount });
      } catch (err) {
        results.push({ folder, ok: false, error: err.message });
        continue;
      }
    }
    // Same fire-and-forget calendar cleanup as /class/delete — a removed
    // class must not keep its events in the worklist (or the .ics files
    // rebuilt from it, or dead click-in links in the dashboard calendar).
    if (results.some(r => r.ok)) spawnWorklistRebuild();
    res.json({ ok: results.every(r => r.ok), results, freedBytes });
    logRequest(req, res, null);
  });

  // GET /api/class/:folderName — full data bundle for the detail view
  dashRouter.get('/class/:folderName', async (req, res) => {
    const { folderName } = req.params;
    if (!CLASS_RE.test(folderName)) return res.status(400).json({ error: 'invalid folderName' });
    const dir = path.join(syncHome(), 'classes', folderName);
    try { await fs.access(dir); } catch { return res.status(404).json({ error: 'not found' }); }

    const [metadata, context, minedRaw, filesIndex, grades, tabs, syllabusParsed, assignments, assignmentGroups, coursePacks] = await Promise.all([
      readJsonOrNull(path.join(dir, 'metadata.json')),
      readJsonOrNull(path.join(dir, 'AI_CONTEXT', 'context.json')),
      readJsonOrNull(path.join(dir, 'assignments_mined.json')),
      readJsonOrNull(path.join(dir, 'files_index.json')),
      readJsonOrNull(path.join(dir, 'grades.json')),
      readJsonOrNull(path.join(dir, 'tabs.json')),
      readJsonOrNull(path.join(dir, 'syllabus_parsed.json')),
      readJsonOrNull(path.join(dir, 'assignments.json')),
      readJsonOrNull(path.join(dir, 'assignment_groups.json')),
      readJsonOrNull(path.join(dir, 'course_packs.json')),
    ]);
    // Until mining runs, Canvas is the task list. Serving nothing here was
    // showing "no tasks yet" for classes with dozens of Canvas assignments —
    // the same fallback the calendar has always had.
    const { items: taskItems, source: taskSource } = tasksForClass({ mined: minedRaw, assignments });
    const mined = { ...(minedRaw ?? {}), items: taskItems, source: taskSource };
    const userState = await readUserState(dir);
    // Provenance is derived from the sibling JSON rather than stored, so it
    // backfills classes synced before file-origins.js existed.
    const filesWithSource = await filesWithOrigins(dir, filesIndex ?? []);
    let contextMd = null;
    try { contextMd = await fs.readFile(path.join(dir, 'AI_CONTEXT', 'context.md'), 'utf8'); } catch {}
    let packFiles = [];
    try {
      const packDir = path.join(dir, 'AI_CONTEXT', 'pack');
      packFiles = await Promise.all((await fs.readdir(packDir)).sort().map(async n => ({
        name: n, size: (await fs.stat(path.join(packDir, n))).size,
      })));
    } catch {}
    res.json({
      folder: folderName, metadata, context, context_md: contextMd,
      mined, files_index: filesWithSource, grades: grades ?? [], tabs: tabs ?? [],
      grade_summary: classGrades({
        metadata, assignments, groups: assignmentGroups, syllabusParsed, enrollments: grades,
      }),
      syllabus_parsed_at: syllabusParsed?.extracted_at ?? null,
      syllabus_parsed: syllabusParsed,
      user_state: userState.items,
      // LTI course packs the extension recognised (extension ≥ 1.3.0). The
      // content lives on the provider's site; these carry the launch links.
      course_packs: coursePacks ?? [],
      pack_files: packFiles,
      pack_dir: path.join(dir, 'AI_CONTEXT', 'pack'),
      class_dir: dir,
    });
  });

  // GET /api/class/:folderName/assignment/:assignmentId — one assignment, read
  // locally. Canvas stays one click away rather than being the only way in, and
  // the Canvas links we hand back go through canvasItemUrl so quiz-backed work
  // points at the page a student is actually allowed to open.
  dashRouter.get('/class/:folderName/assignment/:assignmentId', async (req, res) => {
    const { folderName, assignmentId } = req.params;
    if (!CLASS_RE.test(folderName)) return res.status(400).json({ error: 'invalid folderName' });
    // 200, matching the ceiling user-state.js already accepts for a task id.
    // At 64 this route rejected ids the miner really writes — BUSI 380 has
    // two at 65 and 66 chars — so their calendar rows were dead links while
    // the tick checkbox on the SAME row worked, and the class page opened
    // them fine by Canvas id. One id space, one bound.
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(assignmentId)) {
      return res.status(400).json({ error: 'invalid assignmentId' });
    }
    const dir = path.join(syncHome(), 'classes', folderName);
    try { await fs.access(dir); } catch { return res.status(404).json({ error: 'not found' }); }

    const [assignments, quizzes, filesIndex, metadata, mined] = await Promise.all([
      readJsonOrNull(path.join(dir, 'assignments.json')),
      readJsonOrNull(path.join(dir, 'quizzes.json')),
      readJsonOrNull(path.join(dir, 'files_index.json')),
      readJsonOrNull(path.join(dir, 'metadata.json')),
      readJsonOrNull(path.join(dir, 'assignments_mined.json')),
    ]);

    const wanted = String(assignmentId).replace(/^canvas-/, '');
    // Mined-only work (found in slides, never a Canvas object) has no Canvas
    // row; serve what the miner knows rather than 404ing on the user.
    const minedItem = (mined?.items || []).find(
      x => String(x?.id) === assignmentId || String(x?.canvas_assignment_id ?? '') === wanted) || null;
    // The merge is the identity everything else writes under. A mined item
    // the merge DECLINES (an aggregate whose claimed row is dated, a
    // recurring item that would swallow one) keeps living in the raw file,
    // and keying user state off it returned {} for work the user had already
    // ticked — the panel showed it outstanding. Ask the merge who this is.
    const mergedItems = tasksForClass({ mined, assignments }).items;
    const mergedSelf = mergedItems.find(x => String(x?.id) === assignmentId)
      || (minedItem && mergedItems.find(x => String(x?.id) === String(minedItem.id)))
      || mergedItems.find(x => String(x?.canvas_assignment_id ?? '') === wanted)
      || null;
    // Asked by mined id, answered with the Canvas row it claims: the calendar
    // opens items by item_id, and a merged item's Canvas links were invisible
    // from there until the claim was followed. The claim is followed through
    // tasksForClass — the SAME resolution the task list and worklist use
    // (covers arrays, and the by-title rescue for deleted-and-recreated
    // rows) — or this panel disagrees with them about whether a live Canvas
    // row stands behind the item.
    let a = (assignments || []).find(x => String(x?.id) === wanted) || null;
    if (!a && mergedSelf?.canvas_assignment_id != null) {
      a = (assignments || []).find(x => String(x?.id) === String(mergedSelf.canvas_assignment_id)) || null;
    }
    if (!a && !minedItem) return res.status(404).json({ error: 'assignment not found' });

    const quiz = a?.quiz_id ? (quizzes || []).find(q => String(q?.id) === String(a.quiz_id)) || null : null;
    const userState = await readUserState(dir);
    // The merge's id, because that is the key the task list and the calendar
    // tick under. Falling back to the raw mined id keyed state nothing else
    // writes, so a ticked item opened as untouched.
    const stateKey = mergedSelf?.id ?? minedItem?.id ?? `canvas-${wanted}`;

    // Files that came from THIS assignment, via the same provenance derivation
    // the Files tab uses. Origins carry CANVAS ids, so match on the resolved
    // row's id — the calendar asks by MINED id, and comparing origins against
    // that slug returned [] for exactly the panel's standard path.
    let related = [];
    try {
      const withOrigins = await filesWithOrigins(dir, filesIndex ?? []);
      const canvasId = a?.id != null ? String(a.id) : wanted;
      const quizId = a?.quiz_id != null ? String(a.quiz_id) : null;
      related = withOrigins
        .filter(f => (f.origins || []).some(o =>
          (o.kind === 'assignment' && o.itemId === canvasId)
          || (o.kind === 'quiz' && quizId && o.itemId === quizId)))
        .map(f => ({ name: f.displayName, localPath: f.localPath, size: f.size }));
    } catch { /* provenance is a nicety here, not a requirement */ }

    res.json({
      folder: folderName,
      course_code: metadata?.course_code ?? null,
      id: stateKey,
      canvas_id: a?.id ?? null,
      name: a?.name ?? minedItem?.title ?? 'Untitled',
      due_at: a?.due_at ?? null,
      points_possible: a?.points_possible ?? minedItem?.points_possible ?? null,
      submission_types: a?.submission_types ?? [],
      is_quiz: Boolean(a?.quiz_id),
      quiz: quiz ? { id: quiz.id, question_count: quiz.question_count ?? null, time_limit: quiz.time_limit ?? null } : null,
      locked_for_user: a?.locked_for_user ?? false,
      lock_explanation: a?.lock_explanation ?? null,
      description_html: a?.description ?? null,
      mined: minedItem,
      // 'canvas' when a live Canvas row stands behind this; 'syllabus' when
      // the AI mined it and there is nothing on Canvas to open or submit.
      origin: a ? 'canvas' : 'syllabus',
      url: a ? canvasItemUrl(a) : null,
      submit_url: a ? canvasSubmitUrl(a) : null,
      raw_url: a?.html_url ?? null,
      related_files: related,
      user_state: userState.items?.[stateKey] ?? {},
    });
  });

  // GET/POST/DELETE /api/class/:folderName/meetings — when this class meets.
  //
  // GET reports the recovery chain's answer and where it came from, so the UI
  // can distinguish "the syllabus says 10:50" from "nobody knows, type it in".
  // POST stores the user's own answer, which outranks every other source.
  // POST …/meetings/revert swaps back to whatever the last save or clear
  // replaced — the escape hatch for a time typed wrong or changed by accident.
  //
  // Every response carries `revert`: whether an undo exists and what it lands
  // on, so the UI can offer it without a second request.
  async function meetingRevertInfo(dir) {
    const stash = await readMeetingRevert(dir).catch(() => null);
    if (!stash) return { available: false };
    return {
      available: true,
      action: stash.action,
      replaced_at: stash.replacedAt,
      label: describeRevertTarget(stash),
    };
  }

  dashRouter.get('/class/:folderName/meetings', async (req, res) => {
    const { folderName } = req.params;
    if (!CLASS_RE.test(folderName)) return res.status(400).json({ error: 'invalid folderName' });
    const dir = path.join(syncHome(), 'classes', folderName);
    try { await fs.access(dir); } catch { return res.status(404).json({ error: 'not found' }); }
    const times = await recoverMeetingTimes(dir);
    res.json({ ...times, summary: describeMeetingSource(times), revert: await meetingRevertInfo(dir) });
  });

  dashRouter.post('/class/:folderName/meetings', disabledCheck, async (req, res) => {
    const { folderName } = req.params;
    if (!CLASS_RE.test(folderName)) return res.status(400).json({ error: 'invalid folderName' });
    const dir = path.join(syncHome(), 'classes', folderName);
    try { await fs.access(dir); } catch { return res.status(404).json({ error: 'not found' }); }
    try {
      await writeMeetingOverride(dir, req.body ?? {});
    } catch (err) {
      // A TypeError here is the user's input, not a server fault — say what was
      // wrong with it rather than returning a bare 500.
      return res.status(400).json({ error: err.message.replace(/^writeMeetingOverride: /, '') });
    }
    const times = await recoverMeetingTimes(dir);
    // The times only reach the calendar through the worklist, so rebuild it
    // here rather than making the client fake a plan change to trigger one.
    const rebuild_started = spawnWorklistRebuild();
    res.json({ ok: true, ...times, summary: describeMeetingSource(times), revert: await meetingRevertInfo(dir), rebuild_started });
  });

  dashRouter.post('/class/:folderName/meetings/revert', disabledCheck, async (req, res) => {
    const { folderName } = req.params;
    if (!CLASS_RE.test(folderName)) return res.status(400).json({ error: 'invalid folderName' });
    const dir = path.join(syncHome(), 'classes', folderName);
    try { await fs.access(dir); } catch { return res.status(404).json({ error: 'not found' }); }
    const reverted = await revertMeetingOverride(dir);
    // Nothing stashed is a state the UI should never offer a button for, so
    // reaching here means the two disagree — refresh, don't pretend.
    if (!reverted) return res.status(409).json({ error: 'nothing to revert' });
    const times = await recoverMeetingTimes(dir);
    const rebuild_started = spawnWorklistRebuild();
    res.json({ ok: true, ...times, summary: describeMeetingSource(times), revert: await meetingRevertInfo(dir), rebuild_started });
  });

  dashRouter.delete('/class/:folderName/meetings', disabledCheck, async (req, res) => {
    const { folderName } = req.params;
    if (!CLASS_RE.test(folderName)) return res.status(400).json({ error: 'invalid folderName' });
    const dir = path.join(syncHome(), 'classes', folderName);
    try { await fs.access(dir); } catch { return res.status(404).json({ error: 'not found' }); }
    const removed = await clearMeetingOverride(dir);
    const times = await recoverMeetingTimes(dir);
    const rebuild_started = spawnWorklistRebuild();
    res.json({ ok: true, removed, ...times, summary: describeMeetingSource(times), revert: await meetingRevertInfo(dir), rebuild_started });
  });

  // --- Ask: question answering over one class, routed by the correlation graph
  //
  // The model is the last step, not the first. Everything dated — when the
  // class meets, when the next exam is — is computed from the class data and
  // handed to the model as fact, and the documents it may quote from are chosen
  // by the graph before the prompt is built. A model left to find a meeting time
  // by reading a syllabus will eventually invent one.
  //
  // Serialised deliberately: one question at a time per bridge, and refused
  // outright while a sync job holds the machine-wide model lock. Queueing
  // instead would sit inside localInvoke's 45-minute wait, which is
  // indistinguishable from a hang to whoever is watching the spinner.
  let askInFlight = null;
  let chatModule = null;
  async function loadChat() {
    if (chatModule) return chatModule;
    chatModule = await import('../scripts/class-chat.js');
    return chatModule;
  }

  dashRouter.get('/ask/status', async (req, res) => {
    const lock = await modelLockStatus();
    res.json({
      busy: !!askInFlight,
      asking: askInFlight ? { folder: askInFlight.folder, since: askInFlight.since } : null,
      model_lock: { held: lock.held && lock.alive, heldForMs: lock.heldForMs },
      available: !askInFlight && !(lock.held && lock.alive),
    });
  });

  dashRouter.post('/ask', async (req, res) => {
    const question = String(req.body?.question ?? '').trim();
    if (!question) return res.status(400).json({ error: 'question required' });
    if (question.length > 2000) return res.status(400).json({ error: 'question too long (2000 characters max)' });

    if (askInFlight) {
      return res.status(409).json({ error: 'busy', since: askInFlight.since, folder: askInFlight.folder });
    }
    // CLAIM THE SLOT NOW, not after the awaits below. The check above used to
    // stand alone while class resolution, a dynamic import and a lock read ran
    // in between — two asks arriving in that window both passed, and the
    // second one sat inside localInvoke's 45-minute lock wait, which is the
    // hang this 409 exists to prevent. Cleared on every exit path.
    askInFlight = { folder: null, since: new Date().toISOString() };
    try {
      return await runAsk(req, res);
    } finally {
      askInFlight = null;
    }
  });

  async function runAsk(req, res) {
    const question = String(req.body?.question ?? '').trim();
    let chat;
    try {
      chat = await loadChat();
    } catch (err) {
      return res.status(503).json({ error: 'chat unavailable', detail: err.message });
    }

    const home = syncHome();
    let folder = req.body?.folderName ? String(req.body.folderName) : null;
    if (folder && !CLASS_RE.test(folder)) return res.status(400).json({ error: 'invalid folderName' });

    // No class named: let the resolver read the question. An unsure resolver
    // asks rather than guessing — answering confidently about the wrong class
    // is the worst outcome available here.
    if (!folder) {
      try {
        const picked = await chat.resolveClass(home, question);
        if (!picked || picked.ambiguous || !picked.slug) {
          return res.json({ ambiguous: true, question, candidates: picked?.candidates ?? [] });
        }
        folder = picked.slug;
      } catch (err) {
        return res.status(500).json({ error: 'class resolution failed', detail: err.message });
      }
    }

    const classDir = path.join(home, 'classes', folder);
    try { await fs.access(classDir); } catch { return res.status(404).json({ error: 'class not found', folder }); }

    const lock = await modelLockStatus();
    if (lock.held && lock.alive) {
      return res.status(503).json({
        error: 'model busy',
        detail: 'A sync job is using the local model. Ask again when it finishes.',
        heldForMs: lock.heldForMs,
      });
    }

    // The slot is already held by the caller; name the class now that it is
    // known, so /ask/status can say what is running.
    askInFlight = { ...askInFlight, folder };
    try {
      const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [];
      const result = await chat.answerQuestion({ classDir, question, history });
      res.json({ ok: true, folder, ...result });
      logRequest(req, res, null);
    } catch (err) {
      console.error('[bridge] /api/ask error:', err.message);
      res.status(500).json({ error: 'ask failed', detail: err.message, folder });
    }
  }

  // POST /api/class/:folderName/task/:taskId — the user's own marks on a task:
  // done, a note, a flag, a moved date, checkpoints. Kept out of
  // assignments_mined.json, which the pipeline rewrites wholesale.
  // A partial patch, so the UI can send {done:true} without echoing the note.
  dashRouter.post('/class/:folderName/task/:taskId', disabledCheck, async (req, res) => {
    const { folderName, taskId } = req.params;
    if (!CLASS_RE.test(folderName)) return res.status(400).json({ error: 'invalid folderName' });
    const dir = path.join(syncHome(), 'classes', folderName);
    try { await fs.access(dir); } catch { return res.status(404).json({ error: 'not found' }); }
    try {
      const item = await patchTask(dir, taskId, req.body ?? {});
      scheduleWorklistRebuild();
      res.json({ ok: true, item });
    } catch (err) {
      if (err instanceof UserStateError) return res.status(400).json({ error: err.message });
      console.error('[bridge] task patch error:', err.message);
      res.status(500).json({ error: 'write failed' });
    }
  });

  // GET /api/class/:folderName/file?p=<relpath> — serve one class file.
  // Restricted to files/, materials/, AI_CONTEXT/ and traversal-guarded.
  dashRouter.get('/class/:folderName/file', async (req, res) => {
    const { folderName } = req.params;
    const rel = String(req.query.p ?? '');
    if (!CLASS_RE.test(folderName) || !rel) return res.status(400).json({ error: 'bad request' });
    const dir = path.join(syncHome(), 'classes', folderName);
    const abs = path.resolve(dir, rel);
    const root = rel.split(/[\\/]/)[0];
    if (!abs.startsWith(dir + path.sep) || !SERVABLE_ROOTS.has(root)) {
      return res.status(403).json({ error: 'forbidden path' });
    }
    try {
      const data = await fs.readFile(abs);
      res.setHeader('Content-Type', MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(abs).replace(/"/g, '')}"`);
      res.send(data);
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  });

  // GET /api/calendar — worklist + routine doc
  dashRouter.get('/calendar', async (req, res) => {
    const calDir = path.join(syncHome(), 'calendar');
    const [worklist, custom] = await Promise.all([
      readJsonOrNull(path.join(calDir, 'worklist.json')),
      readCustomItems(calDir),
    ]);
    // The user's own items ride along with the worklist rather than needing a
    // request of their own: the calendar cannot draw an editor for an item it
    // has only seen as an op (an op's title carries the class prefix and its
    // description carries our own footer), and a second fetch could answer
    // from a different moment than the worklist it is annotating.
    res.json({ worklist, custom_items: custom.items, calendar_dir: calDir });
  });

  // --- Items the user adds by hand -----------------------------------------
  //
  // The one kind of calendar entry no pipeline stage can regenerate, so it
  // lives in its own file (calendar/custom_items.json) that nothing but these
  // routes writes. Every mutation schedules a worklist rebuild, because the
  // worklist is what the grid and the .ics files are drawn from — but each
  // response also carries the op the item became, so the client can paint the
  // change immediately instead of waiting on the debounce.
  // CALENDAR-SPEC §8.
  const calendarDir = () => path.join(syncHome(), 'calendar');

  // The course code a class-attached item wears, resolved the same way the
  // worklist resolves it, so an item's title reads identically in both.
  async function customCodeFor() {
    const classesDir = path.join(syncHome(), 'classes');
    const map = new Map();
    let folders = [];
    try {
      folders = (await fs.readdir(classesDir)).filter(n => CLASS_RE.test(n));
    } catch { /* no classes yet — personal items still work */ }
    await Promise.all(folders.map(async (folder) => {
      const metadata = await readJsonOrNull(path.join(classesDir, folder, 'metadata.json'));
      const code = metadata?.course_code ?? metadata?.course?.code ?? null;
      if (code) map.set(folder.replace(/^[0-9]+-/, ''), shortCourseCode(code));
    }));
    return slug => map.get(slug) ?? null;
  }

  const customItemError = (res, err) => {
    if (err instanceof CustomItemError) return res.status(400).json({ error: err.message });
    console.error('[bridge] custom item error:', err.message);
    return res.status(500).json({ error: 'write failed' });
  };

  dashRouter.get('/calendar/items', async (req, res) => {
    const { items } = await readCustomItems(calendarDir());
    res.json({ items });
  });

  dashRouter.post('/calendar/items', disabledCheck, async (req, res) => {
    try {
      const item = await createCustomItem(calendarDir(), req.body ?? {});
      const codeFor = await customCodeFor();
      scheduleWorklistRebuild();
      res.json({ ok: true, item, op: customItemOp(item, { codeFor }), rebuild_scheduled: true });
    } catch (err) {
      customItemError(res, err);
    }
  });

  dashRouter.patch('/calendar/items/:id', disabledCheck, async (req, res) => {
    const { id } = req.params;
    if (!CUSTOM_ID_RE.test(id)) return res.status(400).json({ error: 'invalid item id' });
    try {
      const item = await patchCustomItem(calendarDir(), id, req.body ?? {});
      if (!item) return res.status(404).json({ error: 'not found' });
      const codeFor = await customCodeFor();
      scheduleWorklistRebuild();
      res.json({ ok: true, item, op: customItemOp(item, { codeFor }), rebuild_scheduled: true });
    } catch (err) {
      customItemError(res, err);
    }
  });

  dashRouter.delete('/calendar/items/:id', disabledCheck, async (req, res) => {
    const { id } = req.params;
    if (!CUSTOM_ID_RE.test(id)) return res.status(400).json({ error: 'invalid item id' });
    try {
      const removed = await deleteCustomItem(calendarDir(), id);
      if (!removed) return res.status(404).json({ error: 'not found' });
      scheduleWorklistRebuild();
      res.json({ ok: true, removed: true, rebuild_scheduled: true });
    } catch (err) {
      customItemError(res, err);
    }
  });

  // GET /api/calendar/classes — every class in scope, with the meeting times
  // the recovery chain could find for it. This used to also carry a per-class
  // population plan; nothing is switched off any more, so what is left is the
  // one control that is genuinely per class — the meeting-time override, which
  // is the only way to fix a syllabus that never states when its class meets.
  dashRouter.get('/calendar/classes', async (req, res) => {
    const classesDir = path.join(syncHome(), 'classes');
    const scope = readSyncScope(syncHome());
    let folders = [];
    try {
      folders = (await fs.readdir(classesDir)).filter(n => CLASS_RE.test(n));
    } catch { /* no classes yet */ }
    if (scope.courseIds) folders = folders.filter(f => isInScope(scope, f));

    const classes = await Promise.all(folders.map(async (folder) => {
      const dir = path.join(classesDir, folder);
      const slug = folder.replace(/^[0-9]+-/, '');
      const [metadata, syllabus, events] = await Promise.all([
        readJsonOrNull(path.join(dir, 'metadata.json')),
        readJsonOrNull(path.join(dir, 'syllabus_parsed.json')),
        readJsonOrNull(path.join(dir, 'calendar_events.json')),
      ]);
      // Ask the meeting builder itself rather than re-implementing its filter
      // here; the two drifted apart once already and the toggle enabled for
      // classes that then produced no events. The recovery chain runs first so
      // the toggle reflects an override the user typed, not just the syllabus.
      const times = await recoverMeetingTimes(dir).catch(() => null);
      const scheduled = countMeetings({
        syllabusParsed: syllabus,
        canvasEvents: events,
        patterns: times?.patterns ?? null,
      });
      const hasTime = (times?.patterns ?? []).some(p => p.start);
      return {
        folder, slug,
        name: metadata?.name ?? slug,
        course_code: metadata?.course_code ?? null,
        meetings_available: scheduled > 0 || (Array.isArray(events) && events.length > 0),
        scheduled_days: scheduled,
        // Everything the meeting-time editor needs, so it can say *why* a class
        // has no times instead of only that it has none.
        meeting_times: {
          source: times?.source ?? 'none',
          confidence: times?.confidence ?? 'low',
          has_time: hasTime,
          patterns: times?.patterns ?? [],
          summary: times ? describeMeetingSource(times) : null,
          warnings: times?.warnings ?? [],
          revert: await meetingRevertInfo(dir),
        },
      };
    }));
    classes.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ kinds: CAL_KINDS, labels: CAL_KIND_LABELS, classes, rebuild: calRebuild });
  });

  // POST /api/calendar/rebuild — regenerate the worklist from disk.
  dashRouter.post('/calendar/rebuild', disabledCheck, (req, res) => {
    const started = spawnWorklistRebuild();
    res.json({ ok: true, started, rebuild: calRebuild });
  });

  // GET /api/logs — tail of the pipeline log
  dashRouter.get('/logs', async (req, res) => {
    const n = Math.min(1000, Math.max(1, parseInt(req.query.lines ?? '200', 10) || 200));
    try {
      const raw = await fs.readFile(path.join(syncHome(), 'logs', 'trigger.log'), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      res.json({ lines: lines.slice(-n) });
    } catch {
      res.json({ lines: [] });
    }
  });

  // GET/POST /api/settings — pipeline env overrides, stored in
  // <home>/settings.json under { env: { CSYNC_*: value } }. trigger.js merges
  // these into every spawned job's environment, so changes take effect on the
  // next pipeline pass without restarting anything.
  // --- Local model setup -----------------------------------------------------
  // "One-click download" from the dashboard: the same shell script a user could
  // run themselves, spawned detached with its output tailing into a log the UI
  // can poll. Deliberately NOT run in-process — it downloads tens of gigabytes
  // and must survive the request, the page, and a bridge restart.
  //
  // It never loads the model, so it cannot collide with a job holding the
  // machine-wide model lock.
  const SETUP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'setup-local-model.sh');
  const setupLogPath = () => path.join(syncHome(), 'logs', 'local-model-setup.log');
  let modelSetup = { running: false, at: null, tier: null, ok: null };

  dashRouter.get('/local-model', async (req, res) => {
    const tier = req.query.tier === 'light' ? 'light' : 'standard';
    const child = spawn('bash', [SETUP_SCRIPT, '--check', '--tier', tier], {
      cwd: REPO_ROOT, env: { ...process.env },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', err => {
      res.status(500).json({ error: 'could not run the setup script', detail: err.message });
    });
    child.on('close', () => {
      if (res.headersSent) return;
      // The script prints "  key: value" lines; parse them so the UI can render
      // fields rather than a wall of terminal output.
      const report = {};
      for (const line of out.split('\n')) {
        // Hyphens are part of a key here ("mlx-lm"), so a [a-z ] class silently
        // drops the one line that says whether the runtime is installed at all.
        const m = /^\s{2}([a-z][a-z -]*):\s+(.*)$/.exec(line);
        if (m) report[m[1].trim().replace(/[ -]/g, '_')] = m[2].trim();
      }
      res.json({ tier, report, raw: out.trim(), setup: modelSetup });
    });
  });

  dashRouter.post('/local-model/setup', disabledCheck, async (req, res) => {
    if (modelSetup.running) return res.status(409).json({ error: 'setup already running', ...modelSetup });
    const tier = req.body?.tier === 'light' ? 'light' : 'standard';
    try {
      await fs.mkdir(path.join(syncHome(), 'logs'), { recursive: true });
      const fh = await fs.open(setupLogPath(), 'w');
      const child = spawn('bash', [SETUP_SCRIPT, '--tier', tier], {
        cwd: REPO_ROOT, env: { ...process.env },
        stdio: ['ignore', fh.fd, fh.fd],
        detached: false,
      });
      modelSetup = { running: true, at: new Date().toISOString(), tier, ok: null };
      child.on('error', (err) => {
        console.error('[bridge] local model setup failed to spawn:', err.message);
        modelSetup = { ...modelSetup, running: false, ok: false };
        fh.close().catch(() => {});
      });
      child.on('exit', (code) => {
        modelSetup = { ...modelSetup, running: false, ok: code === 0 };
        fh.close().catch(() => {});
      });
      res.json({ ok: true, ...modelSetup });
    } catch (err) {
      console.error('[bridge] local model setup error:', err.message);
      res.status(500).json({ error: 'could not start setup', detail: err.message });
    }
  });

  dashRouter.get('/local-model/setup/log', async (req, res) => {
    const n = Math.min(500, Math.max(1, parseInt(req.query.lines ?? '80', 10) || 80));
    try {
      const raw = await fs.readFile(setupLogPath(), 'utf8');
      res.json({ ...modelSetup, lines: raw.split('\n').filter(Boolean).slice(-n) });
    } catch {
      res.json({ ...modelSetup, lines: [] });
    }
  });

  // --- Class colours ---------------------------------------------------------
  // Defaults are generic and positional; every one of them is overridable. The
  // store lives beside the data rather than in the browser so the dashboard,
  // the Electron shell and anything reading the data root all draw a class the
  // same colour.
  const colorsPath = () => path.join(syncHome(), COLORS_FILE);

  const listClassSlugs = async () => {
    try {
      return (await fs.readdir(path.join(syncHome(), 'classes')))
        .filter(n => CLASS_RE.test(n))
        .map(n => n.replace(/^[0-9]+-/, ''));
    } catch { return []; }
  };

  // "personal" is where an item with no class goes (custom-items.js). It is
  // deliberately NOT one of the slugs the palette rotates over: resolveColors
  // assigns defaults by sorted position, so slipping a pseudo-class into that
  // list would silently repaint every real class after it in the alphabet.
  // It still gets to hold an override, so the chip's colour picker works on it
  // like any other; with none stored the client draws its own quiet default.
  const PERSONAL_SLUG = 'personal';
  const withPersonal = (colors, stored) => (
    stored?.[PERSONAL_SLUG] ? { ...colors, [PERSONAL_SLUG]: stored[PERSONAL_SLUG] } : colors
  );

  dashRouter.get('/class-colors', async (req, res) => {
    const stored = (await readJsonOrNull(colorsPath())) ?? {};
    const slugs = await listClassSlugs();
    res.json({
      colors: withPersonal(resolveColors(slugs, stored), stored),
      overrides: stored,
      palette: DEFAULT_PALETTE,
    });
  });

  dashRouter.post('/class-colors', async (req, res) => {
    const patch = req.body?.colors;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'body must be { colors: { slug: "#rrggbb" | null } }' });
    }
    const stored = (await readJsonOrNull(colorsPath())) ?? {};
    const { overrides, rejected } = applyColorPatch(stored, patch);
    const tmp = colorsPath() + '.tmp.' + process.pid;
    try {
      await fs.writeFile(tmp, JSON.stringify(overrides, null, 2));
      await fs.rename(tmp, colorsPath());
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      console.error('[bridge] /api/class-colors write failed:', err.message);
      return res.status(500).json({ error: 'could not save colours' });
    }
    const slugs = await listClassSlugs();
    res.json({
      ok: true,
      colors: withPersonal(resolveColors(slugs, overrides), overrides),
      overrides, palette: DEFAULT_PALETTE, rejected,
    });
  });

  // --- Anthropic API key -----------------------------------------------------
  // The `claude` CLI signs in with an OAuth session that expires. When it does,
  // every AI stage silently falls back to the 20 GB local model — correct, but
  // minutes per job instead of seconds — and the only visible symptom is that
  // syncing got slow. A key stored here restores the fast path without a
  // terminal login.
  //
  // The key itself is write-only over HTTP: it is never echoed back, only its
  // presence, its origin, and a masked hint.
  dashRouter.get('/ai-key', async (req, res) => {
    res.json(await anthropicKeyStatus());
  });

  dashRouter.post('/ai-key', async (req, res) => {
    const key = String(req.body?.key ?? '').trim();
    if (!key) return res.status(400).json({ error: 'key required' });
    // Shape check only — the real test is whether a call succeeds, and this
    // catches the common paste error (a URL, a whole shell line, the wrong
    // secret) before it silently breaks every AI stage.
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
      return res.status(400).json({ error: 'that does not look like an Anthropic API key (expected sk-ant-…)' });
    }
    try {
      const fresh = await loadConfig();
      fresh.anthropicApiKey = key;
      await saveConfig(fresh);
      config.anthropicApiKey = key;
    } catch (err) {
      console.error('[bridge] /api/ai-key save failed:', err.message);
      return res.status(500).json({ error: 'could not save the key' });
    }
    res.json({ ok: true, ...(await anthropicKeyStatus()) });
  });

  dashRouter.delete('/ai-key', async (req, res) => {
    try {
      const fresh = await loadConfig();
      const had = typeof fresh.anthropicApiKey === 'string' && fresh.anthropicApiKey.length > 0;
      delete fresh.anthropicApiKey;
      await saveConfig(fresh);
      delete config.anthropicApiKey;
      res.json({ ok: true, removed: had, ...(await anthropicKeyStatus()) });
    } catch (err) {
      console.error('[bridge] /api/ai-key delete failed:', err.message);
      res.status(500).json({ error: 'could not remove the key' });
    }
  });

  dashRouter.get('/settings', async (req, res) => {
    const s = await readJsonOrNull(path.join(syncHome(), 'settings.json'));
    res.json({ settings: s ?? { env: {} } });
  });

  dashRouter.post('/settings', async (req, res) => {
    const incoming = req.body?.env;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'body must be { env: {...} }' });
    }
    // MERGE over what's stored, don't replace: the dashboard form only posts
    // its own fields, and a replace would silently wipe any other CSYNC_*
    // override the user set out-of-band (CSYNC_MAX_JOBS, CSYNC_SOFFICE, …).
    // Sending an explicit empty string/null deletes that one key.
    const settingsPath = path.join(syncHome(), 'settings.json');
    const stored = await readJsonOrNull(settingsPath);
    const env = { ...(stored?.env && typeof stored.env === 'object' ? stored.env : {}) };
    for (const [k, v] of Object.entries(incoming)) {
      if (!/^CSYNC_[A-Z0-9_]+$/.test(k)) continue;      // only our namespace
      if (v === null || v === '' || v === undefined) { delete env[k]; continue; }
      env[k] = String(v).slice(0, 500);
    }
    const tmp = settingsPath + '.tmp.' + process.pid;
    await fs.writeFile(tmp, JSON.stringify({ env }, null, 2), { mode: 0o600 });
    await fs.rename(tmp, settingsPath);
    res.json({ ok: true, settings: { env } });
  });

  // POST /api/pipeline/run — re-run the local pipeline (parse/extract/mine/
  // context/calendar) over what's already on disk. Does NOT scrape Canvas —
  // that's the extension's job.
  dashRouter.post('/pipeline/run', disabledCheck, (req, res) => {
    const st = pipelineStatus();
    if (st.running) {
      return res.status(409).json({ error: 'pipeline already running', pipeline: st });
    }
    runIfNeeded();
    res.json({ ok: true, started: true });
  });

  // POST /api/pipeline/cancel — stop a running pipeline pass: live jobs get
  // SIGTERM (stage scripts forward it to their python/soffice children),
  // queued jobs are skipped.
  dashRouter.post('/pipeline/cancel', async (req, res) => {
    res.json({ ok: true, ...(await cancelPipeline()) });
  });

  // POST /api/pair-token — (re)generate an install token so an extension can
  // pair. Used by the desktop app's setup flow (incl. friends' first run).
  // If already paired, `force: true` unpairs first (the old extension stops
  // being accepted at the Origin check).
  dashRouter.post('/pair-token', async (req, res) => {
    try {
      if (config.extensionId && !req.body?.force) {
        return res.status(409).json({ error: 'already paired', paired: true });
      }
      if (config.extensionId && req.body?.force) {
        const fresh = await loadConfig();
        delete fresh.extensionId;
        await saveConfig(fresh);
        delete config.extensionId;
      }
      const token = crypto.randomBytes(16).toString('hex');
      const tokenPath = path.join(syncHome(), 'install-token.txt');
      await fs.writeFile(tokenPath, token + '\n', { mode: 0o600 });
      res.json({ ok: true, token, expiresInSec: 600 });
    } catch (err) {
      console.error('[bridge] /api/pair-token error:', err.message);
      res.status(500).json({ error: 'token generation failed' });
    }
  });

  app.use('/api', dashRouter);

  // Terminal error handler. Without one, Express's default handler renders the
  // stack trace into the response — and because express.json() runs before any
  // auth, a malformed body leaked absolute paths, the OS username and the
  // node_modules layout to an UNAUTHENTICATED caller. Log the detail, return a
  // shape-stable JSON error. Must stay last and keep all four arguments, which
  // is how Express recognises an error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    const detail = status === 400 ? 'malformed request body'
      : status === 413 ? 'request body too large'
      : 'internal error';
    console.error(`[bridge] ${req.method} ${req.path} → ${status}:`, err.message);
    if (res.headersSent) return next(err);
    res.status(status).json({ error: detail });
  });

  return app;
}

// --- Entrypoint (only runs when executed directly, not when imported by tests) ---
async function main() {
  assertLoopbackEnv();
  const config = await loadConfigOrExit();
  const port = parseInt(process.env.BRIDGE_PORT ?? '3847', 10);
  const app = buildApp(config);

  const server = app.listen(port, BIND_ADDR, () => {
    const addr = server.address();
    if (addr.address !== BIND_ADDR) {
      console.error(`[bridge] Security error: bound to ${addr.address}, expected ${BIND_ADDR}. Exiting.`);
      server.close(() => process.exit(1));
      return;
    }
    console.log(`[bridge] Listening on ${addr.address}:${addr.port} v${VERSION}`);
  });

  function shutdown(signal) {
    console.log(`[bridge] Received ${signal}, shutting down.`);
    server.close(() => process.exit(0));
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

// ES module equivalent of `if (require.main === module)`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
