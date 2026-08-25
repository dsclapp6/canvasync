// The ICS writer — the thing that replaces the Claude routine.
//
// Most of these assert a refusal or an RFC detail that silently breaks one
// calendar client and not another, which is the worst kind of bug to ship to
// someone else's machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIcs, opToVevent, escText, fold, icsDate, icsDateTime, nextDay, icsStamp, icsFilesFor,
} from '../cal-ics.js';

const STAMP = '20260824T120000Z';
const ev = (op) => opToVevent(op, { dtstamp: STAMP })?.join('\n') ?? null;

const OP = {
  marker: '[csync:s|busi-305|hw-3|a1b2c3d4]',
  calendar: 'due', kind: 'homework', title: 'BUSI 305 · HW 3',
  date: '2026-09-14', time: '23:59', all_day: false, description: 'Chapter 6', class: 'busi-305',
};

// --- identity -------------------------------------------------------------

test('the csync marker is the UID, so a regenerated file updates instead of duplicating', () => {
  assert.match(ev(OP), /UID:\[csync:s\|busi-305\|hw-3\|a1b2c3d4\]/);
});

test('an op with no marker is refused — it has no stable identity', () => {
  assert.equal(ev({ ...OP, marker: null }), null);
  assert.equal(ev({ ...OP, marker: '' }), null);
});

test('an op with no date is not an event', () => {
  for (const d of [null, '', 'someday', '2026-13-45x']) {
    assert.equal(ev({ ...OP, date: d }), null, String(d));
  }
});

// --- times ----------------------------------------------------------------

test('a timed deadline is a 15-minute block ENDING at the deadline', () => {
  // The block on the calendar is the time you have left, not an hour after the
  // deadline has already passed.
  const s = ev(OP);
  assert.match(s, /DTSTART:20260914T235900/);
  assert.match(s, /DTEND:20260914T235900/);
});

test('times are floating — no Z, no TZID', () => {
  // "Class at 11:30" means 11:30 where the student is. Anchoring it to a zone
  // moves every lecture by an hour the first time the file and the university
  // disagree about DST.
  const s = ev({ ...OP, time: '11:30', end_time: '12:45' });
  assert.match(s, /DTSTART:20260914T113000\b/);
  assert.equal(/DTSTART:[^\n]*Z/.test(s), false);
  assert.equal(/TZID/.test(s), false);
});

test('an all-day op gets an EXCLUSIVE DTEND on the following day', () => {
  // An inclusive DTEND is the single most common ICS bug: the event renders as
  // zero-length and vanishes in half the clients that read it.
  const s = ev({ ...OP, all_day: true, time: null });
  assert.match(s, /DTSTART;VALUE=DATE:20260914/);
  assert.match(s, /DTEND;VALUE=DATE:20260915/);
});

test('a meeting whose hour is unknown stays all-day rather than being invented', () => {
  const s = ev({ ...OP, kind: 'meeting', time: null, all_day: true, time_known: false });
  assert.match(s, /DTSTART;VALUE=DATE:/);
  // DTSTAMP is a UTC timestamp and always carries a time; the assertion is
  // about the event's own start and end.
  const when = s.split('\n').filter(l => /^DT(START|END)/.test(l));
  assert.equal(when.some(l => /T\d{6}/.test(l)), false, 'no clock time on the event itself');
});

test('an end time that is not after the start falls back to 15 minutes', () => {
  const s = ev({ ...OP, time: '14:00', end_time: '13:00' });
  assert.match(s, /DTSTART:20260914T140000/);
  assert.match(s, /DTEND:20260914T141500/);
});

// --- recurrence -----------------------------------------------------------

test('office hours become one weekly rule, not one event per week', () => {
  const s = ev({
    ...OP, kind: 'office_hours', title: 'BUSI374 Office hours - VanHorn',
    date: '2026-10-07', time: '11:00', end_time: '14:15', all_day: false,
    recurrence: { freq: 'WEEKLY', byday: ['MO', 'WE'], from: '2026-10-07', until: '2026-12-13' },
  });
  assert.match(s, /RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261213T235959/);
});

test('UNTIL matches DTSTART\'s value type, or the last week is dropped', () => {
  // With a DATE start, UNTIL must be a bare date; with a DATE-TIME start it
  // needs a time, and anything earlier than the end of the day loses a week.
  const allDay = ev({
    ...OP, all_day: true, time: null,
    recurrence: { freq: 'WEEKLY', byday: ['TU'], until: '2026-12-01' },
  });
  assert.match(allDay, /UNTIL=20261201\b/);
  assert.equal(/UNTIL=\d{8}T/.test(allDay), false);
});

test('a recurrence with no days is not a recurrence', () => {
  const s = ev({ ...OP, recurrence: { freq: 'WEEKLY', byday: [], until: '2026-12-01' } });
  assert.equal(/RRULE/.test(s), false);
});

// --- escaping and folding -------------------------------------------------

test('TEXT escaping does backslash first, or it escapes its own escapes', () => {
  assert.equal(escText('a\\b'), 'a\\\\b');
  assert.equal(escText('a;b,c'), 'a\;b\\,c');
  assert.equal(escText('one\ntwo'), 'one\\ntwo');
  assert.equal(escText('c:\\dir; x, y'), 'c:\\\\dir\; x\\, y');
});

