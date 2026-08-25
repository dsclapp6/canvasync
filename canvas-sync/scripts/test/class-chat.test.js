// class-chat.test.js — the per-class question answerer.
//
// NOTHING HERE TOUCHES A MODEL. Every path that would reach one takes an
// injected `invoke`; the fakes below record the prompt they were handed and
// return a canned string, and two tests assert that no invoke is called at all
// when there is nothing to answer from.
//
// What has to hold, in order of how badly it hurts when it does not:
//
//   1. A time that is not known must never come out as a time. The project's
//      rule is NO TIME BEATS A WRONG TIME, so `has_time` is false and the
//      rendered text says so in words. Several tests below assert on the
//      ABSENCE of a clock time, which is the only way to test a non-invention.
//   2. The week window is Monday-Sunday in LOCAL time and must survive month
//      and year boundaries. Getting this wrong silently answers "this week"
//      with last week's schedule.
//   3. cleanAnswer must strip the model's preamble WITHOUT mangling an answer
//      that legitimately starts with one of the same words, and must delete a
//      citation naming a source that was never supplied.
//   4. resolveClass must refuse to guess. A confidently wrong class is worse
//      than a clarifying question, which the user explicitly allowed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  classFacts, renderFacts, gatherSources, buildPrompt, cleanAnswer, relatedMaterials,
  answerQuestion, resolveClass,
  weekWindow, localIsoDate, clock12, splitPassages, scorePassage,
  NO_ANSWER, DEFAULT_BUDGET_CHARS,
} from '../class-chat.js';

// --- Fixtures -------------------------------------------------------------

async function tempClass(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'classchat-'));
  for (const [name, body] of Object.entries(files)) {
    const abs = join(dir, name);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

const cleanup = dir => rm(dir, { recursive: true, force: true });

/** A fake invoke that records every prompt and answers with a canned string. */
function fakeInvoke(reply = 'Stub answer.') {
  const calls = [];
  const fn = async (prompt) => { calls.push(prompt); return reply; };
  fn.calls = calls;
  return fn;
}

/** An invoke that fails the test if it is ever called. */
function forbiddenInvoke() {
  return async () => { assert.fail('the model was invoked when it must not have been'); };
}

const TERM = {
  id: '1551',
  name: 'Fall Semester 2026 Full Term',
  start_at: '2026-07-24T00:00:00Z',
  end_at: '2027-06-04T00:00:00Z',
};

function meta(overrides = {}) {
  return { id: '999', name: 'BUSI 380 002 F26', course_code: 'BUSI 380 002', term: TERM, ...overrides };
}

function parsed({ meeting = 'Tuesdays and Thursdays', schedule = [], course = {} } = {}) {
  return {
    extracted_at: '2026-08-01T00:00:00Z',
    source_file: 'syllabus.html',
    course: { title: 'Marketing', code: 'BUSI 380', term: 'Fall 2026', meeting_schedule: meeting, ...course },
    schedule,
    grading: {},
    policies: {},
  };
}

const lecture = (date, title) => ({ date, type: 'lecture', title, description: '', due: false, tentative: false });

// A paragraph that mentions `word` and is long enough to be its own passage.
const block = (word, n = 3) =>
  `${word} block. ` + `The ${word} of demand determines how quantity responds to a price change here. `.repeat(n);

// ==========================================================================
// 1. Week window, local time, boundaries
// ==========================================================================

test('weekWindow returns the Monday-Sunday week containing the date', () => {
  // A Monday is its own week start.
  assert.deepEqual(weekWindow(new Date(2026, 7, 24, 9, 0)), { start: '2026-08-24', end: '2026-08-30' });
  // A Tuesday looks back one day.
  assert.deepEqual(weekWindow(new Date(2026, 7, 25, 23, 30)), { start: '2026-08-24', end: '2026-08-30' });
  // A Sunday belongs to the week that STARTED six days ago, not the one about
  // to start — getDay() returns 0 for Sunday and the naive (day - 1) is off by
  // a whole week exactly one day in seven.
  assert.deepEqual(weekWindow(new Date(2026, 7, 30, 12, 0)), { start: '2026-08-24', end: '2026-08-30' });
});

test('weekWindow crosses a month boundary', () => {
  // Sunday 2026-03-01 belongs to the week that began Monday 2026-02-23.
  assert.deepEqual(weekWindow(new Date(2026, 2, 1, 12, 0)), { start: '2026-02-23', end: '2026-03-01' });
  // Monday 2026-06-01 starts a week that ends inside June.
  assert.deepEqual(weekWindow(new Date(2026, 5, 1, 0, 5)), { start: '2026-06-01', end: '2026-06-07' });
  // Sunday 2026-05-31 closes the week that began in May.
  assert.deepEqual(weekWindow(new Date(2026, 4, 31, 12, 0)), { start: '2026-05-25', end: '2026-05-31' });
});

test('weekWindow crosses a year boundary', () => {
  // Thursday 2026-01-01: the week started in the previous YEAR.
  assert.deepEqual(weekWindow(new Date(2026, 0, 1, 9, 0)), { start: '2025-12-29', end: '2026-01-04' });
  // Sunday 2026-01-04 is the last day of that same week.
  assert.deepEqual(weekWindow(new Date(2026, 0, 4, 22, 0)), { start: '2025-12-29', end: '2026-01-04' });
  // Thursday 2025-12-31 is in it too.
  assert.deepEqual(weekWindow(new Date(2025, 11, 31, 12, 0)), { start: '2025-12-29', end: '2026-01-04' });
});

test('weekWindow survives the spring-forward Sunday', () => {
  // 2026-03-08 is the US DST switch. Date arithmetic done in UTC ms would
  // land an hour short and roll the date back.
  assert.deepEqual(weekWindow(new Date(2026, 2, 8, 12, 0)), { start: '2026-03-02', end: '2026-03-08' });
});

test('localIsoDate uses local calendar fields, not the UTC string', () => {
  // 11:59 PM local on the 24th is the 24th, whatever UTC calls it.
  assert.equal(localIsoDate(new Date(2026, 7, 24, 23, 59)), '2026-08-24');
  assert.equal(localIsoDate(new Date(2026, 0, 1, 0, 1)), '2026-01-01');
});

test('clock12 formats, and refuses anything that is not a clock time', () => {
  assert.equal(clock12('14:30'), '2:30 PM');
  assert.equal(clock12('00:05'), '12:05 AM');
  assert.equal(clock12('12:00'), '12:00 PM');
  assert.equal(clock12('09:00'), '9:00 AM');
  assert.equal(clock12(null), null);
  assert.equal(clock12(''), null);
  assert.equal(clock12('soon'), null);
  assert.equal(clock12('25:00'), null);
});

// ==========================================================================
// 2. classFacts — meetings
// ==========================================================================

test('this_week spans a year boundary and reports days without inventing a time', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({
      schedule: [
        lecture('2025-12-23', 'Before the break'),
        lecture('2025-12-30', 'Session A'),
        lecture('2026-01-01', 'Session B'),
        lecture('2026-01-06', 'Next week'),
      ],
    }),
    'assignments.json': [],
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 0, 1, 9, 0) });
    assert.equal(facts.today, '2026-01-01');
    assert.deepEqual(facts.meetings.this_week.map(m => m.date), ['2025-12-30', '2026-01-01']);
    assert.deepEqual(facts.meetings.this_week.map(m => m.weekday), ['Tuesday', 'Thursday']);
    // The syllabus says "Tuesdays and Thursdays" and never states a clock time.
    for (const m of facts.meetings.this_week) {
      assert.equal(m.has_time, false);
      assert.equal(m.start, null);
      assert.equal(m.end, null);
    }
    assert.equal(facts.meetings.next.date, '2026-01-01');
    assert.equal(facts.meetings.next.has_time, false);

    const text = renderFacts(facts);
    assert.match(text, /This week \(Mon 2025-12-29 to Sun 2026-01-04\)/);
    assert.match(text, /time not known/);
    // The whole point: no clock time appears anywhere in the MEETINGS block.
    const meetingsBlock = text.slice(text.indexOf('MEETINGS'), text.indexOf('WORK'));
    assert.equal(/\d{1,2}:\d{2}\s?(AM|PM)/.test(meetingsBlock), false, meetingsBlock);
  } finally { await cleanup(dir); }
});

test('a known meeting time is rendered as a clock time', async () => {
  const dir = await tempClass({
    'metadata.json': meta({ course_code: 'BUSI 374 001/002' }),
    'syllabus_parsed.json': parsed({
      meeting: 'MW 2:30-3:45pm',
      schedule: [lecture('2026-08-24', 'Kickoff'), lecture('2026-08-26', 'Process design')],
    }),
    'assignments.json': [],
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 7, 24, 8, 0) });
    assert.equal(facts.meetings.source, 'syllabus-field');
    assert.equal(facts.meetings.this_week.length, 2);
    assert.equal(facts.meetings.this_week[0].has_time, true);
    assert.equal(facts.meetings.this_week[0].start, '14:30');
    assert.match(renderFacts(facts), /2:30 PM-3:45 PM/);
  } finally { await cleanup(dir); }
});

