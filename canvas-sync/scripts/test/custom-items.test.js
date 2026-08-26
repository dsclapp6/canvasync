// custom-items.test.js — the calendar items the user types in themselves.
//
// These are the only ops on the calendar that no pipeline stage can rebuild,
// so the store has to be strict about what it accepts (an impossible date here
// becomes a real, different date downstream) and generous about what it keeps
// (nothing in scripts/ may ever eat one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readCustomItems, createCustomItem, patchCustomItem, deleteCustomItem,
  normalizeCustomItem, customItemOp, opsForCustomItems,
  CustomItemError, CUSTOM_ITEMS_FILE, MAX_SPAN_DAYS,
} from '../../custom-items.js';

async function tmpCal() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-custom-'));
  return path.join(dir, 'calendar');
}

// --- validation ------------------------------------------------------------

test('a title and a real date are the whole requirement', async () => {
  const it = normalizeCustomItem({}, { title: '  Group dinner  ', date: '2026-09-14' });
  assert.equal(it.title, 'Group dinner');       // trimmed
  assert.equal(it.date, '2026-09-14');
  assert.equal(it.class, null);                  // personal by default
  assert.equal(it.time, null);
  assert.equal(it.end_date, null);
});

test('an impossible date is refused rather than silently becoming another one', () => {
  // new Date(2026, 1, 31) is March 3rd. A calendar that accepted this would
  // put the item three days from where the user typed it.
  assert.throws(() => normalizeCustomItem({}, { title: 'x', date: '2026-02-31' }), CustomItemError);
  assert.throws(() => normalizeCustomItem({}, { title: 'x', date: '14/09/2026' }), CustomItemError);
  assert.throws(() => normalizeCustomItem({}, { title: 'x' }), CustomItemError);
  assert.throws(() => normalizeCustomItem({}, { title: '   ', date: '2026-09-14' }), CustomItemError);
});

test('times are real clock times, and an end needs a start', () => {
  assert.throws(() => normalizeCustomItem({}, { title: 'x', date: '2026-09-14', time: '25:00' }), CustomItemError);
  assert.throws(() => normalizeCustomItem({}, { title: 'x', date: '2026-09-14', time: '9:00' }), CustomItemError);
  assert.throws(() => normalizeCustomItem({}, { title: 'x', date: '2026-09-14', end_time: '10:00' }), CustomItemError);
  // Same day, end before start, is a typo.
  assert.throws(() => normalizeCustomItem({},
    { title: 'x', date: '2026-09-14', time: '14:00', end_time: '13:00' }), CustomItemError);
  const ok = normalizeCustomItem({}, { title: 'x', date: '2026-09-14', time: '14:00', end_time: '15:30' });
  assert.equal(ok.end_time, '15:30');
});

test('a span runs forwards, collapses when it is one day, and is capped', () => {
  assert.throws(() => normalizeCustomItem({},
    { title: 'x', date: '2026-09-14', end_date: '2026-09-13' }), CustomItemError);
  // date === end_date is one day; storing it as a span would give the same
  // item two readings.
  const same = normalizeCustomItem({}, { title: 'x', date: '2026-09-14', end_date: '2026-09-14' });
  assert.equal(same.end_date, null);
  assert.throws(() => normalizeCustomItem({},
    { title: 'x', date: '2026-01-01', end_date: '2027-01-01' }), CustomItemError);
  const capped = normalizeCustomItem({}, { title: 'x', date: '2026-01-01', end_date: '2026-03-02' });
  assert.equal(capped.end_date, '2026-03-02');   // exactly MAX_SPAN_DAYS = 60
  assert.equal(MAX_SPAN_DAYS, 60);
});

test('a timed item that runs over days has to say when it stops', () => {
  // "Friday 9:00 through Sunday" names no end, and the ICS DTEND would have
  // to be invented.
  assert.throws(() => normalizeCustomItem({},
    { title: 'x', date: '2026-09-14', end_date: '2026-09-16', time: '09:00' }), CustomItemError);
  const ok = normalizeCustomItem({},
    { title: 'x', date: '2026-09-14', end_date: '2026-09-16', time: '09:00', end_time: '17:00' });
  assert.equal(ok.end_time, '17:00');
  // Overnight is legitimate ACROSS days, where same-day would be a typo.
  const overnight = normalizeCustomItem({},
    { title: 'x', date: '2026-09-14', end_date: '2026-09-15', time: '22:00', end_time: '02:00' });
  assert.equal(overnight.end_time, '02:00');
});

