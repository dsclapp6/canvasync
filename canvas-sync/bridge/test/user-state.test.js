// user-state.test.js — the user's marks on a task survive everything the
// pipeline does, and nothing the client sends can corrupt them.
//
// The central risk this guards: assignments_mined.json is regenerated from
// scratch by the AI stages. If a note or a completion tick ever lived in that
// file, the next sync would silently eat it. Every test here is ultimately
// about that separation.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../test/helpers/server-factory.js';
import { readUserState, patchTask, UserStateError, USER_STATE_FILE } from '../user-state.js';

const SECRET = 'test-secret-userstate';
const FOLDER = '92294-busi-305-001';
let server, baseUrl, tmpHome, classDir;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-ustate-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';
  await fs.writeFile(path.join(tmpHome, 'config.json'),
    JSON.stringify({ bridgeSecret: SECRET }), { mode: 0o600 });
  classDir = path.join(tmpHome, 'classes', FOLDER);
  await fs.mkdir(classDir, { recursive: true });
  await fs.writeFile(path.join(classDir, 'metadata.json'), JSON.stringify({ name: 'BUSI 305' }));
  await fs.writeFile(path.join(classDir, 'assignments_mined.json'),
    JSON.stringify({ items: [{ id: 'essay-one', title: 'Essay One' }] }));
  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // THIS HOOK USED TO REWRITE THE USER'S REAL CALENDAR.
  //
  // A task edit schedules a debounced worklist rebuild (server.js
  // scheduleWorklistRebuild — a 1500 ms trailing timer that re-arms every
  // 1000 ms while a rebuild is already in flight). server.close() does not
  // cancel that timer. So this hook deleted CANVAS_SYNC_HOME, the timer fired
  // afterwards, spawned scripts/sync-calendar.js with `env: {...process.env}`
  // no longer carrying the variable, and dataRoot() fell back to the real
  // ~/canvas-sync-data — which is how running the full bridge suite came to
  // rewrite calendar/{worklist.json,worklist.md,ROUTINE.md} out from under the
  // user, four times in one afternoon, with no test anywhere claiming to do so.
  //
  // Two defences, because one is not enough: wait the timer out while the
  // environment still points at the temp home, and then hand the variable to a
  // throwaway directory rather than deleting it, so anything that escapes the
  // wait still cannot reach real data.
  await new Promise(r => setTimeout(r, 2600));
  await new Promise(resolve => server.close(resolve));
  const graveyard = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-ustate-void-'));
  process.env.CANVAS_SYNC_HOME = graveyard;
  delete process.env.BRIDGE_PORT;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(classDir, USER_STATE_FILE), { force: true });
});

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'X-Bridge-Secret': SECRET };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method, headers },
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
    if (data) req.write(data);
    req.end();
  });
}

const patch = (body) => request('POST', `/api/class/${FOLDER}/task/essay-one`, body);

// --- the separation that motivates the whole module -------------------------

test('user state is written beside the mined file, never into it', async () => {
  const minedBefore = await fs.readFile(path.join(classDir, 'assignments_mined.json'), 'utf8');
  await patch({ done: true, note: 'ask about the rubric' });
  assert.equal(await fs.readFile(path.join(classDir, 'assignments_mined.json'), 'utf8'), minedBefore);
  const state = await readUserState(classDir);
  assert.equal(state.items['essay-one'].done, true);
  assert.equal(state.items['essay-one'].note, 'ask about the rubric');
});

test('user state survives the pipeline rewriting the mined file', async () => {
  await patch({ note: 'keep me' });
  // Simulate a re-mine: the whole file is replaced.
  await fs.writeFile(path.join(classDir, 'assignments_mined.json'),
    JSON.stringify({ items: [{ id: 'essay-one', title: 'Essay One (revised)' }] }));
  const state = await readUserState(classDir);
  assert.equal(state.items['essay-one'].note, 'keep me');
});

