// cal-meetings.test.js — when and where you have class.
//
// Everything in cal-meetings.js is inference from prose, so the tests care less
// about getting every syllabus right than about the failure mode: a meeting on
// the calendar at a confidently wrong time and place is worse than a meeting
// with no time at all. Several tests assert that ambiguity yields null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDayCodes, parseTimeRange, parseRoom, parseWeeklyPattern, parseWeeklyPatterns,
  patternFor, meetingsFromSyllabus, meetingsFromCanvasEvents, collectMeetings,
} from '../cal-meetings.js';

test('parseDayCodes reads the compact forms', () => {
  assert.deepEqual(parseDayCodes('MWF'), ['MO', 'WE', 'FR']);
  assert.deepEqual(parseDayCodes('TR'), ['TU', 'TH']);
  assert.deepEqual(parseDayCodes('TTh'), ['TU', 'TH']);
  assert.deepEqual(parseDayCodes('MW'), ['MO', 'WE']);
});

test('parseDayCodes reads the spelled-out forms', () => {
  assert.deepEqual(parseDayCodes('Mon/Wed'), ['MO', 'WE']);
  assert.deepEqual(parseDayCodes('Tuesday, Thursday'), ['TU', 'TH']);
  assert.deepEqual(parseDayCodes('Wednesday'), ['WE']);
});

test('parseDayCodes returns days in week order, deduped', () => {
  assert.deepEqual(parseDayCodes('FMW'), ['MO', 'WE', 'FR']);
  assert.deepEqual(parseDayCodes('MM'), ['MO']);
  assert.deepEqual(parseDayCodes(''), []);
  assert.deepEqual(parseDayCodes(null), []);
});

test('parseTimeRange handles the meridiem trailing the range', () => {
  assert.deepEqual(parseTimeRange('10:00–10:50 AM'), { start: '10:00', end: '10:50' });
  assert.deepEqual(parseTimeRange('1:00-2:15 PM'), { start: '13:00', end: '14:15' });
  assert.deepEqual(parseTimeRange('8:00-9:15'), { start: '08:00', end: '09:15' });
});

test('parseTimeRange resolves afternoon classes written without a meridiem', () => {
  // A college class at "2:00-2:50" is not 2 in the morning.
  assert.deepEqual(parseTimeRange('2:00-2:50'), { start: '14:00', end: '14:50' });
  // …and one that crosses noon still ends after it starts.
  assert.deepEqual(parseTimeRange('11:30-1:00'), { start: '11:30', end: '13:00' });
});

test('parseTimeRange rejects what it cannot read', () => {
  assert.equal(parseTimeRange('mornings'), null);
  assert.equal(parseTimeRange(''), null);
  assert.equal(parseTimeRange(null), null);
});

test('parseRoom finds a building and room number', () => {
  assert.equal(parseRoom('in McNair Hall 314'), 'McNair Hall 314');
  assert.equal(parseRoom('Section 001: 12:00-12:50 MCN 317'), 'MCN 317');
  assert.equal(parseRoom('somewhere unspecified'), null);
});

test('a one-clause schedule parses into one pattern', () => {
  const p = parseWeeklyPattern('Class meets MWF 10:00-10:50 AM in Herring 100');
  assert.deepEqual(p.byday, ['MO', 'WE', 'FR']);
  assert.equal(p.start, '10:00');
  assert.equal(p.end, '10:50');
  assert.equal(p.location, 'Herring 100');
});

test('a two-clause schedule parses into two patterns, not one merged guess', () => {
  const text = 'Lectures MW 8:00-9:15 in McNair Hall 314; Labs Wednesday afternoons 12:00-12:50 MCN 317';
  const ps = parseWeeklyPatterns(text);
  assert.equal(ps.length, 2);
  assert.equal(ps[0].label, 'Lecture');
  assert.deepEqual(ps[0].byday, ['MO', 'WE']);
  assert.equal(ps[1].label, 'Lab');
  assert.equal(ps[1].start, '12:00');
  assert.equal(ps[1].location, 'MCN 317');
});