test('the class is a slug or nothing at all', () => {
  assert.equal(normalizeCustomItem({}, { title: 'x', date: '2026-09-14', class: null }).class, null);
  assert.equal(normalizeCustomItem({}, { title: 'x', date: '2026-09-14', class: 'BUSI-380-002' }).class, 'busi-380-002');
  assert.throws(() => normalizeCustomItem({},
    { title: 'x', date: '2026-09-14', class: '../../etc/passwd' }), CustomItemError);
});

test('a patch cannot sneak an item into a shape a create would refuse', () => {
  const base = normalizeCustomItem({}, { title: 'x', date: '2026-09-14', time: '09:00', end_time: '10:00' });
  // Cross-field rules run over the MERGED result, not over the patch alone.
  assert.throws(() => normalizeCustomItem(base, { end_time: '08:00' }), CustomItemError);
  assert.throws(() => normalizeCustomItem(base, { end_date: '2026-09-01' }), CustomItemError);
  assert.throws(() => normalizeCustomItem(base, { title: '' }), CustomItemError);
});

// --- the store -------------------------------------------------------------

test('an item survives a write and a read, and delete really removes it', async () => {
  const cal = await tmpCal();
  assert.deepEqual((await readCustomItems(cal)).items, []);   // missing file is empty, not an error

  const item = await createCustomItem(cal, { title: 'Advising', date: '2026-09-14', time: '13:00' });
  assert.match(item.id, /^[0-9a-f-]{36}$/);
  assert.equal(item.done, false);
  assert.ok(item.created_at);

  const back = await readCustomItems(cal);
  assert.equal(back.items.length, 1);
  assert.equal(back.items[0].title, 'Advising');

  assert.equal(await deleteCustomItem(cal, item.id), true);
  assert.deepEqual((await readCustomItems(cal)).items, []);
  // Deleting what is not there is false, not a throw — the UI may be a beat
  // behind the file.
  assert.equal(await deleteCustomItem(cal, item.id), false);
});

test('a patch touches only the fields it names', async () => {
  const cal = await tmpCal();
  const item = await createCustomItem(cal,
    { title: 'Study group', date: '2026-09-14', time: '18:00', end_time: '20:00', description: 'library' });
  const moved = await patchCustomItem(cal, item.id, { date: '2026-09-16' });
  assert.equal(moved.date, '2026-09-16');
  assert.equal(moved.time, '18:00');          // untouched
  assert.equal(moved.description, 'library'); // untouched
  assert.equal(moved.id, item.id);            // the id is never rewritten
  assert.notEqual(moved.updated_at, undefined);
  assert.equal(await patchCustomItem(cal, 'no-such-id', { date: '2026-09-16' }), null);
});

test('a corrupt file reads as empty instead of breaking the calendar', async () => {
  const cal = await tmpCal();
  await fs.mkdir(cal, { recursive: true });
  await fs.writeFile(path.join(cal, CUSTOM_ITEMS_FILE), '{ not json');
  assert.deepEqual((await readCustomItems(cal)).items, []);
  // …and a create over the top of it still works.
  const item = await createCustomItem(cal, { title: 'x', date: '2026-09-14' });
  assert.equal((await readCustomItems(cal)).items.length, 1);
  assert.ok(item.id);
});

// --- ops -------------------------------------------------------------------

test('a personal item keeps its bare title; a class item wears the code', () => {
  const base = { id: 'abc', title: 'Group dinner', date: '2026-09-14' };
  assert.equal(customItemOp(base).title, 'Group dinner');
  const classed = customItemOp({ ...base, class: 'busi-380-002' },
    { codeFor: () => 'BUSI 380' });
  assert.equal(classed.title, 'BUSI 380 · Group dinner');
  assert.equal(classed.class, 'busi-380-002');
  // No class means the reserved pseudo-class, so the UI has one thing to
  // colour and filter on rather than a null.
  assert.equal(customItemOp(base).class, 'personal');
});

