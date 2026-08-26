// mine-assignments.js — exhaustive per-class assignment mining.
//
// CLI: node scripts/mine-assignments.js <classDir>
//
// Cross-references EVERY scraped source for a class (Canvas assignments,
// syllabus, modules, pages, announcements, discussions, quizzes, calendar
// events, and the extracted text of all course files) and asks Claude to emit
// the complete task list — including implicit work like a weekly reading that
// only appears inside a lecture PPT. Output: <classDir>/assignments_mined.json.
//
// CLAUDE_SKIP=1 writes a deterministic stub derived from assignments.json
// (used by tests / offline runs).

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiInvoke, readJsonSafe, atomicWriteJson } from './_util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Prompt-corpus budgets (chars). Opus 5 has a 1M-token window; these caps keep
// a heavy class (hundreds of slides) to roughly 150K tokens per run.
const PER_MATERIAL_CHARS = 8_000;
const TOTAL_MATERIALS_CHARS = 400_000;
// The syllabus is the one document where obligations routinely sit past the
// per-file clip — BUSI 380's weekly reading lists start ~18K chars into a 49K
// syllabus, so an 8K clip made the miner report the articles as "not present".
// It gets its own section with a budget that fits a whole syllabus.
const SYLLABUS_CHARS = 100_000;
const PER_PAGE_CHARS = 3_000;
const PER_MESSAGE_CHARS = 1_200;
const PER_DESC_CHARS = 1_500;

function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  // Tell the model HOW MUCH is missing — a bare "[...truncated...]" gives it
  // no reason to suspect obligations may live past the cut.
  const dropped = text.length - max;
  return text.slice(0, max)
    + `\n[TRUNCATED — ${dropped} more characters in this document were omitted; it may contain additional tasks or readings not listed above]`;
}

function slugify(title) {
  return String(title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'untitled';
}

function extractJsonFromResponse(raw) {
  const trimmed = (raw || '').trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd !== -1) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }
  return trimmed;
}

// --- Corpus builders -------------------------------------------------------

// Canvas timestamps are UTC ISO strings, but the mining prompt asks the model
// for LOCAL dates and times — feeding it raw due_at values makes 11:59 PM
// deadlines (stored as ~05:00Z the next day) come back a day late. Convert
// before anything enters the corpus.
const _p2 = n => String(n).padStart(2, '0');
function localDateOf(d) {
  return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}`;
}
function toLocal(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${localDateOf(d)} ${_p2(d.getHours())}:${_p2(d.getMinutes())} (local)`;
}

function sectionCanvasAssignments(assignments) {
  const rows = (assignments || []).map(a => ({
    id: a.id,
    name: a.name,
    due_at: toLocal(a.due_at),
    points_possible: a.points_possible ?? null,
    submission_types: a.submission_types ?? null,
    description: clip(stripHtml(a.description), PER_DESC_CHARS) || null,
  }));
  return `## Canvas assignments (authoritative graded list)\n\n${JSON.stringify(rows, null, 1)}\n`;
}

function sectionAssignmentGroups(groups) {
  const rows = (groups || []).map(g => ({
    name: g.name,
    group_weight: g.group_weight ?? null,
    assignment_names: (g.assignments || []).map(a => a.name),
  }));
  return `## Assignment groups / grading weights\n\n${JSON.stringify(rows, null, 1)}\n`;
}

function sectionQuizzes(quizzes) {
  const rows = (quizzes || []).map(q => ({
    id: q.id, title: q.title, due_at: toLocal(q.due_at),
    points_possible: q.points_possible ?? null, quiz_type: q.quiz_type ?? null,
    description: clip(stripHtml(q.description), 500) || null,
  }));
  return `## Canvas quizzes\n\n${JSON.stringify(rows, null, 1)}\n`;
}

function sectionSyllabus(syllabusParsed) {
  if (!syllabusParsed) return '## Parsed syllabus\n\n(none)\n';
  const compact = {
    course: syllabusParsed.course ?? null,
    grading: syllabusParsed.grading ?? null,
    schedule: syllabusParsed.schedule ?? [],
    extraction_confidence: syllabusParsed.extraction_confidence ?? null,
    extraction_notes: syllabusParsed.extraction_notes ?? null,
  };
  return `## Parsed syllabus\n\n${JSON.stringify(compact, null, 1)}\n`;
}

