// sync-calendar.js — build the calendar worklist for ALL classes.
//
// Scan every class, take the mined task list (assignments_mined.json — Canvas +
// implicit items) with assignments.json as fallback, fold in the user's own
// marks (done / moved / checkpoints), the class meeting schedule and the
// professor's office hours, and emit
//
//   <base>/calendar/worklist.json  — machine-readable ops list
//   <base>/calendar/worklist.md    — the same ops, readable
//   <base>/calendar/*.ics          — the calendars themselves (cal-ics.js)
//
// The .ics files are the point. This used to hand worklist.md to a Claude
// routine with calendar MCP tools, which meant the app could not be given to
// anyone without an Anthropic subscription; an iCalendar subscription does the
// same job with no account at all. See cal-ics.js for why the marker scheme
// made that a rename rather than a rewrite.
//
// It emits EVERY kind it can find — meeting, office_hours, homework, reading,
// exam, checkpoint — unconditionally. What the user sees is filtered in the
// dashboard, not built conditionally here: a kind that is only hidden can be
// counted, searched and explained, and unticking a chip can never leave the
// page empty. See calendar-kinds.js.
//
// Every op carries a marker for the event description's last line:
//   [csync:a|<canvasAssignmentId>|<hash>]            Canvas assignment due event
//   [csync:s|<classSlug>|<itemId>|<hash>]            implicit/mined item due event
//   [csync:s|<classSlug>|<itemId>+<N>d|<hash>]       automatic prep event
//   [csync:s|<classSlug>|<itemId>@<cpId>|<hash>]     a checkpoint the user added
//   [csync:m|<classSlug>|t:<topic-slug>|<hash>]      class meeting
//   [csync:m|<classSlug>|d:<date>|<hash>]            …with no topic to key on
//   [csync:h|<classSlug>|<byday>@<start>|<hash>]     office hours (recurring)
// hash = first 8 hex of sha256(title|date|time|description): if an event with
// the same marker prefix exists but the hash differs, the item changed and the
// event should be updated in place. Events are NEVER deleted by sync (the
// deletion happens implicitly: a class removed from the worklist leaves the
// .ics files, and subscribers drop its events on the next refresh).
//
// Nothing that a CORRECTION can change may live inside a marker prefix — that
// is why the meeting prefix is keyed on the session's topic and not on its
// date. See sessionKey().
//
// Env: CSYNC_CAL_DUE / CSYNC_CAL_CHK / CSYNC_CAL_MEET  target calendar ids,
//        embedded in the worklist when set. Only meaningful to someone writing
//        events into a hosted calendar by hand; the .ics files need none of it.

import { readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classHome, readJsonSafe, atomicWriteJson, atomicWriteText } from './_util.js';
import { readSyncScope, isInScope, CLASS_DIR_RE } from '../scope.js';
import { KINDS, KIND_LABELS, KIND_NOUN, KIND_CALENDAR } from '../calendar-kinds.js';
import { readUserState } from '../bridge/user-state.js';
import { dueTitle, prepTitle, checkpointTitle, meetingTitle, labelSaysNoClass, roomName, shortCourseCode, compactCourseCode, instructorSurname, clip } from './cal-names.js';
import { collectMeetings } from './cal-meetings.js';
import { recoverMeetingTimes } from './meeting-times.js';
import { officeHoursFor, resolveRange, describeOfficeHours } from './cal-office-hours.js';
import { icsFilesFor } from './cal-ics.js';
import { tasksForClass } from '../canvas-tasks.js';

const PAST_GRACE_DAYS = 7;     // still emit ops for items due up to a week ago (late updates)
const HORIZON_DAYS = 180;      // how far ahead to schedule
// Categories that earn prep/checkpoint events, with days-before offsets.
const CHECKPOINTS = {
  exam: [5, 1],
  project: [7, 2],
  paper: [7, 2],
  presentation: [5, 1],
};

// Which population kind each mined category belongs to. Anything unrecognised
// is work you hand in, which is the safe place for it — better an extra
// deadline on the calendar than a missing one.
//
// Exported because this table and the miner's category enum
// (scripts/prompts/assignment-mining.md) are two halves of one contract, and
// nothing but a test stops them drifting: a category the miner invents that has
// no key here does not error, it silently lands in `homework` and stops obeying
// its own toggle. scripts/test/sync-calendar.test.js reads the prompt and fails
// if a single string is missing.
export const CATEGORY_KIND = {
  reading: 'reading',
  exam: 'exam',
  quiz: 'homework',
  homework: 'homework',
  project: 'homework',
  paper: 'homework',
  presentation: 'homework',
  participation: 'homework',
  other: 'homework',
};

// Canvas may promote an item to `exam`; it may never demote one. Everything
// except a reading is fair game — a reading that matches an exam-titled Canvas
// row is a mining error, not a hidden midterm.
const EXAM_PROMOTABLE = new Set(['homework', 'quiz', 'project', 'paper', 'presentation', 'participation', 'other', '']);

function kindForCategory(category) {
  return CATEGORY_KIND[String(category ?? '').toLowerCase()] ?? 'homework';
}

/**
 * The population kind for one task item.
 *
 * The mined category usually wins — mining read the syllabus and knows a
 * "Midterm Case Assignment" is a group project. But when Canvas's own title
 * says exam and mining says project, the kind must not depend on whether
 * mining happened to have finished: BUSI 380's 2026-10-08 midterm (Canvas
 * 532645) was an exam op with 5d/1d prep before its class was mined and a
 * homework op with 7d/2d prep after, orphaning the first event because sync
 * never deletes. Canvas's verdict is the stable one, so it gets the veto.
 */
export function kindForItem(it) {
  const category = String(it?.category ?? '').toLowerCase();
  if (it?.canvas_category === 'exam' && EXAM_PROMOTABLE.has(category)) return 'exam';
  return kindForCategory(category);
}

function shortHash(...parts) {
  return createHash('sha256').update(parts.map(p => p ?? '').join('|')).digest('hex').slice(0, 8);
}

// Local-timezone YYYY-MM-DD. Never use toISOString().slice(0,10) for dates
// shown to (or diffed for) the user — that's the UTC date, which is a day off
// for evening deadlines and near-midnight runs.
function localIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoAddDays(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return localIsoDate(d);
}

// First date on/after `iso` whose weekday is in `byday`. A weekly recurrence
// anchored on a weekday its BYDAY does not name is undefined per RFC 5545,
// and real clients (Google, Apple) render DTSTART itself as an occurrence —
// so a MO/WE/FR office-hours rule anchored on the Tuesday the window opened
// painted a phantom block on a day it never happens.
const BYDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function firstOnByday(iso, byday) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '')) return iso;
  const wanted = new Set((Array.isArray(byday) ? byday : []).map(d => BYDAY_INDEX[d]).filter(n => n != null));
  if (!wanted.size) return iso;
  const d = new Date(iso + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    if (wanted.has(d.getDay())) return localIsoDate(d);
    d.setDate(d.getDate() + 1);
  }
  return iso;
}