test('the marker is stable across every edit but the content', () => {
  const a = customItemOp({ id: 'abc', title: 'Dinner', date: '2026-09-14' });
  const b = customItemOp({ id: 'abc', title: 'Dinner', date: '2026-09-15' });
  // Same item, so the same prefix — a moved item UPDATES its event.
  assert.equal(a.marker_prefix, b.marker_prefix);
  assert.equal(a.marker_prefix, '[csync:u|abc|');
  // Different content, so a different hash.
  assert.notEqual(a.marker, b.marker);
  assert.equal(a.calendar, 'custom');
  assert.equal(a.kind, 'personal');
  assert.equal(a.origin, 'user');
});

test('a done item leaves an op behind and a resurrectable record', () => {
  const drops = [];
  const ops = opsForCustomItems(
    [{ id: 'a', title: 'Done thing', date: '2026-09-14', done: true, doneAt: '2026-09-13T00:00:00Z' }],
    { minIso: '2026-09-01', maxIso: '2026-12-01', drops },
  );
  assert.equal(ops.length, 0);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, 'done');
  // Everything a Show-completed row needs to draw itself and un-tick.
  assert.equal(drops[0].custom_id, 'a');
  assert.equal(drops[0].event_title, 'Done thing');
  assert.equal(drops[0].kind, 'personal');
});

test('an item outside the window is a fact, not a disappearance', () => {
  const drops = [];
  const ops = opsForCustomItems(
    [{ id: 'a', title: 'Next term', date: '2027-03-01' }],
    { minIso: '2026-09-01', maxIso: '2026-12-01', drops },
  );
  assert.equal(ops.length, 0);
  assert.equal(drops[0].reason, 'out_of_window');
});

test('a span counts as in-window while any of it is', () => {
  // An item that started before the window but runs into it is still on the
  // calendar — clipping on the START date alone would drop the trip you are
  // currently on.
  const ops = opsForCustomItems(
    [{ id: 'a', title: 'Trip', date: '2026-08-30', end_date: '2026-09-03' }],
    { minIso: '2026-09-01', maxIso: '2026-12-01' },
  );
  assert.equal(ops.length, 1);
  assert.equal(ops[0].end_date, '2026-09-03');
});

// --- concurrent mutations -------------------------------------------------
// The bridge is ONE process serving every route, so two mutations really do
// overlap: a tick while a drag's PATCH is in flight, two quick ticks, a
// delete during an edit. Both defects below were live and compounded — the
// lost update silently dropped a change, and the shared tmp path made the
// API report the OPPOSITE of what it stored.

test('two concurrent patches on different items both survive', async () => {
  const cal = await tmpCal();
  const a = await createCustomItem(cal, { title: 'A', date: '2026-09-01' });
  const b = await createCustomItem(cal, { title: 'B', date: '2026-09-02' });

  const [ra, rb] = await Promise.all([
    patchCustomItem(cal, a.id, { done: true }),
    patchCustomItem(cal, b.id, { done: true }),
  ]);
  assert.equal(ra.done, true);
  assert.equal(rb.done, true);

  // What the callers were told must be what is on disk — a read-modify-write
  // over the whole file used to drop whichever change was computed first.
  const { items } = await readCustomItems(cal);
  assert.deepEqual(
    Object.fromEntries(items.map(i => [i.title, i.done])),
    { A: true, B: true },
  );
});

test('a burst of patches on ONE item all apply, last write winning', async () => {
  const cal = await tmpCal();
  const it = await createCustomItem(cal, { title: 'Burst', date: '2026-09-01' });
  const titles = ['t1', 't2', 't3', 't4', 't5'];
  await Promise.all(titles.map(t => patchCustomItem(cal, it.id, { title: t })));
  const { items } = await readCustomItems(cal);
  assert.equal(items.length, 1, 'no duplicate rows from interleaved writes');
  assert.ok(titles.includes(items[0].title));
});

test('a create racing a delete leaves the store consistent', async () => {
  const cal = await tmpCal();
  const doomed = await createCustomItem(cal, { title: 'Doomed', date: '2026-09-01' });
  const [, removed] = await Promise.all([
    createCustomItem(cal, { title: 'Fresh', date: '2026-09-03' }),
    deleteCustomItem(cal, doomed.id),
  ]);
  assert.equal(removed, true);
  const { items } = await readCustomItems(cal);
  assert.deepEqual(items.map(i => i.title), ['Fresh'],
    'the create is not erased by the delete rewriting a stale snapshot');
});

