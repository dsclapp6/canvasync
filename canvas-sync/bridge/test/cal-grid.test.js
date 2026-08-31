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
  minutesOf, opSlot, timeWindow, hourMarks, layoutDay, partitionDenseSlots, DEFAULT_SLOT_MIN,
  renderedEnd,
  MIN_BLOCK_MIN,
  MAX_LANES, laneBudgetFor} from '../public/cal-grid.js';

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

// --- the Week time grid -----------------------------------------------------
// Turning Times on lays the week against a clock. Every case here is a way a
// grid like this lands an item on the wrong row or the wrong width.

test('minutesOf reads a real clock and refuses everything else', () => {
  assert.equal(minutesOf('00:00'), 0);
  assert.equal(minutesOf('09:30'), 570);
  assert.equal(minutesOf('23:59'), 1439);
  for (const v of ['24:00', '09:60', '9:30', '', null, undefined, '0930']) {
    assert.equal(minutesOf(v), null, String(v));
  }
});

test('only single-day timed items go on the clock', () => {
  assert.deepEqual(opSlot({ time: '09:00', end_time: '10:15', all_day: false }),
    { startMin: 540, endMin: 615 });
  // No time, all-day, and multi-day runs are banners, not blocks.
  assert.equal(opSlot({ all_day: true, time: '09:00' }), null);
  assert.equal(opSlot({ time: null }), null);
  assert.equal(opSlot({ time: '09:00', end_date: '2026-09-16', date: '2026-09-14' }), null);
});

test('an item with no end, or a backwards one, gets the default block', () => {
  assert.deepEqual(opSlot({ time: '14:00' }), { startMin: 840, endMin: 840 + DEFAULT_SLOT_MIN });
  // 22:00->02:00 is an overnight one column cannot draw; 14:00->13:00 is a typo.
  assert.deepEqual(opSlot({ time: '22:00', end_time: '02:00' }),
    { startMin: 1320, endMin: 1320 + DEFAULT_SLOT_MIN });
  assert.deepEqual(opSlot({ time: '14:00', end_time: '14:00' }),
    { startMin: 840, endMin: 840 + DEFAULT_SLOT_MIN });
  // Never past the end of the day.
  assert.equal(opSlot({ time: '23:50' }).endMin, 1440);
});

test('the window covers the data but never shrinks below the working day', () => {
  // Nothing timed at all still draws a usable grid.
  assert.deepEqual(timeWindow([]), { from: 480, to: 1200 });
  // A single 2pm lecture must not produce a one-hour strip.
  assert.deepEqual(timeWindow([{ time: '14:00', end_time: '15:15' }]), { from: 480, to: 1200 });
  // An early class and a late one widen it, to whole hours.
  assert.deepEqual(timeWindow([{ time: '07:20' }, { time: '20:30', end_time: '21:45' }]),
    { from: 420, to: 1320 });
  // Banners contribute nothing.
  assert.deepEqual(timeWindow([{ all_day: true, time: '03:00' }]), { from: 480, to: 1200 });
});

test('hour marks start on the hour and are labelled in 12-hour clock', () => {
  const marks = hourMarks({ from: 480, to: 780 });
  assert.deepEqual(marks.map(m => m.min), [480, 540, 600, 660, 720, 780]);
  assert.deepEqual(marks.map(m => m.label), ['8a', '9a', '10a', '11a', '12p', '1p']);
  // Midnight at the far end labels nothing rather than "12a" on the wrong day.
  assert.equal(hourMarks({ from: 1380, to: 1440 }).pop().label, '');
});

test('a day splits into banners and blocks', () => {
  const { allDay, timed } = layoutDay([
    { id: 'lecture', time: '09:00', end_time: '10:15' },
    { id: 'trip', date: '2026-09-14', end_date: '2026-09-16' },
    { id: 'unknown', all_day: true },
  ]);
  assert.deepEqual(allDay.map(o => o.id), ['trip', 'unknown']);
  assert.deepEqual(timed.map(t => t.op.id), ['lecture']);
});

test('overlapping blocks get side-by-side lanes, and the rest keep the full width', () => {
  const { timed } = layoutDay([
    { id: 'a', time: '09:00', end_time: '10:00' },
    { id: 'b', time: '09:30', end_time: '10:30' },
    { id: 'far', time: '16:00', end_time: '17:00' },
  ]);
  const by = Object.fromEntries(timed.map(t => [t.op.id, t]));
  assert.equal(by.a.lane, 0);
  assert.equal(by.b.lane, 1);
  assert.equal(by.a.lanes, 2);
  assert.equal(by.b.lanes, 2);
  // The 4pm item is in its own cluster, so a 9am collision does not squeeze it.
  assert.equal(by.far.lane, 0);
  assert.equal(by.far.lanes, 1);
});

test('items that merely touch do not overlap', () => {
  // 9-10 and 10-11 are back to back, not a collision; splitting the column
  // for them wastes half the width of a day that has no conflict at all.
  const { timed } = layoutDay([
    { id: 'a', time: '09:00', end_time: '10:00' },
    { id: 'b', time: '10:00', end_time: '11:00' },
  ]);
  assert.deepEqual(timed.map(t => t.lanes), [1, 1]);
});

