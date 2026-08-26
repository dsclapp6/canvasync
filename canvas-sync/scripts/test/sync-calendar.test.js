// sync-calendar.test.js — the worklist telling the truth.
//
// Every test here is named after a real failure observed on this user's six
// synced classes, where the calendar asserted things no source says:
//
//   - BUSI 380's 2026-10-08 midterm stopped being an exam the moment mining
//     finished, because the mined category ("project") overrode Canvas's.
//   - ENTR 222's "Mid-Semester Teamwork Survey" is dated 2025-10-15, a year
//     off, and vanished with no diagnostic anywhere.
//   - BUSI 305 showed "0 homework" while holding twelve weekly assignments
//     that simply have no date.
//   - Every meeting marker embedded its own date, so correcting a lecture's
//     day created a second event and orphaned the first — permanently, because
//     the routine is forbidden to delete.
//   - Prep blocks landed on Midterm Recess and Thanksgiving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorklist, CATEGORY_KIND, kindForItem } from '../sync-calendar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

function localIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoDaysAhead(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localIso(d);
}

/** The first date at least `minDays` out that falls on `weekday` (0=Sun). */
function nextWeekday(weekday, minDays = 21) {
  const d = new Date();
  d.setDate(d.getDate() + minDays);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  return localIso(d);
}

const DAY_WORD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function tempBase() {
  return mkdtemp(join(tmpdir(), 'synccal-'));
}

async function seedClass(base, folder, {
  items = [], assignments = null, syllabus = null, userState = null, code = 'BUSI 305 001/002',
} = {}) {
  const dir = join(base, 'classes', folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ course_code: code }));
  await writeFile(join(dir, 'assignments_mined.json'), JSON.stringify({ items }));
  if (assignments) await writeFile(join(dir, 'assignments.json'), JSON.stringify(assignments));
  if (syllabus) await writeFile(join(dir, 'syllabus_parsed.json'), JSON.stringify(syllabus));
  if (userState) await writeFile(join(dir, 'user_state.json'), JSON.stringify({ version: 1, items: userState }));
  return dir;
}

async function build(base) {
  return buildWorklist(join(base, 'classes'));
}

// Meetings used to be off by default and every meeting test had to switch them
// on first. Nothing is switched off any more — the worklist builds every kind
// and the dashboard filters what is drawn — so this is a no-op kept only so the
// tests below still read as "given meetings are being populated".
async function meetingsOn() {}

// --- the miner/calendar category contract ----------------------------------

test('a miner category with no home in CATEGORY_KIND silently becomes homework and stops obeying its own toggle', async () => {
  // The two halves of this contract live in different languages — a prompt and
  // a lookup table — and nothing but this test connects them. A category the
  // prompt gains that the table lacks does not throw: kindForCategory's `??`
  // quietly files it under homework, where the user's Readings switch (or
  // Exams switch) can never reach it again.
  const prompt = await readFile(join(REPO, 'scripts', 'prompts', 'assignment-mining.md'), 'utf8');
  const m = /"category"\s*:\s*"([^"]+)"/.exec(prompt);
  assert.ok(m, 'assignment-mining.md must still declare a "category" enum');
  const declared = m[1].split('|').map(s => s.trim()).filter(Boolean);
  assert.ok(declared.length >= 5, `expected an enum, parsed ${JSON.stringify(declared)}`);

  const missing = declared.filter(c => !(c in CATEGORY_KIND));
  assert.deepEqual(missing, [], `miner categories with no kind: ${missing.join(', ')}`);

  // And the other direction: a kind we route that the miner can never emit is
  // dead weight the dashboard still shows a switch for.
  const orphaned = Object.keys(CATEGORY_KIND).filter(c => !declared.includes(c));
  assert.deepEqual(orphaned, [], `kinds routed for categories the miner never emits: ${orphaned.join(', ')}`);
});

test('a mined "project" category must not demote a Canvas midterm out of the exam kind', async () => {
  // Canvas 532645 is "Midterm Case Assignment-Group Assignment"; mining calls
  // the same work a project. Before this the kind flipped on whether mining had
  // finished — exam with 5d/1d prep beforehand, homework with 7d/2d prep after,
  // and the first pair of events orphaned.
  const base = await tempBase();
  const due = isoDaysAhead(30);
  await seedClass(base, '93903-busi-380-002', {
    code: 'BUSI 380 002',
    items: [{
      id: 'midterm-case-assignment', title: 'Midterm Case Assignment (Group)',
      canvas_assignment_id: 532645, category: 'project', due_date: due, due_time: '13:00',
    }],
    assignments: [{
      id: 532645, name: 'Midterm Case Assignment-Group Assignment',
      due_at: new Date(`${due}T13:00:00`).toISOString(), points_possible: 100,
      html_url: 'https://canvas.rice.edu/courses/93903/assignments/532645',
    }],
  });
  const w = await build(base);
  const dueOp = w.ops.find(o => o.calendar === 'due');
  assert.equal(dueOp.kind, 'exam', 'Canvas said midterm; the kind must not depend on mining finishing');
  assert.equal(w.counts.exam, 1);
  const preps = w.ops.filter(o => o.kind === 'checkpoint').map(o => o.days_before).sort((a, b) => a - b);
  assert.deepEqual(preps, [1, 5], 'an exam gets exam prep, not the project prep its mined category implies');
  await rm(base, { recursive: true, force: true });
});

test('a Canvas project report must not be promoted to an exam just because mining has not run', () => {
  // The mirror of the test above: promotion is a veto Canvas holds, and it must
  // only fire on a real exam token. BUSI 374's "Project: Final Project Report"
  // and ENTR 222's "Final Presentation" both used to read as exams.
  assert.equal(kindForItem({ category: 'project', canvas_category: 'homework' }), 'homework');
  assert.equal(kindForItem({ category: 'reading', canvas_category: 'exam' }), 'reading',
    'a reading matching an exam-titled row is a mining error, not a hidden midterm');
  assert.equal(kindForItem({ category: 'exam' }), 'exam');
});

// --- meetings that are not meetings ------------------------------------------

test("BUSI 396's four module boundaries must be counted as unscheduled, not vanish between two files", async () => {
  // cal-meetings.js refuses these rows a session, and it is right to: each is
  // the head of a five-week date RANGE and the class states its meeting days
  // nowhere at all, so a session would be invented time. But the refusal used
  // to happen inside cal-meetings and end there — worklist.json showed the
  // class with zero meetings and zero drops, and the four dated syllabus rows
  // existed in no output the user could see. Suppressed and unaccounted-for
  // are different things.
  const base = await tempBase();
  await seedClass(base, '92403-busi-396-001', {
    code: 'BUSI 396 001',
    items: [],
    syllabus: {
      course: { meeting_schedule: null },
      schedule: [
        { date: isoDaysAhead(3), type: 'lecture', week: 1, title: 'Module 1: Think, Then Do Begins' },
        { date: isoDaysAhead(31), type: 'lecture', week: 5, title: 'Module 2: Land Your Message Begins' },
        { date: isoDaysAhead(52), type: 'lecture', week: 8, title: 'Module 3: Communicate in the Real World Begins' },
        { date: isoDaysAhead(71), type: 'lecture', week: 11, title: 'Module 4: Create Impact, Not Output Begins' },
      ],
    },
  });
  await meetingsOn(base);
  const w = await build(base);

  assert.equal(w.counts.meeting, 0, 'no phantom all-day classes — this half was already right');
  assert.equal(w.unscheduled['busi-396-001'].module_boundary, 4,
    'the four rows must be counted somewhere the user can see');
  const mods = w.dropped.filter(d => d.reason === 'module_boundary');
  assert.equal(mods.length, 4);
  assert.ok(mods.every(d => d.kind === 'meeting'));
  assert.ok(mods.every(d => d.date), 'the dates are real syllabus facts and must survive the refusal');
  assert.match(mods[0].detail, /date RANGE/, 'and the reason must be stated in words, not just tallied');
  const md = await readFile(join(base, 'calendar', 'worklist.md'), 'utf8');
  assert.match(md, /Items with no calendar event/);
  await rm(base, { recursive: true, force: true });
});

