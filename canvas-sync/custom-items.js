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
import { withPathLock, atomicWriteJson } from './write-lock.js';

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

/**
 * Read the store. Always answers — the calendar must render whatever happens
 * here — but says WHICH kind of nothing it found.
 *
 * Absent means the user has added nothing. Unreadable does not: the file may
 * hold fifty items this process merely failed to parse (a torn write, a
 * permission change, a bad disk). Collapsing the two is what makes a read
 * failure destructive, because every mutator writes the whole file back from
 * what it read — one unparseable read and a single "add" replaced twelve real
 * items with one, silently. Readers may ignore `unreadable`; writers must not.
 */
export async function readCustomItems(calDir) {
  let raw;
  try {
    raw = await fs.readFile(itemsPath(calDir), 'utf8');
  } catch (err) {
    // ENOENT is the only error that genuinely means "nothing added yet".
    // EACCES/EIO/EMFILE are a file that exists and could not be read.
    if (err?.code === 'ENOENT') return { version: 1, items: [], unreadable: false };
    return { version: 1, items: [], unreadable: true, reason: err?.code ?? 'unreadable' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      return { version: 1, items: [], unreadable: true, reason: 'shape' };
    }
    return {
      version: 1,
      items: parsed.items.filter(it => it && typeof it === 'object'),
      unreadable: false,
    };
  } catch {
    return { version: 1, items: [], unreadable: true, reason: 'parse' };
  }
}

/**
 * A mutation rewrites the whole file from what it just read, so an unreadable
 * store would be overwritten by whatever the empty read produced — twelve real
 * items replaced by one "add", silently, on a single EACCES or a torn write.
 *
 * Refusing outright would wedge the feature with no way out from the UI, which
 * is why the store deliberately reads as empty rather than throwing. So do
 * neither: move the unreadable file aside first. The user's data stays on disk
 * under a name that says what it is, `items: []` becomes genuinely true, and
 * the mutation proceeds. Only when it cannot be preserved does a write refuse.
 */
async function preserveUnreadable(state, calDir) {
  if (!state.unreadable) return;
  const file = itemsPath(calDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const kept = path.join(calDir, `${CUSTOM_ITEMS_FILE}.unreadable-${stamp}`);
  try {
    await fs.rename(file, kept);
  } catch (err) {
    throw new CustomItemError(
      `${CUSTOM_ITEMS_FILE} could not be read (${state.reason}) and could not be moved aside `
      + `(${err?.code ?? 'unknown'}) — refusing to overwrite it. Fix or move ${file} and try again.`,
    );
  }
}

async function writeCustomItems(calDir, state) {
  await fs.mkdir(calDir, { recursive: true });
  await atomicWriteJson(itemsPath(calDir), { ...state, updatedAt: new Date().toISOString() });
}

// Every mutation is read-modify-write over the WHOLE file, so two of them in
// flight together lose one of the two changes even when they touch different
// items — the second write is computed from a snapshot taken before the first
// landed. Keyed by the items file: one file, one logical target.
// Cross-process safety is not claimed and is not needed — only the bridge
// writes this file, and the pipeline never does.
function withItemsLock(calDir, fn) {
  return withPathLock(itemsPath(calDir), fn);
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
  await preserveUnreadable(state, calDir);
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
  await preserveUnreadable(state, calDir);
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
  await preserveUnreadable(state, calDir);
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
  // Hash the EMITTED title, not the raw one. The hash is what tells the
  // routine an event changed ("if the full marker matches exactly, skip"), so
  // anything visible on the event must be in it — and `title` subsumes both
  // item.class and the course code resolved from it. Hashing item.title alone
  // meant re-filing an item under a different class produced a byte-identical
  // marker, so the event kept its old name forever; the same defect was fixed
  // once already for user checkpoints and their parent's due date.
  const hash = shortHash(title, item.date, item.end_date, item.time, item.end_time, desc);
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
