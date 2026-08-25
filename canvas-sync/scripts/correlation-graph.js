// How the pieces of one class relate to each other.
//
// A class dir is a flat pile: 34 decks, 39 quizzes, 41 assignments, 15 modules.
// Both consumers of that pile need to know which pieces belong together —
// the context pack an LLM reads, and the retrieval router that decides which
// files to open for a question. Neither can afford to read everything.
//
// So: one node per item, and an edge to the handful of items it is actually
// about. A course whose concepts build (math, CS) ends up dense because the
// same vocabulary recurs week after week; a week-to-week survey course ends up
// sparse. That difference is the useful signal, and it falls out of the text.
//
// DETERMINISTIC BY CONSTRUCTION — no model calls, ever. The corpus is small
// (largest class ~55k words over ~36 files) so an O(N^2) text comparison costs
// milliseconds; an O(N^2) model call would cost hours and would not reproduce.
//
// Node builtins only. Reads a class dir, never writes unless asked.

import fs from 'node:fs/promises';
import path from 'node:path';
import { deriveOrigins } from '../bridge/file-origins.js';

export const GRAPH_VERSION = 1;
export const GRAPH_FILE = 'correlation_graph.json';

// --- Tunables -------------------------------------------------------------
// The blend. These sum to 1 so a raw edge weight is already in [0,1] before
// clamping. Provenance leads because it is the course's own statement about
// what goes together; lexical is what actually separates a dense course from a
// sparse one; temporal is a weak tiebreak and must never dominate, or every
// class becomes a chain of "things due the same Tuesday".
export const W_PROVENANCE = 0.40;
export const W_LEXICAL    = 0.35;
export const W_NUMBER     = 0.15;
export const W_TEMPORAL   = 0.10;

// Provenance sub-scores. Containment (this file IS in that module) is certain;
// sibling-hood (two files in the same module) is strong but not certain.
export const PROV_CONTAINS = 1.00;
export const PROV_SIBLING  = 0.65;

// Dates decay to ~1/e over this many days: same day 1.0, one week 0.61,
// two weeks 0.37, a month 0.12.
export const TEMPORAL_DECAY_DAYS = 14;

// Size control. The graph is read by an LLM, so it must be O(N*K), not O(N^2).
export const DEFAULT_TOP_K = 8;
export const MIN_EDGE_WEIGHT = 0.12;

// Title words count for more than body words: a deck called "Pricing" is about
// pricing in a way that one mention on slide 40 is not.
export const TITLE_TOKEN_WEIGHT = 3;

// Per-document bounds, so one 300-page PDF cannot swamp the idf table.
const MAX_TEXT_CHARS = 120000;
const MAX_DOC_TOKENS = 4000;

// Terms kept per node in the written graph: enough for selectForQuery to seed
// from, small enough that 100 nodes cost ~20KB.
const DEFAULT_TERMS_PER_NODE = 12;

// Reason tags fire above these.
const LEX_TAG_MIN    = 0.12;
const LEX_TAG_STRONG = 0.35;

// One hop of expansion in selectForQuery is worth this much of the seed score.
const HOP_DECAY = 0.55;

// --- Small helpers --------------------------------------------------------

function asArray(v) { return Array.isArray(v) ? v : []; }
function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }
// Every sort here needs a total order or equal-weight items land in whatever
// order they happened to be pushed in.
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