function classSlugOf(folderName) {
  return folderName.replace(/^[0-9]+-/, '');
}

/**
 * The caveat a class's parsed syllabus has earned, or null.
 *
 * The parser records how sure it is and what it had to guess, and until now
 * only the AI context packs read either field — the calendar, the one place the
 * guess turns into an assertion, read neither. Four of this user's six classes
 * self-report inference in extraction_notes ("The schedule assumes a standard
 * weekly progression for lectures", "the dates were inferred from exam days")
 * and three of those four still report extraction_confidence "high", so the
 * notes have to be read as well as the confidence.
 */
function scheduleCaveatFor(syllabusParsed) {
  const confidence = String(syllabusParsed?.extraction_confidence ?? '').toLowerCase();
  const notes = String(syllabusParsed?.extraction_notes ?? '');
  const inferred = /\binfer(?:s|red|ring|ence)?\b|\bassume[ds]?\b/i.test(notes);
  const lowConfidence = confidence === 'low' || confidence === 'medium';
  if (!inferred && !lowConfidence) return null;
  const why = inferred
    ? 'the syllabus parser reports it inferred this schedule rather than reading a stated date'
    : `the syllabus parser rates its extraction "${confidence}"`;
  return `Date not confirmed — ${why}. Verify against the syllabus.`;
}

function markerOp(marker, rest) {
  return { marker, marker_prefix: marker.slice(0, marker.lastIndexOf('|') + 1), ...rest };
}

// Where an item came from, for the UI to say out loud: 'canvas' means a live
// Canvas row stands behind it, 'syllabus' means the AI mined it from course
// materials and there is nothing on Canvas to open or submit. tasksForClass
// stamps this on every item it returns; the fallback covers an item read from
// an older assignments_mined.json that predates the field.
function originOf(it) {
  if (it.origin === 'canvas' || it.origin === 'syllabus') return it.origin;
  return it.canvas_assignment_id != null ? 'canvas' : 'syllabus';
}

// "Prep · BUSI 305 Exam 1" twice over is one event shown twice as far as a
// calendar grid is concerned. The offset goes in front, where a month view
// still has characters to spend, and the composition happens here rather than
// in cal-names so a change to the title format degrades to a longer title
// instead of a wrong one.
function prepOpTitle(courseCode, title, days) {
  const base = prepTitle({ code: courseCode, title });
  const lead = 'Prep · ';
  return base.startsWith(lead) ? `Prep ${days}d · ${base.slice(lead.length)}` : `Prep ${days}d · ${base}`;
}

// Which prep offsets an item earns. Keyed on the EFFECTIVE kind first: an item
// Canvas promoted to exam gets exam prep, not the project prep its mined
// category would have given it.
function checkpointOffsets(it, kind) {
  if (kind === 'exam') return CHECKPOINTS.exam;
  return CHECKPOINTS[String(it.category ?? '').toLowerCase()] || [];
}

