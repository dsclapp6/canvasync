// cal-grid.test.js — the date arithmetic behind Week and Month view.
//
// Grid maths fails silently: an off-by-one lands every event on the wrong day
// and the page still renders beautifully. Every test here is a specific way
// that has happened in calendar code, or a specific date in this user's Fall
// 2026 term where it would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isoDate, parseIso, addDays, addMonths, startOfWeek, startOfMonth, weekDays,
  monthGrid, bucketByDate, sortDayOps, monthLabel, weekLabel, dayHeadLabel,
  initialAnchor, relPhrase, dueTier, WEEKDAY_HEADS,
  daysBetween, spanDates, spanPosition, orderedRange, movedDates, resizedDates,
  MAX_SPAN_DAYS,
} from '../public/cal-grid.js';

// --- ISO in, ISO out, always local --------------------------------------

test('an ISO string parses to the day a human typed, not the day before', () => {
  // new Date('2026-08-24') is UTC midnight, which is Aug 23 everywhere west of
  // Greenwich. This is the same class of bug as reading due_at off the raw
  // string instead of a local Date.
  const d = parseIso('2026-08-24');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 24);
  assert.equal(isoDate(d), '2026-08-24');
});

test('parseIso tolerates a full timestamp and junk returns null', () => {
  assert.equal(isoDate(parseIso('2026-08-24T23:59:00Z')), '2026-08-24');
  assert.equal(parseIso(''), null);
  assert.equal(parseIso(null), null);
  assert.equal(parseIso('not a date'), null);
  assert.equal(addDays('nope', 1), null);
});

test('adding a day across the end of DST does not lose or repeat one', () => {
  // US daylight time ends Sunday 2026-11-01, inside this user's term. A
  // midnight-anchored date plus 24h lands on 23:00 the same day and isoDate
  // reads it back as 2026-11-01 twice.
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(addDays('2026-11-02', -1), '2026-11-01');
});

