// meeting-times.test.js — recovering the class time the syllabus field missed.
//
// The fixtures are real. BUSI_380_SYLLABUS is copied verbatim out of
// ~/canvas-sync-data/classes/93903-busi-380-002/materials/, and it is the whole
// reason this module exists: it names the days and never states a time, while
// naming a weekday AND a time range two paragraphs later for office hours. A
// recovery layer that reads the second one as the class time is worse than no
// recovery layer at all, so most of what follows is about NOT finding a time.
//
// The other rule under test is precedence: override, then the syllabus, then
// Canvas, then — only when asked — a guess from due dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWeeklyPatterns } from '../cal-meetings.js';
import {
  readMeetingOverride, writeMeetingOverride, clearMeetingOverride,
  readMeetingRevert, revertMeetingOverride, describeRevertTarget,
  recoverMeetingTimes, describeMeetingSource, OVERRIDE_FILE, PREVIOUS_FILE,
} from '../meeting-times.js';

// Verbatim from "Marketing 380  Syllabus (Fall 2026) Aug 11.pdf.txt", lines
// 1-18, wrapping and all.
const BUSI_380_SYLLABUS = `8.11.2026
  Marketing (BUSI 380) Fall 2026
Professor:   Constance Porter, Office Location: 228 McNair Hall
Email: constanceporter@rice.edu

Faculty Support Specialist:  Katrena Friedman
Email: Katrena.B.Friedman@rice.edu   telephone: (713) 348-3423

Class Session Time
The sessions will start and end at the time scheduled and communicated by the Rice Business registrar on
Tuesdays and Thursdays. See the Canvas website for details on the class dates, time and room location.

Office Hours
Professor Porter's in-person office hours are on Tuesdays, 4:15-5:15PM and she is flexible to meet on
other days as needed, by appointment, at a mutually convenient time, on Zoom or in person. Professor
Porter will not be able to give you proper attention immediately before or after our class sessions, if you
want to discuss complex topics, grades on assignments etc. So, please schedule time with Professor Porter
so that your meeting will be most productive.
`;

// The shape cal-meetings' own docstring uses, and the one a lecture-plus-lab
// syllabus states in its body rather than in the meeting_schedule field.
const LECTURE_AND_LAB_SYLLABUS = `Instructor: Dr. Example
Office Hours: Tuesdays, 4:15-5:15PM in McNair 228

Class Meeting Times
Lectures MW 8:00-9:15 in McNair Hall 314; Labs Wednesday afternoons 12:00-12:50 MCN 317

Homework is due Fridays at 11:59 PM.
`;

async function seedClass({ parsed, syllabusText, syllabusHtml, events, pages, announcements, assignments, override } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-times-'));
  if (parsed !== undefined) await writeFile(join(dir, 'syllabus_parsed.json'), JSON.stringify(parsed));
  if (syllabusText !== undefined) {
    await mkdir(join(dir, 'materials'), { recursive: true });
    await writeFile(join(dir, 'materials', 'Course Syllabus.pdf.txt'), syllabusText);
  }
  if (syllabusHtml !== undefined) await writeFile(join(dir, 'syllabus.html'), syllabusHtml);
  if (events !== undefined) await writeFile(join(dir, 'calendar_events.json'), JSON.stringify(events));
  if (pages !== undefined) await writeFile(join(dir, 'pages.json'), JSON.stringify(pages));
  if (announcements !== undefined) await writeFile(join(dir, 'announcements.json'), JSON.stringify(announcements));
  if (assignments !== undefined) await writeFile(join(dir, 'assignments.json'), JSON.stringify(assignments));
  if (override !== undefined) await writeFile(join(dir, OVERRIDE_FILE), typeof override === 'string' ? override : JSON.stringify(override));
  return dir;
}

// Canvas timestamps are UTC but cal-meetings renders them in the local zone,
// the same zone the calendar is written in. Build fixtures from local wall-clock
// times so the assertions hold wherever the tests run.
function localIso(y, monthIndex, day, hour, minute) {
  return new Date(y, monthIndex, day, hour, minute).toISOString();
}

function slot(p) {
  return `${p.label} ${p.byday.join('')} ${p.start}-${p.end} @ ${p.location}`;
}

// --- The real BUSI 380 case -------------------------------------------------

test('BUSI 380: the days survive, the time stays null, and nothing is invented', async () => {
  const dir = await seedClass({
    parsed: { course: { code: 'BUSI 380', meeting_schedule: 'Tuesdays and Thursdays' } },
    syllabusText: BUSI_380_SYLLABUS,
    syllabusHtml: '<p><a href="https://canvas.rice.edu/courses/93903/files/7692307">Marketing 380 Syllabus.pdf</a></p>',
    events: [],
  });
  const res = await recoverMeetingTimes(dir);

  assert.equal(res.source, 'syllabus-field');
  assert.equal(res.confidence, 'low');
  assert.equal(res.patterns.length, 1);
  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  assert.equal(res.patterns[0].start, null);
  assert.equal(res.patterns[0].end, null);
  assert.match(res.warnings.join(' '), /never states a time/);
  await rm(dir, { recursive: true, force: true });
});

test("BUSI 380: the professor's office hours are not read as the class time", async () => {
  // "office hours are on Tuesdays, 4:15-5:15PM" parses cleanly as a weekly
  // pattern. It is the single most dangerous string in the file.
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    syllabusText: BUSI_380_SYLLABUS,
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.patterns.every(p => p.start === null), true);
  assert.equal(describeMeetingSource(res), 'Days only (TuTh) — no time in the syllabus or in Canvas. Set it yourself.');
  await rm(dir, { recursive: true, force: true });
});

test('BUSI 380: the days are still recovered when the field itself is missing', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    syllabusText: BUSI_380_SYLLABUS,
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-text');
  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  assert.equal(res.patterns[0].start, null);
  await rm(dir, { recursive: true, force: true });
});

// --- Tier 1: the user's override -------------------------------------------

