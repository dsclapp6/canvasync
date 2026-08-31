// CANVASync dashboard. Runs in the Electron shell (window.canvasync injected
// by its preload) or any browser at http://127.0.0.1:3847/app.

'use strict';

// Week and Month view date arithmetic. A module import, which is why index.html
// loads this file with type="module": grid maths that lives inside a render
// function cannot be tested, and off-by-one-day is the failure mode of every
// calendar ever written. bridge/test/cal-grid.test.js pins 28 cases against it.
import {
  addDays, addMonths, bucketByDate, dayHeadLabel, dueTier, initialAnchor,
  monthGrid, monthLabel, relPhrase, sortDayOps, startOfMonth, startOfWeek,
  todayIso, weekDays, weekLabel, WEEKDAY_HEADS,
  daysBetween, spanDates, spanPosition, orderedRange, movedDates, resizedDates,
  timeWindow, hourMarks, layoutDay,
  partitionDenseSlots, MIN_BLOCK_MIN, MAX_LANES, laneBudgetFor,
} from './cal-grid.js';
import { nextSelection, isSelected, pruneSelection, isAiItemVisible } from './cal-plan.js';
import {
  fileName, filePreviewPlan, groupFilesBySource, originDetail, originHeading, primaryOrigin,
} from './file-plan.js';
import { renderMarkdown, renderReadableText } from './content-format.js';
import { taskTitleHtml } from './task-links.js';

const $ = (id) => document.getElementById(id);
const IS_APP = !!window.canvasync;