test('a patch touches only the fields it names', async () => {
  await patch({ note: 'original note', flag: 'priority' });
  await patch({ done: true });
  const item = (await readUserState(classDir)).items['essay-one'];
  assert.equal(item.note, 'original note');
  assert.equal(item.flag, 'priority');
  assert.equal(item.done, true);
});

test('clearing every mark removes the entry rather than leaving a hollow one', async () => {
  await patch({ done: true, note: 'x', flag: 'priority' });
  await patch({ done: false, note: null, flag: 'none' });
  assert.deepEqual((await readUserState(classDir)).items, {});
});

// --- validation ------------------------------------------------------------

test('an impossible date is refused, not silently rolled over', async () => {
  // new Date(2026, 1, 31) is 3 March. Accepting it would move the user's
  // deadline to a day they never chose.
  const res = await patch({ dueOverride: '2026-02-31' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not a real date/);
});

test('date and time formats are enforced', async () => {
  assert.equal((await patch({ dueOverride: 'next tuesday' })).status, 400);
  assert.equal((await patch({ timeOverride: '25:00' })).status, 400);
  assert.equal((await patch({ timeOverride: '9:30' })).status, 400);
  assert.equal((await patch({ dueOverride: '2026-10-07' })).status, 200);
  assert.equal((await patch({ timeOverride: '23:59' })).status, 200);
});

test('an unknown flag is refused', async () => {
  const res = await patch({ flag: 'chartreuse' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /flag must be one of/);
});

test('an oversized note is refused rather than truncated', async () => {
  const res = await patch({ note: 'x'.repeat(5000) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /too long/);
});

// --- checkpoints -----------------------------------------------------------

test('checkpoints get server-generated ids and round-trip', async () => {
  const res = await patch({
    checkpoints: [
      { title: 'outline', date: '2026-10-01' },
      { title: 'draft', date: '2026-10-04', done: true },
    ],
  });
  assert.equal(res.status, 200);
  const cps = res.body.item.checkpoints;
  assert.equal(cps.length, 2);
  assert.notEqual(cps[0].id, cps[1].id);
  assert.equal(cps[1].done, true);
  assert.equal(cps[0].done, false);
});

test('a checkpoint without a title is refused', async () => {
  const res = await patch({ checkpoints: [{ date: '2026-10-01' }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /needs a title/);
});

test('checkpoints are capped', async () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ title: `cp ${i}` }));
  const res = await patch({ checkpoints: many });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /too many checkpoints/);
});

test('an empty checkpoint list clears them', async () => {
  await patch({ checkpoints: [{ title: 'outline' }] });
  await patch({ checkpoints: [] });
  assert.deepEqual((await readUserState(classDir)).items, {});
});

// --- ticking ONE prep block off ---------------------------------------------
//
// CALENDAR-SPEC 2.9. A prep block is work the user planned, so it is work they
// can finish, and until this existed a checkpoint was the one kind of row on
// the calendar whose checkbox could not be drawn at all. The whole-list
// `checkpoints` patch above cannot serve it: the calendar holds one op, not the
// item's list, and an AUTOMATIC block ("5 days before the exam") has no row in
// user_state.json to set a flag on in the first place.

test('a prep block the user wrote ticks off by id, and the assignment stays open', async () => {
  const made = await patch({ checkpoints: [{ title: 'outline', date: '2026-10-01' }, { title: 'draft', date: '2026-10-04' }] });
  const [outline, draft] = made.body.item.checkpoints;

  const res = await patch({ checkpointDone: { id: outline.id, done: true } });
  assert.equal(res.status, 200);
  const cps = res.body.item.checkpoints;
  assert.equal(cps.find(c => c.id === outline.id).done, true);
  assert.equal(cps.find(c => c.id === draft.id).done, false, 'the sibling block is untouched');
  // The one failure that would make the checkbox actively harmful: ticking a
  // block off must never mark the assignment it belongs to as submitted.
  assert.notEqual(res.body.item.done, true);
  // A block the user wrote records its tick in its own row, so there is exactly
  // one place to read it from.
  assert.equal(res.body.item.checkpointsDone, undefined);

  const back = await patch({ checkpointDone: { id: outline.id, done: false } });
  assert.equal(back.body.item.checkpoints.find(c => c.id === outline.id).done, false);
});

