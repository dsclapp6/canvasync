// cal-grid.js — the date arithmetic behind the Week and Month calendar views.
//
// Pure functions, no DOM and no Node builtins, so the same file runs in the
// browser (imported by app.js as a module) and under `node --test` in
// bridge/test/cal-grid.test.js. Grid maths is exactly the kind of code that is
// wrong by one day and looks right on the day you wrote it, so it does not get
// to live inside a render function where nothing can reach it.
//
// Two rules this file exists to enforce:
//
//   Everything is a local ISO date string (YYYY-MM-DD), never a Date, at every
//   boundary. The calendar's own data is ISO date strings; the moment a UTC
//   Date is introduced, an 11:59 PM deadline stored as ~05:00Z lands on the
//   wrong day — the same bug canvas-tasks.js's dueParts() was written to kill.
//
//   Every Date built here is anchored at local NOON. Midnight-anchored dates
//   shift a day across a DST boundary when you add 24h; noon has twelve hours
//   of slack in both directions, so `addDays` is correct through the November
//   change that falls inside this user's term.

/** Local ISO date (YYYY-MM-DD) for a Date. Never toISOString — that is UTC. */
export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * An ISO date string as a local Date at noon.
 *
 * `new Date('2026-08-24')` parses as UTC midnight, which in every timezone west
 * of Greenwich is the 23rd. Splitting the parts and building a local date is
 * the only reading that agrees with the string a human typed.
 */
export function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

/** Today, as a local ISO date. Injectable so tests never depend on the clock. */
export function todayIso() {
  return isoDate(new Date());
}

