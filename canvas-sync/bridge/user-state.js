// user-state.js — the part of a class that the user owns.
//
// assignments_mined.json is pipeline output: it is rewritten from scratch every
// time the AI stages re-run over a class. Anything the user types must
// therefore live somewhere else, or the next sync silently eats it. That
// somewhere is <class dir>/user_state.json, and nothing in scripts/ ever writes
// to it.
//
// Keyed by the mined item's `id`, which is a slug derived from the title and is
// stable across re-mines of the same assignment. When an id does disappear — a
// re-mine renamed it, or the assignment came off Canvas — the entry is kept,
// not pruned: an orphan row costs a few bytes, and deleting a user's note
// because a slug moved is not a trade worth making.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataRoot as syncHome } from '../data-root.js';
import { withPathLock, atomicWriteJson, lockKey } from '../write-lock.js';
import { preserveUnreadable } from './store-safety.js';

export const USER_STATE_FILE = 'user_state.json';

// Flags are colour-coded in the UI, so this list is deliberately short: the
// palette has exactly two hues to spend, and a flag nobody can distinguish at a
// glance is not a flag. 'priority' reads brass, 'blocked' reads brick.
export const FLAGS = ['none', 'priority', 'blocked'];

const MAX_NOTE = 4000;
const MAX_TITLE = 300;
const MAX_CHECKPOINTS = 50;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// A checkpoint id as the calendar knows it: a uuid for a block the user wrote,
// or "auto:5d" for one the worklist derived from the due date. The colon is why
// this is not normaliseCheckpoints' own id pattern.
const CP_ID = /^[A-Za-z0-9:_-]{1,64}$/;
const CLOCK = /^\d{2}:\d{2}$/;

export class UserStateError extends Error {}

function statePath(classDir) {
  return path.join(classDir, USER_STATE_FILE);
}

export function classDirOf(folderName) {
  return path.join(syncHome(), 'classes', folderName);
}

export async function readUserState(classDir) {
  let raw;
  try {
    raw = await fs.readFile(statePath(classDir), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { version: 1, items: {}, unreadable: false };
    return { version: 1, items: {}, unreadable: true, reason: err?.code ?? 'unreadable' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || typeof parsed.items !== 'object' || !parsed.items || Array.isArray(parsed.items)) {
      return { version: 1, items: {}, unreadable: true, reason: 'shape' };
    }
    return { version: 1, items: parsed.items, unreadable: false };
  } catch {
    // Corrupt still reads as empty for GET/class-detail callers, but the flag is
    // load-bearing for the locked read-modify-write path below.
    return { version: 1, items: {}, unreadable: true, reason: 'parse' };
  }
}

async function writeUserState(classDir, state) {
  await atomicWriteJson(statePath(classDir), {
    version: 1,
    items: state.items,
    updatedAt: new Date().toISOString(),
  });
}

// Every mutation is read-modify-write over the WHOLE class file — user_state
// holds every task under `items` — so two of them in flight together lose one
// of the two changes even when they touch DIFFERENT tasks: the second write is
// computed from a snapshot taken before the first landed.
//
// That is reachable from ordinary use, not from a stress case. The calendar
// queues its POSTs per TASK (app.js taskWriteKey is `task|folder|id`), not per
// file, so ticking two checkboxes in one class sends two concurrent PATCHes,
// and the route has no lock of its own. The user ticked two boxes, reloaded,
// and found one of them un-ticked — indistinguishable from the "tick doesn't
// stick" failure CALENDAR-SPEC 2.4 exists to prevent, and silent.
//
// The unique tmp above is not sufficient on its own, and it is worth being
// precise about why: the ENOENT it prevents was never visible to the user
// anyway. The tick site swallows the rejection (`app.js`: `await
// patchTaskState(id, {done}).catch(() => {})`) and then repaints the checkbox
// from local state, so a failed write and a successful one look identical
// until the next reload. Fixing only the tmp path would therefore not "make
// the bug silent" — it is already silent — it would merely delete the last
// trace of it from the bridge log while still losing the tick. The lost update
// is the bug; this queue is what fixes it.
//
// Mutations serialize per file; reads do not. Keyed by CLASS DIR, not by task:
// keying by task would reproduce exactly the mistake the client already makes.
// Cross-process safety is not claimed and is not needed — only the bridge
// writes this file, and the pipeline never does.
function withStateLock(classDir, fn) {
  return withPathLock(lockKey('user-state', statePath(classDir)), fn);
}

function str(value, max, field) {
  if (typeof value !== 'string') throw new UserStateError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new UserStateError(`${field} is too long (max ${max})`);
  return trimmed;
}

function optionalDate(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new UserStateError(`${field} must be YYYY-MM-DD or null`);
  }
  // Reject 2026-02-31 and friends: the calendar builder parses these, and an
  // impossible date silently becomes a different real one.
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
    throw new UserStateError(`${field} is not a real date`);
  }
  return value;
}

function optionalTime(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || !CLOCK.test(value)) {
    throw new UserStateError(`${field} must be HH:MM or null`);
  }
  const [h, min] = value.split(':').map(Number);
  if (h > 23 || min > 59) throw new UserStateError(`${field} is not a real time`);
  return value;
}