test('a rejected mutation does not wedge the ones queued behind it', async () => {
  const cal = await tmpCal();
  const it = await createCustomItem(cal, { title: 'Keep', date: '2026-09-01' });
  const bad = patchCustomItem(cal, it.id, { date: '2026-02-31' }).then(
    () => 'resolved', e => (e instanceof CustomItemError ? 'rejected' : 'wrong-error'));
  const good = patchCustomItem(cal, it.id, { title: 'Still works' });
  assert.equal(await bad, 'rejected');
  assert.equal((await good).title, 'Still works');
});

test('no .tmp files are left behind by concurrent writes', async () => {
  const cal = await tmpCal();
  const it = await createCustomItem(cal, { title: 'X', date: '2026-09-01' });
  await Promise.all([1, 2, 3, 4].map(n => patchCustomItem(cal, it.id, { title: `n${n}` })));
  const left = (await fs.readdir(cal)).filter(n => n.includes('.tmp.'));
  assert.deepEqual(left, [], 'a per-call temp name, cleaned up on failure');
});

test('an unreadable store is moved aside, never overwritten', async () => {
  // Reading as empty keeps the calendar working, but a mutation then rewrote
  // the whole file from that empty read — one add replaced every real item,
  // silently, on nothing worse than a torn write. The data is preserved under
  // a name that says what it is, and the add still succeeds.
  const cal = await tmpCal();
  await fs.mkdir(cal, { recursive: true });
  const file = path.join(cal, CUSTOM_ITEMS_FILE);
  await fs.writeFile(file, '{"items":[{"id":"a","title":"Real thing"},{ TRUNCATED');

  const item = await createCustomItem(cal, { title: 'New', date: '2026-09-14' });
  assert.ok(item.id, 'the feature does not wedge');

  const kept = (await fs.readdir(cal)).filter(n => n.includes('.unreadable-'));
  assert.equal(kept.length, 1, 'exactly one preserved copy');
  const preserved = await fs.readFile(path.join(cal, kept[0]), 'utf8');
  assert.match(preserved, /Real thing/, 'the bytes are still on disk, recoverable');
  assert.deepEqual((await readCustomItems(cal)).items.map(i => i.title), ['New']);
});

test('readCustomItems distinguishes absent from unreadable', async () => {
  const cal = await tmpCal();
  const missing = await readCustomItems(cal);
  assert.deepEqual(missing.items, []);
  assert.equal(missing.unreadable, false, 'nothing added yet is not a failure');

  await fs.mkdir(cal, { recursive: true });
  await fs.writeFile(path.join(cal, CUSTOM_ITEMS_FILE), 'not json at all');
  const broken = await readCustomItems(cal);
  assert.deepEqual(broken.items, [], 'still renders the calendar');
  assert.equal(broken.unreadable, true, 'but writers must know');
});

test('re-filing an item under a class changes its marker, so the event retitles', () => {
  // The marker hash is how the routine decides an event changed. Class is not
  // in the marker prefix (unlike a due op's slug), so if it is not in the hash
  // either, a re-filed item keeps its old event name forever.
  const base = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Group dinner', date: '2026-09-14' };
  const codeFor = slug => ({ 'busi-380-002': 'BUSI 380', 'econ-205-001': 'ECON 205' }[slug] ?? null);
  const personal = customItemOp({ ...base, class: null }, { codeFor });
  const busi = customItemOp({ ...base, class: 'busi-380-002' }, { codeFor });
  const econ = customItemOp({ ...base, class: 'econ-205-001' }, { codeFor });

  assert.equal(personal.title, 'Group dinner');
  assert.equal(busi.title, 'BUSI 380 · Group dinner');
  const markers = [personal.marker, busi.marker, econ.marker];
  assert.equal(new Set(markers).size, 3, 'three different titles, three different markers');
  // The identity half is stable — it is the same item, so it must update in
  // place rather than turning into a second event.
  assert.equal(new Set([personal.marker_prefix, busi.marker_prefix, econ.marker_prefix]).size, 1);
});