function sectionModules(modules) {
  const rows = (modules || []).map(m => ({
    name: m.name,
    items: (m.items || []).map(i => `${i.type}: ${i.title ?? ''}`),
  }));
  return `## Modules\n\n${JSON.stringify(rows, null, 1)}\n`;
}

function sectionPages(pages) {
  const parts = (pages || []).map(p => {
    const body = clip(stripHtml(p.body), PER_PAGE_CHARS);
    return `### Page: ${p.title}\n${body || '(no body)'}\n`;
  });
  return `## Course pages\n\n${parts.join('\n') || '(none)'}\n`;
}

function sectionMessages(label, items, titleKey, bodyKey, dateKey) {
  const parts = (items || []).map(x => {
    const when = x[dateKey] ? ` (${String(x[dateKey]).slice(0, 10)})` : '';
    let line = `- ${x[titleKey] ?? 'Untitled'}${when}: ${clip(stripHtml(x[bodyKey]), PER_MESSAGE_CHARS)}`;
    // Discussion threads: instructor replies often carry the actual task
    // details ("post by Thursday", "use dataset 3"). replies_text is pre-
    // flattened by the extension for the most relevant topics.
    if (x.replies_text) line += `\n  Thread replies: ${clip(x.replies_text, PER_MESSAGE_CHARS)}`;
    return line;
  });
  return `## ${label}\n\n${parts.join('\n') || '(none)'}\n`;
}

function sectionCalendarEvents(events) {
  const rows = (events || []).map(e => ({
    title: e.title, start_at: toLocal(e.start_at), end_at: toLocal(e.end_at),
    description: clip(stripHtml(e.description), 300) || null,
  }));
  return `## Course calendar events\n\n${JSON.stringify(rows, null, 1)}\n`;
}

function isSyllabusFile(e) {
  return /syllab/i.test(`${e?.displayName ?? ''} ${e?.filename ?? ''}`);
}

// Full syllabus text, near-uncut. The parsed-syllabus section carries only the
// structured schedule the parse stage managed to extract; when that parse is
// weak or empty (local-model runs), this section is the only place the weekly
// reading lists exist at all.
export async function sectionSyllabusFullText(classDir, filesIndex) {
  const entries = (filesIndex || []).filter(e => e && isSyllabusFile(e)
    && e.extractionStatus === 'done' && e.materialsPath
    && e.duplicateOf == null && e.supersededBy == null);
  const parts = [];
  let budget = SYLLABUS_CHARS;
  for (const e of entries) {
    if (budget <= 0) break;
    let text = '';
    try {
      text = await readFile(join(classDir, e.materialsPath), 'utf8');
    } catch { continue; }
    const clipped = clip(text.trim(), budget);
    budget -= clipped.length;
    parts.push(`### ${e.displayName || e.filename || 'Syllabus'}\n${clipped}\n`);
  }
  if (parts.length === 0) {
    // No syllabus among the course files — fall back to the scraped page.
    try {
      const html = await readFile(join(classDir, 'syllabus.html'), 'utf8');
      const text = stripHtml(html);
      if (text) parts.push(`### syllabus.html\n${clip(text, SYLLABUS_CHARS)}\n`);
    } catch { /* no syllabus at all — section says so below */ }
  }
  return `## Full syllabus text (authoritative for schedule, readings, and implicit tasks)\n\n${parts.join('\n') || '(no syllabus found)'}\n`;
}

async function sectionMaterials(classDir, filesIndex) {
  const usable = (filesIndex || [])
    .filter(e => e && e.extractionStatus === 'done' && e.duplicateOf == null
      && e.supersededBy == null && e.materialsPath
      // Syllabus files ride in sectionSyllabusFullText at full length — an 8K
      // clipped duplicate here would only invite the model to cite the cut copy.
      && !isSyllabusFile(e))
    .sort((a, b) => {
      const da = a.canvasUpdatedAt ? Date.parse(a.canvasUpdatedAt) : 0;
      const db = b.canvasUpdatedAt ? Date.parse(b.canvasUpdatedAt) : 0;
      return db - da; // newest first — most likely to hold current obligations
    });

  const parts = [];
  let budget = TOTAL_MATERIALS_CHARS;
  let skipped = 0;
  for (const e of usable) {
    if (budget <= 0) { skipped++; continue; }
    let text = '';
    try {
      text = await readFile(join(classDir, e.materialsPath), 'utf8');
    } catch { continue; }
    const clipped = clip(text.trim(), Math.min(PER_MATERIAL_CHARS, budget));
    budget -= clipped.length;
    const name = e.displayName || e.filename || 'Untitled';
    parts.push(`### File: ${name} (Canvas updated ${e.canvasUpdatedAt?.slice(0, 10) ?? 'unknown'})\n${clipped}\n`);
  }
  let md = `## Extracted course-file text (slides, readings, handouts — newest first)\n\n${parts.join('\n') || '(none extracted yet)'}\n`;
  if (skipped > 0) {
    md += `\n(NOTE: ${skipped} older files omitted for length — their names appear in Modules/Files above.)\n`;
  }
  return md;
}