function normaliseCheckpoints(list) {
  if (!Array.isArray(list)) throw new UserStateError('checkpoints must be an array');
  if (list.length > MAX_CHECKPOINTS) {
    throw new UserStateError(`too many checkpoints (max ${MAX_CHECKPOINTS})`);
  }
  return list.map((cp, i) => {
    if (!cp || typeof cp !== 'object') throw new UserStateError(`checkpoint ${i} must be an object`);
    const title = str(cp.title ?? '', MAX_TITLE, `checkpoint ${i} title`);
    if (!title) throw new UserStateError(`checkpoint ${i} needs a title`);
    return {
      // Ids are generated here, never taken from the client: a duplicate id
      // would make two checkpoints impossible to tell apart on the next patch.
      id: typeof cp.id === 'string' && /^[a-z0-9-]{6,64}$/.test(cp.id) ? cp.id : crypto.randomUUID(),
      title,
      date: optionalDate(cp.date ?? null, `checkpoint ${i} date`),
      time: optionalTime(cp.time ?? null, `checkpoint ${i} time`),
      done: cp.done === true,
    };
  });
}

/**
 * Merge a partial patch into one task's user state and persist it.
 * Only the fields present in the patch are touched, so the UI can send
 * `{done: true}` without having to round-trip the note it is not editing.
 */
export async function patchTask(classDir, taskId, patch) {
  // Validation before the queue: a malformed patch should fail immediately and
  // must not take a turn behind a slow write it was never going to join.
  if (typeof taskId !== 'string' || !taskId || taskId.length > 200) {
    throw new UserStateError('invalid task id');
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new UserStateError('patch must be an object');
  }
  return withStateLock(classDir, () => patchTaskLocked(classDir, taskId, patch));
}

// The read-modify-write itself. Only ever called with the file's queue held —
// its `readUserState` must happen after the previous mutation's write, which
// is the whole point of the lock.
async function patchTaskLocked(classDir, taskId, patch) {
  const state = await readUserState(classDir);
  await preserveUnreadable(state, statePath(classDir));
  const current = state.items[taskId] ?? {};
  const next = { ...current };

  if ('done' in patch) {
    if (typeof patch.done !== 'boolean') throw new UserStateError('done must be a boolean');
    next.done = patch.done;
    next.doneAt = patch.done ? new Date().toISOString() : null;
  }
  if ('note' in patch) {
    const note = patch.note === null ? '' : str(patch.note, MAX_NOTE, 'note');
    if (note) next.note = note; else delete next.note;
  }
  if ('flag' in patch) {
    if (!FLAGS.includes(patch.flag)) {
      throw new UserStateError(`flag must be one of ${FLAGS.join(', ')}`);
    }
    if (patch.flag === 'none') delete next.flag; else next.flag = patch.flag;
  }
  if ('dueOverride' in patch) {
    const due = optionalDate(patch.dueOverride, 'dueOverride');
    if (due) next.dueOverride = due; else delete next.dueOverride;
  }
  if ('timeOverride' in patch) {
    const time = optionalTime(patch.timeOverride, 'timeOverride');
    if (time) next.timeOverride = time; else delete next.timeOverride;
  }
  if ('checkpoints' in patch) {
    const cps = normaliseCheckpoints(patch.checkpoints);
    if (cps.length) next.checkpoints = cps; else delete next.checkpoints;
  }
  // Ticking ONE prep block off, by id, without the client having to echo the
  // whole list back — which it cannot do for an automatic block anyway, since
  // those live nowhere but the worklist. CALENDAR-SPEC 2.9.
  if ('checkpointDone' in patch) {
    const cp = patch.checkpointDone;
    if (!cp || typeof cp !== 'object' || Array.isArray(cp)) {
      throw new UserStateError('checkpointDone must be an object');
    }
    if (typeof cp.id !== 'string' || !CP_ID.test(cp.id)) {
      throw new UserStateError('checkpointDone.id is not a checkpoint id');
    }
    if (typeof cp.done !== 'boolean') throw new UserStateError('checkpointDone.done must be a boolean');
    const list = Array.isArray(next.checkpoints) ? next.checkpoints : null;
    const own = list?.some(c => c.id === cp.id) ?? false;
    if (own) {
      // A block the user wrote records its own tick, so there is exactly one
      // place to read it from and the two cannot disagree.
      next.checkpoints = list.map(c => (c.id === cp.id ? { ...c, done: cp.done } : c));
    } else {
      const ids = new Set(Array.isArray(next.checkpointsDone) ? next.checkpointsDone : []);
      if (cp.done) ids.add(cp.id); else ids.delete(cp.id);
      if (ids.size > MAX_CHECKPOINTS) {
        throw new UserStateError(`too many completed checkpoints (max ${MAX_CHECKPOINTS})`);
      }
      if (ids.size) next.checkpointsDone = [...ids].sort(); else delete next.checkpointsDone;
    }
  }

  // An entry that says nothing is worse than no entry: it makes "has the user
  // touched this?" a two-step question everywhere downstream.
  const meaningful = next.done === true || next.note || next.flag
    || next.dueOverride || next.timeOverride || (next.checkpoints?.length ?? 0) > 0
    || (next.checkpointsDone?.length ?? 0) > 0;
  if (meaningful) state.items[taskId] = next;
  else delete state.items[taskId];

  await writeUserState(classDir, state);
  return state.items[taskId] ?? null;
}
