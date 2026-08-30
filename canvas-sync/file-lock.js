// file-lock.js — serialise one file's read-modify-write ACROSS PROCESSES.
//
// Node builtins only — importable from bridge/, scripts/ and app/, each of
// which has its own node_modules. Same contract as canvas-tasks.js and
// write-lock.js.
//
// WHY THIS EXISTS, and why write-lock.js is not enough. write-lock.js is a
// promise chain in one Map in one V8 heap: it serialises two HTTP requests in
// the bridge and nothing else. files_index.json is written by the bridge
// (storage.js:270→330, via /ingest/course-file) AND by the spawned
// extract-course-files stage, which is a different process — so the in-process
// lock cannot see it. Different pids also mean no temp-path collision, which
// is exactly why this one is dangerous: there is no ENOENT, no 500, no
// evidence. The loser's write simply is not there.
//
// The two directions are not symmetric, and that decided the design:
//
//   bridge over extract — a whole extraction pass reverts to the bridge's
//   snapshot. Loud and self-healing: the bridge's write leaves files_index.json
//   newer than materials/last_extracted.txt, so the stage re-runs.
//
//   extract over bridge — a file ingested mid-finalize vanishes from the index.
//   Invisible in the UI, never extracted, until some later sync happens to
//   re-upsert it. SILENT, and permanent until coincidence fixes it.
//
// The second is the one this is for: a file list that fails by looking
// complete. See WRITE-SAFETY-AUDIT.md "Site 1 — accepted design" for the
// options weighed and rejected (a route-level gate cannot work: trigger.js's
// active-stage map only knows stages the BRIDGE spawned, and
// sync-all-contexts.js spawns the same stage in its own process).
//
// LOCK THE READ-MODIFY-WRITE, NEVER THE PASS. Expected hold is one read plus
// one or two small writes. That single choice is what makes staleness
// tractable: STALE_MS sits ~1000x above the expected hold and is still bounded.
// A lock held across a minutes-long extraction would need a stale threshold
// that cannot tell "slow" from "dead" — that is the version that goes wrong.
//
// The mkdir + pid-file + tombstone-reclaim mechanics below are COPIED from the
// local-model lock in scripts/_util.js:229-302, which has already paid for
// these lessons in production. Copied, deliberately, rather than imported:
// _util.js is scripts-only and is not ours to depend on from bridge/.

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { withPathLock, lockKey } from './write-lock.js';

// Tuned for a hold measured in milliseconds. The model lock polls every 5s,
// which is right for a 45-minute hold and absurd here.
const POLL_MS = 25;
// ~1000x the expected hold, so a slow disk cannot trigger a false reclaim.
const STALE_MS = 15_000;

/**
 * Reclaim a stale lock dir atomically: rename it aside to a unique tombstone,
 * then delete the tombstone. rename is atomic, so when several waiters race
 * only one wins — the losers get ENOENT and just retry acquire.
 *
 * A plain rm-by-path here would let a slow waiter delete a lock a live winner
 * had already re-acquired. _util.js:241-250 records that lesson; it cost two
 * simultaneous 20 GB model loads to learn.
 *
 * NOT COVERED BY THE TEST SUITE, and you should know that before editing this.
 * Swapping this rename-aside for a plain rm passes all of file-lock.test.js —
 * it is the one mutation of seven that the suite cannot distinguish. The
 * discriminating case is a microsecond window between the rename and the rm,
 * and reproducing it deterministically would mean exporting this function
 * purely so a test could inject a delay into it. That was considered and
 * rejected: an internal exposed only to be slowed down is a loaded gun in the
 * API, worse than a window that is documented. So the rename is load-bearing
 * on the reasoning above and on the incident it is copied from, NOT on a
 * passing test. Treat it as verified by provenance, not by CI.
 */
