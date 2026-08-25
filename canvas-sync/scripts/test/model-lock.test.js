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

let tmpHome, stubPath, util;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-lock-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;

  // Stub "python": ignores its args, sleeps briefly, echoes a marker.
  stubPath = path.join(tmpHome, 'fake-generate.sh');
  await fs.writeFile(stubPath, '#!/bin/sh\nsleep 1\necho "gen-done pid=$$"\n', { mode: 0o755 });
  process.env.CSYNC_LOCAL_PYTHON = stubPath;

  // LOCAL_PYTHON is captured at module load, so env must be set before import.
  util = await import('../_util.js');
});

after(async () => {
  delete process.env.CANVAS_SYNC_HOME;
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
