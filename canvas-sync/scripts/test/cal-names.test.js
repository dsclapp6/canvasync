// cal-names.test.js — calendar event titles.
//
// The failure these guard against is not ugliness, it's ambiguity: a month view
// truncates at ~20 characters, so two events that share a prefix become the
// same event to the reader. Every case here checks that the characters that
// survive are the ones that distinguish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
//
// meetingTitle is the exception: it is not shortened prose, it is three named
// fields the user dictated — "[LOC] - [CLASS] - [PROF]", e.g.
// "Virani 182 - BUSI380 - VanHorn". Its tests are about what happens when two
// of those three are missing, which is the usual case: 80 of the 106 meeting
// ops in the live worklist carry no location.
import {
  shortCourseCode, cleanItemTitle, clip, dueTitle, prepTitle, checkpointTitle, meetingTitle,
  instructorSurname, compactCourseCode, roomName,
} from '../cal-names.js';

test('shortCourseCode drops the section list', () => {
  assert.equal(shortCourseCode('BUSI 395 001/002/003/004'), 'BUSI 395');
  assert.equal(shortCourseCode('BUSI 305 001/002/003'), 'BUSI 305');
  assert.equal(shortCourseCode('MATH 101 S01/S03'), 'MATH 101');
  assert.equal(shortCourseCode('COMP 140-003'), 'COMP 140');
  assert.equal(shortCourseCode('FWIS 255 (Section 2)'), 'FWIS 255');
});

test('shortCourseCode drops a trailing term', () => {
  assert.equal(shortCourseCode('BUSI 305 F26'), 'BUSI 305');
  assert.equal(shortCourseCode('ECON 100 Fall 2026'), 'ECON 100');
  assert.equal(shortCourseCode('ENTR 222 Spring'), 'ENTR 222');
});

test('shortCourseCode normalises spacing and survives odd input', () => {
  assert.equal(shortCourseCode('BUSI395'), 'BUSI 395');
  assert.equal(shortCourseCode('  COMP  140  '), 'COMP 140');
  assert.equal(shortCourseCode(''), '');
  assert.equal(shortCourseCode(null), '');
  // A course with no code-like shape is left alone rather than mangled.
  assert.equal(shortCourseCode('Power of Persuasion'), 'Power of Persuasion');
});

test('shortCourseCode keeps a number that is part of the course, not a section', () => {
  assert.equal(shortCourseCode('BUSI 305'), 'BUSI 305');
  assert.equal(shortCourseCode('MATH 101'), 'MATH 101');
});

test('cleanItemTitle strips the course code the title repeats', () => {
  assert.equal(cleanItemTitle('BUSI 395: Homework 3', 'BUSI 395'), 'HW 3');
  assert.equal(cleanItemTitle('BUSI395 Homework 3', 'BUSI 395'), 'HW 3');
  assert.equal(cleanItemTitle('Busi 395 - Homework 3', 'BUSI 395'), 'HW 3');
  assert.equal(cleanItemTitle('BUSI 395 001/002 Homework 3', 'BUSI 395'), 'HW 3');
});

test('cleanItemTitle abbreviates only what is long and uninformative', () => {
  assert.equal(cleanItemTitle('Homework Assignment 4'), 'HW 4');
  assert.equal(cleanItemTitle('Problem Set 2'), 'PS 2');
  assert.equal(cleanItemTitle('Chapter 7 Reading'), 'Ch 7 Reading');
  assert.equal(cleanItemTitle('Final Examination'), 'Final');
  assert.equal(cleanItemTitle('Week 3 Discussion Post'), 'Wk 3 Post');
});

test('cleanItemTitle never returns an empty title', () => {
  // "Due" is stripped as noise — but stripping everything must fall back.
  assert.equal(cleanItemTitle('Due'), 'Due');
  assert.equal(cleanItemTitle(''), 'Untitled');
  assert.equal(cleanItemTitle(null), 'Untitled');
  assert.equal(cleanItemTitle('   '), 'Untitled');
});

test('clip cuts on a word boundary and marks the cut', () => {
  const long = 'Assess Multi-Channel Distribution Strategies For The Firm';
  const out = clip(long, 30);
  assert.ok(out.length <= 30, out);
  assert.ok(out.endsWith('…'));
  assert.ok(!/\s…$/.test(out), 'no space before the ellipsis');
  assert.equal(clip('short', 30), 'short');
  // Nothing cut means no ellipsis, even at exactly the limit.
  assert.equal(clip('123456789', 9), '123456789');
});

