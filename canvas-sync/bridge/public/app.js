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
} from './cal-grid.js';
import { nextSelection, isSelected } from './cal-plan.js';

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
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}
const apiJson = (p, o) => api(p, o).then(r => r.json());

// Switching views by clicking the real button keeps wireNav's bookkeeping —
// active class, lazy loads — in one place instead of two.
function navTo(view) {
  const btn = document.querySelector(`.nav-btn[data-view="${view}"]`);
  if (btn && !btn.classList.contains('active')) btn.click();
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

// ---------------------------------------------------------------------------
// Tiny markdown renderer (headings, bold/italic, code, lists, tables, links, hr)
// ---------------------------------------------------------------------------

function esc(s) {
  // Escapes the full set, including both quote characters. The quotes matter:
  // inlineMd drops URLs into href="…", so an unescaped " in a synced Canvas
  // link (e.g. [x](https://evil"onmouseover="…)) would break out of the
  // attribute. Every innerHTML sink in this file routes through esc().
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderMd(md) {
  // An HTML comment in the source is a note to whoever edits the file, not to
  // whoever reads it. ROUTINE.md opens with six lines of one ("Source of truth:
  // …, do NOT edit the data-root copy"), and because every line here is escaped
  // before it is emitted, all six were printed on the calendar page verbatim,
  // angle brackets and all.
  const lines = String(md || '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out = [];
  let inList = false, inTable = false;
  const closeAll = () => {
    if (inList) { out.push('</ul>'); inList = false; }
    if (inTable) { out.push('</table>'); inTable = false; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (/^#{1,4}\s/.test(line)) {
      closeAll();
      const level = line.match(/^#+/)[0].length;
      out.push(`<h${level}>${inlineMd(line.replace(/^#+\s*/, ''))}</h${level}>`);
    } else if (/^---+$/.test(line)) {
      closeAll(); out.push('<hr/>');
    } else if (/^\|/.test(line)) {
      if (/^\|[\s|:-]+\|$/.test(line)) continue; // separator row
      if (!inTable) { closeAll(); out.push('<table>'); inTable = true; }
      // A row directly above a separator row is the header — emit <th> so
      // markdown tables get the mono/uppercase header treatment.
      const isHeader = /^\|[\s|:-]+\|$/.test((lines[i + 1] || '').trimEnd());
      const tag = isHeader ? 'th' : 'td';
      const cells = line.split('|').slice(1, -1).map(c => inlineMd(c.trim()));
      out.push('<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>');
    } else if (/^[-*]\s/.test(line)) {
      if (inTable) { out.push('</table>'); inTable = false; }
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inlineMd(line.replace(/^[-*]\s/, ''))}</li>`);
    } else if (line === '') {
      closeAll();
    } else {
      closeAll(); out.push(`<p>${inlineMd(line)}</p>`);
    }
  }
  closeAll();
  return out.join('\n');
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
  $('bridge-info').textContent = `Bridge v${status.version} · data root ${status.home} · ${status.paired ? 'extension paired' : 'no extension paired yet'}`;
  loadClasses();
  wireNav();
  wireSettings();
  renderPipelineButton(status.pipeline);
  setInterval(async () => {
    try {
      const st = await apiJson('/api/status');
      $('bridge-dot').classList.add('ok');
      renderPipelineButton(st.pipeline);
    } catch { $('bridge-dot').classList.remove('ok'); }
  }, 10000);
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
    btn.title = 'Re-run parse/extract/mine/context over synced data';
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function wireNav() {
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
    if (_pipelineRunning) {
      btn.textContent = 'Cancelling…';
      try { await apiJson('/api/pipeline/cancel', { method: 'POST', body: '{}' }); } catch {}
    } else {
      btn.textContent = 'Starting…';
      try { await apiJson('/api/pipeline/run', { method: 'POST', body: '{}' }); } catch {}
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
    const btn = ev.target.closest('[data-kind-filter]');
    if (!btn) return;
    CAL_KIND_SEL = nextSelection(CAL_KIND_SEL, calKindList(), btn.dataset.kindFilter);
    localStorage.setItem('calKinds', JSON.stringify(CAL_KIND_SEL));
    renderCalendarOps();
  });

  // The three interfaces. CALENDAR-SPEC 1.1-1.2. Switching never touches the
  // kind filter or the class chips: a user who has hidden four classes and
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

  // Bring finished work back so it can be un-finished. CALENDAR-SPEC 2.5.
  $('cal-showdone').addEventListener('click', () => {
    CAL_SHOW_DONE = !CAL_SHOW_DONE;
    localStorage.setItem('calShowDone', CAL_SHOW_DONE ? '1' : '0');
    renderCalendarOps();
  });

  // Class chips: the swatch opens the colour picker, the name toggles the
  // class. Two buttons rather than one, because a colour control nested inside
  // a toggle button is invalid markup and unreachable by keyboard.
  $('cal-classes').addEventListener('click', (ev) => {
    const showAll = ev.target.closest('[data-cal-show-all]');
    if (showAll) { setHiddenClasses(new Set()); renderCalendarOps(); return; }

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
    const slug = chip.dataset.calClassToggle;
    const hidden = hiddenClasses();
    if (hidden.has(slug)) hidden.delete(slug); else hidden.add(slug);
    setHiddenClasses(hidden);
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
    const key = calDoneKey(folder, id, cpId);
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
    const tail = CAL_POST_QUEUE.get(key) ?? Promise.resolve();
    const run = tail.then(async () => {
      const intent = CAL_DONE_PENDING.get(key);
      if (intent === undefined) return; // a seed already reconciled this key
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
      }
    });
    CAL_POST_QUEUE.set(key, run);
  });

  // A month tile that holds more than it can show. CALENDAR-SPEC 3.8.
  $('cal-ops').addEventListener('click', (ev) => {
    const more = ev.target.closest('[data-cal-expand]');
    if (!more) return;
    const iso = more.dataset.calExpand;
    if (CAL_EXPANDED.has(iso)) CAL_EXPANDED.delete(iso); else CAL_EXPANDED.add(iso);
    renderCalendarOps();
  });

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
    return `<li class="hu-row" data-folder="${esc(cls?.folder ?? '')}"
             style="--class-color:${classColor(o.class)}">
        <span class="hu-day">${esc(day)}</span>
        ${dueRelHtml(daysUntil(o.date), 'hu-rel')}
        <span class="hu-title">${esc(o.title)}</span>
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
      .then(({ worklist }) => { CAL_WORKLIST = worklist; seedCalDone(); renderHome(); })
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

async function openCleanup() {
  showClassesPanel('cleanup-panel');
  $('cleanup-result').textContent = '';
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
  await openCleanup();
}

// --- One assignment, read locally ------------------------------------------
// Canvas HTML arrives as-is. It is the user's own course content, but it is
// still third-party markup being injected into a page that holds the bridge
// secret, so scripts, embeds and event handlers come out before it renders.
function sanitizeCanvasHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, link, meta').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach((n) => {
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) n.removeAttribute(attr.name);
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) {
        n.removeAttribute(attr.name);
      }
    }
    if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
  });
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

  const parts = [];
  // Say what this IS before anything else: an AI-added item has no Canvas row,
  // so there is no submit box to hunt for. Strictly the server's word — a
  // bridge that predates the origin field also predates the claim-following
  // lookup, so its `canvas_id` is null for merged items too and inferring from
  // it would pin this notice on real Canvas work.
  const aiAdded = a.origin === 'syllabus';
  if (aiAdded) {
    parts.push('<div class="notice ai-added">Added by AI from the syllabus — not a Canvas assignment. There is nothing to submit on Canvas.</div>');
  }
  if (a.locked_for_user) {
    parts.push(`<div class="notice">Locked on Canvas${a.lock_explanation ? ` — ${esc(a.lock_explanation)}` : ''}</div>`);
  }
  if (a.description_html) {
    parts.push(`<div class="md-body assignment-desc">${sanitizeCanvasHtml(a.description_html)}</div>`);
  } else if (!aiAdded) {
    parts.push('<p class="muted">Canvas has no description for this assignment.</p>');
  }

  if (a.mined?.description) {
    parts.push(`<h3>What this is</h3><p>${esc(a.mined.description)}</p>`);
  }
  const mats = a.mined?.related_materials || [];
  if (mats.length) {
    parts.push(`<h3>Most relevant materials</h3><ul>${mats.slice(0, 6)
      .map(m => `<li>${esc(m.file)}${m.why ? ` — ${esc(m.why)}` : ''}</li>`).join('')}</ul>`);
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
}

// ---------------------------------------------------------------------------
// In-app file viewer
//
// A class file was previously a blob URL in a new tab, which for the two file
// types this app actually holds — PDF slides and PPTX decks — meant leaving
// the app to look at something the app had already read. So: read it here.
//
// Same back-button panel pattern as the assignment page above. Text, markdown
// and images render as themselves; anything the browser cannot show is served
// as the extracted text under materials/, labelled honestly as extracted text
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

function fileUrl(folder, rel) {
  return `/api/class/${folder}/file?p=${encodeURIComponent(rel)}`;
}

async function openFile(folder, file, from = 'detail') {
  FILE_VIEW = { folder, file };
  FILE_RETURN = from;
  navTo('classes');
  showClassesPanel('file-panel');
  await renderFileView();
}

async function renderFileView() {
  const { folder, file } = FILE_VIEW;
  const name = file.displayName || file.filename || file.name || 'Untitled';
  const ext = extOf(file.localPath || name);
  $('file-title').textContent = name;

  const bits = [];
  if (file.size) bits.push(fmtBytes(file.size));
  if (file.pageCount) bits.push(`${file.pageCount} page${file.pageCount === 1 ? '' : 's'}`);
  if (file.slideCount) bits.push(`${file.slideCount} slide${file.slideCount === 1 ? '' : 's'}`);
  if (file.canvasUpdatedAt) bits.push(`updated ${file.canvasUpdatedAt.slice(0, 10)}`);
  $('file-sub').textContent = bits.join('  ·  ');

  $('file-reveal').classList.toggle('hidden', !(IS_APP && file.localPath));
  const body = $('file-body');
  body.innerHTML = '<p class="muted">Reading…</p>';

  try {
    if (IMAGE_EXT.has(ext)) {
      const blob = await (await api(fileUrl(folder, file.localPath))).blob();
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
      body.innerHTML = (ext === '.md' || ext === '.markdown')
        ? `<div class="md-body file-md">${renderMd(text)}</div>`
        : `<div class="file-text">${esc(text)}</div>`;
      return;
    }

    // Everything else — PDF, PPTX, DOCX — is shown as its extracted text.
    const rel = materialsPathFor(file);
    if (!rel) throw new Error('no extractable path');
    const text = await (await api(fileUrl(folder, rel))).text();
    const label = ext === '.pdf' ? 'PDF' : ext === '.pptx' ? 'slide deck' : ext.replace('.', '').toUpperCase() || 'file';
    body.innerHTML =
      `<div class="notice">Text extracted from the ${esc(label)} — no layout, images or formatting.</div>
       <div class="file-text">${esc(text)}</div>`;
  } catch (err) {
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
    if (FILE_RETURN === 'assignment' && ASSIGNMENT) { showClassesPanel('assignment-panel'); return; }
    showClassesPanel(CURRENT ? 'detail' : 'class-home');
  });

  $('file-open').addEventListener('click', async () => {
    const { folder, file } = FILE_VIEW || {};
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
  CURRENT = data;
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
  renderGrades();
  $('overview-md').innerHTML = CURRENT.context_md
    ? renderMd(CURRENT.context_md)
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
  if (!end) return a;
  const b = fmtTime12(end);
  if (!a || !b) return a || b;
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

function renderTasks() {
  const el = $('tab-tasks');
  const items = CURRENT.mined?.items || [];
  if (!items.length) {
    el.innerHTML = '<p class="muted">Nothing to do here yet — Canvas lists no dated assignments for this class, '
      + 'and nothing has been found in its files. Run Rebuild summaries to search the slides and syllabus.</p>';
    return;
  }
  // Canvas-only means nobody has read this class's files yet, so the list is
  // whatever Canvas happens to publish. Say so — a short list reads as "not
  // much due" when it actually means "not looked at properly".
  const banner = CURRENT.mined?.source === 'canvas'
    ? '<p class="muted task-source-note">Straight from Canvas — the slides and syllabus have not been read yet.</p>'
    : '';
  const today = localTodayIso();
  const groups = { Upcoming: [], Recurring: [], 'No date found': [], Done: [], Past: [] };
  for (const it of items) {
    const eff = effectiveDue(it);
    // Done is its own bucket rather than a strikethrough in place: a finished
    // assignment is not "upcoming", and leaving it in the upcoming count made
    // the number useless as a measure of what is left.
    if (taskState(it.id).done) groups.Done.push(it);
    else if (it.recurring) groups.Recurring.push(it);
    else if (!eff.date) groups['No date found'].push(it);
    else if (eff.date >= today) groups.Upcoming.push(it);
    else groups.Past.push(it);
  }
  const dateOf = (it) => effectiveDue(it).date ?? '';
  groups.Upcoming.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
  groups.Past.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));

  const html = [banner];
  for (const [label, group] of Object.entries(groups)) {
    if (!group.length) continue;
    html.push(`<div class="task-group-title">${label} (${group.length})</div>`);
    for (const it of group) {
      const st = taskState(it.id);
      const eff = effectiveDue(it);
      const due = fmtDue(it, eff);
      const mats = (it.related_materials || []).slice(0, 4)
        .map(m => `<li>${esc(m.file)}${m.why ? ` \u2014 ${esc(m.why)}` : ''}</li>`).join('');
      const cps = st.checkpoints ?? [];
      const cpsDone = cps.filter(c => c.done).length;
      // AI-added: mined from the syllabus, no Canvas row behind it. `origin`
      // is the authoritative field; `kind` covers a mined file written before
      // origin existed.
      const aiAdded = it.origin ? it.origin === 'syllabus' : it.kind === 'implicit';
      const classes = ['task'];
      if (aiAdded) classes.push('ai-added');
      if (st.done) classes.push('is-done');
      if (st.flag) classes.push(`flag-${esc(st.flag)}`);
      html.push(`
        <div class="${classes.join(' ')}" data-task="${esc(it.id)}">
          <div class="task-top">
            <input type="checkbox" class="task-check" data-done${st.done ? ' checked' : ''}
                   aria-label="Mark ${esc(it.title)} complete">
            <button type="button" class="task-title linky-title" data-open-assignment="${esc(it.canvas_assignment_id ?? it.id)}">${esc(it.title)}</button>
            <span class="task-due">${due}</span>
          </div>
          <div class="task-badges">
            <span class="badge">${esc(it.category || 'other')}</span>
            ${aiAdded ? '<span class="badge ai-added" title="Added by AI from the syllabus \u2014 not a Canvas assignment, nothing to submit on Canvas">AI-added \u00b7 not on Canvas</span>' : ''}
            ${it.points_possible != null ? `<span class="badge">${esc(it.points_possible)} pts</span>` : ''}
            ${it.due_confidence && it.due_confidence !== 'high' ? `<span class="badge implicit">${esc(it.due_confidence)} confidence date</span>` : ''}
            ${eff.moved ? '<span class="badge moved">moved</span>' : ''}
            ${cps.length ? `<span class="badge">${cpsDone}/${cps.length} checkpoints</span>` : ''}
            ${st.note ? '<span class="badge">note</span>' : ''}
          </div>
          ${it.description ? `<div class="task-desc">${esc(it.description)}</div>` : ''}
          ${mats ? `<div class="task-materials">Most relevant materials:<ul>${mats}</ul></div>` : ''}
          <button type="button" class="linky task-toggle" data-toggle>Edit</button>
          <div class="task-editor-slot hidden"></div>
        </div>`);
    }
  }
  el.innerHTML = html.join('');
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
    const id = idOf(el);
    if (!id) return;
    const task = taskEl(el);

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
    const id = idOf(el);
    if (!id || !el.matches('[data-note]')) return;
    clearTimeout(noteTimers.get(id));
    noteTimers.set(id, setTimeout(() => {
      patchTaskState(id, { note: el.value }).catch(() => {});
    }, 600));
  });
}

