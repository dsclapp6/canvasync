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

/** Group ops by their `date` field. Ops with no usable date are dropped. */
export function bucketByDate(ops) {
  const out = new Map();
  for (const op of ops || []) {
    const iso = String(op?.date ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    if (!out.has(iso)) out.set(iso, []);
    out.get(iso).push(op);
  }
  return out;
}

/**
 * Ops for one day, in the order a student reads them: timed work first by the
 * clock, then all-day markers. A lecture with no known hour must not sort above
 * a 9am deadline just because its string happens to compare low.
 */
export function sortDayOps(ops) {
  return [...(ops || [])].sort((a, b) => {
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