/** ISO date `n` days from `iso`. Negative goes back. */
export function addDays(iso, n) {
  const d = parseIso(iso);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/**
 * The Monday of the week containing `iso`.
 *
 * getDay() is 0=Sunday. Monday-first is what a class schedule reads as — a
 * Sunday-first grid puts the weekend on both ends of the teaching week.
 */
export function startOfWeek(iso) {
  const d = parseIso(iso);
  if (!d) return null;
  const back = (d.getDay() + 6) % 7; // Mon->0, Sun->6
  return addDays(iso, -back);
}

/** The seven ISO dates of the week containing `iso`, Monday first. */
export function weekDays(iso) {
  const start = startOfWeek(iso);
  if (!start) return [];
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** First day of the month containing `iso`. */
export function startOfMonth(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[1]}-${m[2]}-01` : null;
}

/** ISO date `n` months from `iso`, clamped to the target month's last day. */
export function addMonths(iso, n) {
  const d = parseIso(iso);
  if (!d) return null;
  const day = d.getDate();
  // Set the day to 1 before shifting the month, or "Jan 31 + 1 month" becomes
  // March 3rd — the month rolls over because February has no 31st.
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return isoDate(d);
}

/**
 * The tiled month grid containing `iso`: whole Monday-start weeks covering the
 * month, with the leading and trailing days of the adjacent months included and
 * flagged.
 *
 * Whole weeks only — a grid that starts mid-row has no column alignment, and
 * the weekday headers stop meaning anything.
 */
export function monthGrid(iso, today = null) {
  const first = startOfMonth(iso);
  if (!first) return { days: [], month: null };
  const d = parseIso(first);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const last = `${first.slice(0, 8)}${String(lastDay).padStart(2, '0')}`;

  const gridStart = startOfWeek(first);
  // Trailing days run to the Sunday on or after the month's last day.
  const tailPad = (7 - ((parseIso(last).getDay() + 6) % 7) - 1);
  const gridEnd = addDays(last, tailPad);

  const days = [];
  const month = first.slice(0, 7);
  for (let cur = gridStart; cur <= gridEnd; cur = addDays(cur, 1)) {
    days.push({
      iso: cur,
      day: Number(cur.slice(8, 10)),
      adjacent: cur.slice(0, 7) !== month,
      today: today != null && cur === today,
    });
  }
  return { days, month };
}

/** Whole days from `a` to `b`, signed. Both are local ISO dates. */
export function daysBetween(a, b) {
  const x = parseIso(a);
  const y = parseIso(b);
  if (!x || !y) return 0;
  // Both are noon-anchored, so the division is exact across DST.
  return Math.round((y - x) / 864e5);
}

// The most days one item may cover. Mirrors MAX_SPAN_DAYS in custom-items.js —
// the server refuses longer, and a grid that tried to draw one would put a
// chip on every tile of the month.
export const MAX_SPAN_DAYS = 60;

/**
 * Every date an op covers, inclusive: `[date]` for the ordinary case, and the
 * whole run for an item the user dragged across days (`end_date`).
 *
 * An end before the start, or a span past the cap, degrades to the start day
 * alone. A calendar that silently drew a 4000-day event because a field was
 * wrong would be worse than one that drew a single day.
 */
export function spanDates(op) {
  const start = String(op?.date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return [];
  const end = String(op?.end_date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || end <= start) return [start];
  const n = daysBetween(start, end);
  if (n < 1 || n > MAX_SPAN_DAYS) return [start];
  return Array.from({ length: n + 1 }, (_, i) => addDays(start, i));
}

/**
 * Group ops by date. Ops with no usable date are dropped; an op carrying an
 * `end_date` lands in EVERY bucket it covers, because a three-day trip is on
 * the calendar on all three days — that is the whole point of a span.
 */
export function bucketByDate(ops) {
  const out = new Map();
  for (const op of ops || []) {
    for (const iso of spanDates(op)) {
      if (!out.has(iso)) out.set(iso, []);
      out.get(iso).push(op);
    }
  }
  return out;
}

/**
 * Where one day sits in an op's span: 'only' (a single day), or 'start' /
 * 'mid' / 'end'. The renderers use it to round the outer corners of a run and
 * to put the resize handles on the two ends only — a chip in the middle of a
 * span has no edge of its own to drag.
 */
export function spanPosition(op, iso) {
  const dates = spanDates(op);
  if (dates.length < 2) return 'only';
  if (iso === dates[0]) return 'start';
  if (iso === dates[dates.length - 1]) return 'end';
  return 'mid';
}

/**
 * The inclusive date range between two days a pointer touched, in order —
 * so dragging a selection right-to-left picks the same range as left-to-right.
 * Capped at MAX_SPAN_DAYS, and null when either end is not a date.
 */
export function orderedRange(a, b) {
  const x = String(a ?? '').slice(0, 10);
  const y = String(b ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x) || !/^\d{4}-\d{2}-\d{2}$/.test(y)) return null;
  const [from, to] = x <= y ? [x, y] : [y, x];
  const n = daysBetween(from, to);
  return { from, to: n > MAX_SPAN_DAYS ? addDays(from, MAX_SPAN_DAYS) : to };
}

/**
 * An op moved by `days`, as the fields a PATCH would carry. A span keeps its
 * length: dragging a three-day item moves both ends, it does not stretch it.
 * Returns null when nothing would change, so a click that happens to end on
 * the day it started writes nothing.
 */
export function movedDates(op, days) {
  if (!days) return null;
  const start = String(op?.date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const date = addDays(start, days);
  const dates = spanDates(op);
  const end = dates.length > 1 ? addDays(dates[dates.length - 1], days) : null;
  return { date, end_date: end };
}

/**
 * An op whose named edge was dragged to `iso`, as the fields a PATCH would
 * carry — or null when the drag would invert the item.
 *
 * Dragging the START edge past the end (or the END edge before the start) is
 * a gesture with no meaning, and the honest answer is to refuse it rather
 * than to silently swap the two and move an item the user was resizing.
 */
export function resizedDates(op, edge, iso) {
  const dates = spanDates(op);
  if (!dates.length) return null;
  const start = dates[0];
  const end = dates[dates.length - 1];
  const to = String(iso ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  if (edge === 'start') {
    if (to > end) return null;
    if (to === start) return null;
    if (daysBetween(to, end) > MAX_SPAN_DAYS) return null;
    return { date: to, end_date: to === end ? null : end };
  }
  if (to < start) return null;
  if (to === end) return null;
  if (daysBetween(start, to) > MAX_SPAN_DAYS) return null;
  return { date: start, end_date: to === start ? null : to };
}

/**
 * Ops for one day, in the order a student reads them: timed work first by the
 * clock, then all-day markers. A lecture with no known hour must not sort above
 * a 9am deadline just because its string happens to compare low.
 */
export function sortDayOps(ops) {
  // A run of days is a BANNER over each of them, not an appointment inside
  // one, so it sits at the top of every day it covers — which is also the only
  // way the pieces line up into one bar across a week of independently
  // stacked columns. Longest-running first, so a week away does not get drawn
  // underneath the weekend inside it.
  const span = (o) => {
    const d = spanDates(o);
    return d.length > 1 ? d.length : 0;
  };
  return [...(ops || [])].sort((a, b) => {
    const as = span(a);
    const bs = span(b);
    if (as !== bs) return bs - as;
    if (as && bs) return String(a.date).localeCompare(String(b.date));
    const at = a.all_day || !a.time ? null : a.time;
    const bt = b.all_day || !b.time ? null : b.time;
    if (at && bt) return at < bt ? -1 : at > bt ? 1 : 0;
    if (at) return -1;
    if (bt) return 1;
    return 0;
  });
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "August 2026" for the month containing `iso`. */
export function monthLabel(iso) {
  const d = parseIso(iso);
  return d ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
}

/**
 * "Aug 24 – 30, 2026", or "Aug 31 – Sep 6, 2026" when the week straddles a
 * month, or "Dec 28, 2026 – Jan 3, 2027" across a year. Repeating the month on
 * both sides of a week that does not cross one is noise.
 */
export function weekLabel(iso) {
  const days = weekDays(iso);
  if (!days.length) return '';
  const a = parseIso(days[0]);
  const b = parseIso(days[6]);
  const left = `${MON_SHORT[a.getMonth()]} ${a.getDate()}`;
  if (a.getFullYear() !== b.getFullYear()) {
    return `${left}, ${a.getFullYear()} – ${MON_SHORT[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
  }
  const right = a.getMonth() === b.getMonth()
    ? `${b.getDate()}`
    : `${MON_SHORT[b.getMonth()]} ${b.getDate()}`;
  return `${left} – ${right}, ${b.getFullYear()}`;
}

/** "Mon 24" — the column head in Week view. */
export function dayHeadLabel(iso) {
  const d = parseIso(iso);
  if (!d) return '';
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getDate()}`;
}

export const WEEKDAY_HEADS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * "in 3 days" / "in 2 weeks" / "today" — a date's distance in the units a
 * person actually tracks it by: days inside two weeks, weeks beyond ("include
 * the number of days/weeks until its due", 2026-08-25). Takes the whole-day
 * diff (negative = past) rather than a date, so the caller owns the timezone
 * question and this stays a pure function of one integer.
 */
export function relPhrase(diff) {
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  const n = Math.abs(diff);
  const span = n < 14 ? `${n} days` : `${Math.round(n / 7)} weeks`;
  return diff > 0 ? `in ${span}` : `${span} ago`;
}

/**
 * How loud that distance should be. Monotonic — a deadline never gets quieter
 * as it approaches: '' (calm) → 'soon' (inside a week) → 'now' (today or
 * tomorrow) → 'overdue' (past). style.css maps these to muted ink, amber,
 * brick, and bold brick; the names are tiers, not dates, so "now" covers
 * tomorrow — the day a student has to actually do the work.
 */
export function dueTier(diff) {
  if (diff < 0) return 'overdue';
  if (diff <= 1) return 'now';
  if (diff <= 7) return 'soon';
  return '';
}

/**
 * The period to open on: the one containing today when today is inside the
 * worklist window, otherwise the one containing the first op.
 *
 * Opening on the first op is what the list view does and it is wrong for a
 * grid — the worklist window starts a week in the past, so a month view would
 * open on a month the student has already lived through.
 */
export function initialAnchor(ops, today = todayIso()) {
  const dates = (ops || [])
    .map(o => String(o?.date ?? '').slice(0, 10))
    .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s))
    .sort();
  if (!dates.length) return today;
  if (today >= dates[0] && today <= dates[dates.length - 1]) return today;
  return dates[0];
}
