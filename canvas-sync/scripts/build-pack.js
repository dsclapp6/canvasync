// Context pack v2 — the class as a folder an LLM can navigate.
//
// Pack v1 was three documents: an overview, an assignment guide, and every
// course file's extracted text glued into one _combined.txt. Uploaded to a
// project that reads either all 140KB of slide text or none of it, and with no
// way to tell which deck belongs to which quiz — the model had the material but
// not the map.
//
// v2 keeps every course file as its own file and adds a routing layer: four
// small documents that say what the pack is (00), what the course is (01),
// what is due (02), and — in 03-map.md — which file to open for what, with the
// correlation graph between materials and work items rendered inline. The
// reader opens 00 and 03 always; everything else it opens on purpose.
//
// Deterministic by construction: no AI calls, and no wall-clock stamp anywhere
// in the output, so rebuilding unchanged data produces byte-identical files.
// Every "when was this synced" line is derived from the source data instead.

import { readFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteText } from './_util.js';
import { canvasItemUrl } from '../canvas-links.js';
import { filesWithOrigins } from '../bridge/file-origins.js';
import { shortCourseCode, clip } from './cal-names.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PACK_DIR_NAME = 'pack2';
const MATERIALS_SUBDIR = 'materials';

// Combined ceiling for 00–03. They exist to be pasted into a chat, so they are
// budgeted as one unit; blowing the budget drops detail rather than files.
const DOC_BUDGET_BYTES = 150_000;
// The graph can grow with the square of the file count. Cap its share so one
// dense course cannot crowd out the routing table it is meant to annotate.
const GRAPH_SHARE = 0.4;
const MAX_MATERIAL_CHARS = 400_000;
const MAX_RELATED_PER_FILE = 3;

const DOC_START = '00-START-HERE.md';
const DOC_COURSE = '01-course.md';
const DOC_WORK = '02-work.md';
const DOC_MAP = '03-map.md';

// --- small text helpers -----------------------------------------------------