// --- Validation ------------------------------------------------------------

const KINDS = new Set(['canvas', 'implicit']);
const CATEGORIES = new Set(['homework', 'reading', 'quiz', 'exam', 'project', 'paper', 'presentation', 'participation', 'other']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);

function validateMined(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('mined result is not an object');
  const items = Array.isArray(obj.items) ? obj.items : [];
  const seen = new Set();
  const cleaned = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || !raw.title) continue;
    // Clamped to the id space every consumer accepts (bridge assignment
    // route, user-state task ids): an unbounded model-authored id became a
    // dead calendar link. Every other field here is range-checked; this one
    // was not.
    let id = (typeof raw.id === 'string' && raw.id ? raw.id : slugify(raw.title)).slice(0, 200);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    cleaned.push({
      id,
      title: String(raw.title),
      kind: KINDS.has(raw.kind) ? raw.kind : (raw.canvas_assignment_id != null ? 'canvas' : 'implicit'),
      canvas_assignment_id: raw.canvas_assignment_id ?? null,
      // The aggregate forward contract (canvas-tasks.js coveredCanvasIds):
      // an item covering several Canvas rows lists them ALL, and every one is
      // absorbed. The whitelist here used to strip these before they reached
      // disk, making the documented contract unfulfillable.
      canvas_assignment_ids: Array.isArray(raw.canvas_assignment_ids)
        ? raw.canvas_assignment_ids.filter(v => v != null) : undefined,
      covers: Array.isArray(raw.covers) ? raw.covers.filter(v => v != null) : undefined,
      category: CATEGORIES.has(raw.category) ? raw.category : 'other',
      due_date: typeof raw.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.due_date) ? raw.due_date : null,
      due_time: typeof raw.due_time === 'string' && /^\d{2}:\d{2}$/.test(raw.due_time) ? raw.due_time : null,
      due_confidence: CONFIDENCES.has(raw.due_confidence) ? raw.due_confidence : 'low',
      recurring: raw.recurring ?? null,
      points_possible: typeof raw.points_possible === 'number' ? raw.points_possible : null,
      weight_note: raw.weight_note ?? null,
      description: raw.description ? String(raw.description) : '',
      sources: Array.isArray(raw.sources) ? raw.sources.filter(s => s && s.type && s.ref) : [],
      related_materials: Array.isArray(raw.related_materials)
        ? raw.related_materials.filter(m => m && m.file).map(m => ({ file: String(m.file), why: String(m.why ?? '') }))
        : [],
    });
  }
  return { items: cleaned, notes: typeof obj.notes === 'string' ? obj.notes : '' };
}

function stubFromCanvas(assignments, quizzes) {
  const items = [];
  for (const a of assignments || []) {
    if (!a?.name) continue;
    items.push({
      id: slugify(a.name),
      title: a.name,
      kind: 'canvas',
      canvas_assignment_id: a.id ?? null,
      category: 'other',
      // Local date + time from the same Date — a UTC slice writes day-late
      // dates that sync-calendar would then prefer over its own conversion.
      due_date: a.due_at ? localDateOf(new Date(a.due_at)) : null,
      due_time: a.due_at ? (d => `${_p2(d.getHours())}:${_p2(d.getMinutes())}`)(new Date(a.due_at)) : null,
      due_confidence: a.due_at ? 'high' : 'low',
      recurring: null,
      points_possible: a.points_possible ?? null,
      weight_note: null,
      description: stripHtml(a.description).slice(0, 300),
      sources: [{ type: 'canvas_assignment', ref: `Canvas assignment ${a.id}` }],
      related_materials: [],
    });
  }
  return { items, notes: 'CLAUDE_SKIP=1: stub derived from Canvas assignments only — no implicit mining performed.' };
}

// --- main ------------------------------------------------------------------