async function reclaim(dir) {
  const tomb = `${dir}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.rename(dir, tomb);
  } catch (err) {
    // ENOENT is the benign case: another waiter won, or the holder released
    // cleanly. Anything else (EIO, EPERM) means the dir is STILL THERE, and the
    // caller has to know — a release that silently did nothing leaves the lock
    // behind a LIVE pid, which no staleness rule can ever clear. Swallowing
    // these was how a released lock could outlive the request that held it.
    return err?.code === 'ENOENT';
  }
  await fs.rm(tomb, { recursive: true, force: true }).catch(() => {});
  return true;
}

/**
 * Hold `lockDir` for the duration of `fn`, across every process on this
 * machine. Returns fn's value; always releases, including on throw.
 *
 * `timeoutMs` is a real deadline, not a suggestion: a caller serving an HTTP
 * request must fail fast and let the client retry, because a request held open
 * for minutes is indistinguishable from a hang.
 */
export async function withFileLock(lockDir, fn, {
  timeoutMs = 2000,
  // The caller asserting that no OTHER holder in this process is possible for
  // this lock — true only when an in-process lock already serialises the key.
  // It licenses one extra reclaim (see below) that would otherwise steal a
  // live sibling's lock, so it is opt-in rather than the default.
  inProcessExclusive = false,
} = {}) {
  const ownerFile = path.join(lockDir, 'owner.json');
  // Proves the dir we tear down at the end is the one we created, not a
  // successor a reclaiming waiter put there while we were working.
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  await fs.mkdir(path.dirname(lockDir), { recursive: true });

  /**
   * The ONLY exit from an iteration that did not acquire. Every retry funnels
   * through here on purpose.
   *
   * A `continue` that skips the deadline check and the sleep is how a retry
   * loop becomes an unbounded busy loop, and this one had three of them. Delete
   * a class dir while the bridge is serving — safe-delete does exactly that —
   * and every step fails: mkdir ENOENT, readFile ENOENT, stat ENOENT, straight
   * back to the top without sleeping and without ever looking at the deadline.
   * A pinned core, the bridge's 2s 503 unreachable, and extract's 30s fallback
   * unreachable with it, because withFileLock never threw. The contract above
   * says the deadline is real; this is what makes it true.
   */
  const waitOrGiveUp = async () => {
    if (Date.now() > deadline) {
      const err = new Error(`timed out waiting for file lock: ${lockDir}`
        + (lastError ? ` (last error: ${lastError.code || lastError.message})` : ''));
      // Typed, so a caller can tell "the lock was busy" from "the filesystem
      // failed". extract-course-files falls back to an UNLOCKED merge on this
      // code and only this code.
      err.code = 'ELOCKTIMEOUT';
      throw err;
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  };

  /** Reclaim the held dir if — and only if — its holder is provably gone. */
  const considerReclaim = async () => {
    let staleByAge = false;
    try {
      const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
      const pid = Number(owner?.pid);
      if (pid > 0) {
        // OUR OWN pid on the lock is the wreckage of an earlier release that
        // failed: when the caller guarantees in-process exclusion there cannot
        // be a live second holder here, and process.kill(self, 0) would say
        // "alive" forever, so nothing else would ever clear it.
        if (inProcessExclusive && pid === process.pid) { await reclaim(lockDir); return; }
        // EPERM means the holder EXISTS and simply is not ours to signal.
        // Only ESRCH — no such process — licenses a reclaim. Collapsing the
        // two reads a live holder as dead; _util.js:269-275 records what
        // that cost.
        let holderAlive = true;
        try { process.kill(pid, 0); } catch (err) { holderAlive = err?.code === 'EPERM'; }
        if (!holderAlive) { await reclaim(lockDir); return; }
      } else {
        staleByAge = true; // corrupt owner file — identity unknowable
      }
    } catch {
      // No owner file yet. Either the holder is between mkdir and write
      // (sub-millisecond) or it died in that gap. Age disambiguates.
      staleByAge = true;
    }
    if (staleByAge) {
      try {
        const st = await fs.stat(lockDir);
        if (Date.now() - st.mtimeMs > STALE_MS) await reclaim(lockDir);
      } catch { /* vanished — the next mkdir settles it */ }
    }
  };

  /** Tear down a lock we still own — loudly if it will not go. */
  const release = async () => {
    let ours = false;
    try {
      const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
      ours = owner?.token === token;
    } catch (err) {
      // Already gone or already reclaimed: nothing of ours to tear down.
      // Any OTHER read failure and we cannot prove it is not ours — and
      // abandoning a dir we own is precisely how one strands. Tear it down.
      if (err?.code === 'ENOENT') return;
      ours = true;
    }
    if (!ours) return;
    if (await reclaim(lockDir)) return;
    if (await reclaim(lockDir)) return;   // one retry: a transient EIO deserves it
    // Still there, holding OUR live pid — which no staleness rule can clear,
    // because process.kill(pid, 0) keeps succeeding until this process exits.
    // Drop the owner file so the age path reclaims it within STALE_MS, and say
    // so out loud: a release that quietly failed while the request reported
    // success is the silent-failure shape this module exists to prevent.
    await fs.rm(ownerFile, { force: true }).catch(() => {});
    console.error(`[file-lock] could not release ${lockDir}; dropped owner.json`
      + ` so it ages out in ${STALE_MS}ms`);
  };

  for (;;) {
    let acquired = false;
    try {
      await fs.mkdir(lockDir, { recursive: false }); // atomic: fails if held
      acquired = true;
    } catch (err) {
      lastError = err;
      // EEXIST is "held" and may be reclaimable. Anything else is an fs fault —
      // a deleted class dir, EACCES, a read-only mount — and the honest answer
      // is a bounded retry, not a guess and not a spin. Both paths fall through
      // to the same mandatory wait.
      if (err?.code === 'EEXIST') await considerReclaim();
    }

    if (!acquired) { await waitOrGiveUp(); continue; }

    await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, token, at: Date.now() }), 'utf8');
    // A waiter that judged us stale between the mkdir and the write above
    // would have renamed our dir aside and created its own. Reading our own
    // token back is what tells us the dir we hold is still ours.
    let mine = false;
    try {
      const back = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
      mine = back?.token === token;
    } catch (err) {
      // We hold a dir whose owner file we cannot read. Walking away from it
      // here is a second way to strand one, so release before retrying.
      lastError = err;
      await release();
      await waitOrGiveUp();
      continue;
    }
    // Not ours any more: someone reclaimed and re-created it. Theirs to hold,
    // so do NOT release it — just wait our turn.
    if (!mine) { await waitOrGiveUp(); continue; }

    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

/**
 * The canonical identity of one class's files_index.json.
 *
 * REALPATH, not the path as passed: a symlinked class dir would otherwise
 * yield two different names for one inode and serialise nothing. Same
 * reasoning as safe-delete rule 6 (bridge/storage.js:445). Falls back to
 * resolve() for a dir that does not exist yet, which is still better than the
 * raw string.
 */
export async function filesIndexKey(classDir) {
  // realpath is OURS to do: lockKey is sync, so it fixes relative-vs-absolute,
  // doubled separators and dot segments, but not symlink identity. This is the
  // caller write-lock.js's header has in mind when it says a caller that can be
  // handed two paths to one directory must resolve first — a spawned stage may
  // well be given a different spelling than the bridge holds.
  let real;
  try { real = await fs.realpath(classDir); } catch { real = path.resolve(classDir); }
  return lockKey('files_index', real);
}

/**
 * The lock directory guarding one class's files_index.json.
 *
 * Beside the file it guards, and that placement is load-bearing for FIXTURE
 * ISOLATION: a test fixture copies the class dir ROOT per class but symlinks
 * files/, materials/ and AI_CONTEXT/ into the real data root. A lock in the
 * class dir root is therefore per-fixture and cannot leak. A lock under
 * materials/ would write into the user's real data during a test run.
 */
export function filesIndexLockDir(classDir) {
  return path.join(classDir, '.files_index.lock');
}

/**
 * The guarded path for every files_index.json read-modify-write. Use this
 * rather than composing the two locks by hand.
 *
 * IN-PROCESS FIRST, then cross-process. Order is load-bearing: if two bridge
 * requests both reached the file lock, the loser would poll the filesystem
 * inside the same event loop for its whole deadline, burning it on contention
 * the in-process helper resolves for free. The in-process lock serialises
 * siblings; the file lock only ever arbitrates between PROCESSES.
 *
 * Both layers key off the SAME canonical string, so they cannot disagree about
 * what is being serialised.
 *
 * The lock spans a read AND a write, so this helper cannot enforce its own
 * use — a caller can still read and write unguarded. That is discipline, not a
 * guarantee; it is why the raw index writer is not the obvious thing to reach
 * for.
 */
export async function withFilesIndexLock(classDir, fn, opts = {}) {
  const key = await filesIndexKey(classDir);
  // inProcessExclusive AFTER the spread: withPathLock above makes the
  // guarantee structural, so a caller must not be able to switch it off.
  return withPathLock(key, () => withFileLock(
    filesIndexLockDir(classDir), fn, { ...opts, inProcessExclusive: true }));
}
