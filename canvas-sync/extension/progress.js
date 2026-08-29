// progress.js — Full-view sync progress tab.
// Subscribes to SYNC_PROGRESS broadcasts from the background service worker and
// replays any state that exists at load time via GET_PROGRESS_STATE.

import { formatFileCounts } from './sync-support.js';

const ITEM_ORDER = [
  'syllabus', 'assignments', 'groups', 'modules', 'pages',
  'discussions', 'announcements', 'quizzes', 'events',
  'files', 'grades', 'tabs', 'groups_list', 'external_tools', 'course_packs',
  'files_download',
];
const ITEM_LABEL = {
  syllabus:       'Syllabus',
  assignments:    'Assignments',
  groups:         'Assignment groups',
  modules:        'Modules',
  pages:          'Pages',
  discussions:    'Discussions',
  announcements:  'Announcements',
  quizzes:        'Quizzes',
  events:         'Calendar events',
  files:          'Files (listed)',
  grades:         'Grades',
  tabs:           'Course tools',
  groups_list:    'Student groups',
  external_tools: 'External tools',
  course_packs:   'Course packs',
  files_download: 'Files downloaded',
};

const $inProgressList  = document.getElementById('in-progress-list');
const $doneList        = document.getElementById('done-list');
const $inProgressEmpty = document.getElementById('in-progress-empty');
const $doneEmpty       = document.getElementById('done-empty');
const $overallStatus   = document.getElementById('overall-status');
const $startedAt       = document.getElementById('started-at');
const $completedAt     = document.getElementById('completed-at');
const $forceSyncBtn    = document.getElementById('force-sync');
const $historyList     = document.getElementById('history-list');
const $historyEmpty    = document.getElementById('history-empty');
const $clearHistoryBtn = document.getElementById('clear-history');

// Local render state: { courseId: { el, state, ...fields } }
const courseEls = new Map();

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86_400_000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay)   return `Today ${time}`;
  if (yesterday) return `Yesterday ${time}`;
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  return `${date} ${time}`;
}