test('dueTitle reads "CODE · thing"', () => {
  assert.equal(
    dueTitle({ code: 'BUSI 395 001/002/003/004', title: 'Homework Assignment 3', category: 'homework' }),
    'BUSI 395 · HW 3');
  assert.equal(
    dueTitle({ code: 'BUSI 305 001/002/003', title: 'Midterm Exam 2', category: 'exam' }),
    'BUSI 305 · Midterm 2');
});

test('a reading gets a verb, and does not get it twice', () => {
  assert.equal(dueTitle({ code: 'FWIS 255', title: 'Chapter 4', category: 'reading' }),
    'FWIS 255 · Read Ch 4');
  assert.equal(dueTitle({ code: 'FWIS 255', title: 'Read chapters 4-6', category: 'reading' }),
    'FWIS 255 · Read Ch 4-6');
});

test('a course with no code still produces a usable title', () => {
  assert.equal(dueTitle({ code: '', title: 'Homework 1', category: 'homework' }), 'HW 1');
});

test('prep leads with Prep so it cannot be confused with the deadline', () => {
  const due = dueTitle({ code: 'BUSI 305 001', title: 'Midterm 2', category: 'exam' });
  const prep = prepTitle({ code: 'BUSI 305 001', title: 'Midterm 2' });
  assert.equal(prep, 'Prep · BUSI 305 Midterm 2');
  assert.notEqual(prep.slice(0, 12), due.slice(0, 12));
});

test("a user's own checkpoint keeps their words", () => {
  assert.equal(checkpointTitle({ code: 'BUSI 305 001', title: 'buy the calculator' }),
    'BUSI 305 · buy the calculator');
  assert.equal(checkpointTitle({ code: 'BUSI 305', title: '' }), 'BUSI 305 · Checkpoint');
});

// --- compactCourseCode ------------------------------------------------------

test('compactCourseCode writes the code the way the user writes it', () => {
  // "BUSI380", no space and no section list — the user's own example.
  assert.equal(compactCourseCode('BUSI 380 002'), 'BUSI380');
  assert.equal(compactCourseCode('ECON 205 002'), 'ECON205');
  assert.equal(compactCourseCode('BUSI 305 001/002/003'), 'BUSI305');
  assert.equal(compactCourseCode('BUSI 396 001/002/003/004'), 'BUSI396');
  assert.equal(compactCourseCode('ENTR 222 001'), 'ENTR222');
  assert.equal(compactCourseCode('BUSI 374 001/002'), 'BUSI374');
});

test('compactCourseCode is idempotent and survives the slug fallback', () => {
  // Already compact: sync-calendar re-titles an existing event on every run, so
  // a second pass over its own output must not change the title.
  assert.equal(compactCourseCode('BUSI380'), 'BUSI380');
  assert.equal(compactCourseCode(compactCourseCode('BUSI 380 002')), 'BUSI380');
  // When metadata.json has no course_code, sync-calendar falls back to the
  // folder slug uppercased.
  assert.equal(compactCourseCode('BUSI-305-001-002-003'), 'BUSI305');
});

test('compactCourseCode returns null rather than an empty string', () => {
  // meetingTitle filters on truthiness, so "" and null must both drop out — an
  // empty code that survived would leave the " - " in front of the professor.
  assert.equal(compactCourseCode(null), null);
  assert.equal(compactCourseCode(''), null);
  assert.equal(compactCourseCode('   '), null);
});

test('compactCourseCode does not close up a name that is not a code', () => {
  // "PowerofPersuasion" is not a course code, it is a broken word.
  assert.equal(compactCourseCode('Power of Persuasion'), 'Power of Persuasion');
});

// --- instructorSurname ------------------------------------------------------

test('instructorSurname handles all six real instructor strings', () => {
  // Verbatim from each class's syllabus_parsed.json course.instructor.name.
  assert.equal(instructorSurname('Marc Dudey'), 'Dudey');            // econ-205
  assert.equal(instructorSurname('Dr. Leila Peyravan'), 'Peyravan'); // busi-305
  assert.equal(instructorSurname('David VanHorn'), 'VanHorn');       // busi-374
  assert.equal(instructorSurname('Matt Smith'), 'Smith');            // busi-396
  assert.equal(instructorSurname('Constance Porter'), 'Porter');     // busi-380
  assert.equal(instructorSurname('Adam Wulf'), 'Wulf');              // entr-222
});

