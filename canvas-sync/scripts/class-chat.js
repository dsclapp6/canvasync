// class-chat.js — ask one class a question and get a short, sourced answer.
//
// Two halves that must never be confused with each other:
//
//   FACTS   Computed here, in code, from the same functions the calendar and
//           the task list use. Dates, meeting times, exams, deadlines. The
//           model is told to copy these and never to derive them.
//   SOURCES Passages pulled out of the class's own documents, chosen by the
//           correlation graph, tagged [S1]..[Sn] so a claim can be checked.
//
// The split exists because of this project's governing rule for schedule data:
// NO TIME BEATS A WRONG TIME. A model that reads "Tuesdays and Thursdays" off a
// syllabus and helpfully adds "at 2:30" has produced a wrong time, stated
// confidently, that the student will act on. So the meeting time is recovered
// by meeting-times.js, rendered in words including the word "unknown", and the
// model is given no room to improve on it.
//
// Nothing here calls a model on its own. answerQuestion takes an injectable
// `invoke`; production defaults to aiInvoke, which prefers an authenticated
// Claude/Codex terminal session and uses the lock-guarded local model only as
// fallback. Tests inject a fake and assert on the prompt it was handed.
//
// Node builtins only. Reads a class dir; never writes to one.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recoverMeetingTimes, describeMeetingSource } from './meeting-times.js';
import { collectMeetings } from './cal-meetings.js';
import { tasksForClass, EXAM_RE } from '../canvas-tasks.js';
import { readingsWithScheduleFloor } from '../reading-index.js';
import {
  readGraph, buildGraph, selectForQuery, neighbours, stripHtml, tokenise,
} from './correlation-graph.js';
import { searchClassText, isPolicyQuestion, findSyllabusDoc } from './text-search.js';
import { aiInvoke, readJsonSafe, classHome } from './_util.js';

// --- Constants ------------------------------------------------------------

/** The one sentence the model is allowed to fall back to. Exported so the UI
 *  can recognise it and render "nothing found" rather than an answer bubble. */
export const NO_ANSWER = "I don't have that in this class's material.";

/** Total characters of source text allowed into one prompt. */
export const DEFAULT_BUDGET_CHARS = 20000;

/** How many graph nodes selectForQuery is asked for. */
export const DEFAULT_NODE_LIMIT = 12;

/** Below this many seed nodes, expand one hop through the graph. */
export const THIN_SELECTION = 3;

/** Most distinct documents that may appear as [S1]..[Sn]. */
export const MAX_SOURCES = 8;

/** Slots held back for the full-text sweep when it has anything to say. */
export const TEXT_RESERVED_SLOTS = 3;

/** Dated work listed under "Upcoming" in the FACTS block. */
export const UPCOMING_LIMIT = 8;

/** Passages are cut near this length; a single line is never cut mid-line. */
const PASSAGE_TARGET = 520;
const PASSAGE_MAX = 900;
const PASSAGE_MIN = 80;

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_LABELS = { SU: 'Su', MO: 'M', TU: 'Tu', WE: 'W', TH: 'Th', FR: 'F', SA: 'Sa' };

// --- Small helpers --------------------------------------------------------

function asArray(v) { return Array.isArray(v) ? v : []; }
function str(v) { return typeof v === 'string' ? v : v == null ? '' : String(v); }

/** 'YYYY-MM-DD' in LOCAL time. Slicing an ISO string takes the UTC date, which
 *  for an 11:59 PM local deadline lands the item a whole day late. */
export function localIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Noon local, so a date string never drifts across a DST boundary. */
function dateAt(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function weekdayIndex(iso) {
  const d = dateAt(iso);
  return d ? d.getDay() : null;
}

/**
 * The Monday-Sunday week containing `now`, in local time.
 * setDate() rolls months and years over, which is the whole reason the
 * arithmetic is done on a Date rather than on the string.
 */
export function weekWindow(now = new Date()) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (base.getDay() + 6) % 7;      // Monday = 0
  const start = new Date(base);
  start.setDate(base.getDate() - back);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: localIsoDate(start), end: localIsoDate(end) };
}

function addDays(iso, n) {
  const d = dateAt(iso);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  return localIsoDate(d);
}

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