test('adding a day across the start of DST does not skip one', () => {
  // Daylight time starts Sunday 2026-03-08.
  assert.equal(addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
});

test('a week of addDays walks seven distinct consecutive days', () => {
  const seen = [];
  for (let i = 0; i < 7; i++) seen.push(addDays('2026-10-29', i));
  assert.deepEqual(seen, ['2026-10-29', '2026-10-30', '2026-10-31',
    '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
  assert.equal(new Set(seen).size, 7);
});

// --- weeks ----------------------------------------------------------------

test('every day of a week resolves to the same Monday', () => {
  // 2026-08-24 is a Monday.
  const week = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
    '2026-08-28', '2026-08-29', '2026-08-30'];
  for (const d of week) assert.equal(startOfWeek(d), '2026-08-24', d);
});

test('Sunday belongs to the week that started the Monday before it, not the one after', () => {
  // The classic weekStartsOn bug: getDay() is 0 for Sunday, so a naive
  // subtraction sends Sunday forward six days into the next week.
  assert.equal(startOfWeek('2026-08-30'), '2026-08-24');
  assert.equal(startOfWeek('2026-08-31'), '2026-08-31');
});

test('weekDays is seven consecutive dates, Monday first', () => {
  const days = weekDays('2026-08-27');
  assert.equal(days.length, 7);
  assert.equal(days[0], '2026-08-24');
  assert.equal(days[6], '2026-08-30');
  assert.equal(parseIso(days[0]).getDay(), 1, 'first cell is a Monday');
  assert.equal(parseIso(days[6]).getDay(), 0, 'last cell is a Sunday');
  assert.equal(WEEKDAY_HEADS.length, 7);
  assert.equal(WEEKDAY_HEADS[0], 'Mon');
});

test('a week straddling a month still returns seven days', () => {
  const days = weekDays('2026-09-01');
  assert.equal(days.length, 7);
  assert.equal(days[0], '2026-08-31');
  assert.equal(days[6], '2026-09-06');
});

// --- months ---------------------------------------------------------------

test('the month grid is whole weeks: a multiple of seven, at least 28', () => {
  for (const iso of ['2026-08-15', '2026-09-15', '2026-10-15', '2026-11-15', '2026-12-15']) {
    const { days } = monthGrid(iso);
    assert.equal(days.length % 7, 0, `${iso} -> ${days.length}`);
    assert.ok(days.length >= 28, `${iso} -> ${days.length}`);
    assert.equal(parseIso(days[0].iso).getDay(), 1, `${iso} starts on a Monday`);
    assert.equal(parseIso(days[days.length - 1].iso).getDay(), 0, `${iso} ends on a Sunday`);
  }
});

test('the month grid holds every day of its month exactly once', () => {
  const { days } = monthGrid('2026-08-01');
  const own = days.filter(d => !d.adjacent).map(d => d.iso);
  assert.equal(own.length, 31);
  assert.equal(own[0], '2026-08-01');
  assert.equal(own[30], '2026-08-31');
  assert.equal(new Set(own).size, 31);
});

test('a month that begins on a Monday and ends on a Sunday has no adjacent days', () => {
  // February 2027: starts Monday, 28 days, ends Sunday. The one shape where
  // padding logic that always adds a row would be visibly wrong.
  const { days } = monthGrid('2027-02-10');
  assert.equal(days.length, 28);
  assert.equal(days.filter(d => d.adjacent).length, 0);
});

test('adjacent days are flagged and belong to the neighbouring months', () => {
  // 2026-08-01 is a Saturday, so the grid opens with Mon 27 – Fri 31 July.
  const { days } = monthGrid('2026-08-01');
  const lead = days.filter(d => d.adjacent && d.iso < '2026-08-01');
  assert.equal(lead.length, 5);
  assert.equal(lead[0].iso, '2026-07-27');
  assert.ok(days.filter(d => d.adjacent && d.iso > '2026-08-31').length > 0);
});

test('today is flagged on exactly one tile, and only when it is in the grid', () => {
  const inGrid = monthGrid('2026-08-15', '2026-08-24');
  assert.equal(inGrid.days.filter(d => d.today).length, 1);
  assert.equal(inGrid.days.find(d => d.today).iso, '2026-08-24');

  // A month far away must not light one up.
  const away = monthGrid('2027-05-15', '2026-08-24');
  assert.equal(away.days.filter(d => d.today).length, 0);

  // No today passed at all: nothing is flagged rather than everything.
  assert.equal(monthGrid('2026-08-15').days.filter(d => d.today).length, 0);
});

test('a today that falls in the adjacent padding is still flagged once', () => {
  // 2026-08-31 is a Monday, so it is the first tile of September's grid.
  const g = monthGrid('2026-09-10', '2026-08-31');
  const hits = g.days.filter(d => d.today);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].adjacent, true);
});

test('addMonths clamps instead of rolling over into the month after next', () => {
  // Jan 31 + 1 month is Feb 28, not March 3. Rolling over is what setMonth
  // does on its own and it makes the "next" button skip a month.
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonths('2026-08-31', 1), '2026-09-30');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(startOfMonth('2026-08-24'), '2026-08-01');
});

test('twelve forward months land on the same day a year later', () => {
  let iso = '2026-08-15';
  for (let i = 0; i < 12; i++) iso = addMonths(iso, 1);
  assert.equal(iso, '2027-08-15');
});

// --- bucketing and ordering ----------------------------------------------

test('ops bucket by date and undated ops are dropped rather than bucketed under undefined', () => {
  const map = bucketByDate([
    { date: '2026-09-01', title: 'a' },
    { date: '2026-09-01', title: 'b' },
    { date: '2026-09-02', title: 'c' },
    { date: null, title: 'undated' },
    { date: 'garbage', title: 'junk' },
    {},
  ]);
  assert.equal(map.size, 2);
  assert.equal(map.get('2026-09-01').length, 2);
  assert.equal(map.get('2026-09-02').length, 1);
});