// Normalize one mined item (or Canvas assignment fallback) into 0+ ops.
// `state` is this item's entry in user_state.json — the user's own marks win
// over anything the pipeline mined.
//
// `drops` collects every item that produced no due op and why. An item with a
// wrong-year date used to be indistinguishable from an item that did not exist:
// ENTR 222's "Mid-Semester Teamwork Survey" carries due_date 2025-10-15, a year
// off, and the only trace of it anywhere was the aggregate op count on stderr.
function opsForItem(it, {
  classSlug, courseCode, todayIso, minIso, maxIso, state = {},
  drops = null, scheduleCaveat = null, holidayDates = null,
}) {
  const ops = [];
  const kind = kindForItem(it);
  const note = (reason, date = null) => {
    if (drops) drops.push({ class: classSlug, item_id: it.id ?? null, title: it.title ?? null, kind, category: it.category ?? 'other', reason, date });
  };

  // A moved date keeps the original clock time unless the user set one too —
  // dragging a deadline to Wednesday does not make it stop being due at 11:59.
  const dueTime = state.timeOverride ?? it.due_time ?? null;

  // Done means done: no deadline event, and no prep sessions for work that is
  // already finished.
  //
  // The drop record has to carry more than a reason, though. CALENDAR-SPEC 2.5:
  // a ticked item disappears from the worklist on the next rebuild, so its row
  // and its checkbox vanish together and a mis-tick can never be undone from
  // the calendar — the one control the user asked for by name. The UI's "Show
  // completed" toggle re-renders these rows, so this record carries everything
  // a row needs to draw itself and POST {done:false}: where to file it (class,
  // item_id), what to say (title, kind, category), where to put it (date, time,
  // all_day) and where its links go (url, submit_url). Recording is not
  // resurrecting: the item still produces no op.
  if (state.done) {
    if (drops) {
      drops.push({
        class: classSlug,
        item_id: it.id ?? null,
        title: it.title ?? null,
        // The title the op WOULD have carried, so a completed row reads
        // identically to the live rows it sits among ("BUSI 305 · HW 3") rather
        // than reverting to the raw mined title next to them.
        event_title: dueTitle({ code: courseCode, title: it.title, category: it.category }),
        kind,
        category: it.category || 'other',
        reason: 'done',
        date: state.dueOverride || it.due_date || null,
        time: dueTime,
        all_day: !dueTime,
        url: it.html_url || null,
        submit_url: it.submit_url || null,
        origin: originOf(it),
        done_at: state.doneAt ?? null,
      });
    }
    return ops;
  }

  const dueDate = state.dueOverride || it.due_date;
  const canvasId = it.canvas_assignment_id != null ? String(it.canvas_assignment_id) : null;
  const itemRef = canvasId ? `a${canvasId}` : it.id;

  const inWindow = dueDate && dueDate >= minIso && dueDate <= maxIso;
  if (!dueDate) note('undated', null);
  else if (!inWindow) note('out_of_window', dueDate);

  if (inWindow) {
    const descLines = [];
    if (it.description) descLines.push(it.description);
    if (it.points_possible != null) descLines.push(`Points: ${it.points_possible}`);
    if (it.weight_note) descLines.push(`Weight: ${it.weight_note}`);
    if (state.note) descLines.push(`Note: ${state.note}`);
    if (state.flag === 'priority') descLines.push('Flagged: priority');
    if (state.flag === 'blocked') descLines.push('Flagged: blocked');
    if (state.dueOverride) descLines.push(`Moved by you from ${it.due_date ?? 'no date'}.`);
    if (it.html_url) descLines.push(it.html_url);
    if (it.submit_url && it.submit_url !== it.html_url) descLines.push(`Submit: ${it.submit_url}`);
    if (!state.dueOverride && it.due_confidence && it.due_confidence !== 'high') {
      descLines.push(`Date confidence: ${it.due_confidence} — verify.`);
    }
    // The parser already told us when it was guessing; the calendar is the one
    // place that never repeated it. ECON 205's eleven lecture dates and its
    // final-exam date exist in no source — the parser said so in
    // extraction_notes and still reported confidence "high", and every op came
    // out looking like fact. A Canvas-backed date is exempt: Canvas states it.
    if (scheduleCaveat && !canvasId && !state.dueOverride) descLines.push(scheduleCaveat);
    const desc = descLines.join('\n');
    const hash = shortHash(it.title, dueDate, dueTime, desc);
    const marker = canvasId
      ? `[csync:a|${canvasId}|${hash}]`
      : `[csync:s|${classSlug}|${it.id}|${hash}]`;

    ops.push(markerOp(marker, {
      calendar: 'due',
      kind,
      title: dueTitle({ code: courseCode, title: it.title, category: it.category }),
      date: dueDate,
      time: dueTime || null,
      all_day: !dueTime,
      description: desc,
      category: it.category || 'other',
      class: classSlug,
      // Carried as fields (not just inside the description) so the dashboard
      // can render Open/Submit without re-parsing prose.
      url: it.html_url || null,
      submit_url: it.submit_url || null,
      item_id: it.id ?? null,
      origin: originOf(it),
    }));
  }


  // Checkpoints the user set themselves. They replace the automatic ones for
  // that item — someone who has planned their own prep does not also want ours.
  const userCps = Array.isArray(state.checkpoints) ? state.checkpoints : [];
  // Ids of prep blocks the user has ticked off. `checkpoints[].done` is where a
  // user-authored block records it; `checkpointsDone` is where a tick on an
  // AUTOMATIC block goes, because those exist only as an offset from the due
  // date and there is no row in user_state.json to set a flag on. One set here
  // so both kinds are asked the same question.
  const doneCps = new Set(Array.isArray(state.checkpointsDone) ? state.checkpointsDone : []);
  // CALENDAR-SPEC 2.5 applies to a prep block word for word: tick one and the
  // row and its checkbox vanish together on the next rebuild unless the drop
  // carries enough to draw the completed row and POST the un-tick.
  const noteDoneCp = (cp, id) => {
    if (!drops) return;
    drops.push({
      class: classSlug,
      item_id: it.id ?? null,
      checkpoint_id: id,
      title: cp.title ?? null,
      event_title: checkpointTitle({ code: courseCode, title: cp.title }),
      kind: 'checkpoint',
      category: it.category || 'other',
      reason: 'done',
      date: cp.date ?? null,
      time: cp.time || null,
      all_day: !cp.time,
      url: it.html_url || null,
      submit_url: null,
      origin: originOf(it),
    });
  };
  if (userCps.length) {
    for (const cp of userCps) {
      if (cp.done || doneCps.has(cp.id)) { noteDoneCp(cp, cp.id); continue; }
      if (!cp.date || cp.date < minIso || cp.date > maxIso) continue;
      // The parent's due date is IN the description below, so it must be in
      // the hash: a moved deadline otherwise regenerates an identical marker
      // and the routine ("full marker matches exactly → skip") leaves the
      // calendar event asserting the old date forever. The auto-prep block's
      // hash already does this.
      const hash = shortHash(cp.title, cp.date, cp.time, it.title, dueDate ?? '', dueTime ?? '');
      const marker = `[csync:s|${classSlug}|${itemRef}@${cp.id}|${hash}]`;
      ops.push(markerOp(marker, {
        calendar: 'checkpoint',
        kind: 'checkpoint',
        title: checkpointTitle({ code: courseCode, title: cp.title }),
        date: cp.date,
        time: cp.time || null,
        all_day: !cp.time,
        description: `Checkpoint for "${it.title}"${dueDate ? ` — due ${dueDate}${dueTime ? ` ${dueTime}` : ''}` : ''}.${it.html_url ? `\n${it.html_url}` : ''}`,
        category: it.category || 'other',
        class: classSlug,
        // What the calendar's checkbox POSTs. CALENDAR-SPEC 2.9: without an id
        // to name, a prep block is the one kind of work the user cannot tick
        // off from the calendar they plan it on.
        item_id: it.id ?? null,
        checkpoint_id: cp.id,
        // A prep block is FOR something — carry where that something lives, so
        // the calendar can open it. CALENDAR-SPEC 2.12.
        url: it.html_url || null,
        origin: originOf(it),
      }));
    }
    return ops;
  }

  if (!inWindow) return ops;
  for (const days of checkpointOffsets(it, kind)) {
    const prepDate = isoAddDays(dueDate, -days);
    if (prepDate < todayIso || prepDate > maxIso) continue;
    // A prep block on Midterm Recess or Thanksgiving is a work session the
    // student is not there for. Only dates at least two synced classes call a
    // holiday count — one class's "no class" is the professor cancelling, two
    // is the university closing. On this data that is 2026-10-13 and
    // 2026-11-26, which is exactly where two prep blocks used to land.
    if (holidayDates?.has(prepDate)) {
      if (drops) drops.push({ class: classSlug, item_id: it.id ?? null, title: it.title ?? null, kind: 'checkpoint', category: it.category ?? 'other', reason: 'holiday', date: prepDate });
      continue;
    }
    // An automatic block's stable identity is its OFFSET, not its date: moving
    // the deadline moves the block, and a tick has to move with it rather than
    // being stranded on the day the block used to fall.
    const autoCpId = `auto:${days}d`;
    if (doneCps.has(autoCpId)) {
      if (drops) {
        drops.push({
          class: classSlug,
          item_id: it.id ?? null,
          checkpoint_id: autoCpId,
          title: it.title ?? null,
          event_title: prepOpTitle(courseCode, it.title, days),
          kind: 'checkpoint',
          category: it.category || 'other',
          reason: 'done',
          date: prepDate,
          time: null,
          all_day: true,
          url: it.html_url || null,
          submit_url: null,
          origin: originOf(it),
        });
      }
      continue;
    }
    const prepHash = shortHash(it.title, prepDate, '', dueDate);
    const marker = `[csync:s|${classSlug}|${itemRef}+${days}d|${prepHash}]`;
    ops.push(markerOp(marker, {
      calendar: 'checkpoint',
      kind: 'checkpoint',
      // The offset belongs in the title. The 5-day and the 1-day block for one
      // exam were byte-identical apart from the date, so on a calendar the pair
      // read as the same event duplicated — and neither said which was which.
      title: prepOpTitle(courseCode, it.title, days),
      date: prepDate,
      time: null,
      all_day: true,
      description: `Work session ${days} day${days === 1 ? '' : 's'} before "${it.title}" — due ${dueDate}${dueTime ? ' ' + dueTime : ''}.${it.html_url ? `\n${it.html_url}` : ''}`,
      category: it.category || 'other',
      class: classSlug,
      days_before: days,
      item_id: it.id ?? null,
      checkpoint_id: autoCpId,
      // A prep block is FOR something — carry where that something lives, so
      // the calendar can open it. CALENDAR-SPEC 2.12.
      url: it.html_url || null,
      origin: originOf(it),
    }));
  }
  return ops;
}

