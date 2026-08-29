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
// temp on failure and can only ever remove its own; and that two spellings of
// one path are ONE lock rather than two silently-independent queues.
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
import { withPathLock, atomicWrite, atomicWriteJson, lockKey } from '../../write-lock.js';

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

// --- Key normalization ------------------------------------------------------
//
// A key is a Map key, so two spellings of one path would be two queues and no
// serialization AT ALL — while still reporting success, which is the failure
// mode this module exists to kill. Raised by canvasync-96 while reviewing the
// composition boundary with the cross-process file lock; latent at the time,
// because every caller then routed through one path-builder per file.

test('two spellings of one path are one lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-lock-'));
  const file = path.join(dir, 'state.json');
  await fs.writeFile(file, '{}');

  const spellings = [
    file,                                          // canonical
    `${dir}//state.json`,                          // doubled separator
    path.join(dir, '.', 'state.json'),             // a dot segment
    path.join(dir, 'sub', '..', 'state.json'),     // a parent segment
  ];
  const keys = new Set(spellings.map(s => lockKey('t', s)));
  assert.equal(keys.size, 1, 'every spelling must produce the same key');

  // And they really do queue together, not merely compare equal.
  const mutate = (spelling, k) => withPathLock(lockKey('t', spelling), async () => {
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    state[k] = true;
    await atomicWrite(file, JSON.stringify(state));
  });
  await Promise.all(spellings.map((sp, i) => mutate(sp, `k${i}`)));
  assert.equal(Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))).length, 4);
});

test('a relative and an absolute spelling of one path are one lock', async () => {
  const abs = path.join(process.cwd(), 'some', 'file.json');
  const rel = path.join('some', 'file.json');
  assert.equal(lockKey('t', abs), lockKey('t', rel));
});

test('scope keeps two concerns on one directory apart', () => {
  const dir = '/tmp/classes/92294-busi-305-001';
  assert.notEqual(lockKey('meeting', dir), lockKey('textbook-links', dir),
    'the meeting override and the textbook links must not queue behind each other');
});

test('a hand-written scope@path key is normalized too', async () => {
  // withPathLock normalizes the path half itself, so a key not built by
  // lockKey() is still safe.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-lock-'));
  const file = path.join(dir, 'state.json');
  await fs.writeFile(file, '{}');
  const order = [];
  await Promise.all([
    withPathLock(`t@${file}`, async () => {
      await new Promise(r => setTimeout(r, 30));
      order.push('first');
    }),
    withPathLock(`t@${dir}//state.json`, async () => { order.push('second'); }),
  ]);
  assert.deepEqual(order, ['first', 'second'], 'the doubled separator queued behind');
});

test('a key with no @ is left exactly as given', async () => {
  // Resolving it would make the key depend on process.cwd(), and a lock that
  // changes identity when the working directory does is worse than one that is
  // merely unnormalized. Pinned so nobody "improves" it into a resolve.
  const order = [];
  await Promise.all([
    withPathLock('bare-key', async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push('first');
    }),
    withPathLock('bare-key', async () => { order.push('second'); }),
  ]);
  assert.deepEqual(order, ['first', 'second'], 'identical bare keys still serialize');
});
