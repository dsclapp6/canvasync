// user-state-concurrency.test.js — two ticks in one class, at the same time.
//
// The failure this pins was live in a shipped build: user_state.json holds
// EVERY task of a class under `items`, and patchTask is a read-modify-write
// over that whole file. The calendar queues its POSTs per TASK (app.js
// `taskWriteKey` is `task|folder|id`), not per file, so ticking two different
// checkboxes in one class in quick succession put two concurrent
// read-modify-writes on one file in one process. The second read happened
// before the first write landed, and the second write put back a snapshot that
// had never contained the first tick.
//
// The user ticked two boxes, reloaded, and found one of them empty — the exact
// "tick doesn't stick" failure CALENDAR-SPEC 2.4 exists to prevent. It was
// silent: the tick site swallows the rejection and repaints from local state,
// so nothing on screen said a write had been lost.
//
// Both halves are pinned here, because fixing only the visible half is worse
// than useless: a unique tmp path alone turns the noisy variant into the quiet
// one while still dropping the write.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readUserState, patchTask, USER_STATE_FILE } from '../user-state.js';

let tmpHome, classDir;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-ustate-conc-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  classDir = path.join(tmpHome, 'classes', '92294-busi-305-001');
  await fs.mkdir(classDir, { recursive: true });
});

after(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(classDir, USER_STATE_FILE), { force: true });
});

test('two tasks ticked at once in one class both survive', async () => {
  // The headline case, and the one a user reaches by clicking twice quickly.
  const results = await Promise.allSettled([
    patchTask(classDir, 'assignment-a', { done: true }),
    patchTask(classDir, 'assignment-b', { done: true }),
  ]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled'],
    'neither write may fail: a rejection here is the ENOENT half of the bug');

  // Read back from DISK, not from the return values — a write that answered
  // 200 for a change it then discarded is precisely the failure, so the return
  // value is not evidence. This is the reload the user does.
  const onDisk = await readUserState(classDir);
  assert.equal(onDisk.items['assignment-a']?.done, true, 'first tick was lost');
  assert.equal(onDisk.items['assignment-b']?.done, true, 'second tick was lost');
});

test('a burst of ticks across many tasks all survive', async () => {
  // Ten, because two only catches an interleaving that happens to lose; a
  // burst makes a surviving race overwhelmingly likely to show itself.
  const ids = Array.from({ length: 10 }, (_, i) => `task-${i}`);
  const results = await Promise.allSettled(ids.map(id => patchTask(classDir, id, { done: true })));
  assert.equal(results.filter(r => r.status === 'rejected').length, 0, 'no write may fail');

  const onDisk = await readUserState(classDir);
  const survived = ids.filter(id => onDisk.items[id]?.done === true);
  assert.deepEqual(survived, ids, `${ids.length - survived.length} of ${ids.length} ticks were lost`);
});

test('concurrent writes to the SAME task do not corrupt it either', async () => {
  // The client serializes this case per task, so it should not arise from the
  // calendar — but two clients (the desktop app and a browser tab) each carry
  // their own queue, so the server cannot assume it.
  const results = await Promise.allSettled([
    patchTask(classDir, 'same-task', { done: true }),
    patchTask(classDir, 'same-task', { note: 'a note' }),
  ]);
  assert.equal(results.filter(r => r.status === 'rejected').length, 0);

  const onDisk = await readUserState(classDir);
  const item = onDisk.items['same-task'];
  assert.ok(item, 'the task vanished entirely');
  // Last writer wins on a field either may set; but a field only ONE of them
  // set must never be dropped by the other's snapshot.
  assert.equal(item.done, true, 'the done tick was clobbered by the note write');
  assert.equal(item.note, 'a note', 'the note was clobbered by the done write');
});

test('concurrent writes to two DIFFERENT classes are unaffected', async () => {
  // A CONTROL, not a repro: this passes against the unfixed code too, and its
  // job is to keep passing. It pins the mutex's KEY rather than its existence.
  // One global lock would make every other test in this file green while
  // quietly serialising every class in the app behind a single queue — a
  // correctness fix that silently becomes a throughput bug. Keyed by class dir,
  // these two never contend. (Case suggested by canvasync-0e.)
  const classB = path.join(tmpHome, 'classes', '90805-econ-205-002');
  await fs.mkdir(classB, { recursive: true });
  try {
    const results = await Promise.allSettled([
      patchTask(classDir, 'here', { done: true }),
      patchTask(classB, 'there', { done: true }),
    ]);
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled']);

    const a = await readUserState(classDir);
    const b = await readUserState(classB);
    assert.equal(a.items.here?.done, true);
    assert.equal(b.items.there?.done, true);
    // Neither file may have picked up the other's task.
    assert.equal(a.items.there, undefined, 'class A absorbed class B\'s write');
    assert.equal(b.items.here, undefined, 'class B absorbed class A\'s write');
  } finally {
    await fs.rm(classB, { recursive: true, force: true });
  }
});

test('no temp files are left behind by a burst', async () => {
  // The temp name is random per call now; a leaked tmp would accumulate one
  // file per write in the user's real class folder.
  await Promise.all(Array.from({ length: 8 }, (_, i) => patchTask(classDir, `leak-${i}`, { done: true })));
  const leftovers = (await fs.readdir(classDir)).filter(n => n.includes('.tmp.'));
  assert.deepEqual(leftovers, [], `temp files left behind: ${leftovers.join(', ')}`);
});

test('a rejected mutation does not wedge the writes queued behind it', async () => {
  // The queue stores a tail that never rejects, so one bad patch must not
  // poison every later write for that class — the caller still sees its own
  // error.
  const bad = patchTask(classDir, 'ok-task', { done: 'not-a-boolean' });
  const good = patchTask(classDir, 'ok-task-2', { done: true });
  await assert.rejects(bad, /done must be a boolean/);
  await good;

  const onDisk = await readUserState(classDir);
  assert.equal(onDisk.items['ok-task-2']?.done, true, 'a later write was wedged by an earlier failure');
});
