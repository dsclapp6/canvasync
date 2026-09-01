// coming-up-done.test.js — the home page's checkboxes, and the Completed list
// that sits under Coming up.
//
// The user's request, in their words: tick a Coming up row to mark it done,
// and see it in a Completed list below "so if I mismark something I can still
// find it there". Three things have to hold for that to be true, and each was
// broken in a way that would have LOOKED fine:
//
//   - the checkbox has to be the calendar's own, and its handler has to hear
//     it. The tick handler was bound on #cal-ops, so a checkbox rendered on
//     the home page would have drawn, clicked, and done nothing;
//   - the row has to MOVE on the tick, from CAL_DONE, not from the worklist
//     the bridge rebuilds ~2s later — and back again on an un-tick, including
//     for an item the server has already dropped from `ops`;
//   - Completed has to hold every item Coming up would show were it unticked.
//     "The span Coming up shows" is that, except when ticking the LAST row of
//     fewer than eight: the span shrinks and the row just ticked falls off it.
//
// The functions are lifted out of app.js and run against a stub `$`, the way
// coming-up-links.test.js lifts the resolver. Nothing here touches the network:
// `api` records the POST and `apiJson` THROWS, so a refetch is a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, relPhrase, dueTier } from '../public/cal-grid.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [SRC, HTML, CSS] = await Promise.all([
  readFile(path.join(HERE, '..', 'public', 'app.js'), 'utf8'),
  readFile(path.join(HERE, '..', 'public', 'index.html'), 'utf8'),
  readFile(path.join(HERE, '..', 'public', 'style.css'), 'utf8'),
]);

// Absence assertions read CODE, never prose: this repo has been bitten four
// times by a test matching its own explanatory comment.
const stripBlockComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripComments = (js) => stripBlockComments(js).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const CODE = stripComments(SRC);
const CSS_CODE = stripBlockComments(CSS);

