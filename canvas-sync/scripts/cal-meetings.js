// When and where you actually have class.
//
// Three sources, in descending order of trust:
//
//   1. calendar_events.json  — Canvas's own course events. Exact start/end and
//      a real location field. Rare (most profs never create them) but perfect.
//   2. syllabus_parsed.json schedule[] — dated entries with topics, produced by
//      the syllabus parser. Dates and topics are good; times are absent, so we
//      borrow them from the weekly pattern below by weekday.
//   3. syllabus_parsed.json course.meeting_schedule — free text like
//      "Lectures MW 8:00-9:15 in McNair Hall 314". Parsed into a weekly
//      recurrence when there are no dated entries to use instead.
//
// Everything here is a guess made from prose, so every meeting carries the
// source string it came from — the event description shows it, and the user can
// tell at a glance whether the room is real or inferred.
//
// NO TIME BEATS A WRONG TIME, and the same goes for the place: parseRoom
// returns null rather than hand back the instructor's office or the Disability
// Resource Center's address, both of which every syllabus in this corpus states
// in exactly the grammar of a classroom.

const DAY_CODES = {
  su: 'SU', sun: 'SU', sunday: 'SU',
  m: 'MO', mo: 'MO', mon: 'MO', monday: 'MO',
  t: 'TU', tu: 'TU', tue: 'TU', tues: 'TU', tuesday: 'TU',
  w: 'WE', we: 'WE', wed: 'WE', wednesday: 'WE',
  r: 'TH', th: 'TH', thu: 'TH', thur: 'TH', thurs: 'TH', thursday: 'TH',
  f: 'FR', fr: 'FR', fri: 'FR', friday: 'FR',
  s: 'SA', sa: 'SA', sat: 'SA', saturday: 'SA',
};

const DAY_ORDER = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Compact day codes: "MWF" -> [MO,WE,FR], "TR" -> [TU,TH], "TTh" -> [TU,TH]. */
export function parseDayCodes(token) {
  const s = String(token ?? '').trim();
  if (!s) return [];
  // Spelled-out or delimited: "Mon/Wed", "Tuesday, Thursday".
  if (/[\s,\/&]|[a-z]{3,}/i.test(s)) {
    const out = [];
    for (const part of s.split(/[\s,\/&]+|(?:\band\b)/i)) {
      const key = part.replace(/[^a-z]/gi, '').toLowerCase();
      // "Tuesdays" is not in the table, and without this it fell through to the
      // compact walk below, which read the trailing plural as Saturday and
      // returned [TU, SA]. A wrong day is worse than no day: it puts a student
      // in a room on a Saturday. Callers that normalise prose first (see
      // normaliseDayProse) never hit this; callers handing over one bare token
      // did.
      const code = DAY_CODES[key]
        ?? (key.length > 3 && key.endsWith('s') ? DAY_CODES[key.slice(0, -1)] : undefined);
      if (code && !out.includes(code)) out.push(code);
    }
    if (out.length) return out.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  }
  // Compact: walk the string, preferring the two-letter forms Th/Tu/Su/Sa.
  const out = [];
  let i = 0;
  while (i < s.length) {
    const two = s.slice(i, i + 2).toLowerCase();
    if (['th', 'tu', 'su', 'sa'].includes(two)) {
      const c = DAY_CODES[two];
      if (c && !out.includes(c)) out.push(c);
      i += 2;
      continue;
    }
    const one = DAY_CODES[s[i].toLowerCase()];
    if (one && !out.includes(one)) out.push(one);
    i += 1;
  }
  return out.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
}