test('a class with no meeting times at all says so instead of guessing', async () => {
  // BUSI 305 and BUSI 396 are genuinely like this: no meeting_schedule field,
  // no Canvas events, no time anywhere in the syllabus text.
  const dir = await tempClass({
    'metadata.json': meta({ course_code: 'BUSI 305 001/002/003' }),
    'syllabus_parsed.json': { course: {}, schedule: [] },
    'assignments.json': [],
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 7, 24, 8, 0) });
    assert.equal(facts.meetings.source, 'none');
    assert.deepEqual(facts.meetings.patterns, []);
    assert.deepEqual(facts.meetings.this_week, []);
    assert.equal(facts.meetings.next, null);

    const text = renderFacts(facts);
    assert.match(text, /Weekly pattern: not known for this class\./);
    assert.match(text, /No meetings are listed for this week\./);
    assert.match(text, /Next meeting: none listed on or after today\./);
    const meetingsBlock = text.slice(text.indexOf('MEETINGS'), text.indexOf('WORK'));
    assert.equal(/\d{1,2}:\d{2}/.test(meetingsBlock), false, meetingsBlock);
  } finally { await cleanup(dir); }
});

test('with no dated schedule, this week comes from the weekly pattern and says so', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({ meeting: 'TR, 10:50 am - 12:05 pm', schedule: [] }),
    'assignments.json': [],
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 7, 24, 8, 0) });
    assert.deepEqual(facts.meetings.this_week.map(m => m.date), ['2026-08-25', '2026-08-27']);
    assert.equal(facts.meetings.this_week[0].start, '10:50');
    assert.equal(facts.meetings.next.date, '2026-08-25');
    assert.ok(facts.meetings.warnings.some(w => /weekly pattern/i.test(w)),
      JSON.stringify(facts.meetings.warnings));
  } finally { await cleanup(dir); }
});

test('a dated schedule is trusted about which weeks meet — no invented lectures in a gap week', async () => {
  // The syllabus lists sessions in week 1 and week 3. Week 2 is a gap. A
  // pattern-driven generator would put two lectures in it; a wrong meeting is
  // exactly what this module refuses to produce.
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({
      schedule: [
        lecture('2026-08-25', 'Week 1 Tue'),
        lecture('2026-08-27', 'Week 1 Thu'),
        lecture('2026-09-08', 'Week 3 Tue'),
      ],
    }),
    'assignments.json': [],
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 8, 1, 8, 0) }); // Tue of the gap week
    assert.deepEqual(facts.meetings.this_week, []);
    assert.equal(facts.meetings.next.date, '2026-09-08');
    assert.equal(renderFacts(facts).includes('No meetings are listed for this week.'), true);
  } finally { await cleanup(dir); }
});

test('a holiday row is shown in the week but is never the next meeting', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({
      schedule: [
        { date: '2026-10-13', type: 'holiday', title: 'Midterm Recess', description: 'No class.' },
        lecture('2026-10-15', 'Back to it'),
      ],
    }),
    'assignments.json': [],
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 9, 12, 8, 0) }); // Monday
    assert.deepEqual(facts.meetings.this_week.map(m => m.date), ['2026-10-13', '2026-10-15']);
    assert.equal(facts.meetings.this_week[0].holiday, true);
    assert.equal(facts.meetings.next.date, '2026-10-15');
    assert.match(renderFacts(facts), /NO CLASS/);
  } finally { await cleanup(dir); }
});

test('a meeting that has already finished today is not the next meeting', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({
      meeting: 'MW 2:30-3:45pm',
      schedule: [lecture('2026-08-24', 'Today'), lecture('2026-08-26', 'Wednesday')],
    }),
    'assignments.json': [],
    'calendar_events.json': [],
  });
  try {
    const before = await classFacts(dir, { now: new Date(2026, 7, 24, 9, 0) });
    assert.equal(before.meetings.next.date, '2026-08-24');
    const after = await classFacts(dir, { now: new Date(2026, 7, 24, 17, 0) });
    assert.equal(after.meetings.next.date, '2026-08-26');
    // Both weeks still list today's meeting — it happened, it belongs in the week.
    assert.equal(after.meetings.this_week.length, 2);
  } finally { await cleanup(dir); }
});

test('a schedule that has run out says so rather than rolling the pattern forward', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({ schedule: [lecture('2026-08-25', 'Last one')] }),
    'assignments.json': [],
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 11, 1, 8, 0) });
    assert.equal(facts.meetings.next, null);
    assert.ok(facts.meetings.warnings.some(w => /schedule ends 2026-08-25/.test(w)),
      JSON.stringify(facts.meetings.warnings));
  } finally { await cleanup(dir); }
});

// ==========================================================================
// 3. classFacts — work and exams
// ==========================================================================

const canvasAssignment = (id, name, dueAt, extra = {}) => ({
  id, name, due_at: dueAt, points_possible: 100, html_url: `https://canvas.test/a/${id}`, ...extra,
});

test('next_exam comes from the syllabus schedule when Canvas has no exam row', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({
      schedule: [
        lecture('2026-09-01', 'Ordinary session'),
        { date: '2026-09-15', type: 'exam', title: 'Midterm Exam', description: 'In class.' },
      ],
    }),
    // Canvas knows only about a homework. No exam anywhere in assignments.json.
    'assignments.json': [canvasAssignment(1, 'Homework 1', '2026-09-02T04:59:00Z')],
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 7, 24, 8, 0) });
    assert.ok(facts.tasks.next_exam, 'expected an exam');
    assert.equal(facts.tasks.next_exam.date, '2026-09-15');
    assert.equal(facts.tasks.next_exam.source, 'syllabus schedule');
    // The syllabus row states no clock time and none is invented.
    assert.equal(facts.tasks.next_exam.time, null);
    assert.match(renderFacts(facts), /Next exam: 2026-09-15 \(time of day not known\) — Midterm Exam/);
  } finally { await cleanup(dir); }
});

test('an exam already past is not the next exam', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({
      schedule: [
        { date: '2026-08-10', type: 'exam', title: 'Exam 1' },
        { date: '2026-11-05', type: 'exam', title: 'Exam 2' },
      ],
    }),
    'assignments.json': [],
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 7, 24, 8, 0) });
    assert.equal(facts.tasks.next_exam.date, '2026-11-05');
    assert.equal(facts.tasks.next_exam.title, 'Exam 2');
  } finally { await cleanup(dir); }
});

test('on the same day, the graded row with a clock time beats the syllabus prose', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({
      schedule: [{ date: '2026-10-08', type: 'assignment', title: 'Midterm Case Assignment Due', due: true }],
    }),
    'assignments.json': [canvasAssignment(7, 'Midterm Case Assignment-Group', '2026-10-08T18:00:00Z')],
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 7, 24, 8, 0) });
    assert.equal(facts.tasks.next_exam.date, '2026-10-08');
    assert.equal(facts.tasks.next_exam.title, 'Midterm Case Assignment-Group');
    assert.ok(facts.tasks.next_exam.time, 'expected a clock time from the graded row');
    assert.match(renderFacts(facts), /Next exam: 2026-10-08 at \d{1,2}:\d{2} (AM|PM)/);
  } finally { await cleanup(dir); }
});

test('rows that merely name an exam word are not reported as exams', async () => {
  // Every one of these is real BUSI 380 syllabus text. None of them is an exam,
  // and reporting one as "your next exam" is worse than reporting nothing.
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({
      schedule: [
        { date: '2026-10-06', type: 'other', title: 'Midterm Case Preparation', description: 'No class. Work on Midterm Case.' },
        { date: '2026-10-13', type: 'holiday', title: 'Midterm Recess', description: 'No class.' },
        { date: '2026-12-01', type: 'other', title: 'Final Case Released', description: 'Released via Canvas at 3:45 PM.' },
        { date: '2026-12-03', type: 'lecture', title: 'Final Session', description: 'Course wrap-up.' },
      ],
    }),
    'assignments.json': [],
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 7, 24, 8, 0) });
    assert.equal(facts.tasks.next_exam, null);
    assert.match(renderFacts(facts), /Next exam: no exam is dated on or after today/);
  } finally { await cleanup(dir); }
});

