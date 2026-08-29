// file-lock.test.js — the cross-process half of the files_index.json race.
//
// These tests SPAWN CHILD PROCESSES on purpose. Two promises in one heap prove
// nothing here: write-lock.js already serialises those, and the bug this guards
// is precisely the one an in-process test cannot reach — the bridge and the
// spawned extract stage writing files_index.json from two different pids, where
// there is no temp collision and no error, only a write that is silently not
// there.
//
// The liveness pair (a dead holder IS reclaimed, a live holder is NOT) is
// tested in both directions deliberately. scripts/_util.js:269-275 records what
// collapsing those two cost the local-model lock: a live holder read as dead,
// its lock reclaimed, and two ~20 GB models loaded at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  withFileLock, withFilesIndexLock, filesIndexKey, filesIndexLockDir,
} from '../../file-lock.js';

// fileURLToPath, never import.meta.url's raw pathname — a raw-pathname compare
// silently no-ops when the path holds characters the URL form escapes.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_MODULE = path.join(HERE, '..', '..', 'file-lock.js');

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-filelock-'));

/** Run `code` in a child node process. Returns the child handle. */
function child(code) {
  return spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const ended = (c) => new Promise(res => c.on('exit', (code, sig) => res({ code, sig })));

/** A child that does one locked read-modify-write of a counter file. */
function bumper(lockDir, counter, { locked, holdMs = 60 }) {
  const body = `
    const fs = await import('node:fs/promises');
    const { withFileLock } = await import(${JSON.stringify(LOCK_MODULE)});
    const rmw = async () => {
      const n = Number(await fs.readFile(${JSON.stringify(counter)}, 'utf8'));
      await new Promise(r => setTimeout(r, ${holdMs}));   // the await that loses the update
      await fs.writeFile(${JSON.stringify(counter)}, String(n + 1), 'utf8');
    };
    ${locked
      ? `await withFileLock(${JSON.stringify(lockDir)}, rmw, { timeoutMs: 10000 });`
      : `await rmw();`}
  `;
  return child(body);
}

test('two processes racing one read-modify-write lose an update WITHOUT the lock', async () => {
  // The control. If this ever stops failing, the test below proves nothing.
  const dir = await tmp();
  const counter = path.join(dir, 'counter');
  await fs.writeFile(counter, '0', 'utf8');
  const lockDir = path.join(dir, '.lock');

  const a = bumper(lockDir, counter, { locked: false });
  const b = bumper(lockDir, counter, { locked: false });
  await Promise.all([ended(a), ended(b)]);

  assert.equal(await fs.readFile(counter, 'utf8'), '1',
    'expected the classic lost update: both read 0, both wrote 1');
});

test('the same two processes both land WITH the lock', async () => {
  const dir = await tmp();
  const counter = path.join(dir, 'counter');
  await fs.writeFile(counter, '0', 'utf8');
  const lockDir = path.join(dir, '.lock');

  const a = bumper(lockDir, counter, { locked: true });
  const b = bumper(lockDir, counter, { locked: true });
  const [ra, rb] = await Promise.all([ended(a), ended(b)]);

  assert.equal(ra.code, 0, 'child a exited non-zero');
  assert.equal(rb.code, 0, 'child b exited non-zero');
  assert.equal(await fs.readFile(counter, 'utf8'), '2',
    'both increments must survive');
});

test('a lock whose holder was killed is reclaimed, not waited out', async () => {
  const dir = await tmp();
  const lockDir = path.join(dir, '.lock');
  const ready = path.join(dir, 'ready');

  // Holder acquires, signals, then sleeps far past any deadline here.
  const holder = child(`
    const fs = await import('node:fs/promises');
    const { withFileLock } = await import(${JSON.stringify(LOCK_MODULE)});
    await withFileLock(${JSON.stringify(lockDir)}, async () => {
      await fs.writeFile(${JSON.stringify(ready)}, 'held', 'utf8');
      await new Promise(r => setTimeout(r, 600000));
    }, { timeoutMs: 10000 });
  `);
  for (let i = 0; i < 200 && !(await fs.access(ready).then(() => true, () => false)); i++) {
    await new Promise(r => setTimeout(r, 25));
  }
  holder.kill('SIGKILL');
  await ended(holder);

  // The dead holder is detected by pid liveness (ESRCH), so this must NOT have
  // to wait out the 15s age threshold.
  const t0 = Date.now();
  let ran = false;
  await withFileLock(lockDir, async () => { ran = true; }, { timeoutMs: 5000 });
  assert.ok(ran, 'callback never ran');
  assert.ok(Date.now() - t0 < 5000, 'reclaim should be prompt, not age-based');
  await fs.rm(dir, { recursive: true, force: true });
});

test('a lock whose holder is ALIVE is never stolen', async () => {
  // The other half of the pair, and the one that actually protects data:
  // treating a live holder as dead puts two writers inside the lock at once.
  const dir = await tmp();
  const lockDir = path.join(dir, '.lock');
  const ready = path.join(dir, 'ready');

  const holder = child(`
    const fs = await import('node:fs/promises');
    const { withFileLock } = await import(${JSON.stringify(LOCK_MODULE)});
    await withFileLock(${JSON.stringify(lockDir)}, async () => {
      await fs.writeFile(${JSON.stringify(ready)}, 'held', 'utf8');
      await new Promise(r => setTimeout(r, 600000));
    }, { timeoutMs: 10000 });
  `);
  for (let i = 0; i < 200 && !(await fs.access(ready).then(() => true, () => false)); i++) {
    await new Promise(r => setTimeout(r, 25));
  }

  await assert.rejects(
    () => withFileLock(lockDir, async () => {}, { timeoutMs: 400 }),
    /timed out waiting for file lock/,
    'a live holder must make us wait and then fail, never yield the lock');

  holder.kill('SIGKILL');
  await ended(holder);
  await fs.rm(dir, { recursive: true, force: true });
});

test('the lock is released when the callback throws', async () => {
  const dir = await tmp();
  const lockDir = path.join(dir, '.lock');
  await assert.rejects(() => withFileLock(lockDir, async () => { throw new Error('boom'); }));
  let ran = false;
  await withFileLock(lockDir, async () => { ran = true; }, { timeoutMs: 1000 });
  assert.ok(ran, 'a thrown callback must not strand the lock');
  await fs.rm(dir, { recursive: true, force: true });
});

test('two same-process callers serialise without deadlocking on the file lock', async () => {
  // The composition: in-process first, then cross-process. If the order were
  // reversed the loser would poll the filesystem inside this same event loop.
  const dir = await tmp();
  const classDir = path.join(dir, '101-demo');
  await fs.mkdir(classDir, { recursive: true });
  const seen = [];
  await Promise.all([
    withFilesIndexLock(classDir, async () => {
      seen.push('a-in'); await new Promise(r => setTimeout(r, 40)); seen.push('a-out');
    }, { timeoutMs: 5000 }),
    withFilesIndexLock(classDir, async () => {
      seen.push('b-in'); await new Promise(r => setTimeout(r, 10)); seen.push('b-out');
    }, { timeoutMs: 5000 }),
  ]);
  // Order is NOT the property — withFilesIndexLock awaits realpath before it
  // reaches the in-process queue, so which caller gets there first is a race
  // and asserting on it would be testing the scheduler. What must hold is that
  // neither one is inside the lock while the other is.
  assert.deepEqual(
    seen.filter((_, i) => i % 2 === 0).map(s => s.slice(0, 1)),
    seen.filter((_, i) => i % 2 === 1).map(s => s.slice(0, 1)),
    `each caller must exit before the next enters; got ${seen.join(',')}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test('the key is realpath-normalised so a symlinked class dir is ONE lock', async () => {
  const dir = await tmp();
  const real = path.join(dir, '101-real');
  await fs.mkdir(real, { recursive: true });
  const link = path.join(dir, '101-link');
  await fs.symlink(real, link);

  assert.equal(await filesIndexKey(link), await filesIndexKey(real),
    'two names for one inode must produce one key, or the in-process layer serialises nothing');

  // Sameness alone is a tautology — a constant satisfies it, and a constant
  // would queue every class in the install behind every other one. The key has
  // to DISCRIMINATE too.
  const other = path.join(dir, '102-other');
  await fs.mkdir(other, { recursive: true });
  assert.notEqual(await filesIndexKey(other), await filesIndexKey(real),
    'two different class dirs must not share a lock key');
  assert.match(await filesIndexKey(real), /^files_index@\//,
    'the key must carry both the scope and an absolute path');
  await fs.rm(dir, { recursive: true, force: true });
});

test('FIXTURE ISOLATION: the lock never lands inside a symlinked materials/', async () => {
  // A fixture copies the class dir ROOT per class but symlinks files/,
  // materials/ and AI_CONTEXT/ into the real data root. A lock placed under
  // materials/ would write into the user's real data during a test run.
  const dir = await tmp();
  const realData = path.join(dir, 'real-data-materials');
  await fs.mkdir(realData, { recursive: true });
  const classDir = path.join(dir, '101-fixture');
  await fs.mkdir(classDir, { recursive: true });
  await fs.symlink(realData, path.join(classDir, 'materials'));

  await withFilesIndexLock(classDir, async () => {}, { timeoutMs: 5000 });

  assert.deepEqual(await fs.readdir(realData), [],
    'a lock (or its tombstone) leaked into the symlinked materials/ target');
  assert.equal(filesIndexLockDir(classDir), path.join(classDir, '.files_index.lock'),
    'the lock must sit in the class dir root, which a fixture copies');
  await fs.rm(dir, { recursive: true, force: true });
});

test('extract holds the lock for the finalize ONLY, never across the pass', async () => {
  // Structural, and deliberately so: the danger in this design is not that the
  // lock is missing but that it is held too long. A lock spanning the
  // minutes-long extraction would need a stale threshold that cannot tell a
  // slow holder from a dead one.
  const src = await fs.readFile(
    path.join(HERE, '..', '..', 'scripts', 'extract-course-files.js'), 'utf8');
  const lines = src.split('\n');
  const acquire = lines.findIndex(l => l.includes('withFilesIndexLock(classDir'));
  assert.ok(acquire > 0, 'extract no longer takes the files_index lock — this test is stale');
  const lastLoop = lines.reduce(
    (acc, l, i) => (/for \(const entry of index\)/.test(l) ? i : acc), -1);
  assert.ok(lastLoop > 0, 'the per-file extraction loop moved — re-check this guard');
  assert.ok(acquire > lastLoop,
    `lock acquired at line ${acquire + 1}, before the extraction loop at ${lastLoop + 1}`);
});

test('a holder we are not permitted to signal counts as ALIVE (EPERM, not ESRCH)', async () => {
  // The branch the live-holder test above cannot reach: when the holder is our
  // own child, process.kill(pid, 0) simply succeeds and the catch never runs.
  // EPERM is the other case — the holder exists but belongs to someone else —
  // and collapsing it into "dead" is exactly the bug _util.js:269-275 records.
  // pid 1 is always alive and never signalable by a normal user.
  const dir = await tmp();
  const lockDir = path.join(dir, '.lock');
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: 1, token: 'not-ours', at: Date.now() }), 'utf8');

  await assert.rejects(
    () => withFileLock(lockDir, async () => {}, { timeoutMs: 300 }),
    /timed out waiting for file lock/,
    'an unsignalable but living holder must not be reclaimed');
  await fs.rm(dir, { recursive: true, force: true });
});

test('writeCourseFile actually goes through the lock', async () => {
  // Without this, every test above could pass while storage.js quietly did its
  // read-modify-write unguarded — the lock exists for that call site.
  const { writeCourseFile } = await import('../storage.js');
  const home = await tmp();
  const classDir = path.join(home, 'classes', '101-demo');
  await fs.mkdir(classDir, { recursive: true });
  const prevHome = process.env.CANVAS_SYNC_HOME;
  process.env.CANVAS_SYNC_HOME = home;

  const ready = path.join(home, 'ready');
  const holder = child(`
    const fs = await import('node:fs/promises');
    const { withFilesIndexLock } = await import(${JSON.stringify(LOCK_MODULE)});
    await withFilesIndexLock(${JSON.stringify(classDir)}, async () => {
      await fs.writeFile(${JSON.stringify(ready)}, 'held', 'utf8');
      await new Promise(r => setTimeout(r, 600000));
    }, { timeoutMs: 10000 });
  `);
  try {
    for (let i = 0; i < 200 && !(await fs.access(ready).then(() => true, () => false)); i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    await assert.rejects(
      () => writeCourseFile({
        courseId: '101', fileId: 7, displayName: 'a.txt',
        size: 1, canvasUpdatedAt: null, dataBase64: Buffer.from('x').toString('base64'),
      }),
      /timed out waiting for file lock/,
      'writeCourseFile must block on the cross-process lock, not write around it');
  } finally {
    holder.kill('SIGKILL');
    await ended(holder);
    if (prevHome === undefined) delete process.env.CANVAS_SYNC_HOME;
    else process.env.CANVAS_SYNC_HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});
