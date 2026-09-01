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
// Guards, not caps. Each one exists to stop a pathological input from eating
// the document, and each is set far above anything a real syllabus does — the
// old values (180 chars, 180 lines, 1,800 chars, 110 chars) were tight enough
// to bind on ORDINARY content, which made them silent data loss rather than
// protection. What still binds is recorded in the index's `skipped` list,
// because a parser that drops something and says nothing is the failure the
// no-cut-offs rule is about.
const MAX_DATE_HEADING_CHARS = 400;
const MAX_BLOCK_LINES = 2000;

export function readingItemsFromDatedText(text, {
  defaultYear,
  sourceFile = null,
  excludeDates = [],
  skipped = null,
} = {}) {
  const year = Number(defaultYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) return [];
  const excluded = new Set(excludeDates);
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A real date heading is short. This prevents a prose sentence beginning
    // with a month from swallowing the next several pages as one block. It was
    // 180 characters, which a genuine heading can exceed — "September 1: Read
    // ..." with the readings on the same line does it easily — so the guard
    // now sits where only prose reaches, and says so when it fires.
    if (line.length > MAX_DATE_HEADING_CHARS) {
      if (DATE_LINE_RE.test(line)) {
        skipped?.push({
          reason: 'date-heading-too-long',
          detail: `A dated line of ${line.length} characters was not treated as a heading`
            + ` (limit ${MAX_DATE_HEADING_CHARS}). It begins: ${compact(line).slice(0, 120)}`,
        });
      }
      continue;
    }
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
    const naturalEnd = Math.min(lines.length, heads[i + 1]?.line ?? lines.length);
    const end = Math.min(naturalEnd, head.line + MAX_BLOCK_LINES);
    if (end < naturalEnd) {
      skipped?.push({
        reason: 'dated-block-truncated',
        detail: `The block under ${head.date} ran ${naturalEnd - head.line} lines;`
          + ` only the first ${MAX_BLOCK_LINES} were read.`,
      });
    }
    const block = [head.tail, ...lines.slice(head.line + 1, end)].join('\n').trim();
    const required = withoutOptionalTail(block);
    const explicit = RAW_LINE_ACTION_RE.test(required)
      || /\b(?:pre[-\s]?class|assigned|required)\s+readings?\b/i.test(required);
    if (!explicit) continue;

    const firstAction = required.search(/\b(?:read|skim)\b|\bpre[-\s]?class\s+readings?\b/i);
    // Stored whole. The 1,800-character cap here silently dropped the tail of
    // any long reading list, and the 110-character one cut the title mid-word
    // — neither guarded against anything, they just made the stored answer
    // shorter than the page it came from.
    const excerpt = compact(firstAction >= 0 ? required.slice(firstAction) : required);
    if (!excerpt) continue;
    const label = excerpt
      .replace(/^(?:read|skim)(?:\s+(?:the|a|an))?\s*[:\-–—]?\s*/i, '')
      .split(/[.;](?:\s|$)/, 1)[0] || 'assigned material';
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

// --- Class pages -----------------------------------------------------------
//
// Canvas "pages" are where several of these courses actually publish the week:
// what is covered on a given class date, what to read or watch before it, and
// which handouts belong to it. They are edited daily, they are not the
// syllabus, and until now nothing in the pipeline read them at all — ENTR
// 222's 28 collected session pages contributed exactly zero rows to this index.
//
// Two real shapes, and the parser has to take both:
//
//   1. A label/value TABLE. ENTR 222 publishes one <table> per session with
//      <th scope="row">Date|Topics|During Class|Assignments Due|Slides</th>
//      against a <td>. Flattening that to text and reading it line-by-line
//      loses which value belongs to which label, so the th/td pairing is read
//      directly.
//   2. HEADED PROSE. A week page carries "Week 2: August 31 (M) - September 6
//      (Su)", then one block per class — "Class: August 31 (M) 2:30pm-3:45pm"
//      — each with "Topics:", "Class Materials:", "Prep - Readings/Videos:".
//      One page therefore yields SEVERAL dated blocks, not one.
//
// What it will not do is invent. A page that states a topic and no reading
// produces NOTHING here. That is the whole reason this module is deterministic:
// the miner already demonstrated what "a plausible list" costs, and a page
// reading "Topics: Introduction" does not become "Read for Introduction"
// because a reading index would look better with a row in it.

// A section whose LABEL promises preparation. Matched on the label alone, so a
// "Prep - Readings/Videos" block counts even when its items are bare citations
// ("Cachon & Terwiesch, Chapter 3") with no verb to detect.
const PAGE_PREP_LABEL_RE = /\b(?:prep(?:aration)?|readings?|videos?|watch|before\s+class|pre[-\s]?class|assigned\s+(?:readings?|materials?))\b/i;
// A section whose label promises handouts rather than instructions. Its links
// enrich an item; they never create one.
const PAGE_MATERIAL_LABEL_RE = /\b(?:class\s+materials?|materials?|slides?|handouts?|resources?|readings?|videos?|prep(?:aration)?)\b/i;
// "Class: August 31 (M) 2:30pm-3:45pm" opens a dated block inside a week page.
const PAGE_BLOCK_LABEL_RE = /^(?:class|session|meeting)\b/i;
const NUMERIC_DATE_RE = /(?:^|[^\d])(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?(?![\d/])/;
const WORD_DATE_RE = new RegExp(`\\b(${MONTH_WORDS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?`, 'i');

// Canvas's editor emits named entities freely, and an undecoded one does not
// look like a bug in a log — it looks like content. A prep list rendered as
// "Chapter 3 &mdash; skim only" reaches the calendar with the literal text
// "&mdash;" in it, and an em-dash PLACEHOLDER written as &mdash; would not be
// recognised as the "nothing here" marker it is.
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', bull: '\u2022',
  middot: '\u00b7', times: '\u00d7', deg: '\u00b0',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
};

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

// "—", "N/A", "TBD", "posted after class": a cell that exists to say there is
// nothing here. Every one of ENTR 222's 28 session pages uses "—" this way, so
// reading a placeholder as content would manufacture a reading for a class
// whose page explicitly states it has none.
const PLACEHOLDER_RE = /^(?:[\s\u2010-\u2015_.·•-]*|n\/?a|none|nothing|tbd|tba|to\s+be\s+(?:announced|determined)|posted\s+after\s+class)$/i;

function isPlaceholder(text) {
  return PLACEHOLDER_RE.test(compact(text));
}

function htmlText(html) {
  return compact(decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' ')));
}