let SECRET = null;
let CLASSES = [];
let CURRENT = null; // current class detail payload

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function api(pathname, opts = {}) {
  const res = await fetch(pathname, {
    ...opts,
    headers: {
      'X-Bridge-Secret': SECRET,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) {
    // The BODY carries the reason the routes go to trouble to write ("start
    // and end must both be HH:MM with end after start"); the status line
    // carries only "400 Bad Request". Callers show err.message, so the reason
    // belongs there, with the status as the fallback for a non-JSON failure.
    let reason = '';
    try {
      const body = await res.clone().json();
      reason = body?.error || body?.detail || '';
      if (body?.error && body?.detail && body.error !== body.detail) reason = `${body.error} — ${body.detail}`;
    } catch { /* not JSON — the status line is all there is */ }
    const err = new Error(reason || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res;
}
const apiJson = (p, o) => api(p, o).then(r => r.json());

// Switching views by clicking the real button keeps wireNav's bookkeeping —
// active class, lazy loads — in one place instead of two.
function navTo(view) {
  const btn = document.querySelector(`.nav-btn[data-view="${view}"]`);
  if (btn && !btn.classList.contains('active')) btn.click();
}

function showClassDashboard() {
  navTo('classes');
  document.querySelectorAll('#class-list li').forEach(li => li.classList.remove('active'));
  showClassesPanel('class-home');
  const detail = document.querySelector('#view-classes > .detail');
  if (detail) detail.scrollTop = 0;
}

// The Classes view is a sidebar plus exactly one right-hand panel. Every route
// out of it has to leave one of them showing, and one route did not: opening an
// assignment from the Calendar and pressing Back hid the assignment page and
// returned to the Calendar without restoring anything, so the next visit to
// Classes was 475px of empty cream that only clicking a class could recover.
// The invariant lives here rather than at each exit, so a future exit path
// cannot strand the pane either.
const CLASSES_PANELS = ['detail', 'class-home', 'picker-panel', 'cleanup-panel', 'assignment-panel', 'file-panel'];

function showClassesPanel(id) {
  CLASSES_PANELS.forEach(p => $(p).classList.toggle('hidden', p !== id));
  // The Ask rail is part of the class page, so it comes and goes with it.
  // Hooked here rather than at each call site for the same reason the hidden
  // toggles are: a future panel switch cannot forget to do it.
  renderChat();
}

// Whatever just happened, leave the pane showing something: the open class if
// there is one, the home page if there is not.
function ensureClassesPanel() {
  if (CLASSES_PANELS.some(p => !$(p).classList.contains('hidden'))) return;
  showClassesPanel(CURRENT ? 'detail' : 'class-home');
}

// A one-line failure notice. In a desktop app an error logged to the console is
// an error nobody sees.
let _toastTimer = null;
function toast(msg) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
}

// Canvas sends full ISO timestamps. fmtDue works on the mined date/time split,
// so the assignment page needs its own.
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function esc(s) {
  // Escapes the full set, including both quote characters. Every innerHTML
  // sink assembled in this file routes untrusted values through esc().
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Boot + auth
// ---------------------------------------------------------------------------

// Sets SECRET only for the duration of the probe, restoring it if the probe
// fails — otherwise a rejected value stayed in the global and got persisted by
// the caller, leaving the dashboard authenticated with a secret that does not
// work.
async function tryConnect(secret) {
  const previous = SECRET;
  SECRET = secret;
  try {
    return await apiJson('/api/status');
  } catch (err) {
    SECRET = previous;
    throw err;
  }
}

async function boot() {
  let status = null;

  if (IS_APP) {
    try { status = await tryConnect(await window.canvasync.getSecret()); } catch {}
  }
  if (!status && localStorage.getItem('bridgeSecret')) {
    try { status = await tryConnect(localStorage.getItem('bridgeSecret')); } catch {}
  }

  if (!status) {
    $('auth-gate').classList.remove('hidden');

    const btn = $('auth-connect');
    const field = $('auth-secret');
    let connecting = false;

    const showError = (msg) => {
      $('auth-error').textContent = msg;
      $('auth-error').classList.remove('hidden');
    };

    const attempt = async () => {
      // In-flight guard: without it a double-click ran start() twice, which
      // re-registered every listener and started a second 10s status poller.
      if (connecting) return;

      const candidate = field.value.trim();
      // The secret is 32 random bytes rendered as hex. Catching the obvious
      // shape locally turns "Could not connect" into an answerable message —
      // pasting a 32-char install token here was a real, silent dead end.
      if (!/^[0-9a-f]{64}$/i.test(candidate)) {
        showError(candidate.length === 0
          ? 'Paste the bridge secret to connect.'
          : `That does not look like the bridge secret — expected 64 hex characters, got ${candidate.length}. `
            + 'It is the "bridgeSecret" value in config.json (not an install token).');
        return;
      }

      connecting = true;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'Connecting…';
      try {
        status = await tryConnect(candidate);
        // Persist the value that actually worked, not the module global.
        localStorage.setItem('bridgeSecret', candidate);
        $('auth-gate').classList.add('hidden');
        start(status);
      } catch (err) {
        // api() distinguishes these; the old catch discarded the difference and
        // showed one message for two very different problems.
        showError(err?.message === 'unauthorized'
          ? 'The bridge rejected that secret. Copy "bridgeSecret" from config.json in your data folder.'
          : 'Could not reach the bridge. Make sure CANVASync is running, then try again.');
        btn.disabled = false;
        btn.textContent = label;
        connecting = false;
      }
    };

    btn.addEventListener('click', attempt);
    // The field sits in a bare div, not a form, so Enter did nothing at all.
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
    return;
  }
  start(status);
}

function start(status) {
  $('shell').classList.remove('hidden');
  $('bridge-dot').classList.add('ok');
  if (IS_APP) document.querySelectorAll('.app-only').forEach(el => el.classList.remove('hidden'));
  renderBridgeInfo(status);
  loadClasses();
  wireNav();
  wireSettings();
  renderPipelineButton(status.pipeline);
  setInterval(async () => {
    try {
      const st = await apiJson('/api/status');
      $('bridge-dot').classList.add('ok');
      renderBridgeInfo(st);
      renderPipelineButton(st.pipeline);
    } catch { $('bridge-dot').classList.remove('ok'); }
  }, 10000);
}

// The status line, including the one fact the payload always carried and the
// page never showed: the kill switch. With <data root>/DISABLED present the
// bridge 503s every ingest and every pipeline start, and the dashboard said
// nothing at all — "Rebuild summaries" simply did nothing, twice, forever.
function renderBridgeInfo(status) {
  const bits = [`Bridge v${status.version}`, `data root ${status.home}`,
    status.paired ? 'extension paired' : 'no extension paired yet'];
  $('bridge-info').textContent = bits.join(' · ');
  const dot = $('bridge-dot');
  dot.classList.toggle('disabled', !!status.disabled);
  dot.title = status.disabled ? 'Bridge disabled by the DISABLED file' : '';
  let note = $('bridge-disabled');
  if (status.disabled) {
    if (!note) {
      note = document.createElement('span');
      note.id = 'bridge-disabled';
      note.className = 'badge alarm';
      $('bridge-info').after(note);
    }
    // Names the one fix, as an empty/blocked state must.
    note.textContent = `Switched off — delete ${status.home}/DISABLED to re-enable`;
  } else if (note) {
    note.remove();
  }
}

// One button: "Rebuild summaries" when idle, "Cancel pipeline" while running.
let _pipelineRunning = false;
function renderPipelineButton(pipeline) {
  const running = !!pipeline?.running;
  _pipelineRunning = running;
  const btn = $('run-pipeline-btn');
  btn.disabled = false;
  if (running) {
    const n = pipeline.active?.length ?? 0;
    btn.textContent = n ? `Cancel pipeline (${n} running)` : 'Cancel pipeline';
    btn.classList.add('danger');
    btn.title = pipeline.active?.join(', ') || 'Stop running and queued pipeline jobs';
  } else {
    btn.textContent = 'Rebuild summaries';
    btn.classList.remove('danger');
    btn.title = 'Run every stale pipeline part over synced data';
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function wireNav() {
  $('home-btn').addEventListener('click', showClassDashboard);
  $('detail-home').addEventListener('click', showClassDashboard);

  document.querySelectorAll('.nav-btn').forEach(btn => {
    // The Status link is a plain anchor styled as a nav button — no
    // data-view. Binding the view-switcher to it hid every view and then
    // threw on #view-undefined, so a Cmd/Ctrl-click (new tab) left the
    // ORIGINAL tab an empty shell with Status highlighted.
    if (!btn.dataset.view) return;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
      $(`view-${btn.dataset.view}`).classList.remove('hidden');
      // Classes is the one view with swappable right-hand panels; make sure
      // arriving there always finds one of them showing.
      if (btn.dataset.view === 'classes') ensureClassesPanel();
      if (btn.dataset.view === 'calendar') loadCalendar();
      // Activity is no longer a destination of its own — it is a diagnostic,
      // and it now loads with the rest of Settings.
      if (btn.dataset.view === 'settings') { loadSettings(); loadLogs().catch(() => {}); }
    });
  });

  $('run-pipeline-btn').addEventListener('click', async () => {
    const btn = $('run-pipeline-btn');
    btn.disabled = true;
    // Say it when it fails. A bare `catch {}` here meant a 503 from the kill
    // switch looked exactly like success: "Starting…" for three seconds, then
    // the label reset and nothing had happened.
    if (_pipelineRunning) {
      btn.textContent = 'Cancelling…';
      try { await apiJson('/api/pipeline/cancel', { method: 'POST', body: '{}' }); }
      catch (e) { toast(`Could not cancel: ${e.message}`); }
    } else {
      btn.textContent = 'Starting…';
      try { await apiJson('/api/pipeline/run', { method: 'POST', body: '{}' }); }
      catch (e) { toast(`Could not start: ${e.message}`); }
    }
    setTimeout(async () => {
      try { renderPipelineButton((await apiJson('/api/status')).pipeline); } catch { btn.disabled = false; }
      loadClasses();
    }, 3000);
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      $(`tab-${tab.dataset.tab}`).classList.remove('hidden');
    });
  });

  // Sidebar scope toggle — "Current" is the default; "All" is the escape hatch.
  document.querySelectorAll('#class-scope .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      CLASS_SCOPE = btn.dataset.scope;
      localStorage.setItem('classScope', CLASS_SCOPE);
      renderClassList();
      renderHome();
    });
  });

  wireTasks();
  wireTextbooks();
  wireHome();
  wireMeetingTimes();
  wireAssignment();
  wireFileView();
  wireClassColors();

  $('picker-open').addEventListener('click', openPicker);
  $('picker-close').addEventListener('click', closePicker);
  $('picker-save').addEventListener('click', savePicker);
  $('picker-none').addEventListener('click', () => {
    document.querySelectorAll('#picker-list input[type=checkbox]').forEach(el => { el.checked = false; });
    renderPickerCount();
  });
  $('picker-current').addEventListener('click', () => {
    // "Current term" = the latest term whose parsed label is NOT after today
    // — never simply the newest group: an early-registered Spring 2027 shell
    // has newer course ids than the Fall 2026 the student is sitting in, and
    // "newest first" saved next spring as the strict allowlist.
    const cur = currentTermGroup(groupEnrolledByTerm(PICKER.enrolled ?? []));
    const ids = new Set((cur?.courses ?? []).map(c => String(c.courseId)));
    document.querySelectorAll('#picker-list input[type=checkbox]').forEach(el => { el.checked = ids.has(el.value); });
    renderPickerCount();
  });

  $('cleanup-open').addEventListener('click', openCleanup);
  $('cleanup-close').addEventListener('click', closeCleanup);
  $('cleanup-go').addEventListener('click', runCleanup);
  $('cleanup-all').addEventListener('click', () => {
    document.querySelectorAll('#cleanup-list input[type=checkbox]').forEach(el => { el.checked = true; });
    renderCleanupActions();
  });
  $('cleanup-none').addEventListener('click', () => {
    document.querySelectorAll('#cleanup-list input[type=checkbox]').forEach(el => { el.checked = false; });
    renderCleanupActions();
  });

  // Grouping persists, so the shape a user prefers survives a reload. Scoped to
  // the seg that carries a group: the view seg is also made of .seg-btn and
  // lives in the same toolbar.
  document.querySelectorAll('#cal-toolbar .seg-btn[data-group]').forEach(btn => {
    btn.addEventListener('click', () => {
      CAL_GROUP = btn.dataset.group;
      localStorage.setItem('calGroup', CAL_GROUP);
      btn.parentElement.querySelectorAll('.seg-btn')
        .forEach(b => b.classList.toggle('active', b === btn));
      renderCalendarOps();
    });
  });
  document.querySelectorAll('#cal-toolbar .seg-btn[data-group]')
    .forEach(b => b.classList.toggle('active', b.dataset.group === CAL_GROUP));

  // The kind filters. Delegated, because renderCalKinds() rebuilds them.
  $('cal-kind-filters').addEventListener('click', (ev) => {
    const ai = ev.target.closest('[data-ai-added-filter]');
    if (ai) {
      CAL_SHOW_AI_ADDED = !CAL_SHOW_AI_ADDED;
      localStorage.setItem('calShowAiAdded', CAL_SHOW_AI_ADDED ? '1' : '0');
      renderCalendarOps();
      return;
    }
    const btn = ev.target.closest('[data-kind-filter]');
    if (!btn) return;
    CAL_KIND_SEL = nextSelection(CAL_KIND_SEL, calKindList(), btn.dataset.kindFilter);
    localStorage.setItem('calKinds', JSON.stringify(CAL_KIND_SEL));
    renderCalendarOps();
  });

  // The three interfaces. CALENDAR-SPEC 1.1-1.2. Switching never touches the
  // kind filter or the class chips: a user who has narrowed to one class and
  // filtered to meetings is looking at one specific question, and answering it
  // in a different shape must not reset it.
  document.querySelectorAll('[data-calview]').forEach(btn => {
    btn.addEventListener('click', () => {
      CAL_VIEW = btn.dataset.calview;
      localStorage.setItem('calView', CAL_VIEW);
      CAL_EXPANDED = new Set();
      renderCalendarOps();
    });
  });

  // Period navigation for the grids. Delegated: renderCalPeriod() rebuilds
  // these buttons on every render.
  $('cal-period').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-cal-step]');
    if (!btn) return;
    stepCalPeriod(Number(btn.dataset.calStep));
  });

  // Lay the week against a clock. CALENDAR-SPEC 9.1.
  $('cal-times').addEventListener('click', () => {
    CAL_TIMES = !CAL_TIMES;
    localStorage.setItem('calTimes', CAL_TIMES ? '1' : '0');
    renderCalendarOps();
  });

  // A collision list has to escape the clock's scroll/containment boundary or
  // its first rows get clipped. A native popover supplies that top layer; we
  // place it beside the summary from the space ACTUALLY on screen, since the
  // time of day is no guide after the user scrolls the grid.
  $('cal-ops').addEventListener('click', (ev) => {
    const trigger = ev.target.closest('[data-cal-collision-open]');
    if (!trigger) return;
    const stack = trigger.closest('.cal-collision');
    const list = stack?.querySelector('.cal-collision-list');
    if (!list) return;
    if (list.matches(':popover-open')) {
      list.hidePopover();
      return;
    }
    list.showPopover();
    const anchor = trigger.getBoundingClientRect();
    const paper = list.getBoundingClientRect();
    const gap = 4;
    const edge = 8;
    const opensUp = anchor.top - edge > window.innerHeight - anchor.bottom - edge;
    const top = opensUp
      ? Math.max(edge, anchor.top - gap - paper.height)
      : Math.min(window.innerHeight - edge - paper.height, anchor.bottom + gap);
    const left = Math.min(
      Math.max(edge, anchor.left),
      Math.max(edge, window.innerWidth - edge - paper.width),
    );
    list.style.setProperty('--collision-top', `${top}px`);
    list.style.setProperty('--collision-left', `${left}px`);
    stack.classList.toggle('opens-up', opensUp);
  });

  $('cal-ops').addEventListener('toggle', (ev) => {
    const list = ev.target.closest?.('.cal-collision-list[popover]');
    if (!list) return;
    const stack = list.closest('.cal-collision');
    const trigger = stack?.querySelector('[data-cal-collision-open]');
    const open = list.matches(':popover-open');
    stack?.classList.toggle('open', open);
    trigger?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }, true);

  // Bring finished work back so it can be un-finished. CALENDAR-SPEC 2.5.
  $('cal-showdone').addEventListener('click', () => {
    CAL_SHOW_DONE = !CAL_SHOW_DONE;
    localStorage.setItem('calShowDone', CAL_SHOW_DONE ? '1' : '0');
    renderCalendarOps();
  });

  // The list is for planning forward. Old lectures and office hours are useful
  // history, but putting them above today's work makes every visit begin with
  // scrolling. Overdue work stays visible; only past schedule blocks fold away.
  $('cal-showpast').addEventListener('click', () => {
    CAL_SHOW_PAST = !CAL_SHOW_PAST;
    localStorage.setItem('calShowPast', CAL_SHOW_PAST ? '1' : '0');
    renderCalendarOps();
  });

  // Class chips: the swatch opens the colour picker, the name toggles the
  // class. Two buttons rather than one, because a colour control nested inside
  // a toggle button is invalid markup and unreachable by keyboard.
  $('cal-classes').addEventListener('click', (ev) => {
    const swatch = ev.target.closest('[data-color-open]');
    if (swatch) {
      const slug = swatch.dataset.colorOpen;
      COLOR_OPEN = COLOR_OPEN === slug ? null : slug;
      renderClassChips();
      if (COLOR_OPEN) {
        $('cal-classes').querySelector(`[data-color-pop="${cssEsc(COLOR_OPEN)}"] button`)?.focus();
      }
      return;
    }
    if (handleColorPopClick(ev)) return;

    const chip = ev.target.closest('[data-cal-class-toggle]');
    if (!chip) return;
    // Resolved against the PRUNED selection — the chips on screen — not the
    // raw stored one. Otherwise a stale slug the user cannot see makes their
    // click land somewhere else: with ['busi-305', 'a-departed-class'] stored,
    // only BUSI 305 draws as selected, but clicking it is not "the last one"
    // to nextSelection(), so instead of returning to everything it leaves the
    // departed slug selected — invisible now, and re-narrowing the calendar on
    // its own the day that class comes back.
    const vocabulary = chipRowsSource().map(r => r.slug);
    CAL_CLASS_SEL = nextSelection(
      pruneSelection(CAL_CLASS_SEL, vocabulary), vocabulary, chip.dataset.calClassToggle);
    localStorage.setItem('calClassSel', JSON.stringify(CAL_CLASS_SEL));
    renderCalendarOps();
  });

  // A picker left open is a panel covering the calendar. Escape and a click
  // anywhere else both close it.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && COLOR_OPEN) { COLOR_OPEN = null; renderClassChips(); }
  });
  document.addEventListener('click', (ev) => {
    if (!COLOR_OPEN) return;
    // composedPath(), not closest(). The #cal-classes handler above has already
    // called renderClassChips() by the time this fires, so ev.target is a
    // DETACHED node — its ancestor chain no longer reaches #cal-classes and
    // closest() returns null. That made this listener read the very click that
    // opened the picker as a click outside it, so the picker opened and closed
    // in one gesture and the swatch appeared dead. composedPath() is captured
    // when the event is dispatched and survives the re-render.
    if (ev.composedPath().includes($('cal-classes'))) return;
    COLOR_OPEN = null;
    renderClassChips();
  });

  // Ticking a deadline off from the calendar. The row goes struck-through at
  // once and the bridge rebuilds the worklist behind it — waiting for the
  // rebuild before acknowledging the click reads as the checkbox not working.
  $('cal-ops').addEventListener('change', async (ev) => {
    const box = ev.target.closest('[data-cal-done]');
    if (!box) return;
    const folder = box.dataset.calClass;
    const id = box.dataset.calDone;
    // A prep block ticks itself off by id; the assignment it belongs to stays
    // open. Anything else ticks the item.
    const cpId = box.dataset.calCp || null;
    // Two keys, deliberately. `key` identifies the tickable THING (a prep
    // block is not its parent), and is what CAL_DONE and the pending overlay
    // are keyed on. `writeKey` identifies the FILE the write lands in — one
    // JSON object per task, rewritten wholesale — so a tick, a note and a
    // dragged sibling all queue behind each other instead of overwriting one
    // another.
    const key = calDoneKey(folder, id, cpId);
    const writeKey = taskWriteKey(folder, id);
    const done = box.checked;
    // `.cal-row` in the list, `.cal-chip` in the week and month grids — the
    // same checkbox is rendered into both, so the handler cannot assume one.
    const row = box.closest('.cal-row, .cal-chip');
    if (done) CAL_DONE.add(key); else CAL_DONE.delete(key);
    CAL_DONE_PENDING.set(key, done);
    row?.classList.toggle('is-done', done);
    // POSTs for one key are SERIALIZED, and each queue turn sends the LATEST
    // intent. Two overlapping requests could land out of order — tick then
    // untick, with the tick's POST writing last — leaving the server at the
    // stale intent while the pending overlay pins the newer one: the row
    // redrew unchecked on every reload, forever, and the saved state was
    // simply wrong.
    const tail = CAL_POST_QUEUE.get(writeKey) ?? Promise.resolve();
    const run = tail.then(async () => {
      // The pending map is the newest intent when it still holds one, and
      // THIS click's own value otherwise. It must never be read as "nothing
      // to send": seedCalDone retires an entry the moment the (deliberately
      // stale) worklist agrees with it, which for a fresh un-tick is
      // immediately — so bailing on `undefined` dropped the user's last
      // toggle silently, exactly the wedge this queue exists to prevent.
      // Re-POSTing a value the server already holds is idempotent.
      const intent = CAL_DONE_PENDING.has(key) ? CAL_DONE_PENDING.get(key) : done;
      try {
        await api(`/api/class/${folder}/task/${encodeURIComponent(id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cpId ? { checkpointDone: { id: cpId, done: intent } } : { done: intent }),
        });
      } catch (err) {
        // Put it back rather than leaving a tick that did not save — unless
        // the user has re-toggled since; then the newer queue turn owns it.
        if (CAL_DONE_PENDING.get(key) === intent) {
          if (intent) CAL_DONE.delete(key); else CAL_DONE.add(key);
          CAL_DONE_PENDING.delete(key);
          box.checked = !intent;
          row?.classList.toggle('is-done', !intent);
          toast(`Could not save that: ${err.message}`);
        }
      } finally {
        // Drop the tail once it is the last one: the settled promise's
        // closure pins `box` and `row`, detached after any re-render.
        if (CAL_POST_QUEUE.get(writeKey) === run) CAL_POST_QUEUE.delete(writeKey);
      }
    });
    CAL_POST_QUEUE.set(writeKey, run);
  });

  // A month tile that holds more than it can show. CALENDAR-SPEC 3.8.
  $('cal-ops').addEventListener('click', (ev) => {
    const more = ev.target.closest('[data-cal-expand]');
    if (!more) return;
    const iso = more.dataset.calExpand;
    if (CAL_EXPANDED.has(iso)) CAL_EXPANDED.delete(iso); else CAL_EXPANDED.add(iso);
    renderCalendarOps();
  });

  // Ticking off an item the user added. Its own endpoint and its own store,
  // but the same serialized-per-item discipline the task tick has: two fast
  // clicks must not land out of order and leave the file at the older intent.
  $('cal-ops').addEventListener('change', async (ev) => {
    const box = ev.target.closest('[data-cal-custom-done]');
    if (!box) return;
    const id = box.dataset.calCustomDone;
    const done = box.checked;
    box.closest('.cal-row, .cal-chip')?.classList.toggle('is-done', done);
    // Each queued turn carries the value of ITS OWN click, so a double toggle
    // ends where the user's last click put it rather than wherever the slowest
    // response happened to land.
    try {
      await queueCustomWrite(id, { done });
    } catch (err) {
      toast(`Could not save that: ${err.message}`);
    }
  });

  // Opening an item: the user's own goes to its editor, a lecture to its own
  // small page. Both are real destinations — see calItemModel on 2.10.
  $('cal-ops').addEventListener('click', (ev) => {
    const custom = ev.target.closest('[data-open-custom]');
    if (custom) {
      const item = customItemById(custom.dataset.openCustom);
      if (item) openItemDialog({ mode: 'custom', item });
      return;
    }
    const opBtn = ev.target.closest('[data-open-op]');
    if (!opBtn) return;
    const key = opBtn.dataset.openOp;
    const folder = opBtn.dataset.opClass;
    const op = (CAL_WORKLIST?.ops ?? []).find(o => o.note_key === key);
    if (op && folder) openItemDialog({ mode: 'op', op, folder, noteKey: key, note: op.note ?? '' });
  });

  // The Add button. Opens on a day the user is actually looking at: the
  // period they have on screen when that period is not this one, and today
  // otherwise — landing an item in August because the grid is showing
  // November would be a small betrayal every time.
  $('cal-add').addEventListener('click', () => {
    openItemDialog({ mode: 'create', date: addDayForNewItem() });
  });

  wireCalendarDrag();
  wireCalendarResize();
  wireItemDialog();
}

/**
 * A resized window can change how many lanes the grid can afford, and the lane
 * count is baked into the DOM at render time — CSS cannot undo it. Without
 * this, dragging a window from 1200px to 375px leaves the 2-lane chips that
 * width chose, overflowing exactly as they did before the budget was measured.
 *
 * Re-render only when the BUDGET changes, not on every resize event: the
 * fluid part of the layout is CSS's already, and re-rendering the grid on each
 * pixel of a drag would drop the user's open collision stacks for nothing.
 */
function wireCalendarResize() {
  let timer = null;
  const check = () => {
    if (CAL_LANE_BUDGET == null) return;   // no timed grid on screen
    if ($('view-calendar').classList.contains('hidden')) return;
    const days = CAL_VIEW === 'twoday' ? 2 : 7;
    const budget = laneBudgetFor(days, calGridWidth(), {
      ...calGridGeometry(),
      cap: days <= 2 ? 4 : MAX_LANES,
    });
    if (budget === CAL_LANE_BUDGET) return;
    renderCalendarOps();
  };
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(check, 150);
  });
}

/** Which day a brand-new item should default to. */
function addDayForNewItem() {
  const today = localTodayIso();
  if (CAL_VIEW === 'list' || !CAL_ANCHOR) return today;
  if (CAL_VIEW === 'twoday') return today;
  const days = CAL_VIEW === 'week'
    ? weekDays(CAL_ANCHOR)
    : [startOfMonth(CAL_ANCHOR), addDays(addMonths(startOfMonth(CAL_ANCHOR), 1), -1)];
  const first = days[0];
  const last = days[days.length - 1];
  return today >= first && today <= last ? today : first;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

// Canvas keeps every past semester's enrollment active, so the raw class list
// is two years long. The sidebar shows the classes the extension is actually
// syncing; "All" is one click away and the choice persists.
let CLASS_SCOPE = localStorage.getItem('classScope') === 'all' ? 'all' : 'current';
let SCOPE = { courseIds: null, source: 'none' };

// Canvas names a course after its own code plus a term suffix, so the row read
// "BUSI 305 001/002/003" over "BUSI 305 001/002/003 F26" — the same string
// twice. Only show the name when it actually says something else.
function subtitleFor(c) {
  const code = c.code || c.folder;
  const name = c.name || '';
  if (!name || name === code) return '';
  return name.startsWith(code) ? name.slice(code.length).trim() : name;
}

// The slug the colour API keys on ships on every /api/classes row (`c.slug`)
// — spec 2.11: the client must not own a copy of the folder→slug strip rule.
// A private slugOf() here drifted-by-duplication exactly the way calFolder()
// once did, so it is gone; DOM nodes carry data-slug where a class row is not
// at hand.

// ---------------------------------------------------------------------------
// Home — the Classes tab landing page
//
// Canvas's own dashboard is a grid of course cards over a "Coming Up" list, and
// that shape is right here for the same reason it is right there: the two
// questions a student opens this app to answer are "where do I stand in each
// class" and "what is due next".
//
// The grade block on each card has to work on the first day of term, when
// nothing has been graded and every percentage is null. A card showing "—" six
// times is a dead page. So the card leads with the *shape* of the grade — one
// segment per weighted component, sized by its weight and filled by how much of
// it has been graded. That is real information in week one (this class is 45%
// two projects; that one is 33 quizzes) and it fills in on its own as the term
// runs, without anyone having to invent a projection to put in the empty space.
// ---------------------------------------------------------------------------

function schemeTag(g, fallbackStated) {
  if (!g) return '';
  if (g.mode === 'points') return fallbackStated ? 'syllabus' : 'points';
  // "inferred" is the case where Canvas never told us whether it weights by
  // group — the flag was not in metadata.json until this version — and the
  // weights themselves were the evidence. It stops being inferred after the
  // next sync.
  if (g.source === 'canvas') return g.assumed ? 'weighted · inferred' : 'weighted · Canvas';
  return 'weighted · syllabus';
}

/** The segmented weight bar: width by weight, fill by fraction graded. */
function weightBarHtml(g) {
  let buckets = (g?.buckets ?? []).filter(b => (b.total ?? 0) > 0 || (b.weight ?? 0) > 0);
  // Nothing in Canvas to weigh. ECON 205 has no assignments at all, and its
  // card would otherwise be a course code over a dash — while its syllabus
  // states the whole scheme (Problem Sets 15, Midterm 35, Final 50). Draw that
  // instead, entirely unfilled, which is exactly what is true.
  if (!buckets.length && (g?.stated ?? []).length) {
    buckets = g.stated.map(c => ({ name: c.name, weight: c.weight, graded: 0, total: 0,
                                   possible: 0, remaining: 0 }));
    g = { ...g, mode: 'weighted', buckets };
  }
  if (!buckets.length) return '';
  // In points mode there are no weights, so size the segments by the points
  // each group is worth — the same question answered with the units to hand.
  const size = b => g.mode === 'weighted'
    ? (b.weight || 0)
    : ((b.possible || 0) + (b.remaining || 0));
  const total = buckets.reduce((n, b) => n + size(b), 0);
  if (total <= 0) return '';
  return `<div class="hc-weights">${buckets.map(b => {
    const share = (size(b) / total) * 100;
    const fill = b.total > 0 ? (b.graded / b.total) * 100 : 0;
    const label = g.mode === 'weighted' ? `${b.name} — ${b.weight}%` : b.name;
    return `<span class="hc-seg" style="flex:${share.toFixed(3)}"
             title="${esc(label)} · ${b.graded} of ${b.total} graded"
             ><i style="width:${fill.toFixed(1)}%"></i></span>`;
  }).join('')}</div>`;
}

function gradeBlockHtml(g) {
  if (!g) return '';
  const pct = g.current == null ? '—' : `${g.current}%`;
  const band = (g.current != null && g.floor != null && g.ceiling != null)
    ? `<span class="hc-band">${g.floor}–${g.ceiling}</span>` : '';
  // A class with nothing in Canvas still has a scheme worth naming, so the tag
  // is not gated on there being work to count.
  const usingStated = !g.counted && (g.stated ?? []).length > 0;
  return `<div class="hc-grade">
      <span class="hc-pct${g.current == null ? ' none' : ''}">${pct}</span>
      ${band}
      <span class="hc-scheme">${esc(schemeTag(g, usingStated))}</span>
    </div>`;
}

function homeCardHtml(c) {
  const g = c.grade;
  const sub = subtitleFor(c);
  const meta = [];
  if (g?.counted) meta.push(`${g.graded} of ${g.counted} graded`);
  if (g?.hidden) meta.push(`${g.hidden} withheld`);
  if (g?.missing) meta.push(`${g.missing} missing`);
  if (c.taskCount != null) meta.push(`${c.taskCount} ${c.taskCount === 1 ? 'task' : 'tasks'}`);
  meta.push(`${c.fileCount} ${c.fileCount === 1 ? 'file' : 'files'}`);
  return `<article class="home-card" data-folder="${esc(c.folder)}" tabindex="0"
           style="--class-color:${classColor(c.slug)}">
      <div class="hc-code">${esc(c.code || c.folder)}</div>
      ${sub ? `<div class="hc-name">${esc(sub)}</div>` : ''}
      ${gradeBlockHtml(g)}
      ${weightBarHtml(g)}
      <div class="hc-meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div>
    </article>`;
}

/** The next deadlines across every class, newest first. Meetings are not news. */
function upcomingOps(limit = 8) {
  const ops = CAL_WORKLIST?.ops ?? [];
  // Local, never toISOString().slice() — the UTC slice rolls to tomorrow at
  // 5pm local and quietly drops today's own deadlines from "Coming up".
  const today = localTodayIso();
  return ops
    .filter(o => {
      if (o.calendar === 'meeting' || !o.date || o.date < today) return false;
      // CAL_DONE holds calDoneKey (`folder|id[|cp]`) strings — testing the
      // op's `[csync:...]` marker never matched, so a just-ticked deadline
      // kept showing in Coming up and counting in "due this week".
      const folder = calFolder(o.class);
      return !(folder && o.item_id != null
        && CAL_DONE.has(calDoneKey(folder, o.item_id, o.checkpoint_id ?? null)));
    })
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.time ?? '').localeCompare(String(b.time ?? '')))
    .slice(0, limit);
}

function renderHome() {
  const all = CLASSES ?? [];
  const shown = SCOPE.courseIds ? all.filter(c => c.inScope) : all;
  const cards = shown.length ? shown : all;

  const term = cards.find(c => c.term)?.term ?? '';
  $('home-term').textContent = term || 'Classes';

  const graded = cards.reduce((n, c) => n + (c.grade?.graded ?? 0), 0);
  const counted = cards.reduce((n, c) => n + (c.grade?.counted ?? 0), 0);
  const stats = [`${cards.length} ${cards.length === 1 ? 'class' : 'classes'}`];
  if (counted) stats.push(`${graded} of ${counted} graded`);
  const up = upcomingOps(200);
  const weekEnd = addDays(localTodayIso(), 7);
  const thisWeek = up.filter(o => o.date <= weekEnd).length;
  if (thisWeek) stats.push(`${thisWeek} due this week`);
  $('home-stats').innerHTML = stats.map(t => `<span>${esc(t)}</span>`).join('');

  $('home-cards').innerHTML = cards.map(homeCardHtml).join('');

  const next = up.slice(0, 8);
  $('home-upcoming').classList.toggle('hidden', next.length === 0);
  $('home-up-list').innerHTML = next.map(o => {
    const cls = cards.find(c => c.slug === o.class);
    const when = new Date(`${o.date}T${o.time ?? '12:00'}`);
    const day = Number.isNaN(when.getTime()) ? o.date
      : when.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    // The title CLICKS IN to the item, not to the class that contains it.
    //
    // Reused rather than re-derived: calItemModel already resolves an op to
    // what it can honestly offer — a Canvas-backed deadline, a checkpoint that
    // clicks in to the assignment it preps for (spec 2.12), an AI-added item
    // with no Canvas page at all — and calTitleHtml already renders the right
    // control for each, or plain text when there is none. That is the same
    // resolution the calendar rows and chips use, so Coming up cannot drift
    // from them, and it goes through the op's own url/origin rather than
    // matching on titles.
    const m = calItemModel(o);
    return `<li class="hu-row" data-folder="${esc(cls?.folder ?? '')}"
             style="--class-color:${classColor(o.class)}">
        <span class="hu-day">${esc(day)}</span>
        ${dueRelHtml(daysUntil(o.date), 'hu-rel')}
        <span class="hu-title">${calTitleHtml(o, m, o.title)}</span>
        <span class="hu-kind">${esc(calKindLabel(o.kind))}</span>
      </li>`;
  }).join('');
}

function wireHome() {
  $('home-cards').addEventListener('click', ev => {
    const card = ev.target.closest('.home-card');
    if (card) openClass(card.dataset.folder);
  });
  $('home-cards').addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const card = ev.target.closest('.home-card');
    if (!card) return;
    ev.preventDefault();
    openClass(card.dataset.folder);
  });
  $('home-up-list').addEventListener('click', ev => {
    // A control inside the row owns its own click: [data-open-assignment] is
    // handled by the document-level listener in wireAssignment, and a Canvas
    // link is an ordinary <a>. Falling through would open the CLASS page
    // behind whichever of those the user actually clicked.
    if (ev.target.closest('a, button')) return;
    // The rest of the row still goes to the class. That is the honest fallback
    // for a row whose item has no page of its own — an AI-added reading, say —
    // and it is what stops any reachable part of the row being a dead click.
    const row = ev.target.closest('.hu-row');
    if (row?.dataset.folder) openClass(row.dataset.folder);
  });
}

async function loadClasses() {
  const { classes, scope } = await apiJson('/api/classes');
  CLASSES = classes;
  SCOPE = scope ?? { courseIds: null, source: 'none' };
  // Colours are the bridge's to decide, and the sidebar draws one per row, so
  // they have to be in hand before the first paint.
  await loadClassColors().catch(() => {});
  renderClassList();
  renderHome();
  // "Coming up" reads the calendar worklist, which until now only loaded when
  // the calendar view was opened — so the home page would show cards and an
  // empty deadline list on a cold start. Fetch it in the background and
  // repaint; the home page is useful without it, so nothing waits on it.
  if (!CAL_WORKLIST) {
    apiJson('/api/calendar')
      .then(({ worklist, custom_items }) => {
        CAL_WORKLIST = worklist;
        if (Array.isArray(custom_items)) CAL_CUSTOM = custom_items;
        seedCalDone();
        renderHome();
      })
      .catch(() => {});
  }
  // A late or retried colour load has to reach the calendar too, and the
  // calendar may already be on screen by the time it lands.
  if (!$('view-calendar').classList.contains('hidden')) renderCalendarOps();
}

function renderClassList() {
  const all = CLASSES ?? [];
  // A scope the bridge could not determine means "everything is current" —
  // don't let an unreadable last_sync.json empty the user's sidebar.
  const scoped = SCOPE.courseIds ? all.filter(c => c.inScope) : all;
  const hidden = all.length - scoped.length;
  const shown = CLASS_SCOPE === 'all' ? all : scoped;

  $('class-count').textContent = all.length
    ? (CLASS_SCOPE === 'all' || !hidden ? `(${all.length})` : `(${scoped.length} of ${all.length})`)
    : '';
  $('class-scope').classList.toggle('hidden', hidden === 0);
  document.querySelectorAll('#class-scope .seg-btn')
    .forEach(b => b.classList.toggle('active', b.dataset.scope === CLASS_SCOPE));

  $('class-empty').classList.toggle('hidden', all.length > 0);
  $('class-scope-empty').classList.toggle('hidden', !(all.length > 0 && shown.length === 0));

  const ul = $('class-list');
  ul.innerHTML = '';
  for (const c of shown) {
    const li = document.createElement('li');
    li.dataset.folder = c.folder;
    li.dataset.slug = c.slug;
    li.classList.toggle('out-of-scope', SCOPE.courseIds != null && !c.inScope);
    // The class colour as a 3px rule at the row's edge — the same mark the
    // calendar uses, so a colour learned in one place reads in the other.
    li.style.setProperty('--class-color', classColor(c.slug));
    const gradeStr = c.currentScore != null ? `${c.currentGrade ? c.currentGrade + ' · ' : ''}${c.currentScore}%` : '';
    li.innerHTML = `
      <div class="cl-code">${esc(c.code || c.folder)}</div>
      ${subtitleFor(c) ? `<div class="cl-name">${esc(subtitleFor(c))}</div>` : ''}
      <div class="cl-meta">
        ${c.taskCount != null ? `<span>${c.taskCount} tasks</span>` : ''}
        <span>${c.fileCount} files</span>
        ${gradeStr ? `<span>${esc(gradeStr)}</span>` : ''}
        ${SCOPE.courseIds != null && !c.inScope ? '<span class="cl-flag">not syncing</span>' : ''}
      </div>`;
    li.addEventListener('click', () => openClass(c.folder));
    ul.appendChild(li);
  }

  // The cleanup entry point only exists when there is something to clean up.
  $('cleanup-open').classList.toggle('hidden', hidden === 0);
  $('cleanup-open').textContent = hidden === 1
    ? 'Remove 1 old class…'
    : `Remove ${hidden} old classes…`;
}

// ---------------------------------------------------------------------------
// Class picker — editing the sync selection from the app
// ---------------------------------------------------------------------------

let PICKER = { enrolled: [], scope: { courseIds: null }, intent: null };

function pickerChecked() {
  return [...document.querySelectorAll('#picker-list input[type=checkbox]:checked')].map(el => el.value);
}

function renderPickerCount() {
  const n = pickerChecked().length;
  $('picker-count').textContent = `${n} of ${PICKER.enrolled.length} selected`;
}

// Terms sort newest-first by the most recent course id in each — Canvas ids
// climb monotonically, and the term object carries no reliable ordering key.
function groupEnrolledByTerm(list) {
  const byTerm = new Map();
  for (const c of list) {
    const key = c.term || 'Other';
    if (!byTerm.has(key)) byTerm.set(key, []);
    byTerm.get(key).push(c);
  }
  return [...byTerm.entries()]
    .map(([term, courses]) => ({
      term,
      courses,
      rank: Math.max(...courses.map(c => Number(c.courseId) || 0)),
    }))
    .sort((a, b) => b.rank - a.rank);
}

// A term label's place in time, parsed from the label itself ("Fall 2026",
// "2027 Spring"): year*10 + season rung. Null when no year is named.
function termLabelRank(label) {
  const s = String(label || '').toLowerCase();
  const year = /\b(20\d\d)\b/.exec(s)?.[1];
  if (!year) return null;
  const season = s.includes('winter') ? 0
    : s.includes('spring') ? 1
    : s.includes('summer') ? 2
    : (s.includes('fall') || s.includes('autumn')) ? 3
    : 1.5; // a year with no season sorts between spring and summer
  return Number(year) * 10 + season;
}

// The group the "Current term" button should select: the latest term at or
// before today. Falls back to the picker's first (newest-id) group when no
// label parses.
function currentTermGroup(groups) {
  const m = new Date().getMonth() + 1;
  const nowRank = new Date().getFullYear() * 10 + (m <= 5 ? 1 : m <= 7 ? 2 : 3);
  const ranked = groups
    .map(g => ({ g, rank: termLabelRank(g.term) }))
    .filter(x => x.rank != null && x.rank <= nowRank);
  if (!ranked.length) return groups[0] ?? null;
  return ranked.reduce((a, b) => (b.rank > a.rank ? b : a)).g;
}

async function openPicker() {
  showClassesPanel('picker-panel');
  $('picker-result').textContent = '';
  $('picker-list').innerHTML = '<p class="muted">Loading…</p>';

  try {
    PICKER = await apiJson('/api/scope');
  } catch (err) {
    $('picker-list').innerHTML = `<p class="muted">Could not read the course list: ${esc(err.message)}</p>`;
    return;
  }

  if (!PICKER.enrolled.length) {
    $('picker-sub').textContent = '';
    $('picker-list').innerHTML = '<p class="muted">The extension has not sent its course list yet. '
      + 'Open Canvas in Chrome, or press Force sync in the extension popup, then come back.</p>';
    $('picker-count').textContent = '';
    return;
  }

  // A pending change is what the user last asked for, so it wins over the
  // live scope — otherwise the panel would show their edit reverting.
  const pending = PICKER.intent?.courseIds;
  const checked = new Set(Array.isArray(pending) ? pending : (PICKER.scope.courseIds ?? []));
  $('picker-sub').textContent = PICKER.intent
    ? 'A change is waiting for the extension to sync.'
    : '';

  $('picker-list').innerHTML = groupEnrolledByTerm(PICKER.enrolled).map(g => `
    <section class="picker-term">
      <h3>${esc(g.term)}</h3>
      ${g.courses.map(c => `
        <label class="picker-row">
          <input type="checkbox" value="${esc(c.courseId)}"${checked.has(c.courseId) ? ' checked' : ''}>
          <span class="pk-code">${esc(c.code || c.courseId)}</span>
          <span class="pk-name">${esc(c.name || '')}</span>
        </label>`).join('')}
    </section>`).join('');
  $('picker-list').querySelectorAll('input[type=checkbox]')
    .forEach(el => el.addEventListener('change', renderPickerCount));
  renderPickerCount();
}

function closePicker() {
  $('picker-panel').classList.add('hidden');
  ensureClassesPanel();
}

async function savePicker() {
  const btn = $('picker-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await apiJson('/api/scope', {
      method: 'POST',
      body: JSON.stringify({ courseIds: pickerChecked() }),
    });
    $('picker-result').textContent =
      'Saved. The extension picks this up on its next sync — open Canvas, or press Force sync in the popup.';
  } catch (err) {
    $('picker-result').textContent = `Could not save: ${err.message}`;
  }
  btn.disabled = false;
  btn.textContent = 'Save selection';
}

// ---------------------------------------------------------------------------
// Cleanup — deleting classes that fell out of the sync selection
// ---------------------------------------------------------------------------

let STALE = [];

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function cleanupChecked() {
  return [...document.querySelectorAll('#cleanup-list input[type=checkbox]:checked')]
    .map(el => el.value);
}

function renderCleanupActions() {
  const picked = cleanupChecked();
  const bytes = STALE.filter(c => picked.includes(c.folder))
    .reduce((n, c) => n + c.sizeBytes, 0);
  const btn = $('cleanup-go');
  btn.disabled = picked.length === 0;
  btn.dataset.armed = '';
  btn.textContent = picked.length === 0
    ? 'Delete selected'
    : `Delete ${picked.length} class${picked.length === 1 ? '' : 'es'} (${fmtBytes(bytes)})`;
}

async function openCleanup({ keepResult = false } = {}) {
  showClassesPanel('cleanup-panel');
  // The receipt survives the refresh that follows a delete: this is the one
  // destructive action in the app, and blanking "Removed 2 classes, freed
  // 41 MB" milliseconds after writing it left the user with no statement of
  // what had just happened — or of which folder survived on a partial failure.
  if (!keepResult) $('cleanup-result').textContent = '';
  $('cleanup-list').innerHTML = '<p class="muted">Measuring…</p>';

  let data;
  try {
    data = await apiJson('/api/classes/stale');
  } catch (err) {
    $('cleanup-list').innerHTML = `<p class="muted">Could not read the class list: ${esc(err.message)}</p>`;
    return;
  }
  STALE = data.stale ?? [];
  $('cleanup-sub').textContent = STALE.length
    ? `${STALE.length} class${STALE.length === 1 ? '' : 'es'} · ${fmtBytes(data.totalBytes)} on disk`
    : 'Nothing to clean up.';

  if (!STALE.length) {
    // Say WHY it is empty when the reason is not "everything is current" —
    // an empty selection makes every class out-of-scope, and the server now
    // refuses to call that abandoned. Naming the fix beats a false all-clear.
    const why = {
      'empty-selection': 'Your class selection is empty, so nothing counts as abandoned. Pick the classes you keep in Manage courses.',
      'scope-unknown': 'No sync selection on record yet — run a sync first.',
    }[data.reason] ?? 'Every class on disk is in your current selection.';
    $('cleanup-list').innerHTML = `<p class="muted">${esc(why)}</p>`;
    renderCleanupActions();
    return;
  }

  $('cleanup-list').innerHTML = STALE.map(c => `
    <label class="cleanup-row">
      <input type="checkbox" value="${esc(c.folder)}" checked>
      <span class="cu-code">${esc(c.code || c.folder)}</span>
      <span class="cu-name">${esc(c.name || '')}</span>
      <span class="cu-term">${esc(c.term || '—')}</span>
      <span class="cu-size">${c.fileCount} files · ${fmtBytes(c.sizeBytes)}</span>
    </label>`).join('');
  $('cleanup-list').querySelectorAll('input[type=checkbox]')
    .forEach(el => el.addEventListener('change', renderCleanupActions));
  renderCleanupActions();
}

function closeCleanup() {
  $('cleanup-panel').classList.add('hidden');
  ensureClassesPanel();
}

async function runCleanup() {
  const btn = $('cleanup-go');
  const folders = cleanupChecked();
  if (!folders.length) return;

  // Two-step: deleting a class removes real files, so the first press only
  // arms the button and says plainly what is about to happen.
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = `Confirm — permanently delete ${folders.length} folder${folders.length === 1 ? '' : 's'}`;
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const res = await apiJson('/api/classes/cleanup', {
      method: 'POST',
      body: JSON.stringify({ folders }),
    });
    const failed = (res.results ?? []).filter(r => !r.ok);
    $('cleanup-result').textContent = failed.length
      ? `Removed ${(res.results.length - failed.length)} of ${res.results.length}. `
        + failed.map(f => `${f.folder}: ${f.error}`).join('; ')
      : `Removed ${res.results.length} class${res.results.length === 1 ? '' : 'es'}, freed ${fmtBytes(res.freedBytes)}.`;
  } catch (err) {
    $('cleanup-result').textContent = `Cleanup failed: ${err.message}`;
  }
  await loadClasses().catch(() => {});
  await openCleanup({ keepResult: true });
}

// --- One assignment, read locally ------------------------------------------
// Canvas HTML arrives as-is. It is the user's own course content, but it is
// still third-party markup being injected into a page that holds the bridge
// secret, so scripts, embeds and event handlers come out before it renders.
function sanitizeCanvasHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, link, meta').forEach(n => n.remove());
  doc.querySelectorAll('[hidden], [aria-hidden="true"], [style]').forEach((n) => {
    if (n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true'
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(n.getAttribute('style') || '')) n.remove();
  });
  doc.querySelectorAll('*').forEach((n) => {
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'class' || name === 'id'
        || name.startsWith('data-')) n.removeAttribute(attr.name);
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) {
        n.removeAttribute(attr.name);
      }
    }
    if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
  });
  doc.querySelectorAll('i').forEach(n => { if (!n.textContent.trim() && !n.querySelector('img')) n.remove(); });
  return doc.body.innerHTML;
}

let ASSIGNMENT = null;
// Where Back should go. Opening from the calendar and landing back in Classes
// loses the user's place in a list they were reading top to bottom.
let ASSIGNMENT_RETURN = 'classes';

async function openAssignment(folder, assignmentId) {
  const from = document.querySelector('.nav-btn.active')?.dataset.view || 'classes';
  try {
    ASSIGNMENT = await apiJson(`/api/class/${folder}/assignment/${encodeURIComponent(assignmentId)}`);
  } catch (err) {
    toast(`Could not open that assignment: ${err.message}`);
    return;
  }
  ASSIGNMENT_RETURN = from;
  navTo('classes');
  showClassesPanel('assignment-panel');
  renderAssignment();
}

function renderAssignment() {
  const a = ASSIGNMENT;
  if (!a) return;
  $('assignment-title').textContent = a.name;

  // HTML, not textContent, so the due date can carry its graded distance —
  // every piece is escaped here.
  const bits = [];
  if (a.course_code) bits.push(esc(a.course_code));
  if (a.due_at) {
    const diff = daysUntilIso(a.due_at);
    const rel = diff == null ? '' : ` · ${dueRelHtml(diff, '', { done: !!a.user_state?.done })}`;
    bits.push(`Due ${esc(fmtDateTime(a.due_at))}${rel}`);
  } else if (a.due_date) {
    const diff = daysUntil(a.due_date);
    const rel = diff == null ? '' : ` · ${dueRelHtml(diff, '', { done: !!a.user_state?.done })}`;
    bits.push(`Due ${esc(fmtShortDate(a.due_date))}${a.due_time ? ` at ${esc(fmtTime12(a.due_time))}` : ''}${rel}`);
  }
  if (a.points_possible != null) bits.push(esc(`${a.points_possible} pts`));
  if (a.is_quiz) {
    const q = a.quiz || {};
    bits.push(esc(['Quiz',
      q.question_count ? `${q.question_count} question${q.question_count === 1 ? '' : 's'}` : null,
      q.time_limit ? `${q.time_limit} min` : null].filter(Boolean).join(' · ')));
  }
  $('assignment-sub').innerHTML = bits.join('  ·  ');

  const open = $('assignment-open');
  open.classList.toggle('hidden', !a.url);
  if (a.url) open.href = a.url;
  const submit = $('assignment-submit');
  submit.classList.toggle('hidden', !a.submit_url);
  if (a.submit_url) submit.href = a.submit_url;

  // Your own notes. Filled from user_state.json, which is the same field the
  // task list's editor writes and the same one the calendar event's
  // description carries — one note per assignment, wherever you type it.
  const noteEl = $('assignment-note');
  if (noteEl) {
    noteEl.value = a.user_state?.note ?? '';
    noteEl.dataset.folder = a.folder;
    noteEl.dataset.task = a.id;
    $('assignment-note-state').textContent = '';
  }

  const parts = [];
  // Say what this IS before anything else: a syllabus-added item has no Canvas row,
  // so there is no submit box to hunt for. Strictly the server's word — a
  // bridge that predates the origin field also predates the claim-following
  // lookup, so its `canvas_id` is null for merged items too and inferring from
  // it would pin this notice on real Canvas work.
  const aiAdded = a.origin === 'syllabus';
  if (aiAdded) {
    parts.push('<div class="notice ai-added">Added from the syllabus — not a Canvas assignment. There is nothing to submit on Canvas.</div>');
  }
  if (a.locked_for_user) {
    parts.push(`<div class="notice">Locked on Canvas${a.lock_explanation ? ` — ${esc(a.lock_explanation)}` : ''}</div>`);
  }
  if (a.description_html) {
    parts.push(`<article class="content-prose assignment-desc">${sanitizeCanvasHtml(a.description_html)}</article>`);
  } else if (!aiAdded) {
    parts.push('<p class="muted">Canvas has no description for this assignment.</p>');
  }

  if (a.mined?.description) {
    parts.push(`<h3>What this is</h3><div class="content-prose compact-prose">${renderMarkdown(a.mined.description)}</div>`);
  }
  if (a.textbooks?.length) {
    parts.push(`<h3>Textbooks</h3><ul class="assignment-textbooks">${a.textbooks.map(book => `<li>${book.url
      ? `<a class="material-link" href="${esc(book.url)}" target="_blank" rel="noopener noreferrer">${esc(book.title)}</a>`
      : `${esc(book.title)} <span class="muted">— add its PDF or e-book link in this class’s Textbooks tab</span>`}</li>`).join('')}</ul>`);
  }
  const mats = (a.mined?.related_materials || [])
    .map((material, index) => ({ ...material, index }))
    .filter(material => material.source);
  if (mats.length) {
    parts.push(`<h3>Most relevant materials</h3><ul>${mats.slice(0, 6)
      .map(m => `<li><button type="button" class="linky material-link" data-amat="${m.index}">${esc(m.file)}</button>${m.why ? ` — ${esc(m.why)}` : ''}</li>`).join('')}</ul>`);
  }
  if (a.related_files?.length) {
    parts.push(`<h3>Files from this assignment</h3><ul class="assignment-files">${a.related_files
      .map((f, i) => `<li><button type="button" class="linky" data-afile="${i}">${esc(f.name)}</button></li>`)
      .join('')}</ul>`);
  }
  if (a.raw_url && a.url && a.raw_url !== a.url) {
    parts.push(`<p class="muted footnote">This is a quiz, so the link above points at the quiz page.
      Canvas denies students the assignment-object URL (<span class="mono">${esc(a.raw_url)}</span>).</p>`);
  }
  $('assignment-body').innerHTML = parts.join('\n');

  // Reading a file opens it in the app, one panel deeper, with Back returning
  // to this assignment rather than to the class.
  $('assignment-body').querySelectorAll('[data-afile]').forEach(btn => btn.addEventListener('click', () => {
    openFile(a.folder, a.related_files[Number(btn.dataset.afile)], 'assignment');
  }));
  $('assignment-body').querySelectorAll('[data-amat]').forEach(btn => btn.addEventListener('click', () => {
    const material = a.mined.related_materials[Number(btn.dataset.amat)];
    if (material?.source) openFile(a.folder, material.source, 'assignment');
  }));
}

// One listener for the whole document: assignment links are minted by the task
// list, the calendar and the assignment page itself, and all three want the
// same behaviour.
function wireAssignment() {
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-open-assignment]');
    if (!btn) return;
    const folder = btn.dataset.assignmentClass || CURRENT?.folder;
    if (!folder) return;
    ev.preventDefault();
    openAssignment(folder, btn.dataset.openAssignment);
  });

  $('assignment-back').addEventListener('click', () => {
    // Restore the Classes pane first even when Back leads to the Calendar —
    // otherwise the next visit to Classes finds nothing showing at all.
    showClassesPanel(CURRENT ? 'detail' : 'class-home');
    if (ASSIGNMENT_RETURN === 'calendar') navTo('calendar');
  });

  // The notes field. Debounced, because writing the file on every keystroke
  // would rebuild the worklist on every keystroke — and the state line has to
  // say "Saved" rather than leaving the user wondering whether it took.
  const noteEl = $('assignment-note');
  const state = $('assignment-note-state');
  let noteTimer = null;
  noteEl?.addEventListener('input', () => {
    const { folder, task } = noteEl.dataset;
    if (!folder || !task) return;
    // The TEXT is captured here, with the task it belongs to — not inside the
    // timer. Opening another assignment within the debounce window replaces
    // both the field's value and its dataset, so a timer that read the value
    // when it fired would file the new assignment's note under the old one's
    // id and lose the note the user actually typed.
    const text = noteEl.value;
    state.textContent = 'Saving…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      try {
        await postTask(folder, task, { note: text });
        if (ASSIGNMENT?.id === task) {
          ASSIGNMENT.user_state = { ...(ASSIGNMENT.user_state ?? {}), note: text };
        }
        // Only say "Saved" on the page that is actually showing this note,
        // and only while it still reads what was saved.
        if (noteEl.dataset.task === task) {
          state.textContent = noteEl.value === text ? 'Saved' : 'Saving…';
        }
        refreshCalendarSoon();
      } catch (err) {
        if (noteEl.dataset.task === task) state.textContent = `Not saved — ${err.message}`;
        else toast(`Could not save a note on ${task}: ${err.message}`);
      }
    }, 600);
  });
}

// ---------------------------------------------------------------------------
// In-app material viewer
//
// A class file was previously a blob URL in a new tab, which for the two file
// types this app actually holds — PDF slides and PPTX decks — meant leaving
// the app to look at something the app had already read. So: read it here.
//
// Same back-button panel pattern as the assignment page above. Text, markdown,
// images and synced Canvas pages render as themselves; anything the browser
// cannot show is served as extracted text under materials/, labelled honestly
// rather than passed off as the document.
// ---------------------------------------------------------------------------

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

function extOf(p) {
  const m = /\.[a-z0-9]+$/i.exec(String(p || ''));
  return m ? m[0].toLowerCase() : '';
}

// The extractor writes materials/<the file's name>.txt. files_index says so
// explicitly; the assignment payload does not carry it, so fall back to the
// convention and let a 404 mean "no extracted text", which is the truth.
function materialsPathFor(f) {
  if (f.materialsPath) return f.materialsPath;
  const base = String(f.localPath || '').split('/').pop();
  return base ? `materials/${base}.txt` : null;
}

let FILE_VIEW = null;          // { folder, file }
let FILE_RETURN = 'detail';    // 'detail' | 'assignment'
let FILE_RETURN_SCROLL = 0;    // exact spot in the task/assignment pane
let FILE_PREVIEW_RENDER = 0;   // invalidates an in-flight PDF.js page render
let PDFJS_MODULE = null;

function cancelFilePreview() {
  FILE_PREVIEW_RENDER += 1;
}

function loadPdfJs() {
  // pdf-parse already brings this exact PDF.js build into the application.
  // Serving the module locally keeps document bytes and rendering offline.
  PDFJS_MODULE ||= import('/vendor/pdfjs/build/pdf.mjs').then(pdfjs => {
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
    return pdfjs;
  });
  return PDFJS_MODULE;
}

async function renderPdfPages(host, blob, name, renderId) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await blob.arrayBuffer());
  if (renderId !== FILE_PREVIEW_RENDER) return;

  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    wasmUrl: '/vendor/pdfjs/wasm/',
  });
  const pdf = await loadingTask.promise;
  if (renderId !== FILE_PREVIEW_RENDER) {
    await pdf.destroy();
    return;
  }

  try {
    host.innerHTML = '';
    host.setAttribute('aria-label', `${name}, ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (renderId !== FILE_PREVIEW_RENDER) return;
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const available = Math.max(280, host.clientWidth - 32);
      const cssWidth = Math.min(base.width * 1.25, available);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (cssWidth / base.width) * pixelRatio });

      const frame = document.createElement('figure');
      frame.className = 'file-pdf-page';
      frame.style.maxWidth = `${cssWidth}px`;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${name}, page ${pageNumber}`);
      frame.appendChild(canvas);
      if (pdf.numPages > 1) {
        const caption = document.createElement('figcaption');
        caption.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
        frame.appendChild(caption);
      }
      host.appendChild(frame);

      const context = canvas.getContext('2d', { alpha: false });
      await page.render({ canvasContext: context, viewport }).promise;
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
}

function classDetailScroller() {
  return document.querySelector('#view-classes > .detail');
}

function fileUrl(folder, rel) {
  return `/api/class/${folder}/file?p=${encodeURIComponent(rel)}`;
}

async function openFile(folder, file, from = 'detail') {
  const scroller = classDetailScroller();
  FILE_RETURN_SCROLL = scroller?.scrollTop ?? 0;
  FILE_VIEW = { folder, file };
  FILE_RETURN = from;
  navTo('classes');
  showClassesPanel('file-panel');
  if (scroller) scroller.scrollTop = 0;
  await renderFileView();
}

async function renderFileView() {
  const { folder, file } = FILE_VIEW;
  const isPage = file.type === 'page';
  const name = file.displayName || file.filename || file.name || file.title || 'Untitled';
  const ext = extOf(file.localPath || name);
  cancelFilePreview();
  const renderId = FILE_PREVIEW_RENDER;
  // Every await below is a point at which the user can have gone Back and
  // opened a different file: FILE_PREVIEW_RENDER advances on each open, and no
  // caller awaits this function, so two renders overlap freely. A superseded
  // render must therefore write NOTHING — not the body, not the subtitle, not
  // the Open-original target.
  //
  // The token already existed but only renderPdfPages consumed it, which made
  // the worst case the stuck one: a slow deck's fetch would paint its own
  // toolbar and an eternal "Rendering document…" box over the file the user
  // was actually looking at, then abort the page painting on the stale token
  // BEFORE clearing that placeholder. The panel was left showing one file's
  // content under another file's title, with no error and nothing to retry.
  const stale = () => renderId !== FILE_PREVIEW_RENDER;
  $('file-title').textContent = name;

  const bits = [];
  if (isPage) bits.push('Canvas page');
  if (file.size) bits.push(fmtBytes(file.size));
  if (file.pageCount) bits.push(`${file.pageCount} page${file.pageCount === 1 ? '' : 's'}`);
  if (file.slideCount) bits.push(`${file.slideCount} slide${file.slideCount === 1 ? '' : 's'}`);
  if (file.canvasUpdatedAt) bits.push(`updated ${file.canvasUpdatedAt.slice(0, 10)}`);
  $('file-sub').textContent = bits.join('  ·  ');

  $('file-open').textContent = isPage ? 'Open in Canvas' : 'Open original';
  $('file-open').classList.toggle('hidden', isPage ? !file.canvasUrl : !file.localPath);
  $('file-reveal').classList.toggle('hidden', isPage || !(IS_APP && file.localPath));
  const body = $('file-body');
  body.innerHTML = '<p class="muted">Reading…</p>';

  try {
    if (isPage) {
      const page = await apiJson(`/api/class/${folder}/page/${encodeURIComponent(file.pageId)}`);
      if (stale()) return;
      file.canvasUrl = page.canvas_url || file.canvasUrl;
      $('file-open').classList.toggle('hidden', !file.canvasUrl);
      if (page.updated_at) $('file-sub').textContent = `Canvas page  ·  updated ${page.updated_at.slice(0, 10)}`;
      body.innerHTML = page.body_html
        ? `<article class="content-prose assignment-desc">${sanitizeCanvasHtml(page.body_html)}</article>`
        : '<p class="muted">This Canvas page has no body.</p>';
      return;
    }

    if (IMAGE_EXT.has(ext)) {
      const blob = await (await api(fileUrl(folder, file.localPath))).blob();
      if (stale()) return;
      body.innerHTML = '';
      const img = document.createElement('img');
      img.className = 'file-view-img';
      img.alt = name;
      img.src = URL.createObjectURL(blob);
      body.appendChild(img);
      return;
    }

    if (TEXT_EXT.has(ext)) {
      const text = await (await api(fileUrl(folder, file.localPath))).text();
      if (stale()) return;
      body.innerHTML = `<article class="content-prose file-prose">${renderReadableText(text, ext)}</article>`;
      return;
    }

    // Preserve the source's pages whenever a PDF is available: the original
    // for PDFs, or extract-course-files.js's LibreOffice PDF for Office files.
    // PDF.js paints the authenticated bytes into canvases; Chromium's native
    // PDF iframe is blank inside the Electron/in-app browser webview.
    const preview = filePreviewPlan(file);
    if (preview) {
      const blob = await (await api(fileUrl(folder, preview.path))).blob();
      if (stale()) return;

      let extracted = '';
      const rel = materialsPathFor(file);
      if (rel) {
        try { extracted = await (await api(fileUrl(folder, rel))).text(); }
        catch { /* the page-preserving view still works without extracted text */ }
      }
      if (stale()) return;
      const hasText = extracted.trim().length > 0;
      const viewControls = hasText
        ? `<div class="file-view-toolbar">
            <div class="seg seg-sm" role="group" aria-label="Document view">
              <button type="button" class="seg-btn active" data-file-view-mode="pages" aria-pressed="true">${esc(preview.label)}</button>
              <button type="button" class="seg-btn" data-file-view-mode="text" aria-pressed="false">Text</button>
            </div>
            <span class="muted">${preview.source === 'converted' ? 'PDF preview generated from the original file' : 'Original page layout'}</span>
          </div>`
        : '';
      body.innerHTML = `${viewControls}
        <div class="file-view-pane" data-file-view-pane="pages">
          <div class="file-pdf-shell">
            <div class="file-pdf-pages" data-pdf-pages role="region" aria-busy="true">
              <div class="file-pdf-loading">Rendering document…</div>
            </div>
          </div>
        </div>
        ${hasText ? `<div class="file-view-pane hidden" data-file-view-pane="text">
          <div class="notice" data-extracted-note>Extracted text for searching and copying. Switch back to ${esc(preview.label.toLowerCase())} for the source formatting.</div>
          <article class="content-prose file-prose extracted-prose">${renderReadableText(extracted, ext)}</article>
        </div>` : ''}`;

      body.querySelectorAll('[data-file-view-mode]').forEach(button => {
        button.addEventListener('click', () => {
          const mode = button.dataset.fileViewMode;
          body.querySelectorAll('[data-file-view-mode]').forEach(candidate => {
            const active = candidate.dataset.fileViewMode === mode;
            candidate.classList.toggle('active', active);
            candidate.setAttribute('aria-pressed', active ? 'true' : 'false');
          });
          body.querySelectorAll('[data-file-view-pane]').forEach(pane =>
            pane.classList.toggle('hidden', pane.dataset.fileViewPane !== mode));
        });
      });

      const pages = body.querySelector('[data-pdf-pages]');
      try {
        await renderPdfPages(pages, blob, name, renderId);
        if (stale()) return;
        pages?.setAttribute('aria-busy', 'false');
      } catch (renderErr) {
        if (renderId !== FILE_PREVIEW_RENDER) return;
        if (hasText) {
          const note = body.querySelector('[data-extracted-note]');
          note.classList.add('alarm');
          note.textContent = 'The page preview could not be rendered, so this is the extracted text. You can still open the original file.';
          body.querySelector('[data-file-view-mode="text"]')?.click();
        } else {
          pages.innerHTML = `<div class="file-pdf-error">Could not render this document. Open the original file instead.<br><span class="mono">${esc(renderErr.message)}</span></div>`;
          pages.setAttribute('aria-busy', 'false');
        }
      }
      return;
    }

    // Everything else — PDF, PPTX, DOCX — is shown as its extracted text.
    const rel = materialsPathFor(file);
    if (!rel) throw new Error('no extractable path');
    const text = await (await api(fileUrl(folder, rel))).text();
    if (stale()) return;
    const label = ext === '.pdf' ? 'PDF' : ext === '.pptx' ? 'slide deck' : ext.replace('.', '').toUpperCase() || 'file';
    body.innerHTML =
      `<div class="notice">Readable text extracted from the ${esc(label)} — images and the original page layout are omitted.</div>
       <article class="content-prose file-prose extracted-prose">${renderReadableText(text, ext)}</article>`;
  } catch (err) {
    // A superseded render's failure is not this file's failure: painting it
    // would replace the current file's view with an error about another one.
    if (stale()) return;
    if (isPage) {
      body.innerHTML = `<div class="notice alarm">Could not load this Canvas page.</div>
        <p class="muted mono">${esc(err.message)}</p>`;
      return;
    }
    const status = file.extractionStatus;
    body.innerHTML = `<div class="notice alarm">No extracted text for this file${
      status && status !== 'done' ? ` — extraction is <span class="mono">${esc(status)}</span>` : ''
    }. Open the original instead.</div>`
      + (file.extractionError ? `<p class="muted">${esc(file.extractionError)}</p>` : '')
      + `<p class="muted mono">${esc(err.message)}</p>`;
  }
}

function wireFileView() {
  $('file-back').addEventListener('click', () => {
    cancelFilePreview();
    if (FILE_RETURN === 'assignment' && ASSIGNMENT) showClassesPanel('assignment-panel');
    else showClassesPanel(CURRENT ? 'detail' : 'class-home');
    const scroller = classDetailScroller();
    if (scroller) scroller.scrollTop = FILE_RETURN_SCROLL;
  });

  $('file-open').addEventListener('click', async () => {
    const { folder, file } = FILE_VIEW || {};
    if (file?.type === 'page') {
      if (file.canvasUrl) window.open(file.canvasUrl, '_blank', 'noopener');
      return;
    }
    if (!file?.localPath) return;
    try {
      const blob = await (await api(fileUrl(folder, file.localPath))).blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (err) { toast(`Could not open that file: ${err.message}`); }
  });

  $('file-reveal').addEventListener('click', async () => {
    // The viewed file's OWN class, never whichever class the sidebar last
    // selected — the two differ whenever the viewer was reached through the
    // calendar's assignment panel, and CURRENT may not even exist yet.
    const { file, folder } = FILE_VIEW || {};
    if (!(IS_APP && file?.localPath && folder)) return;
    let dir = CURRENT?.folder === folder ? CURRENT.class_dir : null;
    if (!dir) {
      try { dir = (await apiJson(`/api/class/${folder}`)).class_dir; }
      catch (err) { toast(`Could not locate that class folder: ${err.message}`); return; }
    }
    if (dir) window.canvasync.revealPath(`${dir}/${file.localPath}`);
  });
}

let OPEN_CLASS_SEQ = 0;

async function openClass(folder) {
  document.querySelectorAll('#class-list li').forEach(li =>
    li.classList.toggle('active', li.dataset.folder === folder));
  // Only the LATEST click may render: with no guard, a slow class A response
  // arriving after a fast class B overwrote CURRENT and the whole detail
  // pane while B stayed highlighted in the sidebar.
  const seq = ++OPEN_CLASS_SEQ;
  const data = await apiJson(`/api/class/${folder}`);
  if (seq !== OPEN_CLASS_SEQ) return;
  const changedClass = CURRENT?.folder !== folder;
  CURRENT = data;
  if (changedClass) {
    TASK_QUERY = '';
    FILE_QUERY = '';
  }
  showClassesPanel('detail');

  const meta = CURRENT.metadata || {};
  const ctxCourse = CURRENT.context?.course || {};
  // The code and the name are usually the same string with a term suffix
  // ("BUSI 305 001/002/003" / "BUSI 305 001/002/003 F26"), so joining them
  // unconditionally printed it twice.
  const dtCode = ctxCourse.code || meta.course_code || folder;
  const dtName = ctxCourse.title || meta.name || '';
  $('detail-title').textContent =
    (!dtName || dtName.startsWith(dtCode)) ? (dtName || dtCode) : `${dtCode} — ${dtName}`;
  const bits = [];
  // term may be a plain string (new context) or a Canvas enrollment_term
  // object (older context.json built before build-context normalized it).
  const termStr = typeof ctxCourse.term === 'string' ? ctxCourse.term : (ctxCourse.term?.name || '');
  if (termStr) bits.push(esc(termStr));
  if (ctxCourse.instructor?.name) bits.push(esc(ctxCourse.instructor.name));
  if (ctxCourse.meeting_schedule) bits.push(esc(ctxCourse.meeting_schedule));
  // The class's LTI course pack (HBP, Study.Net, …), one click away. The
  // content lives on the provider's site, so a link is the whole feature.
  for (const p of CURRENT.course_packs ?? []) {
    if (!p?.launch_url) continue;
    bits.push(`<a class="course-pack-link" href="${esc(p.launch_url)}" target="_blank" rel="noopener noreferrer">${esc(p.label || 'Course Pack')} ↗</a>`);
  }
  if (CURRENT.context?.last_synced) bits.push(`<span class="mono">built ${esc(CURRENT.context.last_synced.slice(0, 10))}</span>`);
  $('detail-sub').innerHTML = bits.join(' · ');

  const enr = (CURRENT.grades || []).find(e => e?.grades);
  const gs = CURRENT.grade_summary;
  if (enr?.grades?.current_score != null) {
    $('detail-grade').textContent = `${enr.grades.current_grade ? enr.grades.current_grade + ' ' : ''}${enr.grades.current_score}%`;
    $('detail-grade').classList.remove('hidden');
  } else if (gs?.current != null) {
    // Canvas leaves current_score null until it has graded work of its own to
    // report. Our own figure is computed from the same submissions, so show it
    // rather than a blank — tagged with where its weights came from.
    $('detail-grade').textContent = `${gs.current}%`;
    $('detail-grade').classList.remove('hidden');
  } else {
    $('detail-grade').classList.add('hidden');
  }

  renderTasks();
  renderTextbooks();
  renderGrades();
  $('overview-md').innerHTML = CURRENT.context_md
    ? renderMarkdown(courseOverviewMarkdown(CURRENT.context_md))
    : '<p class="muted">Context not built yet — run a sync, then Rebuild summaries.</p>';
  renderFiles();
  renderPack();
  // Meeting times come from a different endpoint and are not worth blocking the
  // page on; the block paints itself in when they land.
  MEET_EDIT = null;
  renderMeetingTimes();
  (CAL_CLASSES ? Promise.resolve(CAL_CLASSES) : loadCalClasses())
    .then(renderMeetingTimes).catch(() => {});
  // The chat rail follows the class: its header and transcript swap here.
  renderChat();
}

// Overview is the class at a glance. The generated context file also contains
// the complete task database, modules, files, announcements and discussions;
// rendering that entire upload bundle here duplicated three other tabs and
// turned a two-minute orientation into a many-screen document.
function courseOverviewMarkdown(markdown) {
  let out = String(markdown || '').replace(/^# .+\n+/, '');
  const taskList = out.search(/^## Complete task list\b/m);
  if (taskList >= 0) out = out.slice(0, taskList);
  return out.trim();
}

// --- Textbooks ------------------------------------------------------------
// Names are extracted from the syllabus; only the access link is editable.
// That division is visible in the form so a sync-owned title never looks like
// a field the user is expected to maintain.
function textbookMeta(book) {
  return [book.author, book.edition, book.isbn ? `ISBN ${book.isbn}` : null]
    .filter(Boolean).map(esc).join(' · ');
}

function renderTextbooks() {
  const root = $('tab-textbooks');
  if (!root || !CURRENT) return;
  const books = CURRENT.textbooks ?? [];
  if (!books.length) {
    const parsed = Array.isArray(CURRENT.syllabus_parsed?.textbooks);
    root.innerHTML = `<div class="empty-state"><b>${parsed ? 'No textbooks listed' : 'Textbooks have not been indexed yet'}</b><span>${
      parsed
        ? 'The synced syllabus does not name a required or recommended textbook.'
        : 'Run Rebuild summaries once to fill this tab from the class syllabus.'
    }</span></div>`;
    return;
  }

  root.innerHTML = `
    <div class="textbook-intro">
      <div>
        <h3>Course textbooks</h3>
        <p class="muted">Names come from the syllabus. Paste a PDF or e-book link once and assignments that reference that book will use it automatically.</p>
      </div>
      <span class="textbook-count">${books.length} title${books.length === 1 ? '' : 's'}</span>
    </div>
    <div class="textbook-list">${books.map(book => `
      <section class="textbook-row" data-textbook="${esc(book.id)}">
        <div class="textbook-copy">
          <div class="textbook-title-line">
            <h3>${esc(book.title)}</h3>
            <span class="badge">${book.required ? 'required' : 'recommended / optional'}</span>
          </div>
          ${textbookMeta(book) ? `<div class="textbook-meta">${textbookMeta(book)}</div>` : ''}
        </div>
        <form class="textbook-link-form" data-textbook-form>
          <label class="sr-only" for="textbook-url-${esc(book.id)}">PDF or e-book link for ${esc(book.title)}</label>
          <input id="textbook-url-${esc(book.id)}" type="url" inputmode="url" data-textbook-url
                 value="${esc(book.url ?? '')}" placeholder="https://… PDF or e-book link" autocomplete="off" />
          <button type="submit" data-textbook-save>${book.url ? 'Update link' : 'Save link'}</button>
          ${book.url ? `<a class="btn-link" href="${esc(book.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
            <button type="button" class="linky textbook-clear" data-textbook-clear>Clear</button>` : ''}
          <span class="note-state" data-textbook-state></span>
        </form>
      </section>`).join('')}</div>`;
}

function updateTextbookEverywhere(textbook) {
  CURRENT.textbooks = (CURRENT.textbooks ?? []).map(book => book.id === textbook.id ? textbook : book);
  for (const item of CURRENT.mined?.items ?? []) {
    item.textbooks = (item.textbooks ?? []).map(book => book.id === textbook.id ? textbook : book);
  }
  if (ASSIGNMENT?.folder === CURRENT.folder) {
    ASSIGNMENT.textbooks = (ASSIGNMENT.textbooks ?? []).map(book => book.id === textbook.id ? textbook : book);
  }
}

async function saveTextbookLink(form, value) {
  const id = form.closest('[data-textbook]')?.dataset.textbook;
  if (!id || !CURRENT) return;
  const folder = CURRENT.folder;
  const button = form.querySelector('[data-textbook-save]');
  const state = form.querySelector('[data-textbook-state]');
  button.disabled = true;
  state.textContent = 'Saving…';
  try {
    const result = await apiJson(`/api/class/${folder}/textbooks/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify({ url: value || null }),
    });
    // A slow save may finish after the student has opened another class. The
    // link is safely stored for its original class; do not paint it into the
    // newly selected class's in-memory textbook list.
    if (CURRENT?.folder !== folder) return;
    updateTextbookEverywhere(result.textbook);
    renderTextbooks();
    renderTasks();
    toast(result.textbook.url ? 'Textbook link saved.' : 'Textbook link cleared.');
  } catch (err) {
    button.disabled = false;
    state.textContent = err.message;
  }
}