test('an automatic prep block ticks off by its offset id and un-ticks back to nothing', async () => {
  // "auto:5d" is the worklist's name for the block five days before the
  // deadline. Keyed on the OFFSET rather than the date so moving the deadline
  // moves the tick with it instead of stranding it.
  const res = await patch({ checkpointDone: { id: 'auto:5d', done: true } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.item.checkpointsDone, ['auto:5d']);
  assert.notEqual(res.body.item.done, true);

  await patch({ checkpointDone: { id: 'auto:1d', done: true } });
  assert.deepEqual((await readUserState(classDir)).items['essay-one'].checkpointsDone, ['auto:1d', 'auto:5d']);

  await patch({ checkpointDone: { id: 'auto:5d', done: false } });
  await patch({ checkpointDone: { id: 'auto:1d', done: false } });
  // Nothing else is set, so the entry goes rather than lingering as an empty
  // shell that makes "has the user touched this?" a two-step question.
  assert.deepEqual((await readUserState(classDir)).items, {});
});

test('a repeated tick is not counted twice', async () => {
  await patch({ checkpointDone: { id: 'auto:3d', done: true } });
  const res = await patch({ checkpointDone: { id: 'auto:3d', done: true } });
  assert.deepEqual(res.body.item.checkpointsDone, ['auto:3d']);
});

test('completed prep blocks are capped like the list itself', async () => {
  for (let i = 0; i < 50; i += 1) {
    await patch({ checkpointDone: { id: `auto:${i}d`, done: true } });
  }
  const res = await patch({ checkpointDone: { id: 'auto:99d', done: true } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /too many completed checkpoints/);
});

test('a malformed checkpointDone is refused rather than written', async () => {
  for (const body of [
    { checkpointDone: 'auto:5d' },
    { checkpointDone: [] },
    { checkpointDone: { done: true } },
    { checkpointDone: { id: 'auto:5d' } },
    { checkpointDone: { id: 'auto:5d', done: 'yes' } },
    { checkpointDone: { id: '../../etc/passwd', done: true } },
    { checkpointDone: { id: 'x'.repeat(65), done: true } },
  ]) {
    const res = await patch(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await readUserState(classDir)).items, {});
});

// --- surfacing + robustness ------------------------------------------------

test('the class bundle carries user state', async () => {
  await patch({ done: true, flag: 'blocked' });
  const res = await request('GET', `/api/class/${FOLDER}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.user_state['essay-one'].done, true);
  assert.equal(res.body.user_state['essay-one'].flag, 'blocked');
});

test('a corrupt user_state.json reads as empty instead of breaking the class view', async () => {
  await fs.writeFile(path.join(classDir, USER_STATE_FILE), '{not json');
  assert.deepEqual((await readUserState(classDir)).items, {});
  const res = await request('GET', `/api/class/${FOLDER}`);
  assert.equal(res.status, 200);
});

test('patching an unknown class 404s and writes nothing outside it', async () => {
  const res = await request('POST', '/api/class/99999-nope/task/essay-one', { done: true });
  assert.equal(res.status, 404);
});

test('a traversal folder name is refused before any path is composed', async () => {
  const res = await request('POST', '/api/class/..%2F..%2Fetc/task/x', { done: true });
  assert.ok(res.status === 400 || res.status === 404, `got ${res.status}`);
});

test('patchTask rejects a non-object patch', async () => {
  await assert.rejects(() => patchTask(classDir, 'essay-one', 'done'), UserStateError);
  await assert.rejects(() => patchTask(classDir, '', { done: true }), UserStateError);
});