/** Every <a> in a fragment, as { text, href }. Empty labels are dropped. */
function linksIn(html) {
  const out = [];
  for (const match of String(html ?? '').matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = htmlText(match[2]);
    const href = decodeEntities(match[1]).trim();
    if (text) out.push({ text, href });
  }
  return out;
}

/**
 * Split a fragment at block boundaries, KEEPING each chunk's inner markup.
 *
 * Converting to text first would be simpler and would throw away every link,
 * which is the half of a page a student most needs. Chunks preserve the <a>
 * tags so a section can carry its own materials.
 */
function htmlChunks(html) {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .split(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|td|th)>/i)
    .map(chunk => chunk.trim())
    .filter(Boolean);
}

/**
 * The labelled sections of a page body, in document order.
 *
 * Tables are read as th/td pairs; whatever is left over is read as prose where
 * a "Label:" line opens a section that runs to the next one. Both are returned
 * because a page may carry a table AND prose around it.
 */
export function pageSections(body) {
  const html = String(body ?? '');
  const out = [];
  for (const match of html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
    const label = htmlText(match[1]).replace(/:\s*$/, '');
    if (label) out.push({ label, tail: '', headHtml: '', html: match[2] });
  }
  const prose = html.replace(/<table[\s\S]*?<\/table>/gi, ' ');
  let current = null;
  for (const chunk of htmlChunks(prose)) {
    const text = htmlText(chunk);
    if (!text) continue;
    // A label is short, ends in a colon, and is not a URL or a sentence.
    const match = /^([A-Za-z][^:]{0,60}):\s*([\s\S]*)$/.exec(text);
    if (match && !/^https?$/i.test(match[1])) {
      // headHtml is kept SEPARATE from html: a label line often carries its own
      // links ("Class Materials: <a>deck.pdf</a>"), so the chunk is needed for
      // link extraction — but folding it into html would make the section's
      // text contain the tail twice, once from `tail` and once from the chunk.
      // That duplication reached "Read for Queuing Topics: Queuing" before it
      // was caught.
      current = { label: compact(match[1]), tail: compact(match[2]), headHtml: chunk, html: '' };
      out.push(current);
    } else if (current) {
      current.html += chunk;
    }
  }
  return out;
}