function wireTextbooks() {
  const root = $('tab-textbooks');
  root.addEventListener('submit', (ev) => {
    const form = ev.target.closest('[data-textbook-form]');
    if (!form) return;
    ev.preventDefault();
    saveTextbookLink(form, form.querySelector('[data-textbook-url]').value.trim());
  });
  root.addEventListener('click', (ev) => {
    const clear = ev.target.closest('[data-textbook-clear]');
    if (!clear) return;
    const form = clear.closest('[data-textbook-form]');
    saveTextbookLink(form, null);
  });
}

// All date math is LOCAL time — a UTC slice would put late-evening deadlines
// on the wrong day for anyone west of Greenwich.
const DAY_MS = 864e5;
function localMidnight() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function localTodayIso() {
  const t = localMidnight();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function daysUntil(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return Math.round((new Date(y, mo - 1, d) - localMidnight()) / DAY_MS);
}

// Same whole-day diff for a full Canvas timestamp — the assignment page's
// due_at carries a time, and the day it belongs to is the LOCAL day.
function daysUntilIso(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null
    : Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - localMidnight()) / DAY_MS);
}

// The one mark for "how impending": the distance itself ("in 3 days", "in 2
// weeks"), graded by the dueTier ladder — muted, then amber inside a week,
// then brick. Every dated item routes through this so the task list, the
// checkpoints, the home page, the assignment page and the calendar can never
// disagree about what urgent looks like.
function dueRelHtml(diff, cls = '', { done = false } = {}) {
  // A finished item is never urgent, whatever its date says — the same rule
  // the calendar applies to its rows.
  const tier = done ? '' : dueTier(diff);
  return `<span class="due-rel${cls ? ` ${cls}` : ''}${tier ? ` ${tier}` : ''}">${esc(relPhrase(diff))}</span>`;
}

// "2:30–3:45 PM" rather than "2:30 PM–3:45 PM". The meridiem is only worth
// stating twice when the range actually crosses noon or midnight, and the
// shorter form is what keeps a class time inside its column instead of
// overrunning the title beside it.
function fmtTimeSpan(start, end) {
  const a = fmtTime12(start);
  const b = end ? fmtTime12(end) : '';
  // A span whose START could not be read is not a span, and returning the end
  // on its own printed a finish time in the place a start time goes: an item
  // ending at 3pm read as one beginning at 3pm, with nothing to say otherwise.
  // "until" is four characters to keep that from being silent.
  if (!a) return b ? `until ${b}` : '';
  if (!b) return a;
  const ap = a.slice(-2);
  return ap === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}

// "2:30p", "9a" — the shortest honest form of a time. A week column is about
// 170px wide at 1280 and "2:30 PM" plus a checkbox plus a title does not fit;
// dropping a zero minute and the space before the meridiem buys the title back
// four characters without inventing or rounding anything.
function fmtTimeChip(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  if (!m) return '';
  let h = Number(m[1]);
  const ap = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return m[2] === '00' ? `${h}${ap}` : `${h}:${m[2]}${ap}`;
}

function fmtTime12(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  if (!m) return '';
  let h = Number(m[1]);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}