test('a full ISO timestamp buckets under its date part', () => {
  const map = bucketByDate([{ date: '2026-09-01T14:30:00Z' }]);
  assert.deepEqual([...map.keys()], ['2026-09-01']);
});

test('timed work sorts before all-day markers, and by the clock among itself', () => {
  // A lecture with no known hour must not sort above a 09:00 deadline. This is
  // the display half of NO TIME BEATS A WRONG TIME: an unknown hour is shown
  // last, never guessed into the middle of the day.
  const out = sortDayOps([
    { title: 'all-day meeting', all_day: true, time: null },
    { title: '2pm quiz', time: '14:00' },
    { title: '9am reading', time: '09:00' },
    { title: 'timeless', all_day: true, time: '10:00' },
  ]).map(o => o.title);
  assert.deepEqual(out, ['9am reading', '2pm quiz', 'all-day meeting', 'timeless']);
});

test('sortDayOps does not mutate its input', () => {
  const input = [{ time: '14:00' }, { time: '09:00' }];
  const copy = [...input];
  sortDayOps(input);
  assert.deepEqual(input, copy);
});

// --- labels ---------------------------------------------------------------

test('a week inside one month names the month once', () => {
  assert.equal(weekLabel('2026-08-26'), 'Aug 24 – 30, 2026');
});

test('a week straddling a month names both', () => {
  assert.equal(weekLabel('2026-09-01'), 'Aug 31 – Sep 6, 2026');
});

test('a week straddling a year names both years', () => {
  // 2026-12-28 is a Monday.
  assert.equal(weekLabel('2026-12-30'), 'Dec 28, 2026 – Jan 3, 2027');
});

test('month and day-head labels read the way a schedule does', () => {
  assert.equal(monthLabel('2026-08-24'), 'August 2026');
  assert.equal(monthLabel('2026-12-01'), 'December 2026');
  assert.equal(dayHeadLabel('2026-08-24'), 'Mon 24');
  assert.equal(dayHeadLabel('2026-08-30'), 'Sun 30');
  assert.equal(dayHeadLabel('junk'), '');
  assert.equal(monthLabel('junk'), '');
  assert.equal(weekLabel('junk'), '');
});

// --- where the grid opens -------------------------------------------------

test('the grid opens on today when today is inside the worklist window', () => {
  const ops = [{ date: '2026-08-17' }, { date: '2026-12-01' }];
  assert.equal(initialAnchor(ops, '2026-08-24'), '2026-08-24');
});

test('the grid opens on the first op when today is outside the window', () => {
  // Opening on the first op is what the list does. For a grid it would open on
  // a month the student has already lived through, so it is only the fallback.
  const ops = [{ date: '2026-09-10' }, { date: '2026-12-01' }];
  assert.equal(initialAnchor(ops, '2026-08-24'), '2026-09-10');
});

test('an empty worklist opens on today rather than on nothing', () => {
  assert.equal(initialAnchor([], '2026-08-24'), '2026-08-24');
  assert.equal(initialAnchor(null, '2026-08-24'), '2026-08-24');
  assert.equal(initialAnchor([{ date: null }], '2026-08-24'), '2026-08-24');
});

// --- the urgency vocabulary ------------------------------------------------
// One phrasing and one loudness ladder for every dated item in the app
// ("include the number of days/weeks until its due", 2026-08-25).

test('relPhrase names the near days and counts the far ones in weeks', () => {
  assert.equal(relPhrase(0), 'today');
  assert.equal(relPhrase(1), 'tomorrow');
  assert.equal(relPhrase(-1), 'yesterday');
  assert.equal(relPhrase(2), 'in 2 days');
  assert.equal(relPhrase(13), 'in 13 days');
  // 13 is the last day counted in days — "in 2 weeks" at 14, and rounded to
  // the nearest week beyond, because "in 17 days" is exactly the arithmetic
  // the user said they cannot do at a glance.
  assert.equal(relPhrase(14), 'in 2 weeks');
  assert.equal(relPhrase(17), 'in 2 weeks');
  assert.equal(relPhrase(18), 'in 3 weeks');
  assert.equal(relPhrase(63), 'in 9 weeks');
  assert.equal(relPhrase(-2), '2 days ago');
  assert.equal(relPhrase(-14), '2 weeks ago');
});