test('a class that really meets MW keeps its module-boundary session instead of losing a class', async () => {
  // The guard on the guard. The refusal only fires where no weekly pattern
  // covers that weekday; with MW 8:00-9:15 in hand, "Module 3 Begins" on a
  // Wednesday is an ordinary session. If the refusal ever widened, a student
  // would quietly lose real classes off their calendar, and the counter added
  // above is what would show it: module_boundary would be non-zero here.
  const base = await tempBase();
  const wed = nextWeekday(3);
  await seedClass(base, '92404-busi-397-001', {
    code: 'BUSI 397 001',
    items: [],
    syllabus: {
      course: { meeting_schedule: 'MW 8:00-9:15am' },
      schedule: [{ date: wed, type: 'lecture', title: 'Module 3: Real World Begins' }],
    },
  });
  await meetingsOn(base);
  const w = await build(base);

  const meeting = w.ops.find(o => o.kind === 'meeting' && o.date === wed);
  assert.ok(meeting, `the ${DAY_WORD[3]} session must survive`);
  assert.equal(meeting.time, '08:00', 'and keep the time the pattern gives it');
  assert.equal(w.unscheduled['busi-397-001']?.module_boundary ?? 0, 0,
    'nothing was refused, so nothing may be reported as refused');
  await rm(base, { recursive: true, force: true });
});

// --- work that has no date ---------------------------------------------------

test('a class whose homework is all undated and recurring must report it, not show an empty column', async () => {
  // BUSI 305 holds "MBC Homework Assignments" (weekly) and ECON 205 "Problem
  // Sets" (weekly) — 15% of a grade between them — with no dates anywhere. The
  // drop is correct: NO TIME BEATS A WRONG TIME. Showing "0 homework" for it is
  // not, because the student cannot tell that from "nothing is due".
  const base = await tempBase();
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [
      { id: 'homework-assignments', title: 'MBC Homework Assignments', category: 'homework', due_date: null, recurring: 'weekly' },
      { id: 'pre-class-readings', title: 'Pre-class Readings', category: 'reading', due_date: null, recurring: 'before each class' },
    ],
  });
  const w = await build(base);
  assert.equal(w.counts.homework, 0);
  assert.equal(w.counts.reading, 0);
  assert.equal(w.unscheduled['busi-305-001-002-003'].recurring, 2);
  assert.equal(w.unscheduled_by_kind.reading, 1, 'the Readings toggle must be able to say WHY it shows zero');
  assert.equal(w.unscheduled_by_kind.homework, 1);
  const reading = w.dropped.find(d => d.kind === 'reading');
  assert.equal(reading.reason, 'recurring');
  assert.equal(reading.title, 'Pre-class Readings');
  assert.equal(w.recurring_notes.length, 2, 'the notes stay — the counts are in addition to them');
  const md = await readFile(join(base, 'calendar', 'worklist.md'), 'utf8');
  assert.match(md, /Items with no calendar event/);
  await rm(base, { recursive: true, force: true });
});

test('an item dated a year off must not vanish without a trace', async () => {
  // ENTR 222's "Mid-Semester Teamwork Survey" carries due_date 2025-10-15 — the
  // miner reading a stale syllabus header. The window filter dropped it in
  // silence, so a wrong year looked exactly like an item that did not exist.
  const base = await tempBase();
  const wrongYear = `${new Date().getFullYear() - 1}-10-15`;
  await seedClass(base, '94038-entr-222-001', {
    code: 'ENTR 222 001',
    items: [
      { id: 'teamwork-survey', title: 'Mid-Semester Teamwork Survey', category: 'other', due_date: wrongYear },
      { id: 'knowledge-check', title: 'Start Here Knowledge Check', category: 'quiz', due_date: null },
    ],
  });
  const w = await build(base);
  const out = w.dropped.find(d => d.item_id === 'teamwork-survey');
  assert.equal(out.reason, 'out_of_window');
  assert.equal(out.date, wrongYear);
  const undated = w.dropped.find(d => d.item_id === 'knowledge-check');
  assert.equal(undated.reason, 'undated');
  assert.equal(w.unscheduled['entr-222-001'].out_of_window, 1);
  assert.equal(w.unscheduled['entr-222-001'].undated, 1);
  await rm(base, { recursive: true, force: true });
});

// --- the title the user asked for --------------------------------------------
//
// "meetings are not going in correctly. they should show class days, times, and
// location. Should be titled '[LOC] - [CLASS] - [PROF]', eg. 'Virani 182 -
// BUSI380 - VanHorn' as pulled from the syllabus." — 2026-08-24.
//
// Every meeting op shipped before this said "ENTR 222 · Lecture: Introduction":
// no room on any of the 26 ops that know one, and no professor on any of the
// 106, though all six classes populate course.instructor.name.

test('a meeting names the room, the class and the professor — in that order, from the syllabus', async () => {
  const base = await tempBase();
  const tuesday = nextWeekday(2, 21);
  await seedClass(base, '94038-entr-222-001', {
    code: 'ENTR 222 001',
    syllabus: {
      course: {
        meeting_schedule: 'TR, 10:50 am - 12:05 pm in Cambridge Office Building 130',
        instructor: { name: 'Adam Wulf' },
      },
      schedule: [{ date: tuesday, type: 'lecture', title: 'Introduction' }],
    },
  });
  await meetingsOn(base);
  const w = await build(base);
  const m = w.ops.find(o => o.kind === 'meeting' && o.date === tuesday);
  assert.ok(m, 'the session itself must survive the retitle');
  assert.equal(m.title, 'Cambridge Office Building 130 - ENTR222 - Wulf');

  // Days and times are still carried as fields, per §4.4 — the title is three
  // fields, not a replacement for the event.
  assert.equal(m.time, '10:50');
  assert.equal(m.end_time, '12:05');
  assert.equal(m.location, 'Cambridge Office Building 130');

  // The label and the topic used to BE the title. They are real syllabus facts,
  // so they lead the description rather than being dropped for not being one of
  // the three fields the user named.
  assert.match(m.description, /^Lecture: Introduction\n/);
  await rm(base, { recursive: true, force: true });
});

test('with no room known the title degrades to class and professor — never a leading dash, never "null"', async () => {
  // 80 of 106 meeting ops have no location at all. BUSI 380 is the shape: the
  // syllabus names the days, states no room, and names Constance Porter.
  const base = await tempBase();
  const tuesday = nextWeekday(2, 21);
  await seedClass(base, '93903-busi-380-002', {
    code: 'BUSI 380 002',
    syllabus: {
      course: { meeting_schedule: 'Tuesdays and Thursdays', instructor: { name: 'Constance Porter' } },
      schedule: [{ date: tuesday, type: 'lecture', title: 'Assess Your Customers' }],
    },
  });
  await meetingsOn(base);
  const w = await build(base);
  const m = w.ops.find(o => o.kind === 'meeting' && o.date === tuesday);
  assert.equal(m.location, null, 'the room really is unknown — this is the degraded case');
  assert.equal(m.title, 'BUSI380 - Porter');
  for (const op of w.ops.filter(o => o.kind === 'meeting')) {
    assert.doesNotMatch(op.title, /^\s*-\s*/, 'an absent room must not leave a leading separator');
    assert.doesNotMatch(op.title, /\bnull\b/, 'an absent field must not print as the word null');
    assert.doesNotMatch(op.title, / - {2,}| -\s+- /, 'and must not leave an empty slot between two separators');
  }
  await rm(base, { recursive: true, force: true });
});