test('an override is read back as the user typed it', async () => {
  const dir = await seedClass({});
  await writeMeetingOverride(dir, {
    days: ['TU', 'TH'], start: '13:00', end: '14:15', location: 'Sewall 301', note: 'registrar email',
  });
  const stored = await readMeetingOverride(dir);
  assert.deepEqual(stored.days, ['TU', 'TH']);
  assert.equal(stored.start, '13:00');
  assert.equal(stored.end, '14:15');
  assert.equal(stored.location, 'Sewall 301');
  assert.match(stored.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  await rm(dir, { recursive: true, force: true });
});

test('the override outranks a syllabus field that already has a time', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'MW 8:00-9:15 in McNair Hall 314' } },
    override: { days: ['TU', 'TH'], start: '13:00', end: '14:15', location: 'Sewall 301' },
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'override');
  assert.equal(res.confidence, 'high');
  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  assert.equal(res.patterns[0].start, '13:00');
  assert.equal(describeMeetingSource(res), 'From your override — TuTh 1:00-2:15 PM, Sewall 301');
  await rm(dir, { recursive: true, force: true });
});

test('a corrupt override reads as no override, not as garbage times', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'MW 8:00-9:15 in McNair Hall 314' } },
    override: '{ days: [TU, TH], start: 1pm',
  });
  assert.equal(await readMeetingOverride(dir), null);

  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-field');
  assert.deepEqual(res.patterns[0].byday, ['MO', 'WE']);
  assert.match(res.warnings.join(' '), /not valid JSON/);
  await rm(dir, { recursive: true, force: true });
});

test('an override with unreadable days is ignored entirely', async () => {
  const dir = await seedClass({ override: { days: ['TBD'], start: '13:00', end: '14:15' } });
  assert.equal(await readMeetingOverride(dir), null);
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'none');
  assert.match(res.warnings.join(' '), /no readable days/);
  await rm(dir, { recursive: true, force: true });
});

test('an override with unreadable times keeps the days and drops the times', async () => {
  const dir = await seedClass({ override: { days: ['TU', 'TH'], start: '1pm', end: 'half two' } });
  const stored = await readMeetingOverride(dir);
  assert.deepEqual(stored.days, ['TU', 'TH']);
  assert.equal(stored.start, null);
  assert.equal(stored.end, null);

  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'override');
  assert.equal(res.confidence, 'low');
  assert.match(res.warnings.join(' '), /HH:MM/);
  assert.equal(describeMeetingSource(res), 'From your override — TuTh, but no time set.');
  await rm(dir, { recursive: true, force: true });
});

test('an end before its start is refused rather than swapped', async () => {
  const dir = await seedClass({ override: { days: ['MO'], start: '14:15', end: '13:00' } });
  const stored = await readMeetingOverride(dir);
  assert.equal(stored.start, null);
  await rm(dir, { recursive: true, force: true });
});

test('writeMeetingOverride refuses what it cannot stand behind', async () => {
  const dir = await seedClass({});
  await assert.rejects(() => writeMeetingOverride(dir, { days: [] }), /days/);
  await assert.rejects(() => writeMeetingOverride(dir, { days: ['TBD'] }), /days/);
  await assert.rejects(
    () => writeMeetingOverride(dir, { days: ['MO'], start: '13:00' }),
    /start and end together/,
  );
  await assert.rejects(
    () => writeMeetingOverride(dir, { days: ['MO'], start: '25:00', end: '26:00' }),
    /HH:MM/,
  );
  assert.equal(await readMeetingOverride(dir), null);
  await rm(dir, { recursive: true, force: true });
});

test('writeMeetingOverride does not invent the class directory', async () => {
  // A typo in the class id would otherwise leave a phantom class holding
  // nothing but the time the user typed, where no sync and no dashboard will
  // ever look at it again.
  const base = await mkdtemp(join(tmpdir(), 'meeting-times-'));
  const phantom = join(base, '99999-no-such-course');
  await assert.rejects(
    () => writeMeetingOverride(phantom, { days: ['MO'], start: '09:00', end: '10:15' }),
    /no class directory/,
  );
  await assert.rejects(() => stat(phantom), { code: 'ENOENT' });
  await rm(base, { recursive: true, force: true });
});

test('recoverMeetingTimes survives a null options argument', async () => {
  const dir = await seedClass({ parsed: { course: { meeting_schedule: 'MW 8:00-9:15' } } });
  const res = await recoverMeetingTimes(dir, null);
  assert.deepEqual(res.patterns[0].byday, ['MO', 'WE']);
  await rm(dir, { recursive: true, force: true });
});

test('writeMeetingOverride patches, and an explicit null clears a field', async () => {
  const dir = await seedClass({});
  await writeMeetingOverride(dir, { days: ['TU', 'TH'], start: '13:00', end: '14:15', location: 'Sewall 301' });
  await writeMeetingOverride(dir, { location: 'Herring 100' });
  let stored = await readMeetingOverride(dir);
  assert.equal(stored.location, 'Herring 100');
  assert.equal(stored.start, '13:00');

  await writeMeetingOverride(dir, { start: null, end: null });
  stored = await readMeetingOverride(dir);
  assert.equal(stored.start, null);
  assert.deepEqual(stored.days, ['TU', 'TH']);

  // Written as real JSON, not as a stringified blob.
  const onDisk = JSON.parse(await readFile(join(dir, OVERRIDE_FILE), 'utf8'));
  assert.deepEqual(onDisk.days, ['TU', 'TH']);
  await rm(dir, { recursive: true, force: true });
});

test('clearMeetingOverride removes the file once and then says so', async () => {
  const dir = await seedClass({});
  await writeMeetingOverride(dir, { days: ['FR'] });
  assert.equal(await clearMeetingOverride(dir), true);
  assert.equal(await clearMeetingOverride(dir), false);
  assert.equal(await readMeetingOverride(dir), null);
  await rm(dir, { recursive: true, force: true });
});

// --- Revert: the escape hatch for a time typed wrong ------------------------

test('a mis-typed change reverts to the earlier override, and reverting again is redo', async () => {
  const dir = await seedClass({});
  await writeMeetingOverride(dir, { days: ['TU', 'TH'], start: '13:00', end: '14:15' });
  await writeMeetingOverride(dir, { days: ['MO'], start: '09:00', end: '09:50' });

  const stash = await readMeetingRevert(dir);
  assert.deepEqual(stash.previous.days, ['TU', 'TH']);
  assert.equal(describeRevertTarget(stash), 'undo — back to TuTh 1:00-2:15 PM');

  assert.ok(await revertMeetingOverride(dir));
  let stored = await readMeetingOverride(dir);
  assert.deepEqual(stored.days, ['TU', 'TH']);
  assert.equal(stored.start, '13:00');

  // The revert swapped states, so a second revert restores the Monday time.
  assert.ok(await revertMeetingOverride(dir));
  stored = await readMeetingOverride(dir);
  assert.deepEqual(stored.days, ['MO']);
  await rm(dir, { recursive: true, force: true });
});

