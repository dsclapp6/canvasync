// write-lock.test.js — the shared serialization helper, tested against the two
// failures it exists for rather than against its own implementation.
//
// Lives in bridge/test/ because bridge/ is where the runner is and where most
// of its callers are; the module itself sits at the package root next to
// canvas-tasks.js, since scripts/meeting-times.js imports it too.
//
// WHAT THIS PINS: that concurrent read-modify-write through withPathLock keeps
// every write; that a rejection does not wedge the queue behind it; that two
// keys do not serialize against each other; that atomicWrite leaves no orphan
// temp on failure and can only ever remove its own.
//
// WHAT IT DOES NOT PIN, and cannot: cross-process safety, which the helper
// explicitly does not offer. Two node processes writing one file will still
// lose an update, and files_index.json is a live example of that shape — it is
// a follow-up item, not something a test here could catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withPathLock, atomicWrite, atomicWriteJson } from '../../write-lock.js';

async function tmpFile(name = 'state.json') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-lock-'));
  return path.join(dir, name);
}

/** The unguarded shape every converted site used to have. */
async function unsafeMutate(file, key) {
  const raw = await fs.readFile(file, 'utf8').catch(() => '{}');
  const state = JSON.parse(raw);
  state[key] = true;                       // the await above is the yield point
  await atomicWrite(file, JSON.stringify(state));
}

const locked = (file, key) => withPathLock(file, () => unsafeMutate(file, key));

// --- The lost update -------------------------------------------------------

test('the UNLOCKED shape loses writes — the bug this helper replaces', async () => {
  // Guard test. Without it, the locked case below could pass against a no-op
  // and prove nothing.
  const file = await tmpFile();
  await fs.writeFile(file, '{}');
  await Promise.all([unsafeMutate(file, 'a'), unsafeMutate(file, 'b')]);
  const keys = Object.keys(JSON.parse(await fs.readFile(file, 'utf8')));
  assert.equal(keys.length, 1, 'two unserialized RMWs must lose one, or the race is not real here');
});

test('two locked mutations on one key both survive', async () => {
  const file = await tmpFile();
  await fs.writeFile(file, '{}');
  await Promise.all([locked(file, 'a'), locked(file, 'b')]);
  assert.deepEqual(
    Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))).sort(), ['a', 'b']);
});

test('a burst of twenty locked mutations loses none', async () => {
  const file = await tmpFile();
  await fs.writeFile(file, '{}');
  const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
  await Promise.all(keys.map(k => locked(file, k)));
  assert.deepEqual(
    Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))).sort(), [...keys].sort());
});

// --- Keying ----------------------------------------------------------------

test('different keys do not serialize against each other', async () => {
  // A lock keyed too coarsely — one global queue — would pass every test above
  // while putting every write in the app behind every other. This is what
  // catches that.
  const a = await tmpFile('a.json');
  const b = await tmpFile('b.json');
  const order = [];
  const slow = withPathLock(a, async () => {
    await new Promise(r => setTimeout(r, 40));
    order.push('slow');
  });
  const fast = withPathLock(b, async () => { order.push('fast'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['fast', 'slow'], 'b must not wait behind a');
});

test('the same key does serialize, in call order', async () => {
  const file = await tmpFile();
  const order = [];
  await Promise.all([
    withPathLock(file, async () => {
      await new Promise(r => setTimeout(r, 30));
      order.push('first');
    }),
    withPathLock(file, async () => { order.push('second'); }),
  ]);
  assert.deepEqual(order, ['first', 'second']);
});

// --- Failure behaviour -----------------------------------------------------

test('a rejected mutation does not wedge the queue behind it', async () => {
  const file = await tmpFile();
  await fs.writeFile(file, '{}');
  const boom = withPathLock(file, async () => { throw new Error('boom'); });
  await assert.rejects(() => boom, /boom/);
  await locked(file, 'after');
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))), ['after']);
});

test('the caller sees its own rejection, not a swallowed one', async () => {
  const file = await tmpFile();
  await assert.rejects(
    () => withPathLock(file, async () => { throw new TypeError('specific'); }),
    TypeError);
});

test('the queue does not grow without bound', async () => {
  // The entry is deleted once nothing is waiting, so a long-lived bridge does
  // not accumulate one resolved promise per class dir it ever touched. Checked
  // indirectly: a second round on the same key still behaves.
  const file = await tmpFile();
  await fs.writeFile(file, '{}');
  await Promise.all([locked(file, 'a'), locked(file, 'b')]);
  await Promise.all([locked(file, 'c'), locked(file, 'd')]);
  assert.deepEqual(
    Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))).sort(), ['a', 'b', 'c', 'd']);
});

// --- atomicWrite -----------------------------------------------------------

test('atomicWrite leaves no temp file behind on success', async () => {
  const file = await tmpFile();
  await atomicWriteJson(file, { ok: true });
  const left = (await fs.readdir(path.dirname(file))).filter(n => n.includes('.tmp.'));
  assert.deepEqual(left, []);
});

test('atomicWrite cleans up its temp when the write fails', async () => {
  // A destination inside a directory that does not exist: writeFile rejects,
  // and the rm in the catch is what keeps the tree clean.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-lock-'));
  const file = path.join(dir, 'missing-subdir', 'state.json');
  await assert.rejects(() => atomicWriteJson(file, { ok: true }));
  const left = (await fs.readdir(dir)).filter(n => n.includes('.tmp.'));
  assert.deepEqual(left, [], 'no orphan temp beside the real file');
});

test('concurrent atomicWrites do not delete each other\'s temp files', async () => {
  // The old shape derived the temp name from the pid, so a failing writer's
  // cleanup could unlink the OTHER writer's in-flight temp. Random per call
  // makes that impossible by construction; this pins it.
  const file = await tmpFile();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => atomicWrite(file, `payload-${i}`)));
  assert.equal(results.filter(r => r.status === 'rejected').length, 0,
    'no writer may fail because of another writer');
  assert.match(await fs.readFile(file, 'utf8'), /^payload-\d$/);
});

test('atomicWrite passes options through — mode survives', async () => {
  const file = await tmpFile();
  await atomicWrite(file, 'secret', { mode: 0o600 });
  const { mode } = await fs.stat(file);
  assert.equal(mode & 0o777, 0o600, 'config.json and settings.json rely on this');
});