test('a schedule with no readable time yields no pattern at all', () => {
  assert.deepEqual(parseWeeklyPatterns('Meets Mondays, time TBA'), []);
  assert.equal(parseWeeklyPattern('TBA'), null);
  assert.equal(parseWeeklyPattern(''), null);
  assert.equal(parseWeeklyPattern(null), null);
});

test('patternFor picks by weekday, then by session label', () => {
  const ps = parseWeeklyPatterns('Lectures MW 8:00-9:15 in McNair 314; Labs Wednesday 12:00-12:50 MCN 317');
  // Monday is unambiguous — only the lecture pattern covers it.
  assert.equal(patternFor(ps, { weekday: 'MO', label: 'Anything' }).start, '08:00');
  // Wednesday is shared, so the label decides.
  assert.equal(patternFor(ps, { weekday: 'WE', label: 'Lecture' }).start, '08:00');
  assert.equal(patternFor(ps, { weekday: 'WE', label: 'Lab' }).start, '12:00');
  // …and when the label matches neither, no time is better than the wrong one.
  assert.equal(patternFor(ps, { weekday: 'WE', label: 'Review' }), null);
  assert.equal(patternFor(ps, { weekday: 'FR', label: 'Lecture' }), null);
});

const SYLLABUS = {
  course: {
    meeting_schedule: 'Lectures MW 8:00-9:15 in McNair Hall 314; Labs Wednesday afternoons 12:00-12:50 MCN 317',
  },
  schedule: [
    { date: '2026-01-12', type: 'lecture', title: 'Descriptive Statistics', description: 'Lecture 1', tentative: true },
    { date: '2026-01-14', type: 'other',   title: 'Intro to Python',        description: 'Lab 1' },
    { date: '2026-01-19', type: 'holiday', title: 'MLK Holiday' },
    { date: '2026-01-21', type: 'assignment', title: 'Homework 1', due: true },
    { date: 'week 3',     type: 'lecture', title: 'Undated row' },
    { date: '2026-01-26', type: 'other',   title: 'Reading: chapter 4' },
  ],
};

test('a lecture takes the lecture slot and a lab takes the lab slot', () => {
  const ms = meetingsFromSyllabus(SYLLABUS);
  const lecture = ms.find(m => m.date === '2026-01-12');
  assert.equal(lecture.label, 'Lecture');
  assert.equal(lecture.start, '08:00');
  assert.equal(lecture.location, 'McNair Hall 314');
  const lab = ms.find(m => m.date === '2026-01-14');
  assert.equal(lab.label, 'Lab');
  assert.equal(lab.start, '12:00');
  assert.equal(lab.location, 'MCN 317');
});

test('a holiday is an all-day no-class entry with no room', () => {
  const holiday = meetingsFromSyllabus(SYLLABUS).find(m => m.date === '2026-01-19');
  assert.equal(holiday.label, 'No class');
  assert.equal(holiday.holiday, true);
  assert.equal(holiday.start, null);
  assert.equal(holiday.location, null);
});

test('assignment rows, undated rows and non-session rows are not meetings', () => {
  const ms = meetingsFromSyllabus(SYLLABUS);
  assert.equal(ms.some(m => m.date === '2026-01-21'), false, 'assignment row');
  assert.equal(ms.some(m => m.topic === 'Undated row'), false, 'undated row');
  assert.equal(ms.some(m => m.date === '2026-01-26'), false, 'a reading is not a session');
});

test('a tentative schedule row is marked tentative', () => {
  assert.equal(meetingsFromSyllabus(SYLLABUS).find(m => m.date === '2026-01-12').tentative, true);
});

test('meetingsFromSyllabus survives a missing or malformed syllabus', () => {
  assert.deepEqual(meetingsFromSyllabus(null), []);
  assert.deepEqual(meetingsFromSyllabus({}), []);
  assert.deepEqual(meetingsFromSyllabus({ schedule: 'nope' }), []);
  assert.deepEqual(meetingsFromSyllabus({ schedule: [null, 42, {}] }), []);
});