// "Oct 7" — the short date for tight rows (checkpoints), which pair it with a
// graded relative label rather than spelling the whole thing out.
function fmtShortDate(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "due Tue 11:59 PM · in 3 days" — weekday inside a week, date beyond it.
// Takes the effective date so a moved deadline reads as the moved one.
// Returns HTML (everything escaped here): the relative part carries the
// urgency tier, the rest stays quiet ink.
function fmtDue(it, eff) {
  const date = eff?.date ?? it.due_date;
  const timeRaw = eff?.time ?? it.due_time;
  if (!date) return esc(it.recurring || 'no date');
  const [y, mo, d] = date.split('-').map(Number);
  const due = new Date(y, mo - 1, d);
  const diff = daysUntil(date);
  const time = fmtTime12(timeRaw);
  const day = (diff >= 0 && diff <= 6)
    ? due.toLocaleDateString('en-US', { weekday: 'short' })
    : due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const when = time ? `${day} ${time}` : day;
  return `due ${esc(when)} · ${dueRelHtml(diff)}`;
}

// One in-flight POST chain per calDoneKey — see the tick handler.
const CAL_POST_QUEUE = new Map();

// The user's own marks, keyed by mined item id. Held here so a checkbox can
// repaint instantly and reconcile with the bridge afterwards, rather than
// making every tick wait on a round trip.
function taskState(id) {
  return (CURRENT?.user_state ?? {})[id] ?? {};
}

// A moved date wins over the mined one everywhere: the list, the sort, the
// grouping and the calendar all read through this, so "moved to Friday" cannot
// mean one thing in the task list and another in the worklist.
function effectiveDue(it) {
  const st = taskState(it.id);
  return {
    date: st.dueOverride ?? it.due_date ?? null,
    time: st.timeOverride ?? it.due_time ?? null,
    moved: !!st.dueOverride,
  };
}

async function patchTaskState(id, patch) {
  const folder = CURRENT.folder;
  const res = await apiJson(`/api/class/${folder}/task/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify(patch),
  });
  CURRENT.user_state = CURRENT.user_state ?? {};
  if (res.item) CURRENT.user_state[id] = res.item;
  else delete CURRENT.user_state[id];
  return res.item;
}

function renderCheckpoints(it) {
  const cps = taskState(it.id).checkpoints ?? [];
  const rows = cps.map(cp => `
    <li class="cp-row${cp.done ? ' done' : ''}">
      <input type="checkbox" data-cp-done="${esc(cp.id)}"${cp.done ? ' checked' : ''}>
      <span class="cp-title">${esc(cp.title)}</span>
      <span class="cp-date">${cp.date ? `${esc(fmtShortDate(cp.date))} · ${dueRelHtml(daysUntil(cp.date))}` : ''}</span>
      <button type="button" class="linky cp-del" data-cp-del="${esc(cp.id)}">remove</button>
    </li>`).join('');
  return `
    <div class="task-checkpoints">
      <ul class="cp-list">${rows}</ul>
      <div class="cp-add">
        <input type="text" data-cp-new-title placeholder="Add a checkpoint — outline, draft, rehearse…">
        <input type="date" data-cp-new-date>
        <button type="button" data-cp-add>Add</button>
      </div>
    </div>`;
}

function renderTaskEditor(it) {
  const st = taskState(it.id);
  const eff = effectiveDue(it);
  const flag = st.flag ?? 'none';
  return `
    <div class="task-editor">
      <div class="te-row">
        <span class="te-label">Flag</span>
        <div class="seg seg-sm">
          ${['none', 'priority', 'blocked'].map(f => `
            <button type="button" class="seg-btn${flag === f ? ' active' : ''}" data-flag="${f}">${f}</button>`).join('')}
        </div>
        <span class="te-label">Move to</span>
        <input type="date" data-due value="${esc(eff.date ?? '')}">
        <input type="time" data-time value="${esc(eff.time ? eff.time.slice(0, 5) : '')}">
        ${eff.moved ? '<button type="button" class="linky" data-due-reset>reset to original</button>' : ''}
      </div>
      <textarea data-note rows="2" placeholder="Notes — what is left, what to ask, where you got stuck">${esc(st.note ?? '')}</textarea>
      ${renderCheckpoints(it)}
    </div>`;
}

let TASK_SCOPE = ['focus', 'term', 'done'].includes(localStorage.getItem('taskScope'))
  ? localStorage.getItem('taskScope') : 'focus';
let TASK_QUERY = '';

function taskCardHtml(it) {
  const st = taskState(it.id);
  const eff = effectiveDue(it);
  const due = fmtDue(it, eff);
  const mats = (it.related_materials || [])
    .map((material, index) => ({ ...material, index }))
    .filter(material => material.source)
    .slice(0, 4)
    .map(m => `<li><button type="button" class="linky material-link" data-task-material="${m.index}">${esc(m.file)}</button>${m.why ? ` \u2014 ${esc(m.why)}` : ''}</li>`).join('');
  const textbooks = (it.textbooks || []).map(book => `<li>${book.url
    ? `<a class="material-link" href="${esc(book.url)}" target="_blank" rel="noopener noreferrer">${esc(book.title)}</a>`
    : `${esc(book.title)} <span class="muted">— add its link in Textbooks</span>`}</li>`).join('');
  const cps = st.checkpoints ?? [];
  const cpsDone = cps.filter(c => c.done).length;
  const aiAdded = it.origin ? it.origin === 'syllabus' : it.kind === 'implicit';
  const classes = ['task'];
  if (aiAdded) classes.push('ai-added');
  if (st.done) classes.push('is-done');
  if (st.flag) classes.push(`flag-${esc(st.flag)}`);
  return `
    <article class="${classes.join(' ')}" data-task="${esc(it.id)}">
      <div class="task-top">
        <input type="checkbox" class="task-check" data-done${st.done ? ' checked' : ''}
               aria-label="Mark ${esc(it.title)} complete">
        ${taskTitleHtml(it)}
        <span class="task-due">${due}</span>
      </div>
      <div class="task-badges">
        <span class="badge">${esc(it.category || 'other')}</span>
        ${aiAdded ? '<span class="badge ai-added" title="Added from the syllabus — not a Canvas assignment, nothing to submit on Canvas">syllabus</span>' : ''}
        ${it.points_possible != null ? `<span class="badge">${esc(it.points_possible)} pts</span>` : ''}
        ${it.due_confidence && it.due_confidence !== 'high' ? `<span class="badge implicit">${esc(it.due_confidence)} confidence date</span>` : ''}
        ${eff.moved ? '<span class="badge moved">moved</span>' : ''}
        ${cps.length ? `<span class="badge">${cpsDone}/${cps.length} checkpoints</span>` : ''}
        ${st.note ? '<span class="badge">note</span>' : ''}
      </div>
      ${it.description ? `<div class="task-desc">${esc(it.description)}</div>` : ''}
      ${textbooks ? `<div class="task-textbooks">Textbook<ul>${textbooks}</ul></div>` : ''}
      ${mats ? `<div class="task-materials">Relevant materials<ul>${mats}</ul></div>` : ''}
      <button type="button" class="linky task-toggle" data-toggle>Edit</button>
      <div class="task-editor-slot hidden"></div>
    </article>`;
}

function applyTaskQuery() {
  const root = $('tab-tasks');
  const q = TASK_QUERY.trim().toLocaleLowerCase();
  let visible = 0;
  root.querySelectorAll('.task-group').forEach(group => {
    let groupVisible = 0;
    group.querySelectorAll('.task').forEach(task => {
      const match = !q || task.textContent.toLocaleLowerCase().includes(q);
      task.classList.toggle('search-hidden', !match);
      if (match) { visible += 1; groupVisible += 1; }
    });
    group.classList.toggle('search-hidden', groupVisible === 0);
    const groupCount = group.querySelector('[data-task-group-count]');
    if (groupCount) groupCount.textContent = q ? groupVisible : groupCount.dataset.taskGroupCount;
  });
  const count = $('task-search-count');
  if (count) count.textContent = q ? `${visible} match${visible === 1 ? '' : 'es'}` : '';
  const empty = $('task-search-empty');
  if (empty) empty.classList.toggle('hidden', !q || visible > 0);
}

function renderTasks() {
  const el = $('tab-tasks');
  const items = CURRENT.mined?.items || [];
  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><b>No tasks yet</b><span>Canvas lists no dated assignments, and the synced files have not yielded any work.</span></div>';
    return;
  }
  const today = localTodayIso();
  const focusEnd = addDays(today, 14);
  const groups = { Upcoming: [], Recurring: [], 'Needs a date': [], Completed: [], Overdue: [] };
  for (const it of items) {
    const eff = effectiveDue(it);
    if (taskState(it.id).done) groups.Completed.push(it);
    else if (it.recurring) groups.Recurring.push(it);
    else if (!eff.date) groups['Needs a date'].push(it);
    else if (eff.date >= today) groups.Upcoming.push(it);
    else groups.Overdue.push(it);
  }
  const dateOf = (it) => effectiveDue(it).date ?? '';
  groups.Upcoming.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
  groups.Overdue.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));

  const activeCount = items.length - groups.Completed.length;
  const laterCount = groups.Upcoming.filter(it => dateOf(it) > focusEnd).length;
  const scoped = {};
  for (const [label, group] of Object.entries(groups)) {
    if (TASK_SCOPE === 'done') scoped[label] = label === 'Completed' ? group : [];
    else if (label === 'Completed') scoped[label] = [];
    else if (TASK_SCOPE === 'focus' && label === 'Upcoming') scoped[label] = group.filter(it => dateOf(it) <= focusEnd);
    else scoped[label] = group;
  }

  const sourceNote = CURRENT.mined?.source === 'canvas'
    ? '<p class="notice compact-notice">Showing Canvas assignments only. Rebuild the index to inspect the syllabus and files too.</p>'
    : '';
  const scopeNote = TASK_SCOPE === 'focus'
    ? `Due through ${esc(fmtShortDate(focusEnd))}${laterCount ? ` · <button type="button" class="linky" data-task-more>${laterCount} later task${laterCount === 1 ? '' : 's'}</button>` : ''}`
    : TASK_SCOPE === 'term'
      ? `${activeCount} open task${activeCount === 1 ? '' : 's'} across the term`
      : `${groups.Completed.length} completed task${groups.Completed.length === 1 ? '' : 's'}`;

  const html = [`
    <div class="task-toolbar">
      <div>
        <div class="seg" role="group" aria-label="Task range">
          ${[['focus', 'Next 2 weeks'], ['term', 'Full term'], ['done', 'Completed']].map(([key, label]) =>
            `<button type="button" class="seg-btn${TASK_SCOPE === key ? ' active' : ''}" data-task-scope="${key}">${label}</button>`).join('')}
        </div>
        <div class="task-scope-note">${scopeNote}</div>
      </div>
      <label class="search-control">
        <span class="sr-only">Search tasks</span>
        <input id="task-search" data-task-search type="search" value="${esc(TASK_QUERY)}" placeholder="Search tasks" autocomplete="off" />
        <span id="task-search-count" class="search-count"></span>
      </label>
    </div>
    ${sourceNote}
    <div id="task-search-empty" class="empty-state hidden"><b>No matching tasks</b><span>Try a different title, category, or material.</span></div>`];

  for (const [label, group] of Object.entries(scoped)) {
    if (!group.length) continue;
    html.push(`<section class="task-group"><h3 class="task-group-title"><span>${label}</span><span data-task-group-count="${group.length}">${group.length}</span></h3>${group.map(taskCardHtml).join('')}</section>`);
  }
  if (!Object.values(scoped).some(group => group.length)) {
    html.push(`<div class="empty-state"><b>${TASK_SCOPE === 'done' ? 'Nothing completed yet' : 'Nothing due in the next two weeks'}</b><span>${TASK_SCOPE === 'focus' && laterCount ? 'Your later work is still available under Full term.' : ''}</span></div>`);
  }
  el.innerHTML = html.join('');
  applyTaskQuery();
}

// One delegated listener for the whole task list. Re-rendering on every edit
// would close whatever the user had open and blur the field they were typing
// in, so the handlers repaint the smallest thing that changed.
function wireTasks() {
  const root = $('tab-tasks');

  const taskEl = (target) => target.closest('.task');
  const idOf = (target) => taskEl(target)?.dataset.task;

  // Editing a note on every keystroke would write the file on every keystroke.
  const noteTimers = new Map();

  root.addEventListener('click', async (ev) => {
    const el = ev.target;

    if (el.matches('[data-task-scope]')) {
      TASK_SCOPE = el.dataset.taskScope;
      localStorage.setItem('taskScope', TASK_SCOPE);
      renderTasks();
      return;
    }
    if (el.matches('[data-task-more]')) {
      TASK_SCOPE = 'term';
      localStorage.setItem('taskScope', TASK_SCOPE);
      renderTasks();
      return;
    }

    const id = idOf(el);
    if (!id) return;
    const task = taskEl(el);

    if (el.matches('[data-task-material]')) {
      const item = (CURRENT.mined?.items || []).find(i => i.id === id);
      const material = item?.related_materials?.[Number(el.dataset.taskMaterial)];
      if (material?.source) await openFile(CURRENT.folder, material.source, 'detail');
      return;
    }

    if (el.matches('[data-toggle]')) {
      const slot = task.querySelector('.task-editor-slot');
      const opening = slot.classList.contains('hidden');
      if (opening) {
        const item = (CURRENT.mined?.items || []).find(i => i.id === id);
        slot.innerHTML = renderTaskEditor(item);
      } else {
        slot.innerHTML = '';
      }
      slot.classList.toggle('hidden', !opening);
      el.textContent = opening ? 'Close' : 'Edit';
      return;
    }

    if (el.matches('[data-flag]')) {
      const flag = el.dataset.flag;
      await patchTaskState(id, { flag }).catch(() => {});
      el.parentElement.querySelectorAll('.seg-btn')
        .forEach(b => b.classList.toggle('active', b === el));
      task.classList.remove('flag-priority', 'flag-blocked');
      if (flag !== 'none') task.classList.add(`flag-${flag}`);
      return;
    }

    if (el.matches('[data-due-reset]')) {
      await patchTaskState(id, { dueOverride: null, timeOverride: null }).catch(() => {});
      renderTasks();
      return;
    }

    if (el.matches('[data-cp-add]')) {
      const wrap = task.querySelector('.cp-add');
      const title = wrap.querySelector('[data-cp-new-title]').value.trim();
      if (!title) return;
      const date = wrap.querySelector('[data-cp-new-date]').value || null;
      const cps = [...(taskState(id).checkpoints ?? []), { title, date }];
      await patchTaskState(id, { checkpoints: cps }).catch(() => {});
      const item = (CURRENT.mined?.items || []).find(i => i.id === id);
      task.querySelector('.task-checkpoints').outerHTML = renderCheckpoints(item);
      return;
    }

    if (el.matches('[data-cp-del]')) {
      const cps = (taskState(id).checkpoints ?? []).filter(c => c.id !== el.dataset.cpDel);
      await patchTaskState(id, { checkpoints: cps }).catch(() => {});
      const item = (CURRENT.mined?.items || []).find(i => i.id === id);
      task.querySelector('.task-checkpoints').outerHTML = renderCheckpoints(item);
    }
  });

  root.addEventListener('change', async (ev) => {
    const el = ev.target;
    const id = idOf(el);
    if (!id) return;

    if (el.matches('[data-done]')) {
      await patchTaskState(id, { done: el.checked }).catch(() => {});
      renderTasks();   // the item moves between groups, so a full repaint is right
      return;
    }
    if (el.matches('[data-cp-done]')) {
      const cps = (taskState(id).checkpoints ?? [])
        .map(c => c.id === el.dataset.cpDone ? { ...c, done: el.checked } : c);
      await patchTaskState(id, { checkpoints: cps }).catch(() => {});
      el.closest('.cp-row').classList.toggle('done', el.checked);
      return;
    }
    if (el.matches('[data-due]') || el.matches('[data-time]')) {
      const task = taskEl(el);
      const date = task.querySelector('[data-due]').value || null;
      const time = task.querySelector('[data-time]').value || null;
      await patchTaskState(id, { dueOverride: date, timeOverride: date ? time : null })
        .catch(err => { $('tab-tasks').dataset.error = err.message; });
      renderTasks();
    }
  });

  root.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.matches('[data-task-search]')) {
      TASK_QUERY = el.value;
      // Searching should search the class, not only the two-week slice that is
      // currently rendered. Move to the term view once the user types; the
      // visible scope control makes that expansion explicit.
      if (TASK_QUERY.trim() && TASK_SCOPE === 'focus') {
        TASK_SCOPE = 'term';
        localStorage.setItem('taskScope', TASK_SCOPE);
        renderTasks();
        const input = $('task-search');
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
        return;
      }
      applyTaskQuery();
      return;
    }
    const id = idOf(el);
    if (!id || !el.matches('[data-note]')) return;
    clearTimeout(noteTimers.get(id));
    noteTimers.set(id, setTimeout(() => {
      patchTaskState(id, { note: el.value }).catch(() => {});
    }, 600));
  });
}

// Files are bunched by where on Canvas they were found — one category section
// for assignments, quizzes, pages, etc., while the course's individual modules
// remain separate sections. The exact item stays beneath each file name.
let FILE_SORT = localStorage.getItem('fileSort') || 'source';
let FILE_QUERY = '';

// ---------------------------------------------------------------------------
// Grades tab
//
// Where the home card shows the shape, this shows the working. Every refusal
// the engine made is printed: a student who sees no projected grade is owed the
// reason, and the reasons here are specific and actionable — BUSI 305's exams
// are 85% of the grade and are not in Canvas at all, so no honest total exists
// until they are.
// ---------------------------------------------------------------------------

const REFUSAL_TEXT = {
  syllabus_unmapped: n => `Not totalled: ${n}`,
  syllabus_weights_incomplete: n => `Not totalled: ${n}`,
  syllabus_ambiguous: n => `Not totalled: ${n}`,
  canvas_weighted_but_unset: n => n,
  unweighted_work: n => n,
  drops_pending: n => n,
  points_mode_with_stated_scheme: n => n,
  canvas_totals_by_points: n => n,
};

const STATE_LABEL = {
  graded: '', hidden: 'withheld', excused: 'excused', missing: 'missing',
  submitted: 'submitted', pending: '', not_counted: '',
};

function renderGrades() {
  const host = $('tab-grades');
  const g = CURRENT?.grade_summary;
  if (!g || !g.counted) {
    host.innerHTML = '<p class="muted">Canvas lists no graded work for this class.</p>';
    return;
  }

  const head = `<div class="gr-head">
      <div class="gr-now">
        <span class="gr-pct${g.current == null ? ' none' : ''}">${g.current == null ? '—' : g.current + '%'}</span>
        <span class="gr-sub">${g.graded} of ${g.counted} graded</span>
      </div>
      ${g.floor != null && !(g.floor === 0 && g.ceiling === 100) ? `<div class="gr-band">
        <span class="gr-band-num">${g.floor}%</span>
        <span class="gr-band-bar"><i style="left:${g.floor}%;right:${100 - g.ceiling}%"></i></span>
        <span class="gr-band-num">${g.ceiling}%</span>
      </div>` : ''}
      <span class="gr-scheme">${esc(schemeTag(g.scheme))}${
        g.scheme.mode === 'weighted' && g.scheme.weightSum !== 100 ? ` · ${g.scheme.weightSum}%` : ''}</span>
    </div>`;

  const rows = g.buckets.filter(b => b.total > 0 || b.weight).map(b => `
      <tr>
        <td>${esc(b.name)}</td>
        <td class="num">${b.weight == null ? '' : b.weight + '%'}</td>
        <td class="num">${b.graded} / ${b.total}</td>
        <td class="num">${b.possible > 0 ? `${b.earned} / ${b.possible}` : ''}</td>
        <td class="num">${b.pct == null ? '' : b.pct + '%'}</td>
        <td class="gr-drop">${b.dropped ? `${b.dropped} dropped`
          : b.dropsPending ? `${b.dropsPending} to drop` : ''}</td>
      </tr>`).join('');

  const table = rows ? `<table class="gr-table">
      <thead><tr><th>Component</th><th class="num">Weight</th><th class="num">Graded</th>
        <th class="num">Points</th><th class="num">Score</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>` : '';

  const notes = (g.refusals ?? []).map(r =>
    `<li>${esc((REFUSAL_TEXT[r.reason] ?? (x => x))(r.detail))}</li>`).join('');

  // The syllabus scheme is worth showing even when it could not be used for
  // arithmetic — it is what the professor actually grades by.
  const stated = (g.scheme.stated ?? []);
  const statedHtml = (g.scheme.source !== 'syllabus' && stated.length)
    ? `<table class="gr-table gr-stated">
        <thead><tr><th>Stated in the syllabus</th><th class="num">Weight</th></tr></thead>
        <tbody>${stated.map(c => `<tr><td>${esc(c.name)}</td>
          <td class="num">${c.weight_pct}%</td></tr>`).join('')}</tbody></table>` : '';

  const items = (g.items ?? []).filter(i => i.state !== 'not_counted');
  const itemRows = items.map(i => `
      <tr class="gr-item ${esc(i.state)}">
        <td>${esc(i.name)}</td>
        <td class="gr-bucket">${esc(i.bucket ?? '')}</td>
        <td class="num">${i.score == null ? '<span class="gr-of">—</span>' : i.score}${
          i.points ? `<span class="gr-of"> / ${i.points}</span>` : ''}</td>
        <td class="gr-state">${esc(STATE_LABEL[i.state] ?? '')}${i.late ? ' late' : ''}</td>
      </tr>`).join('');

  host.innerHTML = head + table + statedHtml
    + (notes ? `<ul class="gr-notes">${notes}</ul>` : '')
    + (itemRows ? `<table class="gr-table gr-items"><tbody>${itemRows}</tbody></table>` : '');
}

function renderFiles() {
  const el = $('tab-files');
  // Superseded copies are hidden the same way duplicates are: a re-uploaded
  // syllabus leaves the old file on disk, and listing both under one name is
  // how the student ends up reading last month's dates.
  const files = (CURRENT.files_index || []).filter(f => f && !f.duplicateOf && f.supersededBy == null);
  if (!files.length) {
    el.innerHTML = '<div class="empty-state"><b>No downloaded files</b><span>Files will appear here after the next Canvas sync.</span></div>';
    return;
  }

  const query = FILE_QUERY.trim().toLocaleLowerCase();
  const shownFiles = query
    ? files.filter(f => [fileName(f), originDetail(f), originHeading(primaryOrigin(f)), f.extractionStatus]
      .some(value => String(value || '').toLocaleLowerCase().includes(query)))
    : files;

  const toolbar = `<div class="files-toolbar">
    <div>
      <b>${shownFiles.length}</b> <span class="muted">of ${files.length} file${files.length === 1 ? '' : 's'}</span>
      <div class="seg seg-sm" role="group" aria-label="Sort files">
        ${[['source', 'Source'], ['name', 'Name'], ['date', 'Newest']].map(([k, lbl]) =>
          `<button type="button" class="seg-btn${FILE_SORT === k ? ' active' : ''}" data-fsort="${k}">${lbl}</button>`,
        ).join('')}
      </div>
    </div>
    <label class="search-control">
      <span class="sr-only">Search files</span>
      <input id="file-search" type="search" value="${esc(FILE_QUERY)}" placeholder="Search files" autocomplete="off" />
    </label>
  </div>`;

  // Index by position in `files` so the click handlers stay O(1) regardless of
  // how the rows were grouped or sorted.
  const idx = new Map(files.map((f, i) => [f, i]));
  const row = (f) => {
    const i = idx.get(f);
    const detail = FILE_SORT === 'source' ? originDetail(f) : originHeading(primaryOrigin(f));
    return `<tr>
      <td>
        <div class="file-name">${esc(fileName(f))}</div>
        ${detail ? `<div class="file-src">${esc(detail)}</div>` : ''}
      </td>
      <td>${esc((f.canvasUpdatedAt || '').slice(0, 10))}</td>
      <td>${f.extractionStatus === 'done' ? 'extracted' : esc(f.extractionStatus || '—')}</td>
      <td class="actions">
        ${f.localPath ? `<button data-view-file="${i}">View</button>` : ''}
        ${IS_APP && f.localPath ? `<button data-reveal-file="${i}">Show in Finder</button>` : ''}
      </td>
    </tr>`;
  };
  const head = '<tr><th>File</th><th>Updated</th><th>Text</th><th></th></tr>';

  let body;
  if (!shownFiles.length) {
    body = '<div class="empty-state"><b>No matching files</b><span>Try a file name, source, or type.</span></div>';
  } else if (FILE_SORT === 'source') {
    body = groupFilesBySource(shownFiles).map(g => `
      <details class="file-group"${query || shownFiles.length <= 12 ? ' open' : ''}>
        <summary class="file-group-head"><span>${esc(g.heading)}</span><span>${g.files.length}</span></summary>
        <div class="file-group-body"><table class="files">${head}${g.files.map(row).join('')}</table></div>
      </details>`).join('');
  } else {
    const sorted = shownFiles.slice().sort(FILE_SORT === 'name'
      ? (a, b) => fileName(a).localeCompare(fileName(b))
      : (a, b) => String(b.canvasUpdatedAt || '').localeCompare(String(a.canvasUpdatedAt || '')));
    body = `<table class="files">${head}${sorted.map(row).join('')}</table>`;
  }
  el.innerHTML = toolbar + body;

  el.querySelectorAll('[data-fsort]').forEach(btn => btn.addEventListener('click', () => {
    FILE_SORT = btn.dataset.fsort;
    localStorage.setItem('fileSort', FILE_SORT);
    renderFiles();
  }));
  $('file-search')?.addEventListener('input', (ev) => {
    FILE_QUERY = ev.target.value;
    renderFiles();
    const input = $('file-search');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
  el.querySelectorAll('[data-view-file]').forEach(btn => btn.addEventListener('click', () => {
    openFile(CURRENT.folder, files[Number(btn.dataset.viewFile)], 'detail');
  }));
  el.querySelectorAll('[data-reveal-file]').forEach(btn => btn.addEventListener('click', () => {
    const f = files[Number(btn.dataset.revealFile)];
    window.canvasync.revealPath(`${CURRENT.class_dir}/${f.localPath}`);
  }));
}

function renderPack() {
  const el = $('tab-pack');
  const files = CURRENT.pack_files || [];
  // Label only. The files still live under AI_CONTEXT/pack/ on disk and the
  // route that serves them is unchanged — this is what the user calls it.
  if (!files.length) {
    el.innerHTML = '<p class="muted">Not built yet. Run Rebuild summaries after a sync.</p>';
    return;
  }
  const fmt = (n) => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1000) + ' KB';
  const rows = files.map((f, i) => `
    <div class="pack-file">
      <span>${esc(f.name)} <span class="muted mono">· ${fmt(f.size)}</span></span>
      <span>
        <button data-dl-pack="${i}">Download</button>
      </span>
    </div>`).join('');
  const openBtn = IS_APP ? `<div class="row-actions"><button id="open-pack-btn">Open folder</button></div>` : '';
  el.innerHTML = rows + openBtn;

  el.querySelectorAll('[data-dl-pack]').forEach(btn => btn.addEventListener('click', async () => {
    const f = files[Number(btn.dataset.dlPack)];
    const res = await api(`/api/class/${CURRENT.folder}/file?p=${encodeURIComponent('AI_CONTEXT/pack/' + f.name)}`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = f.name;
    a.click();
  }));
  if (IS_APP) $('open-pack-btn')?.addEventListener('click', () => window.canvasync.openPath(CURRENT.pack_dir));
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

// "Mon 8/25" — the hanging day label left of the margin rule.
// --- Calendar ----------------------------------------------------------------
// The worklist is a flat, chronologically-sorted array of ~100 ops. Rendering it
// as a flat list repeated the date on every row and interleaved every class, so
// nothing was scannable. Group it: by day (with classes nested) or by class
// (with days nested), switchable from the toolbar.

let CAL_WORKLIST = null;
let CAL_GROUP = localStorage.getItem('calGroup') || 'day';

// ---------------------------------------------------------------------------
// Items the user added themselves.
//
// These are the one kind of calendar entry the pipeline cannot regenerate, and
// the client is their authority between edits: the worklist only learns about
// a new item when the debounced rebuild lands, which is ~2 seconds after the
// user let go of the mouse. So the ops drawn for them are derived from THIS
// list, and any custom op the worklist happens to carry is dropped on the way
// in — one source, so a dragged item can never be drawn twice or snap back to
// where it was for a second and a half. CALENDAR-SPEC §8.
// ---------------------------------------------------------------------------

let CAL_CUSTOM = [];   // the user's own items, newest state, straight from the bridge

// The reserved pseudo-class an item with no class wears, so the chips row, the
// colour map and the filters have one thing to name rather than a null.
const PERSONAL_SLUG = 'personal';
const PERSONAL_COLOR = '#6A6152';

/**
 * One stored item as the op the calendar draws.
 *
 * Deliberately NOT the server's op: that one carries a marker (a content hash
 * the browser cannot compute synchronously) and a class-prefixed title that
 * every renderer here strips again anyway. This is exactly the fields the
 * grid, the list and the dialog read, so the two cannot disagree about
 * anything the user can see.
 */
function customRenderOp(item) {
  return {
    calendar: 'custom',
    kind: 'personal',
    title: item.title,
    date: item.date,
    end_date: item.end_date ?? null,
    time: item.time ?? null,
    end_time: item.end_time ?? null,
    all_day: !item.time,
    description: item.description || '',
    note: item.description || null,
    category: 'personal',
    class: item.class || PERSONAL_SLUG,
    custom_id: item.id,
    origin: 'user',
    _custom: item,
  };
}

function customItemById(id) {
  return CAL_CUSTOM.find(it => it.id === id) ?? null;
}
// Items ticked off here since the last worklist load. The worklist itself
// drops finished work (the routine must not create events for it), so without
// this a ticked row would vanish mid-click with no acknowledgement.
//
// Seeded from the worklist's own `dropped` entries on every load — see
// seedCalDone(). It used to be written only by the click handlers, which meant
// a reload between the tick and the debounced rebuild lost the mark and the
// box came back empty. CALENDAR-SPEC 2.4.
const CAL_DONE = new Set();
// Which kinds are DRAWN. A selection, not switches: [] means every kind, and
// nextSelection() makes "none" unreachable. Stored as JSON because it is a set,
// not a value. A corrupt entry falls back to "everything" rather than to a
// blank calendar.
let CAL_KIND_SEL = (() => {
  try {
    const v = JSON.parse(localStorage.getItem('calKinds') ?? '[]');
    return Array.isArray(v) ? v.filter(k => typeof k === 'string') : [];
  } catch { return []; }
})();
// AI-mined syllabus items are visible by default, but can be hidden without
// suppressing Canvas-backed work or items the student added themselves. This
// is a display preference only; no pipeline output is deleted or rebuilt.
let CAL_SHOW_AI_ADDED = localStorage.getItem('calShowAiAdded') !== '0';
// Which classes are DRAWN — the same selection shape as CAL_KIND_SEL, run
// through the same nextSelection()/isSelected() pair: [] means every class,
// and no sequence of clicks reaches "none". This replaced an inverted hidden
// set ("all selected by default, if one or more is selected it should only
// show selected ones", 2026-08-26); the old calHidden key is retired rather
// than migrated, because "everything showing" IS the new default.
let CAL_CLASS_SEL = (() => {
  try { localStorage.removeItem('calHidden'); } catch { /* private mode */ }
  try {
    const v = JSON.parse(localStorage.getItem('calClassSel') ?? '[]');
    return Array.isArray(v) ? v.filter(s => typeof s === 'string') : [];
  } catch { return []; }
})();

// Which of the three interfaces is showing: the stacked list, the seven-column
// week, or the tiled month. CALENDAR-SPEC 1.1-1.2.
// The prompt the Copy button puts on the clipboard. Set once the calendar
// loads and the real data-root path is known.

// Ordered by span: the shortest answer first. '2 days' is deliberately not
// steerable — see twoDayDays().
const CAL_VIEWS = ['list', 'twoday', 'week', 'month'];

/**
 * The two days the 2-day view shows: today and tomorrow, always.
 *
 * LITERALLY tomorrow, even when tomorrow is empty. A view that skipped an empty
 * day to show the next one with work on it could not answer "is tomorrow
 * clear?" — the question it exists for — because an empty day and a hidden day
 * would look identical.
 *
 * Derived from today rather than from CAL_ANCHOR, which is why the view has no
 * prev/next: a 2-day window you can steer anywhere is Week with five columns
 * missing. It also means the view can never be parked on a stale pair.
 */
function twoDayDays() {
  const today = localTodayIso();
  return [today, addDays(today, 1)];
}
let CAL_VIEW = CAL_VIEWS.includes(localStorage.getItem('calView'))
  ? localStorage.getItem('calView') : 'list';
// The day whose week or month the grid is showing. Not persisted: coming back
// to the calendar tomorrow should land on tomorrow, not on wherever the last
// session was browsing. Set on first render by initialAnchor().
let CAL_ANCHOR = null;
// Finished work is dropped from the worklist by design, so the row that would
// let you un-finish it disappears with it. This brings those rows back, struck
// through and still tickable. CALENDAR-SPEC 2.5.
let CAL_SHOW_DONE = localStorage.getItem('calShowDone') === '1';
let CAL_SHOW_PAST = localStorage.getItem('calShowPast') === '1';
// Whether Week view is drawn against a clock: hour lines across the seven
// columns, every timed item placed and sized by its own hours. Week only —
// a month tile is too small to hold a scale, and the list is not a grid.
// CALENDAR-SPEC 9.1.
let CAL_TIMES = localStorage.getItem('calTimes') === '1';

// Local midnight — never `new Date('2026-09-01')`, which parses as UTC and lands
// on the previous day for anyone west of Greenwich.
function calDate(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, d);
}

function fmtDayLabel(dateStr) {
  const day = calDate(dateStr);
  return `${day.toLocaleDateString('en-US', { weekday: 'short' })} ${day.getMonth() + 1}/${day.getDate()}`;
}

// The day header's relative label. The phrase always prints; the urgency
// tier only applies when the day actually holds unfinished work — a header
// over nothing but lectures must not shout, and a solid run of amber
// headings across a quiet week is exactly the hundred-alarms failure the
// ladder exists to avoid. The past is history either way (the same reason a
// past lecture's row gets no overdue red).
function calDayRelHtml(dateStr, dayOps = []) {
  const diff = daysUntil(dateStr);
  const phrase = relPhrase(diff);
  // "Today", "Tomorrow", "Yesterday" — the one-word forms head a section, the
  // "in N days" forms annotate one, and headers capitalise.
  const cap = phrase.includes(' ') ? phrase : phrase[0].toUpperCase() + phrase.slice(1);
  const hasWork = dayOps.some(o => o.calendar !== 'meeting' && !calItemModel(o).done);
  const tier = diff >= 0 && hasWork ? dueTier(diff) : '';
  return `<span class="cal-day-rel${tier ? ` ${tier}` : ''}">${esc(cap)}</span>`;
}

// The worklist stores a slug (folder minus its numeric prefix); the bridge's
// per-class routes want the folder. Resolve through the synced list so an old
// class that is no longer synced simply yields nothing, rather than a 404.
//
// The join is on `slug`, which /api/classes now ships beside `folder`. It used
// to re-derive the strip here with its own /^\d+-/ — the third copy of that
// rule in the codebase, and the kind of duplication that drifts. CALENDAR-SPEC
// 2.11. The folder comparison stays as a fallback for a worklist written
// before the slug existed.
function calFolder(slug) {
  if (!slug) return null;
  const hit = (CLASSES || []).find(c => c.slug === slug || c.folder === slug);
  return hit ? hit.folder : null;
}

// A class's colour.
//
// The bridge owns this now — both the ten generic defaults and the user's
// overrides — so the sidebar, the calendar and the colour editor cannot
// disagree about what colour a class is. The old hash-of-the-slug scheme is
// gone: it collided (two of five real classes came out the same green) and it
// gave the user nothing to change.
//
// Fetched once and cached; refetched after a save.
let CLASS_COLORS = {};      // slug -> "#rrggbb", resolved (override, else default)
let CLASS_OVERRIDES = {};   // slug -> "#rrggbb", only what the user changed
let CLASS_PALETTE = [];     // the generic defaults, in order

// A neutral stand-in for the moment before /api/class-colors answers, and for
// a slug the bridge has never heard of (an old class still in the worklist).
const NO_CLASS_COLOR = 'var(--rule-2)';

// The value the open native picker is showing but has not committed. Held here
// rather than written into CLASS_COLORS, so an abandoned picker leaves nothing
// behind — dragging used to poke a colour into the cache that no override on
// the server matched, and the next re-render painted it everywhere.
let COLOR_DRAFT = null;     // { slug, hex } | null

function classColor(slug) {
  const s = String(slug || '');
  if (COLOR_DRAFT && COLOR_DRAFT.slug === s) return COLOR_DRAFT.hex;
  // "Personal" is not a class the bridge knows about — it is where an item
  // with no class goes — so it carries its own quiet ink rather than the
  // grey that means "we could not resolve this".
  if (s === PERSONAL_SLUG) return CLASS_COLORS[s] ?? PERSONAL_COLOR;
  return CLASS_COLORS[s] ?? NO_CLASS_COLOR;
}

// The first load is a promise, not a fire-and-forget: the calendar has to be
// able to wait for it. Without this a cold open that reached the Calendar in
// the window between "CLASSES arrived" and "colours arrived" drew every class
// grey and never repainted, because nothing was watching.
let COLORS_READY = null;

function loadClassColors({ force = false } = {}) {
  if (COLORS_READY && !force) return COLORS_READY;
  COLORS_READY = apiJson('/api/class-colors')
    .then(applyColorPayload)
    .catch((err) => {
      // One retry — a single failed request should not leave the whole app
      // colourless for the rest of the session.
      COLORS_READY = null;
      return apiJson('/api/class-colors').then(applyColorPayload).catch((err2) => {
        toast(`Could not load class colours: ${err2.message || err.message}`);
        COLORS_LOADED = false;
        throw err2;
      });
    });
  return COLORS_READY;
}

// False until the bridge has actually answered once. The editor needs to know:
// with no palette in hand it must say "unknown", not invent a default.
let COLORS_LOADED = false;

function applyColorPayload(data) {
  CLASS_COLORS = data?.colors ?? {};
  CLASS_OVERRIDES = data?.overrides ?? {};
  if (Array.isArray(data?.palette) && data.palette.length) CLASS_PALETTE = data.palette;
  COLORS_LOADED = true;
}

// Which of black or cream to set on top of an arbitrary user-chosen colour.
// The ten defaults all clear 4.5:1 against cream, but the native picker will
// happily hand back #FFFF00, so the foreground is computed rather than assumed.
function readableOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 'var(--ink)';
  const n = parseInt(m[1], 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // Contrast against near-white vs near-black, and take the better one.
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.09) ? 'var(--on-accent)' : 'var(--ink)';
}

function calDisplayName(slug) {
  if (slug === PERSONAL_SLUG) return 'Personal';
  const hit = (CLASSES || []).find(c => c.folder === slug || c.slug === slug);
  if (hit && hit.code) return hit.code;
  return String(slug ?? '').replace(/-/g, ' ').toUpperCase();
}

// Titles arrive prefixed with the class ("BUSI 380 · Read Ch 4", legacy
// "BUSI 380 002: Read ch. 4"). Inside a group already headed by that class the
// prefix is pure noise.
function stripClassPrefix(title, slug) {
  for (const sep of [' · ', ': ']) {
    const i = title.indexOf(sep);
    if (i <= 0) continue;
    const head = title.slice(0, i).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (head && slug.startsWith(head)) return title.slice(i + sep.length);
  }
  return title;
}

function calPoints(description) {
  // A NUMBER, not a run of [\d.]: that class accepted "..." from a truncated
  // description and printed "... pts" on the chip, and let "1.2.3" through as
  // though a score could have two decimal points.
  const m = /^Points:\s*(\d+(?:\.\d+)?)/m.exec(description || '');
  return m ? m[1] : null;
}

function calUrl(description) {
  const m = /(https?:\/\/[^\s<>]+)/.exec(description || '');
  if (!m) return null;
  // Sentence punctuation is not part of the link. content-format.js strips the
  // same set when it autolinks prose, and the two disagreeing meant one URL was
  // live in the file reader and a 404 on the calendar chip beside it.
  let url = m[1].replace(/[.,;:!?]+$/, '');
  // A closing paren is the sentence's, not the link's, unless the link opened
  // one itself: "(see https://x/y)" sheds it, ".../Foo_(bar)" keeps it.
  while (url.endsWith(')')
    && (url.split('(').length - 1) < (url.split(')').length - 1)) {
    url = url.slice(0, -1).replace(/[.,;:!?]+$/, '');
  }
  return url || null;
}

/**
 * What controls an op earns, decided once so the list, the week and the month
 * cannot disagree about it. CALENDAR-SPEC 2.1, 2.6-2.10.
 *
 * The rules, each one a real property of this user's 240 ops:
 *
 *   A meeting is not a task. It has no Canvas page and nothing to submit, so it
 *   gets neither a checkbox nor a link — a dead control is worse than no
 *   control, because it reads as broken rather than as absent.
 *
 *   A checkpoint IS the user's own work and should be tickable, but 32 of 32
 *   checkpoint ops carry no `item_id` today: they are derived from the marker
 *   of the item they prepare for. So the gate is "has an id", not "is a
 *   deadline" — the moment the worklist starts carrying one, checkpoints become
 *   checkable with no change here.
 *
 *   Deadline ops with neither a `url` nor a `submit_url` are mined items with
 *   no Canvas row behind them. They say so.
 */
function calItemModel(op) {
  const isMeeting = op.calendar === 'meeting';
  const isCheckpoint = op.calendar === 'checkpoint';
  // An item the user typed in. It has no class folder and no mined id — its
  // identity is its own uuid, and every control on it goes to a different
  // endpoint from every other row's.
  const isCustom = op.calendar === 'custom';
  const customId = op.custom_id ?? null;
  const folder = calFolder(op.class);
  const id = op.item_id ?? null;
  // A prep block belongs to an item but is not the item. Ticking one has to
  // name the block, so a checkpoint with no id of its own is NOT checkable —
  // the alternative is a checkbox that quietly marks the whole assignment done.
  const cpId = op.checkpoint_id ?? null;
  const checkable = isCustom
    ? !!customId
    : (!isMeeting && !!folder && id != null && (!isCheckpoint || !!cpId));
  // Anything ticked off can be clicked into: a deadline opens its own page,
  // and a prep block opens the assignment it preps for — same id, same panel.
  // CALENDAR-SPEC 2.12. A meeting has no page of its own on Canvas, but it
  // does now have somewhere to keep a note about it, which is a real
  // destination rather than the dead control 2.10 forbids.
  const noteKey = isCustom ? null : (op.note_key ?? (isMeeting ? null : id));
  const notable = isCustom || (!!folder && !!noteKey);
  const openable = checkable || (isMeeting && notable);
  const url = op.url || calUrl(op.description);
  const submitUrl = op.submit_url || null;
  const noLink = op.calendar === 'due' && !url && !submitUrl;
  // AI-added: mined out of the syllabus with no Canvas row behind it, so there
  // is nothing to submit. `origin` is authoritative once the worklist carries
  // it; a worklist built before the field falls back to "no link anywhere",
  // which is true of exactly the same rows. CALENDAR-SPEC 2.13.
  const aiAdded = op.calendar === 'due' && (op.origin ? op.origin === 'syllabus' : noLink);
  const key = isCustom ? `custom|${customId}` : calDoneKey(folder, id, cpId);
  const done = isCustom
    ? Boolean(op._custom?.done ?? op._completed)
    : (checkable && CAL_DONE.has(key));

  // What a pointer may do to this row. Three separate questions, because the
  // answers genuinely differ:
  //
  //   An item the user added is theirs entirely — move it, stretch it, retitle
  //   it, delete it.
  //   A deadline can be MOVED (that writes the same dueOverride the task
  //   editor's "Move to" writes) but not stretched: a deadline is a moment.
  //   A prep block the user wrote can be moved. An AUTOMATIC one cannot — it
  //   is defined as an offset from its deadline, so it follows the deadline by
  //   design, and letting it be dragged would strand it (CALENDAR-SPEC 2.9).
  //   A lecture and an office-hours block come from the syllabus. Dragging one
  //   would assert a schedule change nothing downstream believes.
  const autoCheckpoint = isCheckpoint && String(cpId ?? '').startsWith('auto:');
  const movable = isCustom
    ? !!customId
    : (op.calendar === 'due' ? checkable : (isCheckpoint && checkable && !autoCheckpoint));
  const resizable = isCustom && !!customId;
  // Why a drag was refused, in words the row can say when the user tries.
  // Office hours are written to the MEETING calendar, so `isMeeting` is true
  // of them too — ask the kind first or every office-hours block is told to
  // go and edit its class times, which is not where its hours come from.
  const immovableWhy = movable ? null
    : op.kind === 'office_hours' ? 'Office hours come from the syllabus, not from the calendar.'
    : isMeeting ? 'Class meetings come from the syllabus — change them under Class times.'
    : autoCheckpoint ? 'A prep block follows its deadline — move the deadline and it moves with it.'
    : 'This item has no date of its own to move.';

  return {
    isMeeting, isCheckpoint, isCustom, customId, folder, id, cpId, key,
    checkable, openable, notable, noteKey, note: op.note ?? null,
    movable, resizable, immovableWhy,
    url, submitUrl, noLink, aiAdded, done,
  };
}

/**
 * One identity for one tickable thing. The prep blocks of an item share its
 * item_id, so without the checkpoint id in the key, ticking one struck through
 * all of them and the deadline as well.
 */
function calDoneKey(folder, id, cpId) {
  return `${folder}|${id}${cpId ? `|${cpId}` : ''}`;
}

/** The checkbox, or a spacer that keeps the column aligned. */
function calCheckHtml(op, m, title) {
  if (!m.checkable) return '<span class="cal-check-gap"></span>';
  // An item the user added ticks itself off through its own endpoint, so it
  // carries its own id rather than a class folder and a task id.
  if (m.isCustom) {
    return `<input type="checkbox" class="cal-check" data-cal-custom-done="${esc(m.customId)}"`
      + `${m.done ? ' checked' : ''} aria-label="Mark ${esc(title)} done" />`;
  }
  return `<input type="checkbox" class="cal-check" data-cal-done="${esc(m.id)}"`
    + ` data-cal-class="${esc(m.folder)}"${m.cpId ? ` data-cal-cp="${esc(m.cpId)}"` : ''}`
    + `${m.done ? ' checked' : ''}`
    + ` aria-label="Mark ${esc(title)} done" />`;
}

/** The title: an in-app button, a Canvas link, or plain text. Never a dead link. */
function calTitleHtml(op, m, title) {
  // The user's own item opens its editor — the page it clicks in to.
  if (m.isCustom) {
    return `<button type="button" class="linky-title" data-open-custom="${esc(m.customId)}">${esc(title)}</button>`;
  }
  // A lecture opens its own small page: what it is, and the notes field.
  if (m.isMeeting && m.notable) {
    return `<button type="button" class="linky-title" data-open-op="${esc(m.noteKey)}"`
      + ` data-op-class="${esc(m.folder)}">${esc(title)}</button>`;
  }
  if (m.openable) {
    return `<button type="button" class="linky-title" data-open-assignment="${esc(m.id)}"`
      + ` data-assignment-class="${esc(m.folder)}">${esc(title)}</button>`;
  }
  if (!m.isMeeting && m.url) {
    return `<a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>`;
  }
  return esc(title);
}

/**
 * The attributes that make a row or chip draggable, and the handles that make
 * it resizable.
 *
 * `data-cal-drag` is what the pointer handler looks for; it carries everything
 * the handler needs to write the move without going back to the op list. The
 * handles only appear on the ends of a span — the middle day of a three-day
 * item has no edge of its own — and only in the two grid views, where a day is
 * a place on screen rather than a heading in a list.
 */
function calDragAttrs(op, m, iso = null) {
  // A chip that cannot move carries the reason instead, so a user who tries
  // gets an explanation rather than the silence of a thing that does nothing.
  if (!m.movable) return m.immovableWhy ? ` data-immovable="${esc(m.immovableWhy)}"` : '';
  const bits = [
    ' data-cal-drag="1"',
    ` data-drag-date="${esc(op.date)}"`,
    op.end_date ? ` data-drag-end="${esc(op.end_date)}"` : '',
    m.isCustom ? ` data-drag-custom="${esc(m.customId)}"` : '',
    !m.isCustom && m.folder ? ` data-drag-folder="${esc(m.folder)}"` : '',
    !m.isCustom && m.id != null ? ` data-drag-item="${esc(m.id)}"` : '',
    !m.isCustom && m.cpId ? ` data-drag-cp="${esc(m.cpId)}"` : '',
    m.resizable ? ' data-cal-resizable="1"' : '',
    iso ? ` data-drag-day="${esc(iso)}"` : '',
  ];
  return bits.join('');
}

/** The two grab edges of a resizable item, on the days that own them. */
function calHandlesHtml(op, m, iso) {
  if (!m.resizable || !iso) return '';
  const pos = spanPosition(op, iso);
  const out = [];
  if (pos === 'start' || pos === 'only') {
    out.push('<span class="cal-grip start" data-cal-grip="start" aria-hidden="true"></span>');
  }
  if (pos === 'end' || pos === 'only') {
    out.push('<span class="cal-grip end" data-cal-grip="end" aria-hidden="true"></span>');
  }
  return out.join('');
}

/** Submit, or the reason there is nothing to submit to. */
function calSubmitHtml(m, { dense = false } = {}) {
  if (m.submitUrl) {
    return `<a class="cal-submit${dense ? ' dense' : ''}" href="${esc(m.submitUrl)}"`
      + ` target="_blank" rel="noopener noreferrer" title="Submit on Canvas"`
      + `>${dense ? '<span aria-hidden="true">&#8599;</span><span class="sr-only">Submit on Canvas</span>' : 'Submit'}</a>`;
  }
  // An AI-added deadline is real work but not a Canvas assignment — the pill
  // says so, so the user never hunts for a submit box that does not exist.
  // CALENDAR-SPEC 2.13.
  // A WORD, never a bare dash. The dense form used to be `&mdash;`, and on a
  // chip — where `.cal-chip .cal-nolink` strips the pill border that makes it
  // read as a marker in the list — that left an unstyled em dash butted against
  // a two-line-clamped title. It was indistinguishable from a truncation
  // artifact, and it collided with the en dash that means a time RANGE
  // ("2:30–3:45 PM"), so one glyph meant three things. 73 of 143 due ops in the
  // live worklist carry one of these two markers, so it was on half the chips
  // on screen. CALENDAR-SPEC 2.8 and 2.13 require the marker to be PRESENT in
  // all three views; they do not require it to be punctuation.
//
// Both dense forms stay SHORT and space-free on purpose: the marker sits in
// an `auto` grid track next to the two-line-clamped title, so every character
// is taken off the title's lane and an internal space gives it somewhere to
// wrap. 'AI' and 'none', not 'AI-added' and 'no link'.
  if (m.aiAdded) {
    return `<span class="cal-nolink ai" title="Added by AI from the syllabus — not a Canvas assignment, nothing to submit on Canvas">${dense ? 'AI' : 'AI-added'}</span>`;
  }
  if (m.noLink) {
    return `<span class="cal-nolink" title="Canvas has no page for it">${dense ? 'none' : 'no link'}</span>`;
  }
  return '';
}

const RRULE_DAYS = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

/**
 * "weekly Mon, Wed" — that an op REPEATS, which is otherwise invisible.
 *
 * Office hours and the weekly-pattern meeting fallback are emitted as ONE op
 * carrying `recurrence`, anchored on its first occurrence
 * (sync-calendar.js:683-690). The tag that said so was dropped by the dashboard
 * adoption commit with no replacement, and grep for `recurrence` across
 * bridge/public/ returned nothing afterwards: a standing weekly commitment for
 * the whole term rendered as a single event on one date, while classes.ics —
 * built from the same op — emitted an RRULE and showed it every week. The
 * dashboard and the calendar it advertises disagreed about the same op.
 */
function calRecurrenceLabel(op) {
  const r = op?.recurrence;
  if (!r || r.freq !== 'WEEKLY' || !Array.isArray(r.byday) || !r.byday.length) return '';
  const days = r.byday.map(d => RRULE_DAYS[String(d).toUpperCase()] ?? d).join(', ');
  return `weekly ${days}`;
}

/**
 * The last day an op still happens — a recurrence's `until`, not its anchor.
 *
 * Past-ness for a repeat is about when the SERIES ends. Measured against the
 * first occurrence, every office-hours block folded behind "Show past
 * schedule" the week after term began, while it ran until December.
 */
function calLastDate(op) {
  const until = op?.recurrence?.until;
  return (typeof until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(until)) ? until : op?.date;
}

function calOpRow(op, { showClass = false } = {}) {
  const m = calItemModel(op);
  // A past lecture is history, not a missed deadline — no overdue red.
  const overdue = calOverdue(op, m);
  const when = calWhenLabel(op);
  const title = showClass ? op.title : stripClassPrefix(op.title, op.class || '');
  const pts = calPoints(op.description);
  const recurs = calRecurrenceLabel(op);
  const kindLabel = calKindLabel(op.kind);
  const subcategory = !m.isMeeting && !m.isCustom && op.category && op.category !== 'other'
    && String(op.category).toLocaleLowerCase() !== String(op.kind).toLocaleLowerCase()
    ? op.category : '';
  return `
    <div class="cal-row${overdue ? ' overdue' : ''}${m.isMeeting ? ' meeting' : ''}${m.done ? ' is-done' : ''}${m.aiAdded ? ' ai-added' : ''}${m.isCustom ? ' custom' : ''}"
         data-class-slug="${esc(op.class || '')}"
         data-kind="${esc(op.kind || 'other')}"
         style="--class-color:${classColor(op.class)}">
      ${calCheckHtml(op, m, title)}
      <span class="cal-when">${esc(when)}</span>
      <span class="cal-title">${calTitleHtml(op, m, title)}</span>
      <span class="cal-tags">
        <span class="cal-kind category-label">${esc(kindLabel)}</span>
        ${op.location ? `<span class="cal-loc">${esc(op.location)}</span>` : ''}
        ${recurs ? `<span class="cal-loc" title="Repeats every week until ${esc(calLastDate(op))}">${esc(recurs)}</span>` : ''}
        ${subcategory ? `<span class="cal-cat ${esc(subcategory)}">${esc(subcategory)}</span>` : ''}
        ${pts ? `<span class="cal-pts">${esc(pts)} pts</span>` : ''}
        ${m.note && !m.isCustom ? '<span class="cal-kind note" title="You wrote a note on this">note</span>' : ''}
        ${calSubmitHtml(m)}
      </span>
    </div>`;
}

/**
 * Is this late? Measured from the LAST day it covers, not the first.
 *
 * A three-day trip that started yesterday is in progress, not missed, and
 * marking it overdue paints an alarm on every item the user is in the middle
 * of. Same reasoning as "a past lecture is history, not a missed deadline".
 */
function calOverdue(op, m) {
  if (m.isMeeting || m.done) return false;
  const dates = spanDates(op);
  const last = dates.length ? dates[dates.length - 1] : op.date;
  return daysUntil(last) < 0;
}

/**
 * "9:00 AM–5:00 PM", "All day", "Thu–Sat" — what a row says about when it
 * happens. A span has to say so here, because the list has no column for the
 * days it covers and "All day" over three days is a third of the truth.
 */
function calWhenLabel(op) {
  const dates = spanDates(op);
  const multi = dates.length > 1;
  if (!multi) return op.all_day ? 'All day' : op.time ? fmtTimeSpan(op.time, op.end_time) : '—';
  const ends = `${fmtDayLabel(dates[0])} – ${fmtDayLabel(dates[dates.length - 1])}`;
  return op.time ? `${fmtTimeChip(op.time)} ${ends}` : ends;
}

/**
 * The compact form, for a column in Week view or a tile in Month view. Same
 * controls as a list row — the spec is explicit that task control holds in all
 * three interfaces — just short of the tags, which do not survive a 170px
 * column and are one click away in the list.
 */
function calChip(op, iso = null, { style = '', timed = false, placedClass = '' } = {}) {
  const m = calItemModel(op);
  const overdue = calOverdue(op, m);
  const title = stripClassPrefix(op.title, op.class || '');
  const when = op.all_day || !op.time ? '' : fmtTimeChip(op.time);
  // Which day of a span this chip is. A run of days reads as one bar rather
  // than three separate items: only the first says the title and the time,
  // and only the two ends carry a grab handle.
  const pos = iso ? spanPosition(op, iso) : 'only';
  const spanCls = pos === 'only' ? '' : ` span span-${pos}`;
  const lead = pos === 'only' || pos === 'start';
  return `
    <div class="cal-chip${overdue ? ' overdue' : ''}${m.isMeeting ? ' meeting' : ''}${m.done ? ' is-done' : ''}${m.aiAdded ? ' ai-added' : ''}${m.isCustom ? ' custom' : ''}${spanCls}${timed ? ' placed' : ''}${placedClass ? ` ${placedClass}` : ''}"
         data-class-slug="${esc(op.class || '')}"
         data-kind="${esc(op.kind || 'other')}"
         style="--class-color:${classColor(op.class)}${style ? `;${style}` : ''}"
         title="${esc(calDisplayName(op.class))} — ${esc(op.title)}"${calDragAttrs(op, m, iso)}>
      ${lead ? calCheckHtml(op, m, title) : ''}
      ${lead ? `<span class="chip-kind" title="${esc(calKindLabel(op.kind))}">${esc(calKindShort(op.kind))}</span>` : ''}
      ${lead && when ? `<span class="chip-when">${esc(when)}</span>` : ''}
      <span class="chip-title">${lead ? calTitleHtml(op, m, title) : '<span class="chip-cont" aria-hidden="true">&nbsp;</span>'}</span>
      ${lead ? calSubmitHtml(m, { dense: true }) : ''}
      ${calHandlesHtml(op, m, iso)}
    </div>`;
}

/**
 * Three or more items in one exact clock slot cannot remain readable lanes.
 * Keep their shared position on the clock, then open them as ordinary full-
 * width chips so every checkbox, title, Submit link, and drag target survives.
 */
function calCollisionStack(group, iso, { style = '' } = {}) {
  const ops = group.map(item => item.op);
  const count = ops.length;
  const allDue = ops.every(op => op.calendar === 'due');
  const sharedTime = ops.every(op => op.time === ops[0].time) && ops[0].time
    ? fmtTimeChip(ops[0].time)
    : '';
  const sharedKind = ops.every(op => op.kind === ops[0].kind) ? ops[0].kind : 'mixed';
  const label = `${count} ${allDue ? 'due' : 'items'}${sharedTime ? ` · ${sharedTime}` : ''}`;
  return `
    <div class="cal-collision" data-kind="${esc(sharedKind || 'other')}" style="${style}" title="${esc(label)}">
      <button type="button" class="cal-collision-summary" data-cal-collision-open
              aria-expanded="false">
        <span class="cal-collision-count">${count}</span>
        <span class="cal-collision-label">${esc(allDue ? 'due' : 'items')}${sharedTime ? ` · ${esc(sharedTime)}` : ''}</span>
        <span class="cal-collision-caret" aria-hidden="true">&#9662;</span>
      </button>
      <div class="cal-collision-list" popover aria-label="${esc(label)}">
        ${ops.map(op => calChip(op, iso)).join('')}
      </div>
    </div>`;
}

// Stable grouping that preserves the worklist's existing order within a bucket.
function groupBy(items, keyFn) {
  const out = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(it);
  }
  return out;
}

function renderCalendarByDay(ops) {
  const byDate = groupBy(ops, o => o.date);
  const dates = [...byDate.keys()].sort();
  let html = '';
  let lastMonth = '';
  for (const date of dates) {
    const month = calDate(date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    if (month !== lastMonth) {
      html += `<h3 class="cal-month">${esc(month)}</h3>`;
      lastMonth = month;
    }
    const dayOps = byDate.get(date);
    const past = daysUntil(date) < 0;
    html += `
      <section class="cal-day${past ? ' past' : ''}">
        <header class="cal-day-head">
          <span class="cal-day-name">${esc(fmtDayLabel(date))}</span>
          ${calDayRelHtml(date, dayOps)}
          <span class="cal-day-count">${dayOps.length}</span>
        </header>`;
    for (const [slug, classOps] of groupBy(dayOps, o => o.class || 'unknown')) {
      html += `
        <div class="cal-class-group">
          <div class="cal-class-label" data-class-slug="${esc(slug)}" style="--class-color:${classColor(slug)}">
            ${esc(calDisplayName(slug))}
          </div>
          <div class="cal-rows">${classOps.map(o => calOpRow(o)).join('')}</div>
        </div>`;
    }
    html += '</section>';
  }
  return html;
}

function renderCalendarByClass(ops) {
  const byClass = groupBy(ops, o => o.class || 'unknown');
  const slugs = [...byClass.keys()].sort((a, b) => calDisplayName(a).localeCompare(calDisplayName(b)));
  let html = '';
  for (const slug of slugs) {
    const classOps = byClass.get(slug);
    html += `
      <section class="cal-class">
        <header class="cal-class-head" data-class-slug="${esc(slug)}" style="--class-color:${classColor(slug)}">
          <span class="cal-class-name">${esc(calDisplayName(slug))}</span>
          <span class="cal-day-count">${classOps.length}</span>
        </header>`;
    const byDate = groupBy(classOps, o => o.date);
    for (const date of [...byDate.keys()].sort()) {
      html += `
        <div class="cal-class-day${daysUntil(date) < 0 ? ' past' : ''}">
          <div class="cal-class-date">${esc(fmtDayLabel(date))} ${calDayRelHtml(date, byDate.get(date))}</div>
          <div class="cal-rows">${byDate.get(date).map(o => calOpRow(o)).join('')}</div>
        </div>`;
    }
    html += '</section>';
  }
  return html;
}

// ---------------------------------------------------------------------------
// Week and Month — the two grid interfaces.
//
// CALENDAR-SPEC §1. The list answers "what is coming up"; it cannot answer
// "what does Tuesday look like" or "how heavy is October", because a stacked
// list has no shape. These two do, and they carry the same task controls the
// list does — a checkbox that is only in one of three views is not a feature,
// it is a place the user learns not to trust.
//
// All the date arithmetic lives in cal-grid.js and is tested there. Nothing in
// here constructs a Date.
// ---------------------------------------------------------------------------

// How many chips a month tile shows before it collapses the rest behind a
// "+N more". Four is the point where 31 tiles stop fitting on a laptop screen.
const MONTH_TILE_MAX = 3;

// Tiles the user has expanded. Cleared when the month changes — an expansion is
// about one day, not a preference.
let CAL_EXPANDED = new Set();

function renderCalendarWeek(ops) {
  if (CAL_TIMES) return renderCalendarWeekTimed(ops);
  const days = weekDays(CAL_ANCHOR);
  const buckets = bucketByDate(ops);
  const today = todayIso();
  const cols = days.map(iso => {
    const dayOps = sortDayOps(buckets.get(iso) || []);
    const past = iso < today;
    return `
      <section class="cal-daycol${iso === today ? ' today' : ''}${past ? ' past' : ''}" data-cal-day="${esc(iso)}">
        <header class="cal-daycol-head">
          <span class="daycol-name">${esc(dayHeadLabel(iso))}</span>
          ${dayOps.length ? `<span class="daycol-count">${dayOps.length}</span>` : ''}
        </header>
        <div class="cal-daycol-body">
          ${dayOps.map(o => calChip(o, iso)).join('')}
          <div class="cal-daycol-space" data-cal-newday="${esc(iso)}"
               title="Drag to add an item"></div>
        </div>
      </section>`;
  }).join('');
  // The grid scrolls inside its own box rather than pushing the page wide. A
  // week is seven columns by definition — collapsing it to one on a phone
  // would just be the list again — so on a narrow screen you swipe it.
  return `<div class="cal-gridwrap"><div class="cal-week" id="cal-week">${cols}</div></div>`;
}

// How tall one hour is drawn. The whole grid's geometry comes off this single
// number, in both the CSS and the maths below, so they cannot drift.
const HOUR_PX = 44;
// One banner chip is one fixed line, so a band of N of them is arithmetic.
// The CSS pins the chip to exactly this height; if one changes the other must.
const ALLDAY_ROW_PX = 20;
const ALLDAY_PAD_PX = 3;

// The pixel floor is DERIVED from the minutes cal-grid reserves, never a second
// copy of it: lane assignment and this height are the same fact, and I6 was the
// two disagreeing — 32px of screen is 44 minutes of clock, so a block grown to
// it was overlapping a neighbour lane assignment had judged clear.
const MIN_BLOCK_PX = (MIN_BLOCK_MIN / 60) * HOUR_PX;

// How much block height each title clamp actually needs. The title box starts
// 21.4px down (padding + the check/kind/time row + the row gap) and every line
// is 15px, so two lines want 51.4px and three want 66.4px. Measured, not
// chosen — and the tier that was MISSING is the middle one: `slot-roomy` began
// at 52px while allowing three lines, so every block in [52, 67) drew a third
// line it had no room for and the bottom of it was sliced off.
const SLOT_SNUG_PX = 52;    // 2 lines
const SLOT_ROOMY_PX = 67;   // 3 lines

/**
 * Week view against a clock.
 *
 * The stacked week answers "what is on Tuesday"; this answers "when on
 * Tuesday, and what collides with what". Hour lines run across all seven
 * columns and every timed item is positioned and sized by its own hours.
 *
 * The window is computed once for the WEEK, never per column — seven columns
 * on seven different scales would put 10am on seven different rows.
 *
 * Items that are not on the clock — all-day markers, a lecture whose hour the
 * syllabus never stated, a multi-day run — keep a banner band above the grid
 * rather than being given an invented time. That band is the honest place for
 * "this happens today, at an hour nobody knows".
 */
/**
 * The calendar grid's geometry, read from the stylesheet that will draw it.
 *
 * These are CSS's numbers — the day column's minimum, the hour gutter, and the
 * width one chip costs. Copying them into JS is how the lane budget drifted
 * from the layout in the first place, so they are read rather than restated.
 * A missing token falls back to the value style.css declares, so a stylesheet
 * that failed to load renders instead of dividing by NaN.
 */
function calGridGeometry() {
  const cs = getComputedStyle(document.documentElement);
  const px = (name, fallback) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    daycolMin: px('--daycol-min', 120),
    gutter: px('--gutter-w', 44),
    laneMin: px('--lane-min', 80),
  };
}

/**
 * How wide the grid gets to be: the panel it mounts into, not the window.
 * Measured before the write, because the element being measured is the one
 * about to be replaced and its width does not depend on its contents — the
 * wrap scrolls internally rather than growing.
 */
function calGridWidth() {
  return $('cal-ops')?.clientWidth ?? 0;
}

// The lane budget the grid currently on screen was rendered with; null when no
// timed grid is up. Read by the resize check.
let CAL_LANE_BUDGET = null;

function renderCalendarWeekTimed(ops, days = weekDays(CAL_ANCHOR), gridWidth = calGridWidth()) {
  // Two days used to mean four lanes and a week two, both read off a 1200px
  // screen. At 375px a day column sits at its 120px floor whatever the day
  // count, so those same counts gave 60px lanes — chips overflowing their own
  // boxes by 9-10px with the clock already hidden. The count is now a ceiling
  // and the WIDTH decides, which is the only thing that can.
  const laneBudget = laneBudgetFor(days.length, gridWidth, {
    ...calGridGeometry(),
    cap: days.length <= 2 ? 4 : MAX_LANES,
  });
  // What the DOM on screen was actually built with, so a resize can ask
  // whether it is still right rather than guessing from its own history.
  CAL_LANE_BUDGET = laneBudget;
  const buckets = bucketByDate(ops);
  const today = todayIso();
  const win = timeWindow(ops);
  const height = ((win.to - win.from) / 60) * HOUR_PX;
  const y = (min) => ((Math.max(win.from, Math.min(win.to, min)) - win.from) / 60) * HOUR_PX;

  // Every column's banner band is the SAME height — the tallest one's. Left to
  // size themselves, a Monday with three all-day markers and a Thursday with
  // one start their clocks at different heights, and 10am lands on a different
  // row in every column: precisely the failure a shared window exists to
  // prevent, reintroduced one level down. Chips in the band are one fixed line
  // each, so the height is arithmetic rather than a measurement.
  const laid = days.map(iso => layoutDay(sortDayOps(buckets.get(iso) || [])));
  const bandRows = Math.max(0, ...laid.map(l => l.allDay.length));
  const bandPx = bandRows ? bandRows * ALLDAY_ROW_PX + 2 * ALLDAY_PAD_PX : 0;

  const marks = hourMarks(win);
  const gutter = `
    <div class="cal-gutter" aria-hidden="true">
      <div class="cal-gutter-head"></div>
      <div class="cal-allday" style="height:${bandPx}px"></div>
      <div class="cal-gutter-body" style="height:${height}px">
        ${marks.map(m => `<span class="cal-hourlabel" style="top:${y(m.min)}px">${esc(m.label)}</span>`).join('')}
      </div>
    </div>`;

  // One set of rules per column. Drawn behind the blocks, never over them.
  const rules = marks
    .map(m => `<div class="cal-hourline" style="top:${y(m.min)}px"></div>`).join('');

  const nowMark = (iso) => {
    if (iso !== today) return '';
    const now = new Date();
    const min = now.getHours() * 60 + now.getMinutes();
    if (min < win.from || min > win.to) return '';
    return `<div class="cal-nowline" style="top:${y(min)}px" aria-hidden="true"></div>`;
  };

  const cols = days.map((iso, i) => {
    const { allDay, timed } = laid[i];
    const past = iso < today;
    // The budget is computed once above, from the measured grid width rather
    // than from the day count. Collapsing a four-way pileup into a stack when
    // there is room for it side by side would hide work behind a control the
    // user has to open; giving it four lanes when there is not is how those
    // chips came to overflow their own boxes.
    const partitioned = partitionDenseSlots(timed, 3, { maxLanes: laneBudget });
    let ordinary = timed;
    let stacks = [];

    if (partitioned.groups.length) {
      // Replace every dense group with one representative, then recompute the
      // lanes. A long lecture that overlaps the pile still gets its own lane;
      // unrelated items return to full width instead of inheriting the six
      // lanes that existed before the pile was collapsed.
      const representatives = partitioned.groups.map((group, groupIndex) => ({
        ...group[0].op,
        _denseSlot: groupIndex,
      }));
      const relaid = layoutDay([
        ...partitioned.rest.map(item => item.op),
        ...representatives,
      ]).timed;
      ordinary = relaid.filter(item => item.op._denseSlot == null);
      stacks = relaid.filter(item => item.op._denseSlot != null).map((item) => ({
        ...item,
        group: partitioned.groups[item.op._denseSlot],
      }));
    }

    const blocks = ordinary.map(({ op, startMin, endMin, lane, lanes }) => {
      const top = y(startMin);
      // Never shorter than something a finger and an eye can find, even for a
      // deadline, which is a moment rather than a span.
      // A deadline is a point, but a 22px one-line strip cannot show its
      // checkbox, kind, time AND title. Give short slots enough room for the
      // two-row card treatment below; the true start still stays on its line.
      const h = Math.max(y(endMin) - top, MIN_BLOCK_PX);
      const w = 100 / lanes;
      const tier = h < SLOT_SNUG_PX ? 'slot-compact'
        : h < SLOT_ROOMY_PX ? 'slot-snug'
        : 'slot-roomy';
      return calChip(op, iso, {
        style: `top:${top}px;height:${h}px;left:${(lane * w).toFixed(3)}%;width:${w.toFixed(3)}%`,
        timed: true,
        // No narrow-lane class: whether a chip is too narrow for its own
        // time is a question about PIXELS, and the renderer does not know how
        // wide a column resolves to. style.css asks the chip directly with a
        // container query. What stays here is the lane BUDGET — how many lanes
        // to create at all — because that changes the DOM and CSS cannot.
        placedClass: tier,
      });
    }).join('');
    const collisionStacks = stacks.map(({ group, startMin, endMin, lane, lanes }) => {
      const top = y(startMin);
      const h = Math.max(y(endMin) - top, 22);
      const w = 100 / lanes;
      return calCollisionStack(group, iso, {
        style: `top:${top}px;height:${h}px;left:${(lane * w).toFixed(3)}%;width:${w.toFixed(3)}%`,
      });
    }).join('');
    return `
      <section class="cal-daycol${iso === today ? ' today' : ''}${past ? ' past' : ''}" data-cal-day="${esc(iso)}">
        <header class="cal-daycol-head">
          <span class="daycol-name">${esc(dayHeadLabel(iso))}</span>
          ${allDay.length + timed.length ? `<span class="daycol-count">${allDay.length + timed.length}</span>` : ''}
        </header>
        <div class="cal-allday" style="height:${bandPx}px">${allDay.map(o => calChip(o, iso)).join('')}</div>
        <div class="cal-slots" style="height:${height}px" data-cal-newday="${esc(iso)}"
             title="Drag to add an item">
          ${rules}${nowMark(iso)}${blocks}${collisionStacks}
        </div>
      </section>`;
  }).join('');

  // --daycols, not an inline grid-template: the track sizes and the gutter width
  // stay in one place (style.css) and JS supplies only how many days there are.
  return `<div class="cal-gridwrap"><div class="cal-week timed" id="cal-week"`
    + ` style="--daycols:${days.length}">${gutter}${cols}</div></div>`;
}

function renderCalendarMonth(ops) {
  const { days } = monthGrid(CAL_ANCHOR, todayIso());
  const buckets = bucketByDate(ops);
  const heads = WEEKDAY_HEADS.map(h => `<div class="cal-wdh">${esc(h)}</div>`).join('');
  const tiles = days.map(d => {
    const dayOps = sortDayOps(buckets.get(d.iso) || []);
    const open = CAL_EXPANDED.has(d.iso);
    const shown = open ? dayOps : dayOps.slice(0, MONTH_TILE_MAX);
    const hidden = dayOps.length - shown.length;
    return `
      <div class="cal-tile${d.adjacent ? ' adjacent' : ''}${d.today ? ' today' : ''}${open ? ' expanded' : ''}"
           data-cal-day="${esc(d.iso)}">
        <div class="tile-head">
          <span class="tile-day">${d.day}</span>
          ${dayOps.length ? `<span class="tile-count">${dayOps.length}</span>` : ''}
        </div>
        <div class="tile-body">
          ${shown.map(o => calChip(o, d.iso)).join('')}
          <div class="tile-space" data-cal-newday="${esc(d.iso)}" title="Drag to add an item"></div>
        </div>
        ${hidden > 0
          ? `<button type="button" class="tile-more" data-cal-expand="${esc(d.iso)}">+${hidden} more</button>`
          : open && dayOps.length > MONTH_TILE_MAX
            ? `<button type="button" class="tile-more" data-cal-expand="${esc(d.iso)}">show less</button>`
            : ''}
      </div>`;
  }).join('');
  return `<div class="cal-gridwrap"><div class="cal-monthgrid" id="cal-month">${heads}${tiles}</div></div>`;
}

// ---------------------------------------------------------------------------
// Direct manipulation: move an item, stretch it, or draw a new one.
//
// CALENDAR-SPEC §8. Three gestures share one pointer handler because they
// share one hard requirement: NONE of them may cost the user a click. The
// calendar's existing controls — the checkbox, the title that opens a page,
// the Submit link — sit inside the very things being dragged, and a naive
// mousedown handler that starts a drag immediately makes every one of them
// unreliable.
//
// So nothing happens until the pointer has moved DRAG_SLOP pixels. Under that,
// the gesture was a click: the handler never captures the pointer, never calls
// preventDefault, and the click reaches the button exactly as it did before
// any of this existed. Over it, the click that the browser fires at the end of
// the drag is swallowed once, so letting go over a title does not also open it.
//
// Dates are read off the DOM (`[data-cal-day]` under the pointer) rather than
// computed from geometry: the grids are CSS grid and flexbox, and any
// arithmetic here would be a second, drifting copy of the layout.
// ---------------------------------------------------------------------------

// How far the pointer must travel before a press becomes a drag. 4px is under
// the tremor of a deliberate click and well under any intended movement.
const DRAG_SLOP = 4;

// The gesture in flight, or null. One object for all three kinds so the
// pointermove/pointerup handlers have exactly one thing to reason about.
let CAL_DRAG = null;

/** The ISO date of the day cell under a point, or null. */
function dayUnder(x, y) {
  const el = document.elementFromPoint(x, y);
  return el?.closest?.('[data-cal-day]')?.dataset.calDay ?? null;
}

/** Paint the days a gesture is currently proposing. */
function paintDragTargets(dates) {
  const want = new Set(dates ?? []);
  document.querySelectorAll('#cal-ops [data-cal-day]').forEach((cell) => {
    cell.classList.toggle('drop-target', want.has(cell.dataset.calDay));
  });
}

function clearDragPaint() {
  paintDragTargets([]);
  document.querySelectorAll('#cal-ops .dragging, #cal-ops .resizing')
    .forEach(el => el.classList.remove('dragging', 'resizing'));
  $('cal-ops').classList.remove('dragging-any');
}

/**
 * Begin a gesture. Called on pointerdown; decides WHICH gesture this could be
 * but commits to none of them until the pointer actually moves.
 */
function calPointerDown(ev) {
  // Left button only, and never on a control that owns its own click.
  if (ev.button !== 0 || CAL_DRAG) return;
  if (ev.target.closest('input, a, .tile-more, [data-cal-expand]')) return;

  const grip = ev.target.closest('[data-cal-grip]');
  const chip = ev.target.closest('[data-cal-drag]');
  // A collision stack floats inside the clock's blank add-target. Its own
  // summary and scroll surface must not start drawing a new calendar item;
  // chips inside it still retain their normal drag targets.
  const blank = ev.target.closest('.cal-collision') ? null : ev.target.closest('[data-cal-newday]');

  if (grip && chip) {
    CAL_DRAG = {
      kind: 'resize', edge: grip.dataset.calGrip, el: chip, moved: false,
      x0: ev.clientX, y0: ev.clientY,
      from: chip.dataset.dragDate, to: chip.dataset.dragEnd || chip.dataset.dragDate,
      target: null,
    };
  } else if (chip) {
    CAL_DRAG = {
      kind: 'move', el: chip, moved: false,
      x0: ev.clientX, y0: ev.clientY,
      from: chip.dataset.dragDate, to: chip.dataset.dragEnd || chip.dataset.dragDate,
      // Which day of a span was grabbed, so a three-day item dragged by its
      // last day moves by the days the POINTER moved, not by where its start
      // happens to be.
      grabbed: chip.dataset.dragDay || chip.dataset.dragDate,
      target: null,
    };
  } else if (blank) {
    CAL_DRAG = {
      kind: 'select', el: null, moved: false,
      x0: ev.clientX, y0: ev.clientY,
      anchor: blank.dataset.calNewday, target: blank.dataset.calNewday,
    };
  } else {
    // A chip that cannot move. Nothing happens on a CLICK — the title still
    // opens its page — but if the user actually tries to drag it, say why
    // rather than letting it sit there feeling broken.
    const fixed = ev.target.closest('[data-immovable]');
    if (!fixed) return;
    CAL_DRAG = {
      kind: 'refused', el: null, moved: false,
      x0: ev.clientX, y0: ev.clientY, why: fixed.dataset.immovable,
    };
  }
  CAL_DRAG.pointerId = ev.pointerId;
}

function calPointerMove(ev) {
  const d = CAL_DRAG;
  if (!d || ev.pointerId !== d.pointerId) return;
  if (!d.moved) {
    if (Math.abs(ev.clientX - d.x0) < DRAG_SLOP && Math.abs(ev.clientY - d.y0) < DRAG_SLOP) return;
    // A drag on something fixed: explain it once, and end the gesture there.
    // The click still has to be eaten — the press began on a title, so
    // without this the item opens on top of the toast that just explained why
    // it would not move, hiding the explanation behind the answer to a
    // question the user did not ask.
    if (d.kind === 'refused') {
      CAL_DRAG = null;
      swallowNextClick({ afterPointerUp: true });
      toast(d.why);
      return;
    }
    // Past the slop: this is a drag. Take the pointer so the gesture survives
    // leaving the element, and mark the surface so the cursor and the chips
    // stop inviting clicks.
    d.moved = true;
    try { $('cal-ops').setPointerCapture(d.pointerId); } catch { /* not fatal */ }
    $('cal-ops').classList.add('dragging-any');
    if (d.el) d.el.classList.add(d.kind === 'resize' ? 'resizing' : 'dragging');
  }
  ev.preventDefault();

  const day = dayUnder(ev.clientX, ev.clientY);
  if (!day) return;
  d.target = day;

  if (d.kind === 'select') {
    const range = orderedRange(d.anchor, day);
    paintDragTargets(range ? spanDates({ date: range.from, end_date: range.to }) : []);
    return;
  }
  if (d.kind === 'move') {
    const delta = daysBetween(d.grabbed, day);
    const moved = movedDates({ date: d.from, end_date: d.to !== d.from ? d.to : null }, delta);
    paintDragTargets(moved ? spanDates(moved) : spanDates({ date: d.from, end_date: d.to }));
    return;
  }
  const op = { date: d.from, end_date: d.to !== d.from ? d.to : null };
  const next = resizedDates(op, d.edge, day);
  paintDragTargets(spanDates(next ?? op));
}

/**
 * Eat the click the browser synthesises at the end of a drag.
 *
 * A pointer that goes down on a title, moves, and comes up still fires a click
 * on that title — so without this, dropping an item where you started reading
 * it also opens its page. Armed for exactly one click, and disarmed on the
 * next tick so that a gesture which ends over nothing (an empty tile, off the
 * grid) does not leave a trap for the user's next real click.
 */
function swallowNextClick({ afterPointerUp = false } = {}) {
  const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', swallow, { capture: true, once: true });
  const off = () => window.removeEventListener('click', swallow, { capture: true });
  const disarm = () => setTimeout(off, 0);
  if (!afterPointerUp) { disarm(); return; }
  // Cancelling with Escape (or refusing a drag) happens with the button still
  // DOWN, so the click this is here to eat does not arrive until the user lets
  // go — which may be seconds away. Disarming on the next tick would drop the
  // trap before the click ever reached it.
  //
  // Every way the press can end has to disarm it, or a trap set here waits
  // forever and eats an innocent click much later: pointerup is the normal
  // end, pointercancel is the one the OS can force (a system gesture, the
  // window losing the pointer), and the timeout is the backstop for a press
  // that ends in neither.
  const end = () => { window.removeEventListener('pointercancel', end); disarm(); };
  window.addEventListener('pointerup', end, { once: true });
  window.addEventListener('pointercancel', end, { once: true });
  setTimeout(off, 10000);
}

async function calPointerUp(ev) {
  const d = CAL_DRAG;
  if (!d || ev.pointerId !== d.pointerId) return;
  CAL_DRAG = null;
  try { $('cal-ops').releasePointerCapture(d.pointerId); } catch { /* already gone */ }

  // Never moved: this was a click. Leave it entirely alone — the checkbox, the
  // title button and the Submit link all depend on that.
  if (!d.moved) { clearDragPaint(); return; }

  swallowNextClick();
  clearDragPaint();
  const day = d.target;
  if (!day) return;

  if (d.kind === 'select') {
    const range = orderedRange(d.anchor, day);
    if (range) openItemDialog({ mode: 'create', date: range.from, endDate: range.from === range.to ? null : range.to });
    return;
  }

  const op = { date: d.from, end_date: d.to !== d.from ? d.to : null };
  const next = d.kind === 'move'
    ? movedDates(op, daysBetween(d.grabbed, day))
    : resizedDates(op, d.edge, day);
  if (!next) return;   // no movement, or a gesture with no meaning
  await applyDragResult(d, next);
}

/**
 * Write the result of a drag, and paint it immediately.
 *
 * Three different stores are reachable from one gesture, because three
 * different kinds of thing are draggable — and each one already had exactly
 * one right way to be moved before any of this existed. Nothing new is
 * invented here; the drag is a second way to reach the same field.
 */
async function applyDragResult(d, next) {
  const el = d.el;
  const customId = el?.dataset.dragCustom || null;
  const folder = el?.dataset.dragFolder || null;
  const itemId = el?.dataset.dragItem ?? null;
  const cpId = el?.dataset.dragCp || null;

  if (customId) {
    // Through the same per-item queue the tick uses. Two quick drags of one
    // item are two PATCHes of one record, and if they land out of order the
    // file ends up at the earlier date while the screen shows the later one.
    await queueCustomWrite(customId, { date: next.date, end_date: next.end_date })
      .catch(err => toast(`Could not move that: ${err.message}`));
    return;
  }
  if (!folder || itemId == null) return;

  if (cpId) {
    // A prep block the user wrote. Its date lives in the checkpoint LIST on the
    // parent task, and patchTask replaces that list wholesale, so this has to
    // send every sibling back too.
    //
    // Which means the list must be read FRESH, immediately before the write.
    // Reading it from CURRENT — the snapshot taken when the class was last
    // opened — meant that ticking a prep block off in the calendar (which
    // never touches CURRENT) and then dragging any of its siblings echoed the
    // stale `done: false` back over the tick and silently un-finished it.
    // A refetch costs one request on a gesture that already writes one.
    await postTask(folder, itemId, async () => {
      const cps = await loadCheckpointsFor(folder, itemId);
      if (!cps) throw new Error('this prep block is not in the saved list');
      return { checkpoints: cps.map(c => (c.id === cpId ? { ...c, date: next.date } : c)) };
    })
      .then(() => refreshCalendarSoon())
      .catch(err => toast(`Could not move that: ${err.message}`));
    return;
  }

  // A deadline. Dragging it writes the SAME dueOverride the task editor's
  // "Move to" field writes, so the two can never disagree and the "moved"
  // badge appears on both.
  await postTask(folder, itemId, { dueOverride: next.date })
    .then(() => refreshCalendarSoon())
    .catch(err => toast(`Could not move that: ${err.message}`));
}

/**
 * One key per task, for every write anywhere in the app.
 *
 * Every field of one task — done, note, dueOverride, the checkpoint list —
 * lives in ONE JSON object that the server rewrites wholesale, so two writes
 * to the same task must never overlap regardless of which control started
 * them. The checkpoint id is deliberately NOT in this key: ticking a prep
 * block and dragging its sibling write the same object and must queue behind
 * each other.
 */
function taskWriteKey(folder, id) {
  return `task|${folder}|${id}`;
}

/**
 * One task PATCH, serialized per task.
 *
 * `patch` may be a function, evaluated when this write's turn comes up rather
 * than when it was queued. A read-modify-write (the checkpoint list) has to
 * read INSIDE its turn, or it reads state that the write in front of it is
 * about to change.
 */
function postTask(folder, id, patch) {
  const key = taskWriteKey(folder, id);
  const tail = CAL_POST_QUEUE.get(key) ?? Promise.resolve();
  const run = tail.then(async () => api(`/api/class/${folder}/task/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(typeof patch === 'function' ? await patch() : patch),
  }));
  // The chain must survive a rejection, or one failure wedges every later
  // write for the same item; and it must not accumulate a key per item for
  // the life of the page.
  const settled = run.catch(() => {}).finally(() => {
    if (CAL_POST_QUEUE.get(key) === settled) CAL_POST_QUEUE.delete(key);
  });
  CAL_POST_QUEUE.set(key, settled);
  return run;
}