/** The source of one top-level function, `async` keyword included. */
function declaration(name) {
  let start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js no longer declares ${name}() — stale test`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let i = SRC.indexOf('(', start);
  for (let d = 0; i < SRC.length; i++) {
    if (SRC[i] === '(') d++;
    else if (SRC[i] === ')' && !--d) { i++; break; }
  }
  for (let j = SRC.indexOf('{', i), d = 0; j < SRC.length; j++) {
    if (SRC[j] === '{') d++;
    else if (SRC[j] === '}' && !--d) return SRC.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function constant(name) {
  const m = new RegExp(`^const ${name} = ([^;]+);`, 'm').exec(SRC);
  assert.ok(m, `app.js no longer declares const ${name} — stale test`);
  return `const ${name} = ${m[1]};`;
}

const FNS = [
  'esc', 'calUrl', 'calDoneKey', 'calItemModel', 'calCheckHtml', 'calTitleHtml',
  'calFolder', 'calKindLabel', 'localTodayIso', 'daysUntil', 'dueRelHtml', 'customRenderOp',
  'completedOps', 'seedCalDone', 'byDateThenTime', 'homeItems', 'homeLists', 'homeRowHtml',
  'renderHome', 'onCalDoneChange', 'taskWriteKey', 'homeRowClick',
];
const CONSTS = ['HOME_UP_DAYS', 'HOME_UP_MIN_ROWS'];

const CLASSES = [
  { slug: 'busi-305-001', folder: '900-busi-305-001', code: 'BUSI 305' },
  { slug: 'busi-380-001', folder: '900-busi-380-001', code: 'BUSI 380' },
  { slug: 'econ-205-002', folder: '900-econ-205-002', code: 'ECON 205' },
  { slug: 'entr-222-001', folder: '900-entr-222-001', code: 'ENTR 222' },
];

const TODAY = '2026-09-01';

/**
 * A home page: the lifted functions closed over stub globals, plus handles on
 * the stubs so a test can read what was drawn and what was sent.
 */
function boot({ today = TODAY, ops = [], dropped = [], classes = CLASSES, api: apiStub = null } = {}) {
  const nodes = {};
  const $ = (id) => (nodes[id] ??= {
    id, innerHTML: '', textContent: '',
    classList: {
      set: new Set(),
      toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
      contains(c) { return this.set.has(c); },
    },
  });
  const calls = { api: [], apiJson: [], toast: [], openClass: [] };
  const api = apiStub ?? (async (url, opts) => { calls.api.push({ url, body: JSON.parse(opts.body) }); });
  const apiJson = async (url) => { calls.apiJson.push(url); throw new Error(`refetch of ${url} is not allowed here`); };
  const [y, mo, d] = today.split('-').map(Number);
  const localMidnight = () => new Date(y, mo - 1, d);
  const CAL_DONE = new Set();
  const CAL_DONE_PENDING = new Map();
  const CAL_POST_QUEUE = new Map();
  const CAL_WORKLIST = { ops, dropped, kind_labels: {} };
  const fns = new Function(
    '$', 'CLASSES', 'SCOPE', 'CAL_WORKLIST', 'CAL_DONE', 'CAL_DONE_PENDING', 'CAL_POST_QUEUE', 'CAL_CUSTOM',
    'PERSONAL_SLUG', 'localMidnight', 'DAY_MS', 'addDays', 'relPhrase', 'dueTier',
    'api', 'apiJson', 'toast', 'homeCardHtml', 'classColor', 'openClass',
    `${CONSTS.map(constant).join('\n')}\n${FNS.map(declaration).join('\n')}\nreturn { ${FNS.join(', ')} };`,
  )(
    $, classes, { courseIds: null }, CAL_WORKLIST, CAL_DONE, CAL_DONE_PENDING, CAL_POST_QUEUE, [],
    'personal', localMidnight, 864e5, addDays, relPhrase, dueTier,
    api, apiJson, (m) => calls.toast.push(m), () => '', () => '#000000', (f) => calls.openClass.push(f),
  );
  return { ...fns, nodes, calls, CAL_DONE, CAL_DONE_PENDING, CAL_POST_QUEUE, CAL_WORKLIST };
}

// --- fixtures, in the worklist's own shapes ---------------------------------

// A live op, as /api/calendar's worklist.ops carries it.
function due(slug, id, date, time = null, extra = {}) {
  const code = CLASSES.find(c => c.slug === slug)?.code ?? slug;
  return {
    calendar: 'due', kind: 'homework', category: 'homework', class: slug, item_id: id,
    title: `${code} · ${id}`, date, time, all_day: !time, origin: 'canvas',
    url: `https://canvas.rice.edu/courses/1/assignments/${id}`, submit_url: null,
    description: '', note: null, note_key: id, ...extra,
  };
}

// A finished item, as scripts/sync-calendar.js records it in worklist.dropped.
function droppedDone(slug, id, date, time = null, extra = {}) {
  const code = CLASSES.find(c => c.slug === slug)?.code ?? slug;
  return {
    class: slug, item_id: id, canvas_assignment_id: null, title: id,
    event_title: `${code} · ${id}`, kind: 'homework', category: 'homework', reason: 'done',
    date, time, all_day: !time, url: `https://canvas.rice.edu/courses/1/assignments/${id}`,
    submit_url: null, origin: 'canvas', done_at: `${TODAY}T10:00:00Z`, ...extra,
  };
}

const rows = (html) => [...html.matchAll(/<li class="hu-row[^"]*"[\s\S]*?<\/li>/g)].map(m => m[0]);
const idsOf = (html) => rows(html).map(r => /data-cal-done="([^"]+)"/.exec(r)?.[1] ?? null);
const upList = (sb) => sb.nodes['home-up-list'].innerHTML;
const doneList = (sb) => sb.nodes['home-done-list'].innerHTML;
const hidden = (sb, id) => sb.nodes[id].classList.contains('hidden');

