// model-lock.test.js — the machine-wide local-model lock in _util.js.
// The lock is what keeps several pipeline processes from each loading a
// ~20 GB MLX model at once (the crash the user hit). It is unexported, so
// it is exercised through localInvoke() with CSYNC_LOCAL_PYTHON pointed at
// a tiny stub script instead of the real Python runner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let tmpHome, stubPath, util;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-lock-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;

  // Stub "python": ignores its args, sleeps briefly, echoes a marker.
  stubPath = path.join(tmpHome, 'fake-generate.sh');
  await fs.writeFile(stubPath, '#!/bin/sh\nsleep 1\necho "gen-done pid=$$"\n', { mode: 0o755 });
  process.env.CSYNC_LOCAL_PYTHON = stubPath;

  // The python is resolved per call now (resolveLocalPython), but the env is
  // still set before the import so the module constant and the resolved value
  // agree — this file is about the lock, not about which python runs.
  util = await import('../_util.js');
});

after(async () => {
  // REPOINT, never delete — the same rule scope.test.js's teardown records.
  // An acquire loop or a spawned child that outlives this hook reads
  // CANVAS_SYNC_HOME fresh; with it unset, dataRoot() falls back to
  // ~/canvas-sync-data and the leftover work starts taking, reclaiming or
  // writing the USER'S real model lock.
  const graveyard = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-lock-void-'));
  process.env.CANVAS_SYNC_HOME = graveyard;
  delete process.env.CSYNC_LOCAL_PYTHON;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

const lockDir = () => path.join(tmpHome, 'locks', 'local-model.lock');

test('localInvoke acquires and releases the lock around generation', async () => {
  const out = await util.localInvoke('hello', { timeoutMs: 30000 });
  assert.match(out, /gen-done/);
  await assert.rejects(fs.stat(lockDir()), 'lock must be released after generation');
});

test('a stale lock from a dead process is reclaimed immediately', async () => {
  // Forge a lock left by a crashed holder: valid pid file, but the PID is
  // dead. 999999 exceeds macOS's PID range so it can never be alive.
  await fs.mkdir(lockDir(), { recursive: true });
  await fs.writeFile(path.join(lockDir(), 'pid'), '999999', 'utf8');

  const started = Date.now();
  const out = await util.localInvoke('hello', { timeoutMs: 30000 });
  const elapsed = Date.now() - started;

  assert.match(out, /gen-done/);
  // Reclaim is instant (no 5s poll wait): stub sleeps 1s, allow generous slack.
  assert.ok(elapsed < 4500, `stale lock should be reclaimed without polling (took ${elapsed}ms)`);
  await assert.rejects(fs.stat(lockDir()), 'lock must be released after reclaim + generation');
});

test('a pid-less lock shell older than 10s is reclaimed', async () => {
  // Simulate a holder that crashed between mkdir and writeFile: lock dir
  // exists, no pid file, mtime backdated past the 10s disambiguation window.
  await fs.mkdir(lockDir(), { recursive: true });
  const old = new Date(Date.now() - 30_000);
  await fs.utimes(lockDir(), old, old);

  const started = Date.now();
  const out = await util.localInvoke('hello', { timeoutMs: 30000 });
  const elapsed = Date.now() - started;

  assert.match(out, /gen-done/);
  assert.ok(elapsed < 4500, `aged pid-less lock should be reclaimed without polling (took ${elapsed}ms)`);
});

test('concurrent localInvoke calls serialize on the lock', async () => {
  const started = Date.now();
  const [a, b] = await Promise.all([
    util.localInvoke('one', { timeoutMs: 60000 }),
    util.localInvoke('two', { timeoutMs: 60000 }),
  ]);
  const elapsed = Date.now() - started;

  assert.match(a, /gen-done/);
  assert.match(b, /gen-done/);
  // Two 1s generations truly in parallel would finish in ~1s. Serialized,
  // the loser waits for the winner (acquire poll is 5s), so ≥2s total.
  assert.ok(elapsed >= 2000, `runs must not overlap (took ${elapsed}ms — looks parallel)`);
  await assert.rejects(fs.stat(lockDir()), 'lock must be released at the end');
});

// --- modelLockStatus(): the read-only view the dashboard renders -------------
//
// These three cases all had the same shape of bug: the status probe and
// _acquireModelLock disagreed about who holds the machine's single model slot.
// When they disagree the dashboard tells the user "busy" while the pipeline
// reclaims and loads a second ~12.7 GB MLX process on top of the first — the
// exact crash the lock exists to prevent.

test('a pid file holding a negative number is not a live holder', async () => {
  // kill(-1, 0) is POSIX for "signal every process we may signal" and returns
  // success, so `pid = parseInt(...) || null` (which keeps -1, truthy) made the
  // probe report a live holder that could never age out. _acquireModelLock
  // guards with `if (pid > 0)` and would have reclaimed the very same lock.
  await fs.mkdir(lockDir(), { recursive: true });
  await fs.writeFile(path.join(lockDir(), 'pid'), '-1', 'utf8');
  const old = new Date(Date.now() - 30_000);
  await fs.utimes(lockDir(), old, old);

  const st = await util.modelLockStatus();
  assert.equal(st.held, true);
  assert.equal(st.pid, null, 'a negative pid is not a pid');
  assert.equal(st.alive, false, 'kill(-1,0) must not be mistaken for a living holder');

  await fs.rm(lockDir(), { recursive: true, force: true });
});

test('a holder we are not allowed to signal counts as alive, not as a stale lock', async () => {
  // pid 1 (launchd) exists but is not ours: kill(1, 0) throws EPERM. Treating
  // EPERM like ESRCH rendered a live holder as "DEAD — stale lock", which
  // invites a reclaim of a lock that is genuinely in use.
  await fs.mkdir(lockDir(), { recursive: true });
  await fs.writeFile(path.join(lockDir(), 'pid'), '1', 'utf8');

  const st = await util.modelLockStatus();
  assert.equal(st.pid, 1);
  assert.equal(st.alive, true, 'EPERM means the process exists — it is simply not ours');

  await fs.rm(lockDir(), { recursive: true, force: true });
});

test('a lock dated in the future is reported as a clock anomaly, not as freshly taken', async () => {
  // An NTP step or a restored backup can leave mtime ahead of now. ageMs then
  // goes negative, `ageMs < 10_000` stays true forever, and a pid-less lock
  // that is wedged renders as a healthy holder aged 0s.
  await fs.mkdir(lockDir(), { recursive: true });
  const future = new Date(Date.now() + 3_600_000);
  await fs.utimes(lockDir(), future, future);

  const st = await util.modelLockStatus();
  assert.equal(st.held, true);
  assert.equal(st.clockSkew, true, 'a future mtime is an anomaly and must be surfaced as one');
  assert.equal(st.alive, false, 'a negative age must not pass the 10s mid-acquire window');
  assert.equal(st.heldForMs, 0, 'age must never be reported as a negative duration');

  await fs.rm(lockDir(), { recursive: true, force: true });
});

test('no lock at all reads as free rather than throwing', async () => {
  await fs.rm(lockDir(), { recursive: true, force: true });
  const st = await util.modelLockStatus();
  assert.deepEqual(st, { held: false, pid: null, alive: false, heldForMs: 0, clockSkew: false });
});

// --- The wait is a deadline, not a suggestion --------------------------------

test('a lock path that exists for mkdir but vanishes for stat must not spin', {
  // Without the fix this test does not fail an assertion — it never returns.
  // The timeout is what turns an unbounded busy loop into a red test.
  timeout: 20000,
}, async () => {
  // A dangling symlink is the cheapest honest reproduction of the race the
  // acquire loop mishandled: the name EXISTS for mkdir (EEXIST) and does NOT
  // exist for readFile or stat (ENOENT), which is precisely the state a lock
  // dir passes through while another waiter reclaims it. The old dir-vanished
  // branch went `continue` straight back to the top — no poll sleep, and, the
  // part that matters, no deadline check. maxWaitMs stopped meaning anything
  // and the loop spun a core until the process was killed. Same defect class
  // as file-lock.js F1, and the suspected cause of the 192s-against-a-30s-
  // timeout run recorded in WRITE-SAFETY-AUDIT.md.
  await fs.rm(lockDir(), { recursive: true, force: true });
  await fs.mkdir(path.dirname(lockDir()), { recursive: true });
  await fs.symlink(path.join(tmpHome, 'no-such-target'), lockDir());

  const started = Date.now();
  await assert.rejects(
    util.localInvoke('hello', { timeoutMs: 5000, lockWaitMs: 1200 }),
    /timed out waiting for local-model lock/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `acquire must give up on its deadline (took ${elapsed}ms)`);

  await fs.unlink(lockDir()).catch(() => {});
});

test('a short wait behind a live holder gives up promptly, not one poll late', async () => {
  // Guards the clamp, not the busy loop: the poll sleep is 5s and the caller
  // asked for ~1.2s, so an unclamped sleep would overshoot by 4x. A bridge
  // request that waits four times its own deadline is the hang the local-lock
  // 503 pre-check exists to avoid.
  await fs.rm(lockDir(), { recursive: true, force: true });
  await fs.mkdir(lockDir(), { recursive: true });
  // Our own pid: alive, so no staleness rule can reclaim it.
  await fs.writeFile(path.join(lockDir(), 'pid'), String(process.pid), 'utf8');

  const started = Date.now();
  await assert.rejects(
    util.localInvoke('hello', { timeoutMs: 5000, lockWaitMs: 1200 }),
    /timed out waiting for local-model lock/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1200, `must actually wait the requested time (took ${elapsed}ms)`);
  assert.ok(elapsed < 4000, `must not sleep past its own deadline (took ${elapsed}ms)`);

  await fs.rm(lockDir(), { recursive: true, force: true });
});

test('the default wait is still the 45 minutes the pipeline relies on', async () => {
  // A regression to a short default would turn a queued stage — several
  // minutes is normal — into a failed one.
  const src = await fs.readFile(new URL('../_util.js', import.meta.url), 'utf8');
  assert.match(src, /lockWaitMs = 45 \* 60 \* 1000/);
});

// --- A lock that cannot be waited for ---------------------------------------
//
// The wedge: a localInvoke abandoned mid-acquire (its test cancelled, its
// promise dropped) keeps polling. `_acquireModelLock` resolves the lock path
// ONCE at entry, so it keeps asking about a directory that teardown has since
// deleted — and the answer never changes. With the deadline check in place
// that is a QUIET 45-minute wait rather than a hot spin: the process sits idle
// in kevent, using no CPU, and node --test waits on it forever. Two runs were
// caught that way, one killed after 15 minutes.
//
// Waiting is right for a lock that is HELD. It is never right for one whose
// data root is gone, and telling those apart is the fix.

test('a lock whose data root vanishes mid-wait gives up at once, not in 45 minutes', {
  timeout: 30000,
}, async () => {
  await fs.rm(lockDir(), { recursive: true, force: true });
  await fs.mkdir(lockDir(), { recursive: true });
  // Our own pid: alive, so no staleness rule reclaims it and the loop really
  // does enter the wait rather than taking the lock immediately.
  await fs.writeFile(path.join(lockDir(), 'pid'), String(process.pid), 'utf8');

  const started = Date.now();
  const pending = util.localInvoke('hello', { timeoutMs: 5000 });
  const settled = pending.then(() => null, err => err);
  await new Promise(resolve => setTimeout(resolve, 200));
  await fs.rm(tmpHome, { recursive: true, force: true });   // the root disappears

  const err = await settled;
  const elapsed = Date.now() - started;
  assert.ok(err, 'a lock that cannot exist must not resolve');
  assert.equal(err.code, 'EMODELLOCKGONE', `expected a typed fault, got: ${err.message}`);
  assert.ok(elapsed < 25000,
    `must give up on the fault, not wait out the 45-minute deadline (took ${elapsed}ms)`);

  // Put the home back so the remaining tests and the teardown have one.
  await fs.mkdir(tmpHome, { recursive: true });
  await fs.writeFile(stubPath, '#!/bin/sh\nsleep 1\necho "gen-done pid=$$"\n', { mode: 0o755 });
});

test('and the PROCESS exits — a leaked wait is invisible from inside the test', {
  timeout: 40000,
}, async () => {
  // The assertion above proves the promise settles. It cannot prove the
  // process is free to exit, and that is the symptom that actually bit: node
  // --test runs each file in a child and waits on it, so one live handle turns
  // a passing file into a suite that never returns. Measured from outside,
  // which is the only place it is visible.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-lock-exit-'));
  await fs.mkdir(path.join(home, 'locks', 'local-model.lock'), { recursive: true });
  await fs.writeFile(path.join(home, 'locks', 'local-model.lock', 'pid'), '1', 'utf8');
  const utilUrl = new URL('../_util.js', import.meta.url).href;
  const source = `
    const { localInvoke } = await import(${JSON.stringify(utilUrl)});
    const fs = await import('node:fs/promises');
    const run = localInvoke('x', { timeoutMs: 2000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    await fs.rm(${JSON.stringify(home)}, { recursive: true, force: true });
    await run;
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, CANVAS_SYNC_HOME: home, CSYNC_LOCAL_PYTHON: stubPath },
    stdio: 'ignore',
  });
  const started = Date.now();
  const exited = await new Promise((resolve) => {
    const kill = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 30000);
    child.on('exit', () => { clearTimeout(kill); resolve(true); });
  });
  assert.ok(exited, 'the process never exited — a handle outlived the work that made it');
  assert.ok(Date.now() - started < 25000,
    `the process must not hold the suite open for its whole lock deadline (${Date.now() - started}ms)`);
  await fs.rm(home, { recursive: true, force: true });
});