test('an exam nobody has dated is named as undated, not given a date', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({ schedule: [] }),
    'assignments.json': [],
    'assignments_mined.json': {
      items: [
        { id: 'exam-1', title: 'Exam 1', category: 'exam', due_date: null, due_time: null, source: 'mined' },
        { id: 'exam-2', title: 'Final Exam', category: 'exam', due_date: null, due_time: null, source: 'mined' },
      ],
    },
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 7, 24, 8, 0) });
    assert.equal(facts.tasks.next_exam, null);
    assert.deepEqual(facts.tasks.undated_exams, ['Exam 1', 'Final Exam']);
    const text = renderFacts(facts);
    assert.match(text, /Exams named but not dated: Exam 1; Final Exam\./);
    assert.match(text, /Next exam: no exam is dated on or after today/);
  } finally { await cleanup(dir); }
});

test('upcoming is capped and overdue is counted', async () => {
  const rows = [];
  for (let i = 1; i <= 12; i++) {
    const day = String(i).padStart(2, '0');
    rows.push(canvasAssignment(i, `Concept Check ${i}`, `2026-09-${day}T19:30:00Z`));
  }
  rows.push(canvasAssignment(90, 'Old thing A', '2026-08-01T19:30:00Z'));
  rows.push(canvasAssignment(91, 'Old thing B', '2026-08-02T19:30:00Z'));
  const dir = await tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({ schedule: [] }),
    'assignments.json': rows,
    'calendar_events.json': [],
  });
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 7, 24, 8, 0) });
    assert.equal(facts.tasks.upcoming.length, 8);
    assert.equal(facts.tasks.upcoming[0].date, '2026-09-01');
    assert.equal(facts.tasks.overdue_count, 2);
    assert.equal(facts.tasks.total_dated, 14);
    assert.equal(facts.tasks.source, 'canvas');
  } finally { await cleanup(dir); }
});

test('classFacts on an empty directory degrades instead of throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'classchat-empty-'));
  try {
    const facts = await classFacts(dir, { now: new Date(2026, 7, 24, 8, 0) });
    assert.equal(facts.today, '2026-08-24');
    assert.equal(facts.class.slug, dir.split('/').pop());
    assert.deepEqual(facts.meetings.this_week, []);
    assert.equal(facts.tasks.next_exam, null);
    assert.deepEqual(facts.tasks.upcoming, []);
    assert.ok(facts.warnings.length);
    assert.ok(renderFacts(facts).includes('FACTS'));
  } finally { await cleanup(dir); }
});

test('renderFacts survives a null facts object', () => {
  assert.match(renderFacts(null), /FACTS/);
  assert.match(renderFacts(undefined), /none available/);
});

// ==========================================================================
// 4. Passage splitting and scoring
// ==========================================================================

test('splitPassages breaks a line-per-sentence deck into passages, not one blob', () => {
  const deck = Array.from({ length: 60 }, (_, i) =>
    `Slide line ${i}: pricing strategy considerations for the channel decision.`).join('\n');
  const parts = splitPassages(deck);
  assert.ok(parts.length > 4, `expected several passages, got ${parts.length}`);
  for (const p of parts) assert.ok(p.length <= 900, `passage too long: ${p.length}`);
  // Nothing is lost: every line still appears somewhere.
  assert.ok(parts.join('\n').includes('Slide line 59'));
});

test('splitPassages hard-cuts one enormous unwrapped line', () => {
  const long = `${'Sentence about elasticity and demand. '.repeat(120)}`;
  const parts = splitPassages(long);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 900, `passage too long: ${p.length}`);
});

test('splitPassages returns nothing for empty or non-string input', () => {
  assert.deepEqual(splitPassages(''), []);
  assert.deepEqual(splitPassages(null), []);
  assert.deepEqual(splitPassages('   \n\n  '), []);
});

test('scorePassage only fires on shared vocabulary and discounts length', () => {
  const q = new Set(['elasticity', 'demand']);
  assert.equal(scorePassage('Nothing to do with the topic at hand.', q), 0);
  assert.ok(scorePassage('Elasticity of demand.', q) > 0);
  // Both terms beat one.
  assert.ok(scorePassage('Elasticity of demand.', q) > scorePassage('Elasticity alone.', q));
  // A short exact hit beats the same hit buried in a wall of unrelated text.
  const buried = `Elasticity of demand. ${'Filler sentence with unrelated words. '.repeat(20)}`;
  assert.ok(scorePassage('Elasticity of demand.', q) > scorePassage(buried, q));
  assert.equal(scorePassage('anything', new Set()), 0);
});

// ==========================================================================
// 5. gatherSources — graph-driven retrieval
// ==========================================================================

function graphOf(nodes, edges = []) {
  return { version: 1, class: { slug: 'test', code: 'TEST 100', name: 'Test' }, nodes, edges, stats: {} };
}

const fileNode = (id, label, textPath, terms) =>
  ({ id, kind: 'file', label, date: null, textPath, canvasId: id.split(':')[1], url: null, terms });

test('an empty selection returns an empty array and reads nothing', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'files_index.json': [{ canvasId: '1', displayName: 'Deck.pptx', materialsPath: 'materials/deck.txt' }],
    'materials/deck.txt': 'Pricing and elasticity content.',
  });
  try {
    // Every token here is a stopword, so selectForQuery has nothing to seed on.
    const sources = await gatherSources(dir, 'when is the class');
    assert.deepEqual([...sources], []);
    assert.equal(sources.stats.nodesSelected, 0);
  } finally { await cleanup(dir); }
});

// --- 5b. The second retriever ---------------------------------------------
//
// Every test below is a real failure observed against this user's BUSI 380 on
// 2026-08-24, before the full-text sweep was merged into gatherSources. The
// graph stores each node as its top-12 tf-idf terms, and twelve words cannot
// stand in for a thirty-page syllabus.

/** A syllabus long enough that its answer is buried, the way a real one is. */
const SYLLABUS = [
  'Marketing 380 Syllabus Fall 2026',
  'Course Description. This course covers the fundamentals of marketing strategy across the term, ' +
  'including segmentation, positioning, channel design and pricing, with a heavy emphasis on cases.',
  'Assessment of Learning: Graded Assignments and Policies. Group Analysis of a Midterm Case. ' +
  'You will work in groups to respond to the midterm case assignment, which is graded out of one ' +
  'hundred points and counts for twenty percent of the final grade.',
  'Grading Penalty for Unexcused Absences. Missing nine or more classes lowers your final grade ' +
  'by one letter, and attendance is taken at the start of every session.',
].join('\n\n');

test('a question the graph cannot route still reaches the syllabus that answers it', async () => {
  // The real one: "what is the grading breakdown" selected ZERO graph nodes on
  // BUSI 380 and therefore returned zero sources, so the model correctly said
  // it had no material — while the syllabus answered the question outright.
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/Marketing 380 Syllabus.pdf.txt': SYLLABUS,
  });
  try {
    const sources = await gatherSources(dir, 'what is the grading breakdown', { graph: graphOf([]) });
    assert.ok(sources.length > 0, 'the syllabus must be reachable when the graph selects nothing');
    assert.ok(sources.every(s => s.kind === 'file'));
    assert.match(sources.map(s => s.text).join(' '), /grading penalty|graded assignments/i);
    assert.equal(sources.stats.nodesSelected, 0);
    assert.ok(sources.stats.textUsed > 0);
  } finally { await cleanup(dir); }
});

test('a policy question forces the syllabus in even when no passage clears the bar', async () => {
  // "attendance policy" is the case where an empty result is a retrieval
  // failure, not an answer — a syllabus always says something about it.
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/Course Syllabus.pdf.txt':
      'Attendance. Roll is taken each session and repeated absence is handled under the honor code.',
  });
  try {
    const sources = await gatherSources(dir, 'what is the attendance policy', { graph: graphOf([]) });
    assert.ok(sources.length > 0);
    assert.equal(sources.stats.syllabusForced, true);
  } finally { await cleanup(dir); }
});

test('eight bare titles do not crowd out the passage that answers the question', async () => {
  // The exact shape of the "how is the midterm case graded" failure: the graph
  // filled all eight slots with node labels totalling 837 characters against a
  // 20,000 character budget, and the two syllabus paragraphs never got in.
  const files = { 'metadata.json': meta(), 'materials/Syllabus.pdf.txt': SYLLABUS };
  const nodes = [];
  for (let i = 0; i < 8; i++) {
    files[`materials/t${i}.txt`] = `Midterm case week ${i}`;   // a title and nothing else
    nodes.push(fileNode(`file:t${i}`, `Week ${i}: Midterm Case`, `materials/t${i}.txt`,
      { midterm: 0.9, case: 0.8 }));
  }
  const dir = await tempClass(files);
  try {
    const sources = await gatherSources(dir, 'how is the midterm case graded', { graph: graphOf(nodes) });
    assert.ok(sources.length <= 8, 'the cap still holds');
    const fromSyllabus = sources.filter(s => /syllabus/i.test(s.label));
    assert.ok(fromSyllabus.length > 0, 'the syllabus must survive eviction of the bare titles');
    assert.match(fromSyllabus.map(s => s.text).join(' '), /graded assignments and policies/i);
  } finally { await cleanup(dir); }
});

