// reading-index.js — deterministic reading discovery.
//
// The assignment miner is useful for interpretation, but it must not be the
// only gate between an explicit syllabus reading and the calendar. A local
// model omitted every dated reading in BUSI 380 even though
// syllabus_parsed.json held 23 rows that said "Read ...", and it omitted the
// 15-row Pre-class Reading column in BUSI 305. This module turns those stated
// facts into ordinary task items without asking a model for permission.
//
// The primary source is syllabus_parsed.schedule. A conservative raw-text
// pass over the newest extracted syllabus is the backstop for the opposite
// failure: a parser that missed or truncated a dated schedule row. Raw text is
// only accepted when a date heads a block that contains an explicit reading
// action. Optional-only blocks, holidays, and undated prose are not promoted.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OPTIONAL_HEAD_RE = /\b(?:extra\s+insight\s+reading|optional(?:\s+reading)?)\b/i;
const READING_ACTION_RE = /\b(?:read|skim)\b|\b(?:after|before)\s+reading\b|\b(?:pre[-\s]?class|assigned|required)\s+readings?\b/i;
const RAW_LINE_ACTION_RE = /(?:^|\n)\s*(?:\d+[.)]\s*|[a-z][.)]\s*|[•*-]\s*)?(?:read|skim)\b/im;

const MONTHS = new Map([
  ['january', 1], ['jan', 1], ['february', 2], ['feb', 2],
  ['march', 3], ['mar', 3], ['april', 4], ['apr', 4],
  ['may', 5], ['june', 6], ['jun', 6], ['july', 7], ['jul', 7],
  ['august', 8], ['aug', 8], ['september', 9], ['sep', 9], ['sept', 9],
  ['october', 10], ['oct', 10], ['november', 11], ['nov', 11],
  ['december', 12], ['dec', 12],
]);

const MONTH_WORDS = [...MONTHS.keys()].sort((a, b) => b.length - a.length).join('|');
const DATE_LINE_RE = new RegExp(
  `^\\s*(${MONTH_WORDS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\s*:?\\s*(.*)$`,
  'i',
);

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'session';
}

function withoutOptionalTail(text) {
  const value = String(text ?? '');
  const match = OPTIONAL_HEAD_RE.exec(value);
  return match ? value.slice(0, match.index) : value;
}

function hasRequiredReading(text) {
  return READING_ACTION_RE.test(withoutOptionalTail(text));
}

function validDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function sourceMaterial(sourceFile) {
  if (!sourceFile) return [];
  return [{ file: sourceFile, why: 'Lists the reading and the class date.' }];
}

function readingItem({ date, title, details, sourceFile, sourceRef, confidence = 'high', suffix = '' }) {
  const cleanTitle = compact(title) || 'class';
  const cleanDetails = compact(details);
  return {
    id: `reading-${date}-${slug(cleanTitle)}${suffix}`.slice(0, 200),
    title: `Read for ${cleanTitle}`,
    kind: 'implicit',
    canvas_assignment_id: null,
    category: 'reading',
    due_date: date,
    due_time: null,
    due_confidence: confidence,
    recurring: null,
    points_possible: null,
    weight_note: null,
    description: [`Complete before class on ${date}.`, cleanDetails].filter(Boolean).join(' '),
    sources: [{ type: 'syllabus', ref: sourceRef }],
    related_materials: sourceMaterial(sourceFile),
    origin: 'syllabus',
    indexed: true,
  };
}

/**
 * Build dated readings from the structured syllabus schedule.
 *
 * Rows on the same date are grouped into one calendar item. That is deliberate:
 * a professor may split a session into a lecture row and discussion row, while
 * the student still needs one "read before this class" event rather than two
 * partially overlapping reminders.
 */
export function readingItemsFromSchedule(syllabusParsed, { sourceFile = null } = {}) {
  const groups = new Map();
  for (const row of Array.isArray(syllabusParsed?.schedule) ? syllabusParsed.schedule : []) {
    const date = String(row?.date ?? '');
    const type = String(row?.type ?? '').toLowerCase();
    if (!ISO_DATE_RE.test(date) || type === 'holiday' || type === 'exam') continue;
    const title = compact(row?.title);
    const details = compact(row?.description);
    if (!hasRequiredReading(`${title}\n${details}`)) continue;
    const slot = groups.get(date) ?? { titles: [], details: [] };
    if (title && !slot.titles.includes(title)) slot.titles.push(title);
    if (details && !slot.details.includes(details)) slot.details.push(details);
    groups.set(date, slot);
  }

  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, group]) => {
    const title = group.titles.join(' / ') || 'class';
    return readingItem({
      date,
      title,
      details: group.details.join(' '),
      sourceFile,
      sourceRef: `Syllabus schedule ${date}: ${title}`,
    });
  });
}

/**
 * Conservative fallback for extracted syllabus text. It recognises only a
 * month-and-day line followed by an explicit line-level Read/Skim instruction
 * (or a Pre-class Reading label). Narrative policy dates and optional-only
 * recommendations therefore stay out of the calendar.
 */