test('a lane is reused once its earlier item has finished', () => {
  // a 9-12 forces b into its own lane, but c starts after b ends, so three
  // overlapping-ish items need two lanes, not three.
  const { timed } = layoutDay([
    { id: 'a', time: '09:00', end_time: '12:00' },
    { id: 'b', time: '09:30', end_time: '10:00' },
    { id: 'c', time: '10:30', end_time: '11:00' },
  ]);
  const by = Object.fromEntries(timed.map(t => [t.op.id, t]));
  assert.equal(by.b.lane, 1);
  assert.equal(by.c.lane, 1);
  assert.equal(by.a.lanes, 2);
});

test('three or more items in the exact same slot become one dense group', () => {
  const laid = layoutDay([
    { id: 'a', time: '23:44', end_time: '23:59' },
    { id: 'b', time: '23:44', end_time: '23:59' },
    { id: 'c', time: '23:44', end_time: '23:59' },
    { id: 'earlier', time: '20:00', end_time: '21:00' },
  ]);
  const { groups, rest } = partitionDenseSlots(laid.timed);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map(item => item.op.id), ['a', 'b', 'c']);
  assert.deepEqual(rest.map(item => item.op.id), ['earlier']);
});

test('two simultaneous items keep the ordinary side-by-side layout', () => {
  const laid = layoutDay([
    { id: 'a', time: '09:00', end_time: '10:00' },
    { id: 'b', time: '09:00', end_time: '10:00' },
  ]);
  const { groups, rest } = partitionDenseSlots(laid.timed);
  assert.equal(groups.length, 0);
  assert.equal(rest.length, 2);
  assert.deepEqual(rest.map(item => item.lanes), [2, 2]);
});

// --- Week-view geometry: rendered extent, lane capacity ---------------------
//
// These guard the invariant the Week view kept breaking: what is MODELLED and
// what is DRAWN must be the same fact. Every symptom in the user's screenshot
// was a version of the two diverging — a block grown past the minutes it
// claimed, a lane narrower than the chip it holds, a clamp taller than the box.

test('a short block occupies the minutes it is actually drawn for', () => {
  // opSlot gives a no-end item 30 minutes, but the renderer will not draw a
  // block shorter than MIN_BLOCK_MIN's worth of pixels. Lane assignment used
  // the 30 and handed the next item the same lane, which then rendered on top.
  assert.equal(renderedEnd(600, 630), 600 + MIN_BLOCK_MIN, 'a 30-minute slot claims the floor');
  assert.equal(renderedEnd(600, 600 + MIN_BLOCK_MIN), 600 + MIN_BLOCK_MIN, 'exactly the floor is unchanged');
  assert.equal(renderedEnd(600, 780), 780, 'a genuinely long block keeps its own end');
});

test('a deadline and a later item that would visually overlap get separate lanes', () => {
  // The I6 shape: 2:00pm no-end deadline (30 modelled minutes, 55 drawn) and a
  // 2:30 lecture. Modelled they merely touch; drawn, the first covers the
  // second's title row.
  const { timed } = layoutDay([
    { date: '2026-09-10', all_day: false, time: '14:00' },
    { date: '2026-09-10', all_day: false, time: '14:30', end_time: '15:30' },
  ]);
  assert.equal(timed.length, 2);
  assert.notEqual(timed[0].lane, timed[1].lane, 'a pixel-overlapping pair must not share a lane');
  assert.equal(timed[0].lanes, 2);
});

test('items that are genuinely clear of each other still share one lane', () => {
  // The other half. A floor that made everything overlap would satisfy the test
  // above while giving every column as many lanes as it has items.
  const { timed } = layoutDay([
    { date: '2026-09-10', all_day: false, time: '09:00', end_time: '10:00' },
    { date: '2026-09-10', all_day: false, time: '13:00', end_time: '14:00' },
  ]);
  assert.equal(timed[0].lane, 0);
  assert.equal(timed[1].lane, 0, 'four hours apart is not a collision');
  assert.equal(timed[0].lanes, 1);
});

test('a cluster too narrow to read becomes one stack, whatever its end times', () => {
  // The exact-slot rule could not see this: four items starting together with
  // DIFFERENT ends never matched `${startMin}|${endMin}`, so they became four
  // lanes of ~44px against a chip whose controls measure 84px.
  const at230 = [
    { date: '2026-09-10', all_day: false, time: '14:30' },
    { date: '2026-09-10', all_day: false, time: '14:30', end_time: '15:00' },
    { date: '2026-09-10', all_day: false, time: '14:30', end_time: '15:30' },
    { date: '2026-09-10', all_day: false, time: '14:30', end_time: '16:00' },
  ];
  const { timed } = layoutDay(at230);
  assert.ok(timed[0].lanes > MAX_LANES, `precondition: ${timed[0].lanes} lanes needed`);
  const { groups, rest } = partitionDenseSlots(timed);
  assert.equal(groups.length, 1, 'the whole cluster collapses to one stack');
  assert.equal(groups[0].length, 4);
  assert.equal(rest.length, 0);
});