test('tags stay contiguous after a crowded-out source is evicted', async () => {
  // Eviction happens after tagging used to, and a prompt citing [S3] when no
  // [S3] is listed is the fabricated-citation failure cleanAnswer exists for.
  const files = { 'metadata.json': meta(), 'materials/Syllabus.pdf.txt': SYLLABUS };
  const nodes = [];
  for (let i = 0; i < 8; i++) {
    files[`materials/t${i}.txt`] = `Midterm case ${i}`;
    nodes.push(fileNode(`file:t${i}`, `Week ${i}`, `materials/t${i}.txt`, { midterm: 0.9, case: 0.8 }));
  }
  const dir = await tempClass(files);
  try {
    const sources = await gatherSources(dir, 'how is the midterm case graded', { graph: graphOf(nodes) });
    assert.deepEqual(sources.map(s => s.tag), sources.map((_, i) => `S${i + 1}`));
  } finally { await cleanup(dir); }
});

test('a one-word question does not drag in unrelated decks', async () => {
  // "when does this class meet this week" reduces to {meet}, and one common
  // term matched three slide decks that had nothing to do with the question.
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/Syllabus.pdf.txt': 'Office hours. The professor is happy to meet by appointment.',
    'materials/46. Assess Growth.pptx.txt': 'Assess and select growth opportunities. Teams meet to review the portfolio.',
    'materials/34. Segmentation.pptx.txt': 'Assess the quality of your segmentation scheme when the team meets.',
  });
  try {
    const sources = await gatherSources(dir, 'when does this class meet this week', { graph: graphOf([]) });
    assert.ok(sources.every(s => /syllabus/i.test(s.label)),
      `only the syllabus should answer a one-term question, got ${sources.map(s => s.label).join(', ')}`);
  } finally { await cleanup(dir); }
});

test('the same passage found by both retrievers is paid for once', async () => {
  const body = 'Elasticity of demand determines how a price change moves unit volume across the line.';
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/deck.txt': body,
  });
  try {
    const graph = graphOf([fileNode('file:deck', 'Deck', 'materials/deck.txt', { elasticity: 0.9, demand: 0.8 })]);
    const sources = await gatherSources(dir, 'elasticity of demand', { graph });
    const bodies = sources.map(s => s.text.replace(/\s+/g, ' ').trim());
    assert.equal(new Set(bodies).size, bodies.length, 'no source may repeat another verbatim');
  } finally { await cleanup(dir); }
});

test('fullText:false leaves the old graph-only behaviour exactly as it was', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/Syllabus.pdf.txt': SYLLABUS,
  });
  try {
    const sources = await gatherSources(dir, 'what is the grading breakdown',
      { graph: graphOf([]), fullText: false });
    assert.deepEqual([...sources], []);
    assert.equal(sources.stats.textUsed, 0);
  } finally { await cleanup(dir); }
});

test('a class with no materials directory is not an error, just no text hits', async () => {
  const dir = await tempClass({ 'metadata.json': meta() });
  try {
    const sources = await gatherSources(dir, 'what is the grading breakdown', { graph: graphOf([]) });
    assert.deepEqual([...sources], []);
    assert.equal(sources.stats.textHits, 0);
  } finally { await cleanup(dir); }
});

test('gatherSources takes the relevant passages and leaves the rest of the file behind', async () => {
  const filler = Array.from({ length: 40 }, (_, i) =>
    `Line ${i}: zzzmarker unrelated administrative housekeeping note for the roster.`).join('\n');
  const body = `${filler}\n\n${block('elasticity')}\n\n${filler}`;
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/deck.txt': body,
  });
  try {
    const graph = graphOf([fileNode('file:1', 'Pricing deck', 'materials/deck.txt', { elasticity: 0.9 })]);
    const sources = await gatherSources(dir, 'explain elasticity', { graph });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].tag, 'S1');
    assert.equal(sources[0].nodeId, 'file:1');
    assert.match(sources[0].text, /elasticity/i);
    assert.equal(sources[0].text.includes('zzzmarker'), false, 'irrelevant passages leaked in');
    assert.ok(sources[0].chars < body.length / 3,
      `expected a fraction of the file, got ${sources[0].chars} of ${body.length}`);
    // Only one passage of the document was ever in the running; the rest never
    // scored. That is selection, not truncation.
    assert.equal(sources[0].kept_passages, 1);
    assert.ok(sources[0].total_passages > 5, `only ${sources[0].total_passages} passages`);
    assert.equal(sources[0].truncated, false);
    assert.equal(sources[0].omitted_passages, 0);
  } finally { await cleanup(dir); }
});

test('a node whose text does not match the question is dropped, not padded in', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/a.txt': block('elasticity'),
    'materials/b.txt': 'Roster housekeeping and office hours logistics only.',
  });
  try {
    const graph = graphOf([
      fileNode('file:1', 'Deck one', 'materials/a.txt', { elasticity: 0.9 }),
      fileNode('file:2', 'Deck two', 'materials/b.txt', { elasticity: 0.4 }),
    ]);
    const sources = await gatherSources(dir, 'explain elasticity', { graph });
    assert.deepEqual(sources.map(s => s.nodeId), ['file:1']);
    assert.ok(sources.stats.nodesDropped >= 1);
  } finally { await cleanup(dir); }
});

test('a thin selection is widened one hop through the graph', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/a.txt': block('elasticity'),
    'materials/b.txt': 'Administrative notes about the roster and office hours.',
    'materials/c.txt': block('elasticity', 2),
  });
  try {
    // Only A carries the query term in its stored graph terms. C is two hops
    // away — selectForQuery's own single hop cannot reach it, so it only
    // arrives if gatherSources expands.
    const graph = graphOf(
      [
        fileNode('file:a', 'Deck A', 'materials/a.txt', { elasticity: 0.9 }),
        fileNode('file:b', 'Deck B', 'materials/b.txt', { roster: 0.5 }),
        fileNode('file:c', 'Deck C', 'materials/c.txt', { pricing: 0.5 }),
      ],
      [
        { a: 'file:a', b: 'file:b', w: 0.6, why: ['same module'] },
        { a: 'file:b', b: 'file:c', w: 0.6, why: ['same module'] },
      ],
    );
    const sources = await gatherSources(dir, 'explain elasticity', { graph });
    assert.equal(sources.stats.nodesExpanded, 1, 'expected exactly one hop to be added');
    assert.deepEqual(sources.map(s => s.nodeId), ['file:a', 'file:c']);
    assert.deepEqual(sources.map(s => s.tag), ['S1', 'S2']);
    assert.equal(sources[0].seed, true);
    assert.equal(sources[1].seed, false);
  } finally { await cleanup(dir); }
});

test('expansion is skipped when the selection is already wide enough', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/a.txt': block('elasticity'),
    'materials/b.txt': block('elasticity', 2),
    'materials/c.txt': block('elasticity', 2),
  });
  try {
    const graph = graphOf([
      fileNode('file:a', 'Deck A', 'materials/a.txt', { elasticity: 0.9 }),
      fileNode('file:b', 'Deck B', 'materials/b.txt', { elasticity: 0.8 }),
      fileNode('file:c', 'Deck C', 'materials/c.txt', { elasticity: 0.7 }),
    ]);
    const sources = await gatherSources(dir, 'explain elasticity', { graph });
    assert.equal(sources.stats.nodesSelected, 3);
    assert.equal(sources.stats.nodesExpanded, 0);
  } finally { await cleanup(dir); }
});

test('the character budget is respected and the overflow is reported', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/a.txt': [block('elasticity'), block('elasticity'), block('elasticity')].join('\n\n'),
  });
  try {
    const graph = graphOf([fileNode('file:a', 'Deck A', 'materials/a.txt', { elasticity: 0.9 })]);
    const generous = await gatherSources(dir, 'elasticity', { graph });
    assert.equal(generous[0].truncated, false);
    assert.equal(generous[0].omitted_passages, 0);

    const tight = await gatherSources(dir, 'elasticity', { graph, budgetChars: 400 });
    assert.equal(tight.length, 1);
    assert.ok(tight[0].chars <= 400, `budget blown: ${tight[0].chars}`);
    assert.equal(tight[0].truncated, true);
    assert.equal(tight[0].omitted_passages, 2);
    assert.ok(tight.stats.chars <= 400);
  } finally { await cleanup(dir); }
});

test('a budget too small for a second document drops it rather than overrunning', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/a.txt': block('elasticity'),
    'materials/b.txt': block('elasticity'),
  });
  try {
    const graph = graphOf([
      fileNode('file:a', 'Deck A', 'materials/a.txt', { elasticity: 0.9 }),
      fileNode('file:b', 'Deck B', 'materials/b.txt', { elasticity: 0.9 }),
    ]);
    const sources = await gatherSources(dir, 'elasticity', { graph, budgetChars: 400 });
    assert.equal(sources.length, 1);
    assert.ok(sources.stats.nodesDropped >= 1);
    assert.ok(sources.stats.chars <= 400);
  } finally { await cleanup(dir); }
});