// --- spans, moves and resizes ----------------------------------------------
// The maths behind dragging an item around the grid (CALENDAR-SPEC §8). Every
// one of these is a gesture a pointer can actually make, including the ones
// that must be refused.

test('daysBetween is exact across the November DST change', () => {
  // 2026-11-01 is the US fall-back. A midnight-anchored subtraction reports
  // 13.958 days across it and rounds to the wrong side of a boundary.
  assert.equal(daysBetween('2026-10-25', '2026-11-08'), 14);
  assert.equal(daysBetween('2026-11-08', '2026-10-25'), -14);
  assert.equal(daysBetween('2026-08-24', '2026-08-24'), 0);
});

test('an ordinary op covers exactly its own day', () => {
  assert.deepEqual(spanDates({ date: '2026-09-14' }), ['2026-09-14']);
  assert.deepEqual(spanDates({ date: '2026-09-14', end_date: null }), ['2026-09-14']);
  // The same day stated twice is one day, not two.
  assert.deepEqual(spanDates({ date: '2026-09-14', end_date: '2026-09-14' }), ['2026-09-14']);
});

test('a span covers every day it runs through, ends included', () => {
  assert.deepEqual(spanDates({ date: '2026-09-14', end_date: '2026-09-16' }),
    ['2026-09-14', '2026-09-15', '2026-09-16']);
  // Across a month edge, where a day-number loop breaks.
  assert.deepEqual(spanDates({ date: '2026-08-31', end_date: '2026-09-02' }),
    ['2026-08-31', '2026-09-01', '2026-09-02']);
});

test('a nonsense span degrades to one day rather than flooding the grid', () => {
  assert.deepEqual(spanDates({ date: '2026-09-14', end_date: '2026-09-01' }), ['2026-09-14']);
  assert.deepEqual(spanDates({ date: '2026-01-01', end_date: '2027-01-01' }), ['2026-01-01']);
  assert.deepEqual(spanDates({ date: 'nope', end_date: '2026-09-16' }), []);
  // Exactly at the cap is still a real span — the refusal starts one past it.
  const capped = spanDates({ date: '2026-01-01', end_date: addDays('2026-01-01', MAX_SPAN_DAYS) });
  assert.equal(capped.length, MAX_SPAN_DAYS + 1);
});

test('a spanning op lands in every bucket it covers', () => {
  const ops = [
    { id: 'trip', date: '2026-09-14', end_date: '2026-09-16' },
    { id: 'hw', date: '2026-09-15' },
  ];
  const b = bucketByDate(ops);
  assert.deepEqual([...b.keys()].sort(), ['2026-09-14', '2026-09-15', '2026-09-16']);
  assert.deepEqual(b.get('2026-09-14').map(o => o.id), ['trip']);
  assert.deepEqual(b.get('2026-09-15').map(o => o.id), ['trip', 'hw']);
  assert.deepEqual(b.get('2026-09-16').map(o => o.id), ['trip']);
});

test('a multi-day run sits above the appointments inside the day', () => {
  // Every column stacks independently, so a span only reads as ONE bar across
  // the week if it holds the same position in each day it covers.
  const ops = [
    { id: 'hw', date: '2026-09-15', time: '09:00' },
    { id: 'trip', date: '2026-09-14', end_date: '2026-09-17' },
    { id: 'lecture', date: '2026-09-15', all_day: true },
    { id: 'weekend', date: '2026-09-12', end_date: '2026-09-20' },
  ];
  // Longest run first, then the timed work, then the undated marker.
  assert.deepEqual(sortDayOps(ops).map(o => o.id), ['weekend', 'trip', 'hw', 'lecture']);
});