function sectionText(section) {
  return compact([section.tail, htmlText(section.html)].filter(Boolean).join(' '));
}

/** Links anywhere in a section — its label line included. */
function sectionLinks(section) {
  return linksIn(`${section.headHtml ?? ''}${section.html ?? ''}`);
}

/** A loose date anywhere in a string: "8/25", "August 31", "Sept 3, 2026". */
function looseDate(text, defaultYear) {
  const value = String(text ?? '');
  const word = WORD_DATE_RE.exec(value);
  if (word) {
    const year = Number(word[3] || defaultYear);
    const date = validDate(year, MONTHS.get(word[1].toLowerCase()), Number(word[2]));
    if (date) return date;
  }
  const numeric = NUMERIC_DATE_RE.exec(value);
  if (numeric) {
    let year = Number(numeric[3] ?? defaultYear);
    if (year < 100) year += 2000;
    const date = validDate(year, Number(numeric[1]), Number(numeric[2]));
    if (date) return date;
  }
  return null;
}

/**
 * Group a page's sections into dated blocks.
 *
 * A week page opens a new block at every "Class: <date>"; a session page has no
 * such label and gets one block, dated from its "Date" row or from the date in
 * its own title ("Session 1 - Introduction - 8/25").
 */
function pageBlocks(page, defaultYear) {
  const sections = pageSections(page?.body);
  const blocks = [];
  let current = { date: null, heading: compact(page?.title), sections: [] };
  blocks.push(current);
  for (const section of sections) {
    const tailDate = PAGE_BLOCK_LABEL_RE.test(section.label)
      ? looseDate(sectionText(section), defaultYear) : null;
    if (tailDate) {
      current = {
        date: tailDate,
        heading: compact(`${section.label}: ${sectionText(section)}`),
        sections: [],
      };
      blocks.push(current);
      continue;
    }
    if (/^date$/i.test(section.label) && !current.date) {
      current.date = looseDate(sectionText(section), defaultYear);
    }
    current.sections.push(section);
  }
  const titleDate = looseDate(page?.title, defaultYear);
  for (const block of blocks) if (!block.date) block.date = titleDate;
  return blocks.filter(block => block.date && block.sections.length);
}

/**
 * Dated readings stated on a class's Canvas pages.
 *
 * Emits ONE item per dated block that states preparation, and nothing at all
 * for a block that does not. Content is carried whole — no clipping — because
 * a reading list truncated at a fixed width is a reading list with items
 * missing, which is the complaint this work started from.
 */
