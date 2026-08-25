// popup.js — Canvas Sync popup logic. No framework, no build step. Vanilla JS.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Single source of truth for the user-facing data-folder path. There used to be
// a second, contradictory constant further down (_DATA_ROOT_DISPLAY), so "Copy
// data folder path" handed out a path that does not exist on installs whose
// root is the default ~/canvas-sync-data — which is every install the desktop
// app provisions.
// OPEN: the bridge knows the real root; plumbing it through the handshake would
// make this exact rather than conventional.
const DATA_FOLDER_PATH = '~/canvas-sync-data';
// Poll cadence while the popup is open. 5 s is fast enough for live progress
// without spamming the bridge with health probes. Polling stops automatically
// when the popup closes (the timer dies with the popup's window context).
const POLL_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------

const $statusHeader    = document.getElementById('status-header');
const $statusIcon      = document.getElementById('status-icon');
const $statusLabel     = document.getElementById('status-label');
const $lastSync        = document.getElementById('last-sync');
const $lastReason      = document.getElementById('last-reason');
const $nextWeekly      = document.getElementById('next-weekly');
const $coursesTracked  = document.getElementById('courses-tracked');
const $bridgeStatus    = document.getElementById('bridge-status');
const $setupSection    = document.getElementById('setup-section');
const $installToken    = document.getElementById('install-token');
const $connectBtn      = document.getElementById('connect-btn');
const $connectError    = document.getElementById('connect-error');
const $repairLink      = document.getElementById('repair-link-wrap');
const $repairBtn       = document.getElementById('repair-btn');
const $lastError       = document.getElementById('last-error');
const $forceSyncBtn    = document.getElementById('force-sync-btn');
const $fullViewBtn     = document.getElementById('full-view-btn');
const $syncProgress    = document.getElementById('sync-progress');
const $copyPathBtn     = document.getElementById('copy-path-btn');
const $copyConfirm     = document.getElementById('copy-confirm');
const $logsToggleBtn   = document.getElementById('logs-toggle-btn');
const $logsSection     = document.getElementById('logs-section');
const $logsList        = document.getElementById('logs-list');

// v1.1 — tracked classes section (read-only; edit via Manage courses page)
const $classesList     = document.getElementById('classes-list');
const $classesEmpty    = document.getElementById('classes-empty');
const $editClassesBtn  = document.getElementById('edit-classes-btn');

// v1.1 — auto-sync pause toggle
const $autoSyncToggle  = document.getElementById('auto-sync-toggle');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _relativeTime(isoString) {
  if (!isoString) return '—';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (mins  < 1)   return 'just now';
  if (mins  < 60)  return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  return `${days}d ago`;
}