test('a professor with a title keeps their surname, and an internal capital is not a split point', async () => {
  // Two of the six real instructor strings break a naive split: "Dr. Leila
  // Peyravan" (BUSI 305) must not title the calendar "Dr." and "David VanHorn"
  // (BUSI 374) must not become "Horn". This asserts it end to end, through the
  // worklist, because that is where the user sees it.
  const base = await tempBase();
  const monday = nextWeekday(1, 21);
  await seedClass(base, '92294-busi-305-001-002-003', {
    code: 'BUSI 305 001/002/003',
    syllabus: {
      course: { meeting_schedule: 'M/W 2:30-3:45pm', instructor: { name: 'Dr. Leila Peyravan' } },
      schedule: [{ date: monday, type: 'lecture', title: 'Transaction analysis' }],
    },
  });
  await seedClass(base, '92336-busi-374-001-002', {
    code: 'BUSI 374 001/002',
    syllabus: {
      course: { meeting_schedule: 'M/W 2:30-3:45pm', instructor: { name: 'David VanHorn' } },
      schedule: [{ date: monday, type: 'lecture', title: 'Long-Lived Assets' }],
    },
  });
  await meetingsOn(base);
  const w = await build(base);
  assert.equal(w.ops.find(o => o.class === 'busi-305-001-002-003' && o.kind === 'meeting').title, 'BUSI305 - Peyravan');
  assert.equal(w.ops.find(o => o.class === 'busi-374-001-002' && o.kind === 'meeting').title, 'BUSI374 - VanHorn');
  await rm(base, { recursive: true, force: true });
});

test('a no-class day says so instead of naming a room and a professor for a class that does not happen', async () => {
  const base = await tempBase();
  const holiday = nextWeekday(2, 21);
  await seedClass(base, '93903-busi-380-002', {
    code: 'BUSI 380 002',
    syllabus: {
      course: { meeting_schedule: 'Tuesdays and Thursdays', instructor: { name: 'Constance Porter' } },
      schedule: [{ date: holiday, type: 'holiday', title: 'Midterm Recess' }],
    },
  });
  await meetingsOn(base);
  const w = await build(base);
  const m = w.ops.find(o => o.kind === 'meeting' && o.date === holiday);
  assert.equal(m.title, 'No class - BUSI380');
  assert.equal(m.category, 'holiday');
  assert.match(m.description, /Midterm Recess/, 'which recess it is still has to be somewhere');
  await rm(base, { recursive: true, force: true });
});

test('the weekly-recurrence fallback gets the same three-field title as a dated session', async () => {
  // A class with prose and no dated rows emits ONE recurring op. It used to be
  // titled "BUSI 305 · Class", which names neither of the two things the user
  // asked for and which they can read off no other field of the event.
  const base = await tempBase();
  await seedClass(base, '90805-econ-205-002', {
    code: 'ECON 205 002',
    syllabus: {
      course: { meeting_schedule: 'Class meets TR 1:00-2:15 PM in Sewall 301', instructor: { name: 'Marc Dudey' } },
      schedule: [],
    },
  });
  await meetingsOn(base);
  const w = await build(base);
  const m = w.ops.find(o => o.kind === 'meeting');
  assert.ok(m.recurrence, 'still one recurring op, not a fan of guessed dates');
  assert.equal(m.title, 'Sewall 301 - ECON205 - Dudey');
  await rm(base, { recursive: true, force: true });
});

// ADDED BY THE ADVERSARY PASS — THIS TEST IS EXPECTED TO FAIL. It is not a
// scratch test; it pins a defect in the retitle, and the suite is red on
// purpose until the defect is fixed.
test('a Canvas course event whose own title says "No Class" must not be titled with a room and a professor', async () => {
  // The three-field title moved the session's own words out of the title and
  // into the description, and the no-class guard at the call site asks only
  // `m.holiday`. cal-meetings.js:585 hardcodes `holiday: false` on EVERY
  // meeting it reads from Canvas course events — that source has no holiday
  // type to read — and sync-calendar.js:429 passes no `label` at all on the
  // non-holiday branch, so meetingTitle's own NO_CLASS_LABEL_RE (cal-names.js)
  // can never see it. Canvas course events are the FIRST source collectMeetings
  // merges (cal-meetings.js:609), so they outrank the syllabus wherever a
  // professor has created them.
  //
  // Before the retitle this row read "BUSI 380 · Class: No Class - Fall Break"
  // — the words were in the title and the student saw them. It now reads
  // "Virani 182 - BUSI380 - Porter", which is this file's own description of
  // the failure it is meant to prevent: an instruction to walk to an empty
  // building. All six classes hold `calendar_events.json` today and all six are
  // empty, so this is latent on the live data and not visible in the 106
  // meeting ops.
  const base = await tempBase();
  const off = nextWeekday(2, 21);
  const on = nextWeekday(4, 21);
  const dir = await seedClass(base, '93903-busi-380-002', {
    code: 'BUSI 380 002',
    syllabus: {
      course: { meeting_schedule: 'Tuesdays and Thursdays 2:30-3:45pm', instructor: { name: 'Constance Porter' } },
      schedule: [],
    },
  });
  await writeFile(join(dir, 'calendar_events.json'), JSON.stringify([
    {
      id: 1, title: 'No Class - Fall Break', location_name: 'Virani 182',
      start_at: new Date(`${off}T14:30:00`).toISOString(),
      end_at: new Date(`${off}T15:45:00`).toISOString(),
    },
    {
      id: 2, title: 'Pricing Strategy', location_name: 'Virani 182',
      start_at: new Date(`${on}T14:30:00`).toISOString(),
      end_at: new Date(`${on}T15:45:00`).toISOString(),
    },
  ]));
  await meetingsOn(base);
  const w = await build(base);

  const real = w.ops.find(o => o.kind === 'meeting' && o.date === on);
  assert.equal(real.title, 'Virani 182 - BUSI380 - Porter', 'the control: a real session is unaffected');

  const cancelled = w.ops.find(o => o.kind === 'meeting' && o.date === off);
  assert.ok(cancelled, 'the cancelled row is still on the calendar — the student needs to see it');
  assert.equal(cancelled.title, 'No class - BUSI380',
    'a day the class does not meet must not name the room and the professor');
  assert.equal(cancelled.location, null, 'and it must not carry a room as the event location either');
  await rm(base, { recursive: true, force: true });
});

// --- a done item you can get back --------------------------------------------

