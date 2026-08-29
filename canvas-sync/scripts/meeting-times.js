// The meeting time the syllabus field never got around to stating.
//
// cal-meetings.js builds the weekly recurrence out of one short field,
// syllabus_parsed.json course.meeting_schedule. Sometimes that field is all
// days and no clock. BUSI 380's syllabus says, in full:
//
//   "The sessions will start and end at the time scheduled and communicated by
//    the Rice Business registrar on Tuesdays and Thursdays. See the Canvas
//    website for details on the class dates, time and room location."
//
// So the field parses to 'Tuesdays and Thursdays', Canvas returns zero
// calendar_events for the course, and syllabus.html is a bare link to the PDF.
// Every lecture lands on the calendar with no time on it, and the user reports
// the calendar as broken.
//
// This module goes looking for the time the field missed, in the order the user
// would trust:
//
//   1. override     <classDir>/meeting_override.json — the user typing what
//                   they know. Always wins; nothing we infer outranks it.
//   2. syllabus     the FULL syllabus text under materials/, not just the one
//                   extracted field. Profs state the time under a heading the
//                   parser never looked at.
//   3. canvas       calendar_events.json, then pages and announcements.
//   4. inferred     recurring assignment due-times. Off unless asked for.
//
// Priority here is about how specifically a source states the WEEKLY PATTERN,
// which is not the same as how exact its timestamps are: Canvas events are
// exact to the minute but may cover only part of the term, so turning a handful
// of them into a recurrence is itself an inference. cal-meetings still consumes
// those events directly, at full trust, for the dates they actually cover — this
// module never touches that path.
//
// GOVERNING RULE: no time beats a wrong time. Every tier can return days with
// start/end null, and does so rather than guess a clock time. The traps are
// real and close by — the same BUSI 380 syllabus contains "office hours are on
// Tuesdays, 4:15-5:15PM", which the clause parser will happily read as a class
// unless it is filtered out first.
//
// Node builtins only, plus cal-meetings' parsers. All parsing of days, times and
// rooms is delegated there; what this file adds is WHERE to look, WHICH clauses
// to believe, and normalising prose into the compact shapes those parsers were
// written for.

import fs from 'node:fs/promises';
import path from 'node:path';
import { withPathLock, atomicWrite } from '../write-lock.js';
import {
  parseDayCodes, parseTimeRange, parseRoom, parseWeeklyPatterns, meetingsFromCanvasEvents, NO_CLASS_RE,
} from './cal-meetings.js';

export const OVERRIDE_FILE = 'meeting_override.json';

// Whatever the last save or clear replaced, kept so one mis-typed time or one
// stray click on "Use the syllabus instead" is a single revert away. Holds
// exactly one state — the previous one — because the failure being cured is
// "I just broke it", not "show me the history".
export const PREVIOUS_FILE = 'meeting_override.prev.json';

/** Every source recoverMeetingTimes can name, strongest first. */
export const SOURCES = ['override', 'syllabus-field', 'syllabus-text', 'canvas', 'inferred', 'none'];

// Week order taken from cal-meetings' own mapping rather than restated, so the
// two can never drift apart.
const DAY_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  .map(d => parseDayCodes(d)[0]);

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// A class is between 20 minutes and 4 hours long and starts during the day.
// "9:00-5:00" in a syllabus is an office, a building or a support line.
const MIN_MINUTES = 20;
const MAX_MINUTES = 240;
const EARLIEST_START = 6 * 60;
const LATEST_START = 22 * 60 + 30;

// ---------------------------------------------------------------------------
// Small file helpers, same shape as bridge/file-origins.js.
// ---------------------------------------------------------------------------

// A file that is absent and a file that is corrupt mean different things to the
// user: one is a class that was never synced, the other is a sync that half
// finished. Collapsing both to null makes a truncated syllabus_parsed.json read
// exactly like a class with nothing on disk, which is the silent failure this
// module is supposed to be the cure for.
async function readJson(p) {
  let text;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    return { value: null, unreadable: false };
  }
  try {
    return { value: JSON.parse(text), unreadable: false };
  } catch {
    return { value: null, unreadable: true };
  }
}