test("Canvas's own events carry exact times and a real location", () => {
  const ms = meetingsFromCanvasEvents([
    { title: 'BUSI 305 Lecture', start_at: '2026-09-01T14:00:00Z', end_at: '2026-09-01T15:15:00Z', location_name: 'Herring 100' },
  ]);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].location, 'Herring 100');
  assert.equal(ms[0].topic, 'BUSI 305 Lecture');
  assert.equal(ms[0].source, 'Canvas course events');
  // Local time, not UTC — a 14:00Z event is not 14:00 in Houston.
  const local = new Date('2026-09-01T14:00:00Z');
  assert.equal(ms[0].start, `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`);
});

test('a Canvas all-day event has no clock time', () => {
  const [m] = meetingsFromCanvasEvents([
    { title: 'Reading day', start_at: '2026-09-01T00:00:00Z', all_day: true },
  ]);
  assert.equal(m.start, null);
  assert.equal(m.end, null);
});

test('malformed Canvas events are skipped, not crashed on', () => {
  assert.deepEqual(meetingsFromCanvasEvents(null), []);
  assert.deepEqual(meetingsFromCanvasEvents([null, {}, { start_at: 'not a date' }]), []);
  assert.deepEqual(meetingsFromCanvasEvents([{ start_at: '2026-09-01T14:00:00Z', hidden: true }]), []);
});

test('collectMeetings prefers Canvas and does not list a meeting twice', () => {
  const canvasEvents = [
    { title: 'Lecture', start_at: '2026-01-12T14:00:00Z', end_at: '2026-01-12T15:15:00Z', location_name: 'Real Room 1' },
  ];
  const merged = collectMeetings({ syllabusParsed: SYLLABUS, canvasEvents });
  const onThatDay = merged.filter(m => m.date === '2026-01-12');
  // The syllabus row for the same day is at 08:00 and the Canvas one is not,
  // so both survive — but the Canvas one sorts first and keeps its real room.
  assert.equal(onThatDay[0].source, 'Canvas course events');
  assert.equal(onThatDay[0].location, 'Real Room 1');
  // Identical entries from both sources collapse.
  const dup = collectMeetings({
    syllabusParsed: { schedule: [{ date: '2026-01-12', type: 'lecture', title: 'x' }] },
    canvasEvents: [{ title: 'x', start_at: '2026-01-12T00:00:00Z', all_day: true }],
  });
  assert.equal(dup.filter(m => m.date === '2026-01-12').length, 1);
});

test('collectMeetings returns chronological order', () => {
  const ms = collectMeetings({ syllabusParsed: SYLLABUS, canvasEvents: null });
  const dates = ms.map(m => m.date);
  assert.deepEqual(dates, [...dates].sort());
});

// --- Rooms: the ones that are real, and the ones that are somebody's office --

test('a room stated with no cue word at all is still a room', () => {
  // ENTR 222's Canvas home page states its classroom in a table cell, where the
  // column heading is the cue and the sentence never says "in". A building-type
  // noun carrying a number is the whole signal, and the old parser — which
  // needed a lowercase cue and allowed two capitalised words — could not see it.
  assert.equal(
    parseRoom('Section 001 TTh 10:50 AM - 12:05 PM Cambridge Office Building 130 - Liu Idea Lab'),
    'Cambridge Office Building 130',
  );
  // …and the meridiem in front of it is not part of the building's name.
  assert.equal(parseRoom('10:50 AM - 12:05 PM Herring Hall 100'), 'Herring Hall 100');
});

test('a capitalised cue word is still a cue word', () => {
  // The cues were lowercase-only, so a line beginning "In …" and the label
  // "Location:" — the two places a syllabus most often states the room — both
  // parsed to nothing.
  assert.equal(parseRoom('In McNair Hall 314'), 'McNair Hall 314');
  assert.equal(parseRoom('At McNair 314'), 'McNair 314');
  assert.equal(parseRoom('Location: McNair 330'), 'McNair 330');
});

test('"Room 330" — the way everyone writes a room — is a room', () => {
  // The cue branch demanded a capitalised word between "room" and the digits,
  // so the one shape the word "room" exists to catch could never match.
  assert.equal(parseRoom('Room 330'), 'Room 330');
  assert.equal(parseRoom('Rm. 214'), 'Room 214');
  assert.equal(parseRoom('Room: 130'), 'Room 130');
});