function to24h(hour, minute, meridiem) {
  let h = Number(hour);
  const m = Number(minute ?? 0);
  if (meridiem) {
    const pm = /p/i.test(meridiem);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  } else if (h >= 1 && h <= 7) {
    // A bare "1:00-2:15" on a college schedule is the afternoon.
    h += 12;
  }
  if (!Number.isFinite(h) || h > 23 || h < 0) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const TIME_RANGE_RE =
  /(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i;

/** "8:00-9:15 AM" -> { start: '08:00', end: '09:15' }. */
export function parseTimeRange(text) {
  const m = TIME_RANGE_RE.exec(String(text ?? ''));
  if (!m) return null;
  // "10:00–11:15 AM": the meridiem trails the range and governs both ends.
  const endMer = m[6] || null;
  const startMer = m[3] || endMer;
  const start = to24h(m[1], m[2], startMer);
  let end = to24h(m[4], m[5], endMer);
  if (!start || !end) return null;
  // "11:30-1:00" with no meridiem: the end wrapped past noon.
  if (end < start && !endMer) {
    const bumped = to24h(Number(m[4]) + 12, m[5], null);
    if (bumped && bumped > start) end = bumped;
  }
  return end > start ? { start, end } : null;
}

// A room number is followed by a room's worth of nothing. A phone number keeps
// going: the TA cell on ENTR 222's Canvas page reads "370 McNair Hall
// 713-348-4521", which without this guard is a classroom called "McNair Hall
// 713".
const NOT_A_PHONE = '(?!\\s*[-–]\\s*\\d)';

// The cue words are spelled with an explicit case pair rather than an /i flag.
// The flag would relax [A-Z] in the capture group too, and every lowercase word
// in the sentence would become a building name. Case-sensitive and lowercase-
// only was the other extreme: "In McNair Hall 314" at the start of a line, and
// the label "Location: McNair 330", both matched nothing at all.
// The colon is part of how a label states a room ("Room: 130", "Location: McNair
// 330"), so it is allowed after any cue rather than only after "location".
const ROOM_CUE = '(?:[Ii]n|[Aa]t|[Rr]oom|[Rr]m\\.?|[Ll]ocation)\\s*:?';
// A meridiem is a capitalised word sitting immediately before the building name
// in every course-info block ever written: "…10:50 AM - 12:05 PM Cambridge
// Office Building 130" first read as a room called "PM Cambridge Office
// Building 130".
const CAP_WORD = '(?!(?:[AP]\\.?M\\.?)\\b)[A-Z][A-Za-z.]{1,20}';
// Up to THREE capitalised words. ENTR 222 really meets in "Cambridge Office
// Building 130", and the old two-word cap could not express it.
const BUILDING_NAME = `${CAP_WORD}(?:\\s+${CAP_WORD}){0,2}`;
const ROOM_RE = new RegExp(`\\b${ROOM_CUE}\\s+(${BUILDING_NAME}\\s+\\d{1,4}[A-Za-z]?)\\b${NOT_A_PHONE}`);

// No cue word at all — a course-info table states the room as a bare noun
// phrase, because the column heading is the cue. Requiring a building-type noun
// is what keeps this from reading "Section 001" as a room: the number has to
// hang off a Hall, a Building or a Center, not off any capitalised word.
const BUILDING_NOUN =
  '(?:Hall|Building|Bldg\\.?|Center|Centre|Lab|Laboratory|Auditorium|Annex|Tower|Library|Commons|Pavilion|Institute|Complex)';
const NAMED_BUILDING_RE =
  new RegExp(`\\b(${BUILDING_NAME}\\s+${BUILDING_NOUN}\\s+\\d{1,4}[A-Za-z]?)\\b${NOT_A_PHONE}`);

// "Room 330" — the way everybody writes a room, and the one shape the cue
// branch above can never match, because it demands a capitalised word between
// the cue and the digits.
const BARE_ROOM_RE = new RegExp(`\\b(?:[Rr]oom|[Rr]m\\.?)\\s*:?\\s+(\\d{1,4}[A-Za-z]?)\\b${NOT_A_PHONE}`);

const CODE_ROOM_RE = /\b([A-Z]{2,5})\s?(\d{2,4}[A-Za-z]?)\b/;

// The two rooms every syllabus in this corpus states, neither of which is the
// classroom: the instructor's office ("Office: McNair Hall Room 330" in BUSI
// 305, "Office Location: 228 McNair Hall" in BUSI 380) and the Disability
// Resource Center's address ("Allen Center, Room 111"), which is boilerplate in
// four of the six. A wrong room is worse than none, so a clause that is about
// either of them yields no room at all.
//
// Note this deliberately does NOT reject the bare word "office": ENTR 222's
// actual classroom is in the Cambridge OFFICE Building.
const NOT_A_ROOM_RE = new RegExp([
  'office\\s*(?:hours?|:|location|located|is\\b|address)',
  '\\bdisability\\s+resource\\s+center\\b',
  '\\bby\\s+appointment\\b',
].join('|'), 'i');

/**
 * First plausible room out of free text — "McNair Hall 314", "MCN 317".
 *
 * `allowCode` governs the last resort, a bare "LETTERS digits" code. It is only
 * safe where the surrounding clause already states a day and a time, because a
 * bare code is exactly the shape of a COURSE code: scanning BUSI 374's syllabus
 * prose for a room with it on found "BUSI 374" and put the course number on 28
 * calendar entries as the classroom.
 */
export function parseRoom(text, { allowCode = true } = {}) {
  const s = String(text ?? '');
  if (NOT_A_ROOM_RE.test(s)) return null;
  const m = ROOM_RE.exec(s);
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  const b = NAMED_BUILDING_RE.exec(s);
  if (b) return b[1].replace(/\s+/g, ' ').trim();
  const bare = BARE_ROOM_RE.exec(s);
  if (bare) return `Room ${bare[1]}`;
  if (!allowCode) return null;
  const c = CODE_ROOM_RE.exec(s);
  return c ? `${c[1]} ${c[2]}` : null;
}

const DAY_WORD = '(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?';
const COMPACT_RUN = '(?:M|T|W|R|F|S|U|Th|Tu|Su|Sa){1,7}';

// A compact run may be delimited: "M/W", "T/Th", "M,W". Without the repeat
// group the token ended at the delimiter and "M/W 2:30-3:45pm" produced a
// Monday-only class — a whole weekday of lectures missing from the calendar,
// stated as confidently as the half it got right.
const DAY_TOKEN_RE = new RegExp(
  `\\b(${COMPACT_RUN}(?:\\s*[,\\/&]\\s*${COMPACT_RUN})*`
  + `|${DAY_WORD}(?:\\s*[,\\/&]\\s*${DAY_WORD})*)\\b`, 'i');

// Syllabi write days in the plural ("Tuesdays and Thursdays") far more often
// than the singular, and join them with a word rather than a delimiter. Neither
// form matches DAY_TOKEN_RE, so before this normalisation the single most
// common phrasing in the corpus parsed to *nothing at all* — no days, no time,
// no meeting events, and a Populate toggle that claimed there was nothing to
// populate.
const PLURAL_DAY_RE = new RegExp(`\\b(${DAY_WORD})s\\b`, 'gi');
const DAY_CONJ_RE = new RegExp(`\\b(${DAY_WORD})\\s*(?:,\\s*)?(?:and|&|\\+)\\s+(${DAY_WORD})\\b`, 'gi');

/** "Tuesdays and Thursdays" -> "Tuesday/Thursday". Times are left alone. */
function normaliseDayProse(text) {
  let s = String(text ?? '').replace(PLURAL_DAY_RE, '$1');
  // "Monday, Wednesday and Friday" needs more than one pass: the /g scan
  // consumes the second day of each pair, so the next conjunction is only
  // visible on a re-run.
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(DAY_CONJ_RE, '$1/$2');
    if (next === s) break;
    s = next;
  }
  return s;
}

// A syllabus schedule row is a meeting when it is a lecture, or when it is
// filed as "other" but reads like a session the student attends.
// Plurals matter: syllabi say "Lectures MW…", "Labs Wednesday…". Without the
// optional suffix the only singular noun in the clause won — "(Section 001:"
// — and a lab clause came back labelled "Section".
const SESSION_RE = /\b(lab|lecture|section|recitation|studio|workshop|seminar|discussion|class|session|meeting|review)(?:e?s)?\b/i;

/**
 * A row that says the class does NOT meet. SESSION_RE matches the word "class"
 * inside "No class", so BUSI 380's row `2026-10-06 other | Midterm Case
 * Preparation | "No class. Students work on Group Midterm Case."` was admitted
 * as a session and labelled "Class" — the calendar told the student to turn up
 * on the one Tuesday the syllabus tells them not to.
 *
 * Exported because meeting-times.js needs the same test inside its wider
 * NOT_A_CLASS_RE, and the two modules disagreeing about what "no class" means
 * is how this got through in the first place. cal-meetings owns the copy
 * because meeting-times imports from here, never the other way around.
 */
export const NO_CLASS_RE = new RegExp([
  '\\bno\\s+class(?:es)?\\b',
  '\\bcancell?ed\\b',
  '\\bno\\s+longer\\s+meet',
  "\\b(?:will|would|does|do|won'?t|doesn'?t|shall)\\s+not\\s+(?:meet|be\\s+held)",
].join('|'), 'i');

function labelFromText(text, fallback = 'Class') {
  const m = SESSION_RE.exec(String(text ?? ''));
  if (!m) return fallback;
  const w = m[1].toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function parseClause(clause) {
  const dayMatch = DAY_TOKEN_RE.exec(clause);
  if (!dayMatch) return null;
  const days = parseDayCodes(dayMatch[1]);
  if (!days.length) return null;
  const time = parseTimeRange(clause.slice(dayMatch.index + dayMatch[1].length));
  if (!time) return null;
  return {
    label: labelFromText(clause),
    byday: days,
    start: time.start,
    end: time.end,
    location: parseRoom(clause),
    source: clause.trim(),
  };
}

/**
 * Every weekly pattern in a meeting_schedule string, one per clause.
 *
 * Splitting matters: "Lectures MW 8:00-9:15 in McNair 314; Labs Wednesday
 * afternoons 12:00-12:50 MCN 317" describes two different meetings that share a
 * weekday. Treating it as one pattern put the lab in the lecture's slot and the
 * lecture's room — a time and a place that are both wrong, stated confidently.
 */
const ROOM_BLOCK_MAX = 240;

export function parseWeeklyPatterns(text) {
  const s = normaliseDayProse(String(text ?? '').trim());
  if (!s) return [];
  const out = [];
  // Sentence split too, but never on an abbreviation's period ("M.W.F.").
  for (const clause of s.split(/[;\n]|(?<=[a-z0-9)])\.\s+/)) {
    const p = parseClause(clause);
    if (p) out.push({ ...p, full: s });
  }
  // Nothing split cleanly — try the whole string as one clause.
  if (!out.length) {
    const p = parseClause(s);
    if (p) out.push({ ...p, full: s });
  }
  // parseClause only reads a room out of the same clause that gave it the day
  // and the time, so a room stated on its own line is unreachable by
  // construction — and a room on its own line is how every real course-info
  // block writes it. Give it a second look at the whole block, but only when
  // the block is short enough to be about one thing and only one pattern came
  // out of it: with two patterns there is no telling whose room it is, and a
  // lab in the lecture's room is the wrong-place failure this file is written
  // against.
  if (out.length === 1 && !out[0].location && s.length <= ROOM_BLOCK_MAX) {
    const room = parseRoom(s);
    if (room) out[0] = { ...out[0], location: room };
  }
  return out;
}

/** The single best weekly pattern, for callers that can only use one. */
export function parseWeeklyPattern(text) {
  return parseWeeklyPatterns(text)[0] ?? null;
}

/**
 * The pattern that governs a given meeting: same session label if one matches,
 * otherwise the only pattern covering that weekday. Returns null when the
 * choice is ambiguous — a meeting with no time beats a meeting at the wrong
 * time.
 */
export function patternFor(patterns, { weekday, label }) {
  const onDay = patterns.filter(p => p.byday.includes(weekday));
  if (!onDay.length) return null;
  if (onDay.length === 1) return onDay[0];
  const byLabel = onDay.filter(p => p.label.toLowerCase() === String(label ?? '').toLowerCase());
  if (byLabel.length === 1) return byLabel[0];
  return null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function weekdayOf(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : DAY_ORDER[d.getDay()];
}

// Some syllabi are keyed by week, not by session: one row per week, every row
// dated at the Monday the week starts, whatever days the class actually meets.
// Read literally that produces fifteen Monday lectures for a Tuesday/Thursday
// class — a confidently wrong date on every one.
//
// The tell is that the row's weekday is in no known meeting pattern. When that
// happens and a single pattern governs, spread the row across the days the
// class does meet inside that week.
function datesInWeekFrom(isoDate, byday) {
  const out = [];
  const base = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(base.getTime())) return out;
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    if (!byday.includes(DAY_ORDER[d.getDay()])) continue;
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

// The one pattern that can speak for a week row. Ambiguity returns null and the
// row keeps its original date — a lecture on the wrong day is recoverable, a
// lab spread across the lecture's slots is not.
function governingPattern(patterns, label) {
  const withDays = patterns.filter(p => p.byday?.length);
  if (withDays.length === 1) return withDays[0];
  const byLabel = withDays.filter(p => p.label.toLowerCase() === String(label ?? '').toLowerCase());
  return byLabel.length === 1 ? byLabel[0] : null;
}

// …and the same week-keyed table when there is NO pattern to spread across.
// BUSI 305 is the real case: 16 rows carrying week=1..15, every one dated at
// the Monday the week starts, seven days apart, for a class whose syllabus
// states no meeting day or time anywhere and whose own left column reads "Sep 7
// (no classes Monday and Tuesday)" and "Oct 12 (no classes Monday and
// Tuesday)". Read literally that is 16 Monday lectures, two of them on days the
// syllabus explicitly says are free. The defence above cannot help — it needs a
// pattern to spread across, and this class has none.
//
// The tell is in the shape of the table rather than in any one row: a numbered
// `week` on every row, one weekday, seven days apart. A "week of" marker is the
// honest reading whichever days the class turns out to meet.
const WEEK_KEYED_SHARE = 0.75;

function daysBetween(isoA, isoB) {
  const [ay, am, ad] = isoA.split('-').map(Number);
  const [by, bm, bd] = isoB.split('-').map(Number);
  return (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000;
}

function looksWeekKeyed(rows) {
  if (rows.length < 3) return false;
  const numbered = rows.filter(e => Number.isFinite(Number(e.week))).length;
  if (numbered / rows.length < WEEK_KEYED_SHARE) return false;

  const byWeekday = new Map();
  for (const e of rows) {
    const w = weekdayOf(e.date);
    byWeekday.set(w, (byWeekday.get(w) ?? 0) + 1);
  }
  const onOneDay = Math.max(...byWeekday.values());
  if (onOneDay / rows.length < WEEK_KEYED_SHARE) return false;

  const dates = [...new Set(rows.map(e => e.date))].sort();
  if (dates.length < 3) return false;
  let sevens = 0;
  for (let i = 1; i < dates.length; i += 1) {
    if (daysBetween(dates[i - 1], dates[i]) === 7) sevens += 1;
  }
  return sevens / (dates.length - 1) >= WEEK_KEYED_SHARE;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function prettyDate(isoDate) {
  const [, m, d] = isoDate.split('-').map(Number);
  return `${MONTHS[m - 1] ?? isoDate} ${d}`;
}

// A row that marks where a chunk of the course begins, not a class you attend.
// BUSI 396's "Course Schedule" table has four rows, each headed by a date RANGE
// ("Aug 24 – Sep 18"); the extractor kept the start of the range, dropped the
// end, and typed the row `lecture`, so a five-week module became a single
// all-day class meeting. Only refused when no pattern governs that weekday —
// with a real MW pattern in hand, "Module 3 Begins" on a Wednesday is a session
// like any other and keeps its slot.
const MODULE_LANDMARK_RE = /\b(?:module|unit|part|phase)\b[^.]{0,60}?\b(?:begins?|starts?|ends?)\b/i;

/**
 * Dated meetings out of a parsed syllabus. Each is
 * { date, start, end, label, topic, location, holiday, tentative, source },
 * plus `spread: true` when the date was worked out from a week row rather than
 * stated by the row itself, and `week_of: true` when the row IS a week and no
 * pattern was available to place the sessions inside it.
 *
 * Three kinds of row are refused a session of their own: a row whose words say
 * there is no class (it becomes a no-class day), a module or unit boundary
 * (BUSI 396's whole "schedule" is four of them), and a week row for a class
 * with no known meeting days (it becomes a "Week of …" marker instead).
 */
/**
 * `refused` is an optional out-parameter: push a record for every schedule row
 * that was deliberately NOT turned into a meeting, so a caller can report the
 * drop instead of the row simply vanishing. BUSI 396's four module boundaries
 * are the case that made this necessary — the suppression is correct (they are
 * five-week date RANGES, not sessions), but the user previously had those four
 * dates on their calendar and afterwards the class showed zero meetings with
 * nothing anywhere saying why. Every other drop in this pipeline is recorded
 * with a reason; this one was not.
 */
export function meetingsFromSyllabus(parsed, overridePatterns = null, refused = null) {
  const schedule = Array.isArray(parsed?.schedule) ? parsed.schedule : [];
  // Recovered patterns (an override the user typed, a time found deeper in the
  // syllabus text, Canvas's own sections) beat the one-line meeting_schedule
  // field, which is blank or day-only on most real syllabi.
  const patterns = Array.isArray(overridePatterns) && overridePatterns.length
    ? overridePatterns
    : parseWeeklyPatterns(parsed?.course?.meeting_schedule);
  const out = [];

  // Which rows are meetings at all, decided once so the shape of the table can
  // be read off them before any single row is turned into an event.
  const rows = [];
  for (const e of schedule) {
    if (!e || !ISO_DATE_RE.test(String(e.date ?? ''))) continue;
    const type = String(e.type ?? '').toLowerCase();
    const text = `${e.description ?? ''} ${e.title ?? ''}`;
    const isHoliday = type === 'holiday';
    const isLecture = type === 'lecture';
    const looksLikeSession = type === 'other' && SESSION_RE.test(text);
    if (!isHoliday && !isLecture && !looksLikeSession) continue;
    rows.push({ e, text, isHoliday, isLecture, noClass: !isHoliday && NO_CLASS_RE.test(text) });
  }
  const weekKeyed = looksWeekKeyed(rows.filter(r => !r.isHoliday && !r.noClass).map(r => r.e));

  for (const { e, text, isHoliday, isLecture, noClass } of rows) {
    // A row whose own words say there is no class is a no-class day, whatever
    // the extractor typed it. It must never become a session the student is
    // told to attend.
    if (noClass) {
      out.push({
        date: e.date,
        start: null,
        end: null,
        label: 'No class',
        topic: e.title ?? null,
        location: null,
        holiday: true,
        tentative: e.tentative === true,
        source: 'syllabus schedule (the row says there is no class)',
        pattern_source: null,
      });
      continue;
    }

    const label = isHoliday
      ? 'No class'
      : labelFromText(text, isLecture ? 'Lecture' : 'Class');
    // Borrow the clock time from the weekly pattern that governs THIS kind of
    // session on THIS weekday — never from another session's slot.
    const weekday = weekdayOf(e.date);
    const pattern = isHoliday ? null : patternFor(patterns, { weekday, label });
    const coversWeekday = patterns.some(p => p.byday?.includes(weekday));

    // This weekday is in no pattern, so the date does not name a session the
    // way it looks like it does. A holiday keeps its own date — "Midterm
    // recess" dated Monday is about that Monday, not about the lecture slots.
    if (!isHoliday && !pattern && !coversWeekday) {
      if (MODULE_LANDMARK_RE.test(text)) {
        if (refused) {
          refused.push({
            date: e.date,
            title: e.title ?? null,
            reason: 'module_boundary',
            detail: 'a module/unit boundary, not a class session — the syllabus row heads a date RANGE and no weekly pattern covers this weekday',
          });
        }
        continue;
      }
      // A week row, and one pattern to spread it across.
      const gov = patterns.length ? governingPattern(patterns, label) : null;
      if (gov) {
        for (const date of datesInWeekFrom(e.date, gov.byday)) {
          out.push({
            date,
            start: gov.start ?? null,
            end: gov.end ?? null,
            label,
            topic: e.title ?? null,
            location: gov.location ?? null,
            holiday: false,
            tentative: e.tentative === true,
            spread: true,
            source: `syllabus schedule (week of ${e.date}, spread across ${gov.byday.join('/')})`,
            pattern_source: gov.source ?? null,
          });
        }
        continue;
      }
      // A week row and nothing to spread it across: the date is a week label
      // and we do not know which day inside that week the class meets. Say
      // exactly that. A meeting on the wrong day is worse than a week marker.
      if (weekKeyed) {
        out.push({
          date: e.date,
          start: null,
          end: null,
          label: `Week of ${prettyDate(e.date)}`,
          topic: e.title ?? null,
          location: null,
          holiday: false,
          tentative: e.tentative === true,
          week_of: true,
          source: 'syllabus schedule (a week row — no meeting days are known for this class)',
          pattern_source: null,
        });
        continue;
      }
    }

    out.push({
      date: e.date,
      start: pattern?.start ?? null,
      end: pattern?.end ?? null,
      label,
      topic: e.title ?? null,
      location: pattern?.location ?? null,
      holiday: isHoliday,
      tentative: e.tentative === true,
      source: 'syllabus schedule',
      pattern_source: pattern?.source ?? null,
    });
  }
  return out;
}

/** Meetings from Canvas's own course events — exact, when they exist. */
export function meetingsFromCanvasEvents(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.hidden) continue;
    const startAt = e.start_at;
    if (!startAt) continue;
    const start = new Date(startAt);
    if (Number.isNaN(start.getTime())) continue;
    const endAt = e.end_at ? new Date(e.end_at) : null;
    const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const allDay = e.all_day === true;
    // A professor who cancels a session usually keeps the event and renames it
    // — "No Class - Fall Break", still 2:30pm, still in Virani 182. Canvas has
    // no holiday type to read, so the event's own words are the only signal
    // there is, and Canvas events are the FIRST source collectMeetings merges:
    // miss it here and a cancelled session outranks the syllabus row that says
    // so, and the calendar tells the student to walk to an empty building.
    const noClass = NO_CLASS_RE.test(`${e.title ?? ''} ${e.description ?? ''}`);
    out.push({
      date: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
      // A session that does not happen has no clock time and no room, the same
      // way the syllabus no-class path emits none.
      start: allDay || noClass ? null : hhmm(start),
      end: allDay || noClass || !endAt || Number.isNaN(endAt.getTime()) ? null : hhmm(endAt),
      label: noClass ? 'No class' : 'Class',
      topic: e.title ?? null,
      location: noClass ? null : (e.location_name || e.location_address || null),
      holiday: noClass,
      tentative: false,
      source: noClass
        ? 'Canvas course events (the event says there is no class)'
        : 'Canvas course events',
    });
  }
  return out;
}

/**
 * Everything the sources agree on, Canvas first. Deduped by date+start so a
 * class listed in both does not land on the calendar twice.
 */
function mergeTopics(winner, loser) {
  const a = String(winner ?? '').trim();
  const b = String(loser ?? '').trim();
  if (!b || a.toLowerCase() === b.toLowerCase()) return winner ?? null;
  if (!a) return loser ?? null;
  return `${a} / ${b}`;
}

export function collectMeetings({ syllabusParsed, canvasEvents, patterns = null, refused = null }) {
  const at = new Map();
  const out = [];
  for (const m of [...meetingsFromCanvasEvents(canvasEvents), ...meetingsFromSyllabus(syllabusParsed, patterns, refused)]) {
    const key = `${m.date}|${m.start ?? ''}|${(m.label ?? '').toLowerCase()}`;
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, out.length);
      out.push(m);
      continue;
    }
    // Two meetings in one slot. ENTR 222 shows why first-wins is wrong: its
    // schedule holds a mis-parsed Saturday row ("2026-08-29 SA lecture | AI
    // Basics", from a concatenated WkDates column) which the week-spreading
    // defence correctly fans out to TU/TH — landing a copy on Sep 3 at 10:50,
    // the same key as the genuine "Sep 3 | PM Mindset + Product Artifacts" row
    // that comes later in the array. The copy won and the real session's topic
    // vanished with no warning. A date the row itself carries beats a date we
    // worked out, and the loser's topic is merged in rather than dropped, so
    // the collision is visible to the student instead of silently resolved.
    const kept = out[i];
    const winner = kept.spread && !m.spread ? m : kept;
    const loser = winner === kept ? m : kept;
    out[i] = { ...winner, topic: mergeTopics(winner.topic, loser.topic) };
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start)));
  return out;
}

/**
 * How many meetings this class would actually produce, counting the weekly
 * recurrence fallback as one. The dashboard's Meetings toggle gates on this
 * rather than on "a schedule array exists" — a syllabus whose rows are all
 * typed `exam` or `discussion` parses fine, passes a naive check, and then
 * yields nothing, which reads to the user as a broken button.
 */
export function countMeetings({ syllabusParsed, canvasEvents, patterns = null }) {
  const dated = collectMeetings({ syllabusParsed, canvasEvents, patterns }).length;
  if (dated > 0) return dated;
  // No dated rows, but a weekly pattern alone still populates a recurring
  // event, so the toggle should be live.
  if (Array.isArray(patterns) && patterns.length) return 1;
  return parseWeeklyPattern(syllabusParsed?.course?.meeting_schedule) ? 1 : 0;
}
