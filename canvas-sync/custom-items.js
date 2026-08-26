// custom-items.js — calendar items the user creates by hand.
//
// Everything else on the calendar is DERIVED: mined from a syllabus, read from
// Canvas, or generated from a meeting pattern. These are the one kind the user
// simply types in — "Group dinner", "Advising appointment", "Study session" —
// attached to a class (so it wears that class's colour) or to no class at all
// ("personal"). They live in <data root>/calendar/custom_items.json, which
// nothing in the pipeline ever writes, for the same reason user_state.json
// exists: anything the user types must not be eaten by the next sync.
//
// The op builder lives here too, so the worklist builder, the bridge's
// optimistic create response and the tests all emit byte-identical ops.
//
// Node builtins only — the bridge and the scripts both load it.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const CUSTOM_ITEMS_FILE = 'custom_items.json';

export class CustomItemError extends Error {}

const MAX_TITLE = 300;
const MAX_DESC = 4000;
const MAX_ITEMS = 500;
// The longest span an item may cover. A 60-day "event" is a term, not an item,
// and the grid renderers draw one chip per covered day.
export const MAX_SPAN_DAYS = 60;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}$/;
// A class slug as the worklist knows it (folder minus its numeric prefix).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function itemsPath(calDir) {
  return path.join(calDir, CUSTOM_ITEMS_FILE);
}

export async function readCustomItems(calDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(itemsPath(calDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      return { version: 1, items: [] };
    }
    return { version: 1, items: parsed.items.filter(it => it && typeof it === 'object') };
  } catch {
    // Missing or corrupt reads as "the user has added nothing", which never
    // fails the calendar.
    return { version: 1, items: [] };
  }
}