function fmtDuration(startIso, endIso) {
  if (!startIso || !endIso) return '—';
  const ms = new Date(endIso) - new Date(startIso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function buildCourseCard(course) {
  const el = document.createElement('div');
  el.className = 'course';
  el.dataset.courseId = course.id;

  const header = document.createElement('div');
  header.className = 'course-header';

  const title = document.createElement('div');
  title.className = 'course-title';
  if (course.code) {
    const code = document.createElement('span');
    code.className = 'course-code';
    code.textContent = course.code;
    title.appendChild(code);
  }
  const name = document.createElement('span');
  name.className = 'course-name';
  name.textContent = course.name ?? `Course ${course.id}`;
  title.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'course-meta';
  header.appendChild(title);
  header.appendChild(meta);
  el.appendChild(header);

  const items = document.createElement('div');
  items.className = 'items-grid';
  for (const key of ITEM_ORDER) {
    if (!(key in (course.items ?? {}))) continue;
    const item = document.createElement('div');
    item.className = 'item pending';
    item.dataset.item = key;
    const mark = document.createElement('span');
    mark.className = 'mark';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = ITEM_LABEL[key] ?? key;
    const count = document.createElement('span');
    count.className = 'count';
    item.appendChild(mark);
    item.appendChild(label);
    item.appendChild(count);
    items.appendChild(item);
  }
  el.appendChild(items);

  // Expand/collapse for done courses.
  header.addEventListener('click', () => {
    if (el.classList.contains('done')) {
      el.classList.toggle('expanded');
    }
  });

  return el;
}

function updateItem(courseId, item, status, count, display) {
  const card = courseEls.get(courseId);
  if (!card) return;
  const row = card.querySelector(`.item[data-item="${item}"]`);
  if (!row) return;
  row.classList.remove('pending', 'running', 'done', 'skipped', 'error', 'forbidden');
  row.classList.add(status);
  const $count = row.querySelector('.count');
  if (display) {
    $count.textContent = display;
  } else if (count != null) {
    $count.textContent = String(count);
  } else if (status === 'skipped') {
    $count.textContent = 'none';
  } else if (status === 'forbidden') {
    $count.textContent = 'no access';
  } else {
    $count.textContent = '';
  }
}

function moveToDone(courseId, completedAtIso) {
  const card = courseEls.get(courseId);
  if (!card) return;
  card.classList.add('done');

  // Append a finish timestamp in the header (once).
  const iso = completedAtIso ?? new Date().toISOString();
  const meta = card.querySelector('.course-meta');
  if (meta && !meta.dataset.finished) {
    meta.dataset.finished = iso;
    meta.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'course-finished';
    span.textContent = `finished ${fmtTime(iso)}`;
    span.title = new Date(iso).toLocaleString();
    meta.appendChild(span);
  }

  $doneList.appendChild(card);
  $doneEmpty.style.display = 'none';
  refreshEmptyState();
}

function markCourseError(courseId, errMsg) {
  const card = courseEls.get(courseId);
  if (!card) return;
  card.classList.add('error');
  let $err = card.querySelector('.error-msg');
  if (!$err) {
    $err = document.createElement('div');
    $err.className = 'error-msg';
    card.appendChild($err);
  }
  $err.textContent = errMsg;
}

function refreshEmptyState() {
  $inProgressEmpty.style.display = $inProgressList.children.length === 0 ? '' : 'none';
  $doneEmpty.style.display       = $doneList.children.length === 0 ? '' : 'none';
}

function renderCourseStart(course) {
  // If we already have the card, keep it; otherwise build fresh.
  let card = courseEls.get(course.id);
  if (!card) {
    card = buildCourseCard(course);
    courseEls.set(course.id, card);
  }
  $inProgressList.appendChild(card);
  refreshEmptyState();

  // Replay any item statuses that came in before the card mounted.
  for (const [item, v] of Object.entries(course.items ?? {})) {
    if (v.status && v.status !== 'pending') {
      updateItem(course.id, item, v.status, v.count, v.display);
    }
  }
}

function replay(state) {
  if (!state || !state.courses) return;
  if (state.reason) $overallStatus.textContent = `Sync in progress (${state.reason})`;
  if (state.startedAt)   $startedAt.textContent   = `Started ${fmtTime(state.startedAt)}`;
  if (state.completedAt) $completedAt.textContent = `Finished ${fmtTime(state.completedAt)}`;

  for (const course of Object.values(state.courses)) {
    renderCourseStart(course);
    if (course.state === 'done') {
      moveToDone(course.id, course.completedAt);
    } else if (course.state === 'error') {
      markCourseError(course.id, course.error ?? 'Unknown error');
    }
  }

  if (state.phase === 'complete') {
    $overallStatus.textContent = `Sync complete — ${state.courseCount ?? '?'} courses`;
  } else if (state.phase === 'error') {
    $overallStatus.textContent = `Sync error: ${state.error}`;
  }
}

function handleEvent(msg) {
  if (msg.type !== 'SYNC_PROGRESS') return;

  switch (msg.phase) {
    case 'start':
      $overallStatus.textContent = `Sync starting (${msg.reason})`;
      $startedAt.textContent     = `Started ${fmtTime(new Date().toISOString())}`;
      $completedAt.textContent   = '';
      $inProgressList.innerHTML  = '';
      $doneList.innerHTML        = '';
      courseEls.clear();
      refreshEmptyState();
      break;

    case 'courses':
      if (msg.count != null) {
        $overallStatus.textContent = `Fetching ${msg.count} courses…`;
      }
      break;

    case 'course-start':
      renderCourseStart({
        id:    msg.courseId,
        name:  msg.name,
        code:  msg.code,
        items: Object.fromEntries((msg.items ?? []).map(i => [i, { status: 'pending' }])),
      });
      break;

    case 'course-item':
      updateItem(msg.courseId, msg.item, msg.status, msg.count, msg.display);
      break;

    case 'course-done':
      moveToDone(msg.courseId, new Date().toISOString());
      break;

    case 'course-error':
      markCourseError(msg.courseId, msg.error);
      break;

    case 'complete':
      $overallStatus.textContent = `Sync complete — ${msg.courseCount ?? '?'} courses`;
      $completedAt.textContent   = `Finished ${fmtTime(new Date().toISOString())}`;
      loadHistory();
      break;

    case 'error':
      $overallStatus.textContent = `Sync error: ${msg.error}`;
      $completedAt.textContent   = `Failed ${fmtTime(new Date().toISOString())}`;
      loadHistory();
      break;
  }
}

chrome.runtime.onMessage.addListener(handleEvent);

// Guarded force-sync. The bare handler had no disabled state and discarded the
// response, so rapid clicks each launched a full sync and the background's
// "already running" refusal was invisible — which is how three syncs ended up
// firing inside one minute.
let _forceInFlight = false;
$forceSyncBtn.addEventListener('click', () => {
  if (_forceInFlight) return;
  _forceInFlight = true;

  const original = $forceSyncBtn.textContent;
  $forceSyncBtn.disabled = true;
  $forceSyncBtn.textContent = 'Starting…';

  const release = (label) => {
    $forceSyncBtn.textContent = label ?? original;
    if (label) setTimeout(() => { $forceSyncBtn.textContent = original; }, 2500);
    $forceSyncBtn.disabled = false;
    _forceInFlight = false;
  };

  chrome.runtime.sendMessage({ type: 'FORCE_SYNC' }, (response) => {
    if (chrome.runtime.lastError) return release('Not available');
    if (response?.alreadyRunning) return release('Already running');
    release();
  });
});

function renderHistory(history) {
  $historyList.innerHTML = '';
  if (!Array.isArray(history) || history.length === 0) {
    $historyEmpty.style.display = '';
    $clearHistoryBtn.hidden = true;
    return;
  }
  $historyEmpty.style.display = 'none';
  $clearHistoryBtn.hidden = false;

  // Newest first.
  const ordered = [...history].reverse();
  for (const entry of ordered) {
    const li = document.createElement('li');
    li.className = 'history-item' + (entry.phase === 'error' ? ' error' : '');

    const when = document.createElement('span');
    when.className = 'history-when';
    when.textContent = fmtDateTime(entry.completedAt ?? entry.startedAt);
    when.title = `Started ${fmtTime(entry.startedAt)}\nFinished ${fmtTime(entry.completedAt)}`;

    const dur = document.createElement('span');
    dur.className = 'history-dur';
    dur.textContent = fmtDuration(entry.startedAt, entry.completedAt);

    const status = document.createElement('span');
    status.className = 'history-status';
    status.textContent = entry.phase === 'error' ? 'failed' : 'ok';

    const detail = document.createElement('span');
    detail.className = 'history-detail';
    const reasonTxt = entry.reason ? entry.reason : '';
    if (entry.phase === 'error') {
      detail.textContent = `${entry.courseCount ?? 0} ok · ${reasonTxt}`.trim();
    } else {
      detail.textContent = `${entry.courseCount ?? '?'} courses · ${reasonTxt}`.trim();
    }

    li.appendChild(when);
    li.appendChild(dur);
    li.appendChild(status);
    li.appendChild(detail);
    // Per-run coverage, when the run has something to admit. Same sentence the
    // popup shows, so "3 not permitted" means one thing in both places.
    const coverage = formatFileCounts(entry.files);
    if (coverage) {
      const cov = document.createElement('div');
      cov.className = 'history-coverage';
      cov.textContent = coverage;
      li.appendChild(cov);
    }

    $historyList.appendChild(li);
  }
}

function loadHistory() {
  chrome.runtime.sendMessage({ type: 'GET_SYNC_HISTORY' }, (resp) => {
    if (chrome.runtime.lastError) return;
    renderHistory(resp?.history ?? []);
  });
}

$clearHistoryBtn.addEventListener('click', () => {
  if (!confirm('Clear all past sync entries?')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_SYNC_HISTORY' }, () => loadHistory());
});

// Replay existing state on load so a late-opened tab shows the current sync.
chrome.runtime.sendMessage({ type: 'GET_PROGRESS_STATE' }, (state) => {
  if (chrome.runtime.lastError) return;
  replay(state);
});

loadHistory();

// If opened with #history, scroll to the past-syncs panel after initial render.
if (window.location.hash === '#history') {
  setTimeout(() => {
    const panel = document.getElementById('history-panel');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 150);
}