test('the first save reverts to no override at all, and the chain answers again', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'TR, 10:50 am - 12:05 pm' } },
  });
  await writeMeetingOverride(dir, { days: ['FR'], start: '08:00', end: '08:50' });
  assert.equal((await recoverMeetingTimes(dir)).source, 'override');

  const stash = await readMeetingRevert(dir);
  assert.equal(stash.previous, null);
  assert.equal(describeRevertTarget(stash), 'undo — back to the syllabus');

  assert.ok(await revertMeetingOverride(dir));
  assert.equal(await readMeetingOverride(dir), null);
  assert.equal((await recoverMeetingTimes(dir)).source, 'syllabus-field');
  await rm(dir, { recursive: true, force: true });
});

test('a cleared override comes back with revert, original updatedAt and all', async () => {
  const dir = await seedClass({});
  await writeMeetingOverride(dir, { days: ['WE'], start: '15:00', end: '16:15', location: 'Sewall 301' });
  const before = await readMeetingOverride(dir);
  await clearMeetingOverride(dir);
  assert.equal(await readMeetingOverride(dir), null);

  assert.ok(await revertMeetingOverride(dir));
  const restored = await readMeetingOverride(dir);
  assert.deepEqual(restored, before);
  await rm(dir, { recursive: true, force: true });
});

test('nothing to revert to means revert says so and touches nothing', async () => {
  const dir = await seedClass({ override: { days: ['MO'], start: '09:00', end: '09:50' } });
  assert.equal(await readMeetingRevert(dir), null);
  assert.equal(await revertMeetingOverride(dir), null);
  assert.deepEqual((await readMeetingOverride(dir)).days, ['MO']);
  assert.equal(describeRevertTarget(null), null);
  await rm(dir, { recursive: true, force: true });
});

test('a stash that cannot be trusted offers no revert', async () => {
  for (const bad of ['not json{', JSON.stringify({ version: 1 }), JSON.stringify({ previous: { days: ['TBD'] } })]) {
    const dir = await seedClass({ override: { days: ['MO'], start: '09:00', end: '09:50' } });
    await writeFile(join(dir, PREVIOUS_FILE), bad);
    assert.equal(await readMeetingRevert(dir), null, `stash ${bad} should be unusable`);
    assert.equal(await revertMeetingOverride(dir), null);
    // The override the stash knows nothing about is left alone.
    assert.deepEqual((await readMeetingOverride(dir)).days, ['MO']);
    await rm(dir, { recursive: true, force: true });
  }
});

test('saving the same values again does not eat the revert target', async () => {
  const dir = await seedClass({});
  await writeMeetingOverride(dir, { days: ['TU', 'TH'], start: '13:00', end: '14:15' });
  await writeMeetingOverride(dir, { days: ['MO'], start: '09:00', end: '09:50' });
  // A second identical Save — a double-click, a nervous re-submit.
  await writeMeetingOverride(dir, { days: ['MO'], start: '09:00', end: '09:50' });

  const stash = await readMeetingRevert(dir);
  assert.deepEqual(stash.previous.days, ['TU', 'TH'], 'undo must still reach the Tuesday time');
  await rm(dir, { recursive: true, force: true });
});

test('a days-only previous is labelled as such', async () => {
  const dir = await seedClass({});
  await writeMeetingOverride(dir, { days: ['TU', 'TH'] });
  await writeMeetingOverride(dir, { days: ['MO'], start: '09:00', end: '09:50' });
  assert.equal(describeRevertTarget(await readMeetingRevert(dir)), 'undo — back to TuTh (days only)');
  await rm(dir, { recursive: true, force: true });
});

// --- Tier 2: the syllabus ---------------------------------------------------

test('a syllabus field that states a time is used as-is', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'TR, 10:50 am - 12:05 pm' } },
    syllabusText: LECTURE_AND_LAB_SYLLABUS,
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-field');
  assert.equal(res.confidence, 'high');
  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  assert.equal(res.patterns[0].start, '10:50');
  await rm(dir, { recursive: true, force: true });
});

test('a slash-separated day code keeps both days', async () => {
  // BUSI 374's real field. The compact matcher stops at the slash on its own,
  // which silently halves the week.
  const dir = await seedClass({ parsed: { course: { meeting_schedule: 'M/W 2:30-3:45pm' } } });
  const res = await recoverMeetingTimes(dir);
  assert.deepEqual(res.patterns[0].byday, ['MO', 'WE']);
  assert.equal(res.patterns[0].start, '14:30');
  assert.equal(res.patterns[0].end, '15:45');
  await rm(dir, { recursive: true, force: true });
});

test('the syllabus TEXT supplies the time the field never had', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    syllabusText: LECTURE_AND_LAB_SYLLABUS,
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-text');
  assert.equal(res.confidence, 'medium');
  assert.deepEqual(res.patterns.map(slot), [
    'Lecture MOWE 08:00-09:15 @ McNair Hall 314',
    'Lab WE 12:00-12:50 @ MCN 317',
  ]);
  await rm(dir, { recursive: true, force: true });
});

test('a homework deadline in the syllabus text is not a class time', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    syllabusText: 'Grading\nProblem sets are due Wednesday 11:00-11:59 PM in class.\n',
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'none');
  await rm(dir, { recursive: true, force: true });
});

test('an all-day span is not a class', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    syllabusText: 'The lab is staffed Monday 9:00 AM - 5:00 PM.\n',
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'none');
  await rm(dir, { recursive: true, force: true });
});

test('the Canvas syllabus box counts as syllabus text', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    syllabusHtml: '<h2>Class meets</h2><p>Lecture TuTh 1:00-2:15 PM in Sewall 301</p>',
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-text');
  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  assert.equal(res.patterns[0].start, '13:00');
  assert.equal(res.patterns[0].location, 'Sewall 301');
  await rm(dir, { recursive: true, force: true });
});

// --- Tier 3: Canvas ---------------------------------------------------------