export function readingItemsFromDatedText(text, {
  defaultYear,
  sourceFile = null,
  excludeDates = [],
} = {}) {
  const year = Number(defaultYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) return [];
  const excluded = new Set(excludeDates);
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A real date heading is short. This prevents a prose sentence beginning
    // with a month from swallowing the next several pages as one block.
    if (line.length > 180) continue;
    const match = DATE_LINE_RE.exec(line);
    if (!match) continue;
    const month = MONTHS.get(match[1].toLowerCase());
    const date = validDate(Number(match[3] || year), month, Number(match[2]));
    if (date) heads.push({ line: i, date, tail: match[4] || '' });
  }

  const out = [];
  const seen = new Set();
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i];
    if (excluded.has(head.date) || seen.has(head.date)) continue;
    const end = Math.min(lines.length, heads[i + 1]?.line ?? lines.length, head.line + 180);
    const block = [head.tail, ...lines.slice(head.line + 1, end)].join('\n').trim();
    const required = withoutOptionalTail(block);
    const explicit = RAW_LINE_ACTION_RE.test(required)
      || /\b(?:pre[-\s]?class|assigned|required)\s+readings?\b/i.test(required);
    if (!explicit) continue;

    const firstAction = required.search(/\b(?:read|skim)\b|\bpre[-\s]?class\s+readings?\b/i);
    const excerpt = compact(firstAction >= 0 ? required.slice(firstAction) : required).slice(0, 1800);
    if (!excerpt) continue;
    const label = excerpt
      .replace(/^(?:read|skim)(?:\s+(?:the|a|an))?\s*[:\-–—]?\s*/i, '')
      .split(/[.;](?:\s|$)/, 1)[0]
      .slice(0, 110) || 'assigned material';
    out.push(readingItem({
      date: head.date,
      title: label,
      details: excerpt,
      sourceFile,
      sourceRef: `${sourceFile || 'Extracted syllabus'} dated section ${head.date}`,
      confidence: 'high',
      suffix: '-raw',
    }));
    seen.add(head.date);
  }
  return out;
}

function yearFor(metadata, syllabusParsed) {
  for (const row of Array.isArray(syllabusParsed?.schedule) ? syllabusParsed.schedule : []) {
    const match = /^(\d{4})-/.exec(String(row?.date ?? ''));
    if (match) return Number(match[1]);
  }
  const term = typeof metadata?.term === 'string' ? metadata.term : metadata?.term?.name;
  const match = /\b(20\d{2})\b/.exec(String(term ?? syllabusParsed?.course?.term ?? ''));
  return match ? Number(match[1]) : new Date().getFullYear();
}

function currentSyllabusEntry(filesIndex) {
  return (Array.isArray(filesIndex) ? filesIndex : [])
    .filter(entry => entry && entry.extractionStatus === 'done' && entry.materialsPath
      && entry.duplicateOf == null && entry.supersededBy == null
      // Canvas filenames commonly join words with underscores
      // ("syllabus_Busi..."); word boundaries treat '_' as a word character,
      // so a bounded pattern fails on exactly those otherwise obvious files.
      && /syllab(?:us|i)/i.test(`${entry.displayName ?? ''} ${entry.filename ?? ''}`))
    .sort((a, b) => Date.parse(b.canvasUpdatedAt || 0) - Date.parse(a.canvasUpdatedAt || 0))[0] ?? null;
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

/** Read the class artifacts and return the deterministic readings index. */
export async function buildReadingIndex(classDir) {
  const readJson = async name => {
    try { return JSON.parse(await readFile(join(classDir, name), 'utf8')); } catch { return null; }
  };
  const [metadata, syllabusParsed, filesIndex] = await Promise.all([
    readJson('metadata.json'), readJson('syllabus_parsed.json'), readJson('files_index.json'),
  ]);
  const newest = currentSyllabusEntry(filesIndex);
  const sourceFile = newest?.displayName || newest?.filename || syllabusParsed?.source_file || null;
  const structured = readingItemsFromSchedule(syllabusParsed, { sourceFile });

  let rawText = '';
  if (newest?.materialsPath) {
    try { rawText = await readFile(join(classDir, newest.materialsPath), 'utf8'); } catch { /* fallback below */ }
  }
  if (!rawText) {
    try { rawText = stripHtml(await readFile(join(classDir, 'syllabus.html'), 'utf8')); } catch { /* no raw source */ }
  }
  const raw = readingItemsFromDatedText(rawText, {
    defaultYear: yearFor(metadata, syllabusParsed),
    sourceFile,
    excludeDates: structured.map(item => item.due_date),
  });
  const items = structured.concat(raw).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id));
  return {
    version: 1,
    source: {
      structured: syllabusParsed ? 'syllabus_parsed.json' : null,
      raw: rawText ? (newest?.materialsPath || 'syllabus.html') : null,
      syllabus_file: sourceFile,
    },
    coverage: { structured: structured.length, raw_fallback: raw.length, total: items.length },
    items,
  };
}

/**
 * A missing index must not make readings disappear while the pipeline catches
 * up. Consumers use structured rows as an in-memory floor; the persisted
 * index adds raw-text fallbacks once extraction has run.
 */
export function readingsWithScheduleFloor(index, syllabusParsed) {
  const indexed = Array.isArray(index?.items) ? index.items : [];
  const sourceFile = index?.source?.syllabus_file || syllabusParsed?.source_file || null;
  const floor = readingItemsFromSchedule(syllabusParsed, { sourceFile });
  if (!indexed.length) return { version: 1, items: floor };
  const dates = new Set(indexed.map(item => item?.due_date).filter(Boolean));
  return { ...index, items: indexed.concat(floor.filter(item => !dates.has(item.due_date))) };
}