// A session's identity for the marker prefix.
//
// The prefix used to be `[csync:m|<slug>|<date>#<n>|`, i.e. the date was INSIDE
// the part the routine matches on — and the routine is forbidden to delete.
// So correcting a lecture's date did not move the event, it created a second
// one and abandoned the first: BUSI 305's 16 Monday lectures, ENTR 222's ghost
// Sep 3 and BUSI 374's recess lecture are all expected to move once the parser
// is fixed, which under the old scheme meant 19 permanent orphans on the user's
// real calendar. Due and checkpoint markers never had this problem because
// theirs are keyed on the Canvas id or the item id, not on when it happens.
//
// A syllabus session's stable identity is its topic ("Transaction analysis"),
// so that is the key; the date moves into the hash, where a change means UPDATE
// instead of CREATE. A session with no topic has nothing else to be identified
// by and keeps the date — for those the old failure mode remains, and that is
// the honest limit of what we know about them.
function sessionKey(m, used) {
  const topic = String(m.topic ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const base = topic ? `t:${topic}` : `d:${m.date}`;
  const n = (used.get(base) ?? 0) + 1;
  used.set(base, n);
  return n > 1 ? `${base}#${n}` : base;
}

// Class meetings: one op per dated meeting, or a single weekly recurring op
// when the syllabus gives a pattern but no dates.
function opsForMeetings({
  classSlug, courseCode, syllabusParsed, canvasEvents, minIso, maxIso,
  patterns = null, timeWarnings = null, holidayDates = null, refused = null,
  instructor = null,
}) {
  const ops = [];
  const meetings = collectMeetings({ syllabusParsed, canvasEvents, patterns, refused })
    .filter(m => m.date >= minIso && m.date <= maxIso);

  // Known days, unknown hour. recoverMeetingTimes already produces exactly this
  // warning ("The syllabus names the days but never states a time.") and the
  // calendar used to throw it away, leaving a bare all-day bar that asserts
  // "this class meets today" with no hint the hour is unknown — and leaving the
  // routine, whose instruction says "create a real timed event", nothing to do
  // but invent a start. NO TIME BEATS A WRONG TIME: the honest rendering of
  // days-without-a-time is an all-day marker that says why it is all-day.
  const unknownTime = [
    'Time unknown — this is an all-day marker, not a claim about the hour.',
    ...(Array.isArray(timeWarnings) ? timeWarnings : []),
  ].join(' ');

  const used = new Map();
  for (const m of meetings) {
    const descLines = [];
    // The title is now exactly the three fields the user named — room, class,
    // professor — so the session label ("Lecture", "Lab", "Week of Sep 7") and
    // the topic ("Transaction analysis") that used to BE the title have nowhere
    // else to live. All 106 meeting ops carried them in the title and in no
    // other field, so they lead the description instead of being lost: a topic
    // is genuinely useful, it is just not one of the three fields asked for.
    const label = String(m.label ?? '').trim();
    const topic = String(m.topic ?? '').trim();
    if (label && topic && label.toLowerCase() !== topic.toLowerCase()) descLines.push(`${label}: ${topic}`);
    else if (topic || label) descLines.push(topic || label);
    if (m.location) descLines.push(`Location: ${m.location}`);
    if (!m.start && !m.holiday) descLines.push(unknownTime);
    if (m.tentative) descLines.push('Tentative — the syllabus marks this schedule as subject to change.');
    // Two synced classes calling this date a holiday means the university is
    // shut. BUSI 374's "Quality Management" lecture on 2026-10-12 came from a
    // week-range label, and 10/12–10/13 is Rice's midterm recess.
    if (!m.holiday && holidayDates?.has(m.date)) {
      descLines.push('Other synced classes mark this date as a holiday — verify this session happens.');
    }
    descLines.push(`Source: ${m.source}.`);
    const desc = descLines.join('\n');
    // "Virani 182 - BUSI380 - VanHorn". A no-class day keeps the label instead:
    // naming the room and the professor for a session that does not happen is
    // three fields of noise about an event the student must not turn up to.
    // `holiday` is the flag the syllabus path sets; the label is the row's own
    // words, and a Canvas event that says "No Class - Fall Break" only ever had
    // the words. Asking both means neither source can slip a cancelled session
    // through as a room with a professor in it.
    const noClass = m.holiday === true || labelSaysNoClass(m.label);
    const title = noClass
      ? meetingTitle({ code: courseCode, label: 'No class' })
      : meetingTitle({ code: courseCode, label: m.label, location: m.location, instructor });
    const hash = shortHash(title, m.date, m.start, desc);
    const marker = `[csync:m|${classSlug}|${sessionKey(m, used)}|${hash}]`;
    ops.push(markerOp(marker, {
      calendar: 'meeting',
      kind: 'meeting',
      title,
      date: m.date,
      time: m.start || null,
      end_time: m.end || null,
      all_day: !m.start,
      // Says out loud what all_day already implies, because the routine reads
      // ops one at a time and "no time" has to be a fact it can act on rather
      // than an absence it has to interpret.
      time_known: Boolean(m.start),
      // Same normalisation the title uses, so the event's location field cannot
      // say "-" while the title correctly says nothing.
      location: noClass ? null : roomName(m.location),
      description: desc,
      category: noClass ? 'holiday' : 'meeting',
      class: classSlug,
    }));
  }
  if (ops.length) return ops;

  // No dated schedule — fall back to the weekly pattern, as ONE recurring op
  // rather than dozens of guessed dates.
  const pattern = (patterns ?? [])[0] ?? null;
  if (!pattern || !pattern.start) return ops;
  const termEnd = syllabusParsed?.course?.term_end && /^\d{4}-\d{2}-\d{2}$/.test(syllabusParsed.course.term_end)
    ? syllabusParsed.course.term_end
    : maxIso;
  const title = meetingTitle({ code: courseCode, location: pattern.location, instructor });
  const desc = [
    pattern.location ? `Location: ${pattern.location}` : null,
    `Pattern: ${pattern.source}`,
    'No dated class schedule was found, so this is a weekly recurrence — check it against your section.',
  ].filter(Boolean).join('\n');
  const hash = shortHash(title, pattern.byday.join(','), pattern.start, desc);
  const marker = `[csync:m|${classSlug}|weekly|${hash}]`;
  // Anchor on a day the pattern actually meets — see firstOnByday.
  const anchor = firstOnByday(
    minIso > localIsoDate(new Date()) ? minIso : localIsoDate(new Date()),
    pattern.byday,
  );
  if (anchor > termEnd) return ops;
  ops.push(markerOp(marker, {
    calendar: 'meeting',
    kind: 'meeting',
    title,
    date: anchor,
    time: pattern.start,
    end_time: pattern.end,
    all_day: false,
    time_known: true,
    location: pattern.location || null,
    description: desc,
    category: 'meeting',
    class: classSlug,
    recurrence: { freq: 'WEEKLY', byday: pattern.byday, until: termEnd },
  }));
  return ops;
}

// When this class stops meeting. course.term_end is the answer when a syllabus
// states it; none of the six here do, so the last dated row of the schedule is
// the next best thing, and it is a date the professor wrote down.
function classTermEnd(syllabusParsed, maxIso) {
  const stated = syllabusParsed?.course?.term_end;
  if (/^\d{4}-\d{2}-\d{2}$/.test(stated ?? '') && stated <= maxIso) return stated;
  const rows = Array.isArray(syllabusParsed?.schedule) ? syllabusParsed.schedule : [];
  let last = null;
  for (const r of rows) {
    const d = typeof r?.date === 'string' ? r.date : null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(d ?? '') && (!last || d > last)) last = d;
  }
  return last && last <= maxIso ? last : maxIso;
}