test("Canvas's own course events become a weekly pattern", async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    syllabusText: BUSI_380_SYLLABUS,
    events: [
      { id: 1, title: 'BUSI 380', start_at: localIso(2026, 8, 1, 13, 0), end_at: localIso(2026, 8, 1, 14, 15), location_name: 'Sewall 301' },
      { id: 2, title: 'BUSI 380', start_at: localIso(2026, 8, 3, 13, 0), end_at: localIso(2026, 8, 3, 14, 15), location_name: 'Sewall 301' },
      { id: 3, title: 'BUSI 380', start_at: localIso(2026, 8, 8, 13, 0), end_at: localIso(2026, 8, 8, 14, 15), location_name: 'Sewall 301' },
    ],
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'canvas');
  assert.equal(res.confidence, 'medium');
  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  assert.equal(res.patterns[0].start, '13:00');
  assert.equal(res.patterns[0].end, '14:15');
  assert.equal(res.patterns[0].location, 'Sewall 301');
  await rm(dir, { recursive: true, force: true });
});

test('one Canvas event is a date, not a weekly pattern', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    events: [
      { id: 1, title: 'Guest speaker', start_at: localIso(2026, 8, 1, 13, 0), end_at: localIso(2026, 8, 1, 14, 15) },
    ],
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-field');
  assert.equal(res.patterns[0].start, null);
  await rm(dir, { recursive: true, force: true });
});

test('an announcement stating the class time is used when nothing else has one', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    events: [],
    pages: [{ message: 'That page has been disabled for this course' }],
    announcements: [
      { title: 'Welcome', message: '<p>Our section meets TuTh 1:00-2:15 PM in <b>Sewall 301</b>.</p>' },
    ],
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'canvas');
  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  assert.equal(res.patterns[0].start, '13:00');
  assert.equal(res.patterns[0].location, 'Sewall 301');
  await rm(dir, { recursive: true, force: true });
});

test('the syllabus text outranks Canvas bodies', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    syllabusText: LECTURE_AND_LAB_SYLLABUS,
    announcements: [{ title: 'Welcome', message: 'Class meets TuTh 1:00-2:15 PM in Sewall 301.' }],
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-text');
  assert.equal(res.patterns[0].start, '08:00');
  await rm(dir, { recursive: true, force: true });
});

test("Canvas's disabled-pages stub is not mistaken for a page list", async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    events: [],
    pages: [{ message: 'That page has been disabled for this course' }],
    announcements: [],
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-field');
  assert.equal(res.patterns[0].start, null);
  await rm(dir, { recursive: true, force: true });
});

// --- Tier 4: the assignment-due guess --------------------------------------

const BUSI_380_DUE_TIMES = [
  ...Array.from({ length: 8 }, (_, i) => localIso(2026, 8, 1 + i * 7, 14, 30)),   // Tuesdays
  ...Array.from({ length: 4 }, (_, i) => localIso(2026, 8, 3 + i * 7, 14, 30)),   // Thursdays
  localIso(2026, 8, 2, 9, 0),
].map(due_at => ({ due_at }));

test('the due-date guess stays off unless it is asked for', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    assignments: BUSI_380_DUE_TIMES,
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-field');
  assert.equal(res.patterns[0].start, null);
  await rm(dir, { recursive: true, force: true });
});

test('the due-date guess is low confidence, has no end, and says it is a guess', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    assignments: BUSI_380_DUE_TIMES,
  });
  const res = await recoverMeetingTimes(dir, { inferFromDueDates: true });
  assert.equal(res.source, 'inferred');
  assert.equal(res.confidence, 'low');
  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  assert.equal(res.patterns[0].start, '14:30');
  assert.equal(res.patterns[0].end, null);
  assert.match(res.warnings.join(' '), /guess/);
  assert.match(describeMeetingSource(res), /^Guessed from when work is due — TuTh, starts 2:30 PM\. Check it\./);
  await rm(dir, { recursive: true, force: true });
});

test('the due-date guess never adds a day the syllabus does not have', async () => {
  const dir = await seedClass({
    // The syllabus says TuTh; a Friday deadline must not put class on Friday.
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    assignments: [
      ...BUSI_380_DUE_TIMES,
      { due_at: localIso(2026, 8, 4, 14, 30) },
      { due_at: localIso(2026, 8, 11, 14, 30) },
    ],
  });
  const res = await recoverMeetingTimes(dir, { inferFromDueDates: true });
  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  await rm(dir, { recursive: true, force: true });
});

test('scattered due times are not a pattern', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    assignments: [
      { due_at: localIso(2026, 8, 1, 14, 30) },
      { due_at: localIso(2026, 8, 3, 9, 0) },
      { due_at: localIso(2026, 8, 8, 23, 59) },
      { due_at: localIso(2026, 8, 10, 17, 45) },
      { due_at: null },
    ],
  });
  const res = await recoverMeetingTimes(dir, { inferFromDueDates: true });
  assert.equal(res.source, 'syllabus-field');
  assert.equal(res.patterns[0].start, null);
  await rm(dir, { recursive: true, force: true });
});

test('the override still outranks the due-date guess', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    assignments: BUSI_380_DUE_TIMES,
    override: { days: ['TU', 'TH'], start: '13:00', end: '14:15' },
  });
  const res = await recoverMeetingTimes(dir, { inferFromDueDates: true });
  assert.equal(res.source, 'override');
  assert.equal(res.patterns[0].start, '13:00');
  await rm(dir, { recursive: true, force: true });
});

// --- Contract ---------------------------------------------------------------

test('recovered patterns are shaped exactly like parseWeeklyPatterns output', async () => {
  const reference = parseWeeklyPatterns('Lectures MW 8:00-9:15 in McNair Hall 314')[0];
  const expected = Object.keys(reference).sort();

  const dirs = await Promise.all([
    seedClass({ override: { days: ['TU', 'TH'], start: '13:00', end: '14:15', location: 'Sewall 301' } }),
    seedClass({ parsed: { course: { meeting_schedule: 'MW 8:00-9:15 in McNair Hall 314' } } }),
    seedClass({ parsed: { course: { meeting_schedule: null } }, syllabusText: LECTURE_AND_LAB_SYLLABUS }),
    seedClass({
      parsed: { course: { meeting_schedule: null } },
      events: [
        { id: 1, start_at: localIso(2026, 8, 1, 13, 0), end_at: localIso(2026, 8, 1, 14, 15) },
        { id: 2, start_at: localIso(2026, 8, 3, 13, 0), end_at: localIso(2026, 8, 3, 14, 15) },
      ],
    }),
    seedClass({ parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } }, assignments: BUSI_380_DUE_TIMES }),
  ]);
  const results = await Promise.all(dirs.map(d => recoverMeetingTimes(d, { inferFromDueDates: true })));

  assert.deepEqual(results.map(r => r.source),
    ['override', 'syllabus-field', 'syllabus-text', 'canvas', 'inferred']);
  for (const res of results) {
    for (const p of res.patterns) {
      assert.deepEqual(Object.keys(p).sort(), expected);
      assert.equal(typeof p.label, 'string');
      assert.equal(Array.isArray(p.byday), true);
      assert.equal(p.byday.length > 0, true);
      assert.equal(p.start === null || /^\d{2}:\d{2}$/.test(p.start), true);
      assert.equal(p.end === null || /^\d{2}:\d{2}$/.test(p.end), true);
      assert.equal(typeof p.source, 'string');
    }
  }
  await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })));
});