test('a done item produces no event but leaves the record the calendar needs to un-tick it', async () => {
  // CALENDAR-SPEC 2.5. Ticking an item removes it from the next worklist by
  // design, so the row and its checkbox vanish together and a mis-tick can
  // never be undone from the calendar — the exact control the user asked for by
  // name. The drop record is what the "Show completed" toggle re-renders, so it
  // has to carry a whole row, not just a reason code. Today's live worklist
  // holds 13 drops and not one has reason 'done'.
  // The check is deliberately "the record equals the op it replaced", not a
  // list of literals: the same Canvas row is seeded twice, ticked in one class
  // and untouched in the other, and the completed record has to be able to draw
  // the row the live op draws — links included, in the corrected /submissions/
  // form the links work produces rather than whatever mining stored.
  const base = await tempBase();
  const due = isoDaysAhead(10);
  const item = {
    id: 'hw-3', title: 'Homework Assignment 3', category: 'homework',
    canvas_assignment_id: 531001, due_date: due, due_time: '23:59',
  };
  const canvasRow = [{
    id: 531001, name: 'Homework Assignment 3', points_possible: 20,
    due_at: new Date(`${due}T23:59:00`).toISOString(),
    html_url: 'https://canvas.rice.edu/courses/92294/assignments/531001',
    submission_types: ['online_upload'],
  }];
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [item], assignments: canvasRow,
    userState: { 'hw-3': { done: true, doneAt: '2026-08-20T04:12:00.000Z' } },
  });
  await seedClass(base, '93903-busi-380-002', {
    code: 'BUSI 305 001/002', items: [item], assignments: canvasRow,
  });
  const w = await build(base);

  const live = w.ops.find(o => o.calendar === 'due');
  assert.ok(live, 'the untouched copy is the control — it must still be an event');
  assert.equal(w.ops.some(o => o.class === 'busi-305-001-002-003'), false,
    'a record is not a resurrection — the ticked copy is still not an event, deadline or prep');

  const rec = w.dropped.find(d => d.reason === 'done');
  assert.ok(rec, "the live worklist has 13 drops and no 'done' reason at all; that is the defect");
  assert.equal(rec.class, 'busi-305-001-002-003');
  assert.equal(rec.item_id, 'hw-3', 'the POST that un-ticks it is keyed on this');
  assert.equal(rec.title, 'Homework Assignment 3');
  assert.equal(rec.event_title, live.title, 'a completed row must read like the live rows beside it');
  assert.equal(rec.event_title, 'BUSI 305 · HW 3');
  assert.equal(rec.kind, live.kind);
  assert.equal(rec.category, live.category);
  assert.equal(rec.date, live.date, 'the row has to render on the day it was due');
  assert.equal(rec.time, live.time);
  assert.equal(rec.all_day, live.all_day);
  assert.equal(rec.url, live.url);
  assert.equal(rec.submit_url, live.submit_url);
  assert.ok(rec.submit_url, 'a Canvas-backed item has a Submit link, and the completed row keeps it');
  assert.equal(rec.done_at, '2026-08-20T04:12:00.000Z');

  assert.equal(w.unscheduled['busi-305-001-002-003'].done, 1);
  assert.equal(w.unscheduled_by_kind.homework, 0,
    'finished work is not unscheduled work — the two counts must not be confused');
  await rm(base, { recursive: true, force: true });
});

test('a done item that the user also moved is recorded at the date they moved it to', async () => {
  // Otherwise the completed row appears on a day the user has not thought about
  // the item since, and un-ticking it would put the deadline back on the
  // original date rather than theirs.
  const base = await tempBase();
  const moved = isoDaysAhead(20);
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [{ id: 'hw-1', title: 'Homework 1', category: 'homework', due_date: isoDaysAhead(10), due_time: '23:59' }],
    userState: { 'hw-1': { done: true, dueOverride: moved } },
  });
  const w = await build(base);
  const rec = w.dropped.find(d => d.reason === 'done');
  assert.equal(rec.date, moved);
  assert.equal(rec.time, '23:59', 'a move does not change the clock time the item is due at');
  await rm(base, { recursive: true, force: true });
});

// ADDED BY THE ADVERSARY PASS — THIS TEST IS EXPECTED TO FAIL. The suite is
// red on purpose until the defect it pins is fixed.
test('an automatic prep block is tickable by its offset, and the tick survives the deadline moving', async () => {
  // CALENDAR-SPEC 2.9 for the 32 prep blocks the live worklist actually holds:
  // none of them is user-authored, so none has a row in user_state.json to set
  // a flag on. Their identity is the OFFSET from the deadline — key a tick on
  // the date instead and moving the deadline strands it on a day nothing
  // happens any more.
  const base = await tempBase();
  const due = isoDaysAhead(20);
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [{ id: 'exam-1', title: 'Midterm Exam', category: 'exam', due_date: due, due_time: '14:00' }],
  });

  const before = await build(base);
  const blocks = before.ops.filter(o => o.kind === 'checkpoint');
  assert.ok(blocks.length >= 2, `expected several prep blocks, got ${blocks.length}`);
  for (const b of blocks) {
    assert.equal(b.item_id, 'exam-1', 'a block names the item it belongs to');
    assert.match(b.checkpoint_id, /^auto:\d+d$/, 'and names itself, so a checkbox has something to POST');
  }
  const ticked = blocks[0].checkpoint_id;
  const offset = Number(/^auto:(\d+)d$/.exec(ticked)[1]);

  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [{ id: 'exam-1', title: 'Midterm Exam', category: 'exam', due_date: due, due_time: '14:00' }],
    userState: { 'exam-1': { checkpointsDone: [ticked] } },
  });
  const after = await build(base);
  assert.equal(after.ops.some(o => o.checkpoint_id === ticked), false, 'the ticked block produces no event');
  assert.equal(after.ops.filter(o => o.kind === 'checkpoint').length, blocks.length - 1,
    'and only that one — its siblings are still work the user has to do');
  const rec = after.dropped.find(d => d.reason === 'done' && d.checkpoint_id === ticked);
  assert.ok(rec, 'a ticked block leaves the record the un-tick needs');
  assert.equal(rec.item_id, 'exam-1');
  assert.equal(rec.date, isoAddDaysBack(due, offset));
  assert.ok(rec.event_title, 'and reads like the op it replaced');
  assert.equal(after.unscheduled['busi-305-001-002-003'].done, 1);

  // The deadline moves a day later. The tick moves with it rather than being
  // left behind on a date that no longer means anything.
  const moved = isoDaysAhead(21);
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [{ id: 'exam-1', title: 'Midterm Exam', category: 'exam', due_date: due, due_time: '14:00' }],
    userState: { 'exam-1': { checkpointsDone: [ticked], dueOverride: moved } },
  });
  const later = await build(base);
  assert.equal(later.ops.some(o => o.checkpoint_id === ticked), false, 'still ticked after the move');
  const movedRec = later.dropped.find(d => d.reason === 'done' && d.checkpoint_id === ticked);
  assert.equal(movedRec.date, isoAddDaysBack(moved, offset), 'and the completed row moved with it');
  await rm(base, { recursive: true, force: true });
});

/** The date `days` before `iso`, the way the prep-block builder computes it. */
function isoAddDaysBack(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const probe = new Date(y, m - 1, d - days);
  return localIso(probe);
}