/**
 * Office hours as weekly recurring ops — one per stated block.
 *
 * The parser has already refused everything it could not pin down, so anything
 * arriving here has a weekday, a start and an end. What is left to get right is
 * the WINDOW: BUSI 374 holds "M 10am-12:15pm; W 11am-12:15pm" until 10/5 and
 * "MW 11am-2:15pm" from 10/7, and a recurrence that ignores those dates puts
 * two contradictory office hours on every Monday of the term.
 *
 * Blocks the parser refused are recorded as drops with the professor's own
 * words attached, because "office hours: none" is a worse answer than "your
 * professor said something we would not repeat" — ECON 205 names a weekday and
 * an end time and no start, and the student should still be told that.
 */
function opsForOfficeHours({ classSlug, courseCode, syllabusParsed, minIso, maxIso, drops }) {
  const ops = [];
  const oh = officeHoursFor(syllabusParsed);
  // A Fall office hour does not recur into February. No syllabus in this corpus
  // states course.term_end, so the fallback is the last dated row of the class's
  // own schedule — a stated fact, not a guess — and only then the flat horizon.
  const termEnd = classTermEnd(syllabusParsed, maxIso);

  for (const r of oh.refused) {
    drops?.push({
      class: classSlug, item_id: null, title: r.clause,
      kind: 'office_hours', category: 'office_hours',
      reason: r.reason === 'implausible' ? 'implausible_time' : r.reason,
      date: null, detail: r.clause,
    });
  }
  // Appointment-only is not a failure to parse; it is the answer. Recorded so
  // the class page can say so instead of showing an unexplained zero — but not
  // alongside a more specific refusal, or ECON 205 reports the same sentence
  // twice under two different reasons.
  if (!oh.patterns.length && !oh.refused.length && oh.byAppointment) {
    drops?.push({
      class: classSlug, item_id: null,
      title: oh.text, kind: 'office_hours', category: 'office_hours',
      reason: 'by_appointment', date: null, detail: oh.text,
    });
  }

  for (const p of oh.patterns) {
    const span = resolveRange(p.range, minIso, termEnd);
    if (span.to < span.from) continue;
    const title = officeHoursTitle(courseCode, oh.instructor, p.location);
    const desc = [
      `Office hours: ${describeOfficeHours(p)}.`,
      p.location ? `Location: ${p.location}` : null,
      span.ranged ? `Stated for ${span.from} to ${span.to}.` : null,
      oh.byAppointment ? 'Appointments are also offered outside these hours.' : null,
      oh.email ? `Contact: ${oh.email}` : null,
      // The professor's exact words, once, at the bottom. Every reformatting
      // above is this file's reading of them; this is the source.
      oh.text ? `Syllabus: ${oh.text}` : null,
    ].filter(Boolean).join('\n');
    const hash = shortHash(title, p.byday.join(','), `${p.start}-${p.end}`, `${span.from}..${span.to}`, desc);
    // The prefix keys on the weekly slot, not on the date the recurrence starts:
    // a term that shifts by a day must update the event, not create a second one.
    const marker = `[csync:h|${classSlug}|${p.byday.join('')}@${p.start}|${hash}]`;
    // Anchor on a day the pattern actually meets — see firstOnByday. A window
    // the snap pushes past its own end has no occurrences left to show.
    const anchor = firstOnByday(span.from, p.byday);
    if (anchor > span.to) continue;
    ops.push(markerOp(marker, {
      calendar: KIND_CALENDAR.office_hours,
      kind: 'office_hours',
      title,
      date: anchor,
      time: p.start,
      end_time: p.end,
      all_day: false,
      time_known: true,
      location: p.location || null,
      description: desc,
      category: 'office_hours',
      class: classSlug,
      recurrence: { freq: 'WEEKLY', byday: p.byday, from: span.from, until: span.to },
    }));
  }
  return ops;
}

// "Herring 129 - BUSI374 Office hours - VanHorn", in the same grammar
// meetingTitle uses, because these land on the same calendar and sit in the
// same day column as the lectures. cal-names owns every reduction in it, so a
// change to how course codes or instructors are shortened cannot make office
// hours and lectures disagree.
function officeHoursTitle(courseCode, instructor, location) {
  const short = compactCourseCode(courseCode);
  const parts = [
    roomName(location),
    short ? `${short} Office hours` : 'Office hours',
    instructorSurname(instructor),
  ].filter(Boolean);
  return clip(parts.join(' - '));
}



// Why an item never became an event, phrased so a UI can print it unchanged.
// Every one of these strings is already a fact the pipeline recorded as a
// reason code; the codes are what `unscheduled` counts, and a count is not a
// reason. `done` is deliberately in here: a kind showing zero because the work
// is finished is a different answer from a kind showing zero because nothing
// could be dated, and the student is owed the difference.
//
// Singular and plural both spelled out, because the counts here really are
// plural on the live data — BUSI 396 refuses four rows at once — and "4 class
// meetings is a module or unit boundary" is the kind of sentence that makes a
// student stop reading the explanation.
const DROP_REASON = {
  recurring: ['recurs on no fixed date', 'recur on no fixed date'],
  undated: ['has no date in any source', 'have no date in any source'],
  out_of_window: ['falls outside the calendar window', 'fall outside the calendar window'],
  holiday: ['lands on a day at least two classes call a holiday', 'land on a day at least two classes call a holiday'],
  module_boundary: [
    'is a module or unit boundary heading a date range, not a class session',
    'are module or unit boundaries heading date ranges, not class sessions',
  ],
  not_a_session: ['is a syllabus row that is not a class session', 'are syllabus rows that are not class sessions'],
  done: ['is already done', 'are already done'],
  // Office hours. Each of these is the professor's own words failing to state a
  // schedule, and the student is owed the difference between "your professor
  // did not say" and "we could not read what they said".
  by_appointment: ['is offered by appointment only', 'are offered by appointment only'],
  no_time: [
    'names a day but no start time, so no hour could be put on it',
    'name a day but no start time, so no hour could be put on them',
  ],
  no_day: ['states a time but no weekday', 'state a time but no weekday'],
  implausible_time: [
    'states a span too long to be an office hour',
    'state spans too long to be office hours',
  ],
};

function pick(forms, n, fallback) {
  const [one, many] = forms ?? fallback;
  return n === 1 ? one : many;
}

function kindNoun(kind, n) {
  return pick(KIND_NOUN[kind], n, [kind, `${kind} items`]);
}

