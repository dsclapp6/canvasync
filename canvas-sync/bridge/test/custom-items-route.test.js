// custom-items-route.test.js — the API behind "+ Add", drag-to-move and
// drag-an-edge (CALENDAR-SPEC §8).
//
// The store itself is covered in scripts/test/custom-items.test.js; what is
// pinned here is the HTTP contract the calendar depends on: that a create
// answers with the op the grid will draw, that a patch is partial, that a bad
// shape is a 400 carrying a sentence the dialog can print verbatim, and that
// an unknown id is a 404 rather than a new item.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from './helpers/server-factory.js';

const SECRET = 'test-secret-custom-items';
const FOLDER = '92294-busi-380-002';
let server, baseUrl, tmpHome;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-custom-route-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';
  await fs.writeFile(path.join(tmpHome, 'config.json'),
    JSON.stringify({ bridgeSecret: SECRET }), { mode: 0o600 });
  const classDir = path.join(tmpHome, 'classes', FOLDER);
  await fs.mkdir(classDir, { recursive: true });
  await fs.writeFile(path.join(classDir, 'metadata.json'),
    JSON.stringify({ name: 'BUSI 380', course_code: 'BUSI 380 002' }));
  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  // A rebuild may have been scheduled by a write; point the home at an empty
  // directory so nothing it does later can touch real data.
  const graveyard = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-custom-void-'));
  process.env.CANVAS_SYNC_HOME = graveyard;
  delete process.env.BRIDGE_PORT;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function call(method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method,
        headers: {
          'X-Bridge-Secret': SECRET,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        } },
      res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('a created item comes back with the op the calendar will draw', async () => {
  const { status, body } = await call('POST', '/api/calendar/items', {
    title: 'Study group', date: '2026-09-14', time: '18:00', end_time: '20:00',
  });
  assert.equal(status, 200);
  assert.match(body.item.id, /^[0-9a-f-]{36}$/);
  assert.equal(body.item.done, false);
  // The op is what makes the grid able to paint before the rebuild lands.
  assert.equal(body.op.calendar, 'custom');
  assert.equal(body.op.kind, 'personal');
  assert.equal(body.op.class, 'personal');       // no class = the pseudo-class
  assert.equal(body.op.all_day, false);
  assert.equal(body.op.marker_prefix, `[csync:u|${body.item.id}|`);
  assert.equal(body.rebuild_scheduled, true);
});

test('an item filed under a class wears that class code in its event title', async () => {
  const { body } = await call('POST', '/api/calendar/items', {
    title: 'Team meeting', date: '2026-09-15', class: 'busi-380-002',
  });
  // The code is resolved from metadata.json the same way the worklist
  // resolves it, so the .ics event and the worklist agree.
  assert.equal(body.op.title, 'BUSI 380 · Team meeting');
  assert.equal(body.op.class, 'busi-380-002');
});

test('the list route and the calendar route both carry the items', async () => {
  const list = await call('GET', '/api/calendar/items');
  assert.equal(list.status, 200);
  assert.ok(list.body.items.length >= 2);
  // The calendar route ships them alongside the worklist so the page needs
  // one request, answered from one moment.
  const cal = await call('GET', '/api/calendar');
  assert.equal(cal.status, 200);
  assert.ok(Array.isArray(cal.body.custom_items));
  assert.equal(cal.body.custom_items.length, list.body.items.length);
});