test('a checkpoint the user ticked must leave the same record a ticked deadline does', async () => {
  // CALENDAR-SPEC 2.5 with 2.9: checkpoints ARE checkable ("they are the user's
  // own prep blocks", 32 ops on the live data), so a checkpoint is a done item
  // and 2.5 applies to it word for word. The deadline path now records one —
  // sync-calendar.js:218 pushes a full row with reason 'done' — but the
  // checkpoint path two hundred lines further down still reads
  // `if (cp.done) continue;` and records nothing at all. Tick a prep block and
  // its row and its checkbox vanish together, which is exactly the state 2.5
  // exists to end.
  //
  // The consumer is already waiting for it: bridge/public/app.js:2342 maps a
  // done record to `calendar: d.kind === 'checkpoint' ? 'checkpoint' : 'due'`,
  // a branch the worklist can never reach.
  const base = await tempBase();
  const due = isoDaysAhead(20);
  const ticked = isoDaysAhead(8);
  const open = isoDaysAhead(15);
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [{ id: 'hw-1', title: 'Homework 1', category: 'homework', due_date: due, due_time: '23:59' }],
    userState: {
      'hw-1': {
        checkpoints: [
          { id: 'cp1', title: 'Outline draft', date: ticked, done: true },
          { id: 'cp2', title: 'Final read', date: open, done: false },
        ],
      },
    },
  });
  const w = await build(base);

  const live = w.ops.filter(o => o.kind === 'checkpoint');
  assert.equal(live.length, 1, 'the control: the untouched checkpoint is still an event');
  assert.equal(live[0].date, open);
  assert.equal(w.ops.some(o => o.date === ticked), false, 'a record is not a resurrection');

  const rec = w.dropped.find(d => d.reason === 'done' && d.kind === 'checkpoint');
  assert.ok(rec, 'a ticked prep block leaves no trace in `dropped`; that is the defect');
  assert.equal(rec.class, 'busi-305-001-002-003');
  assert.equal(rec.date, ticked, 'the completed row has to render on the day it was planned for');
  assert.equal(rec.event_title, 'BUSI 305 · Outline draft',
    'and read like the checkpoint op it replaced');
  assert.equal(w.unscheduled['busi-305-001-002-003'].done, 1);
  await rm(base, { recursive: true, force: true });
});

// --- a zero that says why it is zero ------------------------------------------

test('a class with no meetings says in a sentence why, not just with a count of four', async () => {
  // CALENDAR-SPEC 4.5. BUSI 396's four "Module N … Begins" rows head five-week
  // date RANGES; refusing them a session is right, and `unscheduled` has
  // counted them as module_boundary since that fix landed. But a count of 4
  // under a key named `module_boundary` is not something a calendar column can
  // print, so the class still showed an empty week with nothing to explain it.
  const base = await tempBase();
  await seedClass(base, '92403-busi-396-001', {
    code: 'BUSI 396 001',
    items: [],
    syllabus: {
      course: { meeting_schedule: null, instructor: { name: 'Matt Smith' } },
      schedule: [
        { date: isoDaysAhead(3), type: 'lecture', week: 1, title: 'Module 1: Think, Then Do Begins' },
        { date: isoDaysAhead(31), type: 'lecture', week: 5, title: 'Module 2: Land Your Message Begins' },
        { date: isoDaysAhead(52), type: 'lecture', week: 8, title: 'Module 3: Communicate in the Real World Begins' },
        { date: isoDaysAhead(71), type: 'lecture', week: 11, title: 'Module 4: Create Impact, Not Output Begins' },
      ],
    },
  });
  await meetingsOn(base);
  const w = await build(base);

  assert.equal(w.counts.meeting, 0);
  const note = w.kind_notes.meeting.classes['busi-396-001'];
  assert.ok(note, 'a class with zero meetings must have a line to show');
  assert.equal(note, 'Meetings: none on the calendar — 4 class meetings are module or unit '
    + 'boundaries heading date ranges, not class sessions.');
  assert.match(note, /^Meetings: none on the calendar — /, 'a whole sentence, printable unchanged');
  assert.match(note, /\.$/);

  const md = await readFile(join(base, 'calendar', 'worklist.md'), 'utf8');
  assert.match(md, /Kinds and classes that produced nothing/);
  assert.ok(md.includes(note), 'the routine reads the markdown and must be told too');
  await rm(base, { recursive: true, force: true });
});

test('the Readings toggle can say why it is structurally dead instead of just showing zero', async () => {
  // CALENDAR-SPEC 4.6. Exactly one of 85 merged items across six classes is
  // categorised `reading` — BUSI 305's "Pre-class Readings" — it is
  // `recurring: "before each class"` with a null due date, and recurring items
  // are routed to notes before ops are built. So the switch reads "on", is
  // honest, and can never produce an event. `unscheduled_by_kind.reading = 1`
  // gave the number; a number is not a reason, and the UI cannot invent one.
  const base = await tempBase();
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [
      { id: 'pre-class-readings', title: 'Pre-class Readings', category: 'reading', due_date: null, recurring: 'before each class' },
      { id: 'hw-1', title: 'Homework 1', category: 'homework', due_date: isoDaysAhead(10) },
    ],
  });
  const w = await build(base);

  assert.equal(w.counts.reading, 0);
  assert.equal(w.kind_notes.reading.ops, 0);
  assert.equal(w.kind_notes.reading.note,
    'Readings: none on the calendar — 1 reading recurs on no fixed date.');
  assert.equal(w.kind_notes.reading.classes['busi-305-001-002-003'],
    w.kind_notes.reading.note, 'and the same answer per class, for the class column');

  // A kind that DID produce events explains nothing — silence is the correct
  // output when there is nothing to explain.
  assert.equal(w.kind_notes.homework.note, null);
  assert.equal('busi-305-001-002-003' in w.kind_notes.homework.classes, false);

  const md = await readFile(join(base, 'calendar', 'worklist.md'), 'utf8');
  assert.ok(md.includes(w.kind_notes.reading.note));
  await rm(base, { recursive: true, force: true });
});

test('nothing is switched off any more, so no note may claim anything is', async () => {
  // This used to read "Meetings: none on the calendar — the Meetings switch is
  // off.", printed once per switched-off kind. The user asked for it to go, in
  // those words: it restated a control sitting directly above it.
  //
  // Then the switches themselves went. The worklist builds every kind it can
  // find and the dashboard filters what is DRAWN, so a kind can no longer be
  // zero because of a setting — only because of the data. Both halves are
  // asserted here: meetings appear with no switch to turn on, and the sentence
  // that used to explain a switch appears nowhere at all.
  const base = await tempBase();
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [{ id: 'hw-1', title: 'Homework 1', category: 'homework', due_date: isoDaysAhead(10) }],
    syllabus: {
      course: { meeting_schedule: 'M/W 2:30-3:45pm', instructor: { name: 'Dr. Leila Peyravan' } },
      schedule: [{ date: nextWeekday(1, 21), type: 'lecture', title: 'Transaction analysis' }],
    },
  });
  const w = await build(base);
  assert.equal(w.counts.meeting, 1, 'a meeting is built with nothing to switch on');
  assert.equal(w.kind_notes.meeting.note, null, 'and a kind that produced events explains nothing');
  assert.equal(/switch is off/.test(JSON.stringify(w.kind_notes)), false,
    'no kind may print that sentence any more');
  // …while a kind that produced nothing still owes a reason.
  assert.match(w.kind_notes.reading.note, /^Readings: none on the calendar — /);
  await rm(base, { recursive: true, force: true });
});