test('a class with nothing on disk says so instead of guessing', async () => {
  const dir = await seedClass({});
  const res = await recoverMeetingTimes(dir, { inferFromDueDates: true });
  assert.equal(res.source, 'none');
  assert.equal(res.confidence, 'low');
  assert.deepEqual(res.patterns, []);
  // Every tier was opened and every tier was empty, and the result says both:
  // which ones were tried, and that the user is the only one left who can
  // answer. "Nothing found" and "never looked" used to be the same object.
  assert.deepEqual(res.searched, ['override', 'syllabus-field', 'syllabus-text', 'canvas', 'inferred']);
  assert.equal(res.needs_override, true);
  assert.equal(describeMeetingSource(res), 'No class days or times found — set them yourself.');
  await rm(dir, { recursive: true, force: true });
});

// --- Things that parse as a weekly class and are not one ---------------------
//
// The office-hours trap above is the one this module was written for, but it is
// not the only clause in a syllabus that names a session, a weekday and a
// class-length span. A single dated occurrence uses exactly the same grammar as
// a recurrence, and reading one as the other puts the student in an empty room
// every week for a term — with no blank field anywhere to tell them why.

const ONE_OFF_CLAUSES = [
  ['a review session', 'A review session will be held Thursday 5:00-6:30 PM.'],
  ['a guest lecture', 'A guest lecture on Friday 4:00-5:00 PM is worth attending.'],
  ['a makeup class', 'A makeup class is scheduled for Saturday 9:00-11:00 AM.'],
  ['a drop-in session', 'Drop-in sessions on Zoom are Wednesday 7:00-8:00 PM.'],
  ['an optional workshop', 'An optional workshop meets Monday 6:00-7:30 PM.'],
  ['an exam slot', 'Exam 1 will be given in class on Wednesday 8:00-9:15.'],
  ['a cancelled week', 'Class will not meet Monday 8:00-9:15 that week.'],
  ['the first class', 'The first class meeting is Tuesday 9:00-10:15 in Sewall 301.'],
];

for (const [what, sentence] of ONE_OFF_CLAUSES) {
  test(`a one-off event is not the weekly class time: ${what}`, async () => {
    const dir = await seedClass({
      parsed: { course: { meeting_schedule: null } },
      syllabusText: `Course Information\n\n${sentence}\n`,
    });
    const res = await recoverMeetingTimes(dir);
    assert.equal(res.source, 'none');
    assert.deepEqual(res.patterns, []);
    await rm(dir, { recursive: true, force: true });
  });
}

test('a study group does not donate its days to the class', async () => {
  // The days-only path has no clock to sanity-check, so the clause has to be
  // about class itself. "The optional study session meets Saturdays" satisfies
  // every meets-shaped test and is not class.
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    syllabusText: 'Support\n\nThe optional study session meets Saturdays.\n',
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'none');
  await rm(dir, { recursive: true, force: true });
});

test('a real recurrence still survives all of that filtering', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    syllabusText: 'Class Meeting Times\n\nThis class meets Tuesdays and Thursdays, 1:00-2:15 PM in Sewall 301.\n'
      + '\nA review session will be held Thursday 5:00-6:30 PM before the exam.\n',
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-text');
  assert.deepEqual(res.patterns.map(p => [p.byday, p.start, p.end]), [[['TU', 'TH'], '13:00', '14:15']]);
  await rm(dir, { recursive: true, force: true });
});

// --- The extracted field is not a registrar record --------------------------

test('a meeting_schedule field taken off the wrong line is refused', async () => {
  // parse-syllabus is an LLM extraction. BUSI 396 states no class time anywhere
  // and does state "Office Hours: M/W/F 11:30 - 1:30"; landing that in the
  // field would otherwise produce the most confident answer this module gives.
  for (const field of [
    'Office hours: MW 2:00-3:00',
    'Office Hours: M/W/F 11:30 - 1:30',
    'Final exam Thursday 9:00-12:00',
    'Lab is staffed Monday 9:00 AM - 5:00 PM',
  ]) {
    const dir = await seedClass({ parsed: { course: { meeting_schedule: field } } });
    const res = await recoverMeetingTimes(dir);
    assert.deepEqual(res.patterns, [], field);
    assert.equal(res.source, 'none', field);
    await rm(dir, { recursive: true, force: true });
  }
});

test('an exception note does not disqualify an otherwise good field', async () => {
  // Refusing this would trade a rare wrong answer for a common missing one.
  const dir = await seedClass({ parsed: { course: { meeting_schedule: 'MW 8:00-9:15 (no class Sep 7)' } } });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-field');
  assert.equal(res.confidence, 'high');
  assert.deepEqual(res.patterns[0].byday, ['MO', 'WE']);
  assert.equal(res.patterns[0].start, '08:00');
  await rm(dir, { recursive: true, force: true });
});

test('a field with the right days over an impossible span keeps the days', async () => {
  const dir = await seedClass({ parsed: { course: { meeting_schedule: 'MW 9:00 AM - 5:00 PM' } } });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'syllabus-field');
  assert.equal(res.confidence, 'low');
  assert.deepEqual(res.patterns[0].byday, ['MO', 'WE']);
  assert.equal(res.patterns[0].start, null);
  await rm(dir, { recursive: true, force: true });
});

// --- A day code plus a clock is not a room ----------------------------------