test("the instructor's office and the DRC are never offered as the classroom", () => {
  // Every syllabus in this corpus states both, in the same grammar as a
  // classroom. A wrong room is worse than no room.
  assert.equal(parseRoom('Fall 2026 Office: McNair Hall Room 330'), null);
  assert.equal(parseRoom('Professor: Constance Porter, Office Location: 228 McNair Hall'), null);
  assert.equal(parseRoom('Disability Resource Center (Allen Center, Room 111 / adarice@rice.edu / x5841)'), null);
  assert.equal(parseRoom('Office Hours: M/W/F 11:30 - 1:30 in McNair 223'), null);
});

test("a phone number after a building is not that building's room number", () => {
  // The TA cell on ENTR 222's page reads "370 McNair Hall 713-348-4521".
  assert.equal(parseRoom('Rafael Serrillos Barboza 370 McNair Hall 713-348-4521 rs158@rice.edu'), null);
});

test('a bare course code is not a classroom once it is out of a schedule clause', () => {
  // "LETTERS digits" is the shape of a room code AND of a course code. Inside a
  // clause that already states a day and a time it is worth believing; loose in
  // syllabus prose it found "BUSI 374" and put the course number on 28
  // calendar entries as the room.
  assert.equal(parseRoom('BUSI 374 - Operations Management', { allowCode: false }), null);
  assert.equal(parseRoom('Section 001: 12:00-12:50 MCN 317', { allowCode: false }), null);
  assert.equal(parseRoom('Section 001: 12:00-12:50 MCN 317'), 'MCN 317');
});

test('a room on its own line reaches the pattern that has the time', () => {
  // parseClause only reads a room out of the clause that gave it day AND time,
  // so a room stated separately — which is how every course-info block states
  // it — was unreachable by construction.
  const [p] = parseWeeklyPatterns('Lectures TTh 10:50-12:05; the room is Cambridge Office Building 130');
  assert.deepEqual(p.byday, ['TU', 'TH']);
  assert.equal(p.location, 'Cambridge Office Building 130');
  // …but not when two patterns are in play: there is no telling whose room it
  // is, and the lab in the lecture's room is the wrong-place failure.
  const two = parseWeeklyPatterns('Lectures MW 8:00-9:15; Labs Wednesday 12:00-12:50; the room is Herring Hall 100');
  assert.equal(two.length, 2);
  assert.equal(two.every(p2 => p2.location === null), true);
});

// --- Schedule rows that are not sessions -----------------------------------

test('a row that says "No class" must never become a class meeting', () => {
  // BUSI 380's real row. SESSION_RE matches the word "class" inside "No class",
  // so the row was admitted and labelFromText picked the same word back out as
  // the label — the calendar told the student to turn up on the one Tuesday the
  // syllabus tells them not to.
  const ms = meetingsFromSyllabus({
    course: { meeting_schedule: 'TR 10:00-11:15' },
    schedule: [{
      date: '2026-10-06', type: 'other', title: 'Midterm Case Preparation',
      description: 'No class. Students work on Group Midterm Case.',
    }],
  });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].holiday, true);
  assert.equal(ms[0].label, 'No class');
  assert.equal(ms[0].start, null);
  assert.equal(ms[0].topic, 'Midterm Case Preparation');
});

test('a cancelled lecture is a no-class day, whatever the row is typed', () => {
  const ms = meetingsFromSyllabus({
    course: { meeting_schedule: 'MW 8:00-9:15' },
    schedule: [
      { date: '2026-09-09', type: 'lecture', title: 'Regression', description: 'Class cancelled — conference travel.' },
      { date: '2026-09-14', type: 'lecture', title: 'Regression', description: 'Lecture 6' },
    ],
  });
  assert.equal(ms.find(m => m.date === '2026-09-09').holiday, true);
  assert.equal(ms.find(m => m.date === '2026-09-14').start, '08:00');
});