test('a very tight budget clips the single best passage rather than returning nothing', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'materials/a.txt': block('elasticity', 6),
  });
  try {
    const graph = graphOf([fileNode('file:a', 'Deck A', 'materials/a.txt', { elasticity: 0.9 })]);
    const sources = await gatherSources(dir, 'elasticity', { graph, budgetChars: 250 });
    assert.equal(sources.length, 1);
    assert.ok(sources[0].chars <= 250);
    assert.match(sources[0].text, /…$/);
    assert.equal(sources[0].truncated, true);
    assert.equal(sources[0].clipped, true);
  } finally { await cleanup(dir); }
});

test('a maxSources cap holds', async () => {
  const files = { 'metadata.json': meta() };
  const nodes = [];
  for (const k of ['a', 'b', 'c', 'd', 'e']) {
    files[`materials/${k}.txt`] = block('elasticity');
    nodes.push(fileNode(`file:${k}`, `Deck ${k.toUpperCase()}`, `materials/${k}.txt`, { elasticity: 0.9 }));
  }
  const dir = await tempClass(files);
  try {
    const sources = await gatherSources(dir, 'elasticity', { graph: graphOf(nodes), maxSources: 2 });
    assert.equal(sources.length, 2);
    assert.deepEqual(sources.map(s => s.tag), ['S1', 'S2']);
  } finally { await cleanup(dir); }
});

test('gatherSources reads the class JSON for nodes that are not files', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'assignments.json': [{ id: 55, name: 'Elasticity worksheet', description: '<p>Compute the <b>elasticity</b> of demand for each product line and explain the result in one paragraph.</p>' }],
    'quizzes.json': [{ id: 66, title: 'Quiz on demand', description: '<p>Ten questions about elasticity of demand.</p>' }],
    'pages.json': [{ url: 'week-3', title: 'Week 3', body: '<p>Read the elasticity chapter before class.</p>' }],
    'announcements.json': [{ id: 77, title: 'Reminder', message: '<p>The elasticity worksheet is due Friday.</p>' }],
    'modules.json': [{ id: 88, name: 'Unit 2', items: [{ title: 'Elasticity deck' }, { title: 'Elasticity quiz' }] }],
  });
  try {
    const graph = graphOf([
      { id: 'assignment:55', kind: 'assignment', label: 'Elasticity worksheet', date: null, textPath: null, canvasId: '55', url: null, terms: { elasticity: 0.9 } },
      { id: 'quiz:66', kind: 'quiz', label: 'Quiz on demand', date: null, textPath: null, canvasId: '66', url: null, terms: { elasticity: 0.8 } },
      { id: 'page:week-3', kind: 'page', label: 'Week 3', date: null, textPath: null, canvasId: null, url: null, terms: { elasticity: 0.7 } },
      { id: 'announcement:77', kind: 'announcement', label: 'Reminder', date: null, textPath: null, canvasId: '77', url: null, terms: { elasticity: 0.6 } },
      { id: 'module:88', kind: 'module', label: 'Unit 2', date: null, textPath: null, canvasId: '88', url: null, terms: { elasticity: 0.5 } },
    ]);
    const sources = await gatherSources(dir, 'elasticity of demand', { graph });
    assert.equal(sources.length, 5);
    const byKind = Object.fromEntries(sources.map(s => [s.kind, s.text]));
    assert.match(byKind.assignment, /Compute the elasticity of demand/);
    assert.equal(/<\w+>/.test(byKind.assignment), false, 'HTML was not stripped');
    assert.match(byKind.quiz, /Ten questions about elasticity/);
    assert.match(byKind.page, /Read the elasticity chapter/);
    assert.match(byKind.announcement, /elasticity worksheet is due Friday/);
    assert.match(byKind.module, /Elasticity deck/);
  } finally { await cleanup(dir); }
});

test('a node selected purely by its title still contributes its title', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'assignments.json': [{ id: 55, name: 'Elasticity worksheet', description: '' }],
  });
  try {
    const graph = graphOf([
      { id: 'assignment:55', kind: 'assignment', label: 'Elasticity worksheet', date: null, textPath: null, canvasId: '55', url: null, terms: { elasticity: 0.9 } },
    ]);
    const sources = await gatherSources(dir, 'elasticity', { graph });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].text, 'Elasticity worksheet');
  } finally { await cleanup(dir); }
});

test('a textPath pointing outside the class dir is refused', async () => {
  const dir = await tempClass({ 'metadata.json': meta() });
  try {
    const graph = graphOf([fileNode('file:1', 'Escape', '../../../etc/hosts', { elasticity: 0.9 })]);
    const sources = await gatherSources(dir, 'elasticity', { graph });
    // The label alone does not match "elasticity", so nothing survives.
    assert.deepEqual([...sources], []);
  } finally { await cleanup(dir); }
});

test('no graph on disk and buildIfMissing off returns nothing', async () => {
  const dir = await tempClass({ 'metadata.json': meta() });
  try {
    const sources = await gatherSources(dir, 'elasticity', { buildIfMissing: false });
    assert.deepEqual([...sources], []);
    assert.equal(sources.stats.graph, 'none');
  } finally { await cleanup(dir); }
});

test('gatherSources builds a graph in memory when the class has none on disk', async () => {
  const dir = await tempClass({
    'metadata.json': meta(),
    'files_index.json': [{ canvasId: '1', displayName: 'Elasticity deck.pptx', materialsPath: 'materials/deck.txt' }],
    'materials/deck.txt': block('elasticity', 4),
    'assignments.json': [],
  });
  try {
    const sources = await gatherSources(dir, 'elasticity of demand');
    assert.equal(sources.stats.graph, 'built');
    assert.ok(sources.length >= 1);
    assert.match(sources[0].text, /elasticity/i);
  } finally { await cleanup(dir); }
});

test('an empty question retrieves nothing', async () => {
  const dir = await tempClass({ 'metadata.json': meta() });
  try {
    assert.deepEqual([...await gatherSources(dir, '')], []);
    assert.deepEqual([...await gatherSources(dir, '   ')], []);
    assert.deepEqual([...await gatherSources(dir, null)], []);
  } finally { await cleanup(dir); }
});

// ==========================================================================
// 6. buildPrompt
// ==========================================================================

test('buildPrompt carries the facts, the tagged sources, the rules and the question', () => {
  const facts = {
    today: '2026-08-24',
    class: { slug: 'x', code: 'BUSI 380 002', name: 'Marketing', term: 'Fall 2026' },
    meetings: { source: 'syllabus-field', confidence: 'low', summary: 'Days only (TuTh)', patterns: [{ byday: ['TU', 'TH'], start: null, end: null }], this_week: [], next: null, warnings: [] },
    tasks: { source: 'canvas', next_exam: null, upcoming: [], overdue_count: 0, total_dated: 0, undated_exams: [], warnings: [] },
    warnings: [],
  };
  const sources = [{ tag: 'S1', nodeId: 'file:1', kind: 'file', label: 'Deck A', url: 'https://canvas.test/f/1', date: '2026-08-10T00:00:00Z', text: 'Elasticity of demand.', truncated: true, omitted_passages: 3 }];
  const prompt = buildPrompt({ facts, sources, question: 'What is elasticity?', history: [{ q: 'earlier?', a: 'earlier answer' }] });

  assert.match(prompt, /FACTS \(computed/);
  assert.match(prompt, /Today: 2026-08-24/);
  assert.match(prompt, /START TIME NOT KNOWN/);
  assert.match(prompt, /\[S1\] Deck A \(file, 2026-08-10, https:\/\/canvas\.test\/f\/1\)/);
  assert.match(prompt, /Elasticity of demand\./);
  assert.match(prompt, /3 less relevant passage\(s\)/);
  assert.ok(prompt.includes(NO_ANSWER), 'the fallback sentence must be quoted verbatim');
  assert.match(prompt, /No preamble/i);
  assert.match(prompt, /EARLIER IN THIS CONVERSATION/);
  assert.match(prompt, /Q: earlier\?/);
  assert.match(prompt, /A: earlier answer/);
  assert.match(prompt, /QUESTION\nWhat is elasticity\?/);
});

test('buildPrompt says so plainly when there are no sources', () => {
  const prompt = buildPrompt({ facts: null, sources: [], question: 'anything' });
  assert.match(prompt, /SOURCES\n\(none/);
  assert.ok(prompt.includes(NO_ANSWER));
});

test('buildPrompt accepts role-shaped history', () => {
  const prompt = buildPrompt({
    facts: null,
    sources: [],
    question: 'and then?',
    history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }],
  });
  assert.match(prompt, /Q: first/);
  assert.match(prompt, /A: second/);
});

