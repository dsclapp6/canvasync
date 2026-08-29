// textbooks.js — syllabus-owned textbook names plus user-owned access links.
//
// The parser may rewrite syllabus_parsed.json on every successful syllabus
// extraction, so links the student finds or buys must never live there. They
// are stored beside it in textbook_links.json and joined at read time.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withPathLock, atomicWriteJson, lockKey } from '../write-lock.js';

export const TEXTBOOK_LINKS_FILE = 'textbook_links.json';
export const TEXTBOOK_SCHEMA_VERSION = 2;
const BOOK_ID_RE = /^book-[a-f0-9]{16}$/;
const MAX_URL = 4096;
const STATUSES = new Set(['required', 'recommended', 'optional']);
const ROLES = new Set(['primary', 'supplemental']);

export class TextbookError extends Error {}

function text(value, max = 500) {
  if (Array.isArray(value)) value = value.filter(Boolean).join(', ');
  if (value == null) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

function isbnCandidates(value) {
  const matches = String(value ?? '').toUpperCase()
    .match(/(?:97[89][\s-]*)?[0-9][0-9X\s-]{8,22}[0-9X]/g) ?? [];
  const seen = new Set();
  const out = [];
  for (const match of matches) {
    const candidate = match.replace(/[^0-9X]/g, '');
    if (![10, 13].includes(candidate.length) || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

function isbnKey(value) {
  const candidates = isbnCandidates(value);
  return candidates.find(candidate => candidate.length === 13)
    ?? candidates[0]
    ?? '';
}

function words(value) {
  return String(value ?? '')
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&(?:amp|nbsp);/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function idFor(book) {
  const identity = isbnKey(book.isbn) || `${words(book.title)}|${words(book.author)}`;
  return `book-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

function legacyIdFor(book) {
  // v1 concatenated every digit from a string containing both ISBN-10 and
  // ISBN-13. v2 correctly chooses the ISBN-13, but an access link saved under
  // the old id must still resolve and migrate rather than disappear.
  const legacyIsbn = String(book?.isbn ?? '').toUpperCase().replace(/[^0-9X]/g, '');
  const identity = legacyIsbn || `${words(book?.title)}|${words(book?.author)}`;
  return `book-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

function statusOf(raw) {
  const status = String(raw?.status ?? '').toLowerCase();
  if (STATUSES.has(status)) return status;
  // Legacy records had only a boolean, so false cannot distinguish optional
  // from recommended. Preserve it as recommended until a v2 parse can read the
  // source heading and make the distinction.
  return raw?.required === false ? 'recommended' : 'required';
}

function roleOf(raw) {
  const role = String(raw?.role ?? '').toLowerCase();
  return ROLES.has(role) ? role : null;
}

function cleanSourceLines(sourceText) {
  return String(sourceText ?? '')
    .split(/\r?\n/)
    .map(line => line.replace(/[\t\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function statusCue(line) {
  const clean = String(line ?? '').replace(/^[#*•\-–—\d.)\s]+/, '').trim();
  // A cue is a heading/label, not prose such as "assigned and/or recommended
  // readings". Letting the latter win incorrectly downgraded an assigned book.
  const match = clean.match(/^(required|recommended|optional)\s+(?:course\s+)?(?:textbooks?|texts?|books?|readings|materials)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function titleSignature(title) {
  const tokens = words(title).split(' ').filter(Boolean);
  return tokens.slice(0, Math.min(5, tokens.length)).join(' ');
}

function evidenceForTitle(lines, title) {
  const signature = titleSignature(title);
  if (!signature) return null;
  const firstTitleToken = signature.split(' ')[0];
  let neutral = null;
  for (let i = 0; i < lines.length; i++) {
    // PDF extraction routinely wraps a title across two or three lines.
    const window = lines.slice(i, i + 3).join(' ');
    if (!words(window).includes(signature)) continue;

    // The matching title may be on the second/third line of this window. Cue
    // lookup must anchor to that line; otherwise "Required Readings / ... /
    // Optional Readings / Deploy Empathy" inherits Required from two lines up.
    const titleOffset = lines.slice(i, i + 3)
      .findIndex(value => words(value).split(' ').includes(firstTitleToken));
    const titleIndex = titleOffset >= 0 ? i + titleOffset : i;

    const direct = statusCue(lines.slice(titleIndex, titleIndex + 3).join(' '));
    if (direct) return { status: direct, index: titleIndex, direct: true };

    for (let j = titleIndex - 1; j >= Math.max(0, titleIndex - 15); j--) {
      const cue = statusCue(lines[j]);
      if (cue) return { status: cue, index: titleIndex, direct: false };
      // Do not let an earlier reading heading bleed through another clearly
      // unrelated high-level section.
      if (/^(?:office hours|assessments?|grading|course schedule|policies|attendance)\b/i.test(lines[j])) break;
    }
    neutral ??= { status: null, index: titleIndex, direct: false };
  }
  return neutral;
}

function editionFrom(value) {
  const match = String(value ?? '').match(/\b(\d+(?:st|nd|rd|th)?(?:\s+[A-Za-z]+){0,3}\s+(?:ed\.?|edition)|\d+e)\b/i);
  return match ? match[1] : null;
}

function isbnDisplay(value) {
  const candidate = isbnCandidates(value)[0];
  return candidate || null;
}

function cleanDetectedTitle(value) {
  let title = String(value ?? '').trim();
  title = title.split(/\s*,?\s+by\s+/i)[0].trim();
  title = title.replace(/\s*\(\s*\d+(?:st|nd|rd|th)?\s*(?:e|ed\.?|edition)\s*\)\s*[,.;]?$/i, '').trim();
  title = title.replace(/[.;,]\s*$/, '').trim();
  if (!title || /^(?:none|n\/a|not required)$/i.test(title)) return null;
  return title;
}

/**
 * A deliberately narrow deterministic floor beneath the model extraction.
 * It handles the two unambiguous formats common in real syllabi—"Required
 * textbook: ..." and labelled Title/Authors blocks—without trying to guess
 * that an arbitrary article citation is a book.
 */
export function detectTextbooksFromText(sourceText) {
  const lines = cleanSourceLines(sourceText);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const direct = line.match(/\b(required|recommended|optional)\s+(?:course\s+)?textbook\s*:\s*(.+)$/i);
    if (direct) {
      const title = cleanDetectedTitle(direct[2]);
      if (!title) continue;
      const block = lines.slice(i, i + 3).join(' ');
      const by = block.match(/\bby\s+(.+?)(?=\s+(?:ISBN|Publisher|Press|\d{4})\b|\s*\(|$)/i);
      const author = by?.[1]
        ?.split(/,\s*(?=[A-Z][^,]{0,50}\b(?:publishers?|press)\b)/i)[0]
        ?.replace(/[.;,]\s*$/, '').trim() || null;
      found.push({
        title,
        author,
        edition: editionFrom(block),
        isbn: isbnDisplay(block),
        status: direct[1].toLowerCase(),
        required: direct[1].toLowerCase() === 'required',
        role: direct[1].toLowerCase() === 'required' ? 'primary' : null,
      });
      continue;
    }

    const labelled = line.match(/^title\s*:\s*(.+)$/i);
    if (!labelled) continue;
    const nearHeading = lines.slice(Math.max(0, i - 15), i).some(value => /\btextbooks?\b/i.test(value));
    if (!nearHeading) continue;
    const title = cleanDetectedTitle(labelled[1]);
    if (!title) continue;
    const blockLines = lines.slice(i + 1, i + 5);
    const authorLine = blockLines.find(value => /^authors?\s*:/i.test(value));
    const block = [line, ...blockLines].join(' ');
    const evidence = evidenceForTitle(lines, title);
    const status = evidence?.status ?? 'required';
    found.push({
      title,
      author: authorLine?.replace(/^authors?\s*:\s*/i, '').trim() || null,
      edition: editionFrom(block),
      isbn: isbnDisplay(block),
      status,
      required: status === 'required',
      role: null,
    });
  }
  return found;
}

function sameBook(a, b) {
  const aIsbn = isbnKey(a?.isbn);
  const bIsbn = isbnKey(b?.isbn);
  if (aIsbn && bIsbn && aIsbn === bIsbn) return true;
  const at = words(a?.title);
  const bt = words(b?.title);
  return at && bt && (at === bt
    || (Math.min(at.length, bt.length) >= 12 && (at.includes(bt) || bt.includes(at))));
}

/** Reconcile model output with section labels and deterministic textbook rows. */
export function reconcileSyllabusTextbooks(rawBooks, sourceText) {
  const lines = cleanSourceLines(sourceText);
  const books = [];
  for (const raw of Array.isArray(rawBooks) ? rawBooks : []) {
    if (!raw || typeof raw !== 'object') continue;
    const title = text(raw.title ?? raw.name);
    if (!title) continue;
    const evidence = evidenceForTitle(lines, title);
    const status = evidence?.status ?? statusOf(raw);
    books.push({
      title,
      author: text(raw.author ?? raw.authors),
      edition: text(raw.edition, 200),
      isbn: text(raw.isbn, 120),
      status,
      required: status === 'required',
      role: roleOf(raw) ?? (evidence?.direct && status === 'required' ? 'primary' : null),
    });
  }

  for (const detected of detectTextbooksFromText(sourceText)) {
    const existing = books.find(book => sameBook(book, detected));
    if (existing) {
      existing.author ??= detected.author;
      existing.edition ??= detected.edition;
      existing.isbn ??= detected.isbn;
      existing.status = detected.status;
      existing.required = detected.required;
      existing.role ??= detected.role;
    } else {
      books.push(detected);
    }
  }

  const visible = books.filter(book => book.status !== 'optional');
  if (visible.length === 1 && !visible[0].role) visible[0].role = 'primary';
  if (visible.length > 1 && !visible.some(book => book.role === 'primary')
    && /\b(?:read\s*:?[\s]*)?textbook\s*[:,]\s*(?:prologue|chapters?|ch\.?|pp?\.?\s*\d)/i.test(String(sourceText ?? ''))) {
    // Some syllabi list a main book first, then a separately named handbook,
    // and use singular "Textbook: Chapter ..." throughout the schedule. That
    // is a clear primary-book convention; retaining the role lets those generic
    // assignments inherit the correct saved link without guessing on classes
    // that merely list two equal books.
    visible[0].role = 'primary';
    for (const book of visible.slice(1)) book.role ??= 'supplemental';
  }
  return books;
}

/** Normalise the parser's deliberately human-readable textbook records. */
export function textbooksFromSyllabus(syllabusParsed) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(syllabusParsed?.textbooks) ? syllabusParsed.textbooks : []) {
    if (!raw || typeof raw !== 'object') continue;
    const title = text(raw.title ?? raw.name);
    if (!title) continue;
    const status = statusOf(raw);
    if (status === 'optional') continue;
    const book = {
      title,
      author: text(raw.author ?? raw.authors),
      edition: text(raw.edition, 200),
      isbn: text(raw.isbn, 120),
      status,
      required: status === 'required',
      role: roleOf(raw),
      source: 'syllabus',
    };
    book.id = idFor(book);
    if (seen.has(book.id)) continue;
    seen.add(book.id);
    out.push(book);
  }
  return out;
}

export async function readTextbookLinks(classDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(classDir, TEXTBOOK_LINKS_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.links || typeof parsed.links !== 'object') {
      return { version: 1, links: {} };
    }
    return { version: 1, links: parsed.links };
  } catch {
    return { version: 1, links: {} };
  }
}

async function currentSyllabusText(classDir) {
  try {
    const index = JSON.parse(await fs.readFile(path.join(classDir, 'files_index.json'), 'utf8'));
    const stamp = entry => {
      const parsed = Date.parse(entry?.canvasUpdatedAt ?? '');
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const candidates = (Array.isArray(index) ? index : [])
      .filter(entry => entry && /syllab/i.test(`${entry.displayName ?? ''} ${entry.filename ?? ''}`)
        && entry.extractionStatus === 'done' && entry.materialsPath
        && entry.duplicateOf == null && entry.supersededBy == null)
      .sort((a, b) => stamp(b) - stamp(a));
    for (const candidate of candidates) {
      const target = path.resolve(classDir, candidate.materialsPath);
      const root = `${path.resolve(classDir)}${path.sep}`;
      if (!target.startsWith(root)) continue;
      try { return await fs.readFile(target, 'utf8'); } catch { /* try the next candidate */ }
    }
  } catch { /* no usable file index */ }

  try {
    const html = await fs.readFile(path.join(classDir, 'syllabus.html'), 'utf8');
    return html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&');
  } catch {
    return '';
  }
}

async function syllabusBooksForClass(classDir, syllabusParsed) {
  const sourceText = await currentSyllabusText(classDir);
  const parsed = sourceText
    ? { ...syllabusParsed, textbooks: reconcileSyllabusTextbooks(syllabusParsed?.textbooks, sourceText) }
    : syllabusParsed;
  return textbooksFromSyllabus(parsed);
}

function linksPath(classDir) {
  return path.join(classDir, TEXTBOOK_LINKS_FILE);
}

async function writeTextbookLinks(classDir, state) {
  await atomicWriteJson(linksPath(classDir), {
    version: 1,
    links: state.links,
    updatedAt: new Date().toISOString(),
  });
}

function normaliseUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new TextbookError('url must be a string or null');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_URL) throw new TextbookError(`url is too long (max ${MAX_URL})`);
  let parsed;
  try { parsed = new URL(trimmed); }
  catch { throw new TextbookError('enter a complete http:// or https:// link'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TextbookError('textbook links must use http:// or https://');
  }
  if (parsed.username || parsed.password) {
    throw new TextbookError('textbook links cannot contain a username or password');
  }
  return parsed.href;
}

/** Join extracted textbook metadata with the links the user owns. */
export async function resolveTextbooks(classDir, syllabusParsed) {
  // Reconcile at read time as well as parse time. Existing class folders gain
  // the optional-heading and deterministic fixes immediately; they do not have
  // to wait for a potentially slow model re-parse before the tab becomes sane.
  const books = await syllabusBooksForClass(classDir, syllabusParsed);
  const state = await readTextbookLinks(classDir);
  return books.map((book) => {
    let url = null;
    const legacyId = legacyIdFor(book);
    try {
      url = normaliseUrl(state.links[book.id]?.url ?? state.links[legacyId]?.url ?? null);
    } catch { /* corrupt/manual edit reads unlinked */ }
    return { ...book, url };
  });
}

/**
 * Set or clear one syllabus textbook's PDF/e-book link.
 *
 * textbook_links.json holds EVERY book of the class under `links`, and this is
 * read-modify-write across two awaits — the syllabus read and the links read —
 * so two of these in flight together lose one of the two edits even though they
 * name different books. The dashboard makes that ordinary rather than exotic:
 * saving a link disables only that row's button (app.js), so pasting URLs for
 * two books of one class in quick succession sends two concurrent PUTs.
 *
 * Locked by the LINKS FILE, which is the whole target here — unlike the meeting
 * override, one logical edit touches exactly one file. The syllabus read is
 * inside the lock deliberately: it is what `book` is resolved from, and a
 * resolution taken before another writer's edit is the same stale snapshot the
 * lock exists to prevent.
 */
export async function patchTextbookLink(classDir, syllabusParsed, textbookId, value) {
  if (typeof textbookId !== 'string' || !BOOK_ID_RE.test(textbookId)) {
    throw new TextbookError('invalid textbook id');
  }
  return withPathLock(lockKey('textbook-links', linksPath(classDir)),
    () => patchTextbookLinkLocked(classDir, syllabusParsed, textbookId, value));
}

async function patchTextbookLinkLocked(classDir, syllabusParsed, textbookId, value) {
  const books = await syllabusBooksForClass(classDir, syllabusParsed);
  const book = books.find(candidate => candidate.id === textbookId);
  if (!book) throw new TextbookError('textbook not found in this class syllabus');

  const url = normaliseUrl(value);
  const state = await readTextbookLinks(classDir);
  const legacyId = legacyIdFor(book);
  if (url) state.links[textbookId] = { url };
  else delete state.links[textbookId];
  if (legacyId !== textbookId) delete state.links[legacyId];
  await writeTextbookLinks(classDir, state);
  return { ...book, url };
}

function referenceCorpus(item) {
  const strings = [];
  const visit = (value) => {
    if (typeof value === 'string' || typeof value === 'number') strings.push(String(value));
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  for (const key of [
    'title', 'name', 'description', 'description_html', 'sources',
    'related_materials', 'related_textbooks',
  ]) visit(item?.[key]);
  return words(strings.join(' ').replace(/<[^>]*>/g, ' '));
}

function explicitTextbookCorpus(item) {
  const strings = [];
  for (const value of Array.isArray(item?.related_textbooks) ? item.related_textbooks : []) {
    if (typeof value === 'string') strings.push(value);
    else if (value && typeof value === 'object') {
      strings.push(value.id, value.title, value.name, value.author, value.isbn);
    }
  }
  return words(strings.filter(Boolean).join(' '));
}

/**
 * Textbooks referenced by a task/assignment.
 *
 * Exact title/ISBN and miner-authored relationships are authoritative. A bare
 * "Chapter 4" is enough only when the class has exactly one textbook; with
 * two books the app refuses to guess which link the instructor meant.
 */
export function referencedTextbooks(textbooks, item) {
  const books = Array.isArray(textbooks) ? textbooks : [];
  const primaryBooks = books.filter(book => book.role === 'primary');
  const genericOwnerId = books.length === 1
    ? books[0]?.id
    : primaryBooks.length === 1 ? primaryBooks[0].id : null;
  const corpus = referenceCorpus(item);
  const explicit = explicitTextbookCorpus(item);
  const genericBookReference = /\b(?:textbook|chapters?|ch|pages?|pp)\s*(?:no\s*)?(?:\d|[ivxlcdm]+)\b/.test(corpus);

  return books.filter(book => {
    const title = words(book.title);
    const author = words(book.author);
    const isbn = isbnKey(book.isbn);
    const corpusIsbn = isbnKey(corpus);
    if (explicit && ((title && explicit.includes(title))
      || (author && explicit.includes(author))
      || (isbn && isbnKey(explicit).includes(isbn)))) return true;
    if (isbn && corpusIsbn.includes(isbn)) return true;
    if (title && title.length >= 5 && corpus.includes(title)) return true;
    return book.id === genericOwnerId && genericBookReference;
  }).map(book => ({ ...book }));
}
