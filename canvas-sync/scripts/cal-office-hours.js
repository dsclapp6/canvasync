// Office hours — the standing weekly commitment nobody ever puts on a calendar.
//
// Every syllabus in this corpus states them, and every one states them
// differently:
//
//   BUSI 396   "M/W/F 11:30 – 1:30"
//   BUSI 380   "Tuesdays, 4:15-5:15PM; flexible by appointment"
//   BUSI 305   "2:00-3:00 in person on Friday. Additional office hours are
//               available by appointment"
//   BUSI 374   "M 10am-12:15pm; W 11am-12:15pm; or by appointment (8/24 – 10/5);
//               MW 11am-2:15pm; or by appointment (10/7-12/13)"
//   ECON 205   "By appointment and, on Tuesdays, in the classroom until 9:00
//               p.m. or until the number of students drops to zero, whichever
//               comes first."
//   ENTR 222   "By appointment"
//
// Three of those are schedulable, one is schedulable TWICE with a date range
// deciding which block is live, and two are not schedulable at all. That last
// pair is the reason this file exists rather than a regex at the call site:
//
// GOVERNING RULE, inherited from cal-meetings.js — NO TIME BEATS A WRONG TIME.
// ECON 205 names a weekday and an end time and no start; the honest output is
// nothing, plus a sentence saying why. A parser that reaches for 9:00 p.m.
// there puts a student outside a dark classroom.
//
// Two things this adds over parseWeeklyPatterns(), which already handles the
// easy half:
//
//   1. Day-after-time order. "2:00-3:00 in person on Friday" is a sentence
//      about Friday; the class-meeting grammar expects the day first.
//   2. Date ranges. BUSI 374 states two DIFFERENT MW schedules, one for
//      8/24–10/5 and one for 10/7–12/13. Without the range both recur across
//      the whole term and the student has two contradictory events every
//      Monday — a wrong time, arrived at from correct inputs.
//
// Node builtins only, and cal-meetings' parsers for days and clock times, so
// the two files can never disagree about what "TR" or "11:30 – 1:30" means.

import { parseDayCodes, parseTimeRange, parseRoom } from './cal-meetings.js';

// Office hours are not classes and do not obey a class's shape: BUSI 374 holds
// a 3h15 block, and a 15-minute slot before a lecture is a real thing a
// professor offers. Wider than cal-meetings' 20–240, and still narrow enough
// to reject "9:00-5:00", which is a building's opening hours.
const MIN_MINUTES = 15;
const MAX_MINUTES = 300;
const EARLIEST_START = 6 * 60;
const LATEST_START = 22 * 60 + 30;

const APPOINTMENT_RE = /\b(?:by|on|per|upon)\s+appointment\b|\bappointments?\s+only\b|\bby\s+arrangement\b/i;

// A compact day token, and only a compact day token. parseDayCodes() walks any
// string letter by letter, so handing it "appointment" comes back [MO, TU] —
// the 'm' and the 't'. Everything reaching it from here has already been
// proved to be days and nothing else.
const COMPACT_DAYS_RE = /^(?:Th|Tu|Su|Sa|M|T|W|R|F)+$/;
const DAY_WORD_RE = /^(?:sun|mon|tue|tues|wed|wednes|thu|thur|thurs|fri|satur|sat)(?:day)?s?$/i;

// Any clock time at all, so day-token scanning never sees the 'M' in "10am" or
// the 'F' that isn't there in "4:15-5:15PM".
const ANY_TIME_RE = /\d{1,2}(?::\d{2})?\s*[ap]\.?\s?m\.?|\d{1,2}:\d{2}/gi;

// "(8/24 – 10/5)", "10/7-12/13", "Sept 3 to Oct 10" is NOT handled: a month
// name next to a range is far more often prose than a qualifier, and a
// mis-scoped range silently halves a semester of office hours.
const DATE_RANGE_RE =
  /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:-|–|—|to|through|thru|until)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/;