// ==========================================================================
// 7. cleanAnswer — the guard rail
// ==========================================================================

const S = [{ tag: 'S1' }, { tag: 'S2' }];

test('cleanAnswer strips interjection preambles', () => {
  assert.equal(cleanAnswer('Sure! The exam is on 2026-10-08.', S).answer, 'The exam is on 2026-10-08.');
  assert.equal(cleanAnswer('Certainly. The exam is on 2026-10-08.', S).answer, 'The exam is on 2026-10-08.');
  assert.equal(cleanAnswer('Great question! The exam is on 2026-10-08.', S).answer, 'The exam is on 2026-10-08.');
  assert.equal(cleanAnswer('Of course — the exam is on 2026-10-08.', S).answer, 'the exam is on 2026-10-08.');
  assert.equal(cleanAnswer('No problem, the class meets Tuesday.', S).answer, 'the class meets Tuesday.');
});

test('cleanAnswer strips a "Here is ...:" lead-in', () => {
  assert.equal(cleanAnswer("Here's what I found:\nThe class meets Tuesday.", S).answer, 'The class meets Tuesday.');
  assert.equal(cleanAnswer('Here is the answer: The class meets Tuesday.', S).answer, 'The class meets Tuesday.');
});

test('cleanAnswer strips a "Based on the provided context" lead-in', () => {
  assert.equal(cleanAnswer('Based on the provided context, the class meets Tuesday.', S).answer, 'the class meets Tuesday.');
  assert.equal(cleanAnswer('According to the sources: the class meets Tuesday.', S).answer, 'the class meets Tuesday.');
  assert.equal(cleanAnswer('Based upon the materials provided, the class meets Tuesday.', S).answer, 'the class meets Tuesday.');
});

test('cleanAnswer strips an "Answer:" label and a code fence', () => {
  assert.equal(cleanAnswer('Answer: The class meets Tuesday.', S).answer, 'The class meets Tuesday.');
  assert.equal(cleanAnswer('**Answer:** The class meets Tuesday.', S).answer, 'The class meets Tuesday.');
  assert.equal(cleanAnswer('```\nThe class meets Tuesday.\n```', S).answer, 'The class meets Tuesday.');
});

test('cleanAnswer strips a restated question', () => {
  assert.equal(
    cleanAnswer('Question: When is the next exam?\nOctober 8.', S).answer,
    'October 8.');
  assert.equal(
    cleanAnswer('When is the next exam?\nOctober 8.', S, { question: 'When is the next exam?' }).answer,
    'October 8.');
  // Even without the question, a leading interrogative line followed by content
  // is a restatement.
  assert.equal(cleanAnswer('When does this class meet this week?\nTuesday and Thursday.', S).answer,
    'Tuesday and Thursday.');
});

test('cleanAnswer strips trailing offers of further help', () => {
  assert.equal(cleanAnswer('The class meets Tuesday.\nLet me know if you need anything else!', S).answer,
    'The class meets Tuesday.');
  assert.equal(cleanAnswer('The class meets Tuesday. Hope this helps!', S).answer, 'The class meets Tuesday.');
  assert.equal(cleanAnswer('The class meets Tuesday.\n\nFeel free to ask about the syllabus.', S).answer,
    'The class meets Tuesday.');
  assert.equal(cleanAnswer('The class meets Tuesday.\nIf you have any other questions, just ask.', S).answer,
    'The class meets Tuesday.');
});

test('cleanAnswer peels a stacked preamble and sign-off in one pass', () => {
  const raw = "Sure! Here's what I found:\nBased on the provided context, the midterm is 2026-10-08 [S1].\nLet me know if you'd like more detail!";
  assert.equal(cleanAnswer(raw, S).answer, 'the midterm is 2026-10-08 [S1].');
});

test('cleanAnswer does NOT mangle an answer that merely starts with one of those words', () => {
  // "Surely" is not "Sure" — the word-boundary and the required punctuation
  // both have to hold.
  const a = 'Surely the deadline is listed in the syllabus.';
  assert.equal(cleanAnswer(a, S).answer, a);
  // "Of course materials" — no punctuation after the interjection, so it is
  // ordinary prose.
  const b = 'Of course materials are listed in Module 3.';
  assert.equal(cleanAnswer(b, S).answer, b);
  // "Based on the syllabus schedule" names a real document, not the prompt.
  const c = 'Based on the syllabus schedule, the midterm is 2026-10-08.';
  assert.equal(cleanAnswer(c, S).answer, c);
  // "Here is McNair Hall 314" has no colon, so it is the answer.
  const d = 'Here is the room: McNair Hall 314.';
  assert.equal(cleanAnswer(d, S).answer, 'McNair Hall 314.');
  const e = 'Here are the two case deadlines in October.';
  assert.equal(cleanAnswer(e, S).answer, e);
  // "Answer key" is not an "Answer:" label.
  const f = 'Answer keys are posted in Module 4.';
  assert.equal(cleanAnswer(f, S).answer, f);
  // A one-line answer that ends in a question mark is the whole answer.
  const g = 'The material does not say whether the final is cumulative.';
  assert.equal(cleanAnswer(g, S).answer, g);
  const h = 'Which case are you asking about?';
  assert.equal(cleanAnswer(h, S).answer, h);
  // A legitimate answer containing "let me know" mid-sentence stays put.
  const i = 'The syllabus asks students to let me know about conflicts by week 2.';
  assert.equal(cleanAnswer(i, S).answer, i);
});

test('cleanAnswer keeps supplied citations and reports them in order', () => {
  const res = cleanAnswer('Elasticity is defined here [S2]. The deck expands on it [S1].', S);
  assert.equal(res.answer, 'Elasticity is defined here [S2]. The deck expands on it [S1].');
  assert.deepEqual(res.citations, ['S2', 'S1']);
  assert.deepEqual(res.dropped, []);
});

test('cleanAnswer drops a fabricated citation and tidies the punctuation', () => {
  const res = cleanAnswer('The midterm is 2026-10-08 [S1]. It is worth 25% [S9].', S);
  assert.equal(res.answer, 'The midterm is 2026-10-08 [S1]. It is worth 25%.');
  assert.deepEqual(res.citations, ['S1']);
  assert.deepEqual(res.dropped, ['S9']);
});

test('cleanAnswer drops every tag when no sources were supplied', () => {
  const res = cleanAnswer('The midterm is 2026-10-08 [S1].', []);
  assert.equal(res.answer, 'The midterm is 2026-10-08.');
  assert.deepEqual(res.citations, []);
  assert.deepEqual(res.dropped, ['S1']);
});

test('cleanAnswer normalises citation spelling', () => {
  const res = cleanAnswer('See [s1] and [ S2 ] and [S1] again.', S);
  assert.equal(res.answer, 'See [S1] and [S2] and [S1] again.');
  assert.deepEqual(res.citations, ['S1', 'S2']);
});

test('cleanAnswer never eats the whole answer', () => {
  // A response that is nothing but a preamble must not become empty and then
  // be reported as an answer.
  assert.equal(cleanAnswer('Sure!', S).answer, 'Sure!');
  assert.equal(cleanAnswer('Let me know if you need anything else.', S).answer,
    'Let me know if you need anything else.');
  assert.equal(cleanAnswer('', S).answer, '');
  assert.equal(cleanAnswer(null, S).answer, '');
  assert.equal(cleanAnswer(undefined).answer, '');
});

test('cleanAnswer leaves the fixed fallback sentence alone', () => {
  assert.equal(cleanAnswer(NO_ANSWER, S).answer, NO_ANSWER);
});

// ==========================================================================
// 8. answerQuestion
// ==========================================================================

async function chatClass() {
  return tempClass({
    'metadata.json': meta(),
    'syllabus_parsed.json': parsed({
      schedule: [lecture('2026-08-25', 'Session A'), lecture('2026-08-27', 'Session B')],
    }),
    'assignments.json': [canvasAssignment(1, 'Elasticity worksheet', '2026-09-04T04:59:00Z')],
    'calendar_events.json': [],
    'files_index.json': [{ canvasId: '1', displayName: 'Elasticity deck.pptx', materialsPath: 'materials/deck.txt' }],
    'materials/deck.txt': block('elasticity', 5),
  });
}

