// background.js — Service worker (ES module). Entry point for all background logic.
// No DOM access. Runs in the extension's isolated service-worker context.

import { paginate, fetchBinary, canvasGetJson, canvasFetch, CANVAS_BASE, AuthError, RateLimitError, NetworkError, ServerError, PermissionError } from './canvas-client.js';
import {
  bridgePost,
  bridgeHealth,
  handshake,
  getUntracked,
  removeUntracked,
  deleteClass,
  ingestCourseFile,
  getFilesIndex,
  publishScope,
  fetchSelectionIntent,
  ackSelectionIntent,
  ConfigError,
  BridgeServerError,
} from './bridge-client.js';

// ---------------------------------------------------------------------------
// Slug alignment — MUST match bridge/storage.js slugifyCourseCode
// ---------------------------------------------------------------------------

// MUST match bridge/storage.js slugifyCourseCode. If you change this, update
// both files in lockstep — the filter in fullSync relies on the extension
// computing the exact folder name the bridge writes to disk.
function slugifyCourseCode(code) {
  if (!code || typeof code !== 'string') return null;
  return code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function folderNameFor(course) {
  // Mirrors bridge/storage.js writeCourse: fallback slug is `course-<id>`.
  const slug = slugifyCourseCode(course?.course_code) || `course-${course?.id}`;
  return `${course?.id}-${slug}`;
}

// ---------------------------------------------------------------------------
// Term helpers — MUST mirror courses.js normalizedTermLabel so the default
// selection here matches what the Manage Courses page labels "current term".
// ---------------------------------------------------------------------------

function _normalizedTermLabel(rawName) {
  if (!rawName || typeof rawName !== 'string') return 'No term';
  const m = rawName.match(/^(Spring|Fall|Summer|Winter)\s+(?:Semester\s+)?(\d{4})/i);
  if (m) {
    const season = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return `${season} ${m[2]}`;
  }
  return rawName;
}

// Returns the course IDs belonging to the current term: the term whose date
// range contains today, falling back to the most recently started term. Used
// as the default sync scope when the user has never saved a selection —
// Rice keeps prior-semester enrollments "active" long after the term ends, so
// "sync everything active" was pulling old classes the user never asked for.
function _currentTermCourseIds(allCourses) {
  const now = Date.now();
  const groups = new Map(); // label -> { start, end, ids }
  for (const c of allCourses) {
    const label = _normalizedTermLabel(c.term?.name);
    const g = groups.get(label) ?? { start: null, end: null, ids: [] };
    const s = c.term?.start_at ? Date.parse(c.term.start_at) : null;
    const e = c.term?.end_at   ? Date.parse(c.term.end_at)   : null;
    if (s != null && !isNaN(s) && (g.start == null || s < g.start)) g.start = s;
    if (e != null && !isNaN(e) && (g.end   == null || e > g.end))   g.end = e;
    g.ids.push(Number(c.id));
    groups.set(label, g);
  }

  let current = null;
  for (const g of groups.values()) {
    if (g.start != null && g.start <= now && (g.end == null || now <= g.end)) {
      if (!current || g.start > current.start) current = g;
    }
  }
  if (!current) {
    for (const g of groups.values()) {
      if (g.start != null && g.start <= now && (!current || g.start > current.start)) {
        current = g;
      }
    }
  }
  // Degenerate case: no term has a parseable past start date, so "current
  // term" is undecidable. Fall back to everything (silently syncing nothing
  // would look like a broken install) — the caller logs which default applied,
  // and saving any explicit selection replaces this heuristic entirely.
  return current ? current.ids : allCourses.map(c => Number(c.id));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BRIDGE_URL          = 'http://127.0.0.1:3847';
const ALARM_NAME          = 'weekly-monday';
const POLL_ALARM_NAME     = 'interval-poll';

// User-tunable sync schedule (popup → Settings). Stored under `syncSettings`;
// missing keys fall back to these defaults so old installs keep old behavior.
const DEFAULT_SYNC_SETTINGS = {
  debounceHours: 12,   // min gap between canvas-opened syncs
  weeklyEnabled: true, // scheduled weekly sync on/off
  weeklyDay:     1,    // 0=Sun … 6=Sat
  weeklyHour:    6,    // 0–23 local
  pollHours:     0,    // recurring interval sync; 0 = off
};

async function _getSyncSettings() {
  const { syncSettings } = await _storageGet(['syncSettings']);
  return { ...DEFAULT_SYNC_SETTINGS, ...(syncSettings || {}) };
}
const COURSE_CONCURRENCY  = 3;
const MAX_LOG_ENTRIES     = 50;
const MAX_SYNC_HISTORY    = 25;
const RETRY_DELAYS_MS     = [1_000, 4_000]; // exponential backoff steps for 5xx
// v1.1: client-side cap on per-file ingest size. Bridge has its own body
// limit (config.maxIngestMb, default 200). We mirror 200 MB as a hard
// client ceiling so large blobs are skipped locally before hitting the wire.
// OPEN: plumb this from bridge config on handshake if/when config exposes it;
// for now match the bridge's default.
const MAX_INGEST_MB       = 200;
const MAX_INGEST_BYTES    = MAX_INGEST_MB * 1024 * 1024;

// ---------------------------------------------------------------------------
// In-memory state (reset on service-worker restart, persisted fields reloaded)
// ---------------------------------------------------------------------------

let _syncLock = null;          // Promise lock — prevents concurrent syncs
let _cancelRequested = false;  // set by CANCEL_SYNC; checked at loop boundaries

// Thrown by _checkCancel() and treated as a clean stop, not an error.
class SyncCancelled extends Error {
  constructor() { super('Sync cancelled by user'); this.name = 'SyncCancelled'; }
}
function _checkCancel() {
  if (_cancelRequested) throw new SyncCancelled();
}

let _status   = {
  lastSync:        null,
  lastSyncReason:  null,
  coursesTracked:  0,
  bridgeReachable: false,
  authStatus:      'unknown',  // 'ok' | 'expired' | 'unknown'
  nextWeeklyRun:   null,
  lastError:       null,
};

// Per-sync progress map for the full-view tab. Populated by _broadcastProgress.
// Shape:
//   { phase, reason, startedAt, completedAt, courses: { [id]: { id, name, code,
//     state: 'pending'|'running'|'done'|'error', items: { [item]: { status, count } },
//     error?: string } } }
let _progressState = { phase: 'idle', courses: {} };

function _resetProgressState(reason) {
  _progressState = {
    phase:       'start',
    reason,
    startedAt:   new Date().toISOString(),
    completedAt: null,
    courses:     {},
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

async function _log(level, message, reason = '') {
  const entry = { ts: new Date().toISOString(), reason, level, message };
  console[level === 'error' ? 'error' : 'log'](`[CanvasSync] ${message}`);

  const data = await _storageGet(['logs']);
  const logs = Array.isArray(data.logs) ? data.logs : [];
  logs.push(entry);
  // Keep only the most recent MAX_LOG_ENTRIES
  const trimmed = logs.slice(-MAX_LOG_ENTRIES);
  await _storageSet({ logs: trimmed });
}

// ---------------------------------------------------------------------------
// chrome.storage helpers (Promise wrappers)
// ---------------------------------------------------------------------------

function _storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(result);
    });
  });
}

function _storageSet(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    });
  });
}