const pad = n => String(n).padStart(2, '0');
const minutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** A start/end pair an office hour could plausibly be. */
function sane(start, end) {
  const a = minutes(start);
  const b = minutes(end);
  const span = b - a;
  return span >= MIN_MINUTES && span <= MAX_MINUTES && a >= EARLIEST_START && a <= LATEST_START;
}

/**
 * "(8/24 – 10/5)" -> { from: '08-24', to: '10-05', year: null }.
 *
 * Month-day only, because that is how a syllabus writes it. The year is the
 * caller's problem: it is the one piece of the answer the text does not carry,
 * and guessing it here would put a whole term of events in 2001.
 */
export function parseDateRange(text) {
  const m = DATE_RANGE_RE.exec(String(text ?? ''));
  if (!m) return null;
  const [, m1, d1, y1, m2, d2, y2] = m;
  const ok = (mo, da) => Number(mo) >= 1 && Number(mo) <= 12 && Number(da) >= 1 && Number(da) <= 31;
  if (!ok(m1, d1) || !ok(m2, d2)) return null;
  const year = v => (v == null ? null : Number(v.length === 2 ? `20${v}` : v));
  return {
    from: `${pad(m1)}-${pad(d1)}`,
    to: `${pad(m2)}-${pad(d2)}`,
    fromYear: year(y1),
    toYear: year(y2),
    text: m[0],
  };
}

const WEEK = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** True when this token is a day and only a day. */
function dayToken(part) {
  return DAY_WORD_RE.test(part) || (COMPACT_DAYS_RE.test(part) && part.length <= 7);
}

/**
 * "Monday-Friday", "M-F", "Tue-Thu" -> every day in between.
 *
 * A hyphen between two days is a span, not a list, and it is how half the
 * syllabi that state a weekday span write it. Both ends have to be a single
 * day: "MW-F" is not a span anyone means.
 */
function expandDayRange(part) {
  const m = /^([A-Za-z]{1,9})\s*[-–—]\s*([A-Za-z]{1,9})$/.exec(part);
  if (!m) return null;
  const a = dayToken(m[1]) ? parseDayCodes(m[1]) : [];
  const b = dayToken(m[2]) ? parseDayCodes(m[2]) : [];
  if (a.length !== 1 || b.length !== 1) return null;
  const i = WEEK.indexOf(a[0]);
  const j = WEEK.indexOf(b[0]);
  if (i < 0 || j < 0 || j <= i) return null;
  return WEEK.slice(i, j + 1);
}

/** The day codes named anywhere in one clause, time text already removed. */
function daysIn(clause) {
  const bare = clause.replace(ANY_TIME_RE, ' ');
  const out = [];
  const add = (codes) => { for (const c of codes) if (!out.includes(c)) out.push(c); };
  for (const raw of bare.split(/[\s,;&()]+|(?:\band\b)/i)) {
    if (!raw) continue;
    const tok = raw.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    if (!tok) continue;
    const span = expandDayRange(tok);
    if (span) { add(span); continue; }
    // Slashes separate days ("M/W/F") but also dates; the date has been
    // stripped by now, so anything left with a slash is a day list.
    for (const part of tok.split('/')) {
      if (part && dayToken(part)) add(parseDayCodes(part));
    }
  }
  return out.sort((a, b) => WEEK.indexOf(a) - WEEK.indexOf(b));
}

/**
 * Split office-hours prose into the clauses that each state one thing.
 *
 * Semicolons and sentence ends, never an abbreviation's period ("a.m."), and
 * never inside a parenthesised date range.
 */
