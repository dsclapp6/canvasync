// canvas-tasks.test.js — what the class page and the calendar call "the work".
//
// Two failures live here, and both are silent. The first is an empty task list:
// a class shows nothing to do while Canvas holds 41 dated assignments, because
// mining has not run yet. The second is the mirror image and worse — mining
// runs, and those 41 deadlines disappear, because mined output used to replace
// the Canvas rows instead of joining them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tasksForClass, itemsFromCanvasAssignments, categoryOf } from '../../canvas-tasks.js';

// Shapes copied from classes/93903-busi-380-002/assignments.json.
const QUIZ_ROW = {
  id: 532620,
  name: 'S9-Concept Check: Product Line Depth',
  due_at: '2026-03-10T05:59:00Z',
  points_possible: 10,
  quiz_id: 244811,
  submission_types: ['online_quiz'],
  html_url: 'https://canvas.rice.edu/courses/93903/assignments/532620',
};
const PAPER_ROW = {
  id: 532700,
  name: 'Midterm Case Assignment',
  due_at: '2026-03-20T04:59:00Z',
  points_possible: 100,
  submission_types: ['online_upload'],
  html_url: 'https://canvas.rice.edu/courses/93903/assignments/532700',
};
const UNDATED_ROW = { id: 532701, name: 'Extra credit (no deadline)', due_at: null };

test('Canvas is the floor: no mining still yields the dated work', () => {
  const { items, source } = tasksForClass({ mined: null, assignments: [QUIZ_ROW, PAPER_ROW] });
  assert.equal(source, 'canvas');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'S9-Concept Check: Product Line Depth');
});

test('undated Canvas rows are dropped — nothing to place, nothing to be late for', () => {
  const { items } = tasksForClass({ mined: null, assignments: [PAPER_ROW, UNDATED_ROW] });
  assert.deepEqual(items.map(i => i.canvas_assignment_id), [532700]);
});

test('a quiz-backed row gets the quiz URL, not the denied assignment page', () => {
  const [it] = itemsFromCanvasAssignments([QUIZ_ROW]);
  assert.equal(it.html_url, 'https://canvas.rice.edu/courses/93903/quizzes/244811');
  assert.equal(it.submit_url, 'https://canvas.rice.edu/courses/93903/quizzes/244811/take');
});