test("a five-week module's start date is a landmark, not a class meeting", () => {
  // BUSI 396's "Course Schedule" table is four rows, each headed by a date
  // RANGE ("Aug 24 – Sep 18"). The extractor kept the start, dropped the end
  // and typed the row `lecture`, so a five-week module became one all-day class
  // meeting — for a class whose meeting days are stated nowhere at all.
  const ms = meetingsFromSyllabus({
    course: { meeting_schedule: null },
    schedule: [
      { date: '2026-08-24', type: 'lecture', week: 1, title: 'Module 1: Think, Then Do Begins' },
      { date: '2026-09-21', type: 'lecture', week: 5, title: 'Module 2: Land Your Message Begins' },
      { date: '2026-10-14', type: 'lecture', week: 8, title: 'Module 3: Communicate in the Real World Begins' },
      { date: '2026-11-02', type: 'lecture', week: 11, title: 'Module 4: Create Impact, Not Output Begins' },
    ],
  });
  assert.deepEqual(ms, []);
});

test('the four module rows BUSI 396 loses must be accounted for, not silently dropped', () => {
  // The landmark rule is correct and it is also the only thing standing between
  // the user and four phantom all-day "classes". But a drop with no record is
  // how BUSI 396 came to show 0 meetings with no stated reason anywhere — the
  // calendar looked broken rather than honest. Every refusal now carries its
  // date and the sentence that explains it, and sync-calendar.js folds these
  // into unscheduled.module_boundary so the count reaches the user.
  const refused = [];
  const ms = meetingsFromSyllabus({
    course: { meeting_schedule: null },
    schedule: [
      { date: '2026-08-24', type: 'lecture', week: 1, title: 'Module 1: Think, Then Do Begins' },
      { date: '2026-09-21', type: 'lecture', week: 5, title: 'Module 2: Land Your Message Begins' },
      { date: '2026-10-14', type: 'lecture', week: 8, title: 'Module 3: Communicate in the Real World Begins' },
      { date: '2026-11-02', type: 'lecture', week: 11, title: 'Module 4: Create Impact, Not Output Begins' },
    ],
  }, null, refused);

  assert.deepEqual(ms, [], 'still no phantom meetings');
  assert.equal(refused.length, 4, 'every row refused a session must leave a record');
  assert.deepEqual(refused.map(r => r.date),
    ['2026-08-24', '2026-09-21', '2026-10-14', '2026-11-02']);
  for (const r of refused) {
    assert.equal(r.reason, 'module_boundary');
    assert.match(r.detail, /date RANGE/);
    assert.ok(r.title, 'the row must be identifiable to a human reading the report');
  }
});

test('collectMeetings forwards refusals so the caller can report them', () => {
  const refused = [];
  const ms = collectMeetings({
    syllabusParsed: {
      course: { meeting_schedule: null },
      schedule: [{ date: '2026-08-24', type: 'lecture', title: 'Module 1 Begins' }],
    },
    canvasEvents: [],
    refused,
  });
  assert.deepEqual(ms, []);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason, 'module_boundary');
});

test('a refusal record is optional — passing nothing must not throw', () => {
  // sync-calendar.js is not the only caller, and an older one passes two args.
  assert.doesNotThrow(() => meetingsFromSyllabus({
    course: { meeting_schedule: null },
    schedule: [{ date: '2026-08-24', type: 'lecture', title: 'Module 1 Begins' }],
  }));
});

test('a module row keeps its slot when a real pattern governs that weekday', () => {
  // The landmark rule only fires where the row could not have been placed as a
  // session anyway. With MW 8:00-9:15 in hand, "Module 3 Begins" on a Wednesday
  // is a session like any other, and dropping it would lose a real class.
  const ms = meetingsFromSyllabus({
    course: { meeting_schedule: 'MW 8:00-9:15' },
    schedule: [{ date: '2026-10-14', type: 'lecture', title: 'Module 3: Real World Begins' }],
  });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].start, '08:00');
});

// --- Tables keyed by week, not by session -----------------------------------

// BUSI 305's schedule, in the shape the parser wrote it: one row per week, every
// row dated at the Monday the week starts, and a course.meeting_schedule of
// null because the syllabus states no day or time anywhere. The left column of
// the real table reads "Sep 7 (no classes Monday and Tuesday)".
const WEEK_KEYED = {
  course: { meeting_schedule: null },
  schedule: [
    { date: '2026-08-24', type: 'lecture', week: 1, title: 'Accounting overview' },
    { date: '2026-08-31', type: 'lecture', week: 2, title: 'Transaction analysis' },
    { date: '2026-09-07', type: 'lecture', week: 3, title: 'Transaction analysis' },
    { date: '2026-09-14', type: 'lecture', week: 4, title: 'Revenue recognition' },
    { date: '2026-09-21', type: 'lecture', week: 5, title: 'T-accounts' },
    { date: '2026-10-07', type: 'exam', week: 7, title: 'Exam 1' },
  ],
};