// Canvas descriptions are rich-text HTML. Cheerio is available here but this
// runs once per assignment on text we only ever clip to a line — a tag strip
// with the five entities Canvas actually emits is enough, and keeps the pack
// builder loadable without the scripts/ node_modules tree.
function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normLabel(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// Pipes and newlines inside a markdown table cell break the table.
function cell(s) {
  return String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function isoDay(iso) {
  const s = String(iso ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

function dueLabel(iso) {
  const day = isoDay(iso);
  if (!day) return 'no due date';
  const t = /T(\d{2}:\d{2})/.exec(String(iso));
  return t ? `${day} ${t[1]} UTC` : day;
}

// Locale-independent ordering. localeCompare's result depends on the ICU data
// built into the running Node, which would make "stable across rebuilds" true
// on this machine and false on the user's.
function byString(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * A filesystem-safe, rebuild-stable slug. Lowercase ASCII only: macOS stores
 * filenames in NFD and compares case-insensitively, so a slug carrying accents
 * or capitals is not the same string coming back out of readdir() as it was
 * going in — and the map file would then reference a name that no longer
 * matches on disk.
 */
export function safeName(raw, max = 60) {
  const ascii = String(raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks NFKD left behind
    .replace(/[^\x20-\x7e]/g, '-');
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
  if (!slug || WINDOWS_RESERVED.test(slug)) return `file-${slug || 'x'}`;
  return slug;
}

function stripExtension(name) {
  return String(name ?? '').replace(/\.[A-Za-z0-9]{1,8}$/, '');
}

function typeLabel(entry) {
  const name = String(entry?.filename || entry?.displayName || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const ct = String(entry?.contentType || '').toLowerCase();
  if (ext === 'pptx' || ct.includes('presentationml')) return 'PPTX';
  if (ext === 'docx' || ct.includes('wordprocessingml')) return 'DOCX';
  if (ext === 'xlsx' || ct.includes('spreadsheetml')) return 'XLSX';
  if (ext === 'pdf' || ct === 'application/pdf') return 'PDF';
  if (ext === 'md') return 'MD';
  if (ext === 'txt' || ct === 'text/plain') return 'TXT';
  if (ext === 'html' || ext === 'htm' || ct.includes('html')) return 'HTML';
  if (['png', 'jpg', 'jpeg', 'gif'].includes(ext) || ct.startsWith('image/')) return 'IMG';
  return (ext || 'FILE').toUpperCase();
}

function quantity(entry) {
  if (entry?.slideCount != null) return `${entry.slideCount} slide${entry.slideCount === 1 ? '' : 's'}`;
  if (entry?.pageCount != null) return `${entry.pageCount} page${entry.pageCount === 1 ? '' : 's'}`;
  if (entry?.sheetCount != null) return `${entry.sheetCount} sheet${entry.sheetCount === 1 ? '' : 's'}`;
  return '';
}

// file-origins already answers "where in the course did this come from"; the
// pack states the winning origin rather than inventing a second vocabulary.
function originLabel(entry) {
  const o = Array.isArray(entry?.origins) ? entry.origins[0] : null;
  if (!o) return 'Unknown';
  return o.itemLabel && o.itemLabel !== o.label ? `${o.label} — ${o.itemLabel}` : String(o.label);
}

// --- sources ----------------------------------------------------------------

// Every class JSON the pack reads. Listed once so the status of each is
// available to the documents that make claims about it.
const SOURCES = [
  'metadata.json', 'assignments.json', 'quizzes.json', 'modules.json',
  'announcements.json', 'pages.json', 'discussions.json', 'files_index.json',
  'syllabus_parsed.json', 'assignment_groups.json', 'grades.json', 'tabs.json',
  'assignments_mined.json',
];

/**
 * Read one source, keeping WHY it is unusable. _util.js's readJsonSafe collapses
 * "the file is absent" and "the file is present and corrupt" into the same null,
 * and the pack cannot afford that: a missing file means a sync step never ran,
 * a corrupt one means it ran and wrote garbage over real data. Reporting the
 * second as the first sends the reader to re-run a sync that will not fix it,
 * and — worse — lets the pack state "0 assignments" as though Canvas said so.
 */
async function readSource(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { data: null, status: 'missing', detail: 'is missing' };
    return { data: null, status: 'unreadable', detail: `could not be read (${err.code ?? err.message})` };
  }
  try {
    return { data: JSON.parse(text), status: 'ok', detail: null };
  } catch (err) {
    return { data: null, status: 'unreadable', detail: `is not valid JSON (${err.message})` };
  }
}

// Phrase for a source the reader is being told about. `ok` still reaches here:
// a file holding valid JSON `null` parses fine and carries nothing, and calling
// that "missing" would send the reader to re-run a sync that already ran.
function sourceState(status) {
  if (status === 'missing') return 'is missing';
  if (status === 'unreadable') return 'could not be read';
  return 'holds no data';
}

/**
 * Resolve a files_index materialsPath under the class directory, or null.
 * The sync writes that field, but a path that climbs out of the class would put
 * an arbitrary local file into the pack under a header claiming Canvas
 * published it — and "the material files are verbatim course material" is the
 * one promise 00-START-HERE.md makes on the pack's behalf.
 */
function materialSource(absClassDir, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const abs = resolve(absClassDir, rel);
  const root = absClassDir.endsWith(sep) ? absClassDir : absClassDir + sep;
  return abs.startsWith(root) ? abs : null;
}

// --- correlation graph ------------------------------------------------------
// scripts/correlation-graph.js is written and owned elsewhere. The contract we
// were handed names buildGraph and toMarkdown and nothing else, so everything
// below reads the returned object defensively: an unexpected shape (or a
// missing module entirely) costs the graph section, never the pack.

async function loadGraphModule(opts) {
  if (opts.graphModule) return { mod: opts.graphModule, error: null };
  const path = opts.graphPath ?? join(__dirname, 'correlation-graph.js');
  try {
    return { mod: await import(path), error: null };
  } catch (err) {
    return { mod: null, error: err.message };
  }
}

async function buildGraphSafely(mod, classDir, payload) {
  if (typeof mod?.buildGraph !== 'function') {
    return { graph: null, error: 'correlation-graph.js exports no buildGraph()' };
  }
  // The module loads the class itself and takes a directory; try the loaded
  // sources second in case it ever takes those instead. The contract we were
  // given names buildGraph and nothing about its argument.
  let error = null;
  for (const arg of [classDir, payload]) {
    try {
      const graph = await mod.buildGraph(arg);
      if (graph && typeof graph === 'object') return { graph, error: null };
      error ??= 'buildGraph() returned nothing usable';
    } catch (err) {
      // Keep the FIRST failure. The directory form is the documented call; the
      // retry's own TypeError ("expected an object") describes the retry, not
      // the reason the real call failed, and reporting it hides the diagnosis.
      error ??= `buildGraph() failed: ${err.message}`;
    }
  }
  return { graph: null, error: error ?? 'buildGraph() returned nothing usable' };
}

function graphMarkdown(mod, graph) {
  if (!graph || typeof mod?.toMarkdown !== 'function') return null;
  try {
    const md = mod.toMarkdown(graph);
    return typeof md === 'string' && md.trim() ? md.trim() : null;
  } catch {
    return null;
  }
}

function labelOf(value, nodesById) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    const node = nodesById.get(String(value));
    return String(node?.label ?? node?.title ?? node?.name ?? value);
  }
  return String(value.label ?? value.title ?? value.name ?? value.id ?? '');
}

function indexNodes(graph) {
  const byId = new Map();
  const byLabel = new Map();
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes
    : (graph?.nodes && typeof graph.nodes === 'object' ? Object.values(graph.nodes) : []);
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const id = n.id ?? n.key ?? n.canvasId;
    if (id == null) continue;
    byId.set(String(id), n);
    // Indexed on collapsed whitespace: the graph tidies its labels, so the node
    // for "Marketing 380  Syllabus.pdf" is labelled with one space and an exact
    // match against the Canvas display name silently finds nothing.
    const label = normLabel(n.label ?? n.title ?? n.name);
    if (label && !byLabel.has(label)) byLabel.set(label, String(id));
  }
  return { byId, byLabel };
}

/**
 * Every id one course file might be filed under in the graph. The graph keys
 * file nodes `file:<canvasId>` — except a syllabus PDF, which it folds into a
 * node called `syllabus` so the syllabus is one node and not two. Matching on
 * the node label as well is what finds that one.
 */
function materialKeys(entry, byLabel) {
  const keys = [entry?.canvasId, entry?.materialsPath, entry?.displayName, entry?.filename];
  if (entry?.canvasId != null) keys.push(`file:${entry.canvasId}`);
  for (const name of [entry?.displayName, entry?.filename]) {
    const id = name ? byLabel.get(normLabel(name)) : null;
    if (id) keys.push(id);
  }
  return keys;
}

/**
 * The strongest few items the graph associates with one course file. `keys` are
 * every identifier this file might be filed under (canvas id, materials path,
 * display name) because the graph's node-key choice is not part of the
 * contract.
 */
function relatedFor(graph, keys, nodesById) {
  if (!graph) return [];
  const wanted = new Set(keys.filter(Boolean).map(String));
  const hits = [];

  const push = (label, weight) => {
    const text = String(label ?? '').replace(/\s+/g, ' ').trim();
    if (text) hits.push({ label: text, weight: Number.isFinite(weight) ? weight : 0 });
  };

  if (typeof graph.relatedTo === 'function') {
    for (const key of wanted) {
      try {
        for (const r of graph.relatedTo(key) ?? []) push(labelOf(r, nodesById), r?.weight ?? r?.score);
      } catch { /* an unusable accessor is the same as no graph */ }
    }
  }

  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  for (const e of edges) {
    if (!e || typeof e !== 'object') continue;
    const from = String(e.from ?? e.source ?? e.a ?? '');
    const to = String(e.to ?? e.target ?? e.b ?? '');
    const weight = Number(e.w ?? e.weight ?? e.score ?? e.strength);
    if (wanted.has(from)) push(labelOf(e.toLabel ?? to, nodesById), weight);
    else if (wanted.has(to)) push(labelOf(e.fromLabel ?? from, nodesById), weight);
  }

  for (const key of wanted) {
    const node = nodesById.get(key);
    const list = node?.related ?? node?.neighbors ?? node?.links;
    for (const r of Array.isArray(list) ? list : []) push(labelOf(r, nodesById), r?.weight ?? r?.score);
  }

  const seen = new Set();
  return hits
    // Weight first, then label: ties must not reorder between rebuilds.
    .sort((a, b) => (b.weight - a.weight) || byString(a.label, b.label))
    .filter(h => (seen.has(h.label) ? false : (seen.add(h.label), true)))
    .slice(0, MAX_RELATED_PER_FILE)
    .map(h => h.label);
}

// --- work items -------------------------------------------------------------

function submissionStatus(item, now) {
  const sub = item.submission;
  if (sub?.excused) return 'excused';
  if (sub?.workflow_state === 'graded' && sub?.grade != null) {
    const out = item.points_possible != null ? `/${item.points_possible}` : '';
    return `graded ${sub.grade}${out}`;
  }
  if (sub?.submitted_at) return `submitted ${isoDay(sub.submitted_at)}, not graded`;
  if (sub?.missing) return 'missing';
  const due = item.due_at ? Date.parse(item.due_at) : NaN;
  if (Number.isFinite(due)) return due < now.getTime() ? 'past due, nothing submitted' : 'not submitted';
  return 'not submitted, no due date';
}

/**
 * Canvas work, deduplicated. An online quiz exists twice in the sync — once in
 * assignments.json and once in quizzes.json — so quizzes already claimed by an
 * assignment are dropped, and only standalone quizzes (surveys, practice) are
 * added. Every row links through canvasItemUrl so a quiz-backed assignment
 * points at /quizzes/ rather than the teacher-only /assignments/ page.
 */
function collectWork(assignments, quizzes, groupsById) {
  const rows = [];
  const claimed = new Set();

  for (const a of assignments) {
    if (a?.quiz_id != null) claimed.add(String(a.quiz_id));
    const group = groupsById.get(String(a?.assignment_group_id));
    rows.push({
      kind: a?.is_quiz_assignment || a?.quiz_id ? 'quiz' : 'assignment',
      id: String(a?.id ?? ''),
      title: String(a?.name ?? 'Untitled'),
      due_at: a?.due_at ?? null,
      points: a?.points_possible ?? null,
      group: group?.name ?? null,
      weight: group?.group_weight ? `${group.group_weight}%` : null,
      url: canvasItemUrl(a),
      description: htmlToText(a?.description),
      submission: a?.submission ?? null,
      points_possible: a?.points_possible ?? null,
    });
  }

  for (const q of quizzes) {
    if (q?.id != null && claimed.has(String(q.id))) continue;
    rows.push({
      kind: 'quiz',
      id: String(q?.id ?? ''),
      title: String(q?.title ?? 'Untitled quiz'),
      due_at: q?.due_at ?? null,
      points: q?.points_possible ?? null,
      group: null,
      weight: null,
      url: canvasItemUrl(q),
      description: htmlToText(q?.description),
      submission: null,
      points_possible: q?.points_possible ?? null,
    });
  }

  // Undated work sorts last, not first: an empty due date is not "the epoch".
  return rows.sort((a, b) => {
    const da = isoDay(a.due_at) || '9999-99-99';
    const db = isoDay(b.due_at) || '9999-99-99';
    return byString(da, db) || byString(a.title, b.title) || byString(a.id, b.id);
  });
}

function renderWorkRow(row, now, detail) {
  const lines = [`### ${row.title}`];
  const meta = [
    `Due: ${dueLabel(row.due_at)}`,
    `Points: ${row.points ?? 'ungraded'}`,
    `Status: ${submissionStatus(row, now)}`,
  ];
  if (row.group) meta.push(`Group: ${row.group}${row.weight ? ` (${row.weight})` : ''}`);
  lines.push(`_${meta.join(' · ')}_`);
  if (row.url) lines.push(`Open: ${row.url}`);
  if (detail && row.description) lines.push(`\n${clip(row.description, 600)}`);
  return lines.join('\n');
}

// --- documents --------------------------------------------------------------

function renderStartHere(ctx) {
  const { code, title, term, materials } = ctx;
  return [
    `# ${code} — context pack`,
    '',
    `This folder is everything canvas-sync could read out of ${title}${term ? ` (${term})` : ''}`,
    'on Canvas: the course description, the graded work, and the full extracted',
    'text of every file the course posted. It was assembled mechanically. No',
    'model wrote any of it, and nothing here is a summary — the material files',
    'are verbatim extractions.',
    '',
    '## Read in this order',
    '',
    `1. \`${DOC_MAP}\` — the routing file. It lists every material file, what each one is,`,
    '   where in the course it came from, and how the files relate to the graded work.',
    `   Decide there which material to open; do not open them all.`,
    `2. \`${DOC_COURSE}\` — instructor, meeting schedule, grading breakdown, policies.`,
    `3. \`${DOC_WORK}\` — every assignment, quiz and deliverable with its due date, points,`,
    '   current status and the Canvas URL to open it.',
    `4. \`${MATERIALS_SUBDIR}/\` — ${materials.length} file${materials.length === 1 ? '' : 's'}, one per course material.`,
    `   Each starts with a header naming the file, where it came from, its date and`,
    '   the work items the correlation graph ties it to.',
    '',
    '## Rules for answering from this pack',
    '',
    '- **Never state a fact that is not in these files.** If the pack does not say it,',
    '  the answer is "the pack does not cover that" — not an inference from what a',
    '  course like this usually does.',
    '- **Cite the file.** Name the pack file you took each claim from, e.g.',
    `  \`${DOC_WORK}\` for a due date, or \`${MATERIALS_SUBDIR}/<name>.txt\` for course content.`,
    '  For a material, cite the file title from its header, not the slug on disk.',
    '- **Dates and points come from `' + DOC_WORK + '` only.** A slide deck that mentions a',
    '  deadline is the older source; Canvas is the live one, and they disagree often.',
    '- **Say when a section is missing.** Sections that could not be built say so in',
    '  place. An absent section means the underlying sync step has not run — not that',
    '  the course has nothing there.',
    '- Extracted text is imperfect: slides lose their layout, scanned PDFs lose',
    '  characters. Quote what is there rather than repairing it silently.',
    '',
    '## Not in this pack',
    '',
    'Canvas does not expose these to a student session: quiz question content,',
    'anything living inside an external tool (Piazza, Panopto, Gradescope — the ones',
    `this course uses are listed in \`${DOC_COURSE}\`), and files inside student group`,
    'spaces. Check those in Canvas directly.',
    '',
  ].join('\n');
}

function renderCourse(ctx, detail) {
  const { code, title, term, syllabus, metadata, groups, grades, externalTools, warnings, sources } = ctx;
  const course = syllabus?.course ?? {};
  const instructor = course.instructor ?? {};
  const grading = syllabus?.grading ?? {};
  const policies = syllabus?.policies ?? {};
  const policyLimit = detail ? 2000 : 400;

  const out = [`# ${code} — course`, ''];
  out.push('| Field | Value |', '|---|---|');
  out.push(`| Course | ${cell(title)} |`);
  out.push(`| Canvas course code | ${cell(metadata?.course_code ?? code)} |`);
  out.push(`| Canvas course id | ${cell(metadata?.id ?? '—')} |`);
  out.push(`| Term | ${cell(term || '—')} |`);
  out.push(`| Instructor | ${cell(instructor.name || '—')} |`);
  out.push(`| Instructor email | ${cell(instructor.email || '—')} |`);
  out.push(`| Office hours | ${cell(instructor.office_hours || '—')} |`);
  out.push(`| Meets | ${cell(course.meeting_schedule || '—')} |`);
  out.push(`| Time zone | ${cell(metadata?.time_zone ?? '—')} |`);
  out.push('');

  if (!syllabus) {
    const state = sourceState(sources['syllabus_parsed.json']);
    out.push(`> The syllabus has not been parsed (\`syllabus_parsed.json\` ${state}), so the`,
      '> instructor, meeting schedule, grading breakdown and policies below are limited to',
      `> what Canvas itself reports. ${sources['syllabus_parsed.json'] === 'unreadable'
        ? 'The file on disk is damaged — delete it and re-run the syllabus parse.'
        : 'Run the syllabus parse to fill them in.'}`, '');
  } else if (syllabus.extraction_confidence && syllabus.extraction_confidence !== 'high') {
    out.push(`> Syllabus extraction confidence is **${syllabus.extraction_confidence}**. Verify anything`,
      '> below against the syllabus file itself before relying on it.', '');
  }

  out.push('## Grading', '');
  const weighted = groups.filter(g => Number(g?.group_weight) > 0);
  if (weighted.length) {
    out.push('_From Canvas assignment groups (authoritative — these are the weights Canvas grades with)._', '');
    out.push('| Component | Weight | Items |', '|---|---|---|');
    for (const g of weighted) {
      out.push(`| ${cell(g.name)} | ${cell(g.group_weight)}% | ${(g.assignments ?? []).length} |`);
    }
    out.push('');
  } else if (Array.isArray(grading.components) && grading.components.length) {
    out.push('_From the syllabus. Canvas reports no assignment-group weights for this course._', '');
    out.push('| Component | Weight | Notes |', '|---|---|---|');
    for (const c of grading.components) {
      out.push(`| ${cell(c.name)} | ${c.weight_pct != null ? `${cell(c.weight_pct)}%` : '—'} | ${cell(clip(c.notes ?? '', 160))} |`);
    }
    out.push('');
  } else {
    out.push('_No grading breakdown found — neither Canvas assignment groups nor the syllabus supplied one._', '');
  }
  if (grading.letter_scale) out.push(`**Letter scale:** ${clip(grading.letter_scale, policyLimit)}`, '');
  if (grading.late_policy) out.push(`**Late policy:** ${clip(grading.late_policy, policyLimit)}`, '');

  const enrollment = grades.find(e => e && e.grades);
  if (enrollment?.grades?.current_score != null) {
    const g = enrollment.grades;
    const final = g.final_score != null && g.final_score !== g.current_score
      ? ` (final including ungraded work: ${g.final_score}%)`
      : '';
    out.push(`**Current grade in Canvas:** ${g.current_grade ? `${g.current_grade} — ` : ''}${g.current_score}%${final}`, '');
  }

  out.push('## Policies', '');
  const named = [
    ['Attendance', policies.attendance],
    ['Academic integrity', policies.academic_integrity],
    ['Accommodations', policies.accommodations],
  ];
  for (const [label, text] of named) {
    out.push(`- **${label}:** ${text ? clip(text, policyLimit) : '_not stated in the syllabus._'}`);
  }
  for (const p of Array.isArray(policies.other) ? policies.other : []) {
    out.push(`- **Other:** ${clip(p, policyLimit)}`);
  }
  out.push('');

  if (externalTools.length) {
    out.push('## External tools (content NOT in this pack)', '');
    out.push('These appear in the course navigation but live outside Canvas, so nothing behind',
      'them was synced. Check them in a browser.', '');
    for (const t of externalTools) out.push(`- ${cell(t.label)}${t.url ? ` — ${t.url}` : ''}`);
    out.push('');
  }

  if (!detail) {
    out.push('_Policy text was shortened to keep this pack small; the full wording is in the',
      'syllabus file listed in `' + DOC_MAP + '`._', '');
  }
  if (warnings.length) {
    out.push('## Build notes', '');
    for (const w of warnings) out.push(`- ${w}`);
    out.push('');
  }
  return out.join('\n');
}

function renderWork(ctx, detail) {
  const { code, work, mined, now, sources } = ctx;
  const today = isoDay(now.toISOString());
  const upcoming = work.filter(r => !isoDay(r.due_at) || isoDay(r.due_at) >= today);
  const past = work.filter(r => isoDay(r.due_at) && isoDay(r.due_at) < today);
  // A finished sync writes both of these for every course, empty arrays
  // included. Either one absent means the list below is a fragment.
  const broken = ['assignments.json', 'quizzes.json'].filter(n => sources[n] !== 'ok');

  const out = [`# ${code} — work`, ''];
  if (broken.length) {
    out.push(`> **This list is incomplete — do not answer "what is due" from it.** ${broken
      .map(n => `\`${n}\` ${sourceState(sources[n])}`).join(', and ')},`,
      `> so whatever graded work ${broken.length === 1 ? 'it' : 'they'} held is absent here. A sync that finished writes both`,
      '> files for every course, empty ones included, so this is a broken sync and not a',
      '> course without assignments. Re-run the sync before trusting anything below.', '');
    out.push(`${work.length} item${work.length === 1 ? '' : 's'} could be read, ${upcoming.length} still open and`,
      `${past.length} past due — a floor, not a total.`, '');
  } else {
    out.push(`Every graded item Canvas reports for this course: ${work.length} in total,`,
      `${upcoming.length} still open and ${past.length} past due. Statuses are the ones Canvas`,
      'recorded at the last sync. Each "Open:" link is the page a student can actually',
      'load — for quiz-backed work that is the quiz, not the assignment page.', '');
  }

  out.push('## At a glance', '');
  if (!work.length) {
    // An empty table renders as an empty grid, which reads as "checked, nothing
    // there" whether or not anything was actually checked.
    out.push(broken.length
      ? '_No graded work could be read — see the notice above._'
      : '_Canvas reports no graded work at all for this course._', '');
  } else {
    out.push('| Due | Item | Points | Status |', '|---|---|---|---|');
    for (const r of work) {
      out.push(`| ${cell(dueLabel(r.due_at))} | ${cell(clip(r.title, 70))} | ${cell(r.points ?? '—')} | ${cell(submissionStatus(r, now))} |`);
    }
    out.push('');
  }

  out.push('## Open work', '');
  // The split is by due DAY, the per-item status by exact timestamp, so an item
  // due at 05:00 today is filed here and still reports "past due". Both are
  // right; say which is which rather than leave the reader to reconcile them.
  out.push(`_Anything due ${today} or later, plus undated work. An item due earlier today is`,
    'still listed here — its Status line is the one that knows the time of day._', '');
  out.push(upcoming.length
    ? upcoming.map(r => renderWorkRow(r, now, detail)).join('\n\n')
    : '_Nothing open._');
  out.push('');

  out.push('## Past due', '');
  out.push(past.length
    ? past.map(r => renderWorkRow(r, now, detail)).join('\n\n')
    : '_Nothing past due._');
  out.push('');

  out.push('## Work that is not a Canvas assignment', '');
  if (!mined) {
    out.push(`_Assignment mining has not run (\`assignments_mined.json\` ${sourceState(sources['assignments_mined.json'])}), so any`,
      'obligation that exists only in the syllabus or a slide deck — recurring readings,',
      'participation, an exam Canvas never got an entry for — is NOT listed here. Do not',
      'read the absence of this section as "there is no other work"._', '');
  } else {
    const items = Array.isArray(mined.items) ? mined.items.filter(i => i?.kind === 'implicit') : [];
    if (!items.length) {
      out.push('_Mining ran and found no obligations outside Canvas._', '');
    } else {
      out.push(`_Mined from the syllabus, slides, pages and announcements. These do NOT exist as`,
        'Canvas assignments and have no Canvas link._', '');
      for (const it of [...items].sort((a, b) => byString(a.due_date ?? '9999', b.due_date ?? '9999') || byString(a.title, b.title))) {
        const due = it.due_date
          ? `${it.due_date}${it.due_time ? ` ${it.due_time}` : ''}${it.due_confidence && it.due_confidence !== 'high' ? ` (${it.due_confidence} confidence)` : ''}`
          : (it.recurring ? `recurring: ${it.recurring}` : 'no date found');
        out.push(`### ${it.title}`);
        const meta = [`Category: ${it.category ?? 'other'}`, `Due: ${due}`];
        if (it.points_possible != null) meta.push(`Points: ${it.points_possible}`);
        if (it.weight_note) meta.push(`Weight: ${it.weight_note}`);
        out.push(`_${meta.join(' · ')}_`);
        if (detail && it.description) out.push(`\n${clip(it.description, 600)}`);
        const sources = Array.isArray(it.sources) ? it.sources : [];
        if (sources.length) out.push(`\nEvidence: ${sources.map(s => `${s.type} — ${s.ref}`).join('; ')}`);
        out.push('');
      }
    }
  }

  if (!detail) {
    out.push('_Item descriptions were dropped to keep this pack small; open the Canvas link._', '');
  }
  return out.join('\n');
}

function renderMap(ctx, graphMd, graphNote) {
  const { code, materials, skipped, work, sources } = ctx;
  const out = [`# ${code} — file map and correlation graph`, ''];
  out.push('This is the routing file. Everything else in the pack is reachable from here.',
    'Find the topic, open the one or two files it names — reading every material file is',
    'never the right move.', '');

  out.push('## Where to look', '');
  out.push('| Question | File |', '|---|---|');
  out.push(`| What is this pack, how should I answer from it | \`${DOC_START}\` |`);
  out.push(`| Instructor, meetings, grading weights, policies | \`${DOC_COURSE}\` |`);
  out.push(`| When is X due, what is it worth, did I submit it | \`${DOC_WORK}\` |`);
  out.push(`| What did the course actually teach about a topic | the material file below |`);
  out.push('');

  out.push(`## Course materials (${materials.length})`, '');
  if (!materials.length) {
    out.push('_No course files have been extracted yet.' + (sources['files_index.json'] === 'ok'
      ? ' `files_index.json` is empty or every'
      : ` \`files_index.json\` ${sourceState(sources['files_index.json'])}, or every`),
      'entry failed extraction, so this pack has no material files. That is a statement',
      'about this pack, not about the course — do not conclude the course posted no files._', '');
  } else {
    out.push('| ID | File | What it is | Where it came from | Updated |', '|---|---|---|---|---|');
    for (const m of materials) {
      const what = [typeLabel(m.entry), quantity(m.entry)].filter(Boolean).join(', ');
      out.push(`| ${cell(m.id)} | \`${MATERIALS_SUBDIR}/${m.filename}\` | ${cell(m.title)} (${cell(what)}) | ${cell(m.origin)} | ${cell(isoDay(m.entry?.canvasUpdatedAt) || '—')} |`);
    }
    out.push('');
  }

  if (skipped.length) {
    out.push('### Course files with no material file', '');
    out.push('`files_index.json` lists these but the pack has no text for them — a duplicate of a',
      'file already here, an extraction that did not finish, or a row that is not a file',
      'record at all. They are named so the count of course files still adds up.', '');
    for (const s of skipped) out.push(`- ${cell(s.title)} — ${cell(s.reason)}`);
    out.push('');
  }

  out.push('## Correlation graph', '');
  if (graphMd) {
    out.push('How the course files relate to each other and to the graded work. Use it to pick',
      `which material to open for a given item in \`${DOC_WORK}\`.`, '', graphMd, '');
  } else {
    out.push(`_Not available: ${graphNote}_`, '',
      'Without the graph, fall back to the "Where it came from" column above: a file whose',
      'origin is a module or an assignment is the material for that item.', '');
  }

  out.push('## Graded work index', '');
  out.push(`Titles only — dates, points, status and links are in \`${DOC_WORK}\`.`, '');
  if (!work.length) out.push(`_Empty. \`${DOC_WORK}\` says why — read it before concluding there is no work._`);
  for (const r of work) out.push(`- ${cell(r.title)}`);
  out.push('');
  return out.join('\n');
}

function materialHeader(m, hasGraph) {
  const what = [typeLabel(m.entry), quantity(m.entry)].filter(Boolean).join(', ');
  const updated = isoDay(m.entry?.canvasUpdatedAt);
  // "no graph" and "graph found nothing" are different facts about this file
  // and a reader acts on them differently, so they never share a phrasing.
  const related = m.related.length
    ? m.related.join(' · ')
    : (hasGraph ? '(none — the graph found no strong link to any other item)' : '(correlation graph unavailable)');
  return [
    `=== ${m.title} ===`,
    `Canvas file ${m.id}${what ? ` · ${what}` : ''}${updated ? ` · updated ${updated}` : ''}`,
    `From: ${m.origin}`,
    `Related work: ${related}`,
    '-'.repeat(72),
    '',
  ].join('\n');
}

// --- build ------------------------------------------------------------------

function utf8Bytes(s) {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Push a foreign markdown block down the heading hierarchy. The graph module
 * renders a standalone document starting at `#`; pasted under 03-map.md's
 * `## Correlation graph` it would outrank the section containing it and every
 * outline of the file would come out wrong. Fenced code is left alone.
 */
function demoteHeadings(md, by = 2) {
  let fenced = false;
  return md.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return line;
    const m = /^(#{1,6})(\s)/.exec(line);
    if (!m) return line;
    return '#'.repeat(Math.min(6, m[1].length + by)) + m[2] + line.slice(m[0].length);
  }).join('\n');
}

/** Trim a rendered block to a byte ceiling on a line boundary. */
function clipBlock(md, maxBytes) {
  if (utf8Bytes(md) <= maxBytes) return md;
  const lines = md.split('\n');
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const size = utf8Bytes(line) + 1;
    if (used + size > maxBytes) break;
    kept.push(line);
    used += size;
  }
  kept.push('', '_(truncated to keep this file pasteable — rebuild the pack for the full graph)_');
  return kept.join('\n');
}

/**
 * Build <classDir>/AI_CONTEXT/pack2/.
 *
 * opts:
 *   now          Date used only to split open work from past due (default: now)
 *   outDir       override the destination (default: <classDir>/AI_CONTEXT/pack2)
 *   graphModule  an already-imported correlation-graph module (tests inject one)
 *   graphPath    where to import it from instead
 *   budgetBytes  combined ceiling for 00–03
 *
 * Returns { dir, files, bytes, warnings }.
 */
export async function buildPack(classDir, opts = {}) {
  const absClassDir = resolve(classDir);
  const outDir = opts.outDir ? resolve(opts.outDir) : join(absClassDir, 'AI_CONTEXT', PACK_DIR_NAME);
  // An Invalid Date passes `instanceof Date` and then throws from toISOString()
  // half way through the build, leaving a directory of materials and no
  // documents. Refuse it before anything is written.
  if (opts.now !== undefined && !(opts.now instanceof Date && Number.isFinite(opts.now.getTime()))) {
    throw new TypeError('buildPack: opts.now must be a valid Date');
  }
  const now = opts.now ?? new Date();
  const budget = Number.isFinite(opts.budgetBytes) ? opts.budgetBytes : DOC_BUDGET_BYTES;
  const warnings = [];

  const src = {};
  await Promise.all(SOURCES.map(async name => {
    src[name] = await readSource(join(absClassDir, name));
  }));
  const sources = Object.fromEntries(SOURCES.map(n => [n, src[n].status]));

  const metadata = src['metadata.json'].data;
  const assignments = src['assignments.json'].data;
  const quizzes = src['quizzes.json'].data;
  const modules = src['modules.json'].data;
  const announcements = src['announcements.json'].data;
  const pages = src['pages.json'].data;
  const discussions = src['discussions.json'].data;
  const syllabus = src['syllabus_parsed.json'].data;
  const grades = src['grades.json'].data;
  const tabs = src['tabs.json'].data;
  const mined = src['assignments_mined.json'].data;

  const arr = v => (Array.isArray(v) ? v : []);
  const filesIndex = arr(src['files_index.json'].data);
  const groups = arr(src['assignment_groups.json'].data);

  // A corrupt source is never just "absent": the sync ran and wrote garbage over
  // data the class really has, so every one of them is named.
  for (const name of SOURCES) {
    if (src[name].status === 'unreadable') {
      warnings.push(`${name} ${src[name].detail} — everything it feeds is missing from this pack.`);
    }
  }
  // The work documents assert a count. Say so when the count has no source.
  for (const name of ['assignments.json', 'quizzes.json']) {
    if (src[name].status === 'missing') {
      warnings.push(`${name} is missing — 02-work.md cannot list the work it held, and its item count is a floor, not a total.`);
    }
  }
  // Warn whenever the section is degraded, whatever the reason — a file holding
  // `null` is as absent to the reader as one that never synced.
  if (!syllabus && sources['syllabus_parsed.json'] !== 'unreadable') {
    warnings.push(`syllabus_parsed.json ${sourceState(sources['syllabus_parsed.json'])} — 01-course.md falls back to Canvas metadata.`);
  }
  if (!mined && sources['assignments_mined.json'] !== 'unreadable') {
    warnings.push(`assignments_mined.json ${sourceState(sources['assignments_mined.json'])} — 02-work.md lists Canvas work only.`);
  }
  if (src['files_index.json'].status === 'missing') {
    warnings.push('files_index.json is missing — the pack has no material files, and the course may have posted files that were never indexed.');
  } else if (src['files_index.json'].status === 'ok' && !Array.isArray(src['files_index.json'].data)) {
    warnings.push('files_index.json is not a list of files — ignored, and the pack has no material files.');
  } else if (!filesIndex.length && src['files_index.json'].status === 'ok') {
    warnings.push('files_index.json lists no files — the pack has no material files.');
  }

  // Identity, with the same precedence build-context.js uses: a parsed syllabus
  // beats Canvas metadata, because Canvas names carry section lists and term
  // suffixes the syllabus does not.
  const course = syllabus?.course ?? {};
  const fullCode = course.code || metadata?.course_code || metadata?.course?.code || 'Unknown course';
  const code = shortCourseCode(fullCode) || fullCode;
  const title = course.title || metadata?.name || metadata?.course?.name || fullCode;
  const rawTerm = course.term || metadata?.term || '';
  const term = typeof rawTerm === 'string' ? rawTerm : (rawTerm?.name || '');

  const groupsById = new Map(groups.map(g => [String(g?.id), g]));
  const work = collectWork(arr(assignments), arr(quizzes), groupsById);

  const externalTools = arr(tabs)
    .filter(t => t && (t.type === 'external' || /^context_external_tool/.test(String(t.id ?? ''))))
    .map(t => ({ label: t.label ?? t.id, url: t.full_url ?? null }));

  // --- materials ------------------------------------------------------------
  // A row that is not a file record cannot be filtered out downstream:
  // attachOrigins() spreads every entry into an object, so a null or a bare
  // string arrives looking like a nameless file and would be published as a
  // material file — a routing-table row for course material that does not
  // exist. Reject them here, and account for them where the reader can see it.
  const malformed = [];
  const usableIndex = filesIndex.filter((entry, i) => {
    const rec = entry && typeof entry === 'object' && !Array.isArray(entry);
    if (rec && (entry.canvasId != null || entry.displayName || entry.filename)) return true;
    malformed.push({ title: `files_index.json entry ${i + 1}`, reason: 'not a file record (no Canvas id and no name) — ignored' });
    return false;
  });
  if (malformed.length) {
    warnings.push(`files_index.json holds ${malformed.length} row${malformed.length === 1 ? '' : 's'} that are not file records — ignored, and listed in ${DOC_MAP}.`);
  }

  const withOrigins = await filesWithOrigins(absClassDir, usableIndex);
  const ordered = [...withOrigins].sort((a, b) =>
    byString(a?.displayName ?? a?.filename, b?.displayName ?? b?.filename) ||
    byString(a?.canvasId, b?.canvasId));

  const graphPayload = {
    classDir: absClassDir,
    assignments: arr(assignments),
    quizzes: arr(quizzes),
    modules: arr(modules),
    announcements: arr(announcements),
    pages: arr(pages),
    discussions: arr(discussions),
    files: withOrigins,
    filesIndex: withOrigins,
    mined,
    syllabus,
  };
  const { mod: graphMod, error: graphImportError } = await loadGraphModule(opts);
  const { graph, error: graphBuildError } = graphMod
    ? await buildGraphSafely(graphMod, absClassDir, graphPayload)
    : { graph: null, error: null };
  const graphNote = graphImportError
    ? `scripts/correlation-graph.js could not be loaded (${graphImportError})`
    : (graphBuildError ?? 'the graph module produced no markdown');
  if (!graph) warnings.push(`Correlation graph unavailable: ${graphNote}`);
  const { byId: nodesById, byLabel: nodesByLabel } = indexNodes(graph);

  const materials = [];
  const skipped = [];
  const usedNames = new Set();

  ordered.forEach((entry, i) => {
    const label = entry?.displayName || entry?.filename || `file ${i + 1}`;
    if (entry?.supersededBy != null) {
      skipped.push({ title: label, reason: `replaced by a newer upload (Canvas file ${entry.supersededBy})` });
      return;
    }
    if (entry?.duplicateOf != null) {
      skipped.push({ title: label, reason: `duplicate of Canvas file ${entry.duplicateOf}` });
      return;
    }
    if (entry?.skipped) {
      skipped.push({ title: label, reason: `not downloaded (${String(entry.skipped)})` });
      return;
    }
    const rawId = String(entry?.canvasId ?? '').replace(/[^A-Za-z0-9]/g, '');
    const id = rawId || `x${String(i + 1).padStart(3, '0')}`;
    let filename = `${id}-${safeName(stripExtension(label))}.txt`;
    // Two Canvas files can slug to the same name only when both lack an id;
    // suffixing keeps the map's one-row-per-file promise true.
    for (let n = 2; usedNames.has(filename); n++) filename = `${id}-${safeName(stripExtension(label))}-${n}.txt`;
    usedNames.add(filename);
    materials.push({
      id,
      title: label,
      filename,
      entry,
      origin: originLabel(entry),
      related: relatedFor(graph, materialKeys(entry, nodesByLabel), nodesById),
    });
  });
  skipped.push(...malformed);

  // Materials are written BEFORE the documents are rendered: every problem
  // found while reading extracted text becomes a warning, and 01-course.md
  // prints the warning list. Rendering first would publish a build-notes
  // section that silently omitted half the build's own notes.
  const materialsDir = join(outDir, MATERIALS_SUBDIR);
  await mkdir(materialsDir, { recursive: true });

  let bytes = 0;
  const written = [];

  for (const m of materials) {
    let text = '';
    const rel = m.entry?.materialsPath;
    const abs = materialSource(absClassDir, rel);
    if (rel && !abs) {
      warnings.push(`${m.title}: materialsPath "${rel}" resolves outside the class directory — refused, so this file has no text.`);
    } else if (abs) {
      try {
        text = await readFile(abs, 'utf8');
      } catch (err) {
        warnings.push(`${m.title}: extracted text could not be read (${err.code ?? err.message}).`);
      }
    }
    if (!text.trim()) {
      const status = m.entry?.extractionStatus ?? 'not extracted';
      text = `_No extracted text for this file (extraction status: ${status}). The file itself is in the class's files/ directory._\n`;
      warnings.push(`${m.title}: no extracted text (extraction status: ${status}).`);
    } else if (text.length > MAX_MATERIAL_CHARS) {
      text = `${text.slice(0, MAX_MATERIAL_CHARS)}\n\n_(text truncated at ${MAX_MATERIAL_CHARS} characters)_\n`;
      warnings.push(`${m.title}: extracted text truncated at ${MAX_MATERIAL_CHARS} characters.`);
    }
    const body = materialHeader(m, Boolean(graph)) + text;
    await atomicWriteText(join(materialsDir, m.filename), body);
    bytes += utf8Bytes(body);
    written.push(`${MATERIALS_SUBDIR}/${m.filename}`);
  }

  // A course file removed on Canvas must not survive in the pack: the map would
  // no longer reference it, and a reader has no way to tell a stale file from a
  // current one. Only this build's own output directory is touched.
  try {
    for (const name of await readdir(materialsDir)) {
      if (name.endsWith('.txt') && !usedNames.has(name)) {
        await unlink(join(materialsDir, name)).catch(() => {});
      }
    }
  } catch { /* freshly created */ }

  // --- documents ------------------------------------------------------------
  const ctx = { code, title, term, syllabus, metadata, groups, grades: arr(grades), externalTools, work, mined, materials, skipped, now, warnings, sources };

  const rawGraphMd = graphMarkdown(graphMod, graph);
  const graphMd = rawGraphMd ? clipBlock(demoteHeadings(rawGraphMd), Math.floor(budget * GRAPH_SHARE)) : null;

  const render = detail => ({
    [DOC_START]: renderStartHere(ctx),
    [DOC_COURSE]: renderCourse(ctx, detail),
    [DOC_WORK]: renderWork(ctx, detail),
    [DOC_MAP]: renderMap(ctx, graphMd, graphNote),
  });

  const docSize = d => Object.values(d).reduce((n, s) => n + utf8Bytes(s), 0);
  let docs = render(true);
  if (docSize(docs) > budget) {
    warnings.push(`Pack documents exceeded the ${budget}-byte budget — item descriptions and long policy text were dropped.`);
    docs = render(false);
    if (docSize(docs) > budget) {
      // Descriptions are the only thing trimming can drop. One row per work item
      // and per material file is the floor, and dropping rows would make the pack
      // quietly wrong rather than merely large — so it ships oversized and says so.
      warnings.push(`Pack documents are STILL over the ${budget}-byte budget after trimming (${docSize(docs)} bytes) — there is nothing left to drop but routing rows. Raise budgetBytes or split the course; do not assume these paste into one chat.`);
      docs = render(false); // re-render so the line above reaches 01-course.md
    }
  }

  for (const [name, body] of Object.entries(docs)) {
    await atomicWriteText(join(outDir, name), body);
    bytes += utf8Bytes(body);
    written.push(name);
  }

  return { dir: outDir, files: written.sort(byString), bytes, warnings };
}

async function main() {
  const classDir = process.argv[2];
  if (!classDir) {
    process.stderr.write('Usage: node build-pack.js <classDir>\n');
    process.exit(1);
  }
  const result = await buildPack(classDir);
  for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
  process.stderr.write(`Written: ${result.dir} (${result.files.length} files, ${result.bytes} bytes)\n`);
  process.exit(0);
}

// Only run main() when invoked directly, not when imported. Compare decoded
// paths — a raw `file://${argv[1]}` comparison fails whenever the repo path
// contains a space (URL-encoding), silently skipping main().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