function _formatDateTime(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function _showEl(el)  { el.classList.remove('hidden'); }
function _hideEl(el)  { el.classList.add('hidden'); }

function _setStatusHeader(state, label) {
  $statusHeader.className = 'status-header';
  const classMap = {
    ok:      'status-ok',
    warn:    'status-warn',
    off:     'status-off',
    info:    'status-info',
    unknown: 'status-unknown',
  };
  $statusHeader.classList.add(classMap[state] ?? 'status-unknown');

  // A drawn mark, not a bracketed word: the dot inherits the state's hue from
  // the header class, the same way the dashboard's bridge dot says it. Warn
  // keeps a bare "!" \u2014 the one state where the mark should interrupt.
  const symbolMap = {
    ok:      '\u25cf',
    warn:    '!',
    off:     '\u25cf',
    info:    '\u25cf',
    unknown: '',
  };
  $statusIcon.textContent  = symbolMap[state] ?? '';
  $statusLabel.textContent = label;
}

// ---------------------------------------------------------------------------
// Status rendering
// ---------------------------------------------------------------------------

function _renderStatus(status) {
  const {
    lastSync, lastSyncReason, coursesTracked,
    bridgeReachable, authStatus, nextWeeklyRun, lastError,
    autoSyncEnabled, hasSecret,
  } = status;

  // Pairing state comes from the background's authoritative `hasSecret` flag.
  // It used to be inferred as `!bridgeReachable && ... && !lastSync`, which
  // hid the token field in the one case that needs it most: bridge UP but
  // extension unpaired (reloading an unpacked extension wipes storage). That
  // left users with no way to re-pair. Older background builds don't send the
  // field, so `undefined` falls back to the previous heuristic.
  const setupIncomplete = hasSecret === undefined
    ? (!bridgeReachable && authStatus === 'unknown' && !lastSync)
    : !hasSecret;
  const paused = autoSyncEnabled === false;

  // The class list renders independently of status, so hand it the pairing
  // state — its empty message told unpaired users to "run a sync first", which
  // is the one thing that cannot work before pairing.
  if (_pairingNeeded !== setupIncomplete) {
    _pairingNeeded = setupIncomplete;
    _renderTrackedClasses();
  }

  if (setupIncomplete) {
    _setStatusHeader('warn', bridgeReachable ? 'Pairing needed' : 'Setup incomplete');
    _showEl($setupSection);
  } else {
    _hideEl($setupSection);

    if (!bridgeReachable) {
      _setStatusHeader('off', 'Bridge offline');
    } else if (authStatus === 'expired') {
      _setStatusHeader('warn', 'Canvas login needed');
    } else if (paused) {
      _setStatusHeader('off', 'Auto-sync paused');
    } else {
      _setStatusHeader('ok', 'Auto-sync on');
    }
  }

  // Re-pair escape hatch: always available once paired, so a user whose secret
  // stops being accepted (bridge re-keyed, force-unpaired, secret rotated) can
  // recover from inside the popup instead of being stuck.
  if ($repairLink) {
    if (setupIncomplete) _hideEl($repairLink); else _showEl($repairLink);
  }

  // Surface the last failure. Suppressed while the setup panel is up, where the
  // pairing instructions are the more useful message.
  if ($lastError) {
    if (lastError && !setupIncomplete) {
      $lastError.textContent = lastError;
      _showEl($lastError);
    } else {
      _hideEl($lastError);
    }
  }

  if (lastSync) {
    $lastSync.textContent = _relativeTime(lastSync);
    $lastSync.title       = new Date(lastSync).toLocaleString();
  } else {
    $lastSync.textContent = '—';
    $lastSync.removeAttribute('title');
  }
  $lastReason.textContent = lastSyncReason ?? '—';
  $nextWeekly.textContent = paused
    ? 'Paused'
    : (nextWeeklyRun ? _formatDateTime(nextWeeklyRun) : '—');
  $coursesTracked.textContent = coursesTracked != null ? String(coursesTracked) : '—';

  $bridgeStatus.textContent  = bridgeReachable ? 'Online' : 'Offline';
  $bridgeStatus.className    = 'value ' + (bridgeReachable ? 'online' : 'offline');

  // Reflect toggle state without firing the change listener.
  if ($autoSyncToggle && document.activeElement !== $autoSyncToggle) {
    $autoSyncToggle.checked = !paused;
  }
}

// ---------------------------------------------------------------------------
// Message to background
// ---------------------------------------------------------------------------

function _sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

async function _fetchStatus() {
  const status = await _sendMessage({ type: 'GET_STATUS' });
  if (status) {
    _renderStatus(status);
    _setSyncButton(status.cancelling ? 'cancelling' : status.syncing ? 'syncing' : 'idle');
  }
}

// The one button is Force sync when idle, Cancel sync while running.
let _syncBtnMode = 'idle';
function _setSyncButton(mode) {
  _syncBtnMode = mode;
  if (mode === 'syncing') {
    $forceSyncBtn.textContent = 'Cancel sync';
    $forceSyncBtn.classList.add('btn-danger');
    $forceSyncBtn.disabled = false;
  } else if (mode === 'cancelling') {
    $forceSyncBtn.textContent = 'Cancelling…';
    $forceSyncBtn.classList.add('btn-danger');
    $forceSyncBtn.disabled = true;
  } else {
    $forceSyncBtn.textContent = 'Force sync now';
    $forceSyncBtn.classList.remove('btn-danger');
    $forceSyncBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Progress listener (from background SYNC_PROGRESS broadcasts)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'SYNC_PROGRESS') return;
  const { phase, error, courseId, name, courseCount } = message;

  if (phase === 'start') {
    $syncProgress.textContent = 'Starting sync...';
    _showEl($syncProgress);
    _setSyncButton('syncing');
  } else if (phase === 'courses') {
    const count = message.count;
    $syncProgress.textContent = count != null
      ? `Found ${count} courses. Fetching data...`
      : 'Fetching courses...';
  } else if (phase === 'course') {
    $syncProgress.textContent = `Syncing: ${name ?? courseId}`;
  } else if (phase === 'course-done') {
    $syncProgress.textContent = `Done: ${courseId}`;
  } else if (phase === 'complete') {
    $syncProgress.textContent = `Sync complete — ${courseCount ?? '?'} courses.`;
    _setSyncButton('idle');
    // Refresh status after short delay
    setTimeout(_fetchStatus, 500);
  } else if (phase === 'cancelling') {
    $syncProgress.textContent = 'Cancelling…';
    _setSyncButton('cancelling');
  } else if (phase === 'cancelled') {
    $syncProgress.textContent = 'Sync cancelled.';
    _setSyncButton('idle');
    setTimeout(_fetchStatus, 500);
  } else if (phase === 'error') {
    $syncProgress.textContent = `Error: ${error}`;
    _setSyncButton('idle');
    setTimeout(_fetchStatus, 500);
  }
});

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