test('a title is stripped before the surname is taken, not after', () => {
  // "Dr. Leila Peyravan" gives the right answer either way; "Prof. Porter" is
  // the case that proves the title was actually removed.
  assert.equal(instructorSurname('Prof. Porter'), 'Porter');
  assert.equal(instructorSurname('Professor Constance Porter'), 'Porter');
  assert.equal(instructorSurname('dr leila peyravan'), 'peyravan');
  for (const t of ['Dr', 'Dr.', 'Prof', 'Prof.', 'Professor', 'Mr', 'Mrs', 'Ms', 'Mx']) {
    assert.equal(instructorSurname(`${t} Wulf`), 'Wulf', t);
  }
});

test('an internal capital is not a split point', () => {
  // "VanHorn" is one word. Splitting on the H puts "Horn" on 28 BUSI 374
  // lectures for a professor of that name.
  assert.equal(instructorSurname('David VanHorn'), 'VanHorn');
  assert.equal(instructorSurname('Sean McCarthy'), 'McCarthy');
  assert.equal(instructorSurname('Ann DeSoto'), 'DeSoto');
});

test('a suffix is never returned as the surname', () => {
  assert.equal(instructorSurname('David VanHorn Jr.'), 'VanHorn');
  assert.equal(instructorSurname('Marc Dudey III'), 'Dudey');
  assert.equal(instructorSurname('Leila Peyravan, PhD'), 'Peyravan');
  assert.equal(instructorSurname('Constance Porter, Ph.D.'), 'Porter');
  assert.equal(instructorSurname('Adam Wulf, MBA'), 'Wulf');
});

test('a single-word name is the surname, not a failure', () => {
  assert.equal(instructorSurname('Smith'), 'Smith');
  assert.equal(instructorSurname('  Wulf  '), 'Wulf');
});

test('the comma form is read surname-first', () => {
  assert.equal(instructorSurname('Porter, Constance'), 'Porter');
  assert.equal(instructorSurname('Peyravan, Leila'), 'Peyravan');
  // A two-word surname before the comma stays two words.
  assert.equal(instructorSurname('Van Horn, David'), 'Van Horn');
  // …but a credential after the comma is not a given name, so this is still
  // given-name-first and the surname is still Porter.
  assert.equal(instructorSurname('Porter, Constance, Ph.D.'), 'Porter');
});

test('instructorSurname returns null rather than something to print', () => {
  // A returned junk value ends up on 106 lecture titles; null is filtered out.
  for (const junk of [null, undefined, '', '   ', 'null', 'undefined', 'TBA', 'TBD',
    'N/A', 'Staff', 'Dr.', 'Professor', '---', 42]) {
    assert.equal(instructorSurname(junk), null, JSON.stringify(junk));
  }
});

// --- meetingTitle: "[LOC] - [CLASS] - [PROF]" -------------------------------

test('meetingTitle is "[LOC] - [CLASS] - [PROF]", the user\'s own example', () => {
  assert.equal(
    meetingTitle({ code: 'BUSI 380 002', label: 'Lecture', location: 'Virani 182', instructor: 'VanHorn' }),
    'Virani 182 - BUSI380 - VanHorn');
  // ENTR 222 is the one class of six whose syllabus states a room, and this is
  // that room, verbatim from its 26 meeting ops.
  assert.equal(
    meetingTitle({ code: 'ENTR 222 001', label: 'Class', location: 'Cambridge Office Building 130', instructor: 'Adam Wulf' }),
    'Cambridge Office Building 130 - ENTR222 - Wulf');
});

test('meetingTitle degrades one field at a time and never leaves the dash behind', () => {
  const code = 'BUSI 380 002';
  assert.equal(meetingTitle({ code, location: 'Virani 182', instructor: 'Constance Porter' }),
    'Virani 182 - BUSI380 - Porter');
  // 80 of 106 meeting ops are this case.
  assert.equal(meetingTitle({ code, location: null, instructor: 'Constance Porter' }),
    'BUSI380 - Porter');
  assert.equal(meetingTitle({ code, location: 'Virani 182', instructor: null }),
    'Virani 182 - BUSI380');
  assert.equal(meetingTitle({ code, location: null, instructor: null }), 'BUSI380');
});

test('meetingTitle is total: no combination of missing fields makes a broken title', () => {
  // The four forbidden shapes, from CALENDAR-SPEC 4.2: a leading " - ", the
  // literal word null, a doubled " -  - ", and an empty title.
  const BROKEN = /^\s*-|null|-\s*-/;
  const values = {
    location: [null, 'Virani 182'],
    code: [null, 'BUSI 380 002'],
    instructor: [null, 'Constance Porter'],
  };
  const seen = [];
  for (const location of values.location) {
    for (const code of values.code) {
      for (const instructor of values.instructor) {
        const t = meetingTitle({ code, label: 'Lecture', topic: 'Segmentation', location, instructor });
        seen.push(t);
        assert.ok(t.length > 0, `empty title for ${JSON.stringify({ code, location, instructor })}`);
        assert.ok(!BROKEN.test(t), `${JSON.stringify({ code, location, instructor })} -> ${JSON.stringify(t)}`);
        assert.ok(!/\s{2,}/.test(t), `double space in ${JSON.stringify(t)}`);
      }
    }
  }
  assert.equal(seen.length, 8);
  assert.equal(seen[0], 'Class', 'all three missing still names something');
});