function clausesOf(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .split(/\s*;\s*|(?<=[a-z0-9)])\.\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Parse one syllabus office-hours field.
 *
 * Returns patterns that are safe to put on a calendar, whether appointments are
 * also offered, and — the part that matters as much — every clause that named a
 * day but could not be pinned to a time, with the reason.
 *
 * Date ranges attach backwards. "M 10am-12:15pm; W 11am-12:15pm; or by
 * appointment (8/24 – 10/5)" is one schedule with a range stated once at the
 * end of it, so a range claims every pattern since the last range, not just the
 * clause it appears in.
 */
export function parseOfficeHours(text) {
  const raw = String(text ?? '').trim();
  const result = { patterns: [], byAppointment: false, refused: [], text: raw || null };
  if (!raw) return result;

  let pending = [];   // patterns still waiting to learn their date range
  for (const clause of clausesOf(raw)) {
    if (APPOINTMENT_RE.test(clause)) result.byAppointment = true;

    const range = parseDateRange(clause);
    const body = range ? clause.replace(range.text, ' ') : clause;

    const time = parseTimeRange(body);
    const byday = daysIn(body);

    if (byday.length && !time) {
      // ECON 205 lives here: a weekday, an end time, no start. The clause is
      // reported rather than dropped, because a student reading "office hours:
      // none" wants to know their professor said something the app would not
      // repeat.
      if (!APPOINTMENT_RE.test(clause) || /\d/.test(body)) {
        result.refused.push({ clause: clause.trim(), reason: 'no_time' });
      }
    } else if (time && !byday.length) {
      result.refused.push({ clause: clause.trim(), reason: 'no_day' });
    } else if (time && byday.length) {
      if (sane(time.start, time.end)) {
        pending.push({
          byday,
          start: time.start,
          end: time.end,
          location: parseRoom(body) || null,
          range: null,
          clause: clause.trim(),
        });
      } else {
        result.refused.push({ clause: clause.trim(), reason: 'implausible' });
      }
    }

    if (range && pending.length) {
      for (const p of pending) p.range = { from: range.from, to: range.to, fromYear: range.fromYear, toYear: range.toYear };
      result.patterns.push(...pending);
      pending = [];
    }
  }
  result.patterns.push(...pending);
  return result;
}

/** The office-hours field of a parsed syllabus, with who is holding them. */
export function officeHoursFor(syllabusParsed) {
  const instructor = syllabusParsed?.course?.instructor ?? {};
  const parsed = parseOfficeHours(instructor.office_hours);
  return {
    ...parsed,
    instructor: typeof instructor.name === 'string' ? instructor.name.trim() || null : null,
    email: typeof instructor.email === 'string' ? instructor.email.trim() || null : null,
  };
}

/**
 * A pattern's MM-DD range resolved against the window the worklist covers.
 *
 * The syllabus wrote "8/24" and meant this academic year. Picking the year that
 * puts the range inside the window is the only reading that cannot land a Fall
 * schedule in the wrong January — and when no year does, the range is dropped
 * and the pattern runs the whole window rather than nothing, because a
 * misplaced range must not silently delete real office hours.
 */
export function resolveRange(range, windowFrom, windowTo) {
  if (!range) return { from: windowFrom, to: windowTo, ranged: false };
  const y0 = Number(windowFrom.slice(0, 4));
  const candidates = [];
  for (const y of [y0, y0 + 1]) {
    const from = range.fromYear ? `${range.fromYear}-${range.from}` : `${y}-${range.from}`;
    // A range that runs backwards crossed New Year: "12/1 – 1/15".
    let toY = range.toYear ?? Number(from.slice(0, 4));
    if (!range.toYear && range.to < range.from) toY += 1;
    candidates.push({ from, to: `${toY}-${range.to}` });
  }
  const hit = candidates.find(c => c.to >= windowFrom && c.from <= windowTo);
  if (!hit) return { from: windowFrom, to: windowTo, ranged: false };
  return {
    from: hit.from > windowFrom ? hit.from : windowFrom,
    to: hit.to < windowTo ? hit.to : windowTo,
    ranged: true,
  };
}

/** "Mondays and Wednesdays, 11:00–14:15" — for a description line. */
export function describeOfficeHours(pattern) {
  const NAMES = { SU: 'Sundays', MO: 'Mondays', TU: 'Tuesdays', WE: 'Wednesdays', TH: 'Thursdays', FR: 'Fridays', SA: 'Saturdays' };
  const days = pattern.byday.map(d => NAMES[d] ?? d);
  const list = days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}` : days[0];
  return `${list}, ${pattern.start}–${pattern.end}`;
}