$fullViewBtn.addEventListener('click', () => {
  const url = chrome.runtime.getURL('progress.html');
  chrome.tabs.create({ url });
  window.close();
});

document.getElementById('manage-courses-btn').addEventListener('click', () => {
  const url = chrome.runtime.getURL('courses.html');
  chrome.tabs.create({ url });
  window.close();
});

document.getElementById('history-btn').addEventListener('click', () => {
  const url = chrome.runtime.getURL('progress.html') + '#history';
  chrome.tabs.create({ url });
  window.close();
});

$forceSyncBtn.addEventListener('click', async () => {
  if (_syncBtnMode === 'cancelling') return;
  if (_syncBtnMode === 'syncing') {
    _setSyncButton('cancelling');
    $syncProgress.textContent = 'Cancelling…';
    _showEl($syncProgress);
    await _sendMessage({ type: 'CANCEL_SYNC' });
    return;
  }
  _setSyncButton('syncing');
  $syncProgress.textContent = 'Requesting sync...';
  _showEl($syncProgress);
  const res = await _sendMessage({ type: 'FORCE_SYNC' });
  if (res && res.alreadyRunning) {
    $syncProgress.textContent = 'A sync is already running.';
  }
  // Progress updates come via SYNC_PROGRESS messages above
});

$copyPathBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(DATA_FOLDER_PATH);
    _showEl($copyConfirm);
    setTimeout(() => _hideEl($copyConfirm), 2_000);
  } catch {
    // Clipboard API may fail if popup loses focus
    $copyConfirm.textContent = 'Copy failed — path: ' + DATA_FOLDER_PATH;
    _showEl($copyConfirm);
  }
});

$logsToggleBtn.addEventListener('click', async () => {
  const isHidden = $logsSection.classList.contains('hidden');
  if (isHidden) {
    await _loadLogs();
    _showEl($logsSection);
    $logsToggleBtn.textContent = 'Hide logs';
  } else {
    _hideEl($logsSection);
    $logsToggleBtn.textContent = 'View logs';
  }
});

$connectBtn.addEventListener('click', async () => {
  const token = $installToken.value.trim();
  if (!token) {
    $connectError.textContent = 'Paste the install token first.';
    _showEl($connectError);
    return;
  }
  _hideEl($connectError);
  $connectBtn.disabled = true;
  $connectBtn.textContent = 'Connecting...';

  const response = await _sendMessage({ type: 'HANDSHAKE', installToken: token });
  $connectBtn.disabled = false;
  $connectBtn.textContent = 'Connect';

  if (response?.ok) {
    $installToken.value = '';
    await _fetchStatus();
  } else {
    const raw = response?.error ?? '';
    // Translate the bridge's terse rejections into something a user can act on.
    // "already paired" in particular is a dead end otherwise: the bridge is
    // pinned to a previous install and only a forced token can dislodge it.
    let msg;
    if (/already paired/i.test(raw)) {
      msg = 'The bridge is still paired to a previous install. In the CANVASync app open '
          + 'Settings → Pair a Chrome extension and confirm generating a NEW token, then paste it here.';
    } else if (/expired/i.test(raw)) {
      msg = 'That token expired (they last 10 minutes). Generate a fresh one in the app and paste it here.';
    } else if (/invalid token/i.test(raw)) {
      msg = 'That token was not accepted. Copy the newest token from the app — each one can only be used once.';
    } else if (/no install token/i.test(raw)) {
      msg = 'The bridge has no pending token. Generate one in the app: Settings → Pair a Chrome extension.';
    } else {
      msg = raw || 'Connection failed. Check the bridge is running.';
    }
    $connectError.textContent = msg;
    _showEl($connectError);
  }
});