test('a week-keyed table with no pattern must not emit a lecture on every Monday', () => {
  const ms = meetingsFromSyllabus(WEEK_KEYED);
  assert.equal(ms.length, 5, 'the exam row is not a meeting');
  for (const m of ms) {
    assert.equal(m.week_of, true);
    assert.equal(m.start, null, 'no time is known, so none is claimed');
    assert.match(m.label, /^Week of /);
    assert.match(m.source, /week row/);
  }
  // Sep 7 is Labor Day and the syllabus says so in the cell the parser dropped.
  // "Week of Sep 7" is true whichever days this class turns out to meet; "Lecture,
  // Monday 7 September" is a claim we have nothing to back.
  assert.equal(ms.find(m => m.date === '2026-09-07').label, 'Week of Sep 7');
  assert.equal(ms.some(m => m.label === 'Lecture'), false);
});

test('a genuine weekly class keeps its own dates once a pattern names its day', () => {
  // The same table, with a pattern that covers the row's weekday: these are
  // sessions, not week labels, and they keep their date, their label and the
  // pattern's clock.
  const ms = meetingsFromSyllabus({ ...WEEK_KEYED, course: { meeting_schedule: 'Mondays 18:30-19:45' } });
  assert.equal(ms.length, 5);
  assert.equal(ms.every(m => m.week_of === undefined), true);
  assert.equal(ms[0].label, 'Lecture');
  assert.equal(ms[0].start, '18:30');
});

test('a stray row in a per-session table is not read as a week label', () => {
  // Two sessions a week, one row each, and a single mis-dated row: that is not
  // a week-keyed table, so the ordinary reading stands and the odd row keeps
  // its own date rather than turning into a "week of" marker.
  const ms = meetingsFromSyllabus({
    course: { meeting_schedule: null },
    schedule: [
      { date: '2026-08-25', type: 'lecture', week: 1, title: 'Introduction' },
      { date: '2026-08-27', type: 'lecture', week: 1, title: 'What is Product Management?' },
      { date: '2026-09-01', type: 'lecture', week: 2, title: 'AI Basics' },
      { date: '2026-09-03', type: 'lecture', week: 2, title: 'PM Mindset' },
    ],
  });
  assert.equal(ms.length, 4);
  assert.equal(ms.every(m => m.week_of === undefined), true);
});

test('a spread week row must not silently evict the real session in its slot', () => {
  // ENTR 222: "2026-08-29 SA lecture | AI Basics" is a Saturday, produced from a
  // concatenated WkDates column. Saturday is in no pattern, so it is correctly
  // spread across TU/TH — landing a copy on Sep 3 at 10:50, the same dedupe key
  // as the genuine Sep 3 row that comes later in the array. First-wins gave the
  // day to the copy and dropped the real topic with no warning at all.
  const ms = collectMeetings({
    syllabusParsed: {
      course: { meeting_schedule: 'TR, 10:50 am - 12:05 pm' },
      schedule: [
        { date: '2026-08-29', type: 'lecture', title: 'AI Basics' },
        { date: '2026-09-03', type: 'lecture', title: 'PM Mindset + Product Artifacts' },
      ],
    },
    canvasEvents: [],
  });
  const sep3 = ms.filter(m => m.date === '2026-09-03');
  assert.equal(sep3.length, 1);
  // The row's own date beats a date we worked out…
  assert.equal(sep3[0].source, 'syllabus schedule');
  // …and the loser's topic is merged in rather than thrown away, so the student
  // can see that two rows claimed the slot.
  assert.equal(sep3[0].topic, 'PM Mindset + Product Artifacts / AI Basics');
  // The spread copy on the other day of that week is untouched.
  assert.equal(ms.find(m => m.date === '2026-09-01').topic, 'AI Basics');
});