/** The checkpoint list of a task this page has not opened. */
async function loadCheckpointsFor(folder, itemId) {
  const data = await apiJson(`/api/class/${folder}`);
  return data?.user_state?.[itemId]?.checkpoints ?? null;
}

/**
 * Pull the worklist again once the bridge has had time to rebuild it.
 *
 * A move that writes to user_state.json only reaches the calendar through the
 * worklist, and that rebuild is debounced ~1.5s. Until it lands the grid still
 * shows the item where it was, so the drag would look like it failed. Waiting
 * is not an option either — the user is holding the mouse. So: paint nothing
 * optimistic for these (the store is not ours to mirror), and refetch shortly
 * after, which is the same mechanism the meeting-times editor uses.
 */
let calRefreshTimer = null;
function refreshCalendarSoon(delay = 1800) {
  clearTimeout(calRefreshTimer);
  calRefreshTimer = setTimeout(async () => {
    // Never repaint out from under a gesture in progress. The pointer is
    // captured on the container so the drag itself would survive, but the
    // chip under the cursor would be replaced mid-move and the drop-target
    // highlight would be wiped — the user would be dragging a ghost.
    if (CAL_DRAG) { refreshCalendarSoon(600); return; }
    try {
      const { worklist, custom_items } = await apiJson('/api/calendar');
      CAL_WORKLIST = worklist;
      if (Array.isArray(custom_items)) CAL_CUSTOM = custom_items;
      seedCalDone();
      renderCalendarOps();
      if (CURRENT) refreshCurrentClass();
    } catch { /* the next full load catches up */ }
  }, delay);
}