// Re-pair: reveal the token field on demand, even while a secret is stored.
if ($repairBtn) {
  $repairBtn.addEventListener('click', () => {
    _showEl($setupSection);
    _hideEl($repairLink);
    _hideEl($connectError);
    $installToken.focus();
  });
}

// Enter submits the token — the field is the only input in that panel.
$installToken.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$connectBtn.disabled) $connectBtn.click();
});

// ---------------------------------------------------------------------------
// Logs rendering
// ---------------------------------------------------------------------------

async function _loadLogs() {
  const data = await new Promise(resolve => {
    chrome.storage.local.get(['logs'], resolve);
  });
  const logs  = Array.isArray(data.logs) ? data.logs : [];
  const recent = logs.slice(-20).reverse();

  $logsList.innerHTML = '';
  if (recent.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No log entries yet.';
    $logsList.appendChild(li);
    return;
  }

  for (const entry of recent) {
    const li = document.createElement('li');
    li.className = `level-${entry.level ?? 'info'}`;
    const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '';
    li.textContent = `${ts} [${(entry.level ?? 'info').toUpperCase()}] ${entry.message}`;
    $logsList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// v1.1 — Tracked classes section
// ---------------------------------------------------------------------------

// Mirror of bridge/storage.js slugifyCourseCode. Popup-side so the confirm
// dialog can show the exact folder path. Kept in sync with background.js's
// copy (both MUST match bridge/storage.js).
function _slugifyCourseCode(code) {
  if (!code || typeof code !== 'string') return null;
  return code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function _folderNameFor(course) {
  const slug = _slugifyCourseCode(course?.course_code) || `course-${course?.id}`;
  return `${course?.id}-${slug}`;
}

// Same path the "Copy data folder path" button uses — see DATA_FOLDER_PATH.
const _DATA_ROOT_DISPLAY = DATA_FOLDER_PATH;

// Read-only view. Selection + hard-delete live on courses.html.
let _trackedState = { courses: [] };
// Mirrors the setup panel's visibility; see _renderStatus.
let _pairingNeeded = false;

async function _loadTrackedClasses() {
  const resp = await _sendMessage({ type: 'GET_TRACKED_CLASSES' });
  if (!resp || !resp.ok) {
    _renderTrackedClasses();
    return;
  }
  _trackedState.courses = Array.isArray(resp.courses) ? resp.courses : [];
  _renderTrackedClasses();
}

function _renderTrackedClasses() {
  const { courses } = _trackedState;
  $classesList.innerHTML = '';

  if (!courses.length) {
    $classesEmpty.textContent = _pairingNeeded
      ? 'Not paired yet — enter an install token to start syncing.'
      : 'No courses cached — run a sync first.';
    _showEl($classesEmpty);
    return;
  }
  _hideEl($classesEmpty);

  // Alphabetize by course_code for stable visual order.
  const sorted = [...courses].sort((a, b) => {
    const ac = (a.course_code ?? '').toLowerCase();
    const bc = (b.course_code ?? '').toLowerCase();
    return ac.localeCompare(bc);
  });

  for (const course of sorted) {
    const li = document.createElement('li');
    li.className = 'class-row';
    li.dataset.folderName = _folderNameFor(course);

    const code = document.createElement('strong');
    code.className = 'class-code';
    code.textContent = course.course_code ?? `#${course.id}`;

    const name = document.createElement('span');
    name.className = 'class-name';
    name.textContent = course.name ?? '';

    li.appendChild(code);
    li.appendChild(name);
    $classesList.appendChild(li);
  }
}

$editClassesBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('courses.html') });
});