/** The change event the DOM would dispatch for a tick on `id`'s checkbox. */
function tick(sb, listId, { id, folder, cpId = undefined, checked }) {
  const html = sb.nodes[listId].innerHTML;
  assert.match(html, new RegExp(`data-cal-done="${id}"`), `${id} is not in #${listId} to be ticked`);
  const box = { dataset: { calDone: id, calClass: folder, calCp: cpId }, checked, closest: () => null };
  const ev = { target: { closest: (sel) => (sel === '[data-cal-done]' ? box : null) } };
  const pending = sb.onCalDoneChange(ev);
  // The serialized POST for this item, so a test can wait for the network
  // turn without guessing at timers.
  const queued = sb.CAL_POST_QUEUE.get(`task|${folder}|${id}`);
  return { pending, queued: queued ?? Promise.resolve() };
}

// ---------------------------------------------------------------------------

test('every checkable Coming up row carries the calendar\'s own checkbox; one that cannot be ticked keeps the spacer', () => {
  const sb = boot({
    ops: [
      due('busi-305-001', 'hw-ch-1', '2026-09-02'),
      // A prep block: checkable by its own id, which the box must carry.
      { calendar: 'checkpoint', kind: 'checkpoint', class: 'entr-222-001', item_id: 'choose-group-product',
        checkpoint_id: 'auto:7d', title: 'Prep 7d · ENTR 222 Choose Group Product', date: '2026-09-03', origin: 'canvas' },
      // Mined with no id: nothing to tick, so a spacer keeps the column aligned.
      { calendar: 'due', kind: 'reading', class: 'busi-380-001', title: 'BUSI 380 · Read for Textbook', date: '2026-09-04', origin: 'syllabus' },
    ],
  });
  sb.renderHome();
  const [hw, cp, reading] = rows(upList(sb));
  assert.equal(rows(upList(sb)).length, 3);

  assert.match(hw, /<input type="checkbox" class="cal-check" data-cal-done="hw-ch-1" data-cal-class="900-busi-305-001"/,
    'the deadline box names the item and the class folder the POST goes to');
  assert.doesNotMatch(hw, /data-cal-done="[^"]*"[^>]*checked/, 'an open item is not drawn ticked');
  assert.match(cp, /data-cal-done="choose-group-product" data-cal-class="900-entr-222-001" data-cal-cp="auto:7d"/,
    'a prep block ticks ITSELF off, so the box must carry the checkpoint id');
  assert.match(reading, /<span class="cal-check-gap"><\/span>/, 'no id, no box — but the column must not collapse');
  assert.doesNotMatch(reading, /<input/, 'a box on an item with no id would tick nothing, silently');

  for (const r of [hw, cp, reading]) {
    const check = r.search(/cal-check(-gap)?/);
    const day = r.indexOf('class="hu-day"');
    assert.ok(check !== -1 && check < day, 'the box (or its spacer) leads the row, before the day column');
  }
});