// Files are grouped by where on Canvas they were found — the module, the
// assignment, the page. The bridge derives that from the course JSON and hands
// each entry an `origins` array; the first entry is the best one to file under.
let FILE_SORT = localStorage.getItem('fileSort') || 'source';

function fileName(f) { return f.displayName || f.filename || 'Untitled'; }

function primaryOrigin(f) {
  return (f.origins && f.origins[0]) || { kind: 'files-tab', label: 'Files tab', group: 'files-tab' };
}

function originHeading(o) {
  return o.kind === 'module' ? `Module · ${o.label}` : o.label;
}

// The row's own sub-label: which module item / assignment / page it sat in.
function originDetail(f) {
  const o = primaryOrigin(f);
  const extra = (f.origins || []).length - 1;
  const bits = [];
  if (o.itemLabel && o.itemLabel !== o.label) bits.push(o.itemLabel);
  if (extra > 0) bits.push(`+${extra} more place${extra > 1 ? 's' : ''}`);
  return bits.join(' · ');
}

function groupFilesBySource(files) {
  const groups = new Map();
  for (const f of files) {
    const o = primaryOrigin(f);
    const key = o.group || o.kind;
    if (!groups.has(key)) groups.set(key, { heading: originHeading(o), sort: o.sort ?? 999, files: [] });
    groups.get(key).files.push(f);
  }
  const out = [...groups.values()];
  out.sort((a, b) => a.sort - b.sort || a.heading.localeCompare(b.heading));
  for (const g of out) {
    g.files.sort((a, b) =>
      (primaryOrigin(a).itemSort ?? 1e9) - (primaryOrigin(b).itemSort ?? 1e9)
      || fileName(a).localeCompare(fileName(b)));
  }
  return out;
}

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
    el.innerHTML = '<p class="muted">No files downloaded for this class.</p>';
    return;
  }

  const toolbar = `<div class="files-toolbar">
    <span class="muted">${files.length} file${files.length > 1 ? 's' : ''}</span>
    <div class="seg seg-sm" role="group" aria-label="Sort files">
      ${[['source', 'Source'], ['name', 'Name'], ['date', 'Newest']].map(([k, lbl]) =>
        `<button type="button" class="seg-btn${FILE_SORT === k ? ' active' : ''}" data-fsort="${k}">${lbl}</button>`,
      ).join('')}
    </div>
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
  if (FILE_SORT === 'source') {
    body = groupFilesBySource(files).map(g => `
      <div class="file-group">
        <h4 class="file-group-head">${esc(g.heading)} <span class="muted">${g.files.length}</span></h4>
        <table class="files">${head}${g.files.map(row).join('')}</table>
      </div>`).join('');
  } else {
    const sorted = files.slice().sort(FILE_SORT === 'name'
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

// Which of the three interfaces is showing: the stacked list, the seven-column
// week, or the tiled month. CALENDAR-SPEC 1.1-1.2.
// The prompt the Copy button puts on the clipboard. Set once the calendar
// loads and the real data-root path is known.

const CAL_VIEWS = ['list', 'week', 'month'];
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

// Classes the user has hidden. Stored by slug, so hiding survives a reload but
// a class that disappears from the worklist does not linger as a stale filter.
function hiddenClasses() {
  try { return new Set(JSON.parse(localStorage.getItem('calHidden') || '[]')); }
  catch { return new Set(); }
}
function setHiddenClasses(set) {
  localStorage.setItem('calHidden', JSON.stringify([...set]));
}

function calDisplayName(slug) {
  const hit = (CLASSES || []).find(c => c.folder === slug || c.slug === slug);
  if (hit && hit.code) return hit.code;
  return slug.replace(/-/g, ' ').toUpperCase();
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
  const m = /^Points:\s*([\d.]+)/m.exec(description || '');
  return m ? m[1] : null;
}

function calUrl(description) {
  const m = /(https?:\/\/\S+)/.exec(description || '');
  return m ? m[1] : null;
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
  const folder = calFolder(op.class);
  const id = op.item_id ?? null;
  // A prep block belongs to an item but is not the item. Ticking one has to
  // name the block, so a checkpoint with no id of its own is NOT checkable —
  // the alternative is a checkbox that quietly marks the whole assignment done.
  const cpId = op.checkpoint_id ?? null;
  const checkable = !isMeeting && !!folder && id != null && (!isCheckpoint || !!cpId);
  // Anything ticked off can be clicked into: a deadline opens its own page,
  // and a prep block opens the assignment it preps for — same id, same panel.
  // CALENDAR-SPEC 2.12.
  const openable = checkable;
  const url = op.url || calUrl(op.description);
  const submitUrl = op.submit_url || null;
  const noLink = op.calendar === 'due' && !url && !submitUrl;
  // AI-added: mined out of the syllabus with no Canvas row behind it, so there
  // is nothing to submit. `origin` is authoritative once the worklist carries
  // it; a worklist built before the field falls back to "no link anywhere",
  // which is true of exactly the same rows. CALENDAR-SPEC 2.13.
  const aiAdded = op.calendar === 'due' && (op.origin ? op.origin === 'syllabus' : noLink);
  const key = calDoneKey(folder, id, cpId);
  const done = checkable && CAL_DONE.has(key);
  return { isMeeting, isCheckpoint, folder, id, cpId, key, checkable, openable, url, submitUrl, noLink, aiAdded, done };
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
  return `<input type="checkbox" class="cal-check" data-cal-done="${esc(m.id)}"`
    + ` data-cal-class="${esc(m.folder)}"${m.cpId ? ` data-cal-cp="${esc(m.cpId)}"` : ''}`
    + `${m.done ? ' checked' : ''}`
    + ` aria-label="Mark ${esc(title)} done" />`;
}

/** The title: an in-app button, a Canvas link, or plain text. Never a dead link. */
function calTitleHtml(op, m, title) {
  if (m.openable) {
    return `<button type="button" class="linky-title" data-open-assignment="${esc(m.id)}"`
      + ` data-assignment-class="${esc(m.folder)}">${esc(title)}</button>`;
  }
  if (!m.isMeeting && m.url) {
    return `<a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>`;
  }
  return esc(title);
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
  if (m.aiAdded) {
    return `<span class="cal-nolink ai" title="Added by AI from the syllabus — not a Canvas assignment, nothing to submit on Canvas">${dense ? '&mdash;' : 'AI-added'}</span>`;
  }
  if (m.noLink) {
    return `<span class="cal-nolink" title="Canvas has no page for it">${dense ? '&mdash;' : 'no link'}</span>`;
  }
  return '';
}

function calOpRow(op, { showClass = false } = {}) {
  const m = calItemModel(op);
  // A past lecture is history, not a missed deadline — no overdue red.
  const overdue = !m.isMeeting && !m.done && daysUntil(op.date) < 0;
  const when = op.all_day ? 'All day' : op.time ? fmtTimeSpan(op.time, op.end_time) : '—';
  const title = showClass ? op.title : stripClassPrefix(op.title, op.class || '');
  const pts = calPoints(op.description);
  return `
    <div class="cal-row${overdue ? ' overdue' : ''}${m.isMeeting ? ' meeting' : ''}${m.done ? ' is-done' : ''}${m.aiAdded ? ' ai-added' : ''}"
         data-class-slug="${esc(op.class || '')}"
         style="--class-color:${classColor(op.class)}">
      ${calCheckHtml(op, m, title)}
      <span class="cal-when">${esc(when)}</span>
      <span class="cal-title">${calTitleHtml(op, m, title)}</span>
      <span class="cal-tags">
        ${op.location ? `<span class="cal-loc">${esc(op.location)}</span>` : ''}
        ${op.recurrence ? `<span class="cal-loc">weekly ${esc(op.recurrence.byday.join(''))}</span>` : ''}
        ${!m.isMeeting && op.category && op.category !== 'other' ? `<span class="cal-cat ${esc(op.category)}">${esc(op.category)}</span>` : ''}
        ${pts ? `<span class="cal-pts">${esc(pts)} pts</span>` : ''}
        ${op.calendar === 'checkpoint' ? '<span class="cal-kind checkpoint">checkpoint</span>' : ''}
        ${calSubmitHtml(m)}
      </span>
    </div>`;
}

/**
 * The compact form, for a column in Week view or a tile in Month view. Same
 * controls as a list row — the spec is explicit that task control holds in all
 * three interfaces — just short of the tags, which do not survive a 170px
 * column and are one click away in the list.
 */
function calChip(op) {
  const m = calItemModel(op);
  const overdue = !m.isMeeting && !m.done && daysUntil(op.date) < 0;
  const title = stripClassPrefix(op.title, op.class || '');
  const when = op.all_day || !op.time ? '' : fmtTimeChip(op.time);
  return `
    <div class="cal-chip${overdue ? ' overdue' : ''}${m.isMeeting ? ' meeting' : ''}${m.done ? ' is-done' : ''}${m.aiAdded ? ' ai-added' : ''}"
         data-class-slug="${esc(op.class || '')}"
         style="--class-color:${classColor(op.class)}"
         title="${esc(calDisplayName(op.class))} — ${esc(op.title)}">
      ${calCheckHtml(op, m, title)}
      ${when ? `<span class="chip-when">${esc(when)}</span>` : ''}
      <span class="chip-title">${calTitleHtml(op, m, title)}</span>
      ${calSubmitHtml(m, { dense: true })}
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
          ${dayOps.length ? dayOps.map(calChip).join('') : '<p class="daycol-empty">—</p>'}
        </div>
      </section>`;
  }).join('');
  // The grid scrolls inside its own box rather than pushing the page wide. A
  // week is seven columns by definition — collapsing it to one on a phone
  // would just be the list again — so on a narrow screen you swipe it.
  return `<div class="cal-gridwrap"><div class="cal-week" id="cal-week">${cols}</div></div>`;
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
        <div class="tile-body">${shown.map(calChip).join('')}</div>
        ${hidden > 0
          ? `<button type="button" class="tile-more" data-cal-expand="${esc(d.iso)}">+${hidden} more</button>`
          : open && dayOps.length > MONTH_TILE_MAX
            ? `<button type="button" class="tile-more" data-cal-expand="${esc(d.iso)}">show less</button>`
            : ''}
      </div>`;
  }).join('');
  return `<div class="cal-gridwrap"><div class="cal-monthgrid" id="cal-month">${heads}${tiles}</div></div>`;
}