test('the day code and the hour are not reported as the classroom', async () => {
  // "MW 10:00-11:15" is one of the commonest field shapes there is, and the
  // room matcher reads its leading "MW 10" as a room code. Being told to go to
  // room "MW 10" is worse than being told nothing about the room.
  for (const field of ['MW 10:00-11:15', 'TR 10:50-12:05', 'MWF 11:00-11:50']) {
    const dir = await seedClass({ parsed: { course: { meeting_schedule: field } } });
    const res = await recoverMeetingTimes(dir);
    assert.equal(res.patterns[0].location, null, field);
    assert.equal(res.patterns[0].start !== null, true, field);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a room that really is a room is kept', async () => {
  for (const [field, room] of [['MW 10:00-11:15 in MCN 317', 'MCN 317'], ['TuTh 9:00-10:15, SEW 309', 'SEW 309']]) {
    const dir = await seedClass({ parsed: { course: { meeting_schedule: field } } });
    const res = await recoverMeetingTimes(dir);
    assert.equal(res.patterns[0].location, room, field);
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Two sections of one course ---------------------------------------------

test('two meeting times under one label are flagged, not silently merged', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Section 001 MW 8:00-9:15; Section 002 TR 1:00-2:15' } },
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.patterns.length, 2);
  assert.match(res.warnings.join(' '), /check which one is yours/);
  await rm(dir, { recursive: true, force: true });
});

test('a lecture and its lab are not an ambiguity', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    syllabusText: LECTURE_AND_LAB_SYLLABUS,
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.patterns.length, 2);
  assert.deepEqual(res.warnings, []);
  await rm(dir, { recursive: true, force: true });
});

// --- Degrading loudly -------------------------------------------------------

test('the due-date guess needs days from somewhere else first', async () => {
  // BUSI 396's real shape: no meeting time stated anywhere, eighteen
  // assignments due at 09:00 on Mondays, Wednesdays and Fridays. Inferring
  // "MWF 9:00 class" from deadlines alone invents a class nothing claims
  // exists — the deadline is evidence about the deadline.
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    syllabusText: 'Instructor: Matt Smith\n\nOffice Hours: M/W/F 11:30 - 1:30\n',
    assignments: [
      ...Array.from({ length: 4 }, (_, i) => localIso(2026, 8, 7 + i * 7, 9, 0)),
      ...Array.from({ length: 3 }, (_, i) => localIso(2026, 8, 9 + i * 7, 9, 0)),
      ...Array.from({ length: 3 }, (_, i) => localIso(2026, 8, 11 + i * 7, 9, 0)),
    ].map(due_at => ({ due_at })),
  });
  const res = await recoverMeetingTimes(dir, { inferFromDueDates: true });
  assert.equal(res.source, 'none');
  assert.deepEqual(res.patterns, []);
  await rm(dir, { recursive: true, force: true });
});

// --- CALENDAR-SPEC 4.4: no time beats a wrong time --------------------------
//
// Two of the six classes have `meeting_schedule: null` and no time in any other
// source either, so their meetings must land on the calendar as honestly
// time-less: recoverMeetingTimes returns start/end null (or no pattern at all),
// which is what sync-calendar.js:393-397 turns into `all_day: true` /
// `time_known: false`, and the warnings this file produces are what it joins
// into the description that says why (sync-calendar.js:360-364).
//
// The fixtures below are the real classes' real shapes, and the syllabus lines
// are verbatim. Each one contains the single most dangerous string in its own
// file: a weekday and a class-length span that belong to office hours.

// From "syllabus_Busi 305-Fall 2026.pdf.txt", the only clock in the document.
const BUSI_305_SYLLABUS = `Financial Accounting
BUSI 305
Fall 2026                                Office: McNair Hall Room 330
Instructor: Dr. Leila Peyravan                          Phone: 713-348-6140

Office Hours: 2:00-3:00 in person on Friday. Additional office hours are available by appointment

Professor and TA office hours TBD
`;

// From "Fall 2026 BUSI 396 Business Communications Syllabus.docx.txt", where
// the office-hours line is likewise the only clock in the file.
const BUSI_396_SYLLABUS = `Course Title
BUSI 396 001/003 & 002/004 Fall 2026
Instructor
Matt SmithEmail: matthew.smith@rice.eduOffice: McNair 223Office Hours: M/W/F 11:30 – 1:30
Course Overview
Communication matters.
`;

// Canvas's real answer for five of the six classes: an array holding a refusal
// rather than a list of pages.
const PAGES_DISABLED = [{ message: 'That page has been disabled for this course' }];

for (const [slug, syllabusText] of [['busi-305', BUSI_305_SYLLABUS], ['busi-396', BUSI_396_SYLLABUS]]) {
  test(`${slug}: meeting_schedule is null and no hour is invented for it`, async () => {
    const dir = await seedClass({
      parsed: { course: { code: slug.toUpperCase().replace('-', ' '), meeting_schedule: null } },
      syllabusText,
      events: [],
      pages: PAGES_DISABLED,
    });
    const res = await recoverMeetingTimes(dir);

    // Nothing survives, and in particular the office-hours line does not: it
    // parses cleanly as a weekly pattern, and taking it would put "Friday
    // 2:00" (busi-305) or "MWF 11:30" (busi-396) on every lecture of the term.
    assert.equal(res.source, 'none');
    assert.deepEqual(res.patterns, []);
    assert.equal(describeMeetingSource(res), 'No class days or times found — set them yourself.');
    // Forward guard: if a later source ever does supply the DAYS for these two,
    // it still must not supply an hour — start/end null is what
    // sync-calendar reads as all_day true / time_known false.
    assert.equal(res.patterns.every(p => p.start === null && p.end === null), true,
      JSON.stringify(res.patterns));
    assert.equal(res.needs_override, true, 'the user is the only one who can answer');
    assert.equal(res.confidence, 'low');
    // Every tier was opened before giving up, so the description can say so
    // rather than sending the user to look somewhere already looked.
    assert.deepEqual(res.searched, ['override', 'syllabus-field', 'syllabus-text', 'canvas']);
    // A reason, not a silence — this is the text that becomes the event
    // description saying why the meeting is all-day.
    assert.match(res.warnings.join(' '), /set (it|them) yourself/);
    await rm(dir, { recursive: true, force: true });
  });

  test(`${slug}: not even the opt-in due-date guess invents an hour for it`, async () => {
    // Both classes have plenty of assignments due at a repeating hour. With no
    // source naming the class DAYS, a deadline is evidence about a deadline —
    // meeting-times.js:707 refuses on exactly that ground.
    const dir = await seedClass({
      parsed: { course: { meeting_schedule: null } },
      syllabusText,
      events: [],
      pages: PAGES_DISABLED,
      assignments: [
        ...Array.from({ length: 5 }, (_, i) => localIso(2026, 8, 7 + i * 7, 9, 0)),
        ...Array.from({ length: 5 }, (_, i) => localIso(2026, 8, 9 + i * 7, 9, 0)),
      ].map(due_at => ({ due_at })),
    });
    const res = await recoverMeetingTimes(dir, { inferFromDueDates: true });
    assert.notEqual(res.source, 'inferred');
    assert.deepEqual(res.patterns, []);
    assert.equal(res.needs_override, true);
    // The tier was genuinely reached and genuinely refused, not skipped.
    assert.ok(res.searched.includes('inferred'), JSON.stringify(res.searched));
    await rm(dir, { recursive: true, force: true });
  });
}