test('office hours are built from the syllabus, and refused rather than guessed', async () => {
  // The professor states them on every syllabus in this corpus and nobody puts
  // them on a calendar. The half that matters is the refusal: ECON 205 names a
  // weekday and an end time and no start, and an hour invented there sends a
  // student to a dark classroom.
  const base = await tempBase();
  await seedClass(base, '92354-busi-396-001', {
    code: 'BUSI 396 001',
    items: [],
    syllabus: {
      course: { instructor: { name: 'Matt Smith', email: 'matthew.smith@rice.edu', office_hours: 'M/W/F 11:30 – 1:30' } },
      schedule: [{ date: isoDaysAhead(30), type: 'lecture', title: 'Week 5' }],
    },
  });
  await seedClass(base, '90805-econ-205-002', {
    code: 'ECON 205 002',
    items: [],
    syllabus: {
      course: { instructor: { name: 'Marc Dudey', office_hours: 'By appointment and, on Tuesdays, in the classroom until 9:00 p.m. or until the number of students drops to zero, whichever comes first.' } },
      schedule: [],
    },
  });
  const w = await build(base);

  const oh = w.ops.filter(o => o.kind === 'office_hours');
  assert.equal(oh.length, 1, 'one block built, one refused');
  assert.equal(oh[0].class, 'busi-396-001');
  assert.equal(oh[0].title, 'BUSI396 Office hours - Smith',
    'the same grammar as a lecture title, because they share a calendar');
  assert.deepEqual(oh[0].recurrence.byday, ['MO', 'WE', 'FR']);
  assert.equal(oh[0].time, '11:30');
  assert.equal(oh[0].end_time, '13:30');
  assert.equal(oh[0].calendar, 'meeting', 'a standing commitment in a room, not a deadline');
  // It ends when the class stops meeting, not 180 days out.
  assert.equal(oh[0].recurrence.until, isoDaysAhead(30));
  // The anchor date must land on a day the pattern actually meets: clients
  // render DTSTART itself as an occurrence, so an arbitrary window-open
  // weekday paints a phantom office-hours block.
  const anchorDay = new Date(oh[0].date + 'T12:00:00').getDay();
  assert.ok([1, 3, 5].includes(anchorDay), `anchor ${oh[0].date} must be a MO/WE/FR`);
  // The professor's own words survive into the description, unreformatted.
  assert.match(oh[0].description, /Syllabus: M\/W\/F 11:30 – 1:30/);

  const refused = w.dropped.filter(d => d.kind === 'office_hours');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].class, 'econ-205-002');
  assert.equal(refused[0].reason, 'no_time');
  assert.match(w.kind_notes.office_hours.classes['econ-205-002'],
    /^Office hours: none on the calendar — 1 office-hours block names a day but no start time/);
  await rm(base, { recursive: true, force: true });
});

test('two office-hours schedules fenced by date ranges must not overlap', async () => {
  // BUSI 374 states MW 11am-2:15pm from 10/7 and a different Monday block
  // before it. Ignoring the ranges puts two contradictory office hours on every
  // Monday of the term — a wrong time reached from entirely correct inputs.
  const base = await tempBase();
  const md = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const field = `M 10am-12:15pm; W 11am-12:15pm; or by appointment (${md(7)} – ${md(60)});`
    + ` MW 11am-2:15pm; or by appointment (${md(62)}-${md(120)})`;
  await seedClass(base, '92336-busi-374-001', {
    code: 'BUSI 374 001',
    items: [],
    syllabus: {
      course: { instructor: { name: 'David VanHorn', office_hours: field } },
      schedule: [{ date: isoDaysAhead(120), type: 'lecture', title: 'Last week' }],
    },
  });
  const w = await build(base);
  const oh = w.ops.filter(o => o.kind === 'office_hours');
  assert.equal(oh.length, 3, 'two Monday blocks and a Wednesday one');
  for (const a of oh) {
    for (const b of oh) {
      if (a === b) continue;
      const sameDay = a.recurrence.byday.some(d => b.recurrence.byday.includes(d));
      const overlap = a.recurrence.from <= b.recurrence.until && b.recurrence.from <= a.recurrence.until;
      assert.equal(sameDay && overlap, false,
        `${a.recurrence.byday}/${a.recurrence.from}-${a.recurrence.until} overlaps `
        + `${b.recurrence.byday}/${b.recurrence.from}-${b.recurrence.until}`);
    }
  }
  await rm(base, { recursive: true, force: true });
});

// --- markers that survive a correction ---------------------------------------

test('a lecture that moves to a different date must update its event, not leave an orphan behind', async () => {
  // The prefix used to be `[csync:m|<slug>|<date>#<n>|`, so every date fix the
  // parser ships would CREATE a second event and strand the first one on the
  // user's real calendar forever — the routine may never delete.
  const base = await tempBase();
  const wrong = nextWeekday(1, 21);            // Monday: the week-table artefact
  const right = nextWeekday(3, 21);            // Wednesday: where the session is
  const syllabus = (date) => ({
    course: { meeting_schedule: 'M/W 2:30-3:45pm' },
    schedule: [{ date, type: 'lecture', title: 'Transaction analysis' }],
  });
  await seedClass(base, '92336-busi-374-001-002', { code: 'BUSI 374 001/002', syllabus: syllabus(wrong) });
  await meetingsOn(base);
  const before = (await build(base)).ops.find(o => o.kind === 'meeting');

  await seedClass(base, '92336-busi-374-001-002', { code: 'BUSI 374 001/002', syllabus: syllabus(right) });
  const after = (await build(base)).ops.find(o => o.kind === 'meeting');

  assert.equal(after.date, right);
  assert.equal(after.marker_prefix, before.marker_prefix, 'same session — the routine must match and UPDATE it');
  assert.notEqual(after.marker, before.marker, 'the hash must change so the routine knows to rewrite it');
  assert.equal(before.marker_prefix.includes(wrong), false, 'no date may live inside a marker prefix');
  await rm(base, { recursive: true, force: true });
});

test('two sessions sharing a topic must not collapse onto one marker', async () => {
  const base = await tempBase();
  const a = nextWeekday(1, 21);
  const b = nextWeekday(3, 21);
  await seedClass(base, '92336-busi-374-001-002', {
    code: 'BUSI 374 001/002',
    syllabus: {
      course: { meeting_schedule: 'M/W 2:30-3:45pm' },
      schedule: [
        { date: a, type: 'lecture', title: 'Long-Lived Assets' },
        { date: b, type: 'lecture', title: 'Long-Lived Assets' },
      ],
    },
  });
  await meetingsOn(base);
  const meetings = (await build(base)).ops.filter(o => o.kind === 'meeting');
  assert.equal(meetings.length, 2);
  assert.equal(new Set(meetings.map(o => o.marker_prefix)).size, 2);
  await rm(base, { recursive: true, force: true });
});

// --- days known, hour unknown -------------------------------------------------

test('a meeting with known days and no stated time must be an all-day op that says the hour is unknown', async () => {
  // BUSI 380's syllabus names Tuesdays and Thursdays and states no time; Canvas
  // has no course events. The all-day bar it produced asserted "class today"
  // with nothing to say the hour was unknown, and ROUTINE.md's only instruction
  // for a meeting op was "create a real timed event" — an invitation to invent
  // a clock time, which is the one thing this codebase must never do.
  const base = await tempBase();
  const tuesday = nextWeekday(2, 21);
  await seedClass(base, '93903-busi-380-002', {
    code: 'BUSI 380 002',
    syllabus: {
      course: { meeting_schedule: 'Tuesdays and Thursdays' },
      schedule: [{ date: tuesday, type: 'lecture', title: 'Assess Your Customers' }],
    },
  });
  await meetingsOn(base);
  const w = await build(base);
  const m = w.ops.find(o => o.kind === 'meeting' && o.date === tuesday);
  assert.ok(m, 'the day is known, so the session is still real');
  assert.equal(m.time, null);
  assert.equal(m.all_day, true);
  assert.equal(m.time_known, false, 'the routine must be able to act on "no time" as a fact, not an absence');
  assert.match(m.description, /Time unknown/);

  const md = await readFile(join(base, 'calendar', 'worklist.md'), 'utf8');
  assert.match(md, /Never invent a start time/i, 'the instructions the routine reads must carry the branch too');
  await rm(base, { recursive: true, force: true });
});

// --- holidays -----------------------------------------------------------------

