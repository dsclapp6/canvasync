// Office-hours parsing, against the six real syllabus fields in this corpus and
// the ways they each break a naive regex.
//
// The rule under test throughout is the one cal-meetings.js is written around:
// NO TIME BEATS A WRONG TIME. Half of these cases assert that nothing comes
// out.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOfficeHours, parseDateRange, resolveRange, describeOfficeHours, officeHoursFor,
} from '../cal-office-hours.js';

const WIN = ['2026-08-17', '2026-12-29'];

// --- the real fields ------------------------------------------------------

test('BUSI 396: a compact day list and a range that wraps past noon', () => {
  const r = parseOfficeHours('M/W/F 11:30 – 1:30');
  assert.equal(r.patterns.length, 1);
  assert.deepEqual(r.patterns[0].byday, ['MO', 'WE', 'FR']);
  assert.equal(r.patterns[0].start, '11:30');
  assert.equal(r.patterns[0].end, '13:30');
  assert.equal(r.byAppointment, false);
});

test('BUSI 380: a plural weekday, and a trailing meridiem governing both ends', () => {
  const r = parseOfficeHours('Tuesdays, 4:15-5:15PM; flexible by appointment');
  assert.equal(r.patterns.length, 1);
  // "Tuesdays" once parsed as [TU, SA] — the plural fell through to the
  // compact letter walk and the trailing 's' became Saturday.
  assert.deepEqual(r.patterns[0].byday, ['TU']);
  assert.equal(r.patterns[0].start, '16:15');
  assert.equal(r.patterns[0].end, '17:15');
  assert.equal(r.byAppointment, true);
});

test('BUSI 305: the day comes after the time, in the next phrase', () => {
  const r = parseOfficeHours('2:00-3:00 in person on Friday. Additional office hours are available by appointment');
  assert.equal(r.patterns.length, 1);
  assert.deepEqual(r.patterns[0].byday, ['FR']);
  assert.equal(r.patterns[0].start, '14:00');   // a college 2:00 is the afternoon
  assert.equal(r.patterns[0].end, '15:00');
  assert.equal(r.byAppointment, true);
});

test('BUSI 374: two schedules, each fenced by its own date range', () => {
  const r = parseOfficeHours('M 10am-12:15pm; W 11am-12:15pm; or by appointment (8/24 – 10/5); MW 11am-2:15pm; or by appointment (10/7-12/13)');
  assert.equal(r.patterns.length, 3);
  const [a, b, c] = r.patterns;
  assert.deepEqual([a.byday, a.start, a.end], [['MO'], '10:00', '12:15']);
  assert.deepEqual([b.byday, b.start, b.end], [['WE'], '11:00', '12:15']);
  assert.deepEqual([c.byday, c.start, c.end], [['MO', 'WE'], '11:00', '14:15']);
  // The range is stated once, at the end of the group it governs — so it has
  // to attach backwards. Without that, both MW schedules recur all term and
  // every Monday carries two contradictory office hours.
  assert.deepEqual([a.range.from, a.range.to], ['08-24', '10-05']);
  assert.deepEqual([b.range.from, b.range.to], ['08-24', '10-05']);
  assert.deepEqual([c.range.from, c.range.to], ['10-07', '12-13']);
});

test('ECON 205: a weekday and an end time and no start is refused, not guessed', () => {
  const r = parseOfficeHours('By appointment and, on Tuesdays, in the classroom until 9:00 p.m. or until the number of students drops to zero, whichever comes first.');
  assert.deepEqual(r.patterns, []);
  assert.equal(r.byAppointment, true);
  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0].reason, 'no_time');
});

test('ENTR 222: by appointment is not a schedule and produces no complaint', () => {
  const r = parseOfficeHours('By appointment');
  assert.deepEqual(r.patterns, []);
  assert.equal(r.byAppointment, true);
  assert.deepEqual(r.refused, []);
});

// --- what must never come out ---------------------------------------------

test('an empty or missing field yields nothing at all', () => {
  for (const v of [null, undefined, '', '   ']) {
    const r = parseOfficeHours(v);
    assert.deepEqual(r.patterns, []);
    assert.equal(r.byAppointment, false);
    assert.deepEqual(r.refused, []);
  }
});

test('a building\'s opening hours are not office hours', () => {
  const r = parseOfficeHours('Monday-Friday 9:00-5:00');
  assert.deepEqual(r.patterns, []);
  assert.equal(r.refused[0].reason, 'implausible');
});

test('a time with no day is refused', () => {
  const r = parseOfficeHours('Office hours 3:00-4:00');
  assert.deepEqual(r.patterns, []);
  assert.equal(r.refused[0].reason, 'no_day');
});

test('prose words are never read as compact day codes', () => {
  // parseDayCodes('appointment') walks letters and answers [MO, TU]. Nothing
  // reaches it from here that has not already been proved to be a day token.
  for (const s of ['Available by appointment', 'Drop in whenever', 'See Canvas for times']) {
    assert.deepEqual(parseOfficeHours(s).patterns, [], s);
  }
});

// --- date ranges ----------------------------------------------------------