test('answerQuestion hands the model a prompt built from facts and sources, and cleans what comes back', async () => {
  const dir = await chatClass();
  const invoke = fakeInvoke("Sure! Based on the provided context, elasticity measures how demand responds to price [S1]. See also [S7]. Let me know if you need more!");
  try {
    const res = await answerQuestion({
      classDir: dir,
      question: 'What is elasticity of demand?',
      invoke,
      now: new Date(2026, 7, 24, 8, 0),
    });
    assert.equal(invoke.calls.length, 1);
    const prompt = invoke.calls[0];
    assert.match(prompt, /FACTS \(computed/);
    assert.match(prompt, /Today: 2026-08-24/);
    assert.match(prompt, /Tue 2026-08-25/);
    assert.match(prompt, /What is elasticity of demand\?/);
    assert.match(prompt, /\[S1\]/);

    assert.equal(res.answer, 'elasticity measures how demand responds to price [S1]. See also.');
    assert.deepEqual(res.citations, ['S1']);
    assert.deepEqual(res.dropped, ['S7']);
    assert.equal(res.used_model, true);
    assert.ok(res.sources.length >= 1);
    assert.equal(res.facts.today, '2026-08-24');
    assert.ok(res.warnings.some(w => /not supplied/.test(w)), JSON.stringify(res.warnings));
  } finally { await cleanup(dir); }
});

test('answerQuestion still answers a schedule question when nothing was retrieved', async () => {
  const dir = await chatClass();
  const invoke = fakeInvoke('Tuesday 2026-08-25 and Thursday 2026-08-27; the time is not known.');
  try {
    // Every token is a stopword, so the graph selects nothing — but the FACTS
    // block is exactly what this question needs.
    const res = await answerQuestion({
      classDir: dir,
      question: 'when does this class meet this week',
      invoke,
      now: new Date(2026, 7, 24, 8, 0),
    });
    assert.equal(invoke.calls.length, 1);
    assert.deepEqual([...res.sources], []);
    assert.match(invoke.calls[0], /SOURCES\n\(none/);
    assert.match(invoke.calls[0], /Tue 2026-08-25 — time not known/);
    assert.equal(res.used_model, true);
  } finally { await cleanup(dir); }
});

test('answerQuestion never calls the model when there is nothing to answer from', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'classchat-bare-'));
  try {
    const invoke = forbiddenInvoke();
    const res = await answerQuestion({
      classDir: dir,
      question: 'what is elasticity',
      invoke,
      now: new Date(2026, 7, 24, 8, 0),
    });
    assert.equal(res.answer, NO_ANSWER);
    assert.equal(res.used_model, false);
    assert.deepEqual(res.sources, []);
    assert.ok(res.facts, 'the facts it looked at are still returned');
  } finally { await cleanup(dir); }
});

test('answerQuestion on an empty class does not even need an invoke to be passed', async () => {
  // The default invoke is localInvoke. Reaching it here would load the local
  // model; this test asserts the guard fires first, with no invoke supplied.
  const dir = await mkdtemp(join(tmpdir(), 'classchat-bare2-'));
  try {
    const res = await answerQuestion({
      classDir: dir,
      question: 'what is elasticity',
      now: new Date(2026, 7, 24, 8, 0),
    });
    assert.equal(res.answer, NO_ANSWER);
    assert.equal(res.used_model, false);
  } finally { await cleanup(dir); }
});

test('answerQuestion refuses an empty question without touching anything', async () => {
  const res = await answerQuestion({ classDir: '/nonexistent', question: '   ' });
  assert.equal(res.answer, NO_ANSWER);
  assert.equal(res.used_model, false);
  assert.equal(res.facts, null);
  assert.deepEqual(res.sources, []);
});

test('answerQuestion falls back to the fixed sentence when the model returns nothing usable', async () => {
  const dir = await chatClass();
  try {
    const res = await answerQuestion({
      classDir: dir,
      question: 'what is elasticity',
      invoke: fakeInvoke('   '),
      now: new Date(2026, 7, 24, 8, 0),
    });
    assert.equal(res.answer, NO_ANSWER);
  } finally { await cleanup(dir); }
});

test('answerQuestion honours the character budget it is given', async () => {
  const dir = await chatClass();
  const invoke = fakeInvoke('ok');
  try {
    const wide = await answerQuestion({ classDir: dir, question: 'elasticity of demand', invoke, budgetChars: DEFAULT_BUDGET_CHARS, now: new Date(2026, 7, 24, 8, 0) });
    const tight = await answerQuestion({ classDir: dir, question: 'elasticity of demand', invoke, budgetChars: 300, now: new Date(2026, 7, 24, 8, 0) });
    const wideChars = wide.sources.reduce((s, x) => s + x.chars, 0);
    const tightChars = tight.sources.reduce((s, x) => s + x.chars, 0);
    assert.ok(tightChars <= 300, `budget blown: ${tightChars}`);
    assert.ok(tightChars < wideChars);
  } finally { await cleanup(dir); }
});

// ==========================================================================
// 9. resolveClass
// ==========================================================================

async function tempRoot({ nested = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'classchat-root-'));
  const classes = nested ? join(root, 'classes') : root;
  const write = async (slug, files) => {
    for (const [name, body] of Object.entries(files)) {
      const abs = join(classes, slug, name);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, JSON.stringify(body, null, 2));
    }
  };
  await mkdir(classes, { recursive: true });
  await write('92294-busi-305-001-002-003', {
    'metadata.json': { course_code: 'BUSI 305 001/002/003', name: 'BUSI 305 001/002/003 F26' },
    'syllabus_parsed.json': { course: {} },
    'files_index.json': [{ canvasId: '1', displayName: 'syllabus_Busi 305-Fall 2026.pdf' }],
  });
  await write('92354-busi-396-001-002-003-004', {
    'metadata.json': { course_code: 'BUSI 396 001/002/003/004', name: 'BUSI 396 001/002/003/004 F26' },
    'syllabus_parsed.json': { course: {} },
    'files_index.json': [{ canvasId: '2', displayName: 'Fall 2026 BUSI 396 Business Communications Syllabus.docx' }],
  });
  await write('93903-busi-380-002', {
    'metadata.json': { course_code: 'BUSI 380 002', name: 'BUSI 380 002 F26' },
    'syllabus_parsed.json': { course: { title: 'Marketing', code: 'BUSI 380' } },
    'files_index.json': [{ canvasId: '3', displayName: 'Marketing 380  Syllabus (Fall 2026) Aug 11.pdf' }],
  });
  await write('94038-entr-222-001', {
    'metadata.json': { course_code: 'ENTR 222 001', name: 'ENTR 222 001 F26' },
    'syllabus_parsed.json': { course: { title: 'AI & Tech Product Development', code: 'ENTR 222' } },
    'files_index.json': [{ canvasId: '4', displayName: 'ENTR 222 F26 - Syllabus.pdf' }],
  });
  // macOS leaves one of these in every directory it has ever opened.
  await writeFile(join(classes, '.DS_Store'), 'not a class');
  return { root, classes };
}

test('resolveClass finds the class named by subject and number', async () => {
  const { root } = await tempRoot();
  try {
    const res = await resolveClass(root, 'when is the busi 380 exam');
    assert.equal(res.slug, '93903-busi-380-002');
    assert.equal(res.ambiguous, false);
    assert.equal(res.confidence, 'high');
    assert.ok(res.dir.endsWith('93903-busi-380-002'));
  } finally { await cleanup(root); }
});

test('resolveClass finds the class by a number alone, and by a distinctive word', async () => {
  const { root } = await tempRoot();
  try {
    assert.equal((await resolveClass(root, 'what is due in 396 this week')).slug, '92354-busi-396-001-002-003-004');
    assert.equal((await resolveClass(root, 'what did we cover in marketing')).slug, '93903-busi-380-002');
    assert.equal((await resolveClass(root, 'the entrepreneurship class')).slug, '94038-entr-222-001');
    assert.equal((await resolveClass(root, 'business communications deliverable')).slug, '92354-busi-396-001-002-003-004');
  } finally { await cleanup(root); }
});

test('resolveClass ignores non-directories in the classes folder', async () => {
  const { root } = await tempRoot();
  try {
    const res = await resolveClass(root, 'nothing matches this at all');
    assert.equal(res.candidates.length, 4, JSON.stringify(res.candidates.map(c => c.slug)));
    assert.equal(res.candidates.some(c => c.slug === '.DS_Store'), false);
  } finally { await cleanup(root); }
});

test('resolveClass refuses to guess when nothing matches', async () => {
  const { root } = await tempRoot();
  try {
    const res = await resolveClass(root, 'when is my chemistry lab');
    assert.equal(res.ambiguous, true);
    assert.equal(res.slug, null);
    assert.equal(res.dir, null);
    assert.equal(res.confidence, 'none');
    assert.equal(res.candidates.length, 4);
  } finally { await cleanup(root); }
});

test('resolveClass refuses to guess when the top two are close', async () => {
  const { root } = await tempRoot();
  try {
    // "business" is an alias of the BUSI subject, so three classes tie on it.
    const res = await resolveClass(root, 'what is my business homework');
    assert.equal(res.ambiguous, true);
    assert.equal(res.slug, null);
    assert.ok(res.candidates.length >= 2, JSON.stringify(res.candidates));
    for (const c of res.candidates) assert.match(c.slug, /busi/);
  } finally { await cleanup(root); }
});