test('a cluster that fits within the lane budget is left alone', () => {
  // Two overlapping items are readable side by side — collapsing them would
  // hide work behind a control the user has to open.
  const { timed } = layoutDay([
    { date: '2026-09-10', all_day: false, time: '14:30', end_time: '15:30' },
    { date: '2026-09-10', all_day: false, time: '14:45', end_time: '15:45' },
  ]);
  assert.equal(timed[0].lanes, 2, 'precondition: exactly the budget');
  const { groups, rest } = partitionDenseSlots(timed);
  assert.deepEqual(groups, [], 'two lanes must not be collapsed');
  assert.equal(rest.length, 2);
});

test('the exact-slot rule still fires for identical pileups', () => {
  // Pre-existing behaviour: three or more sharing a start AND an end.
  const same = Array.from({ length: 3 }, () =>
    ({ date: '2026-09-10', all_day: false, time: '09:00', end_time: '10:00' }));
  const { timed } = layoutDay(same);
  const { groups, rest } = partitionDenseSlots(timed);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3);
  assert.equal(rest.length, 0);
});

// --- the lane budget is a WIDTH question, not a count question ------------
//
// Every number below was measured in a browser against the shipped stylesheet
// (a `.cal-week.timed` grid at these mount widths), not chosen: the formula
// predicted the real column width to within 0.29px at seven days and 1px at
// two, and predicted the same lane count as the rendered grid in all 14
// combinations tried.

// The stylesheet's own values. The renderer reads these from getComputedStyle;
// restating them here is what the tests are FOR — if a token moves, these
// expectations should be re-measured rather than silently following it.
const GEO = { daycolMin: 120, gutter: 44, laneMin: 80 };

test('a narrow grid lowers the budget below the count that was shipped', () => {
  // The bug. A 7-day column sits at its 120px floor from 375px all the way to
  // ~950px of grid, so the shipped budget of 2 produced 59.5px chips — measured
  // 19px of overflow out of each chip's own box, with the clock already hidden
  // by the container query in a failed attempt to fit.
  assert.equal(laneBudgetFor(7, 375, GEO), 1);
  assert.equal(laneBudgetFor(7, 768, GEO), 1);
  // Two days was worse: 4 lanes of 40.88px, measured 38px of overflow.
  assert.equal(laneBudgetFor(2, 375, { ...GEO, cap: 4 }), 2);
});

test('a roomy grid does NOT raise the budget past its cap', () => {
  // The other half, and the one a `return 1` would fail. The cap is a product
  // ceiling — past two lanes a week column reads as a wall of slivers even
  // where the pixels fit — so width may only ever narrow it.
  // Measured: a 1920px grid resolves a 7-day column to 267.71px, which affords
  // three 80px lanes. The budget must still be two.
  assert.equal(laneBudgetFor(7, 1920, GEO), MAX_LANES);
  assert.equal(laneBudgetFor(7, 1200, GEO), 2);
  assert.equal(laneBudgetFor(2, 1920, { ...GEO, cap: 4 }), 4);
  // and never more than the caller allows, at any width
  for (const w of [375, 768, 1200, 1920, 4000]) {
    assert.ok(laneBudgetFor(7, w, GEO) <= MAX_LANES, `${w}px exceeded the cap`);
    assert.ok(laneBudgetFor(2, w, { ...GEO, cap: 4 }) <= 4, `${w}px exceeded the cap`);
  }
});

test('the budget never reaches zero, whatever the width', () => {
  // A column can be narrower than one chip — at which point the chip is too
  // wide for the space, which is a clipping problem. Zero lanes would be a
  // DISAPPEARING problem: the day's work would not be drawn at all.
  for (const w of [0, -100, 1, 45, 46]) {
    assert.ok(laneBudgetFor(7, w, GEO) >= 1, `${w}px gave no lanes`);
  }
  assert.equal(laneBudgetFor(0, 1200, GEO), 1, 'no days is not a division');
  assert.equal(laneBudgetFor(7, 1200, { ...GEO, laneMin: 0 }), 1, 'a zero floor is not a division');
});

test('an unmeasured grid keeps the shipped behaviour rather than guessing', () => {
  // A first render into a hidden panel measures 0. Narrowing to one lane there
  // would collapse pileups into stacks on a grid nobody has laid out yet, and
  // the resize check re-renders once it has a width.
  assert.equal(laneBudgetFor(7, 0, GEO), MAX_LANES);
  assert.equal(laneBudgetFor(2, 0, { ...GEO, cap: 4 }), 4);
});

test('the budget follows the COLUMN, so day count alone does not decide it', () => {
  // The mistake this replaced, stated directly: two days used to mean four
  // lanes and seven days two, at every width. Same day count, different width,
  // must be able to give a different answer — and the same width with
  // different day counts must too.
  assert.notEqual(laneBudgetFor(7, 375, GEO), laneBudgetFor(7, 1200, GEO));
  assert.notEqual(
    laneBudgetFor(2, 375, { ...GEO, cap: 4 }),
    laneBudgetFor(2, 1200, { ...GEO, cap: 4 }),
  );
});