test('a comma in a title cannot split the property', () => {
  const s = ev({ ...OP, title: 'BUSI 305 · HW 3, part 2' });
  assert.match(s, /SUMMARY:BUSI 305 · HW 3\\, part 2/);
});

test('folding counts OCTETS, and never splits a multi-byte character', () => {
  // An en dash is one character and three bytes. Folding on character count
  // produces lines that look legal and are rejected by strict parsers.
  const line = `DESCRIPTION:${'–'.repeat(80)}`;
  const folded = fold(line);
  for (const l of folded.split('\r\n')) {
    assert.ok(new TextEncoder().encode(l).length <= 75, `line was ${l.length} chars`);
  }
  assert.ok(folded.split('\r\n').slice(1).every(l => l.startsWith(' ')), 'continuations begin with one space');
  // And it round-trips: unfolding gives the original back.
  assert.equal(folded.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join(''), line);
});

test('a short line is not folded', () => {
  assert.equal(fold('SUMMARY:short'), 'SUMMARY:short');
});

// --- the file -------------------------------------------------------------

test('a calendar has the envelope every client needs', () => {
  const { text, count } = buildIcs([OP], { name: 'CANVASync — Deadlines', dtstamp: STAMP });
  assert.match(text, /^BEGIN:VCALENDAR\r\n/);
  assert.match(text, /VERSION:2\.0/);
  assert.match(text, /PRODID:-\/\/canvas-sync\/\/CANVASync\/\/EN/);
  assert.match(text, /X-WR-CALNAME:CANVASync — Deadlines/);
  assert.match(text, /END:VCALENDAR\r\n$/);
  assert.equal(count, 1);
});

test('every line ends CRLF, as the RFC requires', () => {
  const { text } = buildIcs([OP], { dtstamp: STAMP });
  assert.equal(/[^\r]\n/.test(text), false, 'a bare LF would break strict parsers');
});

test('refused ops are reported, never silently dropped', () => {
  const { count, skipped } = buildIcs([OP, { ...OP, marker: null }, { ...OP, date: null }], { dtstamp: STAMP });
  assert.equal(count, 1);
  assert.equal(skipped.length, 2);
});

test('deadlines do not block out the day; classes do', () => {
  assert.match(ev(OP), /TRANSP:TRANSPARENT/);
  assert.match(ev({ ...OP, kind: 'meeting' }), /TRANSP:OPAQUE/);
  assert.match(ev({ ...OP, kind: 'office_hours' }), /TRANSP:OPAQUE/);
});

test('an empty worklist is a valid, empty calendar — not a broken file', () => {
  const { text, count } = buildIcs([], { dtstamp: STAMP });
  assert.equal(count, 0);
  assert.match(text, /BEGIN:VCALENDAR/);
  assert.match(text, /END:VCALENDAR/);
  assert.equal(/BEGIN:VEVENT/.test(text), false);
});

test('junk in is an empty calendar, not a throw', () => {
  for (const v of [null, undefined, 'nope', 42, {}]) {
    assert.equal(buildIcs(v, { dtstamp: STAMP }).count, 0, String(v));
  }
});

// --- the four files -------------------------------------------------------

test('one file per target calendar, plus one holding everything', () => {
  const worklist = {
    ops: [
      { ...OP, calendar: 'due' },
      { ...OP, marker: '[csync:s|x|y|2]', calendar: 'checkpoint', kind: 'checkpoint' },
      { ...OP, marker: '[csync:m|x|t:z|3]', calendar: 'meeting', kind: 'meeting' },
    ],
  };
  const files = icsFilesFor(worklist, { dtstamp: STAMP });
  const by = Object.fromEntries(files.map(f => [f.file, f.count]));
  assert.deepEqual(by, { 'deadlines.ics': 1, 'checkpoints.ics': 1, 'classes.ics': 1, 'canvasync.ics': 3 });
});

test('every file in one write shares a DTSTAMP', () => {
  const files = icsFilesFor({ ops: [OP] }, { dtstamp: STAMP });
  for (const f of files) {
    if (f.count) assert.match(f.text, new RegExp(`DTSTAMP:${STAMP}`));
  }
});

// --- helpers --------------------------------------------------------------

test('date helpers refuse anything that is not an ISO date', () => {
  assert.equal(icsDate('2026-08-24'), '20260824');
  for (const v of [null, '', '24/08/2026', '2026-8-4']) assert.equal(icsDate(v), null, String(v));
  assert.equal(icsDateTime('2026-08-24', '11:30'), '20260824T113000');
  assert.equal(icsDateTime('2026-08-24', '25:00'), null);
  assert.equal(icsDateTime('2026-08-24', null), null);
});

test('nextDay crosses months, years and leap days', () => {
  assert.equal(nextDay('2026-08-31'), '2026-09-01');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  assert.equal(nextDay('2028-02-28'), '2028-02-29');
  assert.equal(nextDay('nope'), null);
});

test('icsStamp is UTC and RFC-shaped', () => {
  assert.equal(icsStamp(new Date(Date.UTC(2026, 7, 24, 9, 5, 3))), '20260824T090503Z');
});