test('resolveClass refuses to guess between two classes with the same name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'classchat-tie-'));
  try {
    for (const slug of ['11111-mktg-101-001', '22222-mktg-201-001']) {
      const abs = join(root, 'classes', slug);
      await mkdir(abs, { recursive: true });
      await writeFile(join(abs, 'metadata.json'), JSON.stringify({ course_code: slug.split('-').slice(1, 3).join(' ').toUpperCase() }));
      await writeFile(join(abs, 'syllabus_parsed.json'), JSON.stringify({ course: { title: 'Marketing' } }));
    }
    const res = await resolveClass(root, 'my marketing reading');
    assert.equal(res.ambiguous, true);
    assert.equal(res.candidates.length, 2);
    // The clarifying question the user allowed can be built from these.
    assert.deepEqual(res.candidates.map(c => c.title), ['Marketing', 'Marketing']);
  } finally { await cleanup(root); }
});

test('an explicit hint wins outright', async () => {
  const { root } = await tempRoot();
  try {
    const bySlug = await resolveClass(root, 'when is my chemistry lab', { hint: '93903-busi-380-002' });
    assert.equal(bySlug.slug, '93903-busi-380-002');
    assert.equal(bySlug.ambiguous, false);
    assert.equal(bySlug.confidence, 'high');

    const byCode = await resolveClass(root, 'anything at all', { hint: 'BUSI 380 002' });
    assert.equal(byCode.slug, '93903-busi-380-002');

    // A hint that names nothing real falls through to the question.
    const bogus = await resolveClass(root, 'when is the busi 380 exam', { hint: 'nope-nothing' });
    assert.equal(bogus.slug, '93903-busi-380-002');
  } finally { await cleanup(root); }
});

test('resolveClass accepts the classes directory itself as the base', async () => {
  const { root, classes } = await tempRoot();
  try {
    const res = await resolveClass(classes, 'when is the busi 380 exam');
    assert.equal(res.slug, '93903-busi-380-002');
  } finally { await cleanup(root); }
});

test('resolveClass accepts a flat directory of classes', async () => {
  const { root } = await tempRoot({ nested: false });
  try {
    const res = await resolveClass(root, 'when is the busi 380 exam');
    assert.equal(res.slug, '93903-busi-380-002');
  } finally { await cleanup(root); }
});

test('resolveClass on a missing or empty root is ambiguous, not an exception', async () => {
  const missing = await resolveClass(join(tmpdir(), 'definitely-not-here-9f3a'), 'anything');
  assert.equal(missing.ambiguous, true);
  assert.deepEqual(missing.candidates, []);

  const empty = await mkdtemp(join(tmpdir(), 'classchat-noclasses-'));
  try {
    const res = await resolveClass(empty, 'anything');
    assert.equal(res.ambiguous, true);
    assert.deepEqual(res.candidates, []);
  } finally { await cleanup(empty); }
});

test('a syllabus filename does not leak generic words into class matching', async () => {
  const { root } = await tempRoot();
  try {
    // "fall" and "pdf" appear in filenames. Neither may identify a class.
    const res = await resolveClass(root, 'what is due this fall');
    assert.equal(res.ambiguous, true, JSON.stringify(res.candidates));
  } finally { await cleanup(root); }
});

// ==========================================================================
// 10. Smoke test against the real data root — SKIPPED when it is not there.
// No test may depend on the user's data being present.
// ==========================================================================

const REAL_CLASSES = join(homedir(), 'canvas-sync-data', 'classes');
const REAL_CLASS = join(REAL_CLASSES, '93903-busi-380-002');
const haveRealData = await stat(REAL_CLASS).then(s => s.isDirectory()).catch(() => false);

test('smoke: the real BUSI 380 directory produces a well-formed FACTS block', { skip: !haveRealData }, async () => {
  const facts = await classFacts(REAL_CLASS);
  assert.match(facts.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(facts.class.slug, '93903-busi-380-002');
  assert.ok(Array.isArray(facts.meetings.this_week));
  assert.ok(Array.isArray(facts.tasks.upcoming));
  const text = renderFacts(facts);
  assert.match(text, /^FACTS/);
  assert.match(text, /MEETINGS/);
  assert.match(text, /WORK/);
  // BUSI 380's syllabus names days and never a time. Whatever else changes in
  // the data, a start time must not appear from nowhere.
  for (const m of facts.meetings.this_week) {
    if (!m.has_time) assert.equal(m.start, null);
  }
});

test('smoke: retrieval against the real class is graph-driven and budgeted', { skip: !haveRealData }, async () => {
  const sources = await gatherSources(REAL_CLASS, 'what is the elaboration likelihood model');
  assert.ok(Array.isArray(sources));
  const total = sources.reduce((s, x) => s + x.chars, 0);
  assert.ok(total <= DEFAULT_BUDGET_CHARS, `budget blown: ${total}`);
  for (const s of sources) {
    assert.match(s.tag, /^S\d+$/);
    assert.ok(typeof s.text === 'string' && s.text.length > 0);
  }
});

test('smoke: resolveClass picks a real class out of the real data root', { skip: !haveRealData }, async () => {
  const res = await resolveClass(join(homedir(), 'canvas-sync-data'), 'when is the busi 380 midterm');
  assert.equal(res.ambiguous, false);
  assert.equal(res.slug, '93903-busi-380-002');
});

// ==========================================================================
// 10. relatedMaterials — task↔material cross-references as FACTS
// ==========================================================================
// The user's canonical question is "which articles should I read for this
// assignment". No source SAYS that; the correlation graph's edges know it.
// These pin that the list is computed (seeds only, materials only, deduped,
// capped) and that the prompt carries it as an authoritative section.

test('relatedMaterials lists a seed task\'s material neighbours and nothing else', () => {
  const graph = {
    nodes: [
      { id: 'assignment:1', kind: 'assignment', label: 'Benchmark Package' },
      { id: 'assignment:2', kind: 'assignment', label: 'Rebuild' },
      { id: 'file:Guide.docx', kind: 'file', label: 'Guide.docx' },
      { id: 'file:Worksheet.docx', kind: 'file', label: 'Worksheet.docx' },
      { id: 'page:rubric', kind: 'page', label: 'Rubric' },
      { id: 'syllabus:1', kind: 'syllabus', label: 'Syllabus' },
    ],
    edges: [
      // The nearest neighbour is another TASK, and the syllabus correlates
      // with everything — both must be filtered out, not returned.
      { a: 'assignment:1', b: 'assignment:2', w: 9 },
      { a: 'assignment:1', b: 'syllabus:1', w: 8 },
      { a: 'assignment:1', b: 'file:Guide.docx', w: 7 },
      { a: 'assignment:1', b: 'page:rubric', w: 6 },
      { a: 'assignment:1', b: 'file:Worksheet.docx', w: 5 },
    ],
  };
  const sources = [
    { seed: true, kind: 'assignment', nodeId: 'assignment:1', label: 'Benchmark Package' },
    // Non-seed task: in the budget, but the question did not name it.
    { seed: false, kind: 'assignment', nodeId: 'assignment:2', label: 'Rebuild' },
    // Seed FILE: a material is not a task and gets no materials list.
    { seed: true, kind: 'file', nodeId: 'file:Guide.docx', label: 'Guide.docx' },
  ];
  const rel = relatedMaterials(graph, sources);
  assert.equal(rel.length, 1);
  assert.equal(rel[0].task, 'Benchmark Package');
  assert.deepEqual(rel[0].materials, ['Guide.docx', 'Rubric', 'Worksheet.docx']);
});

test('relatedMaterials returns nothing without a graph or without seed tasks', () => {
  assert.deepEqual(relatedMaterials(null, [{ seed: true, kind: 'assignment', nodeId: 'a', label: 'A' }]), []);
  assert.deepEqual(relatedMaterials({ nodes: [], edges: [] }, []), []);
});

test('buildPrompt carries RELATED MATERIALS as an authoritative section with its own rule', () => {
  const prompt = buildPrompt({
    facts: null,
    sources: [],
    question: 'Which articles should I read for the Benchmark Package?',
    related: [{ task: 'Benchmark Package', materials: ['Guide.docx', 'Worksheet.docx'] }],
  });
  assert.match(prompt, /RELATED MATERIALS \(cross-references computed/);
  assert.match(prompt, /- Benchmark Package: Guide\.docx; Worksheet\.docx/);
  assert.match(prompt, /copy the list from RELATED MATERIALS/);
});

test('buildPrompt omits the RELATED MATERIALS section when there is nothing to put in it', () => {
  const prompt = buildPrompt({ facts: null, sources: [], question: 'anything', related: [] });
  assert.ok(!prompt.includes('RELATED MATERIALS ('), 'an empty section is a claim that nothing relates — omit it');
  // The rule stays: it tells the model what to say when the list is absent.
  assert.match(prompt, /copy the list from RELATED MATERIALS/);
});