test('an empty string is as missing as null, and so is the word "null"', () => {
  // syllabus parsers emit "" and, when they are having a bad day, "null".
  assert.equal(meetingTitle({ code: 'BUSI 380', location: '', instructor: '' }), 'BUSI380');
  assert.equal(meetingTitle({ code: 'BUSI 380', location: 'null', instructor: 'null' }), 'BUSI380');
  assert.equal(meetingTitle({ code: 'BUSI 380', location: '   ', instructor: '   ' }), 'BUSI380');
  assert.equal(meetingTitle(), 'Class');
});

// Was: 'meetingTitle names the session and its topic without repeating itself',
// which asserted the old "CODE · Label: topic" format. Same inputs, new format:
// the label and the topic are gone from the title on purpose, because the user
// asked for a title of exactly three fields and neither is one of them. The
// caller now puts the topic in the event description.
test('the label and the topic no longer appear in the title', () => {
  assert.equal(meetingTitle({ code: 'BUSI 395 001/002', label: 'Lecture', topic: 'Probability' }),
    'BUSI395');
  assert.equal(meetingTitle({ code: 'BUSI 395', label: 'Lab', topic: null }), 'BUSI395');
  assert.equal(meetingTitle({ code: 'BUSI 395', label: 'Lecture', topic: 'lecture' }), 'BUSI395');
});

// Was part of the same old-format test: a holiday used to read
// "BUSI 395 · No class: MLK Holiday". It still has to say "no class" — that is
// the one thing a label decides — but in the new shape.
test('a no-class day says so instead of naming a room and a professor', () => {
  assert.equal(meetingTitle({ code: 'BUSI 395', label: 'No class', topic: 'MLK Holiday' }),
    'No class - BUSI395');
  // A room on a day the university is shut is an instruction to walk to an
  // empty building.
  assert.equal(
    meetingTitle({ code: 'ENTR 222 001', label: 'No class', location: 'Cambridge Office Building 130', instructor: 'Adam Wulf' }),
    'No class - ENTR222');
  for (const label of ['No class', 'no classes', 'Cancelled', 'Fall Recess', 'Spring Break', 'Class will not meet']) {
    assert.equal(meetingTitle({ code: 'BUSI 380 002', label }), 'No class - BUSI380', label);
  }
  assert.equal(meetingTitle({ code: null, label: 'No class' }), 'No class');
});

test('a lecture label is not mistaken for a no-class marker', () => {
  for (const label of ['Lecture', 'Lab', 'Class', 'Breakout session', 'Exam 1', 'Guest speaker']) {
    assert.equal(meetingTitle({ code: 'BUSI 380 002', label, instructor: 'Constance Porter' }),
      'BUSI380 - Porter', label);
  }
});

// --- ADVERSARIAL: these three FAIL against cal-names.js as it stands ---------
//
// Added by the review pass, deliberately red, one per defect. None of them
// changes a live title today — the read-only worklist
// (buildWorklist(~/canvas-sync-data/classes, {write:false}), 106 meeting ops)
// still has 0 titles matching /^\s*-|null|-\s*-/. Each is one field of
// professor-typed text away from being live.

test('a punctuation-only room is a missing room, not a room called "-"', () => {
  // cal-meetings.js:585 takes a meeting's location straight from a Canvas
  // event's location_name/location_address — free text the professor types, and
  // "-" is what people type in a field they have nothing to put in. stated()
  // (cal-names.js:260) catches the WORD placeholders (null, TBA, N/A) and no
  // punctuation one, so the dash survives into the join and rebuilds both of
  // the shapes CALENDAR-SPEC 4.2 forbids by name: a leading " - " and a
  // doubled " -  - ".
  const code = 'BUSI 380 002';
  const instructor = 'Constance Porter';
  const BROKEN = /^\s*-|null|-\s*-/;
  for (const location of ['-', '--', '—', '–', ' - ', '.', ',']) {
    const t = meetingTitle({ code, location, instructor });
    assert.ok(!BROKEN.test(t), `location ${JSON.stringify(location)} -> ${JSON.stringify(t)}`);
    assert.equal(t, 'BUSI380 - Porter', JSON.stringify(location));
  }
  // A room with the separator already on the end of it — "Location: Virani 182 -"
  // clipped at the label — doubles the dash the same way.
  assert.equal(meetingTitle({ code, location: 'Virani 182 -', instructor }),
    'Virani 182 - BUSI380 - Porter');
});