// Consecutive-failure counter driving the canvas-opened retry backoff. Capped
// so the exponent can't run away during a long outage; a successful sync resets
// it to 0. Best-effort: a storage hiccup here must never mask the real error.
async function _bumpFailureCount() {
  try {
    const { syncFailureCount } = await _storageGet(['syncFailureCount']);
    await _storageSet({ syncFailureCount: Math.min(10, (syncFailureCount ?? 0) + 1) });
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// canvas-opened gate
// ---------------------------------------------------------------------------
//
// content-script.js mirrors this gate so it can bail without waking the service
// worker. It used to re-implement the math with a hardcoded 6h constant, which
// silently overrode the user's debounceHours setting and knew nothing about the
// failure backoff. Instead there is one computation here, and the background
// publishes the resulting timestamp for the content script to compare against.

// Earliest time a canvas-opened sync may run, plus a human reason for the log.
// Apply a selection change made in the desktop app, if one is waiting.
// Deliberately quiet: this runs at the head of every sync, and a bridge that
// is unreachable or has nothing pending is the overwhelmingly common case.
async function _applySelectionIntent(reason) {
  let intent;
  try {
    intent = await fetchSelectionIntent();
  } catch {
    return; // bridge unreachable or too old to know about intents
  }
  if (!intent) return;

  // null clears the saved selection, which puts the extension back on its
  // current-term default. An array — even an empty one — is a literal
  // allowlist, matching what Manage Courses saves.
  const ids = Array.isArray(intent.courseIds) ? intent.courseIds.map(Number) : null;
  try {
    await _storageSet({ selectedCourseIds: ids });
    await _log('info',
      ids === null
        ? 'Applied selection change from the app: cleared (current term)'
        : `Applied selection change from the app: ${ids.length} course(s)`,
      reason);
  } catch {
    return; // nothing was applied, so leave the intent for the next attempt
  }
  // Only now — an intent that was never applied must stay pending.
  await ackSelectionIntent(intent.id).catch(() => {});
}

function _computeCanvasOpenedGate(settings, data) {
  let at = 0;
  let why = '';
  if (data.lastSuccessfulSync) {
    const last = new Date(data.lastSuccessfulSync).getTime();
    if (Number.isFinite(last)) {
      at  = last + settings.debounceHours * 60 * 60 * 1000;
      why = `last sync was ${Math.round((Date.now() - last) / 3_600_000)}h ago`;
    }
  }
  // The debounce above keys on lastSuccessfulSync, which a FAILING sync never
  // writes — so while broken the gate was inert and every Canvas page load fired
  // another doomed full sync (observed: three attempts inside two minutes).
  const failures = data.syncFailureCount ?? 0;
  if (failures > 0 && data.lastSyncAttempt) {
    const cooldownMs = Math.min(30 * 60_000, 5 * 60_000 * Math.pow(2, failures - 1));
    const until = data.lastSyncAttempt + cooldownMs;
    if (until > at) {
      at  = until;
      why = `${failures} recent failure(s), retrying in ${Math.ceil((until - Date.now()) / 60_000)}m`;
    }
  }
  return { at, why };
}

// Publish the gate for content-script.js. Best-effort: the content script fails
// open on a missing key, so a storage hiccup costs a service-worker wake, not a
// missed sync.
async function _publishCanvasOpenedGate() {
  try {
    const [settings, data] = await Promise.all([
      _getSyncSettings(),
      _storageGet(['lastSuccessfulSync', 'lastSyncAttempt', 'syncFailureCount']),
    ]);
    await _storageSet({ nextCanvasOpenedSyncAt: _computeCanvasOpenedGate(settings, data).at });
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Badge helper
// ---------------------------------------------------------------------------

// Centralised badge state management.
// states: 'ok' (clear), 'off' (bridge offline), 'sync' (in progress), 'setup' (not configured), 'auth' (need login)
function _setBadge(state) {
  const map = {
    ok:    { text: '',  color: '#4caf50' },
    off:   { text: 'off', color: '#9e9e9e' },
    sync:  { text: '\u27f3', color: '#2196f3' },  // ⟳
    setup: { text: '!',  color: '#ff9800' },
    auth:  { text: '\u27f3', color: '#ff5722' },   // ⟳ in red
  };
  const { text, color } = map[state] ?? map.ok;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ---------------------------------------------------------------------------
// Alarm: weekly Monday 06:00 local
// ---------------------------------------------------------------------------

function _nextWeekly(weeklyDay, weeklyHour) {
  const now  = new Date();
  const day  = now.getDay(); // 0=Sun … 6=Sat
  let daysUntil = (weeklyDay - day + 7) % 7;
  if (daysUntil === 0 && now.getHours() >= weeklyHour) daysUntil = 7;

  const target = new Date(now);
  target.setDate(target.getDate() + daysUntil);
  target.setHours(weeklyHour, 0, 0, 0);
  return target;
}

async function _scheduleWeeklyAlarm() {
  const s = await _getSyncSettings();

  if (!s.weeklyEnabled) {
    await chrome.alarms.clear(ALARM_NAME);
    _status.nextWeeklyRun = null;
  } else {
    const target = _nextWeekly(s.weeklyDay, s.weeklyHour);
    _status.nextWeeklyRun = target.toISOString();
    chrome.alarms.create(ALARM_NAME, { when: target.getTime() });
    _log('info', `Weekly alarm set for ${target.toLocaleString()}`, 'alarm-schedule');
  }

  // Interval polling: independent recurring sync every N hours. Only touch
  // the alarm when its period actually changed — this function runs on every
  // service-worker start, and a clear+recreate would reset the countdown each
  // time Chrome wakes the worker (Canvas visit, popup open), so a poll could
  // otherwise never actually fire.
  const wantPeriod = s.pollHours > 0 ? s.pollHours * 60 : 0;
  const existing = await chrome.alarms.get(POLL_ALARM_NAME);
  if (wantPeriod === 0) {
    if (existing) await chrome.alarms.clear(POLL_ALARM_NAME);
  } else if (!existing || existing.periodInMinutes !== wantPeriod) {
    await chrome.alarms.clear(POLL_ALARM_NAME);
    chrome.alarms.create(POLL_ALARM_NAME, {
      periodInMinutes: wantPeriod,
      delayInMinutes:  wantPeriod,
    });
    _log('info', `Interval sync every ${s.pollHours}h`, 'alarm-schedule');
  }
}

// Cancel the weekly alarm entirely. Used when the user pauses auto-sync —
// we don't want Chrome to wake the service worker at all until they resume.
async function _cancelWeeklyAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(POLL_ALARM_NAME);
  _status.nextWeeklyRun = null;
  await _log('info', 'Scheduled alarms cleared (auto-sync paused)', 'alarm-cancel');
}

// Schedule iff auto-sync is enabled. Used at boot/install/resume so we never
// re-create the alarm while paused.
async function _scheduleIfEnabled() {
  const { autoSyncEnabled } = await _storageGet(['autoSyncEnabled']);
  if (autoSyncEnabled === false) {
    // Make sure no stale alarm hangs around from before the pause.
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.clear(POLL_ALARM_NAME);
    _status.nextWeeklyRun = null;
    return false;
  }
  await _scheduleWeeklyAlarm();
  return true;
}

// ---------------------------------------------------------------------------
// Semaphore for per-course parallelism
// ---------------------------------------------------------------------------

function _makeSemaphore(n) {
  let running = 0;
  const queue = [];

  function _next() {
    if (queue.length === 0 || running >= n) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(
      (v) => { running--; resolve(v); _next(); },
      (e) => { running--; reject(e);  _next(); },
    );
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      _next();
    });
  };
}

// ---------------------------------------------------------------------------
// Progress broadcast
// ---------------------------------------------------------------------------

function _broadcastProgress(data) {
  // Mirror every event into _progressState so a late-opened full-view tab can
  // replay current state via GET_PROGRESS_STATE.
  _updateProgressState(data);
  chrome.runtime.sendMessage({ type: 'SYNC_PROGRESS', ...data }).catch(() => {
    // Popup may be closed — ignore.
  });
}

async function _appendSyncHistory(entry) {
  try {
    const { syncHistory } = await _storageGet(['syncHistory']);
    const list = Array.isArray(syncHistory) ? syncHistory : [];
    list.push(entry);
    // Keep only the most recent runs.
    const trimmed = list.slice(-MAX_SYNC_HISTORY);
    await _storageSet({ syncHistory: trimmed });
  } catch { /* best-effort */ }
}

function _updateProgressState(e) {
  if (e.phase === 'start') {
    _resetProgressState(e.reason);
    return;
  }
  if (e.phase === 'courses' && e.count != null) {
    _progressState.totalCourses = e.count;
    return;
  }
  if (e.phase === 'course-start') {
    _progressState.courses[e.courseId] = {
      id:    e.courseId,
      name:  e.name,
      code:  e.code ?? null,
      state: 'running',
      items: Object.fromEntries((e.items ?? []).map(i => [i, { status: 'pending' }])),
    };
    return;
  }
  if (e.phase === 'course-item') {
    const c = _progressState.courses[e.courseId];
    if (!c) return;
    c.items[e.item] = { status: e.status, count: e.count, display: e.display };
    return;
  }
  if (e.phase === 'course-done') {
    const c = _progressState.courses[e.courseId];
    if (c) {
      c.state       = 'done';
      c.counts      = e.counts;
      c.completedAt = new Date().toISOString();
    }
    return;
  }
  if (e.phase === 'course-error') {
    const c = _progressState.courses[e.courseId];
    if (c) { c.state = 'error'; c.error = e.error; }
    return;
  }
  if (e.phase === 'complete') {
    _progressState.phase = 'complete';
    _progressState.completedAt = new Date().toISOString();
    _progressState.courseCount = e.courseCount;
    _appendSyncHistory({
      startedAt:   _progressState.startedAt,
      completedAt: _progressState.completedAt,
      reason:      _progressState.reason,
      phase:       'complete',
      courseCount: e.courseCount,
    });
    return;
  }
  if (e.phase === 'error') {
    _progressState.phase = 'error';
    _progressState.error = e.error;
    _progressState.completedAt = new Date().toISOString();
    _appendSyncHistory({
      startedAt:   _progressState.startedAt,
      completedAt: _progressState.completedAt,
      reason:      _progressState.reason,
      phase:       'error',
      error:       e.error,
      courseCount: Object.values(_progressState.courses || {}).filter(c => c.state === 'done').length,
    });
    return;
  }
  if (e.phase === 'cancelling') {
    _progressState.phase = 'cancelling';
    return;
  }
  if (e.phase === 'cancelled') {
    // Mirror the terminal state so a late-opened view doesn't replay a
    // perpetually-running sync, and record the run like complete/error do.
    _progressState.phase = 'cancelled';
    _progressState.completedAt = new Date().toISOString();
    _appendSyncHistory({
      startedAt:   _progressState.startedAt,
      completedAt: _progressState.completedAt,
      reason:      _progressState.reason,
      phase:       'cancelled',
      courseCount: Object.values(_progressState.courses || {}).filter(c => c.state === 'done').length,
    });
  }
}

// ---------------------------------------------------------------------------
// Retry wrapper for 5xx errors
// ---------------------------------------------------------------------------

async function _withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // ServerError is Canvas-side, BridgeServerError is bridge-side. Both are
      // 5xx and both are transient; only the first used to be retried, so a
      // single bridge hiccup aborted an otherwise-healthy sync.
      const transient = err instanceof ServerError || err instanceof BridgeServerError;
      if (transient && attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        await _log('warn', `Server error, retrying in ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
        lastErr = err;
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// fullSync — the main data pull
// ---------------------------------------------------------------------------

async function fullSync(reason) {
  _setBadge('sync');
  await _log('info', `Starting full sync (reason: ${reason})`, reason);
  _broadcastProgress({ phase: 'start', reason });

  // 1. Health-check bridge
  const healthy = await bridgeHealth();
  _status.bridgeReachable = healthy;
  if (!healthy) {
    _setBadge('off');
    _status.lastError = 'Bridge unreachable';
    await _storageSet({ lastError: 'Bridge unreachable' });
    await _bumpFailureCount();
    await _log('warn', 'Bridge unreachable — aborting sync', reason);
    _broadcastProgress({ phase: 'error', error: 'Bridge unreachable' });
    return;
  }

  try {
    // 2. Fetch active courses (paginated)
    _broadcastProgress({ phase: 'courses' });
    const allCourses = [];
    const coursesUrl = '/api/v1/courses?enrollment_state=active'
      + '&include[]=term&include[]=syllabus_body&include[]=public_description&per_page=100';

    for await (const page of paginate(coursesUrl)) {
      _checkCancel();
      allCourses.push(...page);
    }

    // v1.1: honor bridge's `untracked` list. Courses the user has deleted
    // must not be re-fetched or re-POSTed — a read failure ABORTS the sync
    // (see the catch below), because proceeding would resurrect them.
    let untrackedSet = new Set();
    try {
      const untracked = await getUntracked();
      untrackedSet = new Set(untracked);
      if (untrackedSet.size > 0) {
        await _log('info', `Untracked filter active: ${untrackedSet.size} classes excluded`, reason);
      }
    } catch (err) {
      // A pairing problem is not a network blip — let it through with its type
      // intact so the caller can stop retrying and prompt for re-pairing.
      // Rewrapping it here is what made a missing secret look identical to a
      // dropped packet and retry on every Canvas page load, forever.
      if (err instanceof ConfigError) throw err;
      // Deleted classes must NEVER be re-fetched/re-POSTed. If we can't read
      // the untracked list, proceeding would resurrect them — abort instead.
      // (The bridge also rejects untracked ingest server-side as a backstop.)
      throw new NetworkError(`Cannot read untracked-class list from bridge (${err.message}) — aborting sync so deleted classes are not resurrected`);
    }

    // Apply user's course selection. The selection is an explicit allowlist:
    //   - saved array (even empty) → sync EXACTLY those courses, nothing else
    //   - never saved (null)       → default to the CURRENT TERM only
    // "Active enrollment" on Canvas includes past semesters, so the old
    // "no selection = sync everything" default pulled classes the user never
    // picked. Empty selection now means sync nothing (user cleared all).
    // Pick up a selection the user changed in the desktop app. The app cannot
    // write chrome.storage, so it leaves the change on the bridge and this is
    // where it lands. Best-effort: a bridge that cannot answer just means the
    // sync runs on the selection already saved here.
    await _applySelectionIntent(reason);

    const { selectedCourseIds } = await _storageGet(['selectedCourseIds']);
    let coursesToSync;
    if (Array.isArray(selectedCourseIds)) {
      const allowed = new Set(selectedCourseIds.map(Number));
      coursesToSync = allCourses.filter(c => allowed.has(Number(c.id)));
      await _log('info',
        `Selection active: ${coursesToSync.length}/${allCourses.length} courses will sync`,
        reason);
    } else {
      const currentIds = new Set(_currentTermCourseIds(allCourses));
      coursesToSync = allCourses.filter(c => currentIds.has(Number(c.id)));
      await _log('info',
        `No saved selection — defaulting to current term: ${coursesToSync.length}/${allCourses.length} courses`,
        reason);
    }

    // v1.1: filter out untracked classes BEFORE any /ingest/* call — untracked
    // courses must never touch disk. Filter by derived folder name to match
    // exactly what the bridge writes.
    if (untrackedSet.size > 0) {
      const before = coursesToSync.length;
      coursesToSync = coursesToSync.filter(c => !untrackedSet.has(folderNameFor(c)));
      const dropped = before - coursesToSync.length;
      if (dropped > 0) {
        await _log('info', `Untracked filter dropped ${dropped} courses`, reason);
      }
    }

    // Cache the visible course list so the popup's tracked-classes section
    // can render offline (bridge reachable for /config/untracked, but the
    // Canvas paginated fetch would be slow + unnecessary). Also persist which
    // course IDs this sync actually covered, so GET_TRACKED_CLASSES can show
    // the real scope even when the user never saved an explicit selection.
    try {
      await _storageSet({
        lastKnownCourses: allCourses.map(c => ({
          id:          c.id,
          name:        c.name,
          course_code: c.course_code ?? null,
        })),
        lastSyncedCourseIds: coursesToSync.map(c => Number(c.id)),
      });
    } catch { /* best-effort */ }

    // Tell the bridge what this sync's scope is, so the dashboard sidebar, the
    // pipeline and the calendar all narrow to the same classes. Cosmetic for
    // the sync itself — a bridge that rejects this must not abort the run.
    publishScope(coursesToSync.map(c => c.id), allCourses).catch(() => {});

    _status.coursesTracked = coursesToSync.length;
    await _log('info', `Fetched ${allCourses.length} courses; syncing ${coursesToSync.length}`, reason);
    _broadcastProgress({ phase: 'courses', count: coursesToSync.length });

    // 3. Per-course data in parallel (max COURSE_CONCURRENCY)
    const sem = _makeSemaphore(COURSE_CONCURRENCY);
    const coursesSeen = [];

    const courseResults = await Promise.allSettled(coursesToSync.map(course => sem(async () => {
      _checkCancel();
      const id = course.id;
      coursesSeen.push(id);

      const itemList = ['assignments', 'groups', 'modules', 'discussions', 'announcements', 'pages', 'quizzes', 'events', 'files', 'grades', 'tabs', 'groups_list', 'files_download', 'syllabus'];
      _broadcastProgress({
        phase:    'course-start',
        courseId: id,
        name:     course.name,
        code:     course.course_code ?? null,
        items:    itemList,
      });

      // Announcements: reach back to term start when known so nothing from
      // this semester is missed; fall back to 180 days.
      const termStartMs = course.term?.start_at ? Date.parse(course.term.start_at) : NaN;
      const annStart = (!isNaN(termStartMs)
        ? new Date(termStartMs)
        : new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
      ).toISOString().split('T')[0];
      // Explicit end_date is required: Canvas defaults end_date to start_date
      // + 28 days, which would silently drop every announcement after the
      // first four weeks of term.
      const annEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      // Course calendar events: 30 days back through 210 days ahead.
      const evStart = new Date(Date.now() - 30  * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const evEnd   = new Date(Date.now() + 210 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      // Fetch helper that tolerates per-resource permission denials — one 403
      // shouldn't nuke the whole course. Emits 'forbidden' to the UI instead.
      const fetchResource = async (url, item) => {
        try {
          const data = await _collectPages(url);
          _broadcastProgress({ phase: 'course-item', courseId: id, item, status: 'done', count: data.length });
          return data;
        } catch (err) {
          if (err instanceof PermissionError) {
            _broadcastProgress({ phase: 'course-item', courseId: id, item, status: 'forbidden', count: 0 });
            return [];
          }
          // A user-initiated cancel is not an error — don't paint red states
          // on rows that were simply interrupted.
          if (!(err instanceof SyncCancelled)) {
            _broadcastProgress({ phase: 'course-item', courseId: id, item, status: 'error', error: err?.message ?? String(err) });
          }
          throw err;
        }
      };

      try {
        // allSettled, not all: an eager rejection (cancel, one failed
        // resource) must not orphan the sibling fetches still on the wire —
        // maybeSync's finally would reset the cancel flag under them.
        const settled = await Promise.allSettled([
          fetchResource(`/api/v1/courses/${id}/assignments?include[]=submission&include[]=all_dates&include[]=overrides&include[]=score_statistics&include[]=rubric&order_by=due_at&per_page=100`, 'assignments'),
          fetchResource(`/api/v1/courses/${id}/assignment_groups?include[]=assignments&per_page=100`, 'groups'),
          fetchResource(`/api/v1/courses/${id}/modules?include[]=items&include[]=content_details&per_page=100`, 'modules'),
          fetchResource(`/api/v1/courses/${id}/discussion_topics?per_page=100`, 'discussions'),
          fetchResource(`/api/v1/announcements?context_codes[]=course_${id}&start_date=${annStart}&end_date=${annEnd}&per_page=100`, 'announcements'),
          fetchResource(`/api/v1/courses/${id}/pages?include[]=body&per_page=100`, 'pages'),
          fetchResource(`/api/v1/courses/${id}/quizzes?per_page=100`, 'quizzes'),
          fetchResource(`/api/v1/calendar_events?type=event&context_codes[]=course_${id}&start_date=${evStart}&end_date=${evEnd}&per_page=100`, 'events'),
          fetchResource(`/api/v1/courses/${id}/files?per_page=100`, 'files'),
          fetchResource(`/api/v1/courses/${id}/enrollments?user_id=self&per_page=100`, 'grades'),
          fetchResource(`/api/v1/courses/${id}/tabs?per_page=100`, 'tabs'),
          fetchResource(`/api/v1/courses/${id}/groups?per_page=100`, 'groups_list'),
          fetchResource(`/api/v1/courses/${id}/external_tools?include_parents=true&per_page=100`, 'external_tools'),
        ]);
        // Everything has settled — now surface the first failure (SyncCancelled
        // included) exactly as Promise.all would have, with nothing orphaned.
        const firstRejection = settled.find(s => s.status === 'rejected');
        if (firstRejection) throw firstRejection.reason;
        const [assignments, assignmentGroups, modules, discussions, announcements, pages, quizzes, calendarEvents, filesIndex, enrollments, tabs, courseGroups, externalTools] = settled.map(s => s.value);

        // Discussion replies: instructor clarifications and task details often
        // live in the thread, not the topic body. Pull the full view for the
        // most relevant topics (graded first, then newest), capped to bound
        // request count, and flatten reply text onto each topic.
        const viewTargets = [...discussions]
          .sort((a, b) => {
            const ga = a?.assignment ? 1 : 0, gb = b?.assignment ? 1 : 0;
            if (ga !== gb) return gb - ga;
            return Date.parse(b?.posted_at ?? 0) - Date.parse(a?.posted_at ?? 0) || 0;
          })
          .slice(0, 20);
        for (const topic of viewTargets) {
          _checkCancel();
          try {
            const view = await canvasGetJson(`/api/v1/courses/${id}/discussion_topics/${topic.id}/view`);
            const texts = [];
            const walk = (entries) => {
              for (const e of entries || []) {
                if (e?.message) texts.push(String(e.message).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
                walk(e?.replies);
              }
            };
            walk(view?.view);
            if (texts.length) topic.replies_text = texts.slice(0, 50).join('\n---\n').slice(0, 20000);
          } catch { /* locked topic or require_initial_post — skip */ }
        }

        // Harvest file IDs embedded in HTML bodies across every scraped
        // surface (syllabus tab, page bodies, assignment descriptions,
        // announcements, discussions, quiz descriptions). Profs routinely link
        // course packs / readings inline without ever putting them in Files or
        // Modules — this is the only way those get picked up.
        const htmlCorpus = [
          course.syllabus_body,
          ...pages.map(p => p?.body),
          ...assignments.map(a => a?.description),
          ...announcements.map(a => a?.message),
          ...discussions.map(d => d?.message),
          ...quizzes.map(q => q?.description),
        ].filter(Boolean).join('\n');
        const knownFileIds = new Set(filesIndex.map(f => String(f.id)));
        const embeddedIds = _extractFileIdsFromHtml(htmlCorpus)
          .filter(fid => !knownFileIds.has(String(fid)))
          .slice(0, 60);
        const embeddedFiles = [];
        for (const fid of embeddedIds) {
          _checkCancel();
          try {
            const info = await canvasGetJson(`/api/v1/courses/${id}/files/${fid}`);
            if (info && info.id) embeddedFiles.push(info);
          } catch { /* forbidden or cross-course link — skip */ }
        }

        // Course packs are LTI external tools (Harvard Business Publishing,
        // Study.Net, …). Their CONTENT lives on the provider's site behind its
        // own auth, which this extension has no permission to read — but
        // Canvas knows the tool exists, what it is called, and where its
        // launch goes, and all of that is same-origin. Best effort by design.
        const coursePacks = await _resolveCoursePacks(id, tabs, externalTools);
        _broadcastProgress({ phase: 'course-item', courseId: id, item: 'course_packs', status: 'done', count: coursePacks.length });

        // Create the class dir + metadata FIRST, before any file ingest. The
        // bridge's /ingest/course-file and /ingest/file locate the class dir by
        // courseId prefix and fail if it doesn't exist yet — so on the first
        // sync of a course, posting files before the course dropped every file
        // binary. writeCourse does NOT write files_index.json (writeCourseFile
        // owns it), so running it first is safe. The course payload is already
        // fully enriched here (discussion replies_text was folded in above).
        await _withRetry(() => bridgePost('/ingest/course', {
          course, assignments, modules, announcements, pages, quizzes, filesIndex,
          assignment_groups: assignmentGroups,
          discussions,
          calendar_events:   calendarEvents,
          enrollments,
          tabs,
          groups: courseGroups,
          external_tools: externalTools,
          course_packs:   coursePacks,
        }));

        // v1.1: Course-files download loop. For each file the bridge hasn't
        // already seen (diffed by canvasId + size + canvasUpdatedAt), fetch
        // the binary and POST to /ingest/course-file. This happens
        // independently of the syllabus pipeline below.
        await _downloadCourseFiles({
          course,
          filesIndex,
          modules,
          extraFiles: embeddedFiles,
          reason,
        });

        // Combine the course's file index + files linked from syllabus_body HTML.
        // Score each and mark the top one as canonical. Works even if the /files
        // listing is forbidden (common for students) — the syllabus body alone
        // can seed candidates we can fetch by /api/v1/files/:id directly.
        const ranked = await _findSyllabusCandidates(course, filesIndex, modules);
        let syllabusOk = 0;
        for (let i = 0; i < ranked.length; i++) {
          _checkCancel();
          const file = ranked[i].file;
          if (!file.url) continue;
          try {
            const binary = await _withRetry(() => fetchBinary(file.url));
            await bridgePost('/ingest/file', {
              courseId:    id,
              fileId:      file.id,
              displayName: file.display_name,
              filename:    file.display_name,      // bridge canonical field
              isSyllabus:  i === 0,                // top-ranked wins
              contentType: binary.contentType,
              dataBase64:  binary.base64,          // bridge canonical field
              base64:      binary.base64,          // belt + suspenders
            });
            syllabusOk++;
          } catch (err) {
            await _log('warn', `Failed to fetch syllabus candidate ${file.id} (${file.display_name}): ${err.message}`, reason);
          }
        }

        // Decide syllabus status based on what actually landed. The bridge
        // auto-writes course.syllabus_body as syllabus.html; a short body is
        // usually a link-stub (the real syllabus is a DOCX/PDF behind it).
        const rawBody   = typeof course.syllabus_body === 'string' ? course.syllabus_body : '';
        const bodyText  = rawBody.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
        const tabLen    = bodyText.length;
        const hasRealTab = tabLen >= 500;   // heuristic — real syllabus prose
        const hasAnyTab  = tabLen > 0;

        let syllabusStatus, syllabusDisplay;
        const parts = [];
        if (syllabusOk > 0)                parts.push(`${syllabusOk} file${syllabusOk > 1 ? 's' : ''}`);
        if (hasRealTab)                    parts.push(`tab ${Math.max(1, Math.round(tabLen / 1024))}KB`);
        else if (hasAnyTab && syllabusOk === 0) parts.push('stub only');

        if (syllabusOk > 0 || hasRealTab) {
          syllabusStatus  = 'done';
          syllabusDisplay = parts.join(' + ');
        } else if (ranked.length > 0) {
          // We found candidates but couldn't actually read any of them — either
          // every download was blocked / 403'd, or each gave a link stub only.
          syllabusStatus  = 'error';
          syllabusDisplay = 'not found';
        } else {
          // No real candidates anywhere — the course just doesn't surface one.
          syllabusStatus  = 'skipped';
          syllabusDisplay = 'not found';
        }
        const totalSyllabus = syllabusOk + (hasRealTab ? 1 : 0);

        _broadcastProgress({
          phase:    'course-item',
          courseId: id,
          item:     'syllabus',
          status:   syllabusStatus,
          count:    totalSyllabus,
          display:  syllabusDisplay,
        });

        // (Course metadata was posted before the file/syllabus downloads above,
        // so the class dir already exists for /ingest/course-file & /ingest/file.)

        _broadcastProgress({
          phase:    'course-done',
          courseId: id,
          name:     course.name,
          code:     course.course_code ?? null,
          counts: {
            assignments:   assignments.length,
            groups:        assignmentGroups.length,
            modules:       modules.length,
            discussions:   discussions.length,
            announcements: announcements.length,
            pages:         pages.length,
            quizzes:       quizzes.length,
            events:        calendarEvents.length,
            files:         filesIndex.length,
            syllabus:      totalSyllabus,
          },
        });
      } catch (err) {
        if (!(err instanceof SyncCancelled)) {
          _broadcastProgress({ phase: 'course-error', courseId: id, error: err.message });
        }
        throw err;
      }
    })));

    // allSettled (not all): on cancel or a single course failure, the other
    // in-flight course tasks must fully wind down BEFORE fullSync returns —
    // otherwise maybeSync's finally resets the cancel flag while detached
    // tasks are still mid-flight and they'd resume past their next
    // _checkCancel. One course failing also no longer aborts the rest.
    const courseFailures = courseResults.filter(r => r.status === 'rejected').map(r => r.reason);
    const cancelledErr = courseFailures.find(e => e instanceof SyncCancelled);
    if (cancelledErr) throw cancelledErr;
    if (courseFailures.length > 0) throw courseFailures[0];

    // 6. POST completion marker
    await _withRetry(() => bridgePost('/ingest/complete', { coursesSeen }));

    // 7. Persist success state
    const now = new Date().toISOString();
    _status.lastSync       = now;
    _status.lastSyncReason = reason;
    _status.lastError      = null;
    _status.authStatus     = 'ok';
    await _storageSet({
      lastSuccessfulSync: now,
      lastSyncReason:     reason,
      coursesTracked:     coursesToSync.length,
      lastError:          null,
      // A success clears the backoff and any stale pairing flag, so one good
      // sync fully re-arms normal scheduling.
      syncFailureCount:   0,
      needsSetup:         false,
      // _status lives in the service worker, which Chrome tears down after
      // ~30s idle. Persisting authStatus keeps "Canvas login needed" on screen
      // across that teardown instead of silently reverting to "Auto-sync on".
      authStatus:         'ok',
    });

    _setBadge('ok');
    await _log('info', `Sync complete — ${coursesToSync.length} courses`, reason);
    _broadcastProgress({ phase: 'complete', courseCount: coursesToSync.length });

  } catch (err) {
    if (err instanceof SyncCancelled) {
      // Clean stop, not a failure — no error state, no notification.
      _setBadge('ok');
      await _log('info', 'Sync cancelled by user', reason);
      _broadcastProgress({ phase: 'cancelled' });
      return;
    }

    _status.lastError = err.message;
    await _storageSet({ lastError: err.message });
    await _bumpFailureCount();

    if (err instanceof ConfigError) {
      // Unrecoverable without user action: stop the silent retry loop, flag the
      // state so scheduled triggers stand down, and tell the user ONCE (fixed
      // notification id, so repeats replace rather than stack).
      _setBadge('setup');
      const { needsSetup: wasFlagged } = await _storageGet(['needsSetup']);
      await _storageSet({ needsSetup: true });
      if (!wasFlagged) {
        chrome.notifications.create('canvas-sync-needs-setup', {
          type:    'basic',
          iconUrl: 'icons/icon48.png',
          title:   'Canvas Sync — Pairing Needed',
          message: 'Canvas Sync is not paired with the bridge. Open the extension popup to reconnect.',
        });
      }
      await _log('error', `Pairing required: ${err.message}`, reason);
    } else if (err instanceof AuthError) {
      _status.authStatus = 'expired';
      await _storageSet({ authStatus: 'expired' });
      _setBadge('auth');
      chrome.notifications.create('canvas-auth-error', {
        type:    'basic',
        iconUrl: 'icons/icon48.png',
        title:   'Canvas Sync — Login Required',
        message: 'Canvas session expired — open Canvas to re-auth and sync will resume.',
      });
      const detail = err.url ? ` [url=${err.url}]` : '';
      await _log('error', `Auth error during sync: ${err.message}${detail}`, reason);
    } else if (err instanceof NetworkError) {
      _setBadge('off');
      await _log('error', `Network error during sync: ${err.message}`, reason);
    } else {
      _setBadge('off');
      chrome.notifications.create(`canvas-sync-error-${Date.now()}`, {
        type:    'basic',
        iconUrl: 'icons/icon48.png',
        title:   'Canvas Sync — Error',
        message: `Sync failed: ${err.message}`,
      });
      await _log('error', `Sync error: ${err.message}`, reason);
    }

    _broadcastProgress({ phase: 'error', error: err.message });
  }
}

// --- Syllabus discovery helpers -------------------------------------------

// Syllabus scoring is split into "name signal" (the only gate for inclusion from
// the course's full file index) vs. "type/size boost" (used to rank already-
// qualified candidates). Without this split, every PDF in the course would get
// treated as a syllabus candidate and fetched.
function _nameScoreForSyllabus(name) {
  const n = (name || '').toLowerCase();
  let s = 0;
  if (/\bsyllab(us|i)\b/.test(n))                                    s += 100;
  if (/course.?(info|outline|overview|schedule|policies)/.test(n))   s += 60;
  if (/class.?(info|outline|policies)/.test(n))                      s += 40;
  if (/\b(greensheet|greenpaper|handbook)\b/.test(n))                s += 80;
  return s;
}

function _scoreSyllabusFile(file) {
  if (!file) return 0;
  const name = (file.display_name || file.filename || '').toLowerCase();
  const ct   = (file.content_type || '').toLowerCase();
  let s = _nameScoreForSyllabus(name);
  if (ct.includes('pdf') || name.endsWith('.pdf'))                   s += 5;
  if (ct.includes('word') || /\.docx?$/.test(name))                  s += 5;
  if (ct.includes('html') || /\.html?$/.test(name))                  s += 2;
  const size = file.size || 0;
  if (size >= 10_000 && size <= 8_000_000)                           s += 3;
  if (size > 0 && size < 3_000)                                      s -= 30;
  return s;
}

function _extractFileIdsFromHtml(html) {
  if (!html) return [];
  const ids = new Set();
  const re = /\/files\/(\d+)/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
}

// ---------------------------------------------------------------------------
// Course packs — LTI external tools recognised by name.
// ---------------------------------------------------------------------------

// Both of this user's packs are "Course Pack" course-navigation tabs pointing
// at Harvard Business Publishing; the other names are the common providers.
const COURSE_PACK_RE = /course\s*-?\s*pack|coursepack|hbsp|harvard\s*business|study\.?net|redshelf|perusall|vitalsource|mcgraw|mheducation/i;

/**
 * What Canvas knows about each course-pack tool: identity, label, provider,
 * and where its launch goes. The pack's CONTENT — the articles and chapters —
 * lives on the provider's site behind its own auth, on a domain this
 * extension has no host permission for, so content is out of reach on
 * purpose; the record is what makes the pack visible and clickable
 * everywhere else.
 *
 * Every fetch here is same-origin (canvas.rice.edu): the tool listing, the
 * sessionless-launch API, and the launch page whose LTI form names the
 * provider's real entry point in its `action`.
 */
async function _resolveCoursePacks(courseId, tabs, externalTools) {
  const toolById = new Map((externalTools ?? [])
    .filter(t => t && t.id != null)
    .map(t => [String(t.id), t]));

  const candidates = [];
  const seen = new Set();
  for (const tab of tabs ?? []) {
    const m = /^context_external_tool_(\d+)$/.exec(String(tab?.id ?? ''));
    if (!m) continue;
    const tool = toolById.get(m[1]) ?? null;
    const hay = [tab.label, tool?.name, tool?.description, tool?.domain, tool?.url].filter(Boolean).join(' ');
    if (!COURSE_PACK_RE.test(hay)) continue;
    seen.add(m[1]);
    candidates.push({ toolId: m[1], label: tab.label ?? tool?.name ?? 'Course Pack', tool, tabUrl: tab.full_url ?? null });
  }
  // A pack tool hidden from course navigation is still in the tool listing.
  for (const [toolId, tool] of toolById) {
    if (seen.has(toolId)) continue;
    const hay = [tool?.name, tool?.description, tool?.domain, tool?.url].filter(Boolean).join(' ');
    if (!COURSE_PACK_RE.test(hay)) continue;
    candidates.push({ toolId, label: tool?.name ?? 'Course Pack', tool, tabUrl: null });
  }

  const packs = [];
  for (const c of candidates) {
    _checkCancel();
    const rec = {
      tool_id:         c.toolId,
      label:           c.label,
      name:            c.tool?.name ?? null,
      description:     c.tool?.description ?? null,
      provider_domain: c.tool?.domain ?? null,
      provider_url:    c.tool?.url ?? null,
      // The link a person clicks: Canvas's own tool page, which launches the
      // pack with their session. Works even when resolution below fails.
      launch_url:      c.tabUrl ?? `${CANVAS_BASE}/courses/${courseId}/external_tools/${c.toolId}`,
      resolved_target: null,
    };
    try {
      const sl = await canvasGetJson(
        `/api/v1/courses/${courseId}/external_tools/sessionless_launch?id=${c.toolId}&launch_type=course_navigation`);
      if (sl?.url) {
        const resp = await canvasFetch(sl.url);
        const html = await resp.text();
        const target = /<form[^>]+action="([^"]+)"/i.exec(html)?.[1]
          ?? /name="target_link_uri"[^>]+value="([^"]+)"/i.exec(html)?.[1]
          ?? null;
        if (target) rec.resolved_target = target.replace(/&amp;/g, '&');
      }
    } catch (err) {
      if (err instanceof SyncCancelled) throw err;
      // Resolution is a nicety; the tab link above works without it.
    }
    packs.push(rec);
  }
  return packs;
}

// Rank a Canvas module by how "syllabus-like" its name is. A module named
// "Syllabus" strongly suggests anything inside it is the course syllabus, even
// if the individual file is named something opaque like "255_2026.docx".
function _scoreModuleName(name) {
  const n = (name || '').toLowerCase();
  let s = 0;
  if (/syllab(us|i)/.test(n))                                s += 100;
  if (/course.?(info|outline|overview|policies)/.test(n))    s += 60;
  if (/class.?(info|outline|policies)/.test(n))              s += 40;
  if (/\b(greensheet|greenpaper|handbook)\b/.test(n))        s += 60;
  if (/\b(start[ -]?here|welcome|getting[ -]?started)\b/.test(n)) s += 20;
  return s;
}

const MAX_SYLLABUS_CANDIDATES = 5;

async function _findSyllabusCandidates(course, filesIndex, modules) {
  const linkedFromBody = new Set(_extractFileIdsFromHtml(course.syllabus_body).map(String));

  // Module bonus: only count modules whose NAME strongly signals syllabus-like
  // content. This stops us from hoovering every file in generic modules like
  // "Week 3" or "Case Studies".
  const fromModuleBonus = new Map();
  for (const mod of modules ?? []) {
    const modBonus = _scoreModuleName(mod.name);
    if (modBonus < 60) continue;
    for (const item of mod.items ?? []) {
      if (item.type !== 'File' || item.content_id == null) continue;
      const id = String(item.content_id);
      fromModuleBonus.set(id, Math.max(fromModuleBonus.get(id) ?? 0, modBonus));
    }
  }

  // Seed candidate map only with files we have a real reason to suspect:
  //   (a) filesIndex entry whose NAME matches a syllabus pattern, OR
  //   (b) file linked from course.syllabus_body, OR
  //   (c) file inside a syllabus-named module.
  const byId = new Map();
  for (const f of filesIndex) {
    if (_nameScoreForSyllabus(f.display_name || f.filename || '') >= 30) {
      byId.set(String(f.id), f);
    }
  }

  const missing = new Set();
  for (const id of linkedFromBody)       if (!byId.has(id)) missing.add(id);
  for (const id of fromModuleBonus.keys()) if (!byId.has(id)) missing.add(id);

  // Hard cap on per-course lookups — the body can contain dozens of links that
  // aren't syllabus-like (readings, figures, etc.).
  const missingList = [...missing].slice(0, 12);
  for (const id of missingList) {
    _checkCancel();
    try {
      const info = await canvasGetJson(`/api/v1/files/${id}`);
      byId.set(String(info.id), info);
    } catch {
      /* forbidden or 404 — skip */
    }
  }

  const ranked = [];
  for (const f of byId.values()) {
    const id = String(f.id);
    let score = _scoreSyllabusFile(f);
    if (linkedFromBody.has(id))      score += 50;
    if (fromModuleBonus.has(id))     score += fromModuleBonus.get(id);
    if (score > 0) ranked.push({ file: f, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, MAX_SYLLABUS_CANDIDATES);
}

// Collect all pages of a paginated endpoint into a flat array.
async function _collectPages(url) {
  const all = [];
  for await (const page of paginate(url)) {
    _checkCancel();
    all.push(...(Array.isArray(page) ? page : [page]));
  }
  return all;
}

// ---------------------------------------------------------------------------
// v1.1: per-course file download loop
// ---------------------------------------------------------------------------

// Walk a modules-with-items response and return the Canvas file IDs of every
// File-type item. These are often the ONLY way to reach a course's slides
// when the prof has locked the Files tab (the /api/v1/courses/:id/files
// endpoint returns [] in that case, but per-file /api/v1/courses/:id/files/:id
// access still works because the link is exposed via the module).
//
// Canvas reports these items as type === 'File'. A few older Canvas UIs label
// them 'Attachment' in admin responses — we accept both defensively.
function _collectModuleFileIds(modules) {
  if (!Array.isArray(modules)) return [];
  const ids = [];
  for (const mod of modules) {
    if (!Array.isArray(mod?.items)) continue;
    for (const item of mod.items) {
      if (item?.type === 'File' || item?.type === 'Attachment') {
        if (item.content_id != null) ids.push(item.content_id);
      }
    }
  }
  return ids;
}

// Download every new/changed Canvas file into the bridge. Diffs against the
// bridge's existing files_index.json by canvasId + size + canvasUpdatedAt so
// unchanged files stay on disk untouched. Emits one SYNC_PROGRESS 'course-item'
// event under item key 'files_download' with a rolling `display` string so the
// full-view tab can show "12/15 files" progress as bytes come down.
//
// Error policy:
// - PermissionError on a single file (403) → skipped: 'forbidden'. NOT retried.
//   We still count it; the final display shows "skipped: forbidden (N)".
// - File > MAX_INGEST_BYTES → skipped: 'size'. Not even fetched.
// - Any other per-file failure → counted as error; sync continues.
async function _downloadCourseFiles({ course, filesIndex, modules, extraFiles = [], reason }) {
  const courseId = course?.id;
  if (!courseId) return;

  // Merge File-type module items into the effective download list. Rice profs
  // often lock the Files tab (so /api/v1/courses/:id/files returns []), but
  // leave the underlying files reachable via module items. For each File
  // content_id not already in filesIndex, fetch the file object individually
  // to get a signed download URL + metadata. This is how BUSI 395's lecture
  // PDFs (uploaded as module attachments, not to the Files tab) get picked up.
  const existingIds = new Set((filesIndex ?? []).map(f => String(f.id)));
  const moduleFileIds = _collectModuleFileIds(modules).filter(
    id => !existingIds.has(String(id)) && !extraFiles.some(f => String(f.id) === String(id)),
  );

  const moduleFiles = [];
  for (const fileId of moduleFileIds) {
    _checkCancel();
    try {
      const info = await canvasGetJson(`/api/v1/courses/${courseId}/files/${fileId}`);
      if (info && info.id) moduleFiles.push(info);
    } catch (err) {
      if (err instanceof PermissionError) continue;
      // Non-fatal: just skip this file and keep going.
      await _log('warn',
        `module-file lookup ${fileId} for course ${courseId} failed: ${err.message}`,
        reason);
    }
  }

  // extraFiles = embedded-link discoveries from HTML bodies (already fetched
  // metadata). Dedupe against the Files-tab index by canvas ID.
  const dedupedExtra = (extraFiles ?? []).filter(f => !existingIds.has(String(f.id)));
  const effective = [...(filesIndex ?? []), ...moduleFiles, ...dedupedExtra];

  // Nothing to do if both sources came up empty.
  if (effective.length === 0) {
    _broadcastProgress({
      phase: 'course-item', courseId, item: 'files_download',
      status: 'done', count: 0, display: '0 files',
    });
    return;
  }

  _broadcastProgress({
    phase: 'course-item', courseId, item: 'files_download',
    status: 'running',
    count: 0,
    display: `0/${effective.length} files`
      + (moduleFiles.length ? ` (+${moduleFiles.length} from modules)` : '')
      + (dedupedExtra.length ? ` (+${dedupedExtra.length} embedded)` : ''),
  });

  // Load bridge index for diffing. Non-fatal on failure — we just treat every
  // file as new (bridge will dedupe by canvasId + size + updated_at on its side).
  const folderName = folderNameFor(course);
  let bridgeIndex = [];
  try {
    bridgeIndex = await getFilesIndex(folderName);
  } catch (err) {
    await _log('warn', `getFilesIndex(${folderName}) failed: ${err.message}`, reason);
  }
  const bridgeById = new Map(bridgeIndex.map(f => [String(f.canvasId), f]));

  let done = 0, skippedForbidden = 0, skippedSize = 0, skippedUnchanged = 0, errored = 0;
  const total = effective.length;

  // Serial per-class so memory stays bounded (one base64 in flight at a time).
  // Course-level parallelism is already enforced by the outer semaphore.
  for (const f of effective) {
    _checkCancel();
    const canvasId = String(f.id);
    const size = typeof f.size === 'number' ? f.size : 0;
    const canvasUpdatedAt = f.updated_at ?? null;

    // Diff: skip entirely if bridge already has this exact file.
    const prev = bridgeById.get(canvasId);
    if (prev
        && Number(prev.size) === size
        && (prev.canvasUpdatedAt ?? null) === canvasUpdatedAt) {
      skippedUnchanged++;
      continue;
    }

    // Size gate — don't even fetch > MAX_INGEST_BYTES.
    if (size > MAX_INGEST_BYTES) {
      skippedSize++;
      _broadcastProgress({
        phase: 'course-item', courseId, item: 'files_download',
        status: 'running',
        display: _formatFilesDisplay({ done, total, skippedForbidden, skippedSize, errored }),
      });
      continue;
    }

    if (!f.url) {
      errored++;
      continue;
    }

    try {
      const binary = await _withRetry(() => fetchBinary(f.url));
      await ingestCourseFile({
        courseId,
        fileId:          f.id,
        displayName:     f.display_name ?? f.filename ?? String(f.id),
        filename:        f.filename ?? f.display_name ?? String(f.id),
        contentType:     binary.contentType ?? f.content_type ?? 'application/octet-stream',
        size,
        canvasUpdatedAt,
        dataBase64:      binary.base64,
      });
      done++;
    } catch (err) {
      if (err instanceof PermissionError) {
        // Per-plan: do NOT retry forbidden files.
        skippedForbidden++;
      } else {
        errored++;
        await _log('warn', `Failed to ingest course file ${f.id} (${f.display_name ?? f.filename}): ${err.message}`, reason);
      }
    }

    _broadcastProgress({
      phase: 'course-item', courseId, item: 'files_download',
      status: 'running',
      display: _formatFilesDisplay({ done, total, skippedForbidden, skippedSize, errored }),
    });
  }

  // Final status. Prefer 'done' when everything finished (even if mostly
  // skipped: forbidden) so the UI doesn't show a phantom error; bump to
  // 'error' only if something unexpectedly blew up.
  const finalStatus = errored > 0 ? 'error' : 'done';
  _broadcastProgress({
    phase: 'course-item', courseId, item: 'files_download',
    status: finalStatus,
    count: done,
    display: _formatFilesDisplay({
      done, total, skippedForbidden, skippedSize, errored, skippedUnchanged, final: true,
    }),
  });
}

function _formatFilesDisplay({ done, total, skippedForbidden, skippedSize, errored, skippedUnchanged = 0, final = false }) {
  // Rolling "12/15 files" while running; fuller breakdown at the end.
  if (!final) {
    return `${done}/${total} files`;
  }
  const parts = [];
  if (done > 0) parts.push(`${done}/${total} files`);
  else          parts.push(`0/${total} files`);
  if (skippedUnchanged > 0) parts.push(`unchanged: ${skippedUnchanged}`);
  if (skippedForbidden > 0) parts.push(`skipped: forbidden (${skippedForbidden})`);
  if (skippedSize > 0)      parts.push(`skipped: size (${skippedSize})`);
  if (errored > 0)          parts.push(`errors: ${errored}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// maybeSync — debounced entry point
// ---------------------------------------------------------------------------

async function maybeSync({ reason }) {
  // Auto-sync pause toggle. The user can disable scheduled/triggered syncs
  // (e.g. over summer break) without uninstalling the extension. A `force`
  // reason still bypasses — manual "Force sync now" always runs regardless.
  if (reason !== 'force') {
    const { autoSyncEnabled } = await _storageGet(['autoSyncEnabled']);
    // Default = true. Only an explicit `false` pauses.
    if (autoSyncEnabled === false) {
      await _log('info', `Auto-sync paused — skipping (reason: ${reason})`, reason);
      return;
    }

    // Stand down while unpaired. Without this, every Canvas page load and every
    // weekly alarm re-ran a full Canvas fetch that could only ever fail at the
    // first bridge call — burning rate-limited API traffic to reach a known
    // dead end. `force` still runs so the popup's manual sync works as a probe.
    const { needsSetup } = await _storageGet(['needsSetup']);
    if (needsSetup) {
      await _log('info', `Not paired with the bridge — skipping (reason: ${reason})`, reason);
      return;
    }
  }

  // Serialize: never run two syncs, and never QUEUE one either. A force
  // request while a sync is running is refused (the popup shows a Cancel
  // button in that state instead) — the old behavior of waiting for the
  // running sync and then immediately running a second full pull doubled the
  // load exactly when the machine was busiest.
  if (_syncLock) {
    await _log('info', `Sync already running — skipping (reason: ${reason})`, reason);
    return { alreadyRunning: true };
  }

  // Debounce canvas-opened: skip if last sync was < debounceHours ago
  // (user-tunable in Settings). Interval polls run undebounced — the user
  // chose that cadence explicitly.
  if (reason === 'canvas-opened') {
    const [settings, data] = await Promise.all([
      _getSyncSettings(),
      _storageGet(['lastSuccessfulSync', 'lastSyncAttempt', 'syncFailureCount']),
    ]);
    const gate = _computeCanvasOpenedGate(settings, data);
    if (Date.now() < gate.at) {
      // Republish: reaching here at all means the content script's copy was
      // stale or missing, so refresh it while we know the answer.
      _storageSet({ nextCanvasOpenedSyncAt: gate.at }).catch(() => {});
      await _log('info', `Skipping canvas-opened sync — ${gate.why}`, reason);
      return;
    }
  }

  // Re-check the lock: the debounce block above awaited storage reads, so a
  // concurrent trigger could have taken the lock since the first check.
  if (_syncLock) {
    await _log('info', `Sync started concurrently — skipping (reason: ${reason})`, reason);
    return { alreadyRunning: true };
  }

  let resolveLock;
  _syncLock = new Promise(r => { resolveLock = r; });
  _cancelRequested = false;
  // Stamp the ATTEMPT, not just the success. fullSync's bridge-unreachable path
  // returns early without throwing, so recording this only in a catch would
  // miss the most common failure and leave the cooldown permanently disarmed.
  await _storageSet({ lastSyncAttempt: Date.now() });
  try {
    await fullSync(reason);
  } finally {
    resolveLock();
    _syncLock = null;
    _cancelRequested = false;
    // Success moves the debounce window, failure arms the backoff — either way
    // the content script's copy of the gate is now stale.
    await _publishCanvasOpenedGate();
  }
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message;

  // maybeSync is fired without awaiting (the sender needs an answer now, not in
  // two minutes), so every call site attaches a catch — otherwise a rejection is
  // an unhandled promise in a console nobody reads.
  const _fireSync = (reason) => maybeSync({ reason }).catch(err =>
    _log('error', `${reason} sync failed: ${err?.message ?? err}`, reason).catch(() => {}));

  if (type === 'CANVAS_OPENED') {
    _fireSync('canvas-opened');
    // No synchronous response needed
    return false;
  }

  if (type === 'FORCE_SYNC') {
    if (_syncLock) {
      sendResponse({ ok: false, alreadyRunning: true });
      return false;
    }
    _fireSync('force');
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'CANCEL_SYNC') {
    if (!_syncLock) {
      sendResponse({ ok: false, notRunning: true });
      return false;
    }
    _cancelRequested = true;
    _broadcastProgress({ phase: 'cancelling' });
    _log('info', 'Cancel requested via popup', 'cancel').catch(() => {});
    sendResponse({ ok: true, cancelling: true });
    return false;
  }

  if (type === 'SET_AUTO_SYNC') {
    // Persist the toggle and adjust the alarm: cancel on pause, re-create on
    // resume. Cancelling means Chrome won't wake the service worker at the
    // weekly slot — full idle until the user resumes.
    const enabled = message.enabled !== false;
    (async () => {
      try {
        await _storageSet({ autoSyncEnabled: enabled });
        if (enabled) {
          _scheduleWeeklyAlarm();
        } else {
          await _cancelWeeklyAlarm();
        }
        await _log('info', `Auto-sync ${enabled ? 'enabled' : 'paused'} via popup`, 'set-auto-sync')
          .catch(() => {});
        sendResponse({ ok: true, autoSyncEnabled: enabled });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async response
  }

  if (type === 'GET_SYNC_SETTINGS') {
    _getSyncSettings().then(s => sendResponse({ ok: true, settings: s }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }

  if (type === 'SET_SYNC_SETTINGS') {
    (async () => {
      try {
        const current = await _getSyncSettings();
        const incoming = message.settings || {};
        const next = {
          debounceHours: Math.max(0, Math.min(168, Number(incoming.debounceHours ?? current.debounceHours) || 0)),
          weeklyEnabled: incoming.weeklyEnabled !== undefined ? !!incoming.weeklyEnabled : current.weeklyEnabled,
          weeklyDay:     Math.max(0, Math.min(6, Number(incoming.weeklyDay ?? current.weeklyDay) || 0)),
          weeklyHour:    Math.max(0, Math.min(23, Number(incoming.weeklyHour ?? current.weeklyHour) || 0)),
          // Snap to the option set the popup offers, so stored state and the
          // displayed value can never disagree.
          pollHours:     (() => {
            const v = Math.max(0, Math.min(168, Number(incoming.pollHours ?? current.pollHours) || 0));
            const allowed = [0, 1, 3, 6, 12, 24];
            return allowed.reduce((best, a) => Math.abs(a - v) < Math.abs(best - v) ? a : best, 0);
          })(),
        };
        await _storageSet({ syncSettings: next });
        await _scheduleIfEnabled();      // re-derive all alarms from the new settings
        await _publishCanvasOpenedGate(); // debounceHours moved the window
        await _log('info', `Sync settings updated: ${JSON.stringify(next)}`, 'set-sync-settings').catch(() => {});
        sendResponse({ ok: true, settings: next });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async response
  }

  if (type === 'GET_STATUS') {
    // Probe the bridge and WAIT for the answer. This used to be fire-and-forget,
    // so the reply carried the previous probe's result — and on a cold service
    // worker there was no previous result, only the `false` the module
    // initialiser set. Opening the popup right after Chrome recycled the worker
    // therefore reported "Bridge offline" against a perfectly healthy bridge,
    // for one poll interval. bridgeHealth never throws and self-limits to 4s.
    const health = bridgeHealth()
      .then(h => { _status.bridgeReachable = h; return h; })
      .catch(() => _status.bridgeReachable);

    // Rebuild status snapshot, merging persisted fields
    Promise.all([
      health,
      _storageGet(['lastSuccessfulSync', 'lastSyncReason', 'coursesTracked',
                   'lastError', 'autoSyncEnabled', 'bridgeSecret', 'authStatus']),
    ]).then(([reachable, data]) => {
      // Default autoSyncEnabled to true when unset.
      const autoSync = data.autoSyncEnabled !== false;
      sendResponse({
        lastSync:        data.lastSuccessfulSync ?? _status.lastSync,
        lastSyncReason:  data.lastSyncReason     ?? _status.lastSyncReason,
        coursesTracked:  data.coursesTracked      ?? _status.coursesTracked,
        // Authoritative pairing signal. The popup previously inferred "needs
        // setup" from !bridgeReachable, which hid the token field whenever the
        // bridge was UP but the extension had no secret (e.g. after reloading
        // the unpacked extension, which clears chrome.storage.local) — leaving
        // no way to re-pair. Report the real thing instead of a proxy.
        hasSecret:       !!data.bridgeSecret,
        bridgeReachable: reachable,
        // In-memory first (this worker may have just learned the session
        // expired); storage is the fallback across service-worker teardown.
        authStatus:      _status.authStatus !== 'unknown'
          ? _status.authStatus
          : (data.authStatus ?? 'unknown'),
        nextWeeklyRun:   autoSync ? _status.nextWeeklyRun : null,
        lastError:       data.lastError           ?? _status.lastError,
        autoSyncEnabled: autoSync,
        syncing:         !!_syncLock,
        cancelling:      _cancelRequested,
      });
    }).catch(() => {
      // A storage fault must not leave the popup stuck on "Loading..." forever.
      // Answer with what the worker knows; the popup re-polls anyway.
      sendResponse({ ..._status, hasSecret: undefined, syncing: !!_syncLock });
    });
    return true; // async response
  }

  if (type === 'LIST_COURSES') {
    // Lists every active-enrollment course, regardless of saved selection.
    // Used by the Manage Courses page to populate its picker.
    (async () => {
      try {
        const url = '/api/v1/courses?enrollment_state=active'
          + '&include[]=term&include[]=course_image&per_page=100';
        const courses = [];
        for await (const page of paginate(url)) {
          courses.push(...page);
        }
        const { selectedCourseIds } = await _storageGet(['selectedCourseIds']);
        // v1.1: cache a trimmed copy so the popup's tracked-classes section
        // can render even when Canvas isn't reachable (e.g. popup opened
        // before first sync of the session).
        try {
          await _storageSet({
            lastKnownCourses: courses.map(c => ({
              id:          c.id,
              name:        c.name,
              course_code: c.course_code ?? null,
            })),
          });
        } catch { /* best-effort */ }
        sendResponse({ ok: true, courses, selectedCourseIds: selectedCourseIds ?? null });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async
  }

  if (type === 'SAVE_SELECTED_COURSES') {
    // Array (even empty) = explicit allowlist; empty syncs nothing.
    // null = clear the saved selection → next sync defaults to current term.
    const ids = Array.isArray(message.courseIds) ? message.courseIds.map(Number) : null;
    _storageSet({ selectedCourseIds: ids }).then(
      () => {
        // Push the new scope straight through so the desktop app reflects the
        // change now instead of one sync cycle later. Best-effort: the save
        // itself has already succeeded and must be reported as such.
        publishScope(ids).catch(() => {});
        // A pending app-side change is now stale — this save is newer. Clearing
        // it here is what stops the app silently reverting the user's choice on
        // the next sync.
        fetchSelectionIntent()
          .then(intent => intent && ackSelectionIntent(intent.id))
          .catch(() => {});
        sendResponse({ ok: true });
      },
      (err) => sendResponse({ ok: false, error: err.message }),
    );
    return true; // async
  }

  if (type === 'GET_PROGRESS_STATE') {
    sendResponse(_progressState);
    return false;
  }

  if (type === 'GET_SYNC_HISTORY') {
    _storageGet(['syncHistory']).then(data => {
      sendResponse({
        history: Array.isArray(data.syncHistory) ? data.syncHistory : [],
      });
    });
    return true; // async
  }

  if (type === 'CLEAR_SYNC_HISTORY') {
    _storageSet({ syncHistory: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (type === 'HANDSHAKE') {
    const { installToken } = message;
    handshake(installToken)
      .then(async () => {
        // Handshake just succeeded → bridge is definitionally reachable.
        // Without this update the popup keeps showing "Setup incomplete" until
        // the next health probe.
        _status.bridgeReachable = true;
        _status.lastError       = null;
        // Pairing fixed the unrecoverable state — clear the stand-down flag and
        // the failure backoff so scheduled syncs resume immediately instead of
        // waiting out a cooldown earned while broken.
        await _storageSet({ needsSetup: false, syncFailureCount: 0, lastError: null });
        // Clearing the failure count retired the backoff; republish so the
        // content script stops suppressing canvas-opened syncs immediately
        // rather than waiting out a cooldown earned while unpaired.
        await _publishCanvasOpenedGate();
        chrome.notifications.clear('canvas-sync-needs-setup');
        _setBadge('ok');
        await _log('info', 'Handshake succeeded — bridge paired', 'handshake');
        sendResponse({ ok: true });
      })
      .catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async response
  }

  // v1.1: popup tracked-classes wiring ---------------------------------------

  if (type === 'GET_TRACKED_CLASSES') {
    // Returns the course list the popup uses to render checkboxes plus the
    // current untracked array. The popup should only show classes that
    // actually get synced — i.e. the intersection of the last-known courses
    // and whatever the user selected in courses.html. Selection semantics
    // (mirrors fullSync): a saved array is a strict allowlist (empty = show
    // nothing); null/never-saved = the current-term default, approximated
    // here by lastSyncedCourseIds when available.
    (async () => {
      try {
        const { lastKnownCourses, selectedCourseIds, lastSyncedCourseIds } =
          await _storageGet(['lastKnownCourses', 'selectedCourseIds', 'lastSyncedCourseIds']);
        const all = Array.isArray(lastKnownCourses) ? lastKnownCourses : [];
        // Scope precedence: explicit saved selection (even empty) → what the
        // last sync actually covered (current-term default) → everything known.
        let allowed = null;
        if (Array.isArray(selectedCourseIds)) {
          allowed = new Set(selectedCourseIds.map(Number));
        } else if (Array.isArray(lastSyncedCourseIds)) {
          allowed = new Set(lastSyncedCourseIds.map(Number));
        }
        const courses = allowed ? all.filter(c => allowed.has(Number(c.id))) : all;
        let untracked = [];
        try { untracked = await getUntracked(); }
        catch (err) { /* bridge offline — untracked stays [] */ }
        sendResponse({ ok: true, courses, untracked });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async
  }

  if (type === 'DELETE_CLASS') {
    const { folderName } = message;
    if (!folderName || typeof folderName !== 'string') {
      sendResponse({ ok: false, error: 'folderName required' });
      return false;
    }
    (async () => {
      try {
        const result = await deleteClass(folderName);
        await _log('info', `Deleted class ${folderName} (cleanupPid=${result?.cleanupPid ?? 'n/a'})`, 'delete-class');
        // Broadcast so any open popup re-renders. Ignore receivers that
        // closed — chrome.runtime.sendMessage rejects with "no receiver".
        chrome.runtime.sendMessage({ type: 'CLASSES_UPDATED' }).catch(() => {});
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async
  }

  if (type === 'RETRACK_CLASS') {
    const { folderName } = message;
    if (!folderName || typeof folderName !== 'string') {
      sendResponse({ ok: false, error: 'folderName required' });
      return false;
    }
    (async () => {
      try {
        await removeUntracked(folderName);
        await _log('info', `Re-tracked class ${folderName}`, 'retrack-class');
        chrome.runtime.sendMessage({ type: 'CLASSES_UPDATED' }).catch(() => {});
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async
  }

  return false;
});

// ---------------------------------------------------------------------------
// Alarm listener
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  // Fire-and-forget with no catch meant an alarm-path rejection surfaced only
  // as an "Uncaught (in promise)" in a service-worker console nobody has open:
  // the scheduled sync just never happened and the popup showed nothing wrong.
  const guard = (label, p) => Promise.resolve(p).catch(err =>
    _log('error', `${label} failed: ${err?.message ?? err}`, alarm.name).catch(() => {}));

  if (alarm.name === ALARM_NAME) {
    // Re-schedule iff still enabled (DST drift safety + defensive against
    // paused-state alarms that somehow got through). maybeSync also re-checks
    // the flag — so paused users get nothing here.
    guard('Weekly re-schedule', _scheduleIfEnabled());
    guard('Weekly sync', maybeSync({ reason: 'weekly' }));
  }
  if (alarm.name === POLL_ALARM_NAME) {
    // periodInMinutes alarms repeat on their own; no re-schedule needed.
    guard('Interval sync', maybeSync({ reason: 'interval' }));
  }
});

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const data = await _storageGet(['bridgeSecret']);
  if (!data.bridgeSecret) {
    _setBadge('setup');
    await _log('info', 'No bridge secret found — waiting for handshake', 'install');
  }
  // Honor pause across reinstalls: schedule only when auto-sync is enabled.
  await _scheduleIfEnabled();
  // Seed the content script's gate. On a fresh install this writes 0 (sync on
  // the next Canvas page load); on an upgrade it backfills the key for profiles
  // that predate it.
  await _publishCanvasOpenedGate();

  // Probe bridge reachability on install
  const healthy = await bridgeHealth();
  _status.bridgeReachable = healthy;
  if (!healthy) _setBadge('setup');
});

// On service-worker restart, restore nextWeeklyRun from any existing alarm.
// If no alarm exists, schedule one ONLY if auto-sync is enabled — otherwise
// stay fully idle until the user explicitly resumes.
chrome.alarms.get(ALARM_NAME, async (alarm) => {
  if (alarm) {
    // Defensive: alarm shouldn't exist when paused, but if it somehow does
    // (e.g. older paused state from before this code shipped), clean up.
    const { autoSyncEnabled } = await _storageGet(['autoSyncEnabled']);
    if (autoSyncEnabled === false) {
      await chrome.alarms.clear(ALARM_NAME);
      _status.nextWeeklyRun = null;
    } else {
      _status.nextWeeklyRun = new Date(alarm.scheduledTime).toISOString();
    }
  } else {
    await _scheduleIfEnabled();
  }
});