async function readJsonOrNull(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

async function readTextOrNull(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

function isoOrNull(v) {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function firstIso(...vals) {
  for (const v of vals) {
    const iso = isoOrNull(v);
    if (iso) return iso;
  }
  return null;
}

function cleanLabel(s, max = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Origin labels arrive already trimmed to 80 chars with an ellipsis, so match
// on a normalised prefix rather than on equality.
function labelKey(s) {
  return String(s ?? '').toLowerCase().replace(/[…]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
}

const TAG_RE = /<[^>]*>/g;
const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"',
  '&mdash;': '-', '&ndash;': '-', '&hellip;': '...',
};

export function stripHtml(html) {
  if (typeof html !== 'string' || !html) return '';
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(TAG_RE, ' ')
    .replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Tokenisation ---------------------------------------------------------

const STOPWORDS = new Set(`
a about above after again against all also am an and any are aren as at be because been
before being below between both but by can cannot could couldn did didn do does doesn doing
don down during each few for from further had hadn has hasn have haven having he her here
hers herself him himself his how i if in into is isn it its itself just let me more most
must my myself no nor not of off on once only or other ought our ours ourselves out over
own same shan she should shouldn so some such than that the their theirs them themselves
then there these they this those through to too under until up very was wasn we were weren
what when where which while who whom why will with won would wouldn you your yours yourself
yourselves s t d ll m re ve
one two three four five six seven eight nine ten new use used using make makes made get
gets got go goes going see seen look looks may might much many way ways thing things
week weeks day days time times part parts page pages slide slides view views video videos
click here below above next back first last end begin start please note also within
course class canvas assignment assignments quiz quizzes due points submit submission
student students instructor professor read reading chapter chapters section sub
`.split(/\s+/).filter(Boolean));

const TOKEN_RE = /[a-z][a-z0-9'+-]{1,23}|[a-z0-9]+\d[a-z0-9]*/g;
const NON_ASCII_RE = /[^\x00-\x7f]/;
const COMBINING_RE = /[\u0300-\u036f]/g;

/** Lowercase word tokens, stopword- and digit-filtered. Deterministic. */
export function tokenise(text, limit = MAX_DOC_TOKENS) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  let src = (text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text).toLowerCase();
  // TOKEN_RE is ASCII-only, so an accented word would be shredded into its
  // fragments — "résumé" becomes "sum", a real word meaning something else.
  // Fold to the ASCII skeleton first. Guarded: the scan is a no-op on the
  // ASCII text that most classes are, and normalize() is not free.
  if (NON_ASCII_RE.test(src)) src = src.normalize('NFD').replace(COMBINING_RE, '');
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    let tok = m[0].replace(/^[-'+]+|[-'+]+$/g, '');
    if (tok.length < 3 || tok.length > 24) continue;
    // Bare numbers are slide counts and years, never topics. Shared numbering
    // is a separate feature (extractCodes) precisely because it needs context.
    if (/^\d+$/.test(tok)) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
    if (out.length >= limit) break;
  }
  return out;
}

// --- Course numbering -----------------------------------------------------
// "Ch 4", "Week 3", "S2a", "Case 2" — when two items carry the same course
// code they are about the same thing far more reliably than any word overlap.

const NUMBERED = [
  [/\b(?:ch|chap|chapter)s?\.?\s*(\d{1,2})\b/g,        'ch'],
  [/\b(?:wk|week)s?\.?\s*(\d{1,2})\b/g,                'week'],
  [/\b(?:unit|module|mod)\.?\s*(\d{1,2})\b/g,          'unit'],
  [/\b(?:lecture|lec)\.?\s*(\d{1,2})\b/g,              'lecture'],
  [/\b(?:hw|homework)\s*#?\s*(\d{1,2})\b/g,            'hw'],
  [/\b(?:ps|problem\s*set)\s*#?\s*(\d{1,2})\b/g,       'ps'],
  [/\b(?:case)\s*#?\s*(\d{1,2})\b/g,                   'case'],
  [/\b(?:exam|test)\s*#?\s*(\d{1,2})\b/g,              'exam'],
  [/\b(?:lab)\s*#?\s*(\d{1,2})\b/g,                    'lab'],
  [/\b(?:part|pt)\.?\s*(\d{1,2})\b/g,                  'part'],
  // "§" is not a word character, so it cannot sit behind a \b.
  [/(?:§|\bsec|\bsection)s?\.?\s*(\d{1,2}(?:\.\d{1,2})?)\b/g, 'sec'],
];

// Compact syllabus codes: "S2a", "M3", "L12b". Only matched standalone, and
// only with a leading letter run of 1-2, so ordinary words never qualify.
const COMPACT_RE = /\b([a-z]{1,2})(\d{1,2}[a-z]?)\b/g;

/** Course-numbering codes in one title. Returns a Set of canonical strings. */
export function extractCodes(title) {
  const out = new Set();
  const s = String(title ?? '').toLowerCase();
  if (!s) return out;
  for (const [re, kind] of NUMBERED) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) out.add(`${kind}:${m[1]}`);
  }
  COMPACT_RE.lastIndex = 0;
  let c;
  while ((c = COMPACT_RE.exec(s)) !== null) out.add(`code:${c[1]}${c[2]}`);
  return out;
}

const CODE_LABELS = {
  ch: 'Ch', week: 'Week', unit: 'Unit', lecture: 'Lecture', hw: 'HW',
  ps: 'PS', case: 'Case', exam: 'Exam', lab: 'Lab', part: 'Part', sec: '§',
};

function displayCode(code) {
  const [kind, val] = String(code).split(':');
  if (kind === 'code') return val.toUpperCase();
  return `${CODE_LABELS[kind] ?? kind} ${val}`;
}

// --- TF-IDF ---------------------------------------------------------------

/**
 * L2-normalised tf-idf vectors for a list of token arrays.
 * idf = log((N+1)/(df+1)) puts a term present in every document at exactly 0,
 * which is what kills Canvas boilerplate ("view the video below") without a
 * hand-maintained blocklist.
 */
export function buildVectors(docs) {
  const n = docs.length;
  const df = new Map();
  const counts = docs.map(tokens => {
    const c = new Map();
    for (const t of tokens) c.set(t, (c.get(t) ?? 0) + 1);
    for (const t of c.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return c;
  });
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log((n + 1) / (d + 1)));

  const vectors = counts.map(c => {
    const v = new Map();
    let sum = 0;
    for (const [t, k] of c) {
      const w = (1 + Math.log(k)) * (idf.get(t) ?? 0);
      if (w <= 0) continue;
      v.set(t, w);
      sum += w * w;
    }
    const norm = Math.sqrt(sum);
    if (norm > 0) for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
  return { vectors, idf };
}

/** Cosine of two L2-normalised sparse vectors. */
export function cosine(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const o = large.get(t);
    if (o !== undefined) dot += w * o;
  }
  return dot > 1 ? 1 : dot;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter === 0 ? 0 : inter / (a.size + b.size - inter);
}

function daysBetween(isoA, isoB) {
  if (!isoA || !isoB) return null;
  return Math.abs(new Date(isoA) - new Date(isoB)) / 86400000;
}

// --- Node construction ----------------------------------------------------

const SYLLABUS_NAME_RE = /syllab(us|i)/i;

function mkNode({ id, kind, label, date, textPath, canvasId, url }) {
  return {
    id,
    kind,
    label: cleanLabel(label) || id,
    date: date ?? null,
    textPath: textPath ?? null,
    canvasId: canvasId == null ? null : String(canvasId),
    url: url ?? null,
  };
}

// Module items name the content they point at, which is how a quiz learns
// which week it belongs to. Pages are addressed by slug, everything else by id.
function moduleChildId(item) {
  const type = item?.type;
  const cid = item?.content_id;
  if (type === 'Page') {
    const slug = item?.page_url ?? item?.url?.split('/pages/')[1];
    return slug ? `page:${String(slug).split(/[?#]/)[0]}` : null;
  }
  if (cid == null) return null;
  if (type === 'Quiz') return `quiz:${cid}`;
  if (type === 'Assignment') return `assignment:${cid}`;
  if (type === 'Discussion' || type === 'DiscussionTopic') return `discussion:${cid}`;
  if (type === 'File' || type === 'Attachment') return `file:${cid}`;
  return null;
}

async function loadClass(classDir) {
  const [
    filesIndex, assignments, modules, pages, quizzes, announcements,
    discussions, syllabusHtml, metadata,
  ] = await Promise.all([
    readJsonOrNull(path.join(classDir, 'files_index.json')),
    readJsonOrNull(path.join(classDir, 'assignments.json')),
    readJsonOrNull(path.join(classDir, 'modules.json')),
    readJsonOrNull(path.join(classDir, 'pages.json')),
    readJsonOrNull(path.join(classDir, 'quizzes.json')),
    readJsonOrNull(path.join(classDir, 'announcements.json')),
    readJsonOrNull(path.join(classDir, 'discussions.json')),
    readTextOrNull(path.join(classDir, 'syllabus.html')),
    readJsonOrNull(path.join(classDir, 'metadata.json')),
  ]);
  return {
    filesIndex: asArray(filesIndex), assignments: asArray(assignments),
    modules: asArray(modules), pages: asArray(pages), quizzes: asArray(quizzes),
    announcements: asArray(announcements), discussions: asArray(discussions),
    syllabusHtml, metadata: metadata && typeof metadata === 'object' ? metadata : {},
  };
}

// materialsPath comes out of files_index.json, so it is only ever meant to name
// something under the class dir. Refuse anything that resolves outside it: the
// text of whatever it points at would otherwise end up in `terms` and in the
// context pack an LLM reads.
function materialsPathInside(classDir, rel) {
  const root = path.resolve(classDir);
  const abs = path.resolve(root, String(rel));
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

// Read the extracted text for every file node, a few at a time so a 200-file
// class cannot hit the descriptor limit. Reports what it could not read: a
// moved or half-extracted materials dir otherwise produces a graph that is
// quietly empty of vocabulary rather than one that says so.
async function readMaterials(classDir, entries) {
  const out = new Map();
  let missing = 0;
  let outside = 0;
  const POOL = 8;
  for (let i = 0; i < entries.length; i += POOL) {
    const slice = entries.slice(i, i + POOL);
    const texts = await Promise.all(slice.map(async e => {
      if (!e.rel) return '';
      const abs = materialsPathInside(classDir, e.rel);
      if (!abs) { outside++; return ''; }
      const text = await readTextOrNull(abs);
      if (text === null) { missing++; return ''; }
      return text;
    }));
    slice.forEach((e, k) => out.set(e.id, texts[k]));
  }
  return { materials: out, missing, outside };
}

/**
 * Build the graph for one class dir.
 *
 * opts:
 *   topK              max neighbours kept per node (default 8)
 *   minWeight         floor below which an edge is dropped (default 0.12)
 *   weights           { provenance, lexical, number, temporal } overrides
 *   dedupeQuizShells  Canvas mirrors every quiz as an assignment; merging the
 *                     pair into the quiz node halves the node count on a
 *                     quiz-heavy course. Set false for strict one-node-per-row.
 *   termsPerNode      top terms stored per node for selectForQuery (default 12)
 */
export async function buildGraph(classDir, opts = {}) {
  const startedAt = Date.now();
  const {
    topK = DEFAULT_TOP_K,
    minWeight = MIN_EDGE_WEIGHT,
    weights = {},
    dedupeQuizShells = true,
    termsPerNode = DEFAULT_TERMS_PER_NODE,
  } = opts;
  const W = {
    provenance: weights.provenance ?? W_PROVENANCE,
    lexical:    weights.lexical    ?? W_LEXICAL,
    number:     weights.number     ?? W_NUMBER,
    temporal:   weights.temporal   ?? W_TEMPORAL,
  };

  // A class dir that is not there is a caller bug, not a half-synced class, and
  // it must not come back as a well-formed graph saying the class has 0 items.
  // Missing FILES inside a dir that exists still degrade to fewer nodes.
  let stat = null;
  try { stat = await fs.stat(classDir); } catch { stat = null; }
  if (!stat?.isDirectory()) {
    throw new Error(`buildGraph: not a class directory: ${classDir}`);
  }

  const src = await loadClass(classDir);
  const nodes = [];
  const texts = [];          // parallel to nodes: raw body text
  const titles = [];         // parallel to nodes: title text
  const groups = [];         // parallel to nodes: Set of container node ids
  const byId = new Map();
  const skipped = {
    duplicateFiles: 0, unusable: 0, quizShells: 0, missingText: 0, outsideClassDir: 0,
  };

  const push = (node, { title = '', body = '' } = {}) => {
    if (!node || byId.has(node.id)) return null;
    byId.set(node.id, nodes.length);
    nodes.push(node);
    titles.push(title || node.label);
    texts.push(body);
    groups.push(new Set());
    return node;
  };

  // --- Syllabus. When a syllabus PDF was downloaded, the syllabus node IS
  // that file: emitting both would put two nodes on one document and split
  // every edge that should have pointed at "the syllabus".
  const syllabusFileIds = new Set();
  const linked = /\/files\/(\d+)/g;
  let lm;
  while ((lm = linked.exec(src.syllabusHtml ?? '')) !== null) syllabusFileIds.add(lm[1]);
  let syllabusFile = src.filesIndex.find(f => syllabusFileIds.has(String(f?.canvasId)));
  if (!syllabusFile) {
    syllabusFile = src.filesIndex.find(f => SYLLABUS_NAME_RE.test(f?.displayName ?? f?.filename ?? ''));
  }
  const syllabusFileId = syllabusFile ? String(syllabusFile.canvasId) : null;
  const materialsToRead = [];

  // No syllabus node on a class that has no syllabus: a node with no document
  // behind it would still attract edges and would still be offered to the
  // router as something to open.
  if (syllabusFile || src.syllabusHtml) {
    push(mkNode({
      id: 'syllabus',
      kind: 'syllabus',
      label: syllabusFile?.displayName ?? 'Course syllabus',
      date: firstIso(syllabusFile?.canvasUpdatedAt),
      textPath: syllabusFile?.materialsPath ?? null,
      canvasId: syllabusFileId,
      url: null,
    }), { title: 'Course syllabus', body: stripHtml(src.syllabusHtml) });
    if (syllabusFile?.materialsPath) {
      materialsToRead.push({ id: 'syllabus', rel: syllabusFile.materialsPath });
    }
  }

  // --- Files
  for (const f of src.filesIndex) {
    const canvasId = f?.canvasId;
    if (canvasId == null) { skipped.unusable++; continue; }
    if (String(canvasId) === syllabusFileId) continue;
    if (f?.duplicateOf || f?.supersededBy != null) { skipped.duplicateFiles++; continue; }
    const id = `file:${canvasId}`;
    const label = f?.displayName ?? f?.filename ?? `File ${canvasId}`;
    push(mkNode({
      id, kind: 'file', label,
      date: firstIso(f?.canvasUpdatedAt, f?.lastSyncedAt),
      textPath: f?.materialsPath ?? null,
      canvasId,
      url: f?.url ?? null,
    }), { title: label });
    if (f?.materialsPath) materialsToRead.push({ id, rel: f.materialsPath });
  }

  // --- Quizzes first, so the assignment mirrors can be recognised and merged.
  const quizIds = new Set();
  for (const q of src.quizzes) {
    if (q?.id == null) { skipped.unusable++; continue; }
    quizIds.add(String(q.id));
    push(mkNode({
      id: `quiz:${q.id}`, kind: 'quiz', label: q?.title ?? `Quiz ${q.id}`,
      date: firstIso(q?.due_at, q?.unlock_at, q?.lock_at),
      textPath: null, canvasId: q.id, url: q?.html_url ?? null,
    }), { title: q?.title ?? '', body: stripHtml(q?.description) });
  }

  for (const a of src.assignments) {
    if (a?.id == null) { skipped.unusable++; continue; }
    if (dedupeQuizShells && a?.quiz_id != null && quizIds.has(String(a.quiz_id))) {
      skipped.quizShells++;
      const idx = byId.get(`quiz:${a.quiz_id}`);
      // The assignment row is the gradebook's copy and is sometimes the only
      // one carrying a due date, so keep what the quiz row is missing.
      if (idx != null) {
        nodes[idx].assignmentId = String(a.id);
        nodes[idx].date ??= firstIso(a?.due_at, a?.unlock_at);
      }
      continue;
    }
    push(mkNode({
      id: `assignment:${a.id}`, kind: 'assignment', label: a?.name ?? `Assignment ${a.id}`,
      date: firstIso(a?.due_at, a?.unlock_at, a?.created_at),
      textPath: null, canvasId: a.id, url: a?.html_url ?? null,
    }), { title: a?.name ?? '', body: stripHtml(a?.description) });
  }

  for (const p of src.pages) {
    const slug = p?.url ?? p?.page_url ?? (p?.page_id != null ? String(p.page_id) : null);
    if (!slug || typeof slug !== 'string') { skipped.unusable++; continue; }
    push(mkNode({
      id: `page:${slug}`, kind: 'page', label: p?.title ?? slug,
      date: firstIso(p?.updated_at, p?.created_at),
      textPath: null, canvasId: p?.page_id ?? null, url: p?.html_url ?? null,
    }), { title: p?.title ?? '', body: stripHtml(p?.body) });
  }

  for (const d of src.discussions) {
    if (d?.id == null) { skipped.unusable++; continue; }
    push(mkNode({
      id: `discussion:${d.id}`, kind: 'discussion', label: d?.title ?? `Discussion ${d.id}`,
      date: firstIso(d?.posted_at, d?.last_reply_at, d?.created_at),
      textPath: null, canvasId: d.id, url: d?.html_url ?? null,
    }), { title: d?.title ?? '', body: stripHtml(d?.message) });
  }

  for (const an of src.announcements) {
    if (an?.id == null) { skipped.unusable++; continue; }
    push(mkNode({
      id: `announcement:${an.id}`, kind: 'announcement', label: an?.title ?? `Announcement ${an.id}`,
      date: firstIso(an?.posted_at, an?.created_at, an?.delayed_post_at),
      textPath: null, canvasId: an.id, url: an?.html_url ?? null,
    }), { title: an?.title ?? '', body: stripHtml(an?.message) });
  }

  // --- Modules last: their date is inherited from what they contain, so the
  // children must already exist.
  for (const mod of src.modules) {
    if (mod?.id == null && !mod?.name) { skipped.unusable++; continue; }
    // deriveOrigins keys an id-less module on its 80-char trimmed name, so this
    // has to trim identically or file provenance silently misses the module.
    const id = `module:${mod?.id ?? cleanLabel(mod?.name, 80)}`;
    const childIds = asArray(mod?.items).map(moduleChildId).filter(Boolean);
    const childDates = [];
    for (const item of asArray(mod?.items)) {
      const d = firstIso(item?.content_details?.due_at, item?.content_details?.unlock_at);
      if (d) childDates.push(d);
    }
    for (const cid of childIds) {
      const idx = byId.get(cid);
      if (idx != null && nodes[idx].date) childDates.push(nodes[idx].date);
    }
    childDates.sort();
    push(mkNode({
      id, kind: 'module', label: mod?.name ?? `Module ${mod.id}`,
      date: firstIso(mod?.unlock_at) ?? childDates[0] ?? null,
      textPath: null, canvasId: mod?.id ?? null, url: null,
    }), {
      title: mod?.name ?? '',
      body: asArray(mod?.items).map(i => i?.title ?? '').join(' \n'),
    });
    // Membership is what makes a module useful: every child points back at it.
    for (const cid of childIds) {
      const idx = byId.get(cid);
      if (idx != null) groups[idx].add(id);
    }
  }

  // --- File provenance, from the same derivation the bridge UI uses.
  const originsById = deriveOrigins({
    modules: src.modules, assignments: src.assignments, pages: src.pages,
    announcements: src.announcements, discussions: src.discussions,
    quizzes: src.quizzes, syllabusHtml: src.syllabusHtml,
  });
  // deriveOrigins identifies non-module origins only by their item LABEL
  // (its `group` is the bare kind), so resolve labels back to node ids.
  const labelIndex = new Map();
  nodes.forEach(n => {
    const key = `${n.kind}|${labelKey(n.label)}`;
    if (!labelIndex.has(key)) labelIndex.set(key, n.id);
  });
  const resolveOrigin = (o) => {
    if (typeof o?.group === 'string' && o.group.startsWith('module:')) return o.group;
    if (o?.kind === 'syllabus') return 'syllabus';
    if (!o?.itemLabel) return null;
    return labelIndex.get(`${o.kind}|${labelKey(o.itemLabel)}`) ?? null;
  };
  for (const [canvasId, list] of originsById) {
    const idx = byId.get(`file:${canvasId}`) ?? (String(canvasId) === syllabusFileId ? byId.get('syllabus') : undefined);
    if (idx == null) continue;
    for (const o of list) {
      const owner = resolveOrigin(o);
      if (owner && owner !== nodes[idx].id && byId.has(owner)) groups[idx].add(owner);
    }
  }

  // --- Text
  const read = await readMaterials(classDir, materialsToRead);
  const materials = read.materials;
  skipped.missingText = read.missing;
  skipped.outsideClassDir = read.outside;
  const docs = nodes.map((n, i) => {
    const title = titles[i] ?? '';
    const body = `${texts[i] ?? ''} ${materials.get(n.id) ?? ''}`;
    const titleTokens = tokenise(title, 128);
    const tokens = tokenise(body, MAX_DOC_TOKENS);
    for (let r = 0; r < TITLE_TOKEN_WEIGHT; r++) tokens.push(...titleTokens);
    return tokens;
  });
  const { vectors } = buildVectors(docs);
  const codes = nodes.map((n, i) => extractCodes(`${titles[i] ?? ''} ${n.label}`));

  // --- Edges: every pair scored, then thinned to top-K per node.
  const n = nodes.length;
  const candidates = Array.from({ length: n }, () => []);
  let scoredPairs = 0;
  let lexSum = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      scoredPairs++;
      const contains = groups[i].has(nodes[j].id) || groups[j].has(nodes[i].id);
      let shared = 0;
      for (const g of groups[i]) if (groups[j].has(g)) shared++;
      const prov = contains ? PROV_CONTAINS : (shared ? PROV_SIBLING : 0);

      const lex = cosine(vectors[i], vectors[j]);
      lexSum += lex;
      const num = jaccard(codes[i], codes[j]);
      const gap = daysBetween(nodes[i].date, nodes[j].date);
      const temp = gap === null ? 0 : Math.exp(-gap / TEMPORAL_DECAY_DAYS);

      const w = clamp01(W.provenance * prov + W.lexical * lex + W.number * num + W.temporal * temp);
      // A zero-weight edge asserts a relationship the scorer just found none of.
      // The floor normally catches it; a caller who lowers minWeight to 0 must
      // still not get N^2 edges that all say nothing.
      if (w <= 0 || w < minWeight) continue;

      const why = [];
      const parts = [
        [W.provenance * prov, contains
          ? (nodes[i].kind === 'module' || nodes[j].kind === 'module' ? 'in this module' : 'attached here')
          : (shared ? 'same module' : null)],
        [W.lexical * lex, lex >= LEX_TAG_STRONG ? 'strong vocabulary overlap'
          : lex >= LEX_TAG_MIN ? 'shared vocabulary' : null],
        [W.number * num, num > 0 ? `shares "${displayCode([...codes[i]].find(c => codes[j].has(c)))}"` : null],
        [W.temporal * temp, gap === null ? null
          : gap <= 1 ? 'same day' : gap <= 4 ? 'same week' : gap <= 14 ? 'nearby dates' : null],
      ];
      parts.sort((a, b) => b[0] - a[0]);
      for (const [, tag] of parts) if (tag && why.length < 3) why.push(tag);

      const edge = { a: nodes[i].id, b: nodes[j].id, w: Math.round(w * 1000) / 1000, why };
      candidates[i].push({ edge, w });
      candidates[j].push({ edge, w });
    }
  }

  // Union of each node's top-K. An edge survives if EITHER endpoint still
  // wants it, so a hub cannot orphan a leaf whose only real link is the hub.
  // Ties are common — same module, same day, same boilerplate — so the
  // tiebreak has to be a total order on (a, b). A comparator that answers 1
  // both ways for two equal-weight edges leaves the top-K choice to insertion
  // order rather than to any stated rule.
  const byWeightThenId = (x, y) => y.w - x.w || cmpStr(x.a, y.a) || cmpStr(x.b, y.b);
  const kept = new Set();
  const edges = [];
  for (let i = 0; i < n; i++) {
    candidates[i].sort((x, y) =>
      y.w - x.w || cmpStr(x.edge.a, y.edge.a) || cmpStr(x.edge.b, y.edge.b));
    for (const c of candidates[i].slice(0, topK)) {
      if (kept.has(c.edge)) continue;
      kept.add(c.edge);
      edges.push(c.edge);
    }
  }
  edges.sort(byWeightThenId);

  // Top terms per node, so selectForQuery works off the written file alone.
  nodes.forEach((node, i) => {
    const top = [...vectors[i]].sort((a, b) => b[1] - a[1]).slice(0, termsPerNode);
    node.terms = Object.fromEntries(top.map(([t, w]) => [t, Math.round(w * 100) / 100]));
  });

  const graph = {
    version: GRAPH_VERSION,
    class: {
      slug: path.basename(classDir),
      code: src.metadata?.course_code ?? null,
      name: src.metadata?.name ?? null,
    },
    builtAt: new Date().toISOString(),
    nodes,
    edges,
    stats: {},
  };
  graph.stats = {
    ...graphStats(graph),
    topK,
    minWeight,
    weights: W,
    scoredPairs,
    meanLexical: scoredPairs ? Math.round((lexSum / scoredPairs) * 10000) / 10000 : 0,
    skipped,
    buildMs: Date.now() - startedAt,
  };
  return graph;
}

// --- Persistence ----------------------------------------------------------

/** Write <classDir>/correlation_graph.json atomically. */
export async function writeGraph(classDir, graph) {
  const file = path.join(classDir, GRAPH_FILE);
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.mkdir(classDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(graph, null, 2), 'utf8');
  await fs.rename(tmp, file);
  return file;
}

/** Read it back. Missing or corrupt reads as null — never throws. */
export async function readGraph(classDir) {
  const g = await readJsonOrNull(path.join(classDir, GRAPH_FILE));
  if (!g || typeof g !== 'object' || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
  return g;
}

// --- Queries --------------------------------------------------------------

// A router calls neighbours() once per node, and rebuilding the whole adjacency
// each time turns that into O(N*E log E). Keyed on the edge array's identity so
// a different graph never reuses it; the length check catches an appended edge.
// Editing an existing edge's weight in place does NOT invalidate — nothing in
// this module does that, and callers should treat a built graph as frozen.
const ADJ_CACHE = new WeakMap();

function adjacency(graph) {
  const edges = graph?.edges;
  if (!Array.isArray(edges)) return new Map();
  const hit = ADJ_CACHE.get(edges);
  if (hit && hit.length === edges.length) return hit.adj;

  const adj = new Map();
  for (const e of edges) {
    if (!e?.a || !e?.b) continue;
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push({ id: e.b, w: e.w ?? 0, why: e.why ?? [] });
    adj.get(e.b).push({ id: e.a, w: e.w ?? 0, why: e.why ?? [] });
  }
  for (const list of adj.values()) list.sort((x, y) => y.w - x.w || cmpStr(x.id, y.id));
  ADJ_CACHE.set(edges, { adj, length: edges.length });
  return adj;
}

/** Node ids adjacent to nodeId, strongest first. */
export function neighbours(graph, nodeId, n = DEFAULT_TOP_K) {
  const list = adjacency(graph).get(nodeId) ?? [];
  return list.slice(0, n).map(x => x.id);
}

/**
 * What to open for a question: nodes whose stored terms match the query, then
 * one hop out through the edges. Returns ranked node ids, best first, and an
 * empty array when nothing matches — a router should read nothing rather than
 * read something irrelevant.
 */
export function selectForQuery(graph, queryText, { limit = 12 } = {}) {
  const nodes = asArray(graph?.nodes);
  if (!nodes.length) return [];
  const qTokens = tokenise(String(queryText ?? ''), 256);
  if (!qTokens.length) return [];
  const qtf = new Map();
  for (const t of qTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);

  const scores = new Map();
  for (const node of nodes) {
    const terms = node?.terms;
    if (!terms || typeof terms !== 'object') continue;
    let s = 0;
    for (const [t, k] of qtf) {
      // Object.hasOwn, not terms[t]: a query containing the word "constructor"
      // would otherwise read Object.prototype.constructor, multiply a number by
      // a function, and take the whole node's score to NaN — which fails the
      // s > 0 test below and silently deletes the node from the results.
      if (!Object.hasOwn(terms, t)) continue;
      const w = terms[t];
      if (typeof w === 'number' && w > 0) s += (1 + Math.log(k)) * w;
    }
    // A query naming the item outright must beat a query merely sharing its
    // vocabulary, even when the title words were too common to survive idf.
    const label = String(node.label ?? '').toLowerCase();
    for (const t of qtf.keys()) if (t.length >= 4 && label.includes(t)) s += 0.15;
    if (s > 0) scores.set(node.id, s);
  }
  if (!scores.size) return [];

  const adj = adjacency(graph);
  const expanded = new Map(scores);
  for (const [id, s] of scores) {
    for (const nb of adj.get(id) ?? []) {
      const bonus = s * (nb.w ?? 0) * HOP_DECAY;
      if (bonus > (expanded.get(nb.id) ?? 0)) expanded.set(nb.id, bonus);
    }
  }
  return [...expanded.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([id]) => id);
}

/** Shape of the graph, for the stats block and for tuning. */
export function graphStats(graph) {
  const nodes = asArray(graph?.nodes);
  const edges = asArray(graph?.edges);
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const degree = new Map(nodes.map(n => [n.id, 0]));
  const strength = new Map(nodes.map(n => [n.id, 0]));
  for (const e of edges) {
    if (degree.has(e.a)) { degree.set(e.a, degree.get(e.a) + 1); strength.set(e.a, strength.get(e.a) + (e.w ?? 0)); }
    if (degree.has(e.b)) { degree.set(e.b, degree.get(e.b) + 1); strength.set(e.b, strength.get(e.b) + (e.w ?? 0)); }
  }
  const degrees = [...degree.values()].sort((a, b) => a - b);
  const mid = degrees.length ? (degrees.length % 2
    ? degrees[(degrees.length - 1) / 2]
    : (degrees[degrees.length / 2 - 1] + degrees[degrees.length / 2]) / 2) : 0;
  const possible = nodeCount > 1 ? (nodeCount * (nodeCount - 1)) / 2 : 0;
  const hubs = [...strength.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 5)
    .filter(([, s]) => s > 0)
    .map(([id, s]) => ({
      id,
      label: nodes.find(x => x.id === id)?.label ?? id,
      degree: degree.get(id) ?? 0,
      strength: Math.round(s * 100) / 100,
    }));
  return {
    nodeCount,
    edgeCount,
    density: possible ? Math.round((edgeCount / possible) * 10000) / 10000 : 0,
    medianDegree: mid,
    hubs,
  };
}

// --- Rendering ------------------------------------------------------------

const KIND_SHORT = {
  file: 'file', assignment: 'assign', module: 'module', page: 'page',
  quiz: 'quiz', announcement: 'announce', discussion: 'discuss', syllabus: 'syllabus',
};

function shortDate(iso) {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

function trim(s, max) {
  const t = String(s ?? '').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Rungs tried in order until one fits the byte budget. Real Canvas titles run
// to 120 characters, so a class of long-titled items has to give up neighbours
// and label width before it gives up being readable at all.
const MARKDOWN_LADDER = [
  { perNode: 5, labelWidth: 46, nbWidth: 38, whyPerEdge: 2 },
  { perNode: 4, labelWidth: 42, nbWidth: 32, whyPerEdge: 2 },
  { perNode: 4, labelWidth: 38, nbWidth: 28, whyPerEdge: 1 },
  { perNode: 3, labelWidth: 34, nbWidth: 24, whyPerEdge: 1 },
  { perNode: 2, labelWidth: 30, nbWidth: 22, whyPerEdge: 1 },
];

export const MARKDOWN_BUDGET_BYTES = 40 * 1024;

/**
 * Compact rendering for the context pack. Budgeted, not exhaustive: the point
 * is that an LLM can read the whole thing, so the renderer drops neighbours
 * and clips labels until it fits `maxBytes`. Pass maxBytes: Infinity to render
 * one pass at the given settings.
 */
export function toMarkdown(graph, { maxBytes = MARKDOWN_BUDGET_BYTES, ...overrides } = {}) {
  let last = '';
  for (const rung of MARKDOWN_LADDER) {
    last = renderMarkdown(graph, { ...rung, ...overrides });
    if (Buffer.byteLength(last, 'utf8') <= maxBytes) return last;
  }
  // The tightest rung still overruns: this class has more items than the budget
  // can hold at any width. Drop whole rows — weakest first — and say how many,
  // because the caller asked for a budget and a pack that quietly runs 7x over
  // it is what blows up the context window it was sized for.
  const rung = { ...MARKDOWN_LADDER[MARKDOWN_LADDER.length - 1], ...overrides };
  let lo = 0;
  let hi = asArray(graph?.nodes).length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(renderMarkdown(graph, { ...rung, maxRows: mid }), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return renderMarkdown(graph, { ...rung, maxRows: lo });
}

function renderMarkdown(graph, { perNode, labelWidth, nbWidth, whyPerEdge, maxRows = Infinity }) {
  const nodes = asArray(graph?.nodes);
  // A stats block can be missing or a stub on a hand-assembled graph; falling
  // through to it regardless prints "undefined items, undefined links".
  const stats = Number.isFinite(graph?.stats?.nodeCount) ? graph.stats : graphStats(graph);
  const adj = adjacency(graph);
  const labelOf = new Map(nodes.map(n => [n.id, n.label]));
  const name = graph?.class?.code || graph?.class?.slug || 'class';

  const out = [];
  out.push(`# Correlation graph — ${name}`);
  out.push('');
  out.push(`${stats.nodeCount} items, ${stats.edgeCount} links, density ${stats.density}, median degree ${stats.medianDegree}.`);
  out.push('Each row lists the items most related to that item, with why. Weights are 0-1.');
  out.push('');

  if (asArray(stats.hubs).length) {
    out.push('## Most connected');
    out.push('');
    for (const h of stats.hubs) out.push(`- ${trim(h.label, labelWidth + 20)} (${h.degree} links)`);
    out.push('');
  }

  // Rows are chosen by connection strength but printed in graph order, so
  // clipping to a budget drops the least informative rows rather than whichever
  // kind happens to be built last.
  const linked = nodes.filter(x => (adj.get(x.id) ?? []).length);
  const strength = new Map(linked.map(x =>
    [x.id, (adj.get(x.id) ?? []).reduce((s, nb) => s + (nb.w ?? 0), 0)]));
  const shownIds = new Set(linked
    .slice()
    .sort((x, y) => (strength.get(y.id) - strength.get(x.id)) || cmpStr(x.id, y.id))
    .slice(0, maxRows)
    .map(x => x.id));

  out.push('## Links');
  out.push('');
  out.push('| Item | Kind | When | Related to |');
  out.push('| --- | --- | --- | --- |');
  for (const node of nodes) {
    if (!shownIds.has(node.id)) continue;
    const list = (adj.get(node.id) ?? []).slice(0, perNode);
    const rel = list.map(nb => {
      const why = asArray(nb.why).slice(0, whyPerEdge).join(', ');
      return `${trim(labelOf.get(nb.id) ?? nb.id, nbWidth)} (${nb.w}${why ? `; ${why}` : ''})`;
    }).join('; ');
    const kind = Object.hasOwn(KIND_SHORT, node.kind) ? KIND_SHORT[node.kind] : String(node.kind ?? '?');
    out.push(`| ${trim(node.label, labelWidth)} | ${kind} | ${shortDate(node.date)} | ${rel} |`);
  }
  if (linked.length > shownIds.size) {
    out.push('');
    out.push(`_${linked.length - shownIds.size} of ${linked.length} linked items omitted to fit the size budget._`);
  }

  const isolated = nodes.filter(x => !(adj.get(x.id) ?? []).length);
  if (isolated.length) {
    const listed = isolated.slice(0, Number.isFinite(maxRows) ? maxRows : isolated.length);
    out.push('');
    out.push(`## Unconnected (${isolated.length})`);
    out.push('');
    const more = isolated.length - listed.length;
    out.push([listed.map(x => trim(x.label, labelWidth)).join('; '), more ? `… and ${more} more` : '']
      .filter(Boolean).join(' '));
  }
  out.push('');
  return out.join('\n');
}