/**
 * One sentence saying why a kind produced no events. `where` completes
 * "no readings to schedule<where>".
 *
 * CALENDAR-SPEC 4.5 and 4.6 both ask for the same thing in different places: a
 * toggle or a class column that shows nothing has to say WHY, in words, or the
 * user reads it as the feature being broken. `reading` is the extreme case —
 * the entire corpus holds one reading, BUSI 305's "Pre-class Readings", it is
 * `recurring: "before each class"` with no date, and recurring items are routed
 * to notes before ops are built. The switch is on, it is honest, and it can
 * never produce an event; without this it says so nowhere.
 */
function kindNote(kind, reasons, { where }) {
  const label = KIND_LABELS[kind] ?? kind;
  const parts = Object.entries(reasons)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => {
      const why = pick(DROP_REASON[reason], n, [`was dropped (${reason.replace(/_/g, ' ')})`, `were dropped (${reason.replace(/_/g, ' ')})`]);
      return `${n} ${kindNoun(kind, n)} ${why}`;
    });
  if (!parts.length) return `${label}: none on the calendar — no ${kindNoun(kind, 2)} to schedule${where}.`;
  return `${label}: none on the calendar — ${parts.join('; ')}.`;
}

function renderWorklistMd(worklist) {
  const { generated_at, calendars, classes, ops, recurring_notes } = worklist;
  const lines = [];
  lines.push('# Calendar worklist (canvas-sync)');
  lines.push('');
  lines.push(`Generated ${generated_at}. Classes: ${classes.join(', ') || 'none'}.`);
  lines.push('');
  lines.push('## Instructions for the calendar routine');
  lines.push('');
  lines.push(`- Three target calendars: **due** (${calendars.due || 'your configured due-dates calendar'}), **checkpoint** (${calendars.checkpoint || 'your configured checkpoints/prep calendar'}) and **meeting** (${calendars.meeting || 'falls back to the due calendar if you have no class-schedule calendar'}).`);
  lines.push(`- First list existing events in ${worklist.window.from} → ${worklist.window.to} on those calendars and index them by the \`[csync:...]\` marker on the last line of each description.`);
  lines.push('- For each op below: if no event matches its `marker_prefix`, CREATE the event (description must end with the full `marker` line). If an event matches the prefix but its marker hash differs, UPDATE that event in place (title/date/time/description, refresh the marker). If the full marker matches exactly, skip — nothing changed.');
  lines.push('- NEVER delete events, even ones with csync markers that have no matching op — class cleanup is a separate, explicit flow.');
  lines.push('- Timed due/checkpoint ops: create a 15-minute event ending at the due time. All-day ops: all-day event on `date`.');
  lines.push('- Meeting ops carry `end_time` and often `location`: create a real timed event from `time` to `end_time` and set the event location. If a meeting op has `recurrence`, create ONE weekly recurring event (`byday`, until `recurrence.until`) instead of separate events.');
  lines.push('- A meeting op with `"time": null` (`"time_known": false`) means the day is known and the hour is NOT. Create an ALL-DAY event on `date`. Never invent a start time for it — the description says why the hour is unknown, and that is the answer the student needs.');
  lines.push('');
  lines.push('- Office-hours ops (`"kind": "office_hours"`) are weekly recurrences like meetings, but they carry `recurrence.from` as well as `recurrence.until`: a professor who holds different hours before and after the midterm states both, and the two must not overlap.');
  lines.push('');
  if (recurring_notes.length) {
    lines.push('## Recurring obligations (not auto-scheduled — review manually)');
    lines.push('');
    for (const n of recurring_notes) lines.push(`- ${n}`);
    lines.push('');
  }
  // What did NOT become an op, and why. Without it "0 homework" for a class
  // holding twelve undated weekly assignments reads as "nothing due".
  const unsched = Object.entries(worklist.unscheduled ?? {}).filter(([, c]) => Object.values(c).some(Boolean));
  if (unsched.length) {
    lines.push('## Items with no calendar event');
    lines.push('');
    for (const [slug, c] of unsched) {
      const parts = Object.entries(c).filter(([, n]) => n > 0).map(([reason, n]) => `${n} ${reason.replace(/_/g, ' ')}`);
      lines.push(`- ${slug}: ${parts.join(', ')}`);
    }
    lines.push('');
  }
  // A kind or a class that produced nothing, in one sentence each. The routine
  // reads this file top to bottom and used to be told only what to create — so
  // "BUSI 396" and "readings" simply did not appear, which is indistinguishable
  // from a class with no schedule and a student with no readings.
  const kindLines = [];
  for (const k of KINDS) {
    const kn = worklist.kind_notes?.[k];
    if (!kn) continue;
    if (kn.note) { kindLines.push(`- ${kn.note}`); continue; }
    for (const [slug, note] of Object.entries(kn.classes ?? {})) {
      // Only where something was actively refused: "no readings to schedule in
      // this class" repeated six times is noise, "4 module boundaries" is not.
      if (!worklist.dropped.some(d => d.class === slug && d.kind === k)) continue;
      kindLines.push(`- ${slug} — ${note}`);
    }
  }
  if (kindLines.length) {
    lines.push('## Kinds and classes that produced nothing, and why');
    lines.push('');
    lines.push(...kindLines);
    lines.push('');
  }
  lines.push(`## Operations (${ops.length})`);
  lines.push('');
  for (const op of ops) {
    lines.push(`### ${op.title}`);
    lines.push(`- calendar: ${op.calendar}`);
    lines.push(`- date: ${op.date}${op.time ? ` ${op.time}${op.end_time ? `–${op.end_time}` : ''}` : ' (all day)'}`);
    if (op.location) lines.push(`- location: ${op.location}`);
    if (op.recurrence) lines.push(`- recurrence: weekly on ${op.recurrence.byday.join(',')} until ${op.recurrence.until}`);
    if (op.description) lines.push(`- description: ${op.description.replace(/\n/g, ' / ')}`);
    // The routine builds the calendar event from this markdown, so the links
    // have to be fields here too — not only in the JSON the dashboard reads.
    if (op.url) lines.push(`- url: ${op.url}`);
    if (op.submit_url && op.submit_url !== op.url) lines.push(`- submit_url: ${op.submit_url}`);
    lines.push(`- marker: \`${op.marker}\``);
    lines.push(`- marker_prefix: \`${op.marker_prefix}\``);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// When assignments_mined.json was last written, or null. Used only to detect a
// build that read a file mining then replaced underneath it.
async function minedMtime(classDir) {
  try { return (await stat(join(classDir, 'assignments_mined.json'))).mtimeMs; } catch { return null; }
}

/**
 * Build the calendar worklist.
 *
 * `write: false` computes everything and touches nothing. It exists because
 * this function is the only way to ask "what would the calendar say?", and
 * asking used to cost the user their real `calendar/worklist.json`: four
 * helper scripts pointed at the live classes dir on 2026-08-24 and each one
 * silently rewrote worklist.json, worklist.md and ROUTINE.md as a side effect
 * of a read. A question must not be able to change the answer.
 */
export async function buildWorklist(baseDirOverride = null, { allowRetry = true, write = true } = {}) {
  const classesDir = baseDirOverride || classHome();
  const baseDir = dirname(classesDir);
  const now = new Date();
  const todayIso = localIsoDate(now); // local date, not UTC — near-midnight runs must not shift the window
  const minIso = isoAddDays(todayIso, -PAST_GRACE_DAYS);
  const maxIso = isoAddDays(todayIso, HORIZON_DAYS);

  let folders = [];
  try {
    folders = (await readdir(classesDir)).filter(n => CLASS_DIR_RE.test(n));
  } catch {
    return null;
  }

  // Old semesters and Canvas's permanent orientation shells ("Emergency
  // Information", "Power of Persuasion") are still active enrollments, so
  // without this their assignments landed in the worklist — and from there in
  // the user's real calendar. Scope comes off disk; unknown scope keeps all.
  const scope = readSyncScope(baseDir);
  if (scope.courseIds) folders = folders.filter(f => isInScope(scope, f));

  // Pass 1: read every class off disk before emitting anything. Two of the
  // checks below are cross-class — a date is only an institutional holiday if
  // more than one class says so — and they cannot be made while the first class
  // is still being turned into ops.
  const contexts = [];
  for (const folder of folders) {
    const classDir = join(classesDir, folder);
    const classSlug = classSlugOf(folder);
    const metadata = await readJsonSafe(join(classDir, 'metadata.json')) || {};
    const syllabusParsed = await readJsonSafe(join(classDir, 'syllabus_parsed.json'));
    contexts.push({
      classDir,
      classSlug,
      courseCode: metadata.course_code || metadata.course?.code || classSlug.toUpperCase(),
      // Read once per class, here, because it is a property of the course and
      // not of a session: all six of this user's classes populate
      // course.instructor.name, and every one of their meetings wants the same
      // surname on it (CALENDAR-SPEC 4.3). meetingTitle reduces it — passing
      // the raw field is what §4.3 specifies as the source.
      instructor: syllabusParsed?.course?.instructor?.name ?? null,
      userState: (await readUserState(classDir)).items ?? {},
      canvasAssignments: await readJsonSafe(join(classDir, 'assignments.json')),
      mined: await readJsonSafe(join(classDir, 'assignments_mined.json')),
      minedMtime: await minedMtime(classDir),
      syllabusParsed,
      canvasEvents: await readJsonSafe(join(classDir, 'calendar_events.json')),
    });
  }

  // A date at least two synced classes call a holiday is the university being
  // shut, not one professor cancelling. On this data that is 2026-10-13
  // (Midterm Recess) and 2026-11-26 (Thanksgiving) — both dates that carried
  // work the student could not have done.
  const holidayVotes = new Map();
  for (const ctx of contexts) {
    const rows = Array.isArray(ctx.syllabusParsed?.schedule) ? ctx.syllabusParsed.schedule : [];
    const own = new Set();
    for (const e of rows) {
      if (String(e?.type ?? '').toLowerCase() !== 'holiday') continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.date ?? ''))) continue;
      own.add(e.date);
    }
    for (const d of own) holidayVotes.set(d, (holidayVotes.get(d) ?? 0) + 1);
  }
  const holidayDates = new Set([...holidayVotes].filter(([, n]) => n >= 2).map(([d]) => d));

  const ops = [];
  const recurringNotes = [];
  const drops = [];
  const classSlugs = [];

  // Pass 2: ops.
  for (const ctx of contexts) {
    const { classDir, classSlug, courseCode, instructor, userState, canvasAssignments, mined, syllabusParsed, canvasEvents } = ctx;
    classSlugs.push(classSlug);

    const { items } = tasksForClass({ mined, assignments: canvasAssignments });
    for (const it of items) {
      if (!it.recurring) continue;
      recurringNotes.push(`${shortCourseCode(courseCode)}: ${it.title} — ${it.recurring}${it.description ? ` (${it.description})` : ''}`);
      // Counted as a drop as well as noted. A recurring obligation with no date
      // is correctly unschedulable — BUSI 305's twelve MBC homeworks and ECON
      // 205's six problem sets are 15% of a grade between them — but the class
      // page showed "0 homework" either way, with no means to tell "nothing due"
      // from "we could not date it".
      drops.push({ class: classSlug, item_id: it.id ?? null, title: it.title ?? null, kind: kindForItem(it), category: it.category ?? 'other', reason: 'recurring', date: it.due_date ?? null });
    }

    const caveat = scheduleCaveatFor(syllabusParsed);

    for (const it of items) {
      if (it.recurring) continue;
      ops.push(...opsForItem(it, {
        classSlug, courseCode, todayIso, minIso, maxIso,
        state: userState[it.id] ?? {},
        drops, holidayDates, scheduleCaveat: caveat,
      }));
    }

    {
      // Days and times come from the recovery chain — the user's override
      // first, then the syllabus field, then its full text, then Canvas — so
      // the calendar and the class page agree on when this class meets. Its
      // `warnings` are carried through too: they are the only place that says
      // WHY a meeting has no time.
      const recovered = await recoverMeetingTimes(classDir).catch(() => null);
      // Rows cal-meetings refuses to turn into a session are collected rather
      // than dropped on the floor. BUSI 396's four "Module N ... Begins" rows
      // are date RANGES, not meetings — suppressing them is right — but the
      // class then reported zero meetings with no trace of four real dated
      // syllabus facts anywhere in worklist.json or worklist.md.
      const refusedRows = [];
      ops.push(...opsForMeetings({
        classSlug, courseCode, instructor, minIso, maxIso,
        patterns: recovered?.patterns ?? null,
        timeWarnings: recovered?.warnings ?? null,
        syllabusParsed, canvasEvents, holidayDates, refused: refusedRows,
      }));
      for (const r of refusedRows) {
        drops.push({
          class: classSlug, item_id: null, title: r.title,
          kind: 'meeting', category: 'meeting',
          reason: r.reason ?? 'not_a_session', date: r.date ?? null,
          detail: r.detail ?? null,
        });
      }
    }

    // Office hours. A standing weekly commitment stated on every syllabus in
    // this corpus and on nobody's calendar.
    ops.push(...opsForOfficeHours({
      classSlug, courseCode, syllabusParsed, minIso, maxIso, drops,
    }));
  }

  // Did mining move a file out from under us? The live worklist was generated
  // at 18:11:26Z while mine-assignments was still running for three of six
  // classes (BUSI 305 finished 18:11:55, ECON 205 18:12:19, BUSI 380 18:16:10),
  // so it went out missing five real exams and ten checkpoints, and a rebuild
  // four minutes later disagreed with it by 17 ops. Writes are atomic, so this
  // is staleness, not corruption — and the cure is simply to read again. One
  // retry only: a pipeline that never settles must still produce a worklist.
  const moved = [];
  for (const ctx of contexts) {
    if (await minedMtime(ctx.classDir) !== ctx.minedMtime) moved.push(ctx.classSlug);
  }
  if (moved.length && allowRetry) {
    process.stderr.write(`Calendar worklist: mining rewrote ${moved.join(', ')} mid-build — rebuilding once.\n`);
    return buildWorklist(baseDirOverride, { allowRetry: false, write });
  }
  if (moved.length) {
    process.stderr.write(`Calendar worklist: mining is still writing ${moved.join(', ')} — this worklist may be a mid-pipeline snapshot.\n`);
  }

  ops.sort((a, b) => a.date.localeCompare(b.date)
    || String(a.time ?? '').localeCompare(String(b.time ?? ''))
    || a.title.localeCompare(b.title));

  const counts = Object.fromEntries(KINDS.map(k => [k, ops.filter(o => o.kind === k).length]));

  // Per class, per reason: what the class page needs to say "9 items, none
  // dated" instead of showing an empty column.
  const unscheduled = {};
  for (const d of drops) {
    const slot = unscheduled[d.class] ??= {
      recurring: 0, undated: 0, out_of_window: 0, done: 0, holiday: 0,
      // A syllabus row that is genuinely not a class session — a module or unit
      // boundary heading a date range. Counted separately from `undated`
      // because it is not work waiting for a date; it is a row that should
      // never have become an event, and the count is here so a class showing
      // zero meetings can point at the four dates it refused.
      module_boundary: 0,
    };
    slot[d.reason] = (slot[d.reason] ?? 0) + 1;
  }
  // Per kind, so a toggle showing zero can say WHY it is zero. `reading` is the
  // case that forced this: the corpus holds exactly one reading, BUSI 305's
  // "Pre-class Readings", and it is `recurring: "before each class"` with no
  // date — correctly unschedulable, but a switch that reads "Readings: on" and
  // changes nothing is a switch the user stops believing.
  const unscheduledByKind = Object.fromEntries(KINDS.map(k => [k, drops.filter(d => d.kind === k && d.reason !== 'done').length]));

  // …and the same thing again in words, because a number is not a reason.
  // `kind_notes[kind].note` is the line a dead global toggle shows (readings:
  // 0 ops, 1 recurring undated item, forever); `kind_notes[kind].classes[slug]`
  // is the line an empty class column shows (BUSI 396: 0 meetings, 4 module
  // boundaries). Both are complete sentences so the UI prints them verbatim
  // rather than assembling prose out of reason codes it would have to know.
  const kindNotes = {};
  for (const kind of KINDS) {
    const classes = {};
    for (const ctx of contexts) {
      if (ops.some(o => o.kind === kind && o.class === ctx.classSlug)) continue;
      const reasons = {};
      for (const d of drops) {
        if (d.class !== ctx.classSlug || d.kind !== kind) continue;
        reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
      }
      const note = kindNote(kind, reasons, { where: ' in this class' });
      if (note) classes[ctx.classSlug] = note;
    }
    const globalReasons = {};
    if (!counts[kind]) {
      for (const d of drops) {
        if (d.kind !== kind) continue;
        globalReasons[d.reason] = (globalReasons[d.reason] ?? 0) + 1;
      }
    }
    kindNotes[kind] = {
      ops: counts[kind],
      note: counts[kind] ? null : kindNote(kind, globalReasons, { where: ' in any synced class' }),
      classes,
    };
  }

  // The window is the range the routine lists and indexes existing events over,
  // on every target calendar, on every run. A flat 180-day horizon made a Fall
  // worklist claim 2026-08-17 → 2027-02-20 while its last op was 2026-12-15 —
  // two months of Spring it has nothing to say about. Clamp it to the ops, plus
  // a fortnight so an event nudged later still falls inside.
  const lastOpDate = ops.reduce((m, o) => (o.date > m ? o.date : m), todayIso);
  const windowTo = ops.length
    ? [isoAddDays(lastOpDate, 14), maxIso].sort()[0]
    : maxIso;

  const worklist = {
    generated_at: now.toISOString(),
    window: { from: minIso, to: windowTo, horizon: maxIso },
    calendars: {
      due: process.env.CSYNC_CAL_DUE || null,
      checkpoint: process.env.CSYNC_CAL_CHK || null,
      meeting: process.env.CSYNC_CAL_MEET || null,
    },
    classes: classSlugs,
    // What each class's mined file said when this was built, so a consumer can
    // tell a worklist that predates the last mine from one that followed it.
    mined_at: Object.fromEntries(contexts.map(c => [c.classSlug, c.minedMtime ? new Date(c.minedMtime).toISOString() : null])),
    mining_in_flight: moved,
    // The vocabulary travels with the artifact. The dashboard's filter row is
    // built from this, so a kind added to calendar-kinds.js appears as a chip
    // without the page having to know anything about kinds itself.
    kind_labels: KIND_LABELS,
    counts,
    holidays: [...holidayDates].sort(),
    recurring_notes: recurringNotes,
    unscheduled,
    unscheduled_by_kind: unscheduledByKind,
    kind_notes: kindNotes,
    dropped: drops,
    ops,
  };

  // A date far outside the window is not a past deadline, it is a typo in the
  // year: ENTR 222's "Mid-Semester Teamwork Survey" is dated 2025-10-15, a
  // stale syllabus header the miner copied. A genuinely past assignment is
  // uninteresting and stays quiet; this band is worth a line on stderr.
  for (const d of drops) {
    if (d.reason !== 'out_of_window' || !d.date) continue;
    if (d.date >= isoAddDays(minIso, -60) && d.date <= isoAddDays(maxIso, 60)) continue;
    process.stderr.write(`Calendar worklist: ${d.class} "${d.title}" is dated ${d.date}, far outside ${minIso}..${maxIso} — probably a wrong year.\n`);
  }

  if (!write) return worklist;

  const calDir = join(baseDir, 'calendar');
  await atomicWriteJson(join(calDir, 'worklist.json'), worklist);
  await atomicWriteText(join(calDir, 'worklist.md'), renderWorklistMd(worklist));

  // The calendars themselves. This is what the Claude routine used to do, and
  // the reason it can stop: the routine's job was mechanical — match each op to
  // an existing event by its marker, create or update, never delete — and a
  // marker is a VEVENT UID, so regenerating the whole file every sync produces
  // exactly that behaviour with no subscription, no MCP server and no account.
  // CALENDAR-SPEC 7.
  const ics = icsFilesFor(worklist);
  for (const f of ics) {
    await atomicWriteText(join(calDir, f.file), f.text);
    if (f.skipped.length) {
      process.stderr.write(`  ${f.file}: ${f.skipped.length} op(s) had no date or no marker and were left out\n`);
    }
  }
  process.stderr.write(`Calendar files: ${ics.map(f => `${f.file} ${f.count}`).join(', ')} → ${calDir}\n`);

  process.stderr.write(`Calendar worklist: ${ops.length} ops (${KINDS.map(k => `${k} ${counts[k]}`).join(', ')}), ${recurringNotes.length} recurring notes, ${drops.length} items unscheduled → ${join(calDir, 'worklist.md')}\n`);
  return worklist;
}

async function main() {
  const worklist = await buildWorklist(process.argv[2] ? resolve(process.argv[2]) : null);
  if (!worklist) {
    process.stderr.write('No classes directory found — nothing to do.\n');
    process.exit(0);
  }

  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