test('a corrupt syllabus_parsed.json says so instead of reading as an empty class', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-times-'));
  await writeFile(join(dir, 'syllabus_parsed.json'), '{"course":{"meeting_schedule":"MW 8:00-9:1');
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'none');
  assert.match(res.warnings.join(' '), /syllabus_parsed\.json is not valid JSON/);
  await rm(dir, { recursive: true, force: true });
});

test('corrupt Canvas files say so and do not stop the syllabus being read', async () => {
  const dir = await seedClass({ parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } } });
  await writeFile(join(dir, 'calendar_events.json'), '[{"start_at":');
  await writeFile(join(dir, 'assignments.json'), 'not json at all');
  const res = await recoverMeetingTimes(dir, { inferFromDueDates: true });
  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  assert.match(res.warnings.join(' '), /calendar_events\.json is not valid JSON/);
  assert.match(res.warnings.join(' '), /assignments\.json is not valid JSON/);
  await rm(dir, { recursive: true, force: true });
});

test("Canvas's error envelope is not reported as an empty calendar", async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    events: { errors: [{ message: 'user not authorized to perform that action' }] },
  });
  const res = await recoverMeetingTimes(dir);
  const warned = res.warnings.join(' ');
  assert.equal(/has no course events/.test(warned), false);
  assert.match(warned, /may have refused the request/);
  await rm(dir, { recursive: true, force: true });
});

test('a path that is not a class directory says so rather than answering none', async () => {
  const missing = join(tmpdir(), 'meeting-times-no-such-class-dir-93903');
  const res = await recoverMeetingTimes(missing);
  assert.equal(res.source, 'none');
  assert.match(res.warnings.join(' '), /No class directory/);

  // A file where a directory was expected is the same mistake.
  const dir = await mkdtemp(join(tmpdir(), 'meeting-times-'));
  await writeFile(join(dir, 'metadata.json'), '{}');
  const onFile = await recoverMeetingTimes(join(dir, 'metadata.json'));
  assert.match(onFile.warnings.join(' '), /No class directory/);
  await rm(dir, { recursive: true, force: true });
});

test('describeMeetingSource is one short sentence per source', async () => {
  assert.equal(
    describeMeetingSource({
      source: 'syllabus-text',
      patterns: [
        { label: 'Lecture', byday: ['MO', 'WE'], start: '08:00', end: '09:15', location: 'McNair Hall 314' },
        { label: 'Lab', byday: ['WE'], start: '12:00', end: '12:50', location: 'MCN 317' },
      ],
    }),
    'Found in the syllabus text — Lecture MW 8:00-9:15 AM, McNair Hall 314 (+1 more)',
  );
  assert.equal(
    describeMeetingSource({
      source: 'canvas',
      patterns: [{ label: 'Class', byday: ['TU', 'TH'], start: '11:30', end: '13:00', location: null }],
    }),
    'From Canvas — TuTh 11:30 AM-1:00 PM',
  );
  assert.equal(describeMeetingSource({ source: 'none', patterns: [] }), 'No class days or times found — set them yourself.');
  assert.equal(describeMeetingSource(null), 'No class days or times found — set them yourself.');
});

// --- The chain looked everywhere, and says so -------------------------------

// The ENTR 222 Canvas home page, cell for cell as Canvas serves it: four <p>s
// in one <td>, each holding one fact, and the classroom is the fourth. This is
// the only place in the entire data root that names that room.
const ENTR_222_PAGE_BODY = `<table>
  <thead>
    <tr>
      <th scope="col"><p><strong>Instructor</strong></p></th>
      <th scope="col"><p><strong>Class Meetings</strong></p></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>
        <p><span><strong>Adam Wulf</strong></span></p>
        <p><span>awulf@rice.edu</span></p>
      </td>
      <td>
        <p><span><strong>Section 001</strong></span></p>
        <p><span>TTh</span></p>
        <p><span>10:50 AM - 12:05 PM</span></p>
        <p>Cambridge Office Building 130 - Liu Idea Lab</p>
      </td>
    </tr>
  </tbody>
</table>`;

test('BUSI 380: a days-only field does not stop the search, and the result says how far it got', async () => {
  // The whole open question about this class was whether the chain even LOOKED
  // past the field that says "Tuesdays and Thursdays". It does — the only early
  // exit above the days-only block is gated on a clock — and now the result
  // proves it instead of leaving the caller to guess.
  const dir = await seedClass({
    parsed: { course: { code: 'BUSI 380', meeting_schedule: 'Tuesdays and Thursdays' } },
    syllabusText: BUSI_380_SYLLABUS,
    events: [],
    pages: [{ title: 'Home', body: '<p>Welcome to Marketing 380.</p>' }],
    announcements: [{ message: '<p>Read the Casper case before our next session.</p>' }],
  });
  const res = await recoverMeetingTimes(dir);

  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  assert.equal(res.patterns[0].start, null, 'no time exists in any source we hold');
  assert.equal(res.patterns[0].end, null);
  // `source` names where the DAYS came from — it is all we have — and the
  // confidence must not read as "we know when this class meets".
  assert.equal(res.source, 'syllabus-field');
  assert.equal(res.confidence, 'low');
  assert.deepEqual(res.searched, ['override', 'syllabus-field', 'syllabus-text', 'canvas']);
  assert.equal(res.needs_override, true, 'the user is the only one left who can answer');
  await rm(dir, { recursive: true, force: true });
});