test('a prep block must not land on a day two synced classes call a holiday', async () => {
  // 2026-11-26 carried "Prep · ENTR 222 Final Talk" and 2026-10-13 carried
  // "Prep · BUSI 396 Business Insight Talk". Both are Rice recess days, named
  // as holidays by two other classes' syllabi, and the checkpoint table never
  // consulted them.
  const base = await tempBase();
  const holiday = isoDaysAhead(25);
  const due = isoDaysAhead(30);                     // 5 days after the holiday
  const holidayRow = { schedule: [{ date: holiday, type: 'holiday', title: 'Midterm Recess' }] };
  await seedClass(base, '93903-busi-380-002', { code: 'BUSI 380 002', syllabus: holidayRow });
  await seedClass(base, '94038-entr-222-001', { code: 'ENTR 222 001', syllabus: holidayRow });
  await seedClass(base, '92354-busi-396-001', {
    code: 'BUSI 396 001',
    items: [{ id: 'insight-talk', title: 'Business Insight Talk', category: 'presentation', due_date: due }],
  });
  const w = await build(base);
  assert.deepEqual(w.holidays, [holiday]);
  assert.equal(w.ops.some(o => o.kind === 'checkpoint' && o.date === holiday), false);
  assert.equal(w.ops.filter(o => o.kind === 'checkpoint').length, 1, 'only the 1-day block survives');
  assert.equal(w.dropped.some(d => d.reason === 'holiday' && d.date === holiday), true);
  await rm(base, { recursive: true, force: true });
});

test('one class calling a date a holiday is not enough to move another class off it', async () => {
  // One "no class" row is the professor cancelling their own session. Treating
  // that as a university closure would silently delete work from every other
  // class on the calendar.
  const base = await tempBase();
  const holiday = isoDaysAhead(25);
  await seedClass(base, '93903-busi-380-002', {
    code: 'BUSI 380 002',
    syllabus: { schedule: [{ date: holiday, type: 'holiday', title: 'No class — conference' }] },
  });
  await seedClass(base, '92354-busi-396-001', {
    code: 'BUSI 396 001',
    items: [{ id: 'insight-talk', title: 'Business Insight Talk', category: 'presentation', due_date: isoDaysAhead(30) }],
  });
  const w = await build(base);
  assert.deepEqual(w.holidays, []);
  assert.equal(w.ops.filter(o => o.kind === 'checkpoint').length, 2);
  await rm(base, { recursive: true, force: true });
});

test('a meeting on a date other classes call a holiday must be flagged for review', async () => {
  const base = await tempBase();
  const holiday = nextWeekday(2, 21);               // a Tuesday that is a recess day
  const holidayRow = { schedule: [{ date: holiday, type: 'holiday', title: 'Midterm Recess' }] };
  await seedClass(base, '93903-busi-380-002', { code: 'BUSI 380 002', syllabus: holidayRow });
  await seedClass(base, '94038-entr-222-001', { code: 'ENTR 222 001', syllabus: holidayRow });
  await seedClass(base, '90805-econ-205-002', {
    code: 'ECON 205 002',
    syllabus: {
      course: { meeting_schedule: `${DAY_WORD[2]}s 6:30 - 7:45 p.m.` },
      schedule: [{ date: holiday, type: 'lecture', title: 'Repeated games' }],
    },
  });
  await meetingsOn(base);
  const w = await build(base);
  const lecture = w.ops.find(o => o.kind === 'meeting' && o.class === 'econ-205-002' && o.date === holiday);
  assert.ok(lecture, 'the session is not deleted — we do not know it is cancelled');
  assert.match(lecture.description, /mark this date as a holiday/);
  await rm(base, { recursive: true, force: true });
});

// --- prep blocks that are legible --------------------------------------------

test('the two prep blocks for one item must not be byte-identical apart from the date', async () => {
  const base = await tempBase();
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [{ id: 'exam-1', title: 'Exam 1', category: 'exam', due_date: isoDaysAhead(30) }],
  });
  const w = await build(base);
  const preps = w.ops.filter(o => o.kind === 'checkpoint');
  assert.equal(preps.length, 2);
  assert.equal(new Set(preps.map(o => o.title)).size, 2, 'a calendar grid shows the title and nothing else');
  assert.equal(new Set(preps.map(o => o.description)).size, 2);
  assert.match(preps.find(o => o.days_before === 5).title, /5d/);
  await rm(base, { recursive: true, force: true });
});

// --- the parser's own admissions ----------------------------------------------

test('a syllabus whose parser admits it inferred the dates must not produce ops that look certain', async () => {
  // ECON 205's parser wrote "The schedule assumes a standard weekly
  // progression for lectures" into extraction_notes and reported
  // extraction_confidence "high" in the same breath. Four of six classes
  // self-report inference; of 246 ops, exactly one carried a caveat.
  const base = await tempBase();
  const due = isoDaysAhead(30);
  await seedClass(base, '90805-econ-205-002', {
    code: 'ECON 205 002',
    items: [{ id: 'final-exam', title: 'Final Exam', category: 'exam', due_date: due, due_confidence: 'high' }],
    syllabus: {
      extraction_confidence: 'high',
      extraction_notes: 'The schedule assumes a standard weekly progression for lectures starting in late August.',
      schedule: [],
    },
  });
  const w = await build(base);
  assert.match(w.ops.find(o => o.calendar === 'due').description, /Date not confirmed/);
  await rm(base, { recursive: true, force: true });
});

test('a Canvas-stated deadline must not be caveated just because the syllabus parser guessed elsewhere', async () => {
  const base = await tempBase();
  const due = isoDaysAhead(30);
  await seedClass(base, '90805-econ-205-002', {
    code: 'ECON 205 002',
    items: [{ id: 'ps-1', title: 'Problem Set 1', canvas_assignment_id: 4242, category: 'homework', due_date: due }],
    assignments: [{ id: 4242, name: 'Problem Set 1', due_at: new Date(`${due}T23:59:00`).toISOString() }],
    syllabus: { extraction_confidence: 'low', extraction_notes: 'Dates were inferred.', schedule: [] },
  });
  const w = await build(base);
  assert.doesNotMatch(w.ops.find(o => o.calendar === 'due').description, /Date not confirmed/);
  await rm(base, { recursive: true, force: true });
});

// --- the window ----------------------------------------------------------------

test('the worklist window must not span a term the ops never reach', async () => {
  // window.from → window.to is the range the routine lists and indexes on every
  // target calendar, every run. A flat 180-day horizon made a Fall worklist
  // claim 2026-08-17 → 2027-02-20 with a last op on 2026-12-15 — two months of
  // a Spring term it has nothing to say about.
  const base = await tempBase();
  const due = isoDaysAhead(20);
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [{ id: 'hw-1', title: 'Homework 1', category: 'homework', due_date: due }],
  });
  const w = await build(base);
  const last = w.ops.map(o => o.date).sort().at(-1);
  assert.equal(last, due);
  assert.ok(w.window.to >= last, 'every op must fall inside the window it is indexed against');
  assert.ok(w.window.to < isoDaysAhead(60), `window ran to ${w.window.to} for a worklist ending ${last}`);
  assert.ok(w.window.horizon > w.window.to, 'the raw horizon is still reported, for anyone who needs it');
  await rm(base, { recursive: true, force: true });
});

// --- builds that race the miner -----------------------------------------------

test('a worklist must record when each class was last mined, so a stale build can be recognised', async () => {
  // The live worklist carried nothing but generated_at, so "229 ops" and
  // "245 ops" from the same data root four minutes apart were indistinguishable
  // without going to logs/trigger.log and comparing file mtimes by hand.
  const base = await tempBase();
  const dir = await seedClass(base, '92294-busi-305-001-002-003', {
    items: [{ id: 'exam-1', title: 'Exam 1', category: 'exam', due_date: isoDaysAhead(30) }],
  });
  const { stat } = await import('node:fs/promises');
  const w = await build(base);
  const onDisk = new Date((await stat(join(dir, 'assignments_mined.json'))).mtimeMs).toISOString();
  assert.equal(w.mined_at['busi-305-001-002-003'], onDisk);
  assert.deepEqual(w.mining_in_flight, [], 'a settled tree must not claim mining is running');
  await rm(base, { recursive: true, force: true });
});