test('spanPosition names the two ends and everything between', () => {
  const op = { date: '2026-09-14', end_date: '2026-09-17' };
  assert.equal(spanPosition(op, '2026-09-14'), 'start');
  assert.equal(spanPosition(op, '2026-09-15'), 'mid');
  assert.equal(spanPosition(op, '2026-09-17'), 'end');
  assert.equal(spanPosition({ date: '2026-09-14' }, '2026-09-14'), 'only');
});

test('a selection dragged backwards picks the same range as forwards', () => {
  assert.deepEqual(orderedRange('2026-09-16', '2026-09-14'), { from: '2026-09-14', to: '2026-09-16' });
  assert.deepEqual(orderedRange('2026-09-14', '2026-09-16'), { from: '2026-09-14', to: '2026-09-16' });
  assert.deepEqual(orderedRange('2026-09-14', '2026-09-14'), { from: '2026-09-14', to: '2026-09-14' });
  assert.equal(orderedRange('2026-09-14', 'nope'), null);
  // A selection dragged off the end of the year is clamped, not refused.
  assert.equal(orderedRange('2026-01-01', '2027-06-01').to, addDays('2026-01-01', MAX_SPAN_DAYS));
});

test('moving an item keeps its length', () => {
  assert.deepEqual(movedDates({ date: '2026-09-14' }, 3), { date: '2026-09-17', end_date: null });
  assert.deepEqual(movedDates({ date: '2026-09-14', end_date: '2026-09-16' }, -2),
    { date: '2026-09-12', end_date: '2026-09-14' });
  // A drag that ends where it started writes nothing — that gesture is a click.
  assert.equal(movedDates({ date: '2026-09-14' }, 0), null);
});

test('resizing moves one edge and refuses to turn the item inside out', () => {
  const op = { date: '2026-09-14', end_date: '2026-09-16' };
  assert.deepEqual(resizedDates(op, 'end', '2026-09-18'), { date: '2026-09-14', end_date: '2026-09-18' });
  assert.deepEqual(resizedDates(op, 'start', '2026-09-12'), { date: '2026-09-12', end_date: '2026-09-16' });
  // Collapsing onto a single day clears end_date rather than storing a
  // same-day span, so the stored shape has exactly one reading.
  assert.deepEqual(resizedDates(op, 'start', '2026-09-16'), { date: '2026-09-16', end_date: null });
  assert.deepEqual(resizedDates(op, 'end', '2026-09-14'), { date: '2026-09-14', end_date: null });
  // Dragging an edge past the other one is a gesture with no meaning.
  assert.equal(resizedDates(op, 'start', '2026-09-17'), null);
  assert.equal(resizedDates(op, 'end', '2026-09-13'), null);
  // No movement, no write.
  assert.equal(resizedDates(op, 'end', '2026-09-16'), null);
  // Past the cap.
  assert.equal(resizedDates(op, 'end', '2027-09-16'), null);
});

test('dueTier is monotonic — a deadline never gets quieter as it closes', () => {
  assert.equal(dueTier(-30), 'overdue');
  assert.equal(dueTier(-1), 'overdue');
  assert.equal(dueTier(0), 'now');
  assert.equal(dueTier(1), 'now');   // tomorrow is the day the work happens
  assert.equal(dueTier(2), 'soon');
  assert.equal(dueTier(7), 'soon');
  assert.equal(dueTier(8), '');
  // Walk the whole line so a refactor cannot swap two rungs silently.
  const rank = { '': 0, soon: 1, now: 2, overdue: 3 };
  let prev = -Infinity;
  for (let d = 45; d >= -45; d--) {
    const r = rank[dueTier(d)];
    assert.ok(r >= prev, `tier fell from ${prev} to ${r} at diff ${d}`);
    prev = r;
  }
});