test('parseDateRange reads month/day, and refuses an impossible month', () => {
  assert.deepEqual(
    { ...parseDateRange('(8/24 – 10/5)'), text: undefined },
    { from: '08-24', to: '10-05', fromYear: null, toYear: null, text: undefined },
  );
  assert.equal(parseDateRange('13/1 - 14/2'), null);
  assert.equal(parseDateRange('no dates here'), null);
});

test('parseDateRange keeps a stated year', () => {
  const r = parseDateRange('1/12/2027 to 3/4/2027');
  assert.equal(r.fromYear, 2027);
  assert.equal(r.toYear, 2027);
});

test('resolveRange picks the year that lands the range inside the window', () => {
  assert.deepEqual(
    resolveRange({ from: '08-24', to: '10-05', fromYear: null, toYear: null }, ...WIN),
    { from: '2026-08-24', to: '2026-10-05', ranged: true },
  );
});

test('resolveRange clamps to the window rather than running past it', () => {
  const r = resolveRange({ from: '08-01', to: '12-31', fromYear: null, toYear: null }, ...WIN);
  assert.deepEqual(r, { from: '2026-08-17', to: '2026-12-29', ranged: true });
});

test('a range that runs backwards crossed New Year', () => {
  const r = resolveRange({ from: '12-01', to: '01-15', fromYear: null, toYear: null }, '2026-11-01', '2027-03-01');
  assert.deepEqual(r, { from: '2026-12-01', to: '2027-01-15', ranged: true });
});

test('a range nowhere near the window falls back to the whole window, not to nothing', () => {
  // Dropping the pattern would silently delete real office hours over a
  // mis-scoped qualifier. Widening it at worst shows an hour that has moved.
  const r = resolveRange({ from: '03-01', to: '04-01', fromYear: 2019, toYear: 2019 }, ...WIN);
  assert.deepEqual(r, { from: '2026-08-17', to: '2026-12-29', ranged: false });
});

test('no range at all is the whole window', () => {
  assert.deepEqual(resolveRange(null, ...WIN), { from: '2026-08-17', to: '2026-12-29', ranged: false });
});

// --- the syllabus wrapper -------------------------------------------------

test('officeHoursFor carries the instructor through, and survives a bare object', () => {
  const r = officeHoursFor({ course: { instructor: { name: ' Dr. Leila Peyravan ', email: 'x@rice.edu', office_hours: 'M/W/F 11:30 – 1:30' } } });
  assert.equal(r.instructor, 'Dr. Leila Peyravan');
  assert.equal(r.email, 'x@rice.edu');
  assert.equal(r.patterns.length, 1);

  for (const empty of [null, {}, { course: {} }, { course: { instructor: {} } }]) {
    const e = officeHoursFor(empty);
    assert.deepEqual(e.patterns, []);
    assert.equal(e.instructor, null);
  }
});

test('describeOfficeHours reads as a sentence for one day and for three', () => {
  assert.equal(describeOfficeHours({ byday: ['FR'], start: '14:00', end: '15:00' }), 'Fridays, 14:00–15:00');
  assert.equal(
    describeOfficeHours({ byday: ['MO', 'WE', 'FR'], start: '11:30', end: '13:30' }),
    'Mondays, Wednesdays and Fridays, 11:30–13:30',
  );
});

test('a hyphen between two days is a span, not a list', () => {
  const r = parseOfficeHours('M-F 2:00-3:00');
  assert.deepEqual(r.patterns[0].byday, ['MO', 'TU', 'WE', 'TH', 'FR']);
  const w = parseOfficeHours('Tue-Thu 10:00-11:00am');
  assert.deepEqual(w.patterns[0].byday, ['TU', 'WE', 'TH']);
  // Only a single day at each end. "MW-F" is not a span anyone means, so it
  // degrades to the day list it literally is rather than inventing Tuesday.
  assert.deepEqual(parseOfficeHours('MW 3:00-4:00').patterns[0].byday, ['MO', 'WE']);
});

test('the six fields in this corpus, end to end', () => {
  const corpus = [
    ['M/W/F 11:30 – 1:30', 1],
    ['Tuesdays, 4:15-5:15PM; flexible by appointment', 1],
    ['2:00-3:00 in person on Friday. Additional office hours are available by appointment', 1],
    ['M 10am-12:15pm; W 11am-12:15pm; or by appointment (8/24 – 10/5); MW 11am-2:15pm; or by appointment (10/7-12/13)', 3],
    ['By appointment and, on Tuesdays, in the classroom until 9:00 p.m. or until the number of students drops to zero, whichever comes first.', 0],
    ['By appointment', 0],
  ];
  for (const [field, n] of corpus) {
    const r = parseOfficeHours(field);
    assert.equal(r.patterns.length, n, field);
    // Whatever survives is a complete, plausible, calendarable block.
    for (const p of r.patterns) {
      assert.ok(p.byday.length >= 1);
      assert.match(p.start, /^\d{2}:\d{2}$/);
      assert.match(p.end, /^\d{2}:\d{2}$/);
      assert.ok(p.end > p.start);
    }
  }
});