/**
 * The period navigator: `‹ prev`, `Today`, `next ›` and the heading naming what
 * is on screen. Only the grids have a period; the list is the whole window.
 */
function renderCalPeriod() {
  const box = $('cal-period');
  if (CAL_VIEW === 'list') { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
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
  if (kinds.length < 2) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const counts = {};
  for (const o of all) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  box.innerHTML = kinds.map((k) => {
    const on = isSelected(CAL_KIND_SEL, k);
    const n = counts[k] ?? 0;
    return `<button type="button" class="filter-chip${on ? ' on' : ''}${n ? '' : ' empty'}"
      data-kind-filter="${esc(k)}" aria-pressed="${on ? 'true' : 'false'}">${esc(calKindLabel(k))}<span class="chip-count">${n}</span></button>`;
  }).join('');
}

/**
 * Why a kind or a class has nothing on the calendar.
 *
 * An empty Readings filter and a class with no meetings both used to look
 * exactly like a sync that had failed: zero rows and no explanation. BUSI 396
 * shows 0 meetings because its four "schedule" rows are module date ranges
 * rather than class sessions, `reading` is 0 ops because the miner is told to
 * collapse recurring readings into one undated item, and ENTR 222 holds office
 * hours by appointment only. All three are correct behaviour and all three are
 * invisible without this. CALENDAR-SPEC 4.5, 4.6.
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
  const hidden = hiddenClasses();
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
      if (hidden.has(slug) || !text) continue;
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
  const known = new Set(fromClasses.map(r => r.slug));
  // A slug the worklist mentions but the class list does not: the bridge
  // resolves colours by walking class folders, so it has no colour to return
  // and no override it would ever apply. Listed and toggleable, not editable.
  const fromOps = [...new Set((CAL_WORKLIST?.ops ?? []).map(o => o.class).filter(Boolean))]
    .filter(s => !known.has(s))
    .map(slug => ({ slug, name: calDisplayName(slug), resolvable: false }));
  return [...fromClasses, ...fromOps].sort((a, b) => a.name.localeCompare(b.name));
}

function renderClassChips() {
  const box = $('cal-classes');
  const rows = chipRowsSource();
  if (!rows.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const hidden = hiddenClasses();
  box.innerHTML = rows.map(({ slug, name, resolvable }) => {
    const off = hidden.has(slug);
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
  }).join('')
    + (hidden.size ? '<button type="button" class="linky" data-cal-show-all="1">show all</button>' : '');
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
  return dropped
    .filter(d => d && d.reason === 'done' && d.date)
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
    }));
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

function renderCalendarOps() {
  const el = $('cal-ops');
  const toolbar = $('cal-toolbar');
  const base = CAL_WORKLIST?.ops ?? [];
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

  const hidden = hiddenClasses();
  // Filter on the op's own kind, not on the calendar it is written to: 'due'
  // covers homework, readings and exams, and a filter that cannot tell them
  // apart is three chips pretending to be one.
  const byKind = all.filter(o => isSelected(CAL_KIND_SEL, o.kind));
  const ops = byKind.filter(o => !hidden.has(o.class));

  renderCalKinds(all);
  renderClassChips();

  // The grids need a period to open on, and it must be the one containing
  // today rather than the one containing the first op — the worklist window
  // starts a week in the past, so anchoring on the data opens a month the
  // student has already lived through.
  if (!CAL_ANCHOR) CAL_ANCHOR = initialAnchor(base);
  renderCalPeriod();
  renderCalNotes();

  const w = CAL_WORKLIST.window || {};
  const classCount = new Set(ops.map(o => o.class)).size;
  const range = w.from && w.to ? `${fmtDayLabel(w.from)} – ${fmtDayLabel(w.to)} · ` : '';
  const hiddenNote = byKind.length - ops.length > 0
    ? ` · ${byKind.length - ops.length} hidden`
    : '';
  $('cal-summary').textContent =
    `${range}${ops.length} item${ops.length === 1 ? '' : 's'} across ${classCount} class${classCount === 1 ? '' : 'es'}${hiddenNote}`;

  if (!ops.length) {
    // Name the filter that emptied it. "Nothing here" sends the user looking
    // for a sync problem when the answer is a toggle two inches above.
    const shown = CAL_KIND_SEL.length
      ? CAL_KIND_SEL.map(calKindLabel).join(' or ').toLowerCase()
      : '';
    const why = !byKind.length
      ? `No ${shown ? `${shown} ` : ''}items in this window.`
      : 'Every class is hidden. Turn one back on above.';
    el.innerHTML = `<p class="muted">${esc(why)}</p>`;
    return;
  }

  if (CAL_VIEW === 'week') {
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
  const showDone = $('cal-showdone');
  if (showDone) {
    showDone.classList.toggle('hidden', doneCount === 0);
    showDone.classList.toggle('active', CAL_SHOW_DONE);
    showDone.setAttribute('aria-pressed', CAL_SHOW_DONE ? 'true' : 'false');
    showDone.textContent = CAL_SHOW_DONE
      ? `Hide ${doneCount} completed`
      : `Show ${doneCount} completed`;
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
  const { worklist } = await apiJson('/api/calendar');
  CAL_WORKLIST = worklist;
  seedCalDone();
  renderCalendarOps();
  // The class-times list arrives behind the grid — the calendar is useful
  // without it, so nothing waits on it.
  loadCalClasses().then(renderMeetingTimes).catch(() => {});
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
      renderMeetingTimes();
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
  const res = await api(`/api/class/${folder}/meetings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days, start, end, location }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { err.textContent = body.error || 'Could not save that.'; return; }
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
        .catch(e => toast(e.message));
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
// Anthropic API key
//
// Write-only over HTTP: the bridge never hands the key back, only whether one
// is set, where it came from, and a masked hint. So the field is always empty
// on load — it is somewhere to type a new key, never a display of the old one.
// ---------------------------------------------------------------------------

function renderAiKey(st) {
  const state = $('ai-key-state');
  const present = !!st?.present;
  state.textContent = present
    ? `Key set${st.source === 'env' ? ' from the environment' : ''} · ${st.hint || ''}`
    : 'No key set — AI stages fall back to the local model.';
  // A key coming from the environment is not ours to delete.
  $('ai-key-remove').classList.toggle('hidden', !present || st.source === 'env');
}

async function loadAiKey() {
  try { renderAiKey(await apiJson('/api/ai-key')); }
  catch { $('ai-key-state').textContent = 'Could not read the key status.'; }
}

function wireAiKey() {
  const msg = $('ai-key-msg');
  const input = $('ai-key-input');

  // A rejected key is a failure, and the rest of the app says failure in brick.
  // This line used to print the bridge's "that does not look like an Anthropic
  // API key" in the same grey as the hint two lines above it.
  const say = (text, bad = false) => {
    msg.textContent = text;
    msg.classList.toggle('error', bad);
    msg.classList.toggle('muted', !bad);
  };

  $('ai-key-save').addEventListener('click', async () => {
    const key = input.value.trim();
    say('Saving…');
    const res = await fetch('/api/ai-key', {
      method: 'POST',
      headers: { 'X-Bridge-Secret': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The bridge's 400 says exactly what is wrong with the paste; say it
      // verbatim rather than replacing it with a generic failure.
      say(body.error || `Could not save the key (${res.status}).`, true);
      return;
    }
    input.value = '';
    say('Saved.');
    renderAiKey(body);
    setTimeout(() => say(''), 3000);
  });

  $('ai-key-remove').addEventListener('click', async () => {
    say('Removing…');
    try {
      const body = await apiJson('/api/ai-key', { method: 'DELETE' });
      input.value = '';
      say(body.removed ? 'Removed.' : 'No stored key to remove.');
      renderAiKey(body);
      setTimeout(() => say(''), 3000);
    } catch (err) {
      say(`Could not remove the key: ${err.message}`, true);
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
  $('set-local-model').value = env.CSYNC_LOCAL_MODEL || '';
  $('set-local-python').value = env.CSYNC_LOCAL_PYTHON || '';
  // Function switches. Absent = on: the toggles only ever WRITE "0", so a
  // settings.json from before they existed reads as everything enabled.
  document.querySelectorAll('[data-fn]').forEach((el) => {
    el.checked = !STAGE_OFF_RE.test(String(env[el.dataset.fn] ?? ''));
  });
  loadAiKey();
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
  wireAiKey();

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
        : (r.pythonOk ? 'Model not downloaded yet.' : 'No MLX python found — install mlx-lm first (see README).');
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
// Ask this class — the chat rail.
//
// The engine is scripts/class-chat.js behind POST /api/ask: correlation-graph
// retrieval, FACTS computed in code, one lock-guarded local-model pass,
// answers citing [S1]..[Sn]. This rail renders exactly what that returns and
// invents nothing — the model plumbing, the busy states and the "nothing
// found" sentinel all come from the server.
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

function renderChat() {
  $('view-classes').classList.toggle('chat-open', CHAT.open);
  $('chat-rail').classList.toggle('hidden', !CHAT.open);
  $('chat-toggle').setAttribute('aria-pressed', CHAT.open ? 'true' : 'false');
  if (!CHAT.open) return;
  $('chat-class').textContent = CURRENT
    ? ($('detail-title').textContent || CURRENT.folder)
    : 'Pick a class';
  $('chat-input').disabled = !CURRENT || CHAT.inFlight;
  $('chat-send').disabled = !CURRENT || CHAT.inFlight;
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
  $('chat-toggle').addEventListener('click', () => {
    CHAT.open = !CHAT.open;
    localStorage.setItem('chatOpen', CHAT.open ? '1' : '0');
    renderChat();
    if (CHAT.open) $('chat-input').focus();
  });
  $('chat-close').addEventListener('click', () => {
    CHAT.open = false;
    localStorage.setItem('chatOpen', '0');
    renderChat();
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
// A rail left open last session opens with the page, not with the first class.
renderChat();

boot();
