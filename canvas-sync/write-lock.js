// write-lock.js — serialise read-modify-write on one file, and write it in a
// way two concurrent writers cannot break.
//
// Node builtins only (crypto, fs) — importable from bridge/, scripts/ and app/,
// each of which has its own node_modules. Same contract as canvas-tasks.js.
//
// THE TWO FAILURES THIS EXISTS FOR, and they are different bugs:
//
//   1. Temp-path collision. A write of the form `${file}.tmp.${process.pid}`
//      is unique between machines and useless within one: the bridge is a
//      single process serving every route, so two requests writing one
//      destination share one temp path. Both write it, the first rename moves
//      it away, and the rest get ENOENT — a 500 for a change that may well
//      have landed. Fixed by a random suffix per call.
//
//   2. Lost update. `read, mutate, write` has an await between the read and
//      the write, and that await is a yield point. The second writer reads
//      before the first writes, then writes back a state its snapshot never
//      contained. The first change is gone, and — this is the part that
//      matters — the write REPORTS SUCCESS. Fixed only by serialising.
//
// Fixing 1 without 2 makes things worse, not better: it converts a write that
// at least failed loudly into one that returns ok and silently discards the
// change. That is not hypothetical, it is measured — user_state.json with only
// the suffix fix applied still lost one of two concurrent ticks, and reported
// both as fulfilled (2026-08-29). Use both halves together.
//
// SCOPE, stated so nobody reaches for this and believes more than it offers:
// the lock is IN-PROCESS ONLY. It is a promise chain in one Map in one V8
// heap. It does nothing about a second process writing the same file, and
// there is a live example — files_index.json is written by the bridge AND by
// the spawned extract-course-files stage. This helper does not cover that one.
// It needs a route-level gate or a real cross-process lock; see the follow-up
// item in WRITE-SAFETY-AUDIT.md.
//
// Extracted from the two hand-rolled copies that fixed this class in
// custom-items.js and bridge/user-state.js, so the pattern has one home.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Keyed by whatever the caller decides identifies "the thing being mutated".
// That choice is load-bearing and belongs to the call site, not here: a file
// path is right for a global like settings.json, but a CLASS DIRECTORY is
// right wherever one logical operation writes more than one file — the meeting
// override and its undo stash, for instance. Key those per file and one
// mutator's stash can still interleave with another's main write, which leaves
// the bug standing while looking fixed.
const QUEUES = new Map();

/**
 * Build a lock key. Use this rather than passing a path directly.
 *
 * The key is a Map key, so two spellings of one path are two queues and no
 * serialization at all — and it would report success while doing nothing,
 * which is the exact failure mode this module exists to kill. `a/b/`, `a//b`
 * and `a/c/../b` are the same file and three different strings.
 *
 * `scope` keeps two concerns on one directory apart: the meeting override and
 * the textbook links both live under a class dir, and they should not queue
 * behind each other.
 *
 * WHAT THIS NORMALIZES: relative-vs-absolute, redundant separators, `.` and
 * `..`. WHAT IT DOES NOT: symlink identity. realpath is async and this is not,
 * so two symlinks to one directory would still be two locks. That is a
 * deliberate limit rather than an oversight — resolving costs an fs call on
 * every acquisition, and the keys here name class-directory roots, which this
 * project's fixture rule copies rather than symlinks. A caller that genuinely
 * can be handed two paths to one directory must realpath before calling.
 */
export function lockKey(scope, target) {
  return `${scope}@${path.resolve(target)}`;
}

// Normalizes the path half of a `scope@path` key, so a hand-written key is as
// safe as one from lockKey(). A key with no `@` is left exactly as given:
// resolving it would make it depend on process.cwd(), and a key that changes
// when the working directory does is worse than one that is merely unnormalized.
function normalizeKey(key) {
  const raw = String(key);
  const at = raw.indexOf('@');
  if (at === -1) return raw;
  return `${raw.slice(0, at + 1)}${path.resolve(raw.slice(at + 1))}`;
}

/**
 * Run `fn` with nothing else holding `key`, and hand back what it returns.
 *
 * Mutations queue; reads do not, and that is deliberate rather than an
 * oversight to tidy up later: rename(2) is atomic, so a read racing a write
 * sees either the complete old file or the complete new one, never a torn
 * half. Serialising reads would buy nothing and would put every GET behind
 * every in-flight PUT. A read that needs a snapshot CONSISTENT WITH its own
 * write is a different matter — that one belongs inside the lock, as part of
 * the mutation that depends on it, which is how every caller here uses it.
 *
 * NOT REENTRANT. Taking the same key again inside `fn` deadlocks: the inner
 * call queues behind the outer one, which is waiting for the inner one to
 * finish. Keep the lock at the call site and let the locked body call only
 * unlocked helpers — every caller here is shaped that way, with a `…Locked`
 * function holding the work.
 */
export function withPathLock(rawKey, fn) {
  const key = normalizeKey(rawKey);
  // The stored tail never rejects, so one failed mutation cannot poison the
  // queue behind it. The caller still sees its own rejection, through `run`.
  const tail = QUEUES.get(key) ?? Promise.resolve();
  const run = tail.then(fn);
  const settled = run.then(() => {}, () => {});
  QUEUES.set(key, settled);
  // Drop the entry once this is the last waiter, so a long-lived bridge does
  // not accumulate one resolved promise per class dir it has ever touched.
  settled.then(() => {
    if (QUEUES.get(key) === settled) QUEUES.delete(key);
  });
  return run;
}

/**
 * Write `data` to `filePath` via a temp file nobody else is holding.
 *
 * The suffix is random per CALL, not per process. Cleaned up if the rename
 * never happens, so a failed write leaves no orphan next to the real file —
 * and cleaned up by path, so it can only ever remove its own temp, never a
 * concurrent writer's.
 */
export async function atomicWrite(filePath, data, options = {}) {
  const tmp = `${filePath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(tmp, data, options);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** atomicWrite for JSON, with the pretty-printing every call site was doing. */
export function atomicWriteJson(filePath, value, options = {}) {
  return atomicWrite(filePath, JSON.stringify(value, null, 2), options);
}