test('due date and time come from the same local view of due_at', () => {
  // 05:59Z is 11:59 PM local the previous day in US Central. Slicing the ISO
  // string would file it a day late.
  const [it] = itemsFromCanvasAssignments([QUIZ_ROW]);
  const d = new Date(QUIZ_ROW.due_at);
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(it.due_date, expected);
  assert.equal(it.due_time, `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
});

test('mining does not evict Canvas: unclaimed dated rows are still listed', () => {
  const mined = { items: [{ id: 'pre-class-slides-review', title: 'Pre-class Slides Review', canvas_assignment_id: null, due_date: null }] };
  const { items, source } = tasksForClass({ mined, assignments: [QUIZ_ROW, PAPER_ROW] });
  assert.equal(source, 'mixed');
  assert.equal(items.length, 3);
  assert.equal(items[0].id, 'pre-class-slides-review');
  assert.deepEqual(items.slice(1).map(i => i.canvas_assignment_id), [532620, 532700]);
});

test('a mined item that claims a Canvas id absorbs that row rather than doubling it', () => {
  const mined = { items: [{ id: 'm1', title: 'S9 concept check', canvas_assignment_id: 532620 }] };
  const { items, source } = tasksForClass({ mined, assignments: [QUIZ_ROW] });
  assert.equal(source, 'mined');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'm1');
  assert.equal(items[0].html_url, 'https://canvas.rice.edu/courses/93903/quizzes/244811');
});

test('a title match suppresses the duplicate even without an id', () => {
  const mined = { items: [{ id: 'm2', title: 'Midterm Case Assignment!', canvas_assignment_id: null }] };
  const { items } = tasksForClass({ mined, assignments: [PAPER_ROW] });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'm2');
});

test('a mined id Canvas no longer has loses its Submit button', () => {
  const mined = { items: [{ id: 'm3', title: 'Deleted work', canvas_assignment_id: 999999, submit_url: 'https://canvas.rice.edu/courses/93903/assignments/999999/submissions/new' }] };
  const { items } = tasksForClass({ mined, assignments: [PAPER_ROW] });
  assert.equal(items[0].submit_url, null);
});

test('the caller’s mined array is not mutated', () => {
  const item = { id: 'm4', title: 'x', canvas_assignment_id: 532620, html_url: 'stale' };
  const mined = { items: [item] };
  tasksForClass({ mined, assignments: [QUIZ_ROW] });
  assert.equal(item.html_url, 'stale');
});

test('no mining and no Canvas is an empty list, not a crash', () => {
  assert.deepEqual(tasksForClass({ mined: null, assignments: null }), { items: [], source: 'canvas' });
  assert.deepEqual(tasksForClass({}), { items: [], source: 'canvas' });
});

// --- Canvas's verdicts, and what mining may and may not overrule -------------

test("a Canvas row titled 'Project: Final Project Report' must not be scheduled as an exam", () => {
  // /\bfinal\b/ caught three project deliverables across this user's classes —
  // BUSI 374's final report, ENTR 222's final presentation, BUSI 380's
  // cumulative final case — and each would have been given exam-shaped prep at
  // 5 and 1 days instead of a project's 7 and 2. It was masked only because
  // mining had run everywhere and its category won.
  assert.equal(categoryOf({ name: 'Project: Final Project Report' }), 'homework');
  assert.equal(categoryOf({ name: 'Final Presentation' }), 'homework');
  assert.equal(categoryOf({ name: 'Cumulative Final Case (Individual) Upload to Canvas' }), 'homework');
});

test('a bare "Final" is still an exam, and so is a midterm', () => {
  assert.equal(categoryOf({ name: 'Final' }), 'exam');
  assert.equal(categoryOf({ name: 'Final Exam' }), 'exam');
  assert.equal(categoryOf({ name: 'Midterm Case Assignment-Group Assignment' }), 'exam');
  assert.equal(categoryOf({ name: 'Exam 2' }), 'exam');
});

test('a reading quiz is a quiz — a graded submission must not be filed under Readings', () => {
  // Order matters here: a student who switches Readings off is hiding optional
  // prep, not a graded quiz.
  assert.equal(categoryOf({ name: 'Reading Quiz 3' }), 'homework');
  assert.equal(categoryOf({ name: 'Chapter 5 Quiz' }), 'homework');
  assert.equal(categoryOf({ name: 'Read Chapter 4 before class' }), 'reading');
});

test('a mined item that claims a Canvas row carries Canvas’s own category verdict', () => {
  const mined = { items: [{ id: 'm1', title: 'Midterm Case (Group)', canvas_assignment_id: 532700, category: 'project' }] };
  const [it] = tasksForClass({ mined, assignments: [PAPER_ROW] }).items;
  assert.equal(it.category, 'project', 'mining still owns the description of the work');
  assert.equal(it.canvas_category, 'exam', 'and Canvas still gets to say it is an assessment');
});

test('a mined due date must not override the Canvas deadline it claims', () => {
  // ENTR 222's "Choose Group Product" is listed under the 9/10 session in the
  // syllabus and closes 2026-09-08 on Canvas. The mined date won unconditionally
  // and put the event two days after the real deadline.
  const canvasDate = (() => { const d = new Date(PAPER_ROW.due_at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const mined = { items: [{ id: 'm1', title: 'Choose Group Product', canvas_assignment_id: 532700, due_date: '2026-09-10', due_time: '11:00', description: 'Email your team.' }] };
  const [it] = tasksForClass({ mined, assignments: [PAPER_ROW] }).items;
  assert.equal(it.due_date, canvasDate);
  assert.equal(it.due_confidence, 'high');
  assert.match(it.description, /Syllabus says 2026-09-10; Canvas says .* — Canvas wins\./,
    'the disagreement is information, not something to discard');
});

test('a recurring mined item must not swallow the dated Canvas assignment it claims', () => {
  // BUSI 380's re-mine folded its concept checks into one item flagged
  // `recurring: "before each class"` that still carried Canvas id 532620 — a
  // real, dated, 100-point assignment. Recurring items become notes, never ops,
  // so claiming that id deleted a graded deadline from the calendar outright.
  const mined = { items: [{ id: 'concept-check-quizzes-weekly', title: 'Weekly Concept Check Quizzes (Pre-Class)', canvas_assignment_id: 532620, category: 'quiz', due_date: null, recurring: 'before each class' }] };
  const { items } = tasksForClass({ mined, assignments: [QUIZ_ROW] });
  assert.equal(items.length, 2, 'the recurrence keeps its note; the Canvas row keeps its date');
  assert.equal(items[0].recurring, 'before each class');
  assert.equal(items[1].canvas_assignment_id, 532620);
  assert.ok(items[1].due_date, 'and it is still dated');
});

test('an aggregate mined item must not double-book work Canvas already schedules individually', () => {
  // "S2a Concept Check Quizzes (7 items)" can only name one of its seven Canvas
  // ids, so the other six fell through and each became its own event beside the
  // aggregate — 7 events for 7 quizzes, one of which said it covered all 7, and
  // 1300 points displayed for 700 points of work.
  const mined = { items: [{ id: 's2a', title: 'S2a Concept Check Quizzes (7 items)', canvas_assignment_id: 532620, category: 'quiz', points_possible: 700 }] };
  const { items } = tasksForClass({ mined, assignments: [QUIZ_ROW, PAPER_ROW] });
  assert.deepEqual(items.map(i => i.canvas_assignment_id), [532620, 532700],
    'Canvas holds the constituents dated, so it wins outright');
  assert.equal(items.some(i => i.id === 's2a'), false);
});

test('an aggregate survives when Canvas has nothing dated to show for it', () => {
  const mined = { items: [{ id: 's2a', title: 'S2a Concept Check Quizzes (7 items)', canvas_assignment_id: 532620, category: 'quiz' }] };
  const { items } = tasksForClass({ mined, assignments: [UNDATED_ROW] });
  assert.equal(items[0].id, 's2a', 'a summary beats nothing at all');
});

test('canvas_assignment_ids absorbs every row the aggregate covers, not just the first', () => {
  const mined = { items: [{ id: 's2a', title: 'S2a Concept Checks', canvas_assignment_ids: [532620, 532700], category: 'quiz', due_date: '2026-09-01' }] };
  const { items } = tasksForClass({ mined, assignments: [QUIZ_ROW, PAPER_ROW] });
  assert.equal(items.length, 1, 'both rows are spoken for');
  assert.equal(items[0].id, 's2a');
});

// --- provenance ------------------------------------------------------------
// The user's words: "AI added tasks/assignments [should] look different from
// actual ones so I dont stress trying to figure out what to do/submit for an
// assignment that isnt actually a submitted assignment." `origin` is the one
// field every consumer trusts for that distinction.

test('origin: a live Canvas row behind an item makes it canvas; a syllabus find is syllabus', () => {
  const mined = { items: [
    { id: 'quiz-claimed', title: 'S9-Concept Check: Product Line Depth', canvas_assignment_id: 532620, category: 'homework' },
    { id: 'exam-1', title: 'Exam 1', kind: 'implicit', category: 'exam', due_date: '2026-10-07' },
  ] };
  const { items } = tasksForClass({ mined, assignments: [QUIZ_ROW, PAPER_ROW] });
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  assert.equal(byId['quiz-claimed'].origin, 'canvas', 'mined description, Canvas row — the row wins the label');
  assert.equal(byId['exam-1'].origin, 'syllabus', 'mined only — nothing on Canvas to open or submit');
  assert.equal(byId['canvas-532700'].origin, 'canvas', 'an unclaimed Canvas extra is Canvas by construction');
});

test('origin: a mined claim on a Canvas row that no longer exists is syllabus, not canvas', () => {
  // The row was deleted (or assignments.json is missing): whatever link mining
  // stored is unverifiable, so the item must not present as submittable.
  const mined = { items: [{ id: 'ghost', title: 'Deleted thing', canvas_assignment_id: 999999, due_date: '2026-10-01' }] };
  const { items } = tasksForClass({ mined, assignments: [] });
  assert.equal(items[0].origin, 'syllabus');
  assert.equal(items[0].submit_url, null);
});

test('a stale FIRST covered id does not swallow the live rows behind it', () => {
  // ids[0] points at a deleted row while ids[1] is live and dated. Resolving
  // by ids[0] alone flipped the whole item to syllabus with its mined date and
  // the claim swallowed the live row — a graded Canvas deadline vanished.
  const mined = { items: [{
    id: 's2a', title: 'S2a Concept Checks',
    canvas_assignment_ids: [999999, 532700], category: 'quiz', due_date: '2026-09-01',
  }] };
  const { items } = tasksForClass({ mined, assignments: [PAPER_ROW] });
  assert.equal(items.length, 1, 'the live row is spoken for, not duplicated');
  assert.equal(items[0].id, 's2a');
  assert.equal(items[0].origin, 'canvas', 'a live row stands behind the item');
  assert.equal(items[0].due_date, '2026-03-19', 'Canvas date wins over the mined 2026-09-01');
  assert.ok(items[0].submit_url, 'the live row supplies the Submit URL');
});

test('a deleted-and-recreated assignment resolves by title to the live row', () => {
  // The instructor deleted the row mining claimed and re-created it under the
  // same name with a new id. The mined item must merge with the live row —
  // not ship as a link-less AI-added ghost carrying the mined date while the
  // real deadline and Submit URL are suppressed by its title claim.
  const mined = { items: [{
    id: 'ghost', title: 'Midterm Case Assignment', canvas_assignment_id: 999999,
    due_date: '2026-10-01',
  }] };
  const { items } = tasksForClass({ mined, assignments: [PAPER_ROW] });
  assert.equal(items.length, 1, 'one item — merged, not a ghost beside a row');
  assert.equal(items[0].id, 'ghost', 'mining keeps the item identity');
  assert.equal(items[0].canvas_assignment_id, 532700, 'but points at the LIVE row');
  assert.equal(items[0].origin, 'canvas');
  assert.equal(items[0].due_date, '2026-03-19', 'the recreated row keeps the real deadline');
  assert.ok(items[0].submit_url, 'and the real Submit URL');
});

test('two distinct same-named Canvas rows both survive a mined claim', () => {
  // The union used to hold a title-wide claim set: one mined item touching
  // "Weekly Reflection" suppressed EVERY dated row with that name, and a
  // second, genuinely separate deadline vanished. Claims are per-row now.
  const twins = [
    { id: 801, name: 'Weekly Reflection', due_at: '2026-09-01T04:59:00Z', submission_types: ['online_upload'], html_url: 'https://canvas.rice.edu/courses/93903/assignments/801' },
    { id: 802, name: 'Weekly Reflection', due_at: '2026-09-15T04:59:00Z', submission_types: ['online_upload'], html_url: 'https://canvas.rice.edu/courses/93903/assignments/802' },
  ];
  const mined = { items: [{ id: 'wr', title: 'Weekly Reflection', canvas_assignment_id: 999999, due_date: '2026-09-03' }] };
  const { items } = tasksForClass({ mined, assignments: twins });
  assert.equal(items.length, 2, 'one merged item + the sibling as an extra');
  const dates = items.map(i => i.due_date).sort();
  assert.deepEqual(dates, ['2026-08-31', '2026-09-14'], 'BOTH Canvas deadlines present, both Canvas-owned');
});

test('a recurring item resolved by title must not swallow the dated row it reached', () => {
  // Stale id + re-created dated row sharing the title: the recurrence keeps
  // its note, the Canvas row keeps its date — same rule as the id-claimed
  // recurring case, through the title door.
  const mined = { items: [{
    id: 'cc', title: 'Concept Check', canvas_assignment_id: 999999,
    recurring: 'before each class',
  }] };
  const row = { id: 101, name: 'Concept Check', due_at: '2026-10-01T04:59:00Z', points_possible: 100, submission_types: ['online_quiz'], html_url: 'https://canvas.rice.edu/courses/93903/assignments/101' };
  const { items } = tasksForClass({ mined, assignments: [row] });
  assert.equal(items.length, 2, 'the recurring note AND the dated Canvas row');
  const dated = items.find(i => i.due_date);
  assert.equal(String(dated.canvas_assignment_id), '101');
  assert.equal(dated.origin, 'canvas');
  assert.ok(dated.submit_url, 'the graded deadline keeps its Submit URL');
});

test('deterministic readings are a union member even when mining found none', () => {
  const readings = { items: [{
    id: 'reading-2026-09-01-customers', title: 'Read for Customer strategy',
    category: 'reading', due_date: '2026-09-01', recurring: null,
    description: 'Read Chapter 3.', origin: 'syllabus', indexed: true,
  }] };
  const { items, source } = tasksForClass({ mined: { items: [] }, readings, assignments: [] });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'reading-2026-09-01-customers');
  assert.equal(items[0].origin, 'syllabus');
  assert.equal(source, 'mined');
});

test('model and index copies of the same dated reading merge without losing index detail', () => {
  const mined = { items: [{
    id: 'week-two-reading', title: 'Week 2 reading', category: 'reading',
    due_date: '2026-09-01', recurring: 'before each class',
    description: 'Read Chapter 3.',
    related_materials: [{ file: 'Chapter 3.pdf', why: 'assigned chapter' }],
  }] };
  const readings = { items: [{
    id: 'reading-2026-09-01-customers', title: 'Read for Customer strategy',
    category: 'reading', due_date: '2026-09-01', recurring: null,
    description: 'Read Chapter 3 and both channel-strategy articles.',
    sources: [{ type: 'syllabus', ref: 'schedule 2026-09-01' }],
    related_materials: [{ file: 'Syllabus.pdf', why: 'lists the reading' }],
    origin: 'syllabus', indexed: true,
  }] };
  const { items } = tasksForClass({ mined, readings, assignments: [] });
  assert.equal(items.length, 1, 'one dated reading, not model + index duplicates');
  assert.equal(items[0].id, 'week-two-reading', 'existing user-state identity survives');
  assert.equal(items[0].recurring, null, 'explicit occurrence is not discarded as an undated recurrence');
  assert.match(items[0].description, /both channel-strategy articles/);
  assert.deepEqual(items[0].related_materials.map(m => m.file), ['Chapter 3.pdf', 'Syllabus.pdf']);
});
