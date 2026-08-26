// text-search.js — the retriever of last resort: read the words themselves.
//
// The correlation graph routes questions to items, and it is good at that: ask
// about the midterm case and it returns the midterm case assignment, the week
// that prepares it, and the case quizzes. But it represents each item by its
// top twelve tf-idf terms, and twelve terms cannot stand in for a thirty-page
// syllabus. On real data "what is the grading breakdown" selected NOTHING, and
// "attendance policy" selected modules and quizzes — while both answers sat in
// the syllabus text, whose extracted line 107 reads "Grading Point
// Allocation/Process and Assignment Due Dates".
//
// The idf that causes this is not a bug: a term appearing in every document
// scores zero, which is what silently kills Canvas boilerplate. The fix is not
// to weaken it but to add a second retriever that indexes nothing and simply
// scans the text, then merge the two. The graph stays the router; it stops
// being the only one.
//
// Node builtins plus the graph's tokeniser, so both retrievers agree on what a
// word is.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tokenise } from './correlation-graph.js';

export const MATERIALS_DIR = 'materials';
// A passage is the unit that gets scored and quoted. Long enough to carry a
// grading table or a policy paragraph, short enough that ten of them still fit
// in a prompt.
export const PASSAGE_TARGET = 900;
export const PASSAGE_MAX = 1600;
// Ceiling on bytes read per class. BUSI 380's materials are 1.4 MB across 34
// files; this keeps a pathological class from turning one question into a disk
// crawl.
export const MAX_BYTES = 4_000_000;
export const DEFAULT_LIMIT = 6;
// Never return more than this many passages from any single document — one
// verbose deck must not crowd out every other source.
export const MAX_PER_DOC = 2;

/** Distinct query terms a passage must contain before it counts as a hit. */
export const DEFAULT_MIN_TERMS = 2;

// Files under materials/ that are concatenations of the others, or bookkeeping.
const DERIVED_RE = /^(_combined|last_extracted)/i;

/**
 * Split text on blank lines, then pack the pieces into passages of roughly
 * PASSAGE_TARGET characters.
 *
 * Packing rather than hard-slicing matters: extracted PDF text arrives as many
 * short lines, and slicing at a fixed width cuts a grading table in half at an
 * arbitrary column. A single paragraph longer than PASSAGE_MAX is split, but
 * only then.
 */
export function toPassages(text, { target = PASSAGE_TARGET, max = PASSAGE_MAX } = {}) {
  const src = String(text ?? '');
  if (!src.trim()) return [];
  const blocks = src.split(/\n\s*\n/);
  const out = [];
  let buf = '';
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const block of blocks) {
    const b = block.trim();
    if (!b) continue;
    if (b.length > max) {
      flush();
      for (let i = 0; i < b.length; i += max) out.push(b.slice(i, i + max).trim());
      continue;
    }
    if (buf.length + b.length + 2 > target) flush();
    buf = buf ? `${buf}\n\n${b}` : b;
  }
  flush();
  return out;
}

/**
 * Score one passage against the query's terms.
 *
 * Coverage dominates frequency on purpose. A passage naming both "grading" and
 * "breakdown" once is the answer; a passage saying "grading" five times and
 * never "breakdown" is the syllabus footer. Ranking by raw count returns the
 * footer every time.
 *
 * The length term is sqrt, not linear: dividing by length outright makes a
 * six-word heading beat the table underneath it.
 */