test('the course code is placeholder-filtered like the other two fields', () => {
  // sync-calendar.js:698 reads `metadata.course_code || metadata.course?.code ||
  // classSlug.toUpperCase()`. All six of this user's classes hold a real code
  // today ("BUSI 380 002", "ENTR 222 001", …), but the || chain only defends
  // against a FALSY code: a metadata.json holding the string "null" — which is
  // exactly what CALENDAR-SPEC 4.2 forbids by name — walks into the title,
  // because location goes through stated() and instructor through
  // NOT_A_NAME_RE while compactCourseCode filters nothing at all.
  for (const code of ['null', 'undefined', 'N/A', 'TBA', 'TBD', '-']) {
    assert.equal(meetingTitle({ code, location: 'Virani 182', instructor: 'Constance Porter' }),
      'Virani 182 - Porter', JSON.stringify(code));
  }
  assert.equal(compactCourseCode('null'), null);
  assert.equal(compactCourseCode('TBA'), null);
});

test('a lecture whose topic contains "break" or "holiday" is still a lecture', () => {
  // NO_CLASS_LABEL_RE (cal-names.js:257) widens cal-meetings' NO_CLASS_RE with
  // \b(?:holiday|recess|break)\b. Those three words are lecture SUBJECTS in
  // this user's own six classes before they are calendar events: break-even
  // analysis is BUSI 305 (Financial Accounting), holiday demand is BUSI 380
  // (Marketing). Titling that day "No class - BUSI380" is the inversion of the
  // failure cal-meetings.js:221-232 exists to prevent — it tells the student to
  // stay home on a day the class meets, and drops the room and the professor
  // while it does it.
  for (const label of ['Break-Even Analysis', 'Break-even point', 'Holiday Shopping Behaviour',
    'The Break-Up: a case study', 'Coffee break exercise']) {
    assert.equal(
      meetingTitle({ code: 'BUSI 380 002', label, location: 'Virani 182', instructor: 'Constance Porter' }),
      'Virani 182 - BUSI380 - Porter', label);
  }
});

test('the location field is normalised the same way the title is', () => {
  // The op carries `location` as a field as well as inside the title, and the
  // renderer prints the field. A title that correctly dropped a dash next to a
  // location line that kept it is the same defect twice.
  for (const junk of ['-', '--', '\u2014', ' - ', '.', 'null', 'TBA', '', null, undefined]) {
    assert.equal(roomName(junk), null, JSON.stringify(junk));
  }
  assert.equal(roomName('Virani 182'), 'Virani 182');
  assert.equal(roomName('Virani 182 -'), 'Virani 182');
  assert.equal(roomName('  Cambridge Office   Building 130 '), 'Cambridge Office Building 130');
  // Clipped to the same width the title clips to, so the two cannot disagree
  // about how much of a long room name there is.
  const long = 'Virani Undergraduate Business Building, second floor, room 182';
  assert.ok(roomName(long).length <= 32);
  assert.ok(meetingTitle({ code: 'BUSI 380 002', location: long }).includes(roomName(long)));
});

test('every title stays short enough to read in a month view', () => {
  const monster = 'S2a-Concept Check: Understand the Nature of Multi-Channel Distribution Strategy';
  for (const t of [
    dueTitle({ code: 'BUSI 380 002', title: monster, category: 'homework' }),
    prepTitle({ code: 'BUSI 380 002', title: monster }),
    meetingTitle({ code: 'BUSI 380 002', label: 'Lecture', topic: monster }),
    // A room stated as a sentence rather than a room. The three fields the user
    // asked for all have to survive it, so it is the LOCATION that gets cut and
    // not the professor on the end.
    meetingTitle({
      code: 'BUSI 380 002',
      label: 'Lecture',
      location: 'Virani Undergraduate Business Building, second floor, room 182',
      instructor: 'Constance Porter',
    }),
    checkpointTitle({ code: 'BUSI 380 002', title: monster }),
  ]) {
    assert.ok(t.length <= 70, `${t.length}: ${t}`);
  }
  assert.match(
    meetingTitle({
      code: 'BUSI 380 002',
      location: 'Virani Undergraduate Business Building, second floor, room 182',
      instructor: 'Constance Porter',
    }),
    /- BUSI380 - Porter$/,
    'the clip lands on the room, never on the code or the professor');
});