async function writeCustomItems(calDir, state) {
  await fs.mkdir(calDir, { recursive: true });
  const file = itemsPath(calDir);
  // A pid is NOT unique between two concurrent requests — the bridge is one
  // process serving every route, so two mutations in flight together used the
  // same tmp path: both wrote it, the first rename moved it away, and the
  // second got ENOENT and answered 500 for a change that had in fact landed
  // (while the other answered 200 for one that had been overwritten). Random
  // per call, and cleaned up if the rename never happens.
  const tmp = `${file}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Every mutation is read-modify-write over the WHOLE file, so two of them in
// flight together lose one of the two changes even when they touch different
// items — the second write is computed from a snapshot taken before the first
// landed. There is no lock to take (the file is this module's alone), so the
// serialization is a per-path promise chain: mutations queue, reads do not.
// Cross-process safety is not claimed and is not needed — only the bridge
// writes this file, and the pipeline never does.
const MUTATION_QUEUES = new Map();
function withItemsLock(calDir, fn) {
  const key = itemsPath(calDir);
  // The stored tail never rejects, so one failed mutation cannot poison the
  // queue behind it; the caller still sees its own rejection through `run`.
  const tail = MUTATION_QUEUES.get(key) ?? Promise.resolve();
  const run = tail.then(fn);
  const settled = run.then(() => {}, () => {});
  MUTATION_QUEUES.set(key, settled);
  settled.then(() => {
    if (MUTATION_QUEUES.get(key) === settled) MUTATION_QUEUES.delete(key);
  });
  return run;
}

function str(value, max, field) {
  if (typeof value !== 'string') throw new CustomItemError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new CustomItemError(`${field} is too long (max ${max})`);
  return trimmed;
}

function realDate(value, field) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new CustomItemError(`${field} must be YYYY-MM-DD`);
  }
  // Reject 2026-02-31 and friends — the grid parses these, and an impossible
  // date silently becomes a different real one.
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
    throw new CustomItemError(`${field} is not a real date`);
  }
  return value;
}

function optionalDate(value, field) {
  return value == null ? null : realDate(value, field);
}

function optionalTime(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string' || !CLOCK.test(value)) {
    throw new CustomItemError(`${field} must be HH:MM or null`);
  }
  const [h, min] = value.split(':').map(Number);
  if (h > 23 || min > 59) throw new CustomItemError(`${field} is not a real time`);
  return value;
}

function spanDays(a, b) {
  // Noon-anchored local dates so the count survives the November DST change.
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd, 12) - new Date(ay, am - 1, ad, 12)) / 864e5);
}

/**
 * Validate and normalise one item's fields. `base` is the existing item on a
 * patch; a create passes {}. Only the fields present in `patch` are touched,
 * so the UI can send {done:true} without echoing the description.
 */
export function normalizeCustomItem(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new CustomItemError('patch must be an object');
  }
  const next = { ...base };

  if ('title' in patch) {
    const title = str(patch.title ?? '', MAX_TITLE, 'title');
    if (!title) throw new CustomItemError('title is required');
    next.title = title;
  }
  if ('class' in patch) {
    if (patch.class == null) next.class = null;
    else {
      const slug = str(patch.class, 80, 'class').toLowerCase();
      if (!SLUG_RE.test(slug)) throw new CustomItemError('class must be a class slug or null');
      next.class = slug;
    }
  }
  if ('date' in patch) next.date = realDate(patch.date, 'date');
  if ('end_date' in patch) next.end_date = optionalDate(patch.end_date, 'end_date');
  if ('time' in patch) next.time = optionalTime(patch.time, 'time');
  if ('end_time' in patch) next.end_time = optionalTime(patch.end_time, 'end_time');
  if ('description' in patch) {
    const d = patch.description == null ? '' : str(patch.description, MAX_DESC, 'description');
    if (d) next.description = d; else delete next.description;
  }
  if ('done' in patch) {
    if (typeof patch.done !== 'boolean') throw new CustomItemError('done must be a boolean');
    next.done = patch.done;
    next.doneAt = patch.done ? new Date().toISOString() : null;
  }

  // Cross-field rules, checked on the merged result so a patch cannot sneak an
  // item into a shape a create would have refused.
  if (!next.title) throw new CustomItemError('title is required');
  if (!next.date) throw new CustomItemError('date is required');
  if (next.end_date != null) {
    if (next.end_date < next.date) throw new CustomItemError('end_date is before date');
    if (next.end_date === next.date) next.end_date = null;
    else if (spanDays(next.date, next.end_date) > MAX_SPAN_DAYS) {
      throw new CustomItemError(`the span is too long (max ${MAX_SPAN_DAYS} days)`);
    }
  }
  if (next.end_time != null && next.time == null) {
    throw new CustomItemError('end_time needs a start time');
  }
  // A timed item that runs over days has to say when it stops. "Friday 9:00
  // through Sunday" names no end, and every honest rendering of it — the ICS
  // DTEND above all — would have to invent one.
  if (next.time && next.end_date && !next.end_time) {
    throw new CustomItemError('an item spanning days needs an end time');
  }
  // Same-day end before start is a typo; across days it is a real overnight.
  if (next.time && next.end_time && !next.end_date && next.end_time <= next.time) {
    throw new CustomItemError('end_time must be after time');
  }
  if (next.class === undefined) next.class = null;
  if (next.end_date === undefined) next.end_date = null;
  if (next.time === undefined) next.time = null;
  if (next.end_time === undefined) next.end_time = null;
  return next;
}

export function createCustomItem(calDir, fields) {
  return withItemsLock(calDir, () => createCustomItemLocked(calDir, fields));
}

async function createCustomItemLocked(calDir, fields) {
  const state = await readCustomItems(calDir);
  if (state.items.length >= MAX_ITEMS) {
    throw new CustomItemError(`too many custom items (max ${MAX_ITEMS})`);
  }
  const now = new Date().toISOString();
  const item = {
    ...normalizeCustomItem({}, fields),
    id: crypto.randomUUID(),
    done: false,
    doneAt: null,
    created_at: now,
    updated_at: now,
  };
  state.items.push(item);
  await writeCustomItems(calDir, state);
  return item;
}

export function patchCustomItem(calDir, id, patch) {
  return withItemsLock(calDir, () => patchCustomItemLocked(calDir, id, patch));
}

async function patchCustomItemLocked(calDir, id, patch) {
  const state = await readCustomItems(calDir);
  const i = state.items.findIndex(it => it.id === id);
  if (i < 0) return null;
  const item = {
    ...normalizeCustomItem(state.items[i], patch),
    id,
    updated_at: new Date().toISOString(),
  };
  state.items[i] = item;
  await writeCustomItems(calDir, state);
  return item;
}

export function deleteCustomItem(calDir, id) {
  return withItemsLock(calDir, () => deleteCustomItemLocked(calDir, id));
}

async function deleteCustomItemLocked(calDir, id) {
  const state = await readCustomItems(calDir);
  const before = state.items.length;
  state.items = state.items.filter(it => it.id !== id);
  if (state.items.length === before) return false;
  await writeCustomItems(calDir, state);
  return true;
}

function shortHash(...parts) {
  return crypto.createHash('sha256').update(parts.map(p => p ?? '').join('|')).digest('hex').slice(0, 8);
}

/**
 * One item as a worklist op, or null for an item that should not be one.
 *
 * The marker is `[csync:u|<uuid>|<hash>]` — 'u' for user — so the item's
 * calendar event has a stable identity across every edit: the uuid never
 * changes, and any edit changes the hash, which the ICS layer reads as UPDATE
 * rather than CREATE.
 *
 * `codeFor(slug)` turns a class slug into the course code for the title
 * prefix, the same "BUSI 380 · …" shape every other class-attached op wears;
 * personal items keep their bare title.
 */
export function customItemOp(item, { codeFor = () => null } = {}) {
  if (!item?.id || !item.title || !item.date) return null;
  const code = item.class ? codeFor(item.class) : null;
  const title = code ? `${code} · ${item.title}` : item.title;
  const descLines = [];
  if (item.description) descLines.push(item.description);
  descLines.push('Added by you in CANVASync.');
  const desc = descLines.join('\n');
  const hash = shortHash(item.title, item.date, item.end_date, item.time, item.end_time, desc);
  const marker = `[csync:u|${item.id}|${hash}]`;
  return {
    marker,
    marker_prefix: marker.slice(0, marker.lastIndexOf('|') + 1),
    calendar: 'custom',
    kind: 'personal',
    title,
    date: item.date,
    end_date: item.end_date ?? null,
    time: item.time ?? null,
    end_time: item.end_time ?? null,
    all_day: !item.time,
    description: desc,
    category: 'personal',
    // 'personal' is a reserved pseudo-class the UI gives its own colour and
    // chip; a real slug wears that class's colour like any other op.
    class: item.class ?? 'personal',
    custom_id: item.id,
    origin: 'user',
    url: null,
    submit_url: null,
  };
}

/**
 * Every item in `items` as ops, window-clipped, with drops recorded the same
 * way opsForItem records them — so Show completed can resurrect a finished
 * item and an out-of-window one is a fact rather than a disappearance.
 */
export function opsForCustomItems(items, { minIso, maxIso, drops = null, codeFor = () => null } = {}) {
  const ops = [];
  for (const item of Array.isArray(items) ? items : []) {
    const op = customItemOp(item, { codeFor });
    if (!op) continue;
    const note = (reason) => {
      if (drops) {
        drops.push({
          class: op.class,
          custom_id: item.id,
          title: item.title,
          event_title: op.title,
          kind: 'personal',
          calendar: 'custom',
          category: 'personal',
          reason,
          date: item.date,
          end_date: item.end_date ?? null,
          time: item.time ?? null,
          end_time: item.end_time ?? null,
          all_day: !item.time,
          url: null,
          submit_url: null,
          origin: 'user',
          done_at: item.doneAt ?? null,
        });
      }
    };
    if (item.done) { note('done'); continue; }
    const last = item.end_date ?? item.date;
    if (last < minIso || item.date > maxIso) { note('out_of_window'); continue; }
    ops.push(op);
  }
  return ops;
}
