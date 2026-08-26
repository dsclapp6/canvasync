// Calls Claude to plan calendar events for one course.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { claudeInvoke, extractJsonFromResponse } from './claude.js';
// One rule governs every link handed to the user: for quiz-backed assignments
// the raw html_url is the teacher view ("Access Denied" for students).
import { canvasItemUrl } from '../../canvas-sync/canvas-links.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, 'prompts', 'calendar-plan.md');

function loadPromptTemplate() {
  return readFile(PROMPT_PATH, 'utf8');
}

export async function readClassInputs(classDir) {
  const mdPath = join(classDir, 'AI_CONTEXT', 'context.md');
  const metaPath = join(classDir, 'metadata.json');
  const assignPath = join(classDir, 'assignments.json');

  const aiContext = existsSync(mdPath) ? await readFile(mdPath, 'utf8') : '';
  const metadata  = existsSync(metaPath)
    ? JSON.parse(await readFile(metaPath, 'utf8'))
    : {};
  const assignments = existsSync(assignPath)
    ? JSON.parse(await readFile(assignPath, 'utf8'))
    : [];

  return { aiContext, metadata, assignments };
}

export function filterFutureAssignments(assignments, now = new Date()) {
  const t = now.getTime();
  return assignments.filter(a => {
    if (!a.due_at) return false;
    const d = new Date(a.due_at);
    return !Number.isNaN(d.getTime()) && d.getTime() > t;
  });
}

// Distil a minimal assignment record for the prompt — avoid firehosing
// megabytes of Canvas HTML into the model.
function slimAssignment(a) {
  return {
    id: String(a.id),
    name: a.name,
    due_at: a.due_at,
    points_possible: a.points_possible,
    submission_types: a.submission_types,
    html_url: canvasItemUrl(a) ?? a.html_url ?? null,
    description_text: stripHtml(a.description || '').slice(0, 2000),
    assignment_group: a.assignment_group?.name ?? null,
    group_weight: a.assignment_group?.group_weight ?? null,
  };
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function contentHash(ev) {
  // Any change to these fields forces a PATCH.
  const h = createHash('sha256');
  h.update(JSON.stringify({
    t: ev.title,
    s: ev.startISO,
    e: ev.endISO,
    d: ev.description,
    r: ev.reminders,
    l: ev.location ?? null,
  }));
  return h.digest('hex');
}

export async function planEventsForClass({
  classDir,
  existingMapping = {},
  now = new Date(),
  model = null,
}) {
  const { aiContext, metadata, assignments } = await readClassInputs(classDir);
  const future = filterFutureAssignments(assignments, now).map(slimAssignment);

  if (process.env.CLAUDE_SKIP === '1') {
    return stubPlan(future, metadata, now);
  }

  if (future.length === 0) {
    return { events: [], skipped: [] };
  }

  const template = await loadPromptTemplate();
  const prompt = template
    .replace(/<NOW_ISO>/g, now.toISOString())
    .replace('<METADATA_JSON>', JSON.stringify(metadata, null, 2))
    .replace('<AI_CONTEXT_MD>', aiContext)
    .replace('<ASSIGNMENTS_JSON>', JSON.stringify(future, null, 2))
    .replace('<EXISTING_MAPPING_JSON>', JSON.stringify(existingMapping, null, 2));

  const raw = await claudeInvoke(prompt, { timeoutMs: 180_000, model });
  const jsonStr = extractJsonFromResponse(raw);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Planner returned invalid JSON: ${err.message}\nRaw head: ${raw.slice(0, 400)}`);
  }
  return normalizePlan(parsed, future);
}

function normalizePlan(p, knownAssignments = []) {
  const events = Array.isArray(p.events) ? p.events : [];
  const skipped = Array.isArray(p.skipped) ? p.skipped : [];
  // The corrected (student-facing) URL per assignment id. The model only ever
  // COPIES a URL, so the event's link is looked up here, not trusted from the
  // response — a checkpoint inherits its parent's.
  const urlById = new Map(knownAssignments.map(a => [String(a.id), a.html_url ?? null]));
  return {
    events: events
      .filter(e => e && e.canvasAssignmentId && e.startISO && e.endISO && e.title)
      .map(e => {
        const id = String(e.canvasAssignmentId);
        const parentId = e.parentCanvasAssignmentId != null ? String(e.parentCanvasAssignmentId) : null;
        const knownUrl = urlById.get(id) ?? (parentId ? urlById.get(parentId) : null);
        return {
          canvasAssignmentId:       id,
          kind:                     e.kind === 'checkpoint' ? 'checkpoint' : 'assignment',
          parentCanvasAssignmentId: parentId,
          checkpointIndex:          e.checkpointIndex != null ? Number(e.checkpointIndex) : null,
          title:                    e.title,
          startISO:                 e.startISO,
          endISO:                   e.endISO,
          description:              e.description ?? '',
          reminders:                Array.isArray(e.reminders) ? e.reminders.filter(Number.isFinite) : [],
          htmlUrl:                  knownUrl ?? e.htmlUrl ?? null,
          courseCode:               e.courseCode ?? '',
        };
      }),
    skipped,
  };
}

// Deterministic fallback used by tests. Produces one assignment event per
// future assignment, no checkpoints, minimal description.
function stubPlan(futureAssignments, metadata, now) {
  const code = metadata.course_code || '';
  const events = futureAssignments.map(a => {
    const due = new Date(a.due_at);
    const start = new Date(due.getTime() - 30 * 60_000);
    return {
      canvasAssignmentId: String(a.id),
      kind: 'assignment',
      parentCanvasAssignmentId: null,
      checkpointIndex: null,
      title: `[${code}] ${a.name}`,
      startISO: start.toISOString(),
      endISO: due.toISOString(),
      description: `Due: ${a.due_at}\nPoints: ${a.points_possible}\nCanvas: ${a.html_url ?? ''}`,
      reminders: [60],
      htmlUrl: a.html_url ?? null,
      courseCode: code,
    };
  });
  return { events, skipped: [] };
}