/** Re-read the open class so its task list agrees with a calendar edit. */
async function refreshCurrentClass() {
  const folder = CURRENT?.folder;
  if (!folder) return;
  try {
    const data = await apiJson(`/api/class/${folder}`);
    if (CURRENT?.folder !== folder) return;   // the user moved on
    CURRENT = data;
    if (!$('detail').classList.contains('hidden')) renderTasks();
  } catch { /* the next open re-reads it */ }
}

// ---------------------------------------------------------------------------
// The item dialog — where a calendar item is written, changed, or read.
//
// One dialog, three jobs, because they are three views of one question ("what
// is this thing on my calendar?"):
//
//   create   a new item, from the Add button or from a range dragged on the
//            grid, which arrives with its dates already filled in
//   custom   an item the user added: every field editable, and deletable
//   op       a lecture or an office-hours block: its facts, stated and not
//            editable — they come from the syllabus — plus the one thing that
//            IS the user's, a note
//
// A native <dialog>, so Escape, the backdrop and focus containment are the
// platform's job rather than this file's. CALENDAR-SPEC §8.
// ---------------------------------------------------------------------------

let ITEM_DIALOG = null;   // { mode, item?, op?, folder?, noteKey? } while open

/** Every class the user could file an item under, plus Personal. */
function itemClassOptions(selected) {
  const rows = [{ slug: PERSONAL_SLUG, name: 'Personal (no class)' }]
    .concat((CLASSES || []).map(c => ({ slug: c.slug, name: c.code || c.folder })));
  // An item filed under a class that has since been unsynced or deleted keeps
  // its own row. Without it the select falls back to the first option, so
  // simply OPENING such an item and saving anything — a typo in the title —
  // silently re-filed it as Personal and lost which class it belonged to.
  if (selected && selected !== PERSONAL_SLUG && !rows.some(r => r.slug === selected)) {
    rows.push({ slug: selected, name: `${calDisplayName(selected)} (no longer synced)` });
  }
  return rows.map(r =>
    `<option value="${esc(r.slug)}"${r.slug === (selected || PERSONAL_SLUG) ? ' selected' : ''}>${esc(r.name)}</option>`
  ).join('');
}

function openItemDialog(spec) {
  const dlg = $('cal-item-dialog');
  if (!dlg) return;
  ITEM_DIALOG = spec;
  renderItemDialog();
  // A lecture's page offers that class's own times, which ride on a request
  // made behind the calendar. Opening one in the gap would show the page with
  // no fields at all, so fetch them and repaint in place.
  if (spec.mode === 'op' && !CAL_CLASSES) {
    loadCalClasses()
      .then(() => { if (ITEM_DIALOG === spec) renderItemDialog(); })
      .catch(() => {});
  }
  if (!dlg.open) dlg.showModal();
  // The title is what a new item needs; a note is what an existing one is
  // usually opened for.
  const focus = dlg.querySelector('[data-item-title]:not([disabled])')
    ?? dlg.querySelector('[data-item-note]');
  focus?.focus();
}

function closeItemDialog() {
  ITEM_DIALOG = null;
  const dlg = $('cal-item-dialog');
  if (dlg?.open) dlg.close();
}

function renderItemDialog() {
  const d = ITEM_DIALOG;
  const form = $('cal-item-form');
  if (!d || !form) return;
  form.innerHTML = d.mode === 'op' ? opDialogHtml(d) : customDialogHtml(d);
}

/** The editor for an item the user owns — new or existing. */
function customDialogHtml(d) {
  const it = d.item ?? {};
  const date = d.date ?? it.date ?? localTodayIso();
  const endDate = d.endDate ?? it.end_date ?? '';
  const time = it.time ?? '';
  const endTime = it.end_time ?? '';
  const editing = d.mode === 'custom';
  return `
    <header class="item-head">
      <h3>${editing ? 'Edit item' : 'New calendar item'}</h3>
      <button type="button" class="linky" data-item-cancel>close</button>
    </header>
    <label class="item-field">
      <span>Title</span>
      <input type="text" data-item-title maxlength="300" required
             value="${esc(it.title ?? '')}" />
    </label>
    <label class="item-field">
      <span>Calendar</span>
      <select data-item-class>${itemClassOptions(it.class)}</select>
    </label>
    <div class="item-row">
      <label class="item-field">
        <span>Date</span>
        <input type="date" data-item-date value="${esc(date)}" required />
      </label>
      <label class="item-field">
        <span>Ends</span>
        <input type="date" data-item-enddate value="${esc(endDate)}" />
      </label>
    </div>
    <div class="item-row">
      <label class="item-field">
        <span>Start time</span>
        <input type="time" data-item-time value="${esc(time)}" />
      </label>
      <label class="item-field">
        <span>End time</span>
        <input type="time" data-item-endtime value="${esc(endTime)}" />
      </label>
    </div>
    <label class="item-field">
      <span>Notes</span>
      <textarea data-item-note rows="3" maxlength="4000">${esc(it.description ?? '')}</textarea>
    </label>
    <div class="item-actions">
      ${editing ? '<button type="button" class="danger" data-item-delete>Delete</button>' : ''}
      <span class="spacer"></span>
      <span class="item-error" data-item-error></span>
      <button type="button" data-item-cancel>Cancel</button>
      <button type="submit" class="primary" data-item-save>${editing ? 'Save' : 'Add to calendar'}</button>
    </div>`;
}

/** The read-and-annotate page for a lecture or an office-hours block. */
function opDialogHtml(d) {
  const op = d.op ?? {};
  const folder = d.folder;
  const c = (CAL_CLASSES?.classes ?? []).find(x => x.folder === folder);
  const p = (c?.meeting_times?.patterns || [])[0] || {};
  // Office hours are stated in the syllabus prose and have no override store,
  // so their times are shown and not offered as fields — a control that
  // silently wrote nowhere would be worse than none.
  const editable = op.kind !== 'office_hours' && !!c;
  const days = p.byday || [];

  // The topic, and nothing else. Everything the description otherwise carries
  // here — why the hour is unknown, which source it came from, what to do
  // about it — is either restated by the fields below or answered by them.
  const topic = String(op.description ?? '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !/^(Note|Source|Location|Time unknown|Pattern|Office hours|Syllabus|Contact|Stated for|Tentative|Appointments|Other synced|Added by you)\b/i.test(l))
    // "Class: …" / "Lecture: …" — the label the schedule row carried. The
    // heading already says what this is, so only the subject survives.
    ?.replace(/^(class|lecture|lab|session|seminar|discussion)\s*[:\u2014-]\s*/i, '')
    ?? '';

  const when = op.date ? `${fmtDayLabel(op.date)} · ${calWhenLabel(op)}` : '';
  const meta = [when, calDisplayName(op.class), op.location].filter(Boolean);

  return `
    <header class="item-head">
      <h3>${esc(op.title ?? 'Calendar item')}</h3>
      <button type="button" class="linky" data-item-cancel>close</button>
    </header>
    <p class="item-meta">${esc(meta.join(' · '))}</p>
    ${topic ? `<p class="item-topic">${esc(clipText(topic, 95))}</p>` : ''}
    ${editable ? `
      <div class="item-field">
        <span>Class times</span>
        <div class="meet-days">
          ${MEET_DAYS.map(([code, label]) => `
            <label class="meet-day${days.includes(code) ? ' on' : ''}">
              <input type="checkbox" name="day" value="${code}"${days.includes(code) ? ' checked' : ''} />
              <span>${label}</span>
            </label>`).join('')}
        </div>
      </div>
      <div class="item-row three">
        <label class="item-field"><span>Starts</span>
          <input type="time" name="start" value="${esc(p.start || '')}" /></label>
        <label class="item-field"><span>Ends</span>
          <input type="time" name="end" value="${esc(p.end || '')}" /></label>
        <label class="item-field"><span>Room</span>
          <input type="text" name="location" value="${esc(p.location || '')}" /></label>
      </div>
      <p class="item-hint">Applies to every ${esc(calDisplayName(op.class))} session.${
        c?.meeting_times?.source === 'override'
          ? ' <button type="button" class="linky" data-item-meet-clear>use the syllabus</button>' : ''}</p>
    ` : ''}
    <label class="item-field">
      <span>Notes</span>
      <textarea data-item-note rows="3" maxlength="4000">${esc(d.note ?? '')}</textarea>
    </label>
    <div class="item-actions">
      <span class="spacer"></span>
      <span class="item-error" data-item-error></span>
      <button type="button" data-item-cancel>Close</button>
      <button type="submit" class="primary" data-item-save>Save</button>
    </div>`;
}

/** One line, cut on a word rather than mid-syllable. */
function clipText(text, max) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s—–-]+$/, '')}…`;
}

/** The class-times fields, or null when this dialog did not offer them. */
function readMeetFields(form) {
  const days = [...form.querySelectorAll('input[name=day]')];
  if (!days.length) return null;
  const val = (n) => form.querySelector(`[name=${n}]`)?.value?.trim() || null;
  return {
    days: days.filter(el => el.checked).map(el => el.value),
    start: val('start'),
    end: val('end'),
    location: val('location'),
  };
}

/** Did the user actually touch the times, or only the note? */
function meetTimesChanged(d, next) {
  const c = (CAL_CLASSES?.classes ?? []).find(x => x.folder === d.folder);
  const p = (c?.meeting_times?.patterns || [])[0] || {};
  const was = {
    days: (p.byday || []).join(','),
    start: p.start || null,
    end: p.end || null,
    location: p.location || null,
  };
  return was.days !== next.days.join(',')
    || was.start !== next.start
    || was.end !== next.end
    || was.location !== next.location;
}

/** Read the editor back out. Empty strings become nulls, never "". */
function readItemForm(form) {
  const val = (sel) => form.querySelector(sel)?.value?.trim() ?? '';
  const slug = val('[data-item-class]');
  return {
    title: val('[data-item-title]'),
    class: !slug || slug === PERSONAL_SLUG ? null : slug,
    date: val('[data-item-date]'),
    end_date: val('[data-item-enddate]') || null,
    time: val('[data-item-time]') || null,
    end_time: val('[data-item-endtime]') || null,
    description: val('[data-item-note]') || null,
  };
}

async function submitItemDialog() {
  const d = ITEM_DIALOG;
  const form = $('cal-item-form');
  if (!d || !form) return;
  const err = form.querySelector('[data-item-error]');
  const say = (msg) => { if (err) err.textContent = msg; };

  if (d.mode === 'op') {
    const note = form.querySelector('[data-item-note]')?.value ?? '';
    // The class's own times, when this page offered them. Sent only when they
    // actually changed: a POST here rewrites the override for every session of
    // the class, so opening a lecture and pressing Save on a note it did not
    // touch must not stamp one.
    const times = readMeetFields(form);
    say('Saving…');
    try {
      if (times && meetTimesChanged(d, times)) {
        if (!times.days.length) { say('Pick at least one day.'); return; }
        if (Boolean(times.start) !== Boolean(times.end)) {
          say('Set both a start and an end, or neither.'); return;
        }
        await api(`/api/class/${d.folder}/meetings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(times),
        });
        await loadCalClasses().catch(() => {});
      }
      await postTask(d.folder, d.noteKey, { note });
      closeItemDialog();
      refreshCalendarSoon();
    } catch (e) { say(e.message); }
    return;
  }

  const fields = readItemForm(form);
  if (!fields.title) { say('Give it a title.'); return; }
  if (!fields.date) { say('Give it a date.'); return; }
  say('Saving…');
  try {
    if (d.mode === 'custom') await queueCustomWrite(d.item.id, fields);
    else await createCustomItem(fields);
    closeItemDialog();
  } catch (e) {
    // The bridge's own message says exactly what is wrong with the shape —
    // "an item spanning days needs an end time" beats "could not save".
    say(e.message);
  }
}

// --- the three writes, each painting before it waits ------------------------

async function createCustomItem(fields) {
  const { item } = await apiJson('/api/calendar/items', {
    method: 'POST', body: JSON.stringify(fields),
  });
  CAL_CUSTOM = [...CAL_CUSTOM, item];
  renderCalendarOps();
  return item;
}

/**
 * One write to one added item, serialized against every other write to it.
 *
 * The store is a single JSON file the bridge rewrites wholesale, so two
 * overlapping PATCHes of one item are a lost update — and since the client
 * paints from the response, the screen would settle on whichever reply came
 * back last rather than on what is actually stored.
 */
