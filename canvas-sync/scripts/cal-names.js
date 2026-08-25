// Concise calendar event titles.
//
// A calendar shows about 20 characters per event in month view. The worklist
// used to emit
//
//   "BUSI 395 001/002/003/004: Homework Assignment 3 - Probability Distributions"
//   "Prep: BUSI 395 001/002/003/004 Homework Assignment 3 - ... (due in 5d)"
//
// which in a month grid reads as "BUSI 395 001/00…" five times over — every
// event indistinguishable from the next. The whole job of these helpers is to
// spend the visible characters on what differs.
//
//   BUSI 395 · HW 3
//   BUSI 395 · Exam 2
//   BUSI 395 · Read Ch 4
//   Prep · BUSI 395 HW 3
//
// Rules, in order: strip the section list off the course code; strip the
// course code back off the item title (Canvas titles routinely repeat it);
// abbreviate the handful of words that are always long and never informative;
// then cap the length on a word boundary.
//
// A MEETING is the exception and does not follow those rules at all. The user
// specified its title themselves, field by field:
//
//   "they should show class days, times, and location. Should be titled
//    '[LOC] - [CLASS] - [PROF]', eg. 'Virani 182 - BUSI380 - VanHorn' as
//    pulled from the syllabus."
//
// so meetingTitle() below spends its characters on those three and nothing
// else. See CALENDAR-SPEC rows 4.1-4.3.

import { NO_CLASS_RE } from './cal-meetings.js';

// "BUSI 395 001/002/003/004" -> "BUSI 395". Also handles "BUSI395-001",
// "BUSI 395 (Section 2)", "MATH 101 S01/S03".
// A field that holds a placeholder where a value should be. Two families, and
// the second is the one that kept getting through: a professor with nothing to
// put in a form field types a dash, not the word "unknown". "-" survived
// stated() and rebuilt both of the shapes CALENDAR-SPEC 4.2 forbids by name —
// a leading " - " and a doubled " -  - ".
const PLACEHOLDER_RE = /^(?:null|undefined|n\/?a|tbd|tba|unknown|none|[-\u2013\u2014.,;:/|_*?]+)$/i;

/** true when the field is absent, blank, or says nothing. */
function unstated(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return !s || PLACEHOLDER_RE.test(s);
}