export function readingItemsFromPages(pages, { defaultYear, sourceFile = null } = {}) {
  const year = Number(defaultYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) return [];
  const out = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    if (!page || typeof page !== 'object' || !page.body) continue;
    const pageTitle = compact(page.title) || compact(page.url) || 'class page';
    for (const block of pageBlocks(page, year)) {
      // The ruling that makes this module worth trusting: a page stating a
      // topic and no reading produces no row. Everything that EXISTS reaches
      // the output; nothing that does not is imagined into it. A "Prep -
      // Readings/Videos: —" row is the page SAYING there is no preparation,
      // and is as much a reason to emit nothing as no row at all.
      const required = [];
      for (const section of block.sections) {
        if (!PAGE_PREP_LABEL_RE.test(section.label)
          && !hasRequiredReading(sectionText(section))) continue;
        // The optional test has to see the LABEL: "Optional Reading" carries
        // the word in its label and its content reads as ordinary prose ("the
        // Erlang C appendix"), so testing content alone promotes exactly the
        // rows the schedule path is careful to refuse.
        const labelled = compact(`${section.label}: ${sectionText(section)}`);
        const stillRequired = withoutOptionalTail(labelled).replace(/^[^:]*:\s*/, '');
        if (isPlaceholder(stillRequired)) continue;
        // Decided on the required part, KEPT WHOLE: a section carrying both a
        // required and an optional reading keeps both, because the student can
        // see both on the page and dropping one is a data-level cut.
        required.push(labelled);
      }
      if (!required.length) continue;

      const topics = block.sections.find(section => /^topics?\b/i.test(section.label));
      const title = compact(topics ? sectionText(topics) : '') || block.heading || 'class';
      const materials = [];
      for (const section of block.sections) {
        if (!PAGE_MATERIAL_LABEL_RE.test(section.label)) continue;
        for (const link of sectionLinks(section)) {
          if (materials.some(material => material.file === link.text)) continue;
          materials.push({
            file: link.text,
            // The schema carries a NAME here, resolved against the class's own
            // files; the href has nowhere structured to live, so it is kept in
            // the reason rather than dropped.
            why: `Linked under "${section.label}" on ${pageTitle}${link.href ? ` (${link.href})` : ''}.`,
          });
        }
      }

      const item = readingItem({
        date: block.date,
        title,
        details: required.join(' '),
        sourceFile,
        sourceRef: `${pageTitle} — ${block.heading || block.date}`,
        suffix: '-page',
      });
      item.sources = [{ type: 'page', ref: `${pageTitle} — ${block.heading || block.date}` }];
      item.origin = 'page';
      item.related_materials = materials.concat(item.related_materials);
      out.push(item);
    }
  }
  return out.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id));
}