test('there is one tick mechanism: the home rows render calCheckHtml, and the handler listens on the document', () => {
  const row = stripComments(declaration('homeRowHtml'));
  assert.match(row, /calCheckHtml\(o, m, o\.title\)/, 'the home row must draw the calendar\'s checkbox, not its own');
  assert.match(row, /calItemModel\(o\)/, 'over the same model the calendar resolves');

  // The handler used to be bound on #cal-ops; a box drawn anywhere else was
  // inert. It is one listener for the whole document now, like the
  // assignment links.
  assert.match(CODE, /document\.addEventListener\('change', onCalDoneChange\)/,
    'the tick handler must be reachable from #home-up-list and #home-done-list');
  const handlers = CODE.match(/closest\('\[data-cal-done\]'\)/g) ?? [];
  assert.equal(handlers.length, 1, 'exactly one place answers a [data-cal-done] change — no second tick mechanism');
  assert.doesNotMatch(CODE, /\$\('cal-ops'\)\.addEventListener\('change', onCalDoneChange\)/,
    'binding it on #cal-ops as well would fire twice for every calendar tick');
  assert.doesNotMatch(CODE, /\$\('home-up-list'\)\.addEventListener\('change'/,
    'a home-list-only change handler is the duplicate this test exists to forbid');
});

test('ticking a Coming up row moves it to Completed at once, with no refetch; un-ticking brings it straight back', async () => {
  const sb = boot({
    ops: [
      due('busi-305-001', 'hw-ch-1', '2026-09-02', '23:59'),
      due('econ-205-002', 'ps-1', '2026-09-03'),
      due('busi-380-001', 'cc-2', '2026-09-04', '14:30'),
    ],
  });
  sb.renderHome();
  assert.deepEqual(idsOf(upList(sb)), ['hw-ch-1', 'ps-1', 'cc-2']);
  assert.ok(hidden(sb, 'home-completed'), 'nothing is done yet, so Completed is hidden');

  const { queued } = tick(sb, 'home-up-list', { id: 'hw-ch-1', folder: '900-busi-305-001', checked: true });
  // Synchronously — before any await — the row has moved. Waiting for the
  // bridge's debounced rebuild here is what reads as "the checkbox does nothing".
  assert.deepEqual(idsOf(upList(sb)), ['ps-1', 'cc-2'], 'gone from Coming up in the same turn');
  assert.deepEqual(idsOf(doneList(sb)), ['hw-ch-1'], 'and present in Completed');
  assert.ok(!hidden(sb, 'home-completed'), 'Completed shows the moment it has a row');
  const [doneRow] = rows(doneList(sb));
  assert.match(doneRow, /^<li class="hu-row is-done"/, 'the moved row is drawn as done');
  assert.match(doneRow, /data-cal-done="hw-ch-1"[^>]*\bchecked\b/, 'with a CHECKED box, so it can be un-ticked');
  assert.match(doneRow, /data-open-assignment="hw-ch-1"/, 'and it still clicks in to the item');
  assert.equal(sb.calls.apiJson.length, 0, 'no refetch of /api/calendar was needed to move it');

  await queued;
  assert.deepEqual(sb.calls.api, [{ url: '/api/class/900-busi-305-001/task/hw-ch-1', body: { done: true } }],
    'the tick was saved through the task endpoint, once');
  assert.deepEqual(idsOf(doneList(sb)), ['hw-ch-1'], 'a saved tick stays put');
  assert.equal(sb.calls.apiJson.length, 0);

  // Now un-tick it from Completed.
  const back = tick(sb, 'home-done-list', { id: 'hw-ch-1', folder: '900-busi-305-001', checked: false });
  assert.deepEqual(idsOf(upList(sb)), ['hw-ch-1', 'ps-1', 'cc-2'], 'back in Coming up, in date order, at once');
  assert.equal(doneList(sb), '', 'and out of Completed');
  assert.ok(hidden(sb, 'home-completed'), 'which hides again when it is empty');
  await back.queued;
  assert.deepEqual(sb.calls.api.at(-1), { url: '/api/class/900-busi-305-001/task/hw-ch-1', body: { done: false } });
  assert.equal(sb.calls.apiJson.length, 0, 'still no refetch');
  assert.equal(sb.calls.toast.length, 0, 'and nothing to apologise for');
});

test('a failed save puts the row back where it was', async () => {
  const sb = boot({
    ops: [due('busi-305-001', 'hw-ch-1', '2026-09-02'), due('econ-205-002', 'ps-1', '2026-09-03')],
    api: async () => { throw new Error('offline'); },
  });
  sb.renderHome();
  const { queued } = tick(sb, 'home-up-list', { id: 'hw-ch-1', folder: '900-busi-305-001', checked: true });
  assert.deepEqual(idsOf(doneList(sb)), ['hw-ch-1'], 'optimistically moved');
  await queued;
  assert.deepEqual(idsOf(upList(sb)), ['hw-ch-1', 'ps-1'], 'and moved back when the save failed');
  assert.equal(doneList(sb), '');
  assert.equal(sb.calls.toast.length, 1, 'the user is told, once');
  assert.ok(!sb.CAL_DONE.has('900-busi-305-001|hw-ch-1'), 'CAL_DONE agrees with what is drawn');
});

test('un-ticking an item the server has already dropped returns it to Coming up — the record is still there to draw', () => {
  // After the rebuild the item is gone from `ops` and sits in `dropped`. The
  // only place it can come back from is that record, so Coming up has to read
  // the union, not `ops` alone.
  const sb = boot({
    ops: [due('econ-205-002', 'ps-1', '2026-09-03')],
    dropped: [droppedDone('busi-305-001', 'hw-ch-1', '2026-09-02', '23:59')],
  });
  sb.seedCalDone();
  sb.renderHome();
  assert.deepEqual(idsOf(upList(sb)), ['ps-1']);
  assert.deepEqual(idsOf(doneList(sb)), ['hw-ch-1'], 'the server\'s finished work is listed as Completed');
  assert.match(rows(doneList(sb))[0], /BUSI 305 · hw-ch-1/, 'under the title the live row would have had');

  tick(sb, 'home-done-list', { id: 'hw-ch-1', folder: '900-busi-305-001', checked: false });
  assert.deepEqual(idsOf(upList(sb)), ['hw-ch-1', 'ps-1'], 'back in Coming up, from the dropped record, in date order');
  assert.equal(doneList(sb), '');
  assert.match(rows(upList(sb))[0], /data-open-assignment="hw-ch-1"/, 'and it clicks in like any other row');
  assert.doesNotMatch(rows(upList(sb))[0], /is-done|\bchecked\b/, 'drawn open, not done');
});

test('an item that is in `ops` AND `dropped` for a moment is one row, not two', () => {
  // The client's worklist is stale for ~2s after a tick: the item can be in
  // `ops` (old) while CAL_DONE says done, or a fresh worklist can put it in
  // `dropped` while `ops` in an older tab still has it. One key, one row.
  const sb = boot({
    ops: [due('busi-305-001', 'hw-ch-1', '2026-09-02', null, { url: 'https://canvas.rice.edu/live' })],
    dropped: [droppedDone('busi-305-001', 'hw-ch-1', '2026-09-02', null, { url: 'https://canvas.rice.edu/stale' })],
  });
  sb.seedCalDone();
  sb.renderHome();
  assert.equal(rows(upList(sb)).length + rows(doneList(sb)).length, 1, 'deduped on calDoneKey');
  assert.deepEqual(idsOf(doneList(sb)), ['hw-ch-1']);
});

test('Completed is ordered by date then time, exactly like Coming up', () => {
  const sb = boot({
    ops: [
      due('busi-380-001', 'open-late', '2026-09-03', '14:30'),
      due('busi-380-001', 'open-early', '2026-09-03', '09:00'),
      due('econ-205-002', 'open-first', '2026-09-02'),
      // Ticked this session — still in `ops`, key in CAL_DONE.
      due('busi-380-001', 'done-late', '2026-09-03', '14:30'),
      due('busi-380-001', 'done-early', '2026-09-03', '09:00'),
      // Neither list is for these: yesterday is not coming up, and a lecture
      // is not news.
      due('busi-380-001', 'yesterday-open', '2026-08-31'),
      { calendar: 'meeting', kind: 'meeting', class: 'busi-380-001', item_id: 'lecture', title: 'BUSI 380', date: '2026-09-02', time: '14:30' },
    ],
    dropped: [
      droppedDone('econ-205-002', 'done-last', '2026-09-05'),
      droppedDone('econ-205-002', 'done-first', '2026-09-02'),
      droppedDone('econ-205-002', 'yesterday-done', '2026-08-31'),
    ],
  });
  sb.seedCalDone();
  sb.CAL_DONE.add('900-busi-380-001|done-late');
  sb.CAL_DONE.add('900-busi-380-001|done-early');
  sb.renderHome();
  assert.deepEqual(idsOf(upList(sb)), ['open-first', 'open-early', 'open-late']);
  assert.deepEqual(idsOf(doneList(sb)), ['done-first', 'done-early', 'done-late', 'done-last'],
    'date first, then time — across both sources');
  assert.doesNotMatch(upList(sb) + doneList(sb), /yesterday|lecture/, 'past items and meetings are in neither list');
  assert.match(stripComments(declaration('homeLists')), /\.sort\(byDateThenTime\)[\s\S]*\.sort\(byDateThenTime\)/,
    'both lists sort with the one comparator');
});

test('a busy day is never cut off: Coming up shows every item due within 7 days', () => {
  // Today: seven concept-check quizzes at 2:30 — the real shape that was
  // cut at three. Plus four more inside the week. All eleven must show.
  const ops = [];
  for (let i = 1; i <= 7; i++) ops.push(due('busi-380-001', `cc-${i}`, TODAY, '14:30', { kind: 'quiz' }));
  ops.push(due('busi-305-001', 'hw-1', '2026-09-03'));
  ops.push(due('econ-205-002', 'ps-1', '2026-09-05'));
  ops.push(due('entr-222-001', 'pitch', '2026-09-07'));
  ops.push(due('busi-305-001', 'hw-2', '2026-09-08'));   // today + 7, inclusive
  ops.push(due('busi-305-001', 'hw-3', '2026-09-09'));   // outside the week, and beyond the eighth row
  const sb = boot({ ops });
  sb.renderHome();
  assert.equal(rows(upList(sb)).length, 11, 'everything within the week, not the first eight');
  assert.ok(!idsOf(upList(sb)).includes('hw-3'), 'the week is the week: an 8-day-out item waits');
  assert.match(sb.nodes['home-stats'].innerHTML, /<span>11 due this week<\/span>/, 'and the stat still counts the same thing');
});

test('a quiet stretch still shows the next 8', () => {
  const ops = [
    due('busi-305-001', 'hw-1', '2026-09-03'),
    due('econ-205-002', 'ps-1', '2026-09-06'),
  ];
  for (let i = 0; i < 10; i++) ops.push(due('busi-380-001', `far-${i}`, addDays('2026-09-15', i * 4)));
  const sb = boot({ ops });
  sb.renderHome();
  assert.equal(rows(upList(sb)).length, 8, 'a two-item week is padded to eight rows');
  assert.deepEqual(idsOf(upList(sb)), ['hw-1', 'ps-1', 'far-0', 'far-1', 'far-2', 'far-3', 'far-4', 'far-5']);
  assert.match(sb.nodes['home-stats'].innerHTML, /<span>2 due this week<\/span>/,
    'padding the list does not inflate "due this week"');
  assert.doesNotMatch(stripComments(declaration('renderHome')), /slice\(0, 8\)/, 'the fixed cap is gone');
});

test('"due this week" counts open items only — a ticked one leaves the count as it leaves the list', () => {
  const sb = boot({ ops: [due('busi-305-001', 'a', '2026-09-02'), due('busi-305-001', 'b', '2026-09-03'), due('busi-305-001', 'c', '2026-09-04')] });
  sb.renderHome();
  assert.match(sb.nodes['home-stats'].innerHTML, /3 due this week/);
  tick(sb, 'home-up-list', { id: 'b', folder: '900-busi-305-001', checked: true });
  assert.match(sb.nodes['home-stats'].innerHTML, /2 due this week/);
});

test('Completed covers the span Coming up shows', () => {
  // Ten open items fill the week, so Coming up shows the week and nothing
  // past it. A finished item inside the week is listed; one three weeks out
  // is not — it would not be in Coming up were it open either.
  const ops = [];
  for (let i = 0; i < 10; i++) ops.push(due('busi-380-001', `o-${i}`, addDays(TODAY, i % 7)));
  const sb = boot({
    ops,
    dropped: [droppedDone('busi-305-001', 'done-in-week', '2026-09-05'), droppedDone('busi-305-001', 'done-far', '2026-09-22')],
  });
  sb.seedCalDone();
  sb.renderHome();
  assert.equal(rows(upList(sb)).length, 10);
  assert.deepEqual(idsOf(doneList(sb)), ['done-in-week'], 'the week, as Coming up shows it');

  // A quiet week that Coming up pads to eight rows reaches further, and
  // Completed reaches exactly as far.
  const sparse = boot({
    ops: [due('busi-305-001', 'a', '2026-09-02'), due('busi-305-001', 'b', '2026-09-04'),
      ...[0, 1, 2, 3, 4, 5, 6].map(i => due('busi-380-001', `f-${i}`, addDays('2026-09-12', i * 3)))],
    dropped: [
      droppedDone('econ-205-002', 'done-on-last-shown-day', '2026-09-27'),   // f-5's date: the eighth row
      droppedDone('econ-205-002', 'done-past-the-list', '2026-09-28'),       // one day past it
    ],
  });
  sparse.seedCalDone();
  sparse.renderHome();
  assert.deepEqual(idsOf(upList(sparse)), ['a', 'b', 'f-0', 'f-1', 'f-2', 'f-3', 'f-4', 'f-5']);
  assert.deepEqual(idsOf(doneList(sparse)), ['done-on-last-shown-day'],
    'up to and including the last day Coming up shows, and not beyond it');
});

test('a mis-tick on the last row is still findable when fewer than eight remain', () => {
  // The hole in "the same span Coming up shows": with eight open items the
  // eighth is the last row; tick it and Coming up shows seven, its span ends
  // at the seventh, and the row just ticked is past that span. The user
  // asked for exactly this case — "if I mismark something I can still find
  // it". When Coming up is showing everything open, Completed shows everything
  // finished, because un-ticking any of it would put it on the list.
  const ops = [];
  for (let i = 0; i < 7; i++) ops.push(due('busi-380-001', `o-${i}`, addDays(TODAY, i * 3)));
  ops.push(due('econ-205-002', 'last', '2026-10-15'));
  const sb = boot({ ops });
  sb.renderHome();
  assert.deepEqual(idsOf(upList(sb)).at(-1), 'last', 'the eighth row, six weeks out');
  tick(sb, 'home-up-list', { id: 'last', folder: '900-econ-205-002', checked: true });
  assert.equal(rows(upList(sb)).length, 7);
  assert.deepEqual(idsOf(doneList(sb)), ['last'], 'findable right below the list it left');

  // And the same with the server's record after a reload: seven open, one
  // dropped far out.
  const reloaded = boot({ ops: ops.slice(0, 7), dropped: [droppedDone('econ-205-002', 'last', '2026-10-15')] });
  reloaded.seedCalDone();
  reloaded.renderHome();
  assert.deepEqual(idsOf(doneList(reloaded)), ['last']);
});

test('Completed is hidden when empty, and its markup is a heading and a list — no placeholder prose', () => {
  const sb = boot({ ops: [due('busi-305-001', 'hw-ch-1', '2026-09-02')] });
  sb.renderHome();
  assert.ok(hidden(sb, 'home-completed'));
  assert.equal(doneList(sb), '');
  assert.ok(!hidden(sb, 'home-upcoming'));

  // Nothing at all: both hide. There is no state in which the page invents a
  // sentence to fill the gap.
  const empty = boot({ ops: [] });
  empty.renderHome();
  assert.ok(hidden(empty, 'home-completed') && hidden(empty, 'home-upcoming'));

  const section = /<section id="home-completed"[^>]*>([\s\S]*?)<\/section>/.exec(HTML);
  assert.ok(section, 'index.html must carry #home-completed');
  assert.match(section[0], /class="home-upcoming hidden"/, 'same section grammar as Coming up, hidden until it has rows');
  assert.equal(section[1].replace(/<[^>]+>/g, '').trim(), 'Completed', 'a heading and an empty list, nothing else');
  assert.match(section[1], /<ul id="home-done-list"><\/ul>/);
  assert.ok(HTML.indexOf('id="home-upcoming"') < HTML.indexOf('id="home-completed"'), 'directly below Coming up');
});

test('a Completed row lacking a url never gets a dead link', () => {
  // A syllabus-mined item has no Canvas page. Finished, it still has an id,
  // so it clicks in to its own in-app page — a real destination — and never
  // to an empty href (spec 3.13).
  const sb = boot({
    ops: [due('busi-305-001', 'open', '2026-09-02')],
    dropped: [
      droppedDone('econ-205-002', 'obtain-required-text', '2026-09-02', null, { url: null, origin: 'syllabus' }),
      // No id at all: nothing to un-tick against, so nothing is drawn — a row
      // that could not be un-ticked would be the dead control 2.10 forbids.
      droppedDone('econ-205-002', null, '2026-09-03', null, { url: null, item_id: null, event_title: 'ECON 205 · orphan' }),
    ],
  });
  sb.seedCalDone();
  sb.renderHome();
  const done = rows(doneList(sb));
  assert.equal(done.length, 1);
  assert.match(done[0], /data-open-assignment="obtain-required-text"/, 'clicks in to the item page');
  assert.doesNotMatch(done[0], /<a\s/, 'no anchor with nowhere to go');
  assert.doesNotMatch(done[0], /href="(null|undefined|)"/, 'no empty href');
  assert.doesNotMatch(doneList(sb) + upList(sb), /orphan/, 'a record with no id is not drawn anywhere');
});

test('a click on the checkbox does not also open the class behind it', () => {
  const sb = boot({ ops: [due('busi-305-001', 'hw-ch-1', '2026-09-02')] });
  const row = { dataset: { folder: '900-busi-305-001' } };
  const input = { closest: (sel) => (sel === 'a, button, input' ? input : sel === '.hu-row' ? row : null) };
  sb.homeRowClick({ target: input });
  assert.deepEqual(sb.calls.openClass, [], 'the box owns its click; the class page must not open on every tick');

  const body = { closest: (sel) => (sel === '.hu-row' ? row : null) };
  sb.homeRowClick({ target: body });
  assert.deepEqual(sb.calls.openClass, ['900-busi-305-001'], 'the rest of the row still goes to the class');
});

test('a done home row reads like a done calendar row — the same rule, no new colour', () => {
  const rule = /([^{}]*\.hu-row\.is-done \.hu-title[^{]*)\{([^}]*)\}/.exec(CSS_CODE);
  assert.ok(rule, 'style.css must style .hu-row.is-done .hu-title');
  assert.match(rule[2], /text-decoration:\s*line-through/, 'struck through');
  assert.match(rule[2], /color:\s*var\(--muted\)/, 'and muted');
  assert.match(rule[1], /\.cal-row\.is-done \.cal-title/, 'by extending the calendar\'s own done rule, not a copy of it');
  assert.doesNotMatch(rule[2], /#[0-9a-f]{3,8}\b/i, 'no colour of its own');

  const check = /\.hu-row \.cal-check,\s*\.hu-row \.cal-check-gap\s*\{([^}]*)\}/.exec(CSS_CODE);
  assert.ok(check, 'the box and its spacer must share one width rule in a flex row');
  assert.match(check[1], /width:\s*13px/, 'the calendar checkbox\'s own width');
  assert.match(check[1], /flex:\s*none/);
  assert.match(CSS_CODE, /#home-up-list, #home-done-list \{ list-style: none; \}/, 'neither list grows bullets');
});