export function shortCourseCode(code) {
  const raw = String(code ?? '').replace(/\s+/g, ' ').trim();
  // "null" is a string a metadata extractor writes; it is not a course code,
  // and printing it on 23 lectures of the term is what CALENDAR-SPEC 4.2
  // forbids by name. Filtered here rather than in one caller so every title
  // that names a class is defended, not just the meeting one.
  if (unstated(raw)) return '';
  // A course code is "SUBJ NNN" and everything after it is section, term or
  // noise. Matching the head explicitly is the only safe way to strip the tail:
  // a trailing-run regex cannot tell "BUSI 305" (keep the 305) from
  // "BUSI 305 001" (drop the 001), and quietly returned "BUSI".
  const head = /^([A-Za-z]{2,6})\s*[-–—]?\s*(\d{2,4}[A-Za-z]?)\b/.exec(raw);
  if (head) return `${head[1].toUpperCase()} ${head[2]}`;
  // Not code-shaped (Canvas shells like "Power of Persuasion"): leave the name
  // alone apart from an obvious trailing term.
  return raw
    .replace(/\s*\((?:section|sec)[^)]*\)\s*/gi, ' ')
    .replace(/[\s\-–—]+(?:fall|spring|summer|winter)\s*(?:\d{4}|\d{2})?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Abbreviations worth making: each saves >= 4 characters and loses nothing.
const ABBREV = [
  [/\bhomework(?:\s+assignment)?\b/gi, 'HW'],
  [/\bproblem\s*set\b/gi,              'PS'],
  [/\bassignment\b/gi,                 'Assign'],
  [/\bchapters?\b/gi,                  'Ch'],
  [/\bsections?\b/gi,                  '§'],
  [/\bpresentations?\b/gi,             'Talk'],
  [/\bdiscussion\s*(?:board\s*)?posts?\b/gi, 'Post'],
  [/\bexamination\b/gi,                'Exam'],
  [/\bmidterm\s*exam\b/gi,             'Midterm'],
  [/\bfinal\s*exam(?:ination)?\b/gi,   'Final'],
  [/\blaboratory\b/gi,                 'Lab'],
  [/\bquestions?\b/gi,                 'Qs'],
  [/\bweek\s*(\d+)\b/gi,               'Wk $1'],
  [/\bpart\s*(\d+)\b/gi,               'Pt $1'],
  [/\bnumber\s*(\d+)\b/gi,             '$1'],
  [/\bdue\b/gi,                        ''],
];

const NOISE = [
  /^\s*(?:required|optional)\s*[:\-–]\s*/i,
  /\s*[\(\[]\s*(?:required|optional|graded|ungraded)\s*[\)\]]\s*/gi,
  /\s*[-–—:]\s*$/,
];

const MAX_TITLE = 46;

/** Trim to a word boundary, with an ellipsis only when something was cut. */
export function clip(s, max = MAX_TITLE) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:\-–—]+$/, '')}…`;
}

/**
 * Clean one item title for calendar display: drop the course code the title
 * repeats, abbreviate, clip. `code` is the SHORT course code.
 */
export function cleanItemTitle(title, code = '') {
  let s = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Untitled';

  // Strip a leading repeat of the course code in any of its usual disguises:
  // "BUSI 395: HW 3", "BUSI395 HW 3", "Busi 395 - HW 3".
  const subj = /^([A-Za-z]{2,5})\s*(\d{2,4})\b/.exec(code);
  if (subj) {
    const re = new RegExp(`^${subj[1]}\\s*${subj[2]}\\b[\\s:\\-–—]*`, 'i');
    s = s.replace(re, '');
    // …and a bare section list left behind by it: "001/002 HW 3".
    s = s.replace(/^(?:[A-Z]?\d{1,3})(?:\s*\/\s*[A-Z]?\d{1,3})*[\s:\-–—]+/i, '');
  }
  for (const re of NOISE) s = s.replace(re, ' ');
  for (const [re, to] of ABBREV) s = s.replace(re, to);
  s = s.replace(/\s+/g, ' ').replace(/\s+([,;:.])/g, '$1').trim();
  if (!s) s = String(title).trim() || 'Untitled';
  return clip(s);
}

// A reading gets a verb, because "Ch 4" alone on a calendar is a mystery.
const CATEGORY_PREFIX = {
  reading: 'Read',
  exam:    '',      // exam titles already say "Midterm"/"Final"
  quiz:    'Quiz',
};

function needsPrefix(prefix, title) {
  if (!prefix) return false;
  return !new RegExp(`^${prefix}\\b`, 'i').test(title);
}

/** "BUSI 395 · Read Ch 4" — the title of a due-date event. */
export function dueTitle({ code, title, category }) {
  const short = shortCourseCode(code);
  let name = cleanItemTitle(title, short);
  const prefix = CATEGORY_PREFIX[category];
  if (needsPrefix(prefix, name)) name = `${prefix} ${name}`;
  return short ? `${short} · ${clip(name, MAX_TITLE)}` : clip(name, MAX_TITLE);
}

/**
 * "Prep · BUSI 395 HW 3" — prep leads, because on a day with the real deadline
 * on it the two must not read identically.
 */
export function prepTitle({ code, title }) {
  const short = shortCourseCode(code);
  const name = cleanItemTitle(title, short);
  return clip(`Prep · ${short ? `${short} ` : ''}${name}`, MAX_TITLE + 8);
}

/** A checkpoint the user wrote themselves — their words lead. */
export function checkpointTitle({ code, title }) {
  const short = shortCourseCode(code);
  const name = clip(String(title ?? '').trim() || 'Checkpoint', MAX_TITLE);
  return short ? `${short} · ${name}` : name;
}

// ---------------------------------------------------------------------------
// Meetings: "[LOC] - [CLASS] - [PROF]".
//
// Three fields, and two of them are usually missing: 80 of today's 106 meeting
// ops carry no location at all (only ENTR 222's "Cambridge Office Building 130"
// survives the syllabus), and an instructor arrives as a full name that has to
// be cut down to a surname first. So the whole job of this section is degrading
// without leaving the punctuation behind. " - BUSI380 - null" and "BUSI380 -  -
// VanHorn" are the shapes CALENDAR-SPEC 4.2 forbids by name, and every helper
// below exists to make one of them impossible.
// ---------------------------------------------------------------------------

/**
 * "BUSI 380 002" -> "BUSI380". The user wrote the code that way themselves and
 * a meeting title has three fields competing for a month-view row, so the space
 * is a character better spent on the room.
 */
export function compactCourseCode(code) {
  // shortCourseCode has already dropped the section list and the term, and is
  // the one place that knows "BUSI 305" keeps its 305 while "BUSI 305 001"
  // drops its 001.
  const short = shortCourseCode(code);
  if (!short) return null;
  // Only a real SUBJ-NNN code closes up. A Canvas shell name ("Power of
  // Persuasion") would become "PowerofPersuasion", which is not a course code,
  // it is a broken word.
  const m = /^([A-Za-z]{2,6})\s(\d{2,4}[A-Za-z]?)$/.exec(short);
  return m ? `${m[1].toUpperCase()}${m[2].toUpperCase()}` : short;
}

// A title in front of the name is the trap this user's data actually contains:
// "Dr. Leila Peyravan". Taking the last word happens to give "Peyravan" here,
// but only by luck of word order — "Prof. Porter" would print "Prof." on all 23
// BUSI 380 lectures of the term. Strip the title first and the answer stops
// depending on how many given names the professor listed.
const TITLE_RE = /^(?:dr|prof|professor|mr|mrs|ms|mx|miss|sir|rev|fr|instructor|lecturer)\.?$/i;

// A credential is not a surname either: "Constance Porter, Ph.D." taken from the
// end is "Ph.D.". Deliberately short — "Ma" and "Bass" are surnames before they
// are degrees, so only the ones that cannot plausibly be a name are listed.
const SUFFIX_RE = /^(?:jr|sr|ii|iii|iv|phd|ph\.?d|m\.?d|mba|msc|edd|dds|dvm|jd|esq|cpa|cfa|emeritus)\.?$/i;

// "Ludwig van Beethoven" -> "van Beethoven". The particle belongs to the
// surname; the last word alone would be a different person's name.
const PARTICLE_RE = /^(?:van|von|der|den|de|del|della|di|da|dos|du|la|le|ter|ten|bin|ibn|st|saint)\.?$/i;

// Fields that hold a placeholder where a person should be. The literal string
// "null" is the one that matters: an extractor that writes it into
// instructor.name would otherwise put the word null on 106 lecture titles,
// which is precisely the failure CALENDAR-SPEC 4.2 names.
const NOT_A_NAME_RE = /^(?:n\/?a|tba|tbd|staff|unknown|none|null|undefined|instructor|professor|faculty|[-–—.]+)$/i;

/**
 * The surname to print on a lecture. "Dr. Leila Peyravan" -> "Peyravan",
 * "David VanHorn" -> "VanHorn", "Porter, Constance" -> "Porter". Returns null
 * — never a guess and never a fragment — when there is no name in the field.
 */
export function instructorSurname(name) {
  const raw = String(name ?? '')
    // "(he/him)", "(instructor of record)" — an aside, never the surname.
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw || NOT_A_NAME_RE.test(raw)) return null;

  // "Porter, Constance" is surname-first and "Constance Porter, Ph.D." is not.
  // The comma cannot tell them apart on its own; what tells them apart is
  // whether what follows it is a name or a credential.
  const segments = raw.split(',').map(s => s.trim()).filter(Boolean);
  const named = segments.filter(s => !s.split(' ').every(w => SUFFIX_RE.test(w)));
  const surnameIsWholeSegment = named.length > 1;

  let words = String(named[0] ?? '').split(' ').filter(Boolean);
  while (words.length && TITLE_RE.test(words[0])) words.shift();
  while (words.length && SUFFIX_RE.test(words[words.length - 1])) words.pop();
  if (!words.length) return null;

  let surname;
  if (surnameIsWholeSegment) {
    // Everything before the comma IS the surname — "Van Horn, David" is not
    // three names, it is a two-word surname and a given name.
    surname = words.join(' ');
  } else {
    let i = words.length - 1;
    while (i > 0 && PARTICLE_RE.test(words[i - 1])) i -= 1;
    surname = words.slice(i).join(' ');
  }
  // A trailing full stop is punctuation from the sentence the name was lifted
  // out of. Internal capitals are NOT a split point: "VanHorn" is one word and
  // the user wrote it that way.
  surname = surname.replace(/[.,;:]+$/, '').trim();
  if (!surname || !/\p{L}/u.test(surname) || NOT_A_NAME_RE.test(surname)) return null;
  return surname;
}

// "Cambridge Office Building 130" is 29 characters and has to leave room for
// " - ENTR222 - Wulf". A room longer than this is a sentence about a room.
const MAX_LOCATION = 32;

// The label only ever answers one question now: is this a day the class does
// NOT meet? Asked with cal-meetings' own regex rather than a second copy of it,
// so a schedule row that reads "no class" cannot be a holiday to one file and a
// lecture to the other.
// "Fall Recess" and "Spring Break" name a week off; "Break-Even Analysis" and
// "Holiday Shopping Behaviour" are lecture SUBJECTS in this user's own six
// classes. The word alone cannot tell them apart, so its POSITION does: a term
// off is a short label whose head noun is the break itself ("Spring Break"),
// while a lecture puts the word in front of what the lecture is actually about
// ("Holiday Shopping Behaviour", "Coffee break exercise"). Telling a student to
// stay home on a day the class meets is the same failure as the reverse, so the
// backstop stays deliberately narrow — a real holiday row already arrives
// labelled "No class" by cal-meetings.js.
const BREAK_HEAD_RE = /^(?:holidays?|recess|breaks?)$/i;

export function labelSaysNoClass(label) {
  const raw = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  if (NO_CLASS_RE.test(raw)) return true;
  const words = raw.replace(/[.,;:!]+$/, '').split(' ').filter(Boolean);
  return words.length <= 3 && BREAK_HEAD_RE.test(words[words.length - 1]);
}

/** Absent, blank, or the string a parser writes when it found nothing. */
function stated(v) {
  // "Location: Virani 182 -" clipped at its label keeps the separator on the
  // end, and joining that with " - " doubles the dash. The room is the text,
  // never the punctuation around it.
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
    .replace(/^[-\u2013\u2014.,;:/|]+\s*/, '')
    .replace(/\s*[-\u2013\u2014.,;:/|]+$/, '')
    .trim();
  return unstated(s) ? null : s;
}

/**
 * The room as it should be printed, or null when the field holds no room.
 * Exported because the op carries `location` as its own field as well as
 * inside the title, and the two disagreeing — a title that dropped the dash
 * next to a location field that kept it — is the drift this avoids.
 */
export function roomName(location) {
  const room = stated(location);
  return room ? clip(room, MAX_LOCATION) : null;
}

/**
 * "Virani 182 - BUSI380 - VanHorn" — the title of a meeting event, in the
 * user's own words and their own order. Degrades a field at a time:
 *
 *   location + instructor  ->  "Virani 182 - BUSI380 - VanHorn"
 *   instructor only        ->  "BUSI380 - VanHorn"
 *   location only          ->  "Virani 182 - BUSI380"
 *   neither                ->  "BUSI380"
 *   a no-class day         ->  "No class - BUSI380"
 *
 * `topic` is accepted and ignored. The user asked for a title of exactly three
 * fields and the day's subject is not one of them, so the CALLER puts the topic
 * in the event description where there is room for it.
 *
 * Total by construction: every combination of missing fields, including all of
 * them, returns a string a student can read, and none of them can produce a
 * leading " - ", a doubled " -  - ", or the literal word null.
 */
export function meetingTitle({ code, label, location, instructor } = {}) {
  const short = compactCourseCode(code);
  // A holiday is not a room with a professor in it. "Virani 182 - BUSI380 -
  // VanHorn" on a day the university is shut is an instruction to walk to an
  // empty building.
  if (labelSaysNoClass(label)) {
    return short ? `No class - ${short}` : 'No class';
  }
  const parts = [
    roomName(location),
    short,
    instructorSurname(instructor),
  ].filter(Boolean);
  // Never an empty title: an untitled calendar event is a grey box the student
  // cannot identify at all, which is worse than the generic word.
  return parts.length ? parts.join(' - ') : 'Class';
}