test('a class the miner rewrites mid-build must be re-read, not shipped half-old', async () => {
  // The deployed worklist was generated at 18:11:26Z while mine-assignments was
  // still running for BUSI 305, ECON 205 and BUSI 380 (they finished 18:11:55,
  // 18:12:19 and 18:16:10). It went out missing five real exams and ten
  // checkpoints. Writes are atomic, so nothing was corrupt — the build had read
  // the previous file and had no way to notice.
  //
  // Reproducing that needs a real interleaving, so the tree is padded until the
  // build takes tens of milliseconds and the rewrite is fired well inside it:
  // the target class is created first (and so read first), then rewritten at
  // 8ms, while the whole pass takes ~25ms. On the old code the exam is simply
  // absent from the result.
  const base = await tempBase();
  const due = isoDaysAhead(30);
  const dir = await seedClass(base, '10000-busi-305-001-002-003', { items: [] });
  for (let i = 0; i < 120; i += 1) {
    await seedClass(base, `9${String(i).padStart(4, '0')}-filler-${i}-001`, { items: [] });
  }
  const { writeFile: wf } = await import('node:fs/promises');
  const rewrite = new Promise((resolve) => setTimeout(() => {
    wf(join(dir, 'assignments_mined.json'), JSON.stringify({
      items: [{ id: 'exam-1', title: 'Exam 1', category: 'exam', due_date: due }],
    })).then(resolve, resolve);
  }, 8));

  const w = await build(base);
  await rewrite;

  assert.equal(w.counts.exam, 1, 'the exam mining wrote must be in the worklist that same build produced');
  assert.deepEqual(w.mining_in_flight, [], 'and the shipped worklist must not still be mid-pipeline');
  await rm(base, { recursive: true, force: true });
});

// --- asking a question must not change the answer --------------------------
//
// On 2026-08-24 four helper scripts called buildWorklist() against the live
// classes dir to *read* what the calendar would say. Each one rewrote the
// user's real calendar/worklist.json, worklist.md and ROUTINE.md, because the
// writes are unconditional at the end of the function. The data survived; the
// hazard is that a read had a side effect at all.

test('write:false computes the same worklist and leaves the calendar directory untouched', async () => {
  const base = await tempBase();
  try {
    await seedClass(base, '11111-busi-305-001-002', {
      items: [{ title: 'Weekly memo', category: 'homework', due_date: isoDaysAhead(6), due_time: '23:59' }],
    });

    const dry = await buildWorklist(join(base, 'classes'), { write: false });
    assert.ok(dry, 'a dry build still returns the worklist');
    assert.ok(dry.ops.length > 0, 'and it is a real one, not an empty stub');

    // Nothing at all — not an empty calendar/ dir, not a ROUTINE.md.
    await assert.rejects(
      readFile(join(base, 'calendar', 'worklist.json'), 'utf8'),
      /ENOENT/,
      'a dry build must not create worklist.json',
    );
    await assert.rejects(readFile(join(base, 'calendar', 'worklist.md'), 'utf8'), /ENOENT/);
    await assert.rejects(readFile(join(base, 'calendar', 'ROUTINE.md'), 'utf8'), /ENOENT/);

    // Same computation, so a caller gains nothing by writing.
    const wet = await build(base);
    assert.deepEqual(
      dry.ops.map(o => o.marker).sort(),
      wet.ops.map(o => o.marker).sort(),
      'write:false must not be a different, cheaper build',
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('write:false survives the internal retry path without writing', async () => {
  const base = await tempBase();
  try {
    // A mined file mid-write is what triggers the allowRetry recursion; an
    // unparseable one reaches the same branch. The retry used to drop the
    // caller's options on the floor and re-enter with write defaulted to true.
    const dir = join(base, 'classes', '22222-busi-380-002');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'metadata.json'), JSON.stringify({ course_code: 'BUSI 380 002' }));
    await writeFile(join(dir, 'assignments_mined.json'), '{"items": [');

    const dry = await buildWorklist(join(base, 'classes'), { write: false });
    assert.ok(dry, 'a class with a half-written mined file still builds');
    await assert.rejects(
      readFile(join(base, 'calendar', 'worklist.json'), 'utf8'),
      /ENOENT/,
      'the retry must carry write:false through with it',
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// --- provenance and click-in (CALENDAR-SPEC 2.12, 2.13) ---------------------

test('every due op carries its origin, and prep blocks carry the parent link to click into', async () => {
  // The user's words: AI-added work must "look different from actual ones",
  // and "all the check ins [prep blocks] have click in". The worklist is where
  // both start: due ops say whose word they are, and a checkpoint op carries
  // the URL of the assignment it preps for.
  const base = await tempBase();
  const due = isoDaysAhead(20);
  const dueAt = new Date(Date.now() + 20 * 864e5).toISOString();
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [
      // Mined item claiming a live Canvas row: actual, submittable work.
      { id: 'proj-1', title: 'Course Project', category: 'project', canvas_assignment_id: 71 },
      // Mined only: the AI read it out of the syllabus.
      { id: 'exam-1', title: 'Midterm Exam', kind: 'implicit', category: 'exam', due_date: due, due_time: '14:00' },
    ],
    assignments: [{ id: 71, name: 'Course Project', due_at: dueAt,
      html_url: 'https://canvas.rice.edu/courses/92294/assignments/71', submission_types: ['online_upload'] }],
  });

  const w = await build(base);
  const dueOps = w.ops.filter(o => o.calendar === 'due');
  assert.equal(dueOps.length, 2);
  for (const o of dueOps) assert.ok(o.origin === 'canvas' || o.origin === 'syllabus', `${o.title} says whose word it is`);
  assert.equal(dueOps.find(o => o.item_id === 'proj-1').origin, 'canvas');
  assert.equal(dueOps.find(o => o.item_id === 'exam-1').origin, 'syllabus');

  const cps = w.ops.filter(o => o.calendar === 'checkpoint');
  assert.ok(cps.length >= 3, `project prep + exam prep expected, got ${cps.length}`);
  for (const cp of cps.filter(o => o.item_id === 'proj-1')) {
    assert.equal(cp.url, 'https://canvas.rice.edu/courses/92294/assignments/71',
      'a prep block for Canvas work links to that work');
    assert.equal(cp.origin, 'canvas');
  }
  for (const cp of cps.filter(o => o.item_id === 'exam-1')) {
    assert.equal(cp.url, null, 'a syllabus-only item has no Canvas page to link');
    assert.equal(cp.origin, 'syllabus');
  }
  await rm(base, { recursive: true, force: true });
});

test('a done item keeps its origin in the drop record, so the completed row reads like the live ones', async () => {
  const base = await tempBase();
  const due = isoDaysAhead(20);
  await seedClass(base, '92294-busi-305-001-002-003', {
    items: [{ id: 'exam-1', title: 'Midterm Exam', kind: 'implicit', category: 'exam', due_date: due }],
    userState: { 'exam-1': { done: true, doneAt: '2026-08-25T00:00:00Z' } },
  });
  const w = await build(base);
  const rec = w.dropped.find(d => d.reason === 'done' && d.item_id === 'exam-1');
  assert.ok(rec, 'the record exists');
  assert.equal(rec.origin, 'syllabus');
  await rm(base, { recursive: true, force: true });
});