function queueCustomWrite(id, patch) {
  const key = `custom|${id}`;
  const tail = CAL_POST_QUEUE.get(key) ?? Promise.resolve();
  const run = tail.then(() => patchCustomItem(id, patch));
  const settled = run.catch(() => {}).finally(() => {
    if (CAL_POST_QUEUE.get(key) === settled) CAL_POST_QUEUE.delete(key);
  });
  CAL_POST_QUEUE.set(key, settled);
  return run;
}

async function patchCustomItem(id, patch) {
  const before = CAL_CUSTOM;
  // Paint it first: a dragged item that waits for the network snaps back to
  // where it was for as long as the round trip takes, which reads as the drag
  // having failed.
  CAL_CUSTOM = CAL_CUSTOM.map(it => (it.id === id ? { ...it, ...patch } : it));
  renderCalendarOps();
  try {
    const { item } = await apiJson(`/api/calendar/items/${id}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    });
    CAL_CUSTOM = CAL_CUSTOM.map(it => (it.id === id ? item : it));
    renderCalendarOps();
    return item;
  } catch (e) {
    CAL_CUSTOM = before;
    renderCalendarOps();
    throw e;
  }
}

async function deleteCustomItem(id) {
  const before = CAL_CUSTOM;
  CAL_CUSTOM = CAL_CUSTOM.filter(it => it.id !== id);
  renderCalendarOps();
  try {
    await api(`/api/calendar/items/${id}`, { method: 'DELETE' });
  } catch (e) {
    CAL_CUSTOM = before;
    renderCalendarOps();
    throw e;
  }
}

function wireItemDialog() {
  const dlg = $('cal-item-dialog');
  const form = $('cal-item-form');
  if (!dlg || !form) return;

  form.addEventListener('submit', (ev) => {
    // The form is method="dialog"; without this the dialog closes on Enter
    // before anything is written.
    ev.preventDefault();
    submitItemDialog();
  });

  // The day pills carry their own checkbox; the class only reflects it.
  form.addEventListener('change', (ev) => {
    const box = ev.target.closest('.meet-day input[name=day]');
    if (box) box.closest('.meet-day').classList.toggle('on', box.checked);
  });

  form.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-item-cancel]')) { closeItemDialog(); return; }

    // Drop this class's override and go back to whatever the syllabus said.
    if (ev.target.closest('[data-item-meet-clear]')) {
      const d = ITEM_DIALOG;
      if (!d?.folder) return;
      try {
        await api(`/api/class/${d.folder}/meetings`, { method: 'DELETE' });
        await loadCalClasses().catch(() => {});
        renderItemDialog();
        refreshCalendarSoon();
      } catch (e) {
        form.querySelector('[data-item-error]').textContent = e.message;
      }
      return;
    }

    const del = ev.target.closest('[data-item-delete]');
    if (!del) return;
    // Two presses, like the class cleanup: deleting is the one action here
    // that cannot be undone by typing the same thing back in.
    if (del.dataset.armed !== '1') {
      del.dataset.armed = '1';
      del.textContent = 'Confirm — delete this item';
      return;
    }
    const id = ITEM_DIALOG?.item?.id;
    if (!id) return;
    del.disabled = true;
    try {
      await deleteCustomItem(id);
      closeItemDialog();
    } catch (e) {
      del.disabled = false;
      form.querySelector('[data-item-error]').textContent = `Could not delete that: ${e.message}`;
    }
  });

  // Closing by Escape or the backdrop has to clear the state too, or the next
  // open renders whatever was on screen last.
  dlg.addEventListener('close', () => { ITEM_DIALOG = null; });
  dlg.addEventListener('click', (ev) => {
    // A click on the backdrop lands on the dialog element itself.
    if (ev.target === dlg) closeItemDialog();
  });
}

function wireCalendarDrag() {
  const box = $('cal-ops');
  box.addEventListener('pointerdown', calPointerDown);
  box.addEventListener('pointermove', calPointerMove);
  box.addEventListener('pointerup', calPointerUp);
  box.addEventListener('pointercancel', () => { CAL_DRAG = null; clearDragPaint(); });
  // A drag abandoned with the keyboard leaves nothing painted and writes
  // nothing — the same escape hatch the colour picker has. The button is
  // usually still down, so the click that lands on release has to be eaten
  // too: cancelling a drag over a title must not open that title.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !CAL_DRAG) return;
    const wasDragging = CAL_DRAG.moved;
    CAL_DRAG = null;
    clearDragPaint();
    if (wasDragging) swallowNextClick({ afterPointerUp: true });
  });
}

/**
 * The period navigator: `‹ prev`, `Today`, `next ›` and the heading naming what
 * is on screen. Only the grids have a period; the list is the whole window.
 */
function renderCalPeriod() {
  const box = $('cal-period');
  if (CAL_VIEW === 'list') { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  if (CAL_VIEW === 'twoday') {
    // The range says what it is; there is nothing to steer, so no arrows are
    // drawn rather than drawn-and-inert.
    const [a, b] = twoDayDays();
    box.innerHTML = `<span class="period-label" id="cal-period-label">${
      esc(`${fmtDayLabel(a)} – ${fmtDayLabel(b)}`)}</span>`;
    return;
  }
  const label = CAL_VIEW === 'week' ? weekLabel(CAL_ANCHOR) : monthLabel(CAL_ANCHOR);
  const unit = CAL_VIEW === 'week' ? 'week' : 'month';
  box.innerHTML = `
    <button type="button" class="period-nav" data-cal-step="-1" aria-label="Previous ${unit}">&#8249;</button>
    <span class="period-label" id="cal-period-label">${esc(label)}</span>
    <button type="button" class="period-nav" data-cal-step="1" aria-label="Next ${unit}">&#8250;</button>
    <button type="button" class="period-today" data-cal-step="0">Today</button>`;
}

// The kinds the worklist actually carries, in the order the builder names them.
// It comes off the worklist itself rather than a second request, so the filter
// row and the ops it filters can never disagree about what a kind is called.
function calKindList() {
  const labels = CAL_WORKLIST?.kind_labels;
  if (labels && typeof labels === 'object') return Object.keys(labels);
  const counts = CAL_WORKLIST?.counts;
  return counts && typeof counts === 'object' ? Object.keys(counts) : [];
}

function calKindLabel(kind) {
  return CAL_WORKLIST?.kind_labels?.[kind] ?? kind;
}

// Dense grid chips need a category cue that survives a narrow month cell.
// These are deliberately short, while their title exposes the full label.
function calKindShort(kind) {
  return ({
    meeting: 'CLASS',
    office_hours: 'OH',
    homework: 'HW',
    reading: 'READ',
    exam: 'EXAM',
    checkpoint: 'STEP',
    personal: 'YOU',
  })[kind] ?? String(kind || 'ITEM').slice(0, 5).toUpperCase();
}

/**
 * The kind filters.
 *
 * These used to be the "Populate" panel: five switches that decided what the
 * worklist BUILT. Turning one off did not hide readings, it stopped mining
 * them, so the answer to "where did they go" was a rebuild away — and with all
 * five off the calendar emptied itself, which looks exactly like a broken sync.
 *
 * Now everything is built and these only decide what is drawn. The selection
 * semantics are unchanged and still proved exhaustively in cal-plan.test.js:
 * nothing selected lights every chip and shows every kind, and no sequence of
 * clicks reaches "none".
 *
 * A kind with no ops still gets a chip. It is not dead: the count on it is the
 * answer to "why is there no homework this week", and cal-notes says why.
 */
function renderCalKinds(all) {
  const box = $('cal-kind-filters');
  const kinds = calKindList();
  const aiCount = all.filter(o => calItemModel(o).aiAdded).length;
  if (kinds.length < 2 && !aiCount) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const counts = {};
  for (const o of all) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  const kindButtons = kinds.length < 2 ? '' : kinds.map((k) => {
    const on = isSelected(CAL_KIND_SEL, k);
    const n = counts[k] ?? 0;
    return `<button type="button" class="filter-chip${on ? ' on' : ''}${n ? '' : ' empty'}"
      data-kind-filter="${esc(k)}" aria-pressed="${on ? 'true' : 'false'}">${esc(calKindLabel(k))}<span class="chip-count">${n}</span></button>`;
  }).join('');
  const aiButton = aiCount ? `<button type="button" class="filter-chip ai-filter${CAL_SHOW_AI_ADDED ? ' on' : ''}"
      data-ai-added-filter aria-pressed="${CAL_SHOW_AI_ADDED ? 'true' : 'false'}"
      title="Show or hide items added by AI from syllabi">AI-added<span class="chip-count">${aiCount}</span></button>` : '';
  box.innerHTML = `${kindButtons}${aiButton}`;
}

/**
 * Why a kind or a class has nothing on the calendar.
 *
 * An empty Readings filter and a class with no meetings both used to look
 * exactly like a sync that had failed: zero rows and no explanation. BUSI 396
 * shows 0 meetings because its four "schedule" rows are module date ranges
 * rather than class sessions, a genuinely undated recurring reading still has
 * no honest calendar slot, and ENTR 222 holds office hours by appointment only.
 * These cases are invisible without the notes. Explicit dated readings now
 * come from the deterministic reading index. CALENDAR-SPEC 4.5, 4.6.
 *
 * Global notes always; per-class notes only when the filter has narrowed to a
 * few kinds, or the unfiltered view prints a paragraph per class per kind.
 */
function renderCalNotes() {
  const box = $('cal-notes');
  const kn = CAL_WORKLIST?.kind_notes;
  const all = calKindList();
  const kinds = all.filter(k => isSelected(CAL_KIND_SEL, k));
  if (!kn) { box.classList.add('hidden'); box.innerHTML = ''; return; }

  const narrowed = CAL_KIND_SEL.length > 0 && CAL_KIND_SEL.length <= 2;
  const classSel = calClassSel();
  const lines = [];
  for (const k of kinds) {
    const entry = kn[k];
    if (!entry) continue;
    // A note that only restates a control is not a note. The worklist stopped
    // emitting these, but a page loaded against a worklist built by older code
    // would still print four of them.
    if (entry.note && !/switch is off\.?$/.test(entry.note)) {
      lines.push({ text: entry.note, slug: null });
    }
    if (!narrowed) continue;
    for (const [slug, text] of Object.entries(entry.classes || {})) {
      if (!isSelected(classSel, slug) || !text) continue;
      // Only where something was actively refused. "No readings to schedule in
      // this class", printed once per class, is six lines that say nothing;
      // "4 module boundaries, not class sessions" is the answer to the question
      // the empty column raises. Same filter renderWorklistMd() applies, so the
      // page and the routine's own markdown agree about what is worth saying.
      const refused = (CAL_WORKLIST?.dropped ?? [])
        .some(d => d.class === slug && d.kind === k && d.reason !== 'done');
      if (!refused) continue;
      lines.push({ text, slug });
    }
  }
  if (!lines.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = lines.map(l => `
    <p class="cal-note"${l.slug ? ` style="--class-color:${classColor(l.slug)}"` : ''}>
      ${l.slug ? `<span class="note-class">${esc(calDisplayName(l.slug))}</span>` : ''}${esc(l.text)}
    </p>`).join('');
}

/** Move the grid one period, or back to the one containing today. */
function stepCalPeriod(n) {
  if (CAL_VIEW === 'twoday') return;   // the range is today+tomorrow by definition
  if (n === 0) CAL_ANCHOR = todayIso();
  else if (CAL_VIEW === 'week') CAL_ANCHOR = addDays(CAL_ANCHOR, 7 * n);
  else CAL_ANCHOR = addMonths(startOfMonth(CAL_ANCHOR), n);
  CAL_EXPANDED = new Set();
  renderCalendarOps();
}

// ---------------------------------------------------------------------------
// Class chips: one per synced class, carrying its colour, its name and whether
// it is showing.
//
// The colour editor used to be a separate collapsed block listing every class
// again, underneath the chips that already showed every class in its colour.
// Two lists of the same thing, and the one you wanted to change was the one you
// could not click. So the swatch on the chip IS the control now.
//
// Built from the synced class list rather than from the ops, so a class whose
// work has all gone past still has a chip — it is the only place its colour can
// be changed, and a control that vanishes with the last deadline is worse than
// one that does nothing this week.
// ---------------------------------------------------------------------------

let COLOR_OPEN = null;   // slug whose picker is open, or null

function cssEsc(s) {
  return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

function chipRowsSource() {
  const fromClasses = (CLASSES || [])
    .map(c => ({ slug: c.slug, name: c.code || c.folder, resolvable: true }));
  // Personal items get a chip of their own as soon as one exists, so they can
  // be filtered and recoloured like any class. It is listed only when there is
  // something in it — a filter for an empty category is a dead control.
  //
  // A worklist op with no class counts too, via opClassSlug(). Under the old
  // hidden-set model a classless op was always drawn, because nothing was
  // hiding it; under a selection it is drawn only if its slug is selected, so
  // one with no chip would vanish the moment any class was picked and no
  // control could bring it back. Every drawn item belongs to exactly one chip.
  if (CAL_CUSTOM.some(it => !it.class)
      || (CAL_WORKLIST?.ops ?? []).some(o => !o.class)) {
    fromClasses.push({ slug: PERSONAL_SLUG, name: 'Personal', resolvable: true });
  }
  const known = new Set(fromClasses.map(r => r.slug));
  // A slug the worklist mentions but the class list does not: the bridge
  // resolves colours by walking class folders, so it has no colour to return
  // and no override it would ever apply. Listed and toggleable, not editable.
  const fromOps = [...new Set((CAL_WORKLIST?.ops ?? []).map(o => o.class).filter(Boolean))]
    .filter(s => !known.has(s))
    .map(slug => ({ slug, name: calDisplayName(slug), resolvable: false }));
  return [...fromClasses, ...fromOps].sort((a, b) => a.name.localeCompare(b.name));
}

// The chip an op answers to. Falsy means "no class", which is what the
// Personal chip is — the same mapping customRenderOp() already applies to a
// classless custom item, so the two paths cannot disagree about which chip
// governs an item.
function opClassSlug(op) {
  return op?.class || PERSONAL_SLUG;
}

// The stored class selection, less any slug the chips no longer offer. The
// reasoning lives with pruneSelection() in cal-plan.js, where it is testable;
// this is only the wiring that hands it the current vocabulary.
function calClassSel(rows = chipRowsSource()) {
  return pruneSelection(CAL_CLASS_SEL, rows.map(r => r.slug));
}

function renderClassChips() {
  const box = $('cal-classes');
  const rows = chipRowsSource();
  if (!rows.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const sel = calClassSel(rows);
  box.innerHTML = rows.map(({ slug, name, resolvable }) => {
    const off = !isSelected(sel, slug);
    const open = COLOR_OPEN === slug;
    return `
    <span class="class-chip${off ? ' off' : ''}${open ? ' picking' : ''}" style="--class-color:${classColor(slug)}">
      <button type="button" class="chip-swatch" data-color-open="${esc(slug)}"
              aria-expanded="${open ? 'true' : 'false'}"
              aria-label="Colour for ${esc(name)}"${resolvable && COLORS_LOADED ? '' : ' disabled'}></button>
      <button type="button" class="chip-name" data-cal-class-toggle="${esc(slug)}"
              aria-pressed="${off ? 'false' : 'true'}">${esc(name)}</button>
      ${open ? colorPopHtml(slug, name) : ''}
    </span>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// The colour picker.
//
// Any colour, because a native <input type="color"> is any colour and writing a
// worse one in JavaScript would be the only reason to have fewer. Above it, the
// generic palette, and the last six colours actually used — which is the list
// that matters once a term is underway, because the second class you recolour
// is usually being matched to the first.
// ---------------------------------------------------------------------------

const COLOR_RECENTS_KEY = 'calColorRecents';
const COLOR_RECENTS_MAX = 6;
const HEX_RE = /^#[0-9a-f]{6}$/i;

function colorRecents() {
  try {
    const v = JSON.parse(localStorage.getItem(COLOR_RECENTS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter(h => typeof h === 'string' && HEX_RE.test(h)).slice(0, COLOR_RECENTS_MAX) : [];
  } catch { return []; }
}

function rememberColor(hex) {
  if (!HEX_RE.test(hex ?? '')) return;
  const h = hex.toLowerCase();
  const next = [h, ...colorRecents().filter(x => x.toLowerCase() !== h)].slice(0, COLOR_RECENTS_MAX);
  try { localStorage.setItem(COLOR_RECENTS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
}

function swatchBtn(hex, slug, current, cls) {
  const on = current && hex.toLowerCase() === current.toLowerCase();
  return `<button type="button" class="pick${on ? ' on' : ''}${cls ? ` ${cls}` : ''}"
    style="--pick-color:${esc(hex)};--pick-ink:${readableOn(hex)}"
    data-color-pick="${esc(hex)}" data-color-slug="${esc(slug)}"
    title="${esc(hex)}" aria-label="Use ${esc(hex)}">${on ? '✓' : ''}</button>`;
}

function colorPopHtml(slug, name) {
  const current = (COLORS_LOADED && CLASS_COLORS[slug]) || null;
  const recents = colorRecents().filter(h => !CLASS_PALETTE.some(p => p.toLowerCase() === h.toLowerCase()));
  return `
    <div class="color-pop" data-color-pop="${esc(slug)}" role="dialog" aria-label="Colour for ${esc(name)}">
      <div class="pop-picks">${CLASS_PALETTE.map(h => swatchBtn(h, slug, current)).join('')}</div>
      ${recents.length ? `<div class="pop-picks recents" aria-label="Recently used">${recents.map(h => swatchBtn(h, slug, current, 'recent')).join('')}</div>` : ''}
      <div class="pop-foot">
        <label class="pop-custom">
          <input type="color" data-color-input="${esc(slug)}" value="${esc(current || '#cdc1ab')}"
                 aria-label="Any colour for ${esc(name)}" />
          <span>${esc(current || 'any colour')}</span>
        </label>
        ${CLASS_OVERRIDES[slug] ? `<button type="button" class="linky" data-color-reset="${esc(slug)}">revert</button>` : ''}
      </div>
    </div>`;
}

// Saving must feel immediate: paint the new colour everywhere first, POST, and
// reconcile with whatever the bridge says the truth is.
async function saveClassColor(slug, hex) {
  const previous = { colors: { ...CLASS_COLORS }, overrides: { ...CLASS_OVERRIDES }, palette: CLASS_PALETTE };
  if (hex === null) delete CLASS_OVERRIDES[slug]; else CLASS_OVERRIDES[slug] = hex;
  if (hex !== null) CLASS_COLORS[slug] = hex;
  repaintClassColors();
  try {
    const res = await apiJson('/api/class-colors', {
      method: 'POST',
      body: JSON.stringify({ colors: { [slug]: hex } }),
    });
    applyColorPayload(res);
    if (res.rejected?.length) toast(`Could not use that colour: ${res.rejected[0].reason}`);
    else if (hex !== null) rememberColor(hex);
  } catch (err) {
    applyColorPayload(previous);
    toast(`Could not save that colour: ${err.message}`);
  }
  repaintClassColors();
}

// Everywhere a class colour is drawn, redrawn. Cheap, and it keeps the sidebar
// rule, the calendar rules and the chips from ever disagreeing.
function repaintClassColors() {
  document.querySelectorAll('#class-list li').forEach((li) => {
    li.style.setProperty('--class-color', classColor(li.dataset.slug));
  });
  renderCalendarOps();   // rebuilds the chips row, picker included
}

// The live preview while the native picker is open. Only the marks carrying
// this one class's colour move, so dragging the eyedropper does not rebuild the
// calendar sixty times a second — and never rebuilds the chip holding the open
// picker, which would tear it out from under the pointer.
function previewClassColor(slug) {
  const c = classColor(slug);
  for (const sel of ['#class-list li', `[data-cal-class-toggle="${cssEsc(slug)}"]`, `[data-class-slug="${cssEsc(slug)}"]`]) {
    document.querySelectorAll(sel).forEach((el) => {
      if (sel !== '#class-list li' || el.dataset.slug === slug) {
        (el.closest('.class-chip') ?? el).style.setProperty('--class-color', c);
      }
    });
  }
  const label = document.querySelector(`[data-color-pop="${cssEsc(slug)}"] .pop-custom span`);
  if (label) label.textContent = c;
}

function wireClassColors() {
  const box = $('cal-classes');

  // 'input' fires continuously while the native picker is open; 'change' fires
  // once it closes. Preview on input, write on change — otherwise dragging the
  // eyedropper across a gradient POSTs a hundred times. The in-flight value
  // lives in COLOR_DRAFT, never in CLASS_COLORS, so abandoning it leaves
  // nothing behind.
  box.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-color-input]');
    if (!el || el.disabled) return;
    COLOR_DRAFT = { slug: el.dataset.colorInput, hex: el.value };
    previewClassColor(COLOR_DRAFT.slug);
  });
  box.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-color-input]');
    if (!el || el.disabled) return;
    const { slug } = { slug: el.dataset.colorInput };
    COLOR_DRAFT = null;
    COLOR_OPEN = null;
    saveClassColor(slug, el.value);
  });
  // A picker dismissed without committing leaves no trace.
  box.addEventListener('blur', (ev) => {
    if (!ev.target.closest?.('[data-color-input]') || !COLOR_DRAFT) return;
    const { slug } = COLOR_DRAFT;
    COLOR_DRAFT = null;
    previewClassColor(slug);
  }, true);
}

/** Clicks inside an open picker. Returns true when it handled one. */
function handleColorPopClick(ev) {
  const pick = ev.target.closest('[data-color-pick]');
  if (pick) {
    rememberColor(pick.dataset.colorPick);
    COLOR_OPEN = null;
    saveClassColor(pick.dataset.colorSlug, pick.dataset.colorPick);
    return true;
  }
  const reset = ev.target.closest('[data-color-reset]');
  if (reset) {
    COLOR_OPEN = null;
    saveClassColor(reset.dataset.colorReset, null);
    return true;
  }
  // The native picker and its label must not fall through to the chip toggle.
  return Boolean(ev.target.closest('.pop-custom'));
}

/**
 * Finished work, brought back as op-shaped rows.
 *
 * buildWorklist() drops done items on purpose — the routine must not create a
 * calendar event for work that is finished. But the row and the checkbox that
 * would un-finish it disappeared together, so a mis-click was permanent. The
 * worklist records them in `dropped` with reason 'done'; this turns them back
 * into something the same renderers can draw. CALENDAR-SPEC 2.5.
 */
function completedOps() {
  const dropped = CAL_WORKLIST?.dropped ?? [];
  // Finished items the user added come from CAL_CUSTOM for the same reason
  // the live ones do: it is newer than the worklist's `dropped` record.
  const custom = CAL_CUSTOM
    .filter(it => it.done)
    .map(it => ({ ...customRenderOp(it), _completed: true }));
  return dropped
    .filter(d => d && d.reason === 'done' && d.date && d.calendar !== 'custom')
    .map(d => ({
      ...d,
      calendar: d.calendar || (d.kind === 'checkpoint' ? 'checkpoint' : 'due'),
      // The op title, not the raw mined one. The record carries both because
      // `title` is what the un-tick POSTs against and `event_title` is what the
      // row says — reading the wrong one put "S2a-Concept Check: Understand
      // the Nature of…" next to "BUSI 380 · Concept Check".
      title: d.event_title || d.title,
      all_day: d.all_day ?? !d.time,
      _completed: true,
    }))
    .concat(custom);
}

/**
 * Seed CAL_DONE from the worklist itself, every load.
 *
 * Without this the set only ever held what was clicked in this page's lifetime:
 * a reload between the tick and the debounced rebuild came back with an empty
 * box for work that was saved. CALENDAR-SPEC 2.4.
 */
// Ticks (and un-ticks) made this session that the server's worklist has not
// caught up to yet: the rebuild is debounced ~1.5s plus run time, so a
// Calendar → Classes → Calendar round trip inside that window refetches a
// stale worklist. Reseeding from it alone redrew a SAVED tick as unchecked —
// spec 2.2/2.4's exact failure mode, reintroduced via the nav path. Each
// entry is key -> intended done state; it retires the moment the server's
// answer agrees.
const CAL_DONE_PENDING = new Map();

function seedCalDone() {
  CAL_DONE.clear();
  for (const d of CAL_WORKLIST?.dropped ?? []) {
    if (!d || d.reason !== 'done') continue;
    const folder = calFolder(d.class);
    if (folder && d.item_id != null) CAL_DONE.add(calDoneKey(folder, d.item_id, d.checkpoint_id ?? null));
  }
  for (const [key, done] of CAL_DONE_PENDING) {
    if (CAL_DONE.has(key) === done) { CAL_DONE_PENDING.delete(key); continue; }
    if (done) CAL_DONE.add(key); else CAL_DONE.delete(key);
  }
}

/**
 * Which control emptied the calendar — named, so the user is not sent to a
 * toggle that is innocent. CALENDAR-SPEC 6.20.
 *
 * Pure, and separated from renderCalendarOps for the same reason
 * brokenPipelinePlan is separated from its route: the decision is the part
 * that was wrong, and inline in a DOM renderer it cannot be tested.
 *
 * `aiHidHere` is measured against the CLASS SELECTION, before the AI filter.
 * The old guard asked whether AI-hidden items emptied the view GLOBALLY, which
 * missed two real shapes: a selected class whose items are all AI-added (the
 * message blamed the class chips, telling the user to deselect a class that
 * was selected and did have items), and a selection whose only VISIBLE rows
 * are past meetings while AI-hidden upcoming work sits behind them (the past
 * message masked it). Both name the AI toggle now, and when the past toggle is
 * also holding something back, both get named.
 */
function calEmptyReason({ shown, matching, aiHidHere, hiddenPast }) {
  if (!matching) return `No ${shown ? `${shown} ` : ''}items in this window.`;
  const n = aiHidHere;
  if (n > 0) {
    const are = n === 1 ? 'is' : 'are';
    const plural = n === 1 ? '' : 's';
    return hiddenPast
      ? `${n} matching item${plural} ${are} AI-added and the rest have already happened — turn on AI-added, or past items, above.`
      : `${n} matching item${plural} ${are} AI-added — turn on AI-added above to show ${n === 1 ? 'it' : 'them'}.`;
  }
  // Past meetings are dropped by their own toggle, AFTER the class filter.
  // Blaming the class chips here would send the user to deselect a class that
  // is in fact selected and does have items — they are simply behind.
  if (hiddenPast) {
    return `Everything here has already happened — turn on past items above to show ${hiddenPast === 1 ? 'it' : 'them'}.`;
  }
  return 'Nothing from the selected classes in this window — deselect one above to widen the view.';
}

function renderCalendarOps() {
  const el = $('cal-ops');
  const toolbar = $('cal-toolbar');
  // Cleared on every path; only a timed grid sets it again. An empty week or a
  // switch to List must not leave a stale budget behind for the resize check
  // to act on — it would re-render a view that has no lanes at all.
  CAL_LANE_BUDGET = null;
  // The worklist's own custom ops are dropped and re-derived from CAL_CUSTOM:
  // between an edit and the rebuild that follows it, this list is newer than
  // the worklist, and drawing both would show the item twice.
  const base = (CAL_WORKLIST?.ops ?? [])
    .filter(o => o.calendar !== 'custom')
    .concat(CAL_CUSTOM.filter(it => !it.done).map(customRenderOp));
  const done = completedOps();
  const all = CAL_SHOW_DONE ? base.concat(done) : base;
  syncCalControls(done.length);
  if (!all.length) {
    // Completed records may still exist behind an empty live list (end of
    // term, everything ticked). The toolbar holds Show completed — the ONE
    // control that can resurrect a mis-ticked item (spec 2.5) — so hiding it
    // here made those items unrecoverable from the calendar.
    if (done.length) {
      toolbar.classList.remove('hidden');
      el.innerHTML = '<p class="muted">Everything in this window is ticked done — Show completed brings it back.</p>';
    } else {
      toolbar.classList.add('hidden');
      el.innerHTML = '<p class="muted">No calendar operations in the current window.</p>';
    }
    return;
  }
  toolbar.classList.remove('hidden');

  const classSel = calClassSel();
  // Filter on the op's own kind, not on the calendar it is written to: 'due'
  // covers homework, readings and exams, and a filter that cannot tell them
  // apart is three chips pretending to be one.
  const byKind = all.filter(o => isSelected(CAL_KIND_SEL, o.kind));
  // A COMPLETED row bypasses the AI-origin filter. Completed records only
  // enter `all` when the user has turned Show completed on, which is an
  // explicit request to see finished work — and spec 2.5 calls that control
  // the one thing that can resurrect a mis-ticked item. With the AI chip off,
  // ticking an AI-added reading by mistake used to leave a button reading
  // "Show 1 completed" that produced no row at all: the label counts the
  // unfiltered done list, the filter then dropped the row again, and nothing
  // named the second, unrelated chip you had to flip to get it back.
  const byOrigin = byKind.filter(o =>
    o._completed || isAiItemVisible(CAL_SHOW_AI_ADDED, calItemModel(o).aiAdded));
  const selectedOps = byOrigin.filter(o => isSelected(classSel, opClassSlug(o)));
  const hiddenPast = CAL_VIEW === 'list' && !CAL_SHOW_PAST
    ? selectedOps.filter(o => daysUntil(calLastDate(o)) < 0 && (o.kind === 'meeting' || o.kind === 'office_hours')).length
    : 0;
  const ops = hiddenPast
    // calLastDate, not o.date: a weekly op is anchored on its FIRST occurrence,
    // so measuring past-ness against it hid every office-hours block a week
    // into term while the series still ran until December. The count above
    // uses the same rule — a summary that disagrees with the filter is worse
    // than either being wrong alone.
    ? selectedOps.filter(o => !(daysUntil(calLastDate(o)) < 0 && (o.kind === 'meeting' || o.kind === 'office_hours')))
    : selectedOps;

  renderCalKinds(all);
  renderClassChips();

  // The grids need a period to open on, and it must be the one containing
  // today rather than the one containing the first op — the worklist window
  // starts a week in the past, so anchoring on the data opens a month the
  // student has already lived through.
  if (!CAL_ANCHOR) CAL_ANCHOR = initialAnchor(base);
  renderCalPeriod();
  renderCalNotes();

  // Optional: an item the user added is drawn from CAL_CUSTOM, which can hold
  // something before a worklist has ever been built — a first run where the
  // pipeline has not finished, and the user adds a personal item. Reading
  // `.window` off a null worklist threw and emptied the whole calendar.
  const w = CAL_WORKLIST?.window || {};
  const classCount = new Set(ops.map(o => o.class)).size;
  const firstVisible = ops.map(o => o.date).filter(Boolean).sort()[0];
  const lastVisible = ops.map(o => o.date).filter(Boolean).sort().at(-1);
  const range = firstVisible && lastVisible ? `${fmtDayLabel(firstVisible)} – ${fmtDayLabel(lastVisible)} · `
    : (w.from && w.to ? `${fmtDayLabel(w.from)} – ${fmtDayLabel(w.to)} · ` : '');
  const hiddenAi = byKind.length - byOrigin.length;
  const hiddenNote = byKind.length - ops.length > 0
    ? ` · ${byKind.length - ops.length} hidden${hiddenAi || hiddenPast ? ` (${[
      hiddenAi ? `${hiddenAi} AI-added` : '',
      hiddenPast ? `${hiddenPast} past schedule` : '',
    ].filter(Boolean).join(', ')})` : ''}`
    : '';
  $('cal-summary').textContent =
    `${range}${ops.length} item${ops.length === 1 ? '' : 's'} across ${classCount} class${classCount === 1 ? '' : 'es'}${hiddenNote}`;

  if (!ops.length) {
    // Name the filter that emptied it. "Nothing here" sends the user looking
    // for a sync problem when the answer is a toggle two inches above.
    const shown = CAL_KIND_SEL.length
      ? CAL_KIND_SEL.map(calKindLabel).join(' or ').toLowerCase()
      : '';
    // "Every class is hidden" is unreachable now that the chips are a
    // selection — deselecting the last one shows everything. What remains
    // reachable is a selection of classes that have nothing in this window.
    // Measure the class filter PRE-AI. The old guard only caught the case where
    // AI-hidden items emptied the view GLOBALLY (`!byOrigin.length`), so a
    // selected class whose items are all AI-added would fall through and blame
    // the class chips — telling the user to deselect a class that is selected
    // and does have items. It also let the past branch mask AI-hidden upcoming
    // work: a selection whose only VISIBLE rows are past meetings reported
    // "everything has already happened" while AI-hidden future items existed.
    // CALENDAR-SPEC 6.20: name the control that emptied it, never an innocent one.
    const selectedPreAi = byKind.filter(o => isSelected(classSel, opClassSlug(o)));
    const why = calEmptyReason({
      shown,
      matching: byKind.length,
      aiHidHere: selectedPreAi.length - selectedOps.length,
      hiddenPast,
    });
    el.innerHTML = `<p class="muted">${esc(why)}</p>`;
    return;
  }

  if (CAL_VIEW === 'twoday') {
    // Scoped to the two days on screen, unlike Week: the clock window is
    // computed from the ops it is given, and a 6am item next week has no
    // business setting the scale of a view about today and tomorrow.
    const days = twoDayDays();
    const inView = ops.filter(o => spanDates(o).some(d => days.includes(d)));
    el.innerHTML = renderCalendarWeekTimed(inView, days);
  } else if (CAL_VIEW === 'week') {
    el.innerHTML = renderCalendarWeek(ops);
  } else if (CAL_VIEW === 'month') {
    el.innerHTML = renderCalendarMonth(ops);
  } else {
    el.innerHTML = CAL_GROUP === 'class' ? renderCalendarByClass(ops) : renderCalendarByDay(ops);
  }
  el.dataset.calView = CAL_VIEW;
}

/**
 * Toolbar state that depends on the view: which view button is pressed, and
 * whether the Day/Class grouping control means anything (it does not in a grid,
 * where the grouping IS the grid). CALENDAR-SPEC 1.4.
 */
function syncCalControls(doneCount) {
  document.querySelectorAll('[data-calview]').forEach(b => {
    const on = b.dataset.calview === CAL_VIEW;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const grp = $('cal-group-seg');
  if (grp) grp.classList.toggle('hidden', CAL_VIEW !== 'list');
  // The clock belongs to Week alone: a month tile has no room for a scale and
  // the list is not a grid, so the control is hidden rather than dead there.
  const times = $('cal-times');
  if (times) {
    times.classList.toggle('hidden', CAL_VIEW !== 'week');
    times.classList.toggle('active', CAL_TIMES);
    times.setAttribute('aria-pressed', CAL_TIMES ? 'true' : 'false');
  }
  const showDone = $('cal-showdone');
  if (showDone) {
    showDone.classList.toggle('hidden', doneCount === 0);
    showDone.classList.toggle('active', CAL_SHOW_DONE);
    showDone.setAttribute('aria-pressed', CAL_SHOW_DONE ? 'true' : 'false');
    showDone.textContent = CAL_SHOW_DONE
      ? `Hide ${doneCount} completed`
      : `Show ${doneCount} completed`;
  }
  const showPast = $('cal-showpast');
  if (showPast) {
    showPast.classList.toggle('hidden', CAL_VIEW !== 'list');
    showPast.classList.toggle('active', CAL_SHOW_PAST);
    showPast.setAttribute('aria-pressed', CAL_SHOW_PAST ? 'true' : 'false');
    showPast.textContent = CAL_SHOW_PAST ? 'Hide past schedule' : 'Show past schedule';
  }
}

async function loadCalendar() {
  // Colours and display names come from the class list; load it first so the
  // calendar never renders a class in the wrong colour on a cold open. Waiting
  // on CLASSES alone was not enough — loadClasses() sets CLASSES before it
  // awaits the colours, so a calendar opened in that gap saw a full class list
  // and an empty colour map and drew the lot grey, permanently. Await the
  // colour promise itself; it is memoised, so this costs one tick when warm.
  if (!CLASSES || !CLASSES.length) await loadClasses().catch(() => {});
  await loadClassColors().catch(() => {});
  const { worklist, custom_items } = await apiJson('/api/calendar');
  CAL_WORKLIST = worklist;
  if (Array.isArray(custom_items)) CAL_CUSTOM = custom_items;
  seedCalDone();
  renderCalendarOps();
  // The class-times list arrives behind the grid — the calendar is useful
  // without it, so nothing waits on it. An open editor is the user's, not
  // ours to redraw (see the poll tick).
  loadCalClasses().then(() => { if (!MEET_EDIT) renderMeetingTimes(); }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Meeting times.
//
// This used to live inside the calendar's "Populate" panel, behind a
// disclosure, next to controls it had nothing to do with. It belongs on the
// class: "when does BUSI 380 meet" is a fact about a class, and the class page
// is where a student goes to look it up.
//
// It has to exist at all because a syllabus that never states a class time is
// common — two of the six here — so "the app cannot know" must be a state the
// user can resolve rather than a dead end. CALENDAR-SPEC 4.4.
// ---------------------------------------------------------------------------

let CAL_CLASSES = null;   // last /api/calendar/classes response
let MEET_EDIT = null;     // folder whose editor is open
let calRebuildTimer = null;

async function loadCalClasses() {
  CAL_CLASSES = await apiJson('/api/calendar/classes');
  return CAL_CLASSES;
}

/** The bridge rebuilds the worklist behind a meeting-time change; poll for it. */
function pollCalRebuild(remaining) {
  clearTimeout(calRebuildTimer);
  if (remaining <= 0) return;
  calRebuildTimer = setTimeout(async () => {
    try {
      const st = await loadCalClasses();
      // NEVER repaint an open editor from a background tick: the repaint
      // rebuilds the form from CAL_CLASSES, so ticked days, typed times and a
      // typed room are discarded and focus is dropped mid-keystroke — once a
      // second for the whole poll window.
      if (!MEET_EDIT) renderMeetingTimes();
      if (st.rebuild?.running) return pollCalRebuild(remaining - 1);
      const { worklist } = await apiJson('/api/calendar');
      CAL_WORKLIST = worklist;
      renderCalendarOps();
    } catch { /* transient — the next full load catches up */ }
  }, 1000);
}

const MEET_DAYS = [['MO', 'M'], ['TU', 'Tu'], ['WE', 'W'], ['TH', 'Th'], ['FR', 'F'], ['SA', 'Sa'], ['SU', 'Su']];

/** The set/change + undo controls every meeting-time surface shares. */
function meetControlsHtml(c, open) {
  const mt = c.meeting_times || {};
  // "change" for any time already on record, whoever stated it — the editor
  // opens prefilled either way; "set times" only when there is nothing yet.
  const label = open ? 'cancel' : ((mt.source === 'override' || mt.has_time) ? 'change' : 'set times');
  const undo = !open && mt.revert?.available
    ? `<button type="button" class="linky meet-undo" data-meet-revert="${esc(c.folder)}">${esc(mt.revert.label || 'undo')}</button>`
    : '';
  return `<button type="button" class="linky" data-meet-edit="${esc(c.folder)}">${label}</button>${undo}`;
}

/** The meeting-times block for the class currently open, or '' when unknown. */
function meetingTimesHtml() {
  const folder = CURRENT?.folder;
  if (!folder) return '';
  const c = (CAL_CLASSES?.classes ?? []).find(x => x.folder === folder);
  if (!c) return '';
  const mt = c.meeting_times || {};
  const open = MEET_EDIT === folder;
  return `
    <section class="meet-block${mt.has_time ? '' : ' unset'}" id="meet-block">
      <h3>Meeting times</h3>
      <p class="meet-when">${esc(mt.summary || 'No class days or times found in the syllabus.')}</p>
      <div class="meet-controls">${meetControlsHtml(c, open)}</div>
      ${open ? meetEditor(c) : ''}
    </section>`;
}

/**
 * The calendar's class-times list: every class, its time, and the same editor
 * — because the calendar is where a missing or wrong time is NOTICED, and
 * noticing it must not mean going hunting for the class's Overview tab.
 * CALENDAR-SPEC 6.7.
 */
function renderCalMeetTimes() {
  const box = $('cal-meettimes');
  if (!box) return;
  const classes = CAL_CLASSES?.classes ?? [];
  box.classList.toggle('hidden', !classes.length);
  if (!classes.length) return;
  const unset = classes.filter(c => !c.meeting_times?.has_time).length;
  $('cal-meettimes-summary').textContent = unset ? `Class times · ${unset} not set` : 'Class times';
  $('cal-meettimes-body').innerHTML = classes.map(c => {
    const mt = c.meeting_times || {};
    const open = MEET_EDIT === c.folder;
    return `
      <div class="meet-row${mt.has_time ? '' : ' unset'}">
        <div class="meet-row-head">
          <span class="meet-name">${esc(c.course_code || c.name)}</span>
          <span class="meet-when">${esc(mt.summary || 'No class days or times found.')}</span>
          ${meetControlsHtml(c, open)}
        </div>
        ${open ? meetEditor(c) : ''}
      </div>`;
  }).join('');
}

function meetEditor(c) {
  const p = (c.meeting_times?.patterns || [])[0] || {};
  const days = p.byday || [];
  return `
    <form class="meet-editor" data-meet-form="${esc(c.folder)}">
      <div class="meet-days">
        ${MEET_DAYS.map(([code, label]) => `
          <label class="meet-day${days.includes(code) ? ' on' : ''}">
            <input type="checkbox" name="day" value="${code}"${days.includes(code) ? ' checked' : ''} />
            <span>${label}</span>
          </label>`).join('')}
      </div>
      <div class="meet-fields">
        <label>Starts <input type="time" name="start" value="${esc(p.start || '')}" /></label>
        <label>Ends <input type="time" name="end" value="${esc(p.end || '')}" /></label>
        <label class="meet-room">Room <input type="text" name="location" value="${esc(p.location || '')}" placeholder="optional" /></label>
      </div>
      <div class="meet-actions">
        <button type="submit" class="primary">Save</button>
        ${c.meeting_times?.source === 'override'
          ? `<button type="button" class="linky" data-meet-clear="${esc(c.folder)}">Use the syllabus instead</button>`
          : ''}
        <span class="meet-error"></span>
      </div>
    </form>`;
}

/** Repaint every meeting-times surface, in place. */
function renderMeetingTimes() {
  const host = $('meet-host');
  if (host) host.innerHTML = meetingTimesHtml();
  renderCalMeetTimes();
}

async function saveMeetEditor(form, folder) {
  const days = [...form.querySelectorAll('input[name=day]:checked')].map(el => el.value);
  const start = form.querySelector('input[name=start]').value || null;
  const end = form.querySelector('input[name=end]').value || null;
  const location = form.querySelector('input[name=location]').value.trim() || null;
  const err = form.querySelector('.meet-error');

  if (!days.length) { err.textContent = 'Pick at least one day.'; return; }
  if (Boolean(start) !== Boolean(end)) { err.textContent = 'Set both a start and an end, or neither.'; return; }

  err.textContent = 'Saving…';
  // api() THROWS on a non-2xx, so a `!res.ok` branch after it can never run —
  // the old one left the editor reading "Saving…" forever while a toast said
  // "400 Bad Request" and the server's actual reason went nowhere.
  try {
    await api(`/api/class/${folder}/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days, start, end, location }),
    });
  } catch (e) {
    err.textContent = e.message || 'Could not save that.';
    return;
  }
  MEET_EDIT = null;
  await loadCalClasses();
  renderMeetingTimes();
  pollCalRebuild(8);
}

function wireMeetHost(host) {
  host.addEventListener('submit', (ev) => {
    const form = ev.target.closest('[data-meet-form]');
    if (!form) return;
    ev.preventDefault();
    saveMeetEditor(form, form.dataset.meetForm).catch(e => toast(e.message));
  });
  host.addEventListener('click', (ev) => {
    const edit = ev.target.closest('[data-meet-edit]');
    if (edit) {
      MEET_EDIT = MEET_EDIT === edit.dataset.meetEdit ? null : edit.dataset.meetEdit;
      renderMeetingTimes();
      return;
    }
    const clear = ev.target.closest('[data-meet-clear]');
    if (clear) {
      api(`/api/class/${clear.dataset.meetClear}/meetings`, { method: 'DELETE' })
        .then(() => { MEET_EDIT = null; return loadCalClasses(); })
        .then(() => { renderMeetingTimes(); pollCalRebuild(8); })
        .catch(e => toast(e.message));
      return;
    }
    const undo = ev.target.closest('[data-meet-revert]');
    if (undo) {
      // Disabled for the round-trip: a double-click would revert the revert.
      undo.disabled = true;
      api(`/api/class/${undo.dataset.meetRevert}/meetings/revert`, { method: 'POST' })
        .then(() => { MEET_EDIT = null; return loadCalClasses(); })
        .then(() => { renderMeetingTimes(); pollCalRebuild(8); })
        // Re-enable on failure, or the control sits there labelled and dead
        // until some unrelated repaint — and a 409 means the two disagree, so
        // refetch rather than leave a stale row on screen.
        .catch(e => {
          undo.disabled = false;
          toast(e.message);
          loadCalClasses().then(renderMeetingTimes).catch(() => {});
        });
    }
  });
}

function wireMeetingTimes() {
  // The same controls live in two places — the class's Overview tab and the
  // calendar's class-times list — and must behave identically in both.
  for (const id of ['meet-host', 'cal-meettimes']) {
    const host = $(id);
    if (host) wireMeetHost(host);
  }
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

async function loadLogs() {
  const { lines } = await apiJson('/api/logs?lines=300');
  $('log-lines').textContent = lines.length ? lines.join('\n') : 'No pipeline activity yet.';
  $('log-lines').scrollTop = $('log-lines').scrollHeight;
}

// ---------------------------------------------------------------------------
// Terminal AI subscription login
// ---------------------------------------------------------------------------

function renderAiCliStatus(data) {
  for (const provider of ['claude', 'codex']) {
    const st = data?.providers?.[provider];
    const node = $(`${provider}-cli-state`);
    if (!node) continue;
    node.textContent = !st?.installed ? 'Not installed'
      : st.authenticated ? 'Signed in — ready'
        : st.timedOut ? 'Status check timed out' : 'Installed — sign in needed';
    node.classList.toggle('cli-ready', !!st?.authenticated);
    const button = document.querySelector(`[data-ai-login="${provider}"]`);
    if (button) button.textContent = st?.authenticated ? 'Sign in again' : 'Open login terminal';
  }
}

async function loadAiCliStatus() {
  try {
    renderAiCliStatus(await apiJson('/api/ai-cli'));
  } catch {
    for (const id of ['claude-cli-state', 'codex-cli-state']) {
      if ($(id)) $(id).textContent = 'Could not check status';
    }
  }
}

function wireAiCli() {
  $('ai-cli-refresh').addEventListener('click', async () => {
    $('ai-cli-refresh').disabled = true;
    await loadAiCliStatus();
    $('ai-cli-refresh').disabled = false;
  });
  $('terminal-ai-card').addEventListener('click', async ev => {
    const button = ev.target.closest('[data-ai-login]');
    if (!button) return;
    button.disabled = true;
    $('ai-cli-msg').textContent = 'Opening Terminal…';
    try {
      const result = await apiJson('/api/ai-cli/login', {
        method: 'POST', body: JSON.stringify({ provider: button.dataset.aiLogin }),
      });
      $('ai-cli-msg').textContent = result.message || 'Complete sign-in in Terminal, then refresh status.';
    } catch (err) {
      $('ai-cli-msg').textContent = `Could not open login: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// What counts as "off" for a CSYNC_STAGE_* value — mirrored in
// scripts/_util.js stageEnabled(); the two must agree or the switch lies.
const STAGE_OFF_RE = /^(0|false|off|no)$/i;

async function loadSettings() {
  const { settings } = await apiJson('/api/settings');
  const env = settings?.env || {};
  $('set-backend').value = env.CSYNC_AI_BACKEND || '';
  $('set-claude-model').value = env.CSYNC_CLAUDE_MODEL || '';
  $('set-codex-model').value = env.CSYNC_CODEX_MODEL || '';
  $('set-local-model').value = env.CSYNC_LOCAL_MODEL || '';
  $('set-local-python').value = env.CSYNC_LOCAL_PYTHON || '';
  // Function switches. Absent = on: the toggles only ever WRITE "0", so a
  // settings.json from before they existed reads as everything enabled.
  document.querySelectorAll('[data-fn]').forEach((el) => {
    el.checked = !STAGE_OFF_RE.test(String(env[el.dataset.fn] ?? ''));
  });
  loadAiCliStatus();
  renderSubscriptions().catch(() => {});
}

// ---------------------------------------------------------------------------
// Calendar subscriptions.
//
// This is what replaced the Claude routine. Each row is a URL to paste into
// whatever calendar app the user already has — Apple Calendar, Google Calendar,
// Outlook, Thunderbird — which then refreshes itself on its own timer. No
// account, no OAuth grant, nothing to configure per person, which is the whole
// requirement: the app has to be givable to someone else.
// ---------------------------------------------------------------------------

async function renderSubscriptions() {
  const box = $('subs-list');
  if (!box) return;
  let data;
  try {
    data = await apiJson('/api/calendar/subscriptions');
  } catch (err) {
    box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    return;
  }
  box.innerHTML = (data.calendars ?? []).map(c => `
    <div class="sub-row">
      <span class="sub-name">${esc(c.name)}</span>
      <span class="sub-count">${c.events == null ? 'not built yet' : `${c.events} event${c.events === 1 ? '' : 's'}`}</span>
      <input class="sub-url" type="text" readonly value="${esc(c.url)}" aria-label="Subscription URL for ${esc(c.name)}" />
      <button type="button" class="linky" data-sub-copy="${esc(c.url)}">copy</button>
    </div>`).join('');
}

function wireSettings() {
  wireAiCli();

  // Copy, and select the field as well — a URL you can see selected is one you
  // can paste even when the clipboard API is unavailable.
  $('subs-list').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-sub-copy]');
    if (!btn) return;
    const field = btn.parentElement.querySelector('.sub-url');
    field?.select();
    try {
      await navigator.clipboard.writeText(btn.dataset.subCopy);
      btn.textContent = 'copied';
    } catch {
      btn.textContent = 'select and copy';
    }
    setTimeout(() => { btn.textContent = 'copy'; }, 1800);
  });
  $('log-refresh-btn').addEventListener('click', () => {
    $('log-refresh-btn').textContent = 'Refreshing…';
    loadLogs()
      .catch(err => toast(`Could not read the log: ${err.message}`))
      .finally(() => { $('log-refresh-btn').textContent = 'Refresh'; });
  });

  $('settings-save-btn').addEventListener('click', async () => {
    const env = {
      CSYNC_AI_BACKEND: $('set-backend').value,
      CSYNC_CLAUDE_MODEL: $('set-claude-model').value.trim(),
      CSYNC_CODEX_MODEL: $('set-codex-model').value.trim(),
      CSYNC_LOCAL_MODEL: $('set-local-model').value.trim(),
      CSYNC_LOCAL_PYTHON: $('set-local-python').value.trim(),
    };
    // On = delete the key (default), off = "0". The POST route treats '' as
    // delete, so an old settings.json converges instead of accreting "1"s.
    document.querySelectorAll('[data-fn]').forEach((el) => {
      env[el.dataset.fn] = el.checked ? '' : '0';
    });
    await apiJson('/api/settings', { method: 'POST', body: JSON.stringify({ env }) });
    $('settings-confirm').classList.remove('hidden');
    setTimeout(() => $('settings-confirm').classList.add('hidden'), 2500);
  });

  $('pair-btn').addEventListener('click', async () => {
    let resp;
    try {
      resp = await apiJson('/api/pair-token', { method: 'POST', body: '{}' });
    } catch (err) {
      // Only a 409 means "already paired" — anything else is a real failure
      // and must not be papered over with the force-re-pair confirm.
      if (!String(err.message).startsWith('409')) {
        $('pair-result').textContent = `Could not generate a token: ${err.message}. Check the bridge log.`;
        $('pair-result').classList.remove('hidden');
        return;
      }
      if (!confirm('An extension is already paired. Generate a new token anyway? The old extension will be disconnected.')) return;
      try {
        resp = await apiJson('/api/pair-token', { method: 'POST', body: JSON.stringify({ force: true }) });
      } catch (err2) {
        $('pair-result').textContent = `Could not generate a token: ${err2.message}. Check the bridge log.`;
        $('pair-result').classList.remove('hidden');
        return;
      }
    }
    $('pair-result').innerHTML =
      `Install token (valid 10 min): <strong>${esc(resp.token)}</strong><br/>` +
      `Paste it into the Canvas Sync extension popup → Connect.`;
    $('pair-result').classList.remove('hidden');
  });

  if (IS_APP) {
    $('bridge-restart-btn').addEventListener('click', () => window.canvasync.restartBridge());

    $('model-check-btn').addEventListener('click', async () => {
      $('model-status').textContent = 'Checking…';
      const r = await window.canvasync.checkLocalModel($('set-local-model').value.trim());
      $('model-status').textContent = r.present
        ? `Model present (${r.sizeGb ? r.sizeGb + ' GB' : 'in HF cache'})`
        // Name the python it actually looked for. "No MLX python found" made
        // the user guess which path was tried, when the IPC response has
        // carried the configured one all along (app/main.js:296 returns it
        // whether or not it exists). Same wording as the download path's
        // failure two handlers below, so the card does not describe one
        // problem two ways.
        : (r.pythonOk ? 'Model not downloaded yet.'
          : `No python at ${r.python || '(none configured)'} — set "Local python" in Settings `
            + `to your MLX venv's bin/python, or create that venv (see README).`);
      $('model-download-btn').classList.toggle('hidden', r.present || !r.pythonOk);
    });

    $('model-download-btn').addEventListener('click', async () => {
      $('model-status').textContent = 'Downloading (tens of GB — this can take a while)…';
      $('model-download-btn').disabled = true;
      const r = await window.canvasync.downloadLocalModel($('set-local-model').value.trim());
      $('model-status').textContent = r.ok ? 'Download complete.' : `Download failed: ${r.error}`;
      $('model-download-btn').disabled = false;
    });
  }
}

// ---------------------------------------------------------------------------
// Ask this class — the chat sidebar.
//
// The engine is scripts/class-chat.js behind POST /api/ask: correlation-graph
// retrieval, FACTS computed in code, one lock-guarded local-model pass,
// answers citing [S1]..[Sn]. This rail renders exactly what that returns and
// invents nothing — the model plumbing, the busy states and the "nothing
// found" sentinel all come from the server.
//
// The rail is a sidebar with two widths, not a panel behind a button: a
// labelled spine holds the page's right edge for as long as a class is open,
// and clicking it pops the panel out beside whatever tab is showing. It used
// to be an "Ask" button parked after the five tabs, which read as a sixth tab
// and was missed accordingly (2026-08-26).
//
// Transcripts live in memory per class folder and die with the page. The
// bridge answers one question at a time (409 otherwise), so a single global
// in-flight flag is the truth, not a simplification.
// ---------------------------------------------------------------------------

// Mirrors NO_ANSWER in scripts/class-chat.js. The one sentence the model may
// fall back to; rendered as a finding, not an answer bubble.
const CHAT_NO_ANSWER = "I don't have that in this class's material.";

const CHAT = { open: localStorage.getItem('chatOpen') === '1', logs: {}, inFlight: false, tick: null };

function chatEntries() {
  const key = CURRENT?.folder || '';
  return (CHAT.logs[key] ??= []);
}

/** A source of kind "file" that matches a file we can open in the app. */
function chatFileFor(s) {
  if (!CURRENT || s.kind !== 'file') return null;
  const names = [String(s.label || ''), String(s.nodeId || '').replace(/^file:/, '')]
    .map(n => n.toLowerCase()).filter(Boolean);
  return (CURRENT.files_index || []).find(f => {
    if (!f || f.duplicateOf) return false;
    return [f.displayName, f.filename, f.name].filter(Boolean)
      .some(n => names.includes(String(n).toLowerCase()));
  }) || null;
}

function chatSourceHtml(s, ei, si) {
  const file = chatFileFor(s);
  const open = file
    ? `<button type="button" class="linky" data-chat-src="${ei}:${si}">open</button>`
    : (s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Canvas</a>` : '');
  return `<div class="chat-src">`
    + (s.tag ? `<span class="s-tag">[${esc(s.tag)}]</span>` : '')
    + `<span class="s-label" title="${esc(s.label)}">${esc(s.label)}</span>`
    + (s.truncated ? '<span>partial</span>' : '')
    + open
    + `</div>`;
}

function chatEntryHtml(e, ei) {
  let html = `<div class="chat-q">${esc(e.q)}</div>`;
  if (e.pending) {
    const secs = Math.round((Date.now() - e.started) / 1000);
    // Two honest stages: retrieval is sub-second, so past a beat the time is
    // all generation — and on the local model that is minutes, not a hang.
    html += `<p class="chat-note">${secs < 15
      ? 'Reading this class’s sources…'
      : `Generating — the local model can take a couple of minutes (${secs}s)…`}</p>`;
    return html;
  }
  if (e.err) { html += `<p class="chat-note err">${esc(e.err)}</p>`; return html; }
  const none = e.a === CHAT_NO_ANSWER;
  html += `<div class="chat-a${none ? ' none' : ''}">${esc(e.a).replace(/\[(S\d+)\]/g, '<b>[$1]</b>')}</div>`;
  (e.warnings || []).forEach(w => { html += `<p class="chat-note">${esc(w)}</p>`; });
  if (e.sources?.length) {
    html += `<div class="chat-sources">${e.sources.map((s, si) => chatSourceHtml(s, ei, si)).join('')}</div>`;
  }
  return html;
}

// Where the rail belongs: a class is open AND the pane is showing one of its
// pages. Not the class home (there is no class to ask about) and not the
// picker or cleanup panels (those are settings, not a class). Driving the rail
// off this rather than off CURRENT alone is what keeps the spine from
// advertising a panel that would open onto nothing.
const CHAT_PANELS = ['detail', 'assignment-panel', 'file-panel'];
function chatAvailable() {
  return !!CURRENT && CHAT_PANELS.some(p => !$(p).classList.contains('hidden'));
}

function renderChat() {
  // CHAT.open is what the user last asked for; `open` is what that means here
  // and now. Remembering the request while the rail is away means it comes
  // back open on the next class page instead of needing a second click.
  const avail = chatAvailable();
  const open = avail && CHAT.open;
  $('view-classes').classList.toggle('chat-avail', avail);
  $('view-classes').classList.toggle('chat-open', open);
  $('chat-rail').classList.toggle('hidden', !avail);
  $('chat-rail').classList.toggle('open', open);
  $('chat-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  $('chat-toggle').title = open ? 'Collapse' : 'Ask about this class';
  if (!open) return;
  $('chat-class').textContent = $('detail-title').textContent || CURRENT.folder;
  $('chat-input').disabled = CHAT.inFlight;
  $('chat-send').disabled = CHAT.inFlight;
  const log = $('chat-log');
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = chatEntries().map((e, i) => chatEntryHtml(e, i)).join('');
  if (stick) log.scrollTop = log.scrollHeight;
}

async function askChat(question) {
  if (!CURRENT || CHAT.inFlight) return;
  const entry = { q: question, pending: true, started: Date.now() };
  const folder = CURRENT.folder;
  (CHAT.logs[folder] ??= []).push(entry);
  CHAT.inFlight = true;
  renderChat();
  // Keep the elapsed count honest while the model works.
  CHAT.tick = setInterval(renderChat, 5000);

  try {
    const history = (CHAT.logs[folder] || [])
      .filter(x => x.a && x.a !== CHAT_NO_ANSWER && !x.err)
      .slice(-3).map(x => ({ q: x.q, a: x.a }));
    // Raw fetch rather than apiJson: the error BODY carries the reason (model
    // busy, question refused) and apiJson throws it away.
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'X-Bridge-Secret': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, folderName: folder, history }),
    });
    const body = await res.json().catch(() => ({}));
    entry.pending = false;
    if (!res.ok) {
      entry.err = res.status === 409
        ? 'Still answering the last question — one at a time.'
        : res.status === 503
          ? (body.detail || 'The local model is busy with a sync job — ask again when it finishes.')
          : `Could not ask: ${body.error || res.status}${body.detail ? ` — ${body.detail}` : ''}`;
    } else {
      entry.a = String(body.answer ?? CHAT_NO_ANSWER);
      entry.sources = body.sources || [];
      entry.warnings = body.warnings || [];
    }
  } catch (err) {
    entry.pending = false;
    entry.err = `Could not ask: ${err.message}`;
  } finally {
    CHAT.inFlight = false;
    clearInterval(CHAT.tick);
    renderChat();
  }
}

function wireChat() {
  // One control, both directions: the spine opens the panel and the spine
  // closes it. A second "close" link inside the header put two targets a
  // centimetre apart doing the same job.
  $('chat-toggle').addEventListener('click', () => {
    CHAT.open = !CHAT.open;
    localStorage.setItem('chatOpen', CHAT.open ? '1' : '0');
    renderChat();
    if (CHAT.open) $('chat-input').focus();
  });
  $('chat-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = $('chat-input').value.trim();
    if (!q) return;
    $('chat-input').value = '';
    askChat(q);
  });
  // Source rows: open the cited file in the in-app viewer.
  $('chat-log').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-chat-src]');
    if (!btn) return;
    const [ei, si] = btn.dataset.chatSrc.split(':').map(Number);
    const src = chatEntries()[ei]?.sources?.[si];
    const file = src && chatFileFor(src);
    if (file) openFile(CURRENT.folder, file, 'detail');
  });
}

wireChat();
// Paint once before boot(): with no class open yet this only hides the rail,
// but it is what puts .chat-avail off the grid so the first frame is not a
// 44px column of nothing.
renderChat();

boot();