// Auto-sync toggle. Optimistic UI — flip immediately, revert if the message
// fails. Force sync still works when paused; only scheduled syncs are gated.
$autoSyncToggle.addEventListener('change', async () => {
  const wantEnabled = $autoSyncToggle.checked;
  $autoSyncToggle.disabled = true;
  const resp = await _sendMessage({ type: 'SET_AUTO_SYNC', enabled: wantEnabled });
  $autoSyncToggle.disabled = false;
  if (!resp || resp.ok !== true) {
    // Revert UI on failure.
    $autoSyncToggle.checked = !wantEnabled;
    return;
  }
  // Pull a fresh status so the header label + Next-weekly value update.
  _fetchStatus();
});

// Listen for CLASSES_UPDATED broadcasts from the background so multiple
// open popups (rare, but possible) stay in sync.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CLASSES_UPDATED') {
    _loadTrackedClasses();
  }
});

// ---------------------------------------------------------------------------
// Sync schedule settings
// ---------------------------------------------------------------------------

const $scheduleToggleBtn = document.getElementById('schedule-toggle-btn');
const $scheduleForm      = document.getElementById('schedule-form');
const $weeklyEnabled     = document.getElementById('weekly-enabled');
const $weeklyDay         = document.getElementById('weekly-day');
const $weeklyHour        = document.getElementById('weekly-hour');
const $pollHours         = document.getElementById('poll-hours');
const $debounceHours     = document.getElementById('debounce-hours');
const $scheduleSaveBtn   = document.getElementById('schedule-save-btn');
const $scheduleConfirm   = document.getElementById('schedule-confirm');

// Populate the hour select (12-hour labels, 24-hour values).
for (let h = 0; h < 24; h++) {
  const opt = document.createElement('option');
  opt.value = String(h);
  const ampm = h < 12 ? 'AM' : 'PM';
  const disp = h % 12 === 0 ? 12 : h % 12;
  opt.textContent = `${disp}:00 ${ampm}`;
  $weeklyHour.appendChild(opt);
}

async function _loadSyncSettings() {
  const resp = await _sendMessage({ type: 'GET_SYNC_SETTINGS' });
  if (!resp?.ok) return;
  const s = resp.settings;
  $weeklyEnabled.checked = s.weeklyEnabled;
  $weeklyDay.value       = String(s.weeklyDay);
  $weeklyHour.value      = String(s.weeklyHour);
  $pollHours.value       = String([0, 1, 3, 6, 12, 24].includes(s.pollHours) ? s.pollHours : 0);
  $debounceHours.value   = String(s.debounceHours);
}

$scheduleToggleBtn.addEventListener('click', () => {
  const opening = $scheduleForm.classList.contains('hidden');
  $scheduleForm.classList.toggle('hidden');
  $scheduleToggleBtn.textContent = opening ? 'Close' : 'Edit';
  if (opening) _loadSyncSettings();
});

$scheduleSaveBtn.addEventListener('click', async () => {
  $scheduleSaveBtn.disabled = true;
  const resp = await _sendMessage({
    type: 'SET_SYNC_SETTINGS',
    settings: {
      weeklyEnabled: $weeklyEnabled.checked,
      weeklyDay:     Number($weeklyDay.value),
      weeklyHour:    Number($weeklyHour.value),
      pollHours:     Number($pollHours.value),
      debounceHours: Number($debounceHours.value),
    },
  });
  $scheduleSaveBtn.disabled = false;
  if (resp?.ok) {
    $scheduleConfirm.classList.remove('hidden');
    setTimeout(() => $scheduleConfirm.classList.add('hidden'), 1500);
    _fetchStatus(); // refresh "Next weekly" display
  }
});

// ---------------------------------------------------------------------------
// Init + polling
// ---------------------------------------------------------------------------

_fetchStatus();
_loadTrackedClasses();

const _pollTimer = setInterval(_fetchStatus, POLL_INTERVAL_MS);

// Clean up polling when popup is closed
window.addEventListener('unload', () => clearInterval(_pollTimer));