test('a patch moves the item and leaves everything it did not name', async () => {
  const created = await call('POST', '/api/calendar/items', {
    title: 'Advising', date: '2026-09-14', time: '13:00', description: 'bring the plan',
  });
  const id = created.body.item.id;
  const moved = await call('PATCH', `/api/calendar/items/${id}`, { date: '2026-09-17' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.item.date, '2026-09-17');
  assert.equal(moved.body.item.time, '13:00');            // untouched
  assert.equal(moved.body.item.description, 'bring the plan');
  assert.equal(moved.body.item.id, id);                    // same item, not a new one
});

test('a stretch across days is stored as a span', async () => {
  const created = await call('POST', '/api/calendar/items', { title: 'Trip', date: '2026-10-02' });
  const id = created.body.item.id;
  const grown = await call('PATCH', `/api/calendar/items/${id}`, { end_date: '2026-10-05' });
  assert.equal(grown.body.item.end_date, '2026-10-05');
  assert.equal(grown.body.op.end_date, '2026-10-05');
  // Collapsed back onto one day, the span is cleared rather than stored as a
  // same-day range — one shape, one reading.
  const flat = await call('PATCH', `/api/calendar/items/${id}`, { end_date: '2026-10-02' });
  assert.equal(flat.body.item.end_date, null);
});

test('a bad shape is a 400 whose message the dialog can print verbatim', async () => {
  const noTitle = await call('POST', '/api/calendar/items', { date: '2026-09-14' });
  assert.equal(noTitle.status, 400);
  assert.match(noTitle.body.error, /title/);

  const badDate = await call('POST', '/api/calendar/items', { title: 'x', date: '2026-02-31' });
  assert.equal(badDate.status, 400);
  assert.match(badDate.body.error, /not a real date/);

  const openEnded = await call('POST', '/api/calendar/items',
    { title: 'x', date: '2026-09-14', end_date: '2026-09-16', time: '09:00' });
  assert.equal(openEnded.status, 400);
  assert.match(openEnded.body.error, /end time/);
  // …and none of the refusals created anything.
  const list = await call('GET', '/api/calendar/items');
  assert.ok(!list.body.items.some(it => it.title === 'x'));
});

test('an unknown or malformed id is refused, never created', async () => {
  const unknown = await call('PATCH', '/api/calendar/items/11111111-2222-3333-4444-555555555555',
    { date: '2026-09-20' });
  assert.equal(unknown.status, 404);
  const malformed = await call('PATCH', '/api/calendar/items/not-a-uuid', { date: '2026-09-20' });
  assert.equal(malformed.status, 400);
  const gone = await call('DELETE', '/api/calendar/items/11111111-2222-3333-4444-555555555555');
  assert.equal(gone.status, 404);
});

test('delete removes exactly one item', async () => {
  const before = (await call('GET', '/api/calendar/items')).body.items.length;
  const created = await call('POST', '/api/calendar/items', { title: 'Temp', date: '2026-11-02' });
  const id = created.body.item.id;
  assert.equal((await call('GET', '/api/calendar/items')).body.items.length, before + 1);
  const del = await call('DELETE', `/api/calendar/items/${id}`);
  assert.equal(del.status, 200);
  const after = (await call('GET', '/api/calendar/items')).body.items;
  assert.equal(after.length, before);
  assert.ok(!after.some(it => it.id === id));
});

test('ticking an item done keeps it, so it can be un-ticked', async () => {
  // CALENDAR-SPEC 2.5 applies to these too: done drops the op, not the item.
  const created = await call('POST', '/api/calendar/items', { title: 'Errand', date: '2026-09-21' });
  const id = created.body.item.id;
  const done = await call('PATCH', `/api/calendar/items/${id}`, { done: true });
  assert.equal(done.body.item.done, true);
  assert.ok(done.body.item.doneAt);
  const still = (await call('GET', '/api/calendar/items')).body.items.find(it => it.id === id);
  assert.ok(still, 'a finished item is still on file');
  const undone = await call('PATCH', `/api/calendar/items/${id}`, { done: false });
  assert.equal(undone.body.item.done, false);
  assert.equal(undone.body.item.doneAt, null);
});

test('the route needs the secret like every other dashboard route', async () => {
  const res = await new Promise((resolve, reject) => {
    const url = new URL(baseUrl + '/api/calendar/items');
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET' },
      r => { r.resume(); r.on('end', () => resolve({ status: r.statusCode })); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.status, 401);
});