export function scorePassage(passage, queryTerms) {
  // Reset BEFORE any early return: this property is read by the caller after
  // every call, and a value left over from the previous passage let
  // zero-match passages through the minScore:0 forced-syllabus path — and
  // leaked across documents and across questions in a long-lived bridge.
  scorePassage.lastTermsMatched = 0;
  if (!queryTerms.size) return 0;
  const tokens = tokenise(passage);
  if (!tokens.length) return 0;
  const counts = new Map();
  for (const t of tokens) if (queryTerms.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  if (!counts.size) return 0;
  const coverage = counts.size / queryTerms.size;
  scorePassage.lastTermsMatched = counts.size;
  let frequency = 0;
  for (const n of counts.values()) frequency += 1 + Math.log(n);
  return (coverage * 3 + frequency / queryTerms.size) / Math.sqrt(Math.max(tokens.length, 30) / 30);
}

async function listDocs(classDir) {
  const dir = join(classDir, MATERIALS_DIR);
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const docs = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.txt')) continue;
    // _combined.txt is pack v1's concatenation of every other file in here. It
    // is a derived aggregate, not a source, and leaving it in returns every hit
    // twice — once under its real filename and once under "_combined".
    if (DERIVED_RE.test(name)) continue;
    const path = join(dir, name);
    let size = 0;
    try { size = (await stat(path)).size; } catch { continue; }
    docs.push({ path, name, size, label: name.replace(/\.txt$/i, '') });
  }
  // Smallest first, so the byte ceiling truncates the long tail rather than
  // spending the whole budget on one 400 KB deck and reading nothing else.
  docs.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  return docs;
}

/**
 * The best passages in a class's extracted text for one question.
 *
 * Returns [{ path, name, label, score, text }] best first — passages, never
 * whole documents. Returns [] when nothing scores, which is the honest answer:
 * a retriever that always returns its best guess hands the model something
 * irrelevant to be confidently wrong about.
 */
export async function searchClassText(classDir, question, opts = {}) {
  const {
    limit = DEFAULT_LIMIT,
    maxBytes = MAX_BYTES,
    maxPerDoc = MAX_PER_DOC,
    minScore = 0.35,
    only = null,
    minTerms = DEFAULT_MIN_TERMS,
  } = opts ?? {};

  const queryTerms = new Set(tokenise(String(question ?? '')));
  if (!queryTerms.size) return [];
  // How many DISTINCT query terms a passage must contain. Score alone is not
  // enough: "what is the late work policy" reduces to {late, work, policy}, and
  // a slide deck that says "work" eight times outscored the syllabus paragraph
  // that answers the question. Requiring two different terms drops the deck and
  // keeps the paragraph. A one-term query cannot clear a bar of two, so the
  // requirement is clamped to what the question can actually supply.
  const needTerms = Math.max(1, Math.min(minTerms, queryTerms.size));

  const docs = await listDocs(classDir);
  const hits = [];
  let budget = maxBytes;
  for (const doc of docs) {
    if (budget <= 0) break;
    if (only && !only(doc)) continue;
    budget -= doc.size;
    let text;
    try { text = await readFile(doc.path, 'utf8'); } catch { continue; }
    const scored = [];
    for (const passage of toPassages(text)) {
      const score = scorePassage(passage, queryTerms);
      if (score < minScore) continue;
      const termsMatched = scorePassage.lastTermsMatched ?? 0;
      if (termsMatched < needTerms) continue;
      scored.push({ score, text: passage, termsMatched });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored.slice(0, maxPerDoc)) {
      hits.push({ path: doc.path, name: doc.name, label: doc.label, score: s.score, text: s.text, terms_matched: s.termsMatched });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

const SYLLABUS_RE = /syllab(us|i)/i;

/**
 * Questions about how the course is run, rather than about its subject matter.
 *
 * These are the ones the graph reliably misses, because policy vocabulary is
 * spread thinly through one long document instead of concentrated in a title.
 * A hit here is a reason to read the syllabus whatever else was selected.
 */
export function isPolicyQuestion(question) {
  return /\b(grad(e|es|ed|ing)|weight(ed|ing)?|percent|%|points?|rubric|curve|polic(y|ies)|attendance|absent|absence|late|extension|deadline|honor|integrity|plagiar|academic|accommodat|office hours|textbook|required|prerequisite|drop|withdraw|participation|breakdown|syllabus)\b/i
    .test(String(question ?? ''));
}

/** The syllabus's extracted text, if the class has one. */
export async function findSyllabusDoc(classDir) {
  const docs = await listDocs(classDir);
  return docs.find(d => SYLLABUS_RE.test(d.name)) ?? null;
}