/** '14:30' -> '2:30 PM'. Returns null for anything that is not a clock time. */
export function clock12(hhmm) {
  const m = HHMM_RE.exec(str(hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (!Number.isFinite(h) || h > 23) return null;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

function timeRangeText(start, end) {
  const a = clock12(start);
  if (!a) return null;
  const b = clock12(end);
  return b ? `${a}-${b}` : a;
}

function daysText(byday) {
  return asArray(byday).map(d => DAY_LABELS[d] ?? d).join('');
}

function longDate(iso) {
  const i = weekdayIndex(iso);
  return i == null ? iso : `${WEEKDAY_SHORT[i]} ${iso}`;
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const k = str(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

// A path out of a JSON index is only ever meant to name something under the
// class dir. Anything that resolves outside it is refused: its text would
// otherwise be handed straight to a model as this class's material.
function insideClassDir(classDir, rel) {
  const root = path.resolve(classDir);
  const abs = path.resolve(root, str(rel));
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

async function readTextOrNull(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

// ==========================================================================
// A. FACTS
// ==========================================================================

async function loadClassData(classDir) {
  const [metadata, syllabusParsed, assignments, mined, readings, canvasEvents] = await Promise.all([
    readJsonSafe(path.join(classDir, 'metadata.json')),
    readJsonSafe(path.join(classDir, 'syllabus_parsed.json')),
    readJsonSafe(path.join(classDir, 'assignments.json')),
    readJsonSafe(path.join(classDir, 'assignments_mined.json')),
    readJsonSafe(path.join(classDir, 'readings_index.json')),
    readJsonSafe(path.join(classDir, 'calendar_events.json')),
  ]);
  return { metadata, syllabusParsed, assignments, mined, readings, canvasEvents };
}

/**
 * Meetings for one week, generated from the weekly pattern rather than from a
 * dated schedule. Only ever reached when the class has NO dated schedule at
 * all — a class whose syllabus lists sessions is trusted about which weeks it
 * meets, because inventing a lecture during reading week is exactly the kind
 * of confident wrong answer this module exists to avoid.
 */
function meetingsFromPatterns(patterns, from, to, { termStart, termEnd } = {}) {
  const out = [];
  for (let date = from; date && date <= to; date = addDays(date, 1)) {
    if (termStart && date < termStart) continue;
    if (termEnd && date > termEnd) continue;
    const code = DAY_CODES[weekdayIndex(date)];
    for (const p of patterns) {
      if (!asArray(p?.byday).includes(code)) continue;
      out.push({
        date,
        start: p.start ?? null,
        end: p.end ?? null,
        label: p.label ?? 'Class',
        topic: null,
        location: p.location ?? null,
        holiday: false,
        source: `weekly pattern${p.source ? ` ("${p.source}")` : ''}`,
      });
    }
  }
  return out;
}

function toMeetingFact(m) {
  const i = weekdayIndex(m.date);
  return {
    date: m.date,
    weekday: i == null ? null : WEEKDAY_LONG[i],
    start: m.start ?? null,
    end: m.end ?? null,
    label: m.label ?? 'Class',
    topic: m.topic ?? null,
    location: m.location ?? null,
    has_time: Boolean(m.start),
    holiday: Boolean(m.holiday),
    source: m.source ?? null,
  };
}

// EXAM_RE comes from canvas-tasks.js so FACTS applies the same guarded
// reading of "final" the task list does — a bare \bfinal\b here reported
// "Final Presentation" and "Project: Final Project Report" (real project
// deliverables on this user's classes) as the next exam, which rule 1 of the
// prompt then forces the model to repeat verbatim.
// "Midterm Case Preparation", "Final Session", "Midterm Recess" all name an
// exam word and none of them is an exam. Reporting one as "your next exam" is
// worse than reporting nothing, so these are excluded by construction.
const NOT_EXAM_PHRASE_RE = /\b(?:final|midterm)\s+(?:session|class|lecture|day|week|meeting|recess|break|prep\w*|review|holiday)\b/i;
const NOT_EXAM_CONTEXT_RE = /\b(?:no class|prep\b|preparation|review session|study day|recess|released|release|reading day)\b/i;

function examCandidatesFromTasks(items, today) {
  const out = [];
  for (const it of items) {
    const title = str(it?.title);
    const isExam = it?.category === 'exam' || EXAM_RE.test(title);
    if (!isExam) continue;
    if (NOT_EXAM_PHRASE_RE.test(title)) continue;
    const date = str(it?.due_date);
    if (!ISO_DATE_RE.test(date) || date < today) continue;
    out.push({
      date,
      time: it?.due_time ?? null,
      title: title || 'Untitled',
      source: it?.source ? `${it.source} assignment list` : 'assignment list',
      category: it?.category ?? 'exam',
      url: it?.html_url ?? null,
    });
  }
  return out;
}

function examCandidatesFromSyllabus(schedule, today) {
  const out = [];
  for (const e of asArray(schedule)) {
    const date = str(e?.date);
    if (!ISO_DATE_RE.test(date) || date < today) continue;
    const type = str(e?.type).toLowerCase();
    if (type === 'holiday') continue;
    const title = str(e?.title);
    const description = str(e?.description);
    const haystack = `${title} ${type}`;
    if (!EXAM_RE.test(haystack)) continue;
    if (NOT_EXAM_PHRASE_RE.test(`${title} ${description}`)) continue;
    if (NOT_EXAM_CONTEXT_RE.test(`${title} ${description}`)) continue;
    out.push({
      date,
      time: null,
      title: title || 'Exam',
      source: 'syllabus schedule',
      category: 'exam',
      url: null,
    });
  }
  return out;
}

// Earliest wins. On the same day, a candidate that knows the clock time beats
// one that does not, and the graded assignment row beats the syllabus prose.
function pickNextExam(candidates) {
  const ranked = candidates.slice().sort((a, b) =>
    a.date.localeCompare(b.date)
    || (b.time ? 1 : 0) - (a.time ? 1 : 0)
    || (a.source === 'syllabus schedule' ? 1 : 0) - (b.source === 'syllabus schedule' ? 1 : 0)
    || a.title.localeCompare(b.title));
  return ranked[0] ?? null;
}

function sortTasks(items) {
  return items.slice().sort((a, b) =>
    str(a.due_date).localeCompare(str(b.due_date))
    || str(a.due_time ?? '99:99').localeCompare(str(b.due_time ?? '99:99'))
    || str(a.title).localeCompare(str(b.title)));
}

/**
 * Everything about this class that can be computed rather than read.
 *
 * Resolves to { today, class, meetings, tasks, warnings }. Every time field is
 * null when unknown, never defaulted — renderFacts then says so in words.
 */
export async function classFacts(classDir, { now = new Date() } = {}) {
  const dir = path.resolve(str(classDir));
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const today = localIsoDate(at);
  const nowClock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  // A meeting that has already finished today is not the next one. Only an
  // END time can prove that; a meeting with no time stays in the running,
  // because "it may already have happened" is a better answer than skipping a
  // class that has not.
  const stillAhead = m => m.date > today || !m.end || m.end > nowClock;
  const warnings = [];

  const { metadata, syllabusParsed, assignments, mined, readings, canvasEvents } = await loadClassData(dir);

  const klass = {
    slug: path.basename(dir),
    code: metadata?.course_code ?? syllabusParsed?.course?.code ?? null,
    name: syllabusParsed?.course?.title ?? metadata?.name ?? null,
    term: metadata?.term?.name ?? syllabusParsed?.course?.term ?? null,
  };

  // --- Meetings -----------------------------------------------------------
  const rec = await recoverMeetingTimes(dir);
  const meetingWarnings = asArray(rec.warnings).slice();
  const patterns = asArray(rec.patterns);

  const dated = collectMeetings({
    syllabusParsed,
    canvasEvents: Array.isArray(canvasEvents) ? canvasEvents : [],
    patterns: patterns.length ? patterns : null,
  }).filter(m => ISO_DATE_RE.test(str(m?.date)));

  const termStart = metadata?.term?.start_at ? str(metadata.term.start_at).slice(0, 10) : null;
  const termEnd = metadata?.term?.end_at ? str(metadata.term.end_at).slice(0, 10) : null;

  const { start: weekStart, end: weekEnd } = weekWindow(now);
  let thisWeekRaw = dated.filter(m => m.date >= weekStart && m.date <= weekEnd);
  let nextRaw = dated.find(m => m.date >= today && !m.holiday && stillAhead(m)) ?? null;

  if (!dated.length && patterns.length) {
    // No dated schedule anywhere — the weekly pattern is all there is.
    meetingWarnings.push('This class has no dated schedule; these meetings come from the weekly pattern.');
    thisWeekRaw = meetingsFromPatterns(patterns, weekStart, weekEnd, { termStart, termEnd });
    const horizon = addDays(today, 27) ?? weekEnd;
    nextRaw = meetingsFromPatterns(patterns, today, horizon, { termStart, termEnd })
      .find(stillAhead) ?? null;
  } else if (dated.length) {
    const lastDated = dated[dated.length - 1].date;
    if (!nextRaw && lastDated < today) {
      meetingWarnings.push(`The course schedule ends ${lastDated} — no meetings are listed on or after today.`);
    }
  }

  const meetings = {
    source: rec.source,
    confidence: rec.confidence,
    summary: describeMeetingSource(rec),
    patterns,
    this_week: thisWeekRaw.map(toMeetingFact),
    next: nextRaw ? toMeetingFact(nextRaw) : null,
    warnings: uniq(meetingWarnings),
  };

  // --- Tasks --------------------------------------------------------------
  const taskWarnings = [];
  if (!Array.isArray(assignments)) {
    taskWarnings.push('assignments.json is missing or unreadable — Canvas work is not in this answer.');
  }
  const { items: allTasks, source: taskSource } = tasksForClass({
    mined,
    readings: readingsWithScheduleFloor(readings, syllabusParsed),
    assignments: Array.isArray(assignments) ? assignments : [],
  });
  const datedTasks = sortTasks(allTasks.filter(t => ISO_DATE_RE.test(str(t?.due_date))));
  const overdue = datedTasks.filter(t => t.due_date < today);
  const upcoming = datedTasks.filter(t => t.due_date >= today).slice(0, UPCOMING_LIMIT).map(t => ({
    date: t.due_date,
    time: t.due_time ?? null,
    title: str(t.title) || 'Untitled',
    category: t.category ?? null,
    points: t.points_possible ?? null,
    source: t.source ?? null,
    url: t.html_url ?? null,
  }));

  const nextExam = pickNextExam([
    ...examCandidatesFromTasks(datedTasks, today),
    ...examCandidatesFromSyllabus(syllabusParsed?.schedule, today),
  ]);

  // An exam the class knows about but has no date for is a real answer to
  // "when is the next exam" — "it exists, nobody has dated it" — and it is the
  // only honest one. Guessing a date from the syllabus prose is not.
  const undatedExams = uniq(allTasks
    .filter(t => (t?.category === 'exam' || EXAM_RE.test(str(t?.title)))
      && !ISO_DATE_RE.test(str(t?.due_date))
      && !NOT_EXAM_PHRASE_RE.test(str(t?.title)))
    .map(t => str(t.title) || 'Untitled'));

  const tasks = {
    source: taskSource,
    next_exam: nextExam,
    upcoming,
    overdue_count: overdue.length,
    total_dated: datedTasks.length,
    undated_exams: undatedExams,
    warnings: taskWarnings,
  };

  if (!syllabusParsed) {
    warnings.push('No syllabus_parsed.json — the syllabus schedule was not available.');
  }
  if (!allTasks.length) {
    warnings.push('No assignments or mined tasks for this class yet.');
  }

  return {
    today,
    class: klass,
    meetings,
    tasks,
    warnings: uniq([...warnings, ...meetings.warnings, ...taskWarnings]),
  };
}

// ==========================================================================
// A2. renderFacts
// ==========================================================================

function meetingLine(m) {
  const when = m.has_time
    ? timeRangeText(m.start, m.end)
    : 'time not known';
  const bits = [longDate(m.date), when];
  if (m.holiday) bits.push('NO CLASS');
  if (m.label && m.label.toLowerCase() !== 'class') bits.push(m.label);
  if (m.topic) bits.push(m.topic);
  if (m.location) bits.push(m.location);
  return `  - ${bits.join(' — ')}`;
}

function taskLine(t) {
  const when = t.time ? `${t.date} ${clock12(t.time) ?? t.time}` : `${t.date} (time not known)`;
  const tail = t.points == null ? '' : ` [${t.points} pts]`;
  return `  - ${when} — ${t.title}${tail}`;
}

/**
 * The FACTS block. Plain text, no markdown that a model might echo back, and
 * every unknown stated as an unknown in words — "time not known", never a
 * blank the model can fill in for itself.
 */
export function renderFacts(facts) {
  if (!facts) return 'FACTS\n(none available)';
  const out = [];
  const i = weekdayIndex(facts.today);
  const { start, end } = (() => {
    const d = dateAt(facts.today);
    return d ? weekWindow(d) : { start: facts.today, end: facts.today };
  })();

  out.push('FACTS (computed from this class\'s data; authoritative for anything dated)');
  out.push(`Today: ${facts.today}${i == null ? '' : ` (${WEEKDAY_LONG[i]})`}`);
  const c = facts.class ?? {};
  out.push(`Class: ${[c.code, c.name].filter(Boolean).join(' — ') || c.slug || 'unknown'}${c.term ? ` (${c.term})` : ''}`);
  out.push('');

  const m = facts.meetings ?? {};
  out.push('MEETINGS');
  out.push(`  Summary: ${m.summary ?? 'unknown'}`);
  for (const p of asArray(m.patterns)) {
    const t = timeRangeText(p.start, p.end);
    out.push(`  Weekly pattern: ${daysText(p.byday) || 'days unknown'} — ${t ?? 'START TIME NOT KNOWN (the syllabus never states one)'}${p.location ? ` — ${p.location}` : ''}`);
  }
  if (!asArray(m.patterns).length) {
    out.push('  Weekly pattern: not known for this class.');
  }
  out.push(`  This week (Mon ${start} to Sun ${end}):`);
  if (asArray(m.this_week).length) {
    for (const e of m.this_week) out.push(meetingLine(e));
  } else {
    out.push('  - No meetings are listed for this week.');
  }
  out.push(m.next
    ? `  Next meeting: ${meetingLine(m.next).replace(/^ {2}- /, '')}`
    : '  Next meeting: none listed on or after today.');
  for (const w of asArray(m.warnings)) out.push(`  Note: ${w}`);
  out.push('');

  const t = facts.tasks ?? {};
  out.push('WORK');
  out.push(`  Task list source: ${t.source ?? 'unknown'}; ${t.total_dated ?? 0} dated item(s); ${t.overdue_count ?? 0} overdue.`);
  if (t.next_exam) {
    const when = t.next_exam.time
      ? `${t.next_exam.date} at ${clock12(t.next_exam.time) ?? t.next_exam.time}`
      : `${t.next_exam.date} (time of day not known)`;
    out.push(`  Next exam: ${when} — ${t.next_exam.title} (from ${t.next_exam.source})`);
  } else {
    out.push('  Next exam: no exam is dated on or after today in this class\'s material.');
  }
  if (asArray(t.undated_exams).length) {
    out.push(`  Exams named but not dated: ${t.undated_exams.join('; ')}.`);
  }
  out.push('  Upcoming work:');
  if (asArray(t.upcoming).length) {
    for (const item of t.upcoming) out.push(taskLine(item));
  } else {
    out.push('  - Nothing dated on or after today.');
  }
  for (const w of asArray(t.warnings)) out.push(`  Note: ${w}`);

  return out.join('\n');
}

// ==========================================================================
// B. Source selection
// ==========================================================================

/**
 * Split a document into passages. Materials text from a slide deck is one
 * sentence per line with no blank lines, so a naive paragraph split returns
 * the whole 40KB file as a single passage — which is precisely the "dump the
 * file into the prompt" behaviour this is here to prevent.
 */
export function splitPassages(text, { target = PASSAGE_TARGET, max = PASSAGE_MAX } = {}) {
  const src = str(text).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!src) return [];
  const out = [];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    let buf = '';
    const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
    for (const line of lines) {
      if (line.length > max) {
        flush();
        // One enormous line (a PDF paragraph with no wrapping): cut on
        // sentence ends, then hard-cut whatever is still too long.
        let rest = line;
        while (rest.length > max) {
          const window = rest.slice(0, max);
          const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
          const at = cut > target / 2 ? cut + 1 : max;
          out.push(rest.slice(0, at).trim());
          rest = rest.slice(at);
        }
        if (rest.trim()) out.push(rest.trim());
        continue;
      }
      if (buf && buf.length + line.length + 1 > target) flush();
      buf = buf ? `${buf}\n${line}` : line;
    }
    flush();
  }
  // Very short fragments carry no context on their own; fold them forward.
  const merged = [];
  for (const p of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.length < PASSAGE_MIN && prev.length + p.length + 1 <= max) {
      merged[merged.length - 1] = `${prev}\n${p}`;
    } else {
      merged.push(p);
    }
  }
  return merged;
}

/**
 * Score one passage against the question's tokens. Deterministic, no idf table:
 * distinct query terms present dominate, repeats add a little, and length is
 * discounted so a long passage cannot win by containing everything once.
 */
export function scorePassage(passage, queryTokens) {
  if (!queryTokens?.size) return 0;
  const tokens = tokenise(passage, 2000);
  if (!tokens.length) return 0;
  const counts = new Map();
  for (const t of tokens) if (queryTokens.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  if (!counts.size) return 0;
  let score = 0;
  for (const [, k] of counts) score += 1 + 0.25 * Math.min(3, k - 1);
  const lengthPenalty = 1 + Math.log10(1 + passage.length / 400);
  return score / lengthPenalty;
}

function nodeIdParts(id) {
  const s = str(id);
  const at = s.indexOf(':');
  return at < 0 ? { kind: s, rest: '' } : { kind: s.slice(0, at), rest: s.slice(at + 1) };
}

function pageSlug(p) {
  const slug = p?.url ?? p?.page_url ?? (p?.page_id != null ? String(p.page_id) : null);
  return typeof slug === 'string' ? slug : null;
}

// A JSON cache per gatherSources call: a query touching eight quizzes must not
// parse a 127KB quizzes.json eight times.
function jsonCache(classDir) {
  const cache = new Map();
  return async (name) => {
    if (!cache.has(name)) cache.set(name, readJsonSafe(path.join(classDir, name)));
    return cache.get(name);
  };
}

/**
 * The text behind one graph node. File and syllabus nodes carry a
 * `textPath` into materials/; everything else lives in the class JSON and
 * arrives as HTML.
 */
async function nodeDocument(classDir, node, load) {
  const label = str(node?.label);
  const { kind, rest } = nodeIdParts(node?.id);
  const canvasId = node?.canvasId == null ? null : String(node.canvasId);

  const fromMaterials = async () => {
    if (!node?.textPath) return '';
    const abs = insideClassDir(classDir, node.textPath);
    if (!abs) return '';
    return (await readTextOrNull(abs)) ?? '';
  };

  let body = '';
  switch (kind) {
    case 'file':
      body = await fromMaterials();
      break;
    case 'syllabus':
      body = await fromMaterials();
      if (!body) body = stripHtml((await readTextOrNull(path.join(classDir, 'syllabus.html'))) ?? '');
      break;
    case 'assignment': {
      const row = asArray(await load('assignments.json')).find(a => String(a?.id) === (canvasId ?? rest));
      body = stripHtml(row?.description);
      break;
    }
    case 'quiz': {
      const row = asArray(await load('quizzes.json')).find(q => String(q?.id) === (canvasId ?? rest));
      body = stripHtml(row?.description);
      break;
    }
    case 'page': {
      const row = asArray(await load('pages.json')).find(p => pageSlug(p) === rest);
      body = stripHtml(row?.body);
      break;
    }
    case 'announcement': {
      const row = asArray(await load('announcements.json')).find(a => String(a?.id) === (canvasId ?? rest));
      body = stripHtml(row?.message);
      break;
    }
    case 'discussion': {
      const row = asArray(await load('discussions.json')).find(d => String(d?.id) === (canvasId ?? rest));
      body = stripHtml(row?.message);
      break;
    }
    case 'module': {
      const rows = asArray(await load('modules.json'));
      const row = rows.find(mod => (canvasId != null && String(mod?.id) === canvasId))
        ?? rows.find(mod => str(mod?.name) && rest.startsWith(str(mod.name).slice(0, 40)));
      body = asArray(row?.items).map(it => str(it?.title)).filter(Boolean).join('\n');
      break;
    }
    default:
      body = '';
  }
  // The label leads the document so a node selected purely by its title still
  // has one passage that scores — an assignment row with an empty description
  // is otherwise silently dropped for having no matching text.
  return `${label}\n\n${body}`.trim();
}

/**
 * The passages of this class worth putting in front of a model for `question`.
 *
 * Two retrievers, merged. The graph routes: selectForQuery picks the seed
 * nodes, one hop of neighbours() widens a thin selection, and then only the
 * passages that actually score against the question are loaded — a 40KB deck
 * contributes a few hundred characters or nothing at all.
 *
 * But the graph stores each node as its top-12 tf-idf terms, which means a
 * 30-page syllabus is represented by twelve words. Stress-testing this against
 * the real BUSI 380 data, "what is the grading breakdown" selected NOTHING and
 * "attendance policy" selected modules and quizzes but not the syllabus — and
 * the syllabus is where both answers live (its line 107 reads "Grading Point
 * Allocation/Process and Assignment Due Dates"). The model then correctly said
 * it did not have the material. The router had simply never handed it any.
 *
 * So a full-text sweep of materials/ runs alongside the graph and its hits are
 * merged in. The graph still decides what is *about* the question; the sweep
 * catches what the twelve terms could not represent. For a policy question the
 * syllabus is forced in outright — that is the one document where "we searched
 * and found nothing" is almost always a retrieval failure rather than an answer.
 *
 * opts:
 *   graph          a prebuilt graph (skips disk)
 *   buildIfMissing build one in memory when correlation_graph.json is absent
 *                  (deterministic, ~30ms for 93 nodes, never calls a model)
 *   budgetChars    total characters of source text (default 20000)
 *   limit          node ids requested from selectForQuery
 *   maxSources     most documents that may become [S1]..[Sn]
 *   fullText       run the materials/ sweep too (default true)
 */
export async function gatherSources(classDir, question, opts = {}) {
  const {
    graph: given = null,
    buildIfMissing = true,
    budgetChars = DEFAULT_BUDGET_CHARS,
    limit = DEFAULT_NODE_LIMIT,
    maxSources = MAX_SOURCES,
    expand = true,
    perSourceChars = null,
    fullText = true,
  } = opts ?? {};

  const dir = path.resolve(str(classDir));
  const stats = { nodesSelected: 0, nodesExpanded: 0, nodesUsed: 0, nodesDropped: 0, chars: 0, budget: budgetChars, graph: 'none', textHits: 0, textUsed: 0, syllabusForced: false };
  const withStats = (arr) => {
    Object.defineProperty(arr, 'stats', { value: stats, enumerable: false });
    return arr;
  };

  const q = str(question).trim();
  if (!q) return withStats([]);

  let graph = given;
  if (!graph) {
    graph = await readGraph(dir);
    stats.graph = graph ? 'file' : 'none';
    if (!graph && buildIfMissing) {
      try {
        graph = await buildGraph(dir);
        stats.graph = 'built';
      } catch { graph = null; }
    }
  } else {
    stats.graph = 'given';
  }
  // No early return when the graph is missing or selects nothing. An empty
  // graph selection used to mean zero sources, which is how "what is the
  // grading breakdown" came back empty on a class whose syllabus answers it in
  // so many words. The full-text sweep below gets its turn either way.
  const seeds = graph ? selectForQuery(graph, q, { limit }) : [];
  stats.nodesSelected = seeds.length;

  let ids = seeds.slice();
  if (graph && expand && ids.length < THIN_SELECTION) {
    const seen = new Set(ids);
    for (const id of seeds) {
      for (const nb of neighbours(graph, id, 4)) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        ids.push(nb);
        stats.nodesExpanded++;
      }
    }
    ids = ids.slice(0, limit);
  }

  const byId = new Map(asArray(graph?.nodes).map(n => [n.id, n]));
  const load = jsonCache(dir);
  const queryTokens = new Set(tokenise(q, 256));
  const perSource = perSourceChars ?? Math.min(3000, Math.max(600, Math.round(budgetChars / 6)));

  const out = [];
  let used = 0;
  for (const id of ids) {
    if (out.length >= maxSources) { stats.nodesDropped++; continue; }
    const remaining = budgetChars - used;
    if (remaining < 200) { stats.nodesDropped++; continue; }
    const node = byId.get(id);
    if (!node) { stats.nodesDropped++; continue; }

    const doc = await nodeDocument(dir, node, load);
    const passages = splitPassages(doc);
    const scored = passages
      .map((text, index) => ({ text, index, score: scorePassage(text, queryTokens) }))
      .filter(p => p.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);

    if (!scored.length) { stats.nodesDropped++; continue; }

    const cap = Math.min(perSource, remaining);
    const keep = [];
    let chars = 0;
    let omitted = 0;
    let clipped = false;
    for (const p of scored) {
      if (chars + p.text.length + 3 > cap) { omitted++; continue; }
      keep.push(p);
      chars += p.text.length + 3;
    }
    if (!keep.length) {
      // Every scoring passage is larger than what is left of the budget: take
      // the best one clipped, rather than dropping a relevant document.
      const best = scored[0];
      const clip = best.text.slice(0, Math.max(0, cap - 3));
      if (clip.length < 80) { stats.nodesDropped++; continue; }
      keep.push({ ...best, text: `${clip}…` });
      omitted = scored.length - 1;
      clipped = true;
      chars = clip.length + 3;
    }
    keep.sort((a, b) => a.index - b.index);

    const text = keep.map(p => p.text).join('\n…\n');
    used += text.length;
    stats.nodesUsed++;
    out.push({
      tag: `S${out.length + 1}`,
      nodeId: node.id,
      kind: node.kind ?? nodeIdParts(node.id).kind,
      label: str(node.label) || node.id,
      url: node.url ?? null,
      date: node.date ?? null,
      text,
      chars: text.length,
      // `truncated` means RELEVANT material was left behind — either whole
      // scoring passages that did not fit, or the best one cut short. Passages
      // that simply did not match the question are not truncation; the gap
      // between kept_passages and total_passages is what says how much of the
      // document was never in the running.
      truncated: omitted > 0 || clipped,
      clipped,
      omitted_passages: omitted,
      kept_passages: keep.length,
      total_passages: passages.length,
      seed: seeds.includes(id),
      retriever: 'graph',
    });
  }

  // --- Second retriever: the full text of materials/ --------------------
  //
  // The graph knows what each document is ABOUT, in twelve terms. That is
  // enough to route and far too little to answer from. This sweep scores real
  // passages, so a phrase that appears once on page 4 of a syllabus is findable
  // even though it never made the node's term list.
  //
  // It runs unconditionally rather than only when the graph left room, because
  // "how is the midterm case graded" is exactly the case where the graph fills
  // all eight slots with bare titles — 40, 91 and 83 characters — totalling 837
  // characters against a 20,000 budget, while the two syllabus paragraphs that
  // answer the question wait outside. Slots, not characters, were the scarce
  // resource, and the least informative sources were holding them.
  if (fullText && budgetChars - used >= 200) {
    // A question that reduces to one common term cannot discriminate: "when
    // does this class meet this week" is just {meet}, which matched three
    // unrelated slide decks. With nothing to discriminate on, the sweep is
    // restricted to the syllabus, where a weak match is still worth reading.
    const contentTerms = new Set(tokenise(q));
    const syllabus = contentTerms.size < 2 || isPolicyQuestion(q)
      ? await findSyllabusDoc(dir).catch(() => null)
      : null;

    let hits = contentTerms.size < 2
      ? (syllabus ? await searchClassText(dir, q, { only: d => d.path === syllabus.path, limit: 2 }).catch(() => []) : [])
      : await searchClassText(dir, q).catch(() => []);

    // A policy question — grading, attendance, late work, the honor code — is
    // the one case where an empty result is almost always a retrieval failure
    // rather than an answer: the syllabus says something about it, near
    // certainly. So force the syllabus in and let the passage scorer pick the
    // part that matches, instead of reporting that this class has no policy.
    if (syllabus && !hits.some(h => h.path === syllabus.path)) {
      const forced = await searchClassText(dir, q, {
        only: d => d.path === syllabus.path, minScore: 0, minTerms: 1, limit: 2,
      }).catch(() => []);
      if (forced.length) {
        stats.syllabusForced = true;
        hits = forced.concat(hits);
      }
    }
    stats.textHits = hits.length;

    // Make room. A text hit is worth more than a graph node that contributed
    // only its own title, so evict those first — never a seed before a
    // one-hop neighbour, and never a text source already placed.
    const reserve = Math.min(hits.length, TEXT_RESERVED_SLOTS);
    while (hits.length && out.length + reserve > maxSources) {
      let worst = -1;
      for (let i = 0; i < out.length; i++) {
        // `retriever`, not `kind`: a graph node's kind is 'file' whenever it
        // came from materials/, so keying eviction on kind skipped every
        // candidate and quietly restored the crowding this block exists to fix.
        if (out[i].retriever !== 'graph') continue;
        if (worst < 0) { worst = i; continue; }
        const a = out[i], b = out[worst];
        if (a.seed !== b.seed) { if (!a.seed) worst = i; continue; }
        if (a.chars < b.chars) worst = i;
      }
      if (worst < 0) break;
      used -= out[worst].chars;
      out.splice(worst, 1);
      stats.nodesUsed--;
      stats.nodesDropped++;
    }

    const seen = new Set(out.map(src => textKey(src.text)));
    for (const hit of hits) {
      if (out.length >= maxSources) break;
      const remaining = budgetChars - used;
      if (remaining < 200) break;

      const key = textKey(hit.text);
      if (seen.has(key)) continue;
      seen.add(key);

      const cap = Math.min(perSource, remaining);
      const clipped = hit.text.length + 3 > cap;
      const text = clipped ? `${hit.text.slice(0, Math.max(0, cap - 3))}…` : hit.text;
      if (text.length < 80) continue;

      used += text.length;
      stats.textUsed++;
      out.push({
        tag: '',
        nodeId: `file:${hit.name}`,
        kind: 'file',
        label: hit.label || hit.name,
        url: null,
        date: null,
        text,
        chars: text.length,
        truncated: clipped,
        clipped,
        omitted_passages: 0,
        kept_passages: 1,
        total_passages: 1,
        seed: false,
        retriever: 'text',
      });
    }
  }

  // Tags are assigned last. Eviction above can remove a source that already
  // held S3, and a prompt that cites [S3] when no [S3] is listed is exactly the
  // fabricated-citation failure cleanAnswer exists to catch.
  out.forEach((src, i) => { src.tag = `S${i + 1}`; });

  stats.chars = used;
  return withStats(out);
}

/**
 * A passage's identity for dedup purposes. The two retrievers can reach the
 * same words by different routes — a Canvas page whose body was also extracted
 * to materials/ — and paying for it twice costs the budget a document that
 * would otherwise have fit.
 */
function textKey(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);
}

// ==========================================================================
// C. Prompt
// ==========================================================================

function normaliseHistory(history) {
  const out = [];
  for (const turn of asArray(history).slice(-4)) {
    if (!turn) continue;
    if (typeof turn.role === 'string') {
      const role = turn.role.toLowerCase() === 'assistant' ? 'A' : 'Q';
      const content = str(turn.content ?? turn.text).trim();
      if (content) out.push(`${role}: ${content}`);
      continue;
    }
    const q = str(turn.q ?? turn.question).trim();
    const a = str(turn.a ?? turn.answer).trim();
    if (q) out.push(`Q: ${q}`);
    if (a) out.push(`A: ${a}`);
  }
  return out;
}

function sourceHeader(s) {
  const bits = [s.kind, s.date ? str(s.date).slice(0, 10) : null, s.url].filter(Boolean);
  return `[${s.tag}] ${s.label}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

// Which node kinds count as a TASK a student prepares for, and which count as
// MATERIAL to prepare with. The syllabus is deliberately not a material: every
// task in a class correlates with its syllabus, so listing it answers nothing.
const TASK_KINDS = new Set(['assignment', 'quiz', 'discussion']);
const MATERIAL_KINDS = new Set(['file', 'page']);

/**
 * "Which documents go with this task", computed from the correlation graph's
 * edges — the class's own cross-references, not the model's guess. Only SEED
 * sources are considered tasks: a seed is a node the question itself matched,
 * so a question naming one assignment yields that assignment's materials and
 * not a digest of every task the budget happened to include.
 */
export function relatedMaterials(graph, sources, { perTask = 6, maxTasks = 3 } = {}) {
  const nodes = new Map(asArray(graph?.nodes).filter(n => n?.id).map(n => [n.id, n]));
  if (!nodes.size) return [];
  const out = [];
  const seenTask = new Set();
  for (const s of asArray(sources)) {
    if (!s?.seed || !TASK_KINDS.has(s.kind)) continue;
    if (seenTask.has(s.nodeId)) continue;
    if (out.length >= maxTasks) break;
    seenTask.add(s.nodeId);
    const mats = [];
    const seen = new Set();
    // Ask for more neighbours than we keep: the nearest edges are usually
    // other tasks in the same module, and those are filtered out here.
    for (const id of neighbours(graph, s.nodeId, perTask * 4)) {
      const n = nodes.get(id);
      const kind = n?.kind ?? nodeIdParts(id).kind;
      if (!MATERIAL_KINDS.has(kind)) continue;
      const label = str(n?.label).trim() || id;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      mats.push(label);
      if (mats.length >= perTask) break;
    }
    if (mats.length) out.push({ task: str(s.label).trim() || s.nodeId, materials: mats });
  }
  return out;
}

/**
 * The whole prompt. Terse, because the user asked for concise and precise and
 * a long instruction block is where "here's a helpful overview" comes from.
 */
export function buildPrompt({ facts, sources = [], question, history = [], related = [] } = {}) {
  const list = asArray(sources);
  const out = [];

  out.push('You answer questions about one university course. Use only what is below.');
  out.push('');
  out.push('RULES');
  out.push('1. Dates, times, meetings, deadlines, exams: take them from FACTS only. Never read a time or a date out of SOURCES, and never infer one.');
  out.push('2. If FACTS says a time or date is not known, say it is not known. Do not guess or offer a typical value.');
  out.push('3. Which readings, articles, files or materials go with a task: copy the list from RELATED MATERIALS. If the task is not listed there and no SOURCE states its materials, say the class does not name any.');
  out.push('4. Everything else: use SOURCES only, and put the tag ([S1], [S2]) right after the sentence it supports.');
  out.push(`5. If the answer is not in FACTS, RELATED MATERIALS or SOURCES, reply with exactly this and nothing else: ${NO_ANSWER}`);
  out.push('6. No preamble, no restating the question, no praise, no acknowledgement, no sign-off, no offer of further help.');
  out.push('7. At most three sentences, or a short list. Plain text.');
  out.push('');
  out.push(renderFacts(facts));
  out.push('');

  // The user's canonical question is "which articles should I read for this
  // assignment" — and the honest answer is almost never a sentence in any
  // source. It is the correlation graph's edges: computed from the class's
  // own cross-references, the same way meeting times are computed by
  // meeting-times.js. So it ships as a FACT the model copies, not a link it
  // is asked to infer from prose — under rule 4 alone the model (correctly)
  // refused to invent a reading list and fell back to NO_ANSWER.
  const rel = asArray(related);
  if (rel.length) {
    out.push("RELATED MATERIALS (cross-references computed from this class's own data; authoritative for which document goes with which task)");
    for (const r of rel) out.push(`- ${r.task}: ${r.materials.join('; ')}`);
    out.push('');
  }

  if (list.length) {
    out.push(`SOURCES (${list.length} excerpt${list.length === 1 ? '' : 's'} from this class's own material)`);
    for (const s of list) {
      out.push('');
      out.push(sourceHeader(s));
      out.push(str(s.text));
      if (s.truncated) out.push(`(${s.omitted_passages} less relevant passage(s) from this document were left out.)`);
    }
  } else {
    out.push('SOURCES');
    out.push('(none — no document in this class matched the question. Answer from FACTS or use the exact fallback sentence.)');
  }
  out.push('');

  const hist = normaliseHistory(history);
  if (hist.length) {
    out.push('EARLIER IN THIS CONVERSATION');
    out.push(...hist);
    out.push('');
  }

  out.push('QUESTION');
  out.push(str(question).trim());
  out.push('');
  out.push('ANSWER (no preamble):');
  return out.join('\n');
}

// ==========================================================================
// D. cleanAnswer — the guard rail
// ==========================================================================

// Each pattern must be safe against a legitimate answer that merely starts
// with the same word, so every one of them requires punctuation, a colon, or a
// specific noun before it will fire.
const PREAMBLE_PATTERNS = [
  // "Sure!", "Certainly.", "Great question —"
  /^(?:sure(?:\s+thing)?|certainly|absolutely|of course|got it|great question|good question|excellent question|happy to help|no problem|thanks for asking)(?=\s*[!,.:;—–-])[\s!,.:;—–-]*/i,
  // "Here's the answer:", "Here is what I found:"
  /^here(?:'s|’s| is| are)\b[^\n:]{0,60}:[ \t]*\n?/i,
  // "Based on the provided context," / "According to the sources:"
  /^(?:based (?:on|upon)|according to|drawing (?:on|from)|from)\s+(?:the\s+)?(?:provided\s+|given\s+|above\s+|attached\s+|supplied\s+)?(?:context|sources?|materials?|documents?|information|facts|excerpts?|passages?|data)\b[^\n]{0,40}?[,:]\s*/i,
  // "Answer:", "**Answer:**", "Response:"
  /^\**\s*(?:answer|response|reply)\s*\**\s*:[ \t]*\**[ \t]*\n?/i,
  // A stray markdown fence the model wrapped everything in.
  /^```[a-z]*\s*\n/i,
];

const SIGNOFF_WORDS = String.raw`let me know if|hope (?:this|that) helps|feel free to|if you (?:have|need) (?:any )?(?:other|more|further|additional)?\s*questions?|happy to (?:help|clarify|elaborate)|don'?t hesitate|anything else\?`;

// A sign-off is removed only when something ELSE ends first: either a previous
// line, or a finished sentence. Without that anchor the pattern eats an answer
// that is itself one sentence long — "Let me know if you need anything else"
// is a bad answer, but deleting it and returning an empty string is worse.
const SIGNOFF_PATTERNS = [
  new RegExp(String.raw`\n[ \t]*[^\n]*\b(?:${SIGNOFF_WORDS})[^\n]*$`, 'i'),
  // Anchored on the END of the previous sentence, and the span it removes may
  // not itself contain a sentence end — otherwise a greedy match starting at
  // the first period swallows every sentence between there and the sign-off.
  new RegExp(String.raw`(?<=[.!?…])[^\n.!?]*\b(?:${SIGNOFF_WORDS})[^\n]*$`, 'i'),
  /\n?[ \t]*```\s*$/,
];

function normalisePhrase(s) {
  return str(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** '[S1]', '[ s2 ]', '[s3]' -> canonical tag + span. */
const CITE_RE = /\[\s*[sS]\s*(\d{1,3})\s*\]/g;

/**
 * Strip whatever the model produced in spite of the rules, and drop citation
 * tags naming a source that was never supplied.
 *
 * `opts.question` is optional and additive: when the caller knows what was
 * asked, an opening line that merely repeats it can be removed exactly rather
 * than heuristically.
 *
 * Returns { answer, citations, dropped }. `citations` are the surviving tags in
 * first-appearance order; `dropped` are the fabricated ones that were removed.
 */
export function cleanAnswer(raw, sources = [], { question = null } = {}) {
  const valid = new Set(asArray(sources).map(s => str(s?.tag).toUpperCase()).filter(Boolean));
  let text = str(raw).replace(/\r\n?/g, '\n').trim();
  if (!text) return { answer: '', citations: [], dropped: [] };

  // --- Preamble, repeatedly: "Sure! Here's what I found: ..." is two of them.
  const stripPreamble = () => {
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const re of PREAMBLE_PATTERNS) {
        const next = text.replace(re, '');
        if (next !== text && next.trim()) { text = next.trimStart(); changed = true; }
      }
      if (!changed) break;
    }
  };
  stripPreamble();

  // --- A restated question as the first line. Only ever removed when there is
  // something after it: an answer that IS one line must survive intact.
  const lines = text.split('\n');
  if (lines.length > 1) {
    const head = lines[0];
    const rest = lines.slice(1).join('\n').trim();
    const bare = head.replace(/^\**\s*(?:question|q)\s*\**\s*:\s*/i, '').replace(/\*+/g, '').trim();
    const labelled = /^\**\s*(?:question|q)\s*\**\s*:/i.test(head);
    const echoesQuestion = question != null
      && normalisePhrase(bare) === normalisePhrase(question)
      && normalisePhrase(bare) !== '';
    // "When is the next exam?" followed by the answer is a restatement; a
    // one-line answer that happens to end in a question mark is not, and it
    // cannot reach here because `rest` would be empty.
    const interrogative = /\?\s*$/.test(head) && bare.length <= 160;
    if (rest && (labelled || echoesQuestion || interrogative)) {
      text = rest;
      stripPreamble();
    }
  }

  // --- Sign-offs, repeatedly.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const re of SIGNOFF_PATTERNS) {
      const next = text.replace(re, '');
      if (next !== text && next.trim()) { text = next.trimEnd(); changed = true; }
    }
    if (!changed) break;
  }

  // --- Citations.
  const dropped = [];
  const citations = [];
  text = text.replace(CITE_RE, (_m, n) => {
    const tag = `S${Number(n)}`;
    if (valid.has(tag)) {
      if (!citations.includes(tag)) citations.push(tag);
      return `[${tag}]`;
    }
    if (!dropped.includes(tag)) dropped.push(tag);
    return '';
  });

  // Removing a tag leaves " ." or a doubled space behind.
  text = text
    .replace(/\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { answer: text, citations, dropped };
}

// ==========================================================================
// E. resolveClass
// ==========================================================================

const SUBJECT_ALIASES = {
  busi: ['business'],
  bus: ['business'],
  entr: ['entrepreneurship', 'entrepreneurial', 'entrepreneur', 'startup', 'venture'],
  mgmt: ['management'],
  mktg: ['marketing'],
  acct: ['accounting'],
  fina: ['finance', 'financial'],
  econ: ['economics', 'economic'],
  stat: ['statistics', 'statistical'],
  comp: ['computing', 'computer'],
  psyc: ['psychology'],
  hist: ['history'],
  chem: ['chemistry'],
  phys: ['physics'],
  math: ['mathematics'],
};

const CODE_RE = /\b([a-z]{2,5})\s*[- ]?\s*(\d{3})\b/i;
const SLUG_RE = /^(\d+)-([a-z]{2,5})-(\d{3})/i;

// Words that appear in a syllabus FILENAME and say nothing about the subject.
// Without this, "what is due this fall" scores a hit on whichever class
// happens to have "Fall 2026" in its filename — a confident wrong class.
const FILENAME_NOISE = new Set(`
syllabus syllabi fall spring summer winter term semester final draft updated
revised version copy new old pdf docx doc pptx ppt txt rtf pages
jan feb mar apr may jun jul aug sep sept oct nov dec
january february march april june july august september october november december
`.split(/\s+/).filter(Boolean));

async function describeClassDir(dir) {
  const slug = path.basename(dir);
  const [metadata, parsed, filesIndex] = await Promise.all([
    readJsonSafe(path.join(dir, 'metadata.json')),
    readJsonSafe(path.join(dir, 'syllabus_parsed.json')),
    readJsonSafe(path.join(dir, 'files_index.json')),
  ]);
  const code = str(metadata?.course_code || parsed?.course?.code || '');
  const title = str(parsed?.course?.title || '');
  const name = str(metadata?.name || '');
  const syllabusFile = asArray(filesIndex).find(f => /syllab/i.test(str(f?.displayName)))?.displayName ?? '';

  const fromCode = CODE_RE.exec(code) ?? SLUG_RE.exec(slug) ?? CODE_RE.exec(name);
  const subject = fromCode ? str(fromCode[fromCode.length - 2]).toLowerCase() : '';
  const number = fromCode ? str(fromCode[fromCode.length - 1]) : '';

  const words = new Set([
    ...tokenise(title, 64),
    ...tokenise(name, 64),
    ...tokenise(str(syllabusFile).replace(/[._-]+/g, ' '), 64).filter(t => !FILENAME_NOISE.has(t)),
    ...(SUBJECT_ALIASES[subject] ?? []),
  ]);
  if (subject) words.add(subject);

  return { slug, dir, code: code || null, title: title || name || null, subject, number, words };
}

function scoreClass(entry, q, rarity) {
  let score = 0;
  const lower = q.toLowerCase();

  if (entry.slug && lower.includes(entry.slug.toLowerCase())) score += 8;

  if (entry.subject && entry.number) {
    const pair = new RegExp(`\\b${entry.subject}\\s*[- ]?\\s*${entry.number}\\b`, 'i');
    if (pair.test(lower)) score += 5;
    for (const alias of SUBJECT_ALIASES[entry.subject] ?? []) {
      if (new RegExp(`\\b${alias}\\s*[- ]?\\s*${entry.number}\\b`, 'i').test(lower)) score += 5;
    }
  }
  if (entry.number && new RegExp(`\\b${entry.number}\\b`).test(lower)) score += 3;

  for (const token of new Set(tokenise(q, 128))) {
    if (!entry.words.has(token)) continue;
    // A word only one class uses ("marketing") identifies it; a word every
    // class uses ("business") barely narrows anything.
    score += (rarity.get(token) ?? 1) === 1 ? 2 : 0.5;
  }
  return Math.round(score * 100) / 100;
}

/**
 * Which class a general question is about.
 *
 * `baseDir` may be the data root or the classes directory itself. Returns the
 * winner with a confidence, or ambiguous:true plus candidates when the top two
 * are close or nothing matched — the user explicitly allowed asking for
 * clarification, and a confident wrong class is the worst outcome available.
 */
export async function resolveClass(baseDir, question, { hint = null } = {}) {
  const base = path.resolve(str(baseDir));
  let root = base;
  if (path.basename(base) !== 'classes') {
    try {
      const s = await fs.stat(path.join(base, 'classes'));
      if (s.isDirectory()) root = path.join(base, 'classes');
    } catch { /* base itself is the classes dir, or does not exist */ }
  }

  let dirents = [];
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { slug: null, dir: null, confidence: 'none', candidates: [], ambiguous: true };
  }
  const dirs = dirents
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => path.join(root, e.name))
    .sort();

  const entries = [];
  for (const d of dirs) entries.push(await describeClassDir(d));
  if (!entries.length) {
    return { slug: null, dir: null, confidence: 'none', candidates: [], ambiguous: true };
  }

  const shape = e => ({ slug: e.slug, dir: e.dir, code: e.code, title: e.title });

  // --- An explicit hint wins outright, when it names something real.
  const h = str(hint).trim().toLowerCase();
  if (h) {
    const exact = entries.find(e => e.slug.toLowerCase() === h)
      ?? entries.find(e => normalisePhrase(e.code) === normalisePhrase(h))
      ?? entries.find(e => e.slug.toLowerCase().includes(h) && h.length >= 3);
    if (exact) {
      return {
        slug: exact.slug,
        dir: exact.dir,
        confidence: 'high',
        candidates: [{ ...shape(exact), score: null }],
        ambiguous: false,
      };
    }
  }

  const rarity = new Map();
  for (const e of entries) for (const w of e.words) rarity.set(w, (rarity.get(w) ?? 0) + 1);

  const q = str(question);
  const ranked = entries
    .map(e => ({ ...shape(e), score: scoreClass(e, q, rarity) }))
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));

  const top = ranked[0];
  if (!top || top.score <= 0) {
    return { slug: null, dir: null, confidence: 'none', candidates: ranked, ambiguous: true };
  }

  const second = ranked[1];
  if (second && second.score > 0 && top.score - second.score < 1.5) {
    const cutoff = second.score;
    return {
      slug: null,
      dir: null,
      confidence: 'low',
      candidates: ranked.filter(r => r.score >= cutoff).slice(0, 4),
      ambiguous: true,
    };
  }

  return {
    slug: top.slug,
    dir: top.dir,
    confidence: top.score >= 4 ? 'high' : top.score >= 2 ? 'medium' : 'low',
    candidates: ranked.slice(0, 3),
    ambiguous: false,
  };
}

// ==========================================================================
// F. answerQuestion
// ==========================================================================

function factsAreUseful(facts) {
  const m = facts?.meetings ?? {};
  const t = facts?.tasks ?? {};
  return Boolean(
    asArray(m.this_week).length
    || m.next
    || asArray(m.patterns).length
    || t.next_exam
    || asArray(t.upcoming).length
    || asArray(t.undated_exams).length,
  );
}

/**
 * Ask one class one question.
 *
 * `invoke` is injectable and defaults to aiInvoke from _util.js. Tests pass a
 * fake; nothing here calls a model when there is nothing to answer from.
 *
 * Resolves to { answer, citations, sources, facts, warnings, used_model, dropped }.
 */
export async function answerQuestion({
  classDir,
  question,
  history = [],
  invoke = aiInvoke,
  now = new Date(),
  budgetChars = DEFAULT_BUDGET_CHARS,
  sourceOpts = {},
} = {}) {
  const q = str(question).trim();
  if (!q) {
    return {
      answer: NO_ANSWER,
      citations: [],
      sources: [],
      related: [],
      facts: null,
      warnings: ['No question was asked.'],
      used_model: false,
      dropped: [],
    };
  }

  const facts = await classFacts(classDir, { now });

  // The graph is read once and shared: gatherSources selects with it, and
  // relatedMaterials walks its edges for the task↔material cross-references.
  let graph = sourceOpts.graph ?? null;
  if (!graph) {
    const dir = path.resolve(str(classDir));
    graph = await readGraph(dir);
    if (!graph && (sourceOpts.buildIfMissing ?? true)) {
      try { graph = await buildGraph(dir); } catch { graph = null; }
    }
  }

  const sources = await gatherSources(classDir, q, { ...sourceOpts, ...(graph ? { graph } : {}), budgetChars });
  const related = graph ? relatedMaterials(graph, sources) : [];
  const warnings = uniq(asArray(facts.warnings));

  if (!sources.length && !factsAreUseful(facts)) {
    // Nothing computed, nothing retrieved. Calling a model here can only
    // produce an invention.
    return {
      answer: NO_ANSWER,
      citations: [],
      sources: [],
      related,
      facts,
      warnings: uniq([...warnings, 'This class has no schedule, no dated work and no matching material.']),
      used_model: false,
      dropped: [],
    };
  }

  const prompt = buildPrompt({ facts, sources, question: q, history, related });
  const raw = await invoke(prompt);
  const { answer, citations, dropped } = cleanAnswer(raw, sources, { question: q });

  return {
    answer: answer || NO_ANSWER,
    citations,
    sources,
    related,
    facts,
    warnings: dropped.length
      ? uniq([...warnings, `The model cited ${dropped.length} source(s) that were not supplied; they were removed.`])
      : warnings,
    used_model: true,
    dropped,
  };
}

// ==========================================================================
// G. CLI
// ==========================================================================

// The CLI never calls the model unless asked to in so many words. The default
// is a dry run: it prints the FACTS block and the sources that would go into
// the prompt, which is the part worth checking by eye.
const USAGE = `Usage:
  node class-chat.js <classDir> "<question>" [options]
  node class-chat.js --resolve "<question>"        which class is this about?

Options:
  --facts-only     print the FACTS block and stop
  --fake           answer with a built-in stub instead of a model
  --run-model      answer with the configured AI backend (terminal CLI first)
  --json           machine-readable output
  --budget <n>     source character budget (default ${DEFAULT_BUDGET_CHARS})
`;

function fakeInvoke(prompt) {
  return Promise.resolve(
    `Sure! Here's what I found: this is a stub answer produced without a model `
    + `(${prompt.length} prompt chars). [S1] Let me know if you need anything else!`,
  );
}

async function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const flag = name => args.includes(name);
  const valueOf = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const positional = args.filter((a, i) =>
    !a.startsWith('--') && args[i - 1] !== '--budget');

  if (flag('--resolve')) {
    const res = await resolveClass(classHome(), positional.join(' '));
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return res.ambiguous ? 2 : 0;
  }

  const classDir = positional[0];
  const question = positional.slice(1).join(' ');
  if (!classDir) {
    process.stderr.write(USAGE);
    return 1;
  }

  const facts = await classFacts(classDir);
  if (flag('--facts-only') || !question) {
    process.stdout.write(`${renderFacts(facts)}\n`);
    return 0;
  }

  const budgetChars = Number(valueOf('--budget', DEFAULT_BUDGET_CHARS)) || DEFAULT_BUDGET_CHARS;

  if (!flag('--fake') && !flag('--run-model')) {
    // Mirror answerQuestion: same graph read, same related computation, so
    // the dry run previews the prompt the model would actually get.
    let graph = await readGraph(path.resolve(str(classDir)));
    if (!graph) { try { graph = await buildGraph(path.resolve(str(classDir))); } catch { graph = null; } }
    const sources = await gatherSources(classDir, question, { ...(graph ? { graph } : {}), budgetChars });
    const related = graph ? relatedMaterials(graph, sources) : [];
    const prompt = buildPrompt({ facts, sources, question, related });
    if (flag('--json')) {
      process.stdout.write(`${JSON.stringify({ facts, sources, related, promptChars: prompt.length }, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderFacts(facts)}\n\n`);
      for (const r of related) {
        process.stdout.write(`RELATED — ${r.task}: ${r.materials.join('; ')}\n`);
      }
      process.stdout.write(`SOURCES SELECTED (${sources.length}, ${sources.stats?.chars ?? 0} chars, graph: ${sources.stats?.graph}):\n`);
      for (const s of sources) {
        process.stdout.write(`  ${s.tag} ${s.kind} — ${s.label} (${s.chars} chars${s.truncated ? `, ${s.omitted_passages} passages omitted` : ''})\n`);
      }
      process.stdout.write(`\nPrompt would be ${prompt.length} characters. `);
      process.stdout.write('Re-run with --fake (stub) or --run-model (configured AI backend) to get an answer.\n');
    }
    return 0;
  }

  const invoke = flag('--run-model') ? aiInvoke : fakeInvoke;
  const res = await answerQuestion({ classDir, question, invoke, budgetChars });
  if (flag('--json')) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    process.stdout.write(`${res.answer}\n`);
    if (res.citations.length) {
      process.stdout.write(`\nCited: ${res.citations.map(tag => {
        const s = res.sources.find(x => x.tag === tag);
        return `${tag} ${s ? s.label : ''}`.trim();
      }).join('; ')}\n`);
    }
    for (const w of res.warnings) process.stderr.write(`warning: ${w}\n`);
  }
  return 0;
}

// Compare DECODED paths. A raw `file://${process.argv[1]}` comparison fails on
// any repo path containing a space, and the script then silently does nothing —
// a bug this repo has already been bitten by.
const isDirectInvocation = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  main(process.argv).then(code => { process.exitCode = code ?? 0; }).catch(err => {
    process.stderr.write(`FATAL: ${err?.stack || err?.message || String(err)}\n`);
    process.exitCode = 1;
  });
}