async function main() {
  const classDirArg = process.argv[2];
  if (!classDirArg) {
    process.stderr.write('Usage: node mine-assignments.js <classDir>\n');
    process.exit(1);
  }
  const classDir = resolve(classDirArg);
  if (!existsSync(classDir)) {
    process.stderr.write(`Class dir not found: ${classDir}\n`);
    process.exit(1);
  }

  const [metadata, assignments, assignmentGroups, syllabusParsed, modules, pages,
         announcements, discussions, quizzes, calendarEvents, filesIndex] = await Promise.all([
    readJsonSafe(join(classDir, 'metadata.json')),
    readJsonSafe(join(classDir, 'assignments.json')),
    readJsonSafe(join(classDir, 'assignment_groups.json')),
    readJsonSafe(join(classDir, 'syllabus_parsed.json')),
    readJsonSafe(join(classDir, 'modules.json')),
    readJsonSafe(join(classDir, 'pages.json')),
    readJsonSafe(join(classDir, 'announcements.json')),
    readJsonSafe(join(classDir, 'discussions.json')),
    readJsonSafe(join(classDir, 'quizzes.json')),
    readJsonSafe(join(classDir, 'calendar_events.json')),
    readJsonSafe(join(classDir, 'files_index.json')),
  ]);

  const outPath = join(classDir, 'assignments_mined.json');

  if (process.env.CLAUDE_SKIP === '1') {
    const stub = stubFromCanvas(assignments, quizzes);
    stub.mined_at = new Date().toISOString();
    stub.course = { code: metadata?.course_code ?? null, title: metadata?.name ?? null };
    await atomicWriteJson(outPath, stub);
    process.stderr.write(`Written (stub): ${outPath}\n`);
    process.exit(0);
  }

  const corpusParts = [
    `Course: ${metadata?.course_code ?? '?'} — ${metadata?.name ?? '?'} (term: ${metadata?.term?.name ?? '?'})`,
    '',
    sectionCanvasAssignments(assignments),
    sectionAssignmentGroups(assignmentGroups),
    sectionQuizzes(quizzes),
    sectionSyllabus(syllabusParsed),
    await sectionSyllabusFullText(classDir, filesIndex),
    sectionModules(modules),
    sectionPages(pages),
    sectionMessages('Announcements', announcements, 'title', 'message', 'posted_at'),
    sectionMessages('Discussions', discussions, 'title', 'message', 'posted_at'),
    sectionCalendarEvents(calendarEvents),
    await sectionMaterials(classDir, filesIndex),
  ];
  const corpus = corpusParts.join('\n');

  const promptTemplate = await readFile(join(__dirname, 'prompts', 'assignment-mining.md'), 'utf8');
  const prompt = promptTemplate
    .replace('<TODAY>', localDateOf(new Date()))
    .replace('<CORPUS>', () => corpus);

  process.stderr.write(`Mining assignments for ${classDir} (corpus ${Math.round(corpus.length / 1000)}K chars)\n`);

  let rawResponse = null;
  let parsed = null;
  try {
    rawResponse = await aiInvoke(prompt, { timeoutMs: 900000, maxTokens: 16384 });
    parsed = JSON.parse(extractJsonFromResponse(rawResponse));
  } catch (err) {
    process.stderr.write(`Mining attempt failed: ${err.message}\n`);
    try {
      const repair = await aiInvoke(
        `The previous response was not valid JSON. Return the same content as VALID JSON only, matching the original schema.\n\nPrevious response:\n${rawResponse ?? ''}`,
        { timeoutMs: 300000 },
      );
      parsed = JSON.parse(extractJsonFromResponse(repair));
    } catch (err2) {
      process.stderr.write(`Repair failed: ${err2.message}\n`);
      // Skip empty .ERROR files from cancelled/killed AI calls (see parse-syllabus).
      if (rawResponse && rawResponse.trim()) {
        await writeFile(outPath + '.ERROR', rawResponse, 'utf8');
      }
      process.exit(1);
    }
  }

  const result = validateMined(parsed);
  result.mined_at = new Date().toISOString();
  result.course = { code: metadata?.course_code ?? null, title: metadata?.name ?? null };

  await atomicWriteJson(outPath, result);
  process.stderr.write(`Written: ${outPath} (${result.items.length} items)\n`);
  process.exit(0);
}

const isDirectInvocation = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  main().catch(err => {
    process.stderr.write(`FATAL: ${err.stack || err.message || String(err)}\n`);
    process.exit(1);
  });
}