test('a class with no stated time is told to set it, not told the syllabus was all we read', async () => {
  // The sentence used to say "no time found in the syllabus" after the chain
  // had also read this class's Canvas events, pages and announcements — sending
  // the user off to check Canvas, which we had already checked for them.
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    syllabusText: BUSI_380_SYLLABUS,
    events: [],
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(describeMeetingSource(res), 'Days only (TuTh) — no time in the syllabus or in Canvas. Set it yourself.');
  assert.match(res.warnings.join(' '), /never states a time, and neither does Canvas — set it yourself/);
  await rm(dir, { recursive: true, force: true });
});

test('a days-only override is still flagged as needing a time', async () => {
  const dir = await seedClass({ override: { days: ['TU', 'TH'] } });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'override');
  assert.equal(res.needs_override, true);
  await rm(dir, { recursive: true, force: true });
});

test('a guess from due dates is flagged as needing a real time even though it has one', async () => {
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    assignments: [
      { due_at: localIso(2026, 8, 1, 14, 30) },
      { due_at: localIso(2026, 8, 3, 14, 30) },
      { due_at: localIso(2026, 8, 8, 14, 30) },
    ],
  });
  const res = await recoverMeetingTimes(dir, { inferFromDueDates: true });
  assert.equal(res.source, 'inferred');
  assert.equal(res.needs_override, true, 'a time nobody wrote down is not a time');
  await rm(dir, { recursive: true, force: true });
});

// --- The room, when the time came from somewhere else ------------------------

test("ENTR 222: the classroom is found even though the field already gave the time", async () => {
  // The chain stopped at the field the moment it had a clock, so the one file
  // that names this class's room was never opened. WHERE is now looked up
  // independently of WHEN.
  const dir = await seedClass({
    parsed: { course: { code: 'ENTR 222', meeting_schedule: 'TR, 10:50 am - 12:05 pm' } },
    events: [],
    pages: [{ title: 'ENTR 222 Home', body: ENTR_222_PAGE_BODY }],
  });
  const res = await recoverMeetingTimes(dir);

  assert.equal(res.source, 'syllabus-field', 'the TIME still came from the syllabus');
  assert.equal(res.confidence, 'high');
  assert.equal(res.patterns[0].start, '10:50');
  assert.equal(res.patterns[0].location, 'Cambridge Office Building 130');
  assert.equal(res.patterns[0].location_source, 'the Canvas course pages');
  assert.equal(
    describeMeetingSource(res),
    'From the syllabus — TuTh 10:50 AM-12:05 PM, Cambridge Office Building 130 (room from the Canvas course pages)',
  );
  await rm(dir, { recursive: true, force: true });
});

test('a Canvas table cell is one clause, not one clause per paragraph', async () => {
  // stripHtml turned every </p> into a newline and the indentation between tags
  // left a blank line, so clausesOf split a single <td> into four unrelated
  // clauses: the days, the time and the room each alone, and none of them
  // holding the day AND time parseClause needs. The cell parsed to nothing.
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    events: [],
    pages: [{ title: 'ENTR 222 Home', body: ENTR_222_PAGE_BODY }],
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'canvas');
  assert.deepEqual(res.patterns[0].byday, ['TU', 'TH']);
  assert.equal(res.patterns[0].start, '10:50');
  assert.equal(res.patterns[0].end, '12:05');
  assert.equal(res.patterns[0].location, 'Cambridge Office Building 130');
  await rm(dir, { recursive: true, force: true });
});

test("the room hunt does not hand back the professor's office", async () => {
  // BUSI 305 states "Office: McNair Hall Room 330" and never states a
  // classroom. Null is the right answer; the office is the wrong one.
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'MW 2:30-3:45pm' } },
    syllabusText: 'Financial Accounting (BUSI 305)\nFall 2026 Office: McNair Hall Room 330\n\n'
      + 'Students with disabilities should contact the Disability Resource Center (Allen Center, Room 111).\n',
    events: [],
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.patterns[0].start, '14:30');
  assert.equal(res.patterns[0].location, null);
  assert.equal(res.patterns[0].location_source, undefined);
  await rm(dir, { recursive: true, force: true });
});

test('the course code in the syllabus prose is not offered as the classroom', async () => {
  // "BUSI 374" is the same shape as a room code. Scanning prose for a room with
  // that branch on put the course number on every meeting of the term.
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'M/W 2:30-3:45pm' } },
    syllabusText: 'BUSI 374 - Operations Management - Course Syllabus (F26)\n\n'
      + 'This course covers process analysis, quality management and inventory.\n',
    events: [],
  });
  const res = await recoverMeetingTimes(dir);
  assert.deepEqual(res.patterns[0].byday, ['MO', 'WE']);
  assert.equal(res.patterns[0].location, null);
  await rm(dir, { recursive: true, force: true });
});

test('an override is not quietly given a room the user never typed', async () => {
  // The override is the user's own record of this class. A room appearing in it
  // that they cannot see the source of, in the very editor they typed it into,
  // is not a favour.
  const dir = await seedClass({
    override: { days: ['TU', 'TH'], start: '10:50', end: '12:05' },
    pages: [{ title: 'ENTR 222 Home', body: ENTR_222_PAGE_BODY }],
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'override');
  assert.equal(res.patterns[0].location, null);
  await rm(dir, { recursive: true, force: true });
});

test("Canvas's disabled Pages tab is reported as disabled, not as a class with no room", async () => {
  // Five of the six real classes hold [{"message":"That page has been disabled
  // for this course"}] here. It is a list, so the empty-envelope check cannot
  // see it, and the scan comes back empty in exactly the way a real but silent
  // Pages tab does.
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: 'Tuesdays and Thursdays' } },
    events: [],
    pages: [{ message: 'That page has been disabled for this course' }],
  });
  const res = await recoverMeetingTimes(dir);
  assert.match(res.warnings.join(' '), /would not serve this class's Pages/);
  assert.equal(res.patterns[0].start, null);
  await rm(dir, { recursive: true, force: true });
});

test('a schedule row saying "no class" cannot donate its day and time to the class', async () => {
  // cal-meetings and meeting-times now share one definition of a no-class
  // clause; they used to disagree, and BUSI 380's "No class. Students work on
  // Group Midterm Case" became a class meeting on one side of the disagreement.
  const dir = await seedClass({
    parsed: { course: { meeting_schedule: null } },
    syllabusText: 'Class Meetings\nThere is no class on Tuesday 10:00-11:15 AM this week.\n',
    events: [],
  });
  const res = await recoverMeetingTimes(dir);
  assert.equal(res.source, 'none');
  assert.deepEqual(res.patterns, []);
  await rm(dir, { recursive: true, force: true });
});