/** The comparable core of an item's reading text, for merge decisions. */
function readingKey(item) {
  return String(item?.description ?? '')
    .replace(/^Complete before class on \d{4}-\d{2}-\d{2}\.\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Words that say HOW something is assigned rather than WHAT was assigned. A
// syllabus writes "Read Cachon & Terwiesch, Chapter 3"; the week page writes
// "Prep - Readings/Videos: Cachon & Terwiesch, Chapter 3". Same reading, and a
// literal string comparison says otherwise — which is how a merge rule that
// looks careful ends up emitting the identical chapter twice for one class.
const READING_FRAME_WORDS = new Set([
  'read', 'reads', 'reading', 'readings', 'skim', 'watch', 'view', 'viewing',
  'prep', 'preparation', 'prepare', 'video', 'videos', 'before', 'class',
  'pre', 'assigned', 'required', 'optional', 'complete', 'materials',
  'material', 'due', 'this', 'week', 'and', 'the', 'a', 'an', 'of', 'for',
  'to', 'in', 'on', 'at', 'is', 'are', 'be', 'from', 'with', 'by', 'or',
]);

function readingTokens(item) {
  return new Set(readingKey(item).split(' ').filter(word => word && !READING_FRAME_WORDS.has(word)));
}

function sameReading(a, b) {
  const x = readingTokens(a);
  const y = readingTokens(b);
  if (!x.size || !y.size) return false;
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  // Two content words is the floor. Below it a bare "chapter 3" would match any
  // other chapter 3 in the class, and the merge would swallow a real second
  // reading — the failure that matters more than a duplicate row.
  if (small.size < 2) return false;
  for (const token of small) if (!big.has(token)) return false;
  return true;
}

/** An item's reading text without the generated "Complete before class" lead. */
function statedText(item) {
  return String(item?.description ?? '')
    .replace(/^Complete before class on \d{4}-\d{2}-\d{2}\.\s*/, '')
    .trim();
}

function mergeList(into, from, keyOf) {
  const seen = new Set(into.map(keyOf));
  for (const entry of from) {
    const key = keyOf(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    into.push(entry);
  }
  return into;
}

/**
 * Fold page readings into the syllabus-derived ones.
 *
 * Same date AND the same reading merges — the page's provenance and materials
 * join the existing row rather than producing a second, near-identical reminder
 * for one class. Same date and a DIFFERENT reading is kept: a week page adding
 * a video the syllabus never listed is exactly the content this work exists to
 * stop losing.
 */
export function mergeReadingItems(existing, incoming) {
  const items = existing.map(item => ({ ...item }));
  for (const candidate of Array.isArray(incoming) ? incoming : []) {
    const match = items.find(item => item.due_date === candidate.due_date && sameReading(item, candidate));
    if (!match) {
      items.push(candidate);
      continue;
    }
    match.sources = mergeList([...(match.sources ?? [])], candidate.sources ?? [],
      source => `${source?.type}|${source?.ref}`);
    match.related_materials = mergeList([...(match.related_materials ?? [])],
      candidate.related_materials ?? [], material => String(material?.file));
    // Merging must not COST content. "Same reading" is decided by containment,
    // so the page's line can legitimately carry more than the syllabus's — a
    // video, a second chapter, a page range. Keeping only the existing text
    // would quietly drop exactly the material this work exists to surface, so
    // anything the page adds is appended verbatim. It reads a little
    // redundantly when the two overlap; that is the correct trade against
    // losing a reading.
    const known = readingTokens(match);
    const adds = [...readingTokens(candidate)].some(token => !known.has(token));
    const extra = statedText(candidate);
    if (adds && extra) match.description = compact(`${match.description} ${extra}`);
  }
  return items;
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
  const [metadata, syllabusParsed, filesIndex, pages] = await Promise.all([
    readJson('metadata.json'), readJson('syllabus_parsed.json'), readJson('files_index.json'),
    readJson('pages.json'),
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
  const skipped = [];
  const raw = readingItemsFromDatedText(rawText, {
    defaultYear: yearFor(metadata, syllabusParsed),
    sourceFile,
    excludeDates: structured.map(item => item.due_date),
    skipped,
  });
  // Class pages are the daily-updated source: they restate the week's prep, and
  // they change between syncs while the syllabus does not. Merged rather than
  // appended, so a reading the syllabus already carries gains the page's links
  // instead of appearing on the calendar twice for one class.
  const fromPages = readingItemsFromPages(pages, {
    defaultYear: yearFor(metadata, syllabusParsed),
    sourceFile,
  });
  const items = mergeReadingItems(structured.concat(raw), fromPages)
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id));
  const addedByPages = items.filter(item => item.origin === 'page').length;
  return {
    version: 1,
    source: {
      structured: syllabusParsed ? 'syllabus_parsed.json' : null,
      raw: rawText ? (newest?.materialsPath || 'syllabus.html') : null,
      syllabus_file: sourceFile,
      pages: Array.isArray(pages) && pages.length ? 'pages.json' : null,
    },
    coverage: {
      structured: structured.length,
      raw_fallback: raw.length,
      // Read together these say what the pages contributed: `pages_scanned`
      // counts what was looked at, `pages` counts what it was honest enough to
      // emit. A class whose pages state topics and no readings shows a large
      // scanned count against zero, and that IS the correct answer for it.
      pages_scanned: Array.isArray(pages) ? pages.filter(page => page?.body).length : 0,
      pages: addedByPages,
      pages_merged: fromPages.length - addedByPages,
      total: items.length,
    },
    // Everything a guard refused to read, named. An empty list is the ordinary
    // case and the honest one; a non-empty list is the index telling you the
    // source held something it would not promote, instead of leaving you to
    // notice a missing reading on a calendar.
    skipped,
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