async function readTextOrNull(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

function asArray(v) { return Array.isArray(v) ? v : []; }

function minutesOf(hhmm) {
  const m = HHMM_RE.exec(String(hhmm ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function trimText(s, max = 200) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// Prose normalisation.
//
// cal-meetings' day matcher was written for the compact forms a meeting_schedule
// field uses — "MWF", "TR", "Mon/Wed". Body prose does not talk that way: it
// says "Tuesdays and Thursdays", and the matcher reads neither the plural nor
// the "and". Rather than duplicate the day mapping here, rewrite the prose into
// the shape the existing parsers already handle and hand it straight over.
// ---------------------------------------------------------------------------

const DAY_WORD = '(?:sun|mon|tues|wed(?:nes)?|thurs?|fri|satur)day';
const PLURAL_DAY_RE = new RegExp(`\\b(${DAY_WORD})s\\b`, 'gi');
const DAY_CONJ_RE = new RegExp(`\\b(${DAY_WORD})\\s*(?:,\\s*)?(?:and|&|\\+)\\s+(${DAY_WORD})\\b`, 'gi');
const DAY_SPAN_RE = new RegExp(`\\b(${DAY_WORD}(?:\\s*[,\\/&]\\s*${DAY_WORD})*)\\b`, 'i');

// A compact run is only believed when EVERY character is a day letter — "TBD"
// otherwise reads as Tuesday, and a course whose time is literally To Be
// Determined would get one invented for it.
const COMPACT_DAYS_RE = /^(?:Su|Sa|Th|Tu|M|T|W|R|F|S|U){2,7}$/;

// "M/W 2:30-3:45pm" — BUSI 374's real field. The compact matcher stops at the
// slash and reads Monday alone, putting half the week's lectures nowhere. Close
// the run up before handing it over. Case-sensitive, so a lowercase "w/" stays
// the word "with".
const COMPACT_DAY = '(?:Th|Tu|Su|Sa|[MTWRFSU])';
const SLASHED_DAYS_RE = new RegExp(`\\b(${COMPACT_DAY}(?:\\s*/\\s*${COMPACT_DAY})+)\\b`, 'g');

function closeUpSlashedDays(run) {
  const joined = run.replace(/[\s/]/g, '');
  // "S/U" is satisfactory/unsatisfactory grading, not Sunday.
  return joined === 'SU' || joined === 'US' ? run : joined;
}

function normaliseDayProse(text) {
  let s = String(text ?? '')
    .replace(PLURAL_DAY_RE, '$1')
    .replace(SLASHED_DAYS_RE, closeUpSlashedDays);
  // "Monday, Wednesday and Friday" needs two passes; the /g scan consumes the
  // second day of each pair, so the next conjunction is only seen on a re-run.
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(DAY_CONJ_RE, '$1/$2');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Days named in a clause, with no time attached. [] when none are stated. */
function daysOnlyFrom(text, { allowCompact = false } = {}) {
  const s = normaliseDayProse(text);
  const span = DAY_SPAN_RE.exec(s);
  if (span) return parseDayCodes(span[1]);
  if (!allowCompact) return [];
  for (const token of s.split(/[^A-Za-z]+/)) {
    if (COMPACT_DAYS_RE.test(token)) {
      const codes = parseDayCodes(token);
      if (codes.length) return codes;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Which clauses are allowed to name a class time.
// ---------------------------------------------------------------------------

// Something that has a day and a time but is not a class meeting. Office hours
// are the dangerous one: they sit two paragraphs from the meeting schedule, name
// a weekday and a time range, and parse perfectly.
const NOT_A_CLASS_RE = new RegExp([
  'office\\s*hours?', '\\bby\\s+appointment\\b', '\\bdue\\b', '\\bdeadline',
  '\\bsubmit', '\\bturn\\s+(?:it|them|in)\\b', '\\bposted\\b', '\\bdistributed\\b',
  '\\bcloses?\\b', '\\bopens?\\b', '\\bavailable\\s+(?:at|from|until)\\b',
  '\\bexams?\\b', '\\bmidterms?\\b', '\\bquiz', '\\bholiday', '\\brecess\\b',
  '\\btutor', '\\bhelp\\s+desk\\b',
  '\\bstudy\\s+(?:group|session|hall)', '\\breview\\s+session',
  // The no-class clauses come from cal-meetings so the module that admits
  // schedule ROWS and the module that admits schedule PROSE cannot drift into
  // disagreeing about what "No class" means — they already had, and BUSI 380's
  // "No class. Students work on Group Midterm Case" became a class meeting.
  NO_CLASS_RE.source,
].join('|'), 'i');

// A single dated occurrence, stated in the same grammar as the weekly pattern.
// "A review session will be held Thursday 5:00-6:30 PM" and "a guest lecture on
// Friday 4:00-5:00 PM" both name a session, a weekday and a class-length span,
// and both parse into a perfectly formed recurrence that puts the student in an
// empty room every week. The weekly reading has to be refused outright: unlike a
// missing time, a wrong one gives the user nothing to notice.
const ONE_OFF_RE = new RegExp([
  '\\breview\\b', '\\bguest\\b', '\\bvisitor', '\\bspeaker',
  '\\bmake-?\\s?up\\b', '\\bdrop-?\\s?in\\b', '\\bone-?\\s?(?:time|off)\\b',
  '\\boptional\\b', '\\bvoluntary\\b', '\\bextra\\s+(?:session|class|credit)',
  '\\brescheduled?\\b', '\\bspecial\\s+(?:session|class|lecture)',
  '\\b(?:first|last|final)\\s+(?:class|session|lecture|meeting|day)\\b',
  '\\borientation\\b', '\\bpresentation\\s+day', '\\bcapstone\\s+day',
].join('|'), 'i');

// The meeting_schedule field is an LLM extraction, not a registrar record, and
// what it hands back is sometimes the wrong line off the page — BUSI 396's
// syllabus states no class time at all and does state "Office Hours: M/W/F
// 11:30 - 1:30", which as a field parses into the most confident answer this
// module can give. A field is one short string, so an appointment word in it is
// not an aside the way it is in prose: it disqualifies the whole field.
//
// Exception notes are deliberately NOT in this list. "MW 8:00-9:15 (no class
// Sep 7)" is a field that is otherwise exactly right, and refusing it would
// trade a rare wrong answer for a common missing one.
const MISLABELLED_FIELD_RE = new RegExp([
  'office\\s*hours?', '\\bby\\s+appointment\\b', '\\bexams?\\b', '\\bmidterms?\\b',
  '\\bquiz', '\\bdue\\b', '\\bdeadline', '\\btutor', '\\bhelp\\s+desk\\b',
  '\\bstaffed\\b', '\\breview\\s+session', '\\bdrop-?\\s?in\\b',
  '\\bstudy\\s+(?:group|session|hall)',
].join('|'), 'i');

// Some word in the clause has to be about a session the student attends.
const SESSION_CUE_RE =
  /\b(?:class(?:es)?|course|lecture|lab|laboratory|section|recitation|studio|workshop|seminar|discussion|session|meeting)s?\b/i;

// …and for a DAYS-ONLY reading, where there is no time to sanity-check, the
// clause has to actually be about when the thing happens.
const MEETS_RE =
  /\b(?:class(?:es)?|course|lecture|lab|section|seminar|session)s?\b[^.;]{0,80}?\b(?:meets?|meeting|start(?:s)?|begins?|held|convenes?|takes\s+place|run(?:s)?)\b/i;

// cal-meetings' room matcher reads "LETTERS digits" as a room code, and the
// commonest field shape in the corpus — "MW 10:00-11:15", "TR 10:50-12:05" —
// hands it a day run followed by an hour. The user is then told to go to room
// "MW 10". The tell is that the digits it took are the start of a clock, so look
// at what follows them in the source text rather than guessing from the shape:
// "MCN 317" ends there, "MW 10" is followed by ":00".
function cleanRoom(location, { source, full, start } = {}) {
  if (!location) return null;
  const text = `${full ?? ''} ${source ?? ''}`;
  const escaped = location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  if (new RegExp(`${escaped}\\s*[:.]\\s*\\d`).test(text)) return null;
  // Belt and braces for a room read straight out of the field, where the clock
  // may have been reformatted before we see it.
  const m = /^([A-Za-z]{1,7})\s*(\d{1,2})$/.exec(location);
  if (m && COMPACT_DAYS_RE.test(m[1]) && Number(m[2]) === Number(String(start ?? '').slice(0, 2))) {
    return null;
  }
  return location;
}

function plausibleClassTime(start, end) {
  const a = minutesOf(start);
  const b = minutesOf(end);
  if (a === null || b === null) return false;
  if (a < EARLIEST_START || a > LATEST_START) return false;
  const span = b - a;
  return span >= MIN_MINUTES && span <= MAX_MINUTES;
}

const HEADING_MAX = 60;

/** Split text into the clauses a schedule statement could live in. */
function clausesOf(text) {
  const out = [];
  const push = (block) => {
    // Never split on an abbreviation's period — "M.W.F." is one token.
    for (const clause of block.split(/;\s*|(?<=[a-z0-9)])[.!?]\s+/)) {
      const s = clause.trim();
      if (s) out.push(s);
    }
  };
  for (const para of String(text ?? '').split(/\n\s*\n+/)) {
    // PDF extraction wraps mid-sentence, so a paragraph is one logical line.
    const lines = para.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
    if (!lines.length) continue;
    const whole = lines.join(' ');
    // A short unpunctuated first line is a section heading the extractor glued
    // to the body — "Class Session Time", "Class Meeting Times". Read the body
    // without it FIRST, so the session word that names the pattern is the body's
    // own ("Lectures MW 8:00-9:15") and not the heading's ("Class"). Then read
    // the block whole, for the syllabus whose heading carries the only cue that
    // the line underneath is about class at all.
    const headed = lines.length > 1 && lines[0].length <= HEADING_MAX && !/[.:;!?]$/.test(lines[0]);
    if (headed) push(lines.slice(1).join(' '));
    push(whole);
  }
  return out;
}

/**
 * Weekly patterns stated in one clause of free text, or [] when the clause is
 * not about class or its time is not class-shaped.
 */
function patternsFromClause(clause) {
  if (NOT_A_CLASS_RE.test(clause) || ONE_OFF_RE.test(clause)) return [];
  if (!SESSION_CUE_RE.test(clause)) return [];
  const found = parseWeeklyPatterns(normaliseDayProse(clause));
  const kept = found
    .filter(p => plausibleClassTime(p.start, p.end))
    .map(p => ({ ...p, location: cleanRoom(p.location, p) }));
  if (!kept.length) return [];
  const original = trimText(clause, 200);
  // One pattern out of one clause: show the user the sentence they wrote, not
  // the normalised rewrite. Several patterns came from sub-clauses the parser
  // split for itself, so leave its own provenance alone.
  return kept.map(p => ({ ...p, source: kept.length === 1 ? original : p.source, full: original }));
}

function makePattern({ label = 'Class', byday, start = null, end = null, location = null, source, full }) {
  return { label, byday, start, end, location, source, full: full ?? source };
}

function dedupePatterns(patterns) {
  const seen = new Set();
  const out = [];
  for (const p of patterns) {
    if (!p?.byday?.length) continue;
    // Keyed on the slot, not the label: the same clause read with and without
    // its heading yields the same meeting under two names, and the first
    // reading — the one that saw the body alone — has the better name.
    const key = `${p.byday.join('')}|${p.start ?? ''}|${p.end ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The user's override.
// ---------------------------------------------------------------------------

function sortDays(codes) {
  return [...new Set(codes)].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
}

// The override is the user deliberately typing day codes, so a lone "F" is
// meaningful here in a way it is not out in prose — but the token still has to
// be day letters end to end. "TBD" must not read as Tuesday. The two-letter
// canonical codes are listed explicitly: MO, WE, FR and SU are the shape this
// module hands back, and their second letters are not day letters on their own.
const OVERRIDE_DAY_RE =
  /^(?:sun|mon|tues|tue|wed|thurs|thur|thu|sat|su|mo|tu|we|th|fr|sa|m|t|w|r|f|s|u){1,7}$/i;
const SPELLED_DAY_RE = new RegExp(`^${DAY_WORD}$`, 'i');
const CONNECTOR_RE = /^(?:and|or|&|\+|-|,)$/i;

function normaliseDays(raw) {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : null);
  if (!list || !list.length) return null;
  const out = [];
  for (const entry of list) {
    if (typeof entry !== 'string') return null;
    const tokens = normaliseDayProse(entry).split(/[\s,\/&]+/).filter(Boolean);
    if (!tokens.length) return null;
    for (const token of tokens) {
      if (CONNECTOR_RE.test(token)) continue;
      if (!SPELLED_DAY_RE.test(token) && !OVERRIDE_DAY_RE.test(token)) return null;
      const codes = parseDayCodes(token);
      if (!codes.length) return null;
      out.push(...codes);
    }
  }
  return out.length ? sortDays(out) : null;
}

/**
 * Validate a raw override object. Returns { override, warnings }; `override` is
 * null whenever the file cannot be trusted at all. Times are all-or-nothing and
 * are dropped — never repaired — when they do not validate, because a repaired
 * time is exactly the confidently wrong time this module exists to avoid.
 */
function validateOverride(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { override: null, warnings: [`${OVERRIDE_FILE} is not an object — ignoring it.`] };
  }
  const days = normaliseDays(raw.days);
  if (!days) {
    return { override: null, warnings: [`${OVERRIDE_FILE} has no readable days — ignoring it.`] };
  }

  let start = null;
  let end = null;
  const hasStart = raw.start !== undefined && raw.start !== null && raw.start !== '';
  const hasEnd = raw.end !== undefined && raw.end !== null && raw.end !== '';
  if (hasStart || hasEnd) {
    const okShape = typeof raw.start === 'string' && typeof raw.end === 'string'
      && HHMM_RE.test(raw.start) && HHMM_RE.test(raw.end);
    if (okShape && minutesOf(raw.end) > minutesOf(raw.start)) {
      start = raw.start;
      end = raw.end;
    } else {
      warnings.push(`${OVERRIDE_FILE}: start and end must both be HH:MM with end after start — keeping the days only.`);
    }
  }

  const str = (v, max) => (typeof v === 'string' && v.trim() ? trimText(v, max) : null);
  return {
    override: {
      version: 1,
      days,
      start,
      end,
      location: str(raw.location, 80),
      label: str(raw.label, 40),
      note: str(raw.note, 200),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    },
    warnings,
  };
}

async function loadOverride(classDir) {
  const file = path.join(classDir, OVERRIDE_FILE);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { override: null, warnings: [] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { override: null, warnings: [`${OVERRIDE_FILE} is not valid JSON — ignoring it.`] };
  }
  return validateOverride(raw);
}

/** The user's saved meeting time, or null when absent or unusable. */
export async function readMeetingOverride(classDir) {
  const { override } = await loadOverride(classDir);
  return override;
}

function writeJsonAtomic(file, value) {
  // Trailing newline preserved — these files are read by humans and diffed.
  return atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Serialise the three mutators against each other, per CLASS.
 *
 * Keyed by the class dir and NOT by file, which matters here more than
 * anywhere else in this conversion: every one of the three mutators writes TWO
 * files for one logical operation — the override itself and its undo stash.
 * Lock per file and one mutator's stash can still interleave with another's
 * main write, which leaves the exact bug standing while looking fixed: a
 * double-clicked "use the syllabus instead" lets the second clear read an
 * override the first has already unlinked, stash `previous: null`, and destroy
 * the undo target the first one just recorded. Neither the clear control nor
 * the save form has a double-click guard, so that is one impatient click away.
 *
 * Only the bridge calls these (server.js's meeting routes); nothing in the
 * pipeline mutates an override. So an in-process lock is the whole fix, not
 * half of one.
 */
function withMeetingLock(classDir, fn) {
  return withPathLock(`meeting:${classDir}`, fn);
}

async function stashPrevious(classDir, previous, action) {
  await writeJsonAtomic(path.join(classDir, PREVIOUS_FILE), {
    version: 1,
    action,
    replacedAt: new Date().toISOString(),
    previous,
  });
}

/**
 * What revert would restore, or null when there is nothing to go back to.
 * `previous` is the validated earlier override, or null meaning "no override
 * — back to whatever the syllabus and Canvas say". A stash whose override no
 * longer validates is unusable and reads as no stash at all: restoring
 * garbage is the accident this file exists to undo, not a way to perform it.
 */
export async function readMeetingRevert(classDir) {
  const { value } = await readJson(path.join(classDir, PREVIOUS_FILE));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // The key has to be present: a stash that never says what came before must
  // not read as "nothing did" — reverting on that would delete an override
  // the stash knows nothing about.
  if (!('previous' in value)) return null;
  const meta = {
    action: typeof value.action === 'string' ? value.action : null,
    replacedAt: typeof value.replacedAt === 'string' ? value.replacedAt : null,
  };
  if (value.previous === null) return { ...meta, previous: null };
  const { override } = validateOverride(value.previous);
  return override ? { ...meta, previous: override } : null;
}

/**
 * Swap the override with the stashed previous state. Returns what was
 * restored ({ previous, action, replacedAt } as readMeetingRevert shapes it),
 * or null when there is nothing usable to revert to. The state that was just
 * replaced becomes the new stash, so a revert is itself revertible — a second
 * revert is redo, and no click here can strand the user.
 */
export function revertMeetingOverride(classDir) {
  return withMeetingLock(classDir, () => revertMeetingOverrideLocked(classDir));
}

async function revertMeetingOverrideLocked(classDir) {
  const stash = await readMeetingRevert(classDir);
  if (!stash) return null;
  const current = await readMeetingOverride(classDir);
  if (stash.previous) {
    // Restored verbatim, original updatedAt included — it is the record of
    // when the user actually typed this, and reverting is not retyping.
    await writeJsonAtomic(path.join(classDir, OVERRIDE_FILE), stash.previous);
  } else {
    try { await fs.unlink(path.join(classDir, OVERRIDE_FILE)); } catch { /* already absent */ }
  }
  await stashPrevious(classDir, current, 'revert');
  return stash;
}

/**
 * Short label for the revert control, or null when `stash` is null. Says what
 * clicking it restores — an undo that does not say where it lands is the same
 * gamble as the mistake it undoes.
 */
export function describeRevertTarget(stash) {
  if (!stash) return null;
  if (!stash.previous) return 'undo — back to the syllabus';
  const p = patternsFromOverride(stash.previous)[0];
  const days = formatDays(p.byday);
  const range = formatRange(p.start, p.end);
  return `undo — back to ${days}${range ? ` ${range}` : ' (days only)'}`;
}

/**
 * Merge `patch` into the saved override and write it back. An explicit null
 * clears a field, so { start: null, end: null } drops the time and keeps the
 * days. Throws on anything that would store a time we cannot stand behind —
 * this is a user typing, and silently discarding what they typed reads to them
 * as the feature being broken.
 */
export function writeMeetingOverride(classDir, patch = {}) {
  return withMeetingLock(classDir, () => writeMeetingOverrideLocked(classDir, patch));
}

async function writeMeetingOverrideLocked(classDir, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('writeMeetingOverride: patch must be an object');
  }
  const current = await readMeetingOverride(classDir);
  const merged = { ...(current ?? {}) };
  for (const key of ['days', 'start', 'end', 'location', 'label', 'note']) {
    if (!(key in patch)) continue;
    if (patch[key] === null) merged[key] = null;
    else merged[key] = patch[key];
  }

  if (!normaliseDays(merged.days)) {
    throw new TypeError('writeMeetingOverride: days must be day codes, e.g. ["TU","TH"]');
  }
  const hasStart = merged.start !== undefined && merged.start !== null && merged.start !== '';
  const hasEnd = merged.end !== undefined && merged.end !== null && merged.end !== '';
  if (hasStart !== hasEnd) {
    throw new TypeError('writeMeetingOverride: set start and end together, or neither');
  }
  // validateOverride's warnings are written for the LOAD path — they name the
  // file and say what was salvaged from it ("meeting_override.json: … —
  // keeping the days only"). Reaching a person who is typing into a form,
  // that text names a file they have never heard of and describes a salvage
  // that did not happen: a rejected save keeps nothing, it saves nothing. So
  // the write path states its own terms. (Invisible until the bridge started
  // forwarding the reason to the editor — the branch that showed it was
  // unreachable, so this read fine in a unit test and nowhere else.)
  const { override } = validateOverride(merged);
  if (!override) {
    throw new TypeError('writeMeetingOverride: those days are not ones I can read — use day codes like TU, TH');
  }
  if (hasStart && !override.start) {
    // validateOverride collapses "not a clock at all" and "end not after
    // start" into one branch, which is fine when it is salvaging a file but
    // useless as advice: told "the end must come after the start" about
    // 25:00, a user checks the order and finds nothing wrong with it.
    const badClock = !HHMM_RE.test(String(merged.start)) || !HHMM_RE.test(String(merged.end));
    throw new TypeError(badClock
      ? 'writeMeetingOverride: a start and end must be times on a 24-hour clock, like 14:30'
      : 'writeMeetingOverride: the end time has to come after the start time');
  }

  // Never create the class directory. A typo in the class id would otherwise
  // leave a phantom class holding nothing but the time the user typed, in a
  // directory no sync will ever fill and no dashboard will ever show.
  let stat = null;
  try {
    stat = await fs.stat(classDir);
  } catch { /* reported just below */ }
  if (!stat?.isDirectory()) {
    throw new TypeError(`writeMeetingOverride: no class directory at ${classDir}`);
  }

  // Whatever stood before this save — an earlier override, or nothing —
  // becomes the revert target. A save that changes no field keeps the old
  // stash: pressing Save twice must not turn "undo" into a restatement of
  // what is already there.
  const unchanged = current && ['days', 'start', 'end', 'location', 'label', 'note']
    .every(k => JSON.stringify(current[k] ?? null) === JSON.stringify(override[k] ?? null));
  if (!unchanged) await stashPrevious(classDir, current, 'set');

  override.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(classDir, OVERRIDE_FILE), override);
  return override;
}

/** Forget the override. True when a file was actually removed. */
export function clearMeetingOverride(classDir) {
  return withMeetingLock(classDir, () => clearMeetingOverrideLocked(classDir));
}

async function clearMeetingOverrideLocked(classDir) {
  // Stash what is being cleared first: "Use the syllabus instead" clicked by
  // mistake must not eat a time the user typed.
  //
  // A file too corrupt to read back cannot be restored, but it must still be
  // RECORDED as cleared: leaving an older stash in place made undo offer a
  // state the user never left (and had no idea was on the record), which is
  // worse than offering nothing. `previous: null` is the honest target —
  // "back to the syllabus" — and it is what writeMeetingOverride already
  // stashes when nothing readable stood before.
  const current = await readMeetingOverride(classDir);
  let existed = false;
  try {
    await fs.stat(path.join(classDir, OVERRIDE_FILE));
    existed = true;
  } catch { /* nothing there — the unlink below decides the return value */ }
  try {
    await fs.unlink(path.join(classDir, OVERRIDE_FILE));
  } catch {
    return false;
  }
  if (current || existed) await stashPrevious(classDir, current, 'clear');
  return true;
}

function patternsFromOverride(override) {
  return [makePattern({
    label: override.label ?? 'Class',
    byday: override.days,
    start: override.start,
    end: override.end,
    location: override.location,
    source: override.note ? `you: ${override.note}` : `${OVERRIDE_FILE} (set by you)`,
  })];
}

// ---------------------------------------------------------------------------
// 2. The syllabus — its one extracted field, then its whole text.
// ---------------------------------------------------------------------------

const SYLLABUS_NAME_RE = /syllab(us|i)/i;

// A table cell is one logical block, however many <p>s the editor put inside
// it. ENTR 222's Canvas home page states the whole meeting in a single <td>:
//
//   <p><strong>Section 001</strong></p><p>TTh</p>
//   <p>10:50 AM - 12:05 PM</p><p>Cambridge Office Building 130 - Liu Idea Lab</p>
//
// Turning each </p> into a newline left a blank line between them (the source
// indents, so the intervening line is not empty), clausesOf split on the blank
// lines, and the days, the time and the ROOM ended up in three unrelated
// clauses — none of which holds a day AND a time, so the one page in the whole
// data root that names a classroom yielded nothing at all. Cells are joined
// with " | " instead, and only </tr> ends the line.
const TABLE_CELL_RE = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
const CELL_BREAK_RE = /<br\s*\/?>|<\/(?:p|div|li|h[1-6])>/gi;

function stripHtml(html) {
  const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&amp;': '&', '&nbsp;': ' ' };
  return String(html ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(TABLE_CELL_RE, (_, cell) => ` ${cell.replace(CELL_BREAK_RE, ' ')} | `)
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/[ \t]+/g, ' ');
}

/**
 * The syllabus as text: whatever extract-course-files wrote under materials/,
 * plus the Canvas syllabus box. syllabus.html counts as syllabus text rather
 * than a Canvas signal — it is the same document, just typed into Canvas.
 */
async function readSyllabusText(classDir, maxBytes) {
  const parts = [];
  let names = [];
  try {
    names = await fs.readdir(path.join(classDir, 'materials'));
  } catch { /* no materials extracted yet */ }
  const picked = names
    .filter(n => n.toLowerCase().endsWith('.txt') && n !== '_combined.txt' && SYLLABUS_NAME_RE.test(n))
    .sort();
  for (const name of picked) {
    const text = await readTextOrNull(path.join(classDir, 'materials', name));
    if (text) parts.push(text);
  }
  const html = await readTextOrNull(path.join(classDir, 'syllabus.html'));
  if (html) parts.push(stripHtml(html));
  const joined = parts.join('\n\n');
  return joined.length > maxBytes ? joined.slice(0, maxBytes) : joined;
}

function scanTextForPatterns(text) {
  const out = [];
  for (const clause of clausesOf(text)) out.push(...patternsFromClause(clause));
  return dedupePatterns(out);
}

/**
 * The first room stated by a clause that is about class, ignoring the time.
 *
 * Room lookup used to be welded to time lookup: parseClause only reads a room
 * out of the same clause that gave it the day AND the time, and the chain stops
 * at the first source that states a time. ENTR 222's field states the time and
 * no room, so the chain returned at step 2a and the one file in the whole data
 * root that names its classroom — the Canvas home page — was never opened.
 */
function scanTextForRoom(text) {
  for (const clause of clausesOf(text)) {
    if (NOT_A_CLASS_RE.test(clause) || ONE_OFF_RE.test(clause)) continue;
    if (!SESSION_CUE_RE.test(clause)) continue;
    // allowCode off: out in prose, "BUSI 374" is the course, not the room.
    const room = cleanRoom(parseRoom(clause, { allowCode: false }), { full: clause });
    if (room) return { location: room, source: trimText(clause, 200) };
  }
  return null;
}

function scanBodiesForRoom(entries, bodyKeys) {
  for (const entry of asArray(entries)) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of bodyKeys) {
      const body = entry[key];
      if (typeof body !== 'string' || !body) continue;
      const found = scanTextForRoom(stripHtml(body));
      if (found) return found;
    }
  }
  return null;
}

/** Days with no time, from a clause that is unmistakably about when class meets. */
function scanTextForDays(text) {
  for (const clause of clausesOf(text)) {
    if (NOT_A_CLASS_RE.test(clause) || ONE_OFF_RE.test(clause) || !MEETS_RE.test(clause)) continue;
    const days = daysOnlyFrom(clause);
    if (days.length) {
      return [makePattern({
        byday: days,
        location: cleanRoom(parseRoom(clause, { allowCode: false }), { full: clause }),
        source: trimText(clause, 200),
      })];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// 3. Canvas.
// ---------------------------------------------------------------------------

const MIN_EVENTS_FOR_PATTERN = 2;

function weekdayOf(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : DAY_ORDER[d.getDay()];
}

/**
 * A weekly recurrence out of Canvas's own course events. Times come back in the
 * process's local zone, the same zone the calendar is written in, so a recovered
 * pattern reads the same as the events the sync already produces.
 */
function patternsFromCanvasEvents(events) {
  const buckets = new Map();
  for (const m of meetingsFromCanvasEvents(events)) {
    if (!m.start || !m.end) continue;
    const weekday = weekdayOf(m.date);
    if (!weekday) continue;
    const key = `${m.start}-${m.end}`;
    const bucket = buckets.get(key) ?? { start: m.start, end: m.end, days: new Set(), rooms: new Map(), count: 0 };
    bucket.days.add(weekday);
    bucket.count += 1;
    if (m.location) bucket.rooms.set(m.location, (bucket.rooms.get(m.location) ?? 0) + 1);
    buckets.set(key, bucket);
  }
  const out = [];
  for (const bucket of buckets.values()) {
    // One event is a date, not a recurrence.
    if (bucket.count < MIN_EVENTS_FOR_PATTERN) continue;
    if (!plausibleClassTime(bucket.start, bucket.end)) continue;
    const room = [...bucket.rooms.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.push(makePattern({
      byday: sortDays([...bucket.days]),
      start: bucket.start,
      end: bucket.end,
      location: room,
      source: `Canvas course events (${bucket.count})`,
    }));
  }
  return dedupePatterns(out);
}

/** Canvas's "that page has been disabled" envelope, which arrives as a list. */
function isCanvasRefusal(value) {
  const list = asArray(value);
  return list.length > 0
    && list.every(e => e && typeof e === 'object' && typeof e.message === 'string' && !('body' in e) && !('title' in e));
}

function scanCanvasBodies(entries, bodyKeys) {
  const out = [];
  for (const entry of asArray(entries)) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of bodyKeys) {
      const body = entry[key];
      if (typeof body !== 'string' || !body) continue;
      out.push(...scanTextForPatterns(stripHtml(body)));
    }
  }
  return dedupePatterns(out);
}

// ---------------------------------------------------------------------------
// 4. Assignment-due inference. Weakest, opt-in, and always 'low'.
// ---------------------------------------------------------------------------

const MIN_DUE_SAMPLES = 3;
const DUE_MAJORITY = 0.5;

/**
 * Work is often due "at the start of class", so a due-time that repeats across
 * most of the term on the days class meets is a hint about the class hour. It
 * is only ever a hint: the duration is unknowable, so `end` stays null, and the
 * days are narrowed to the ones we already know class meets.
 *
 * Which is also why there is nothing to infer when no source named the days.
 * A deadline is evidence about a deadline; on its own it says only that the
 * professor set one, not that anybody was in a room. BUSI 396 has no stated
 * meeting time and eighteen assignments due at 09:00 on Mondays, Wednesdays and
 * Fridays, and an inference from those alone hands the user a fully formed
 * "MWF 9:00 class" that no document anywhere claims exists.
 */
function inferPatternsFromDue(assignments, knownDays) {
  if (!knownDays.length) return [];
  const buckets = new Map();
  let total = 0;
  for (const a of asArray(assignments)) {
    const due = a?.due_at ?? a?.due ?? null;
    if (typeof due !== 'string') continue;
    const d = new Date(due);
    if (Number.isNaN(d.getTime())) continue;
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const weekday = DAY_ORDER[d.getDay()];
    const bucket = buckets.get(hhmm) ?? { days: new Set(), count: 0 };
    bucket.days.add(weekday);
    bucket.count += 1;
    buckets.set(hhmm, bucket);
    total += 1;
  }
  if (!total) return [];
  const [time, best] = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  if (best.count < MIN_DUE_SAMPLES || best.count / total < DUE_MAJORITY) return [];
  const minutes = minutesOf(time);
  if (minutes === null || minutes < EARLIEST_START || minutes > LATEST_START) return [];

  const byday = sortDays([...best.days]).filter(d => knownDays.includes(d));
  if (!byday.length) return [];
  return [makePattern({
    byday,
    start: time,
    end: null,
    source: `inferred from ${best.count} of ${total} assignments due at ${time}`,
  })];
}

// ---------------------------------------------------------------------------
// The recovery itself.
// ---------------------------------------------------------------------------

// Two patterns with different labels are a lecture and its lab, and downstream
// patternFor can tell them apart. Two with the SAME label are two sections of
// one course — "Section 001 meets MW 8:00-9:15. Section 002 meets TR 1:00-2:15"
// — and only the registrar knows which one the student is in. Taking both puts
// four lectures a week on a calendar for a class that meets twice, so say so.
function ambiguityWarning(patterns) {
  const byLabel = new Map();
  for (const p of patterns) {
    const key = String(p.label ?? '').toLowerCase();
    byLabel.set(key, (byLabel.get(key) ?? 0) + 1);
  }
  for (const [label, count] of byLabel) {
    if (count > 1) return `The syllabus describes ${count} different "${label}" meeting times — check which one is yours.`;
  }
  return null;
}

function hasTime(patterns) {
  return patterns.some(p => p.start);
}

function result(source, patterns, warnings, confidence, searched = []) {
  const ambiguous = ambiguityWarning(patterns);
  if (ambiguous) warnings.push(ambiguous);
  return {
    source,
    confidence,
    patterns,
    warnings,
    // Which tiers were actually opened looking for a TIME. Without this a
    // caller cannot tell "we searched Canvas too and it says nothing" from "we
    // stopped at the syllabus field", and the dashboard said "no time found in
    // the syllabus" for BUSI 380 after having also read its Canvas events,
    // pages and announcements.
    searched: [...searched],
    // The one thing a UI can act on: nobody states a time for this class, so
    // the student has to. An inferred time counts — it is a guess from when
    // work is due, not a time anyone wrote down.
    needs_override: !hasTime(patterns) || source === 'inferred',
  };
}

// One read per file however many times the chain and the room pass ask for it.
function lazy(fn) {
  let promise = null;
  return () => (promise ??= fn());
}

/**
 * A room from any source, for a pattern whose own source did not state one.
 *
 * Only when exactly ONE pattern is missing a room: with a lecture and a lab in
 * hand there is no telling which of them the room belongs to, and a lab in the
 * lecture's room is the wrong-place twin of a lecture at the wrong time. The
 * room never overwrites one that arrived with the time, and it carries
 * location_source so the UI can say the time came from the syllabus and the
 * room from Canvas.
 */
async function completeRoom(patterns, sources) {
  if (patterns.length !== 1 || patterns[0].location) return patterns;

  const fromText = scanTextForRoom(await sources.text());
  let room = fromText ? { ...fromText, tier: 'the syllabus text' } : null;
  if (!room) {
    const withRoom = meetingsFromCanvasEvents((await sources.events()).value).find(m => m.location);
    if (withRoom) room = { location: withRoom.location, tier: 'Canvas course events' };
  }
  if (!room) {
    const pg = scanBodiesForRoom((await sources.pages()).value, ['body']);
    if (pg) room = { ...pg, tier: 'the Canvas course pages' };
  }
  if (!room) {
    const an = scanBodiesForRoom((await sources.announcements()).value, ['message']);
    if (an) room = { ...an, tier: 'a Canvas announcement' };
  }
  if (!room) return patterns;
  return [{ ...patterns[0], location: room.location, location_source: room.tier }];
}

/**
 * Find the best meeting times available for one class.
 *
 * Resolves to { source, confidence, patterns, warnings, searched,
 * needs_override }. `patterns` is shaped exactly like cal-meetings'
 * parseWeeklyPatterns output, so it drops straight into meetingsFromSyllabus /
 * patternFor; `start` and `end` are null when only the days are known.
 *
 * `source` names what supplied the TIME, or — when nothing did — where the days
 * came from. `searched` lists the tiers that were opened looking for a time, so
 * a caller can tell an exhausted chain from a short-circuited one.
 * `needs_override` is the actionable one: true means no source anywhere states
 * a time and the user has to type it. BUSI 305, BUSI 396 and BUSI 380 are all
 * permanently in that state — their syllabi genuinely do not say — and the
 * honest answer is to route the user to the editor, not to guess an hour from
 * due dates or from a standard Rice block.
 *
 * A room is looked up independently of the time: the tier that states the hour
 * often states no room, and the room is often stated by a tier further down.
 *
 * opts.inferFromDueDates opts into the assignment-due guess, which is off by
 * default because a plausible wrong time is worse than a blank one.
 */
export async function recoverMeetingTimes(classDir, opts = {}) {
  const { inferFromDueDates = false, maxTextBytes = 400_000 } = opts ?? {};
  const warnings = [];
  const searched = [];

  // A path that is not a class directory would otherwise walk the whole
  // precedence chain and answer 'none' — the same answer a real, freshly synced
  // class gives, so a typo in the id looks like a class with no schedule.
  let stat = null;
  try {
    stat = await fs.stat(classDir);
  } catch { /* reported just below */ }
  if (!stat?.isDirectory()) {
    return result('none', [], [`No class directory at ${classDir} — nothing to read.`], 'low');
  }

  // Every source, read at most once, whichever tier or the room pass asks.
  const sources = {
    text: lazy(() => readSyllabusText(classDir, maxTextBytes)),
    events: lazy(() => readJson(path.join(classDir, 'calendar_events.json'))),
    pages: lazy(() => readJson(path.join(classDir, 'pages.json'))),
    announcements: lazy(() => readJson(path.join(classDir, 'announcements.json'))),
  };
  // WHERE is looked up independently of WHEN: a source is consulted for the
  // time only until one states a time, but the room may well be stated
  // somewhere further down, and usually is.
  const finish = async (source, patterns, confidence) =>
    result(source, await completeRoom(patterns, sources), warnings, confidence, searched);

  // --- 1. Override ---------------------------------------------------------
  searched.push('override');
  const { override, warnings: overrideWarnings } = await loadOverride(classDir);
  warnings.push(...overrideWarnings);
  if (override) {
    const patterns = patternsFromOverride(override);
    if (!override.start) warnings.push('Your override names the days but no time.');
    // No room pass here. The override is the user's own record of this class;
    // quietly adding a room they did not type would show them a classroom they
    // cannot edit out of the editor they typed it into.
    return result('override', patterns, warnings, override.start ? 'high' : 'low', searched);
  }

  const parsedFile = await readJson(path.join(classDir, 'syllabus_parsed.json'));
  if (parsedFile.unreadable) warnings.push('syllabus_parsed.json is not valid JSON — the syllabus field was skipped.');
  const field = parsedFile.value?.course?.meeting_schedule ?? null;

  // --- 2a. The syllabus field, when it already states a time ---------------
  // A field the extractor took off the wrong line is worth nothing, days
  // included: office hours are on days class need not meet at all.
  searched.push('syllabus-field');
  const fieldIsWrongLine = MISLABELLED_FIELD_RE.test(String(field ?? ''));
  if (fieldIsWrongLine) {
    warnings.push('The syllabus meeting-time field describes something other than class — ignoring it.');
  }
  // The duration check is separate: a field naming the right days over an
  // impossible span keeps its days and loses only the clock.
  const fieldPatterns = fieldIsWrongLine ? [] : dedupePatterns(parseWeeklyPatterns(normaliseDayProse(field)))
    .filter(p => plausibleClassTime(p.start, p.end))
    .map(p => ({ ...p, location: cleanRoom(p.location, p) }));
  if (hasTime(fieldPatterns)) {
    return finish('syllabus-field', fieldPatterns, 'high');
  }

  // --- 2b. The full syllabus text ------------------------------------------
  // Reached whenever the field states no TIME, days or no days: a field reading
  // "Tuesdays and Thursdays" is not an answer, it is half of one, and the only
  // early exit above this line is gated on a clock.
  searched.push('syllabus-text');
  const syllabusText = await sources.text();
  const textPatterns = scanTextForPatterns(syllabusText);
  if (hasTime(textPatterns)) {
    return finish('syllabus-text', textPatterns, 'medium');
  }

  // --- 3. Canvas ------------------------------------------------------------
  searched.push('canvas');
  const [eventsFile, pagesFile, announcementsFile] = await Promise.all([
    sources.events(), sources.pages(), sources.announcements(),
  ]);
  for (const [name, file] of [['calendar_events.json', eventsFile], ['pages.json', pagesFile], ['announcements.json', announcementsFile]]) {
    if (file.unreadable) warnings.push(`${name} is not valid JSON — it was skipped.`);
  }
  const events = eventsFile.value;
  const eventPatterns = patternsFromCanvasEvents(events);
  if (hasTime(eventPatterns)) {
    return finish('canvas', eventPatterns, 'medium');
  }
  // Only worth saying when Canvas was actually asked and came back empty — a
  // class that has never been synced has no news for the user here. A non-array
  // is Canvas's error envelope, which is not the same as an empty term.
  if (Array.isArray(events) && !events.length) {
    warnings.push('Canvas has no course events for this class.');
  } else if (events !== null && !Array.isArray(events)) {
    warnings.push('calendar_events.json is not a list of events — Canvas may have refused the request.');
  }

  const bodyPatterns = dedupePatterns([
    ...scanCanvasBodies(pagesFile.value, ['body']),
    ...scanCanvasBodies(announcementsFile.value, ['message']),
  ]);
  if (hasTime(bodyPatterns)) {
    return finish('canvas', bodyPatterns, 'medium');
  }
  // Five of the six real classes hold Canvas's refusal here rather than a list
  // of pages: [{"message":"That page has been disabled for this course"}]. It
  // is an array, so the envelope check above cannot see it, and the scan of it
  // finds nothing in exactly the way an empty Pages tab finds nothing. "Canvas
  // states no room" and "the Pages tab is switched off, so it never could have"
  // are different answers, and only the second one tells the user what to do.
  for (const [name, file] of [['Pages', pagesFile], ['Announcements', announcementsFile]]) {
    if (isCanvasRefusal(file.value)) {
      warnings.push(`Canvas would not serve this class's ${name} — the tab is disabled, so nothing there could be read.`);
    }
  }

  // --- Days with no time, from the strongest source that names them --------
  const fieldDays = fieldIsWrongLine ? [] : daysOnlyFrom(field ?? '', { allowCompact: true });
  const daysOnly = fieldDays.length
    ? [makePattern({
      byday: fieldDays,
      location: cleanRoom(parseRoom(field ?? '', { allowCode: false }), { full: field }),
      source: trimText(field, 200),
    })]
    : scanTextForDays(syllabusText);

  // --- 4. Assignment-due inference, only when asked for --------------------
  if (inferFromDueDates) {
    searched.push('inferred');
    const assignmentsFile = await readJson(path.join(classDir, 'assignments.json'));
    if (assignmentsFile.unreadable) warnings.push('assignments.json is not valid JSON — no time was inferred from due dates.');
    const inferred = inferPatternsFromDue(assignmentsFile.value, daysOnly[0]?.byday ?? []);
    if (inferred.length) {
      warnings.push('This time is a guess from when assignments are due, not from the syllabus.');
      return finish('inferred', inferred, 'low');
    }
  }

  if (daysOnly.length) {
    // Everything above has already been read and has nothing to say. `source`
    // names where the DAYS came from — the only fact we have — and confidence
    // stays 'low' because the time is missing, not because the days are shaky.
    warnings.push(parseTimeRange(field ?? '')
      ? 'The syllabus names days and a time, but not clearly enough to pair them.'
      : 'The syllabus names the days but never states a time, and neither does Canvas — set it yourself.');
    return finish(fieldDays.length ? 'syllabus-field' : 'syllabus-text', daysOnly, 'low');
  }

  warnings.push('No source states the days or the time for this class — set them yourself.');
  return result('none', [], warnings, 'low', searched);
}

// ---------------------------------------------------------------------------
// One sentence for the UI.
// ---------------------------------------------------------------------------

const DAY_LABELS = { SU: 'Su', MO: 'M', TU: 'Tu', WE: 'W', TH: 'Th', FR: 'F', SA: 'Sa' };

const SOURCE_LEAD = {
  override: 'From your override',
  'syllabus-field': 'From the syllabus',
  'syllabus-text': 'Found in the syllabus text',
  canvas: 'From Canvas',
  inferred: 'Guessed from when work is due',
};

function formatDays(byday) {
  return asArray(byday).map(d => DAY_LABELS[d] ?? d).join('');
}

function clock(hhmm) {
  const m = HHMM_RE.exec(String(hhmm ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return { text: `${hour12}:${m[2]}`, meridiem: h < 12 ? 'AM' : 'PM' };
}

function formatRange(start, end) {
  const a = clock(start);
  if (!a) return null;
  const b = clock(end);
  if (!b) return `${a.text} ${a.meridiem}`;
  // "1:00-2:15 PM" when both ends share a meridiem, spelled out when they do not.
  return a.meridiem === b.meridiem
    ? `${a.text}-${b.text} ${b.meridiem}`
    : `${a.text} ${a.meridiem}-${b.text} ${b.meridiem}`;
}

/** One short sentence saying where the meeting time came from, for the UI. */
export function describeMeetingSource(res) {
  const patterns = asArray(res?.patterns);
  const source = res?.source ?? 'none';
  if (!patterns.length || source === 'none') {
    return 'No class days or times found — set them yourself.';
  }

  const p = patterns[0];
  const days = formatDays(p.byday);
  const more = patterns.length > 1 ? ` (+${patterns.length - 1} more)` : '';
  const label = p.label && p.label.toLowerCase() !== 'class' ? `${p.label} ` : '';
  const lead = SOURCE_LEAD[source] ?? 'From the syllabus';

  if (!p.start) {
    // This sentence used to say "no time found in the syllabus" after the chain
    // had also read the class's Canvas events, pages and announcements. It
    // understated the search, so the user's reasonable next thought — "then go
    // and look at Canvas" — was a dead end we had already walked. Say how far
    // we got, and that the next move is theirs.
    if (source === 'override') return `${lead} — ${label}${days}, but no time set.${more}`;
    const alsoCanvas = asArray(res?.searched).includes('canvas') ? ' or in Canvas' : '';
    return `Days only (${days}) — no time in the syllabus${alsoCanvas}. Set it yourself.`;
  }

  // Where the ROOM came from, when it is not where the time came from: the time
  // can be the syllabus's and the room the Canvas home page's, which is exactly
  // ENTR 222's shape.
  const roomFrom = p.location && p.location_source ? ` (room from ${p.location_source})` : '';
  const where = p.location ? `, ${p.location}` : '';
  if (!p.end) {
    return `${lead} — ${label}${days}, starts ${formatRange(p.start, null)}${where}. Check it.${more}${roomFrom}`;
  }
  return `${lead} — ${label}${days} ${formatRange(p.start, p.end)}${where}${more}${roomFrom}`;
}
