// canvas-links.js — the URL a student can actually open.
//
// Canvas hands back `html_url` on every assignment, but for a quiz-backed
// assignment that URL (/courses/:c/assignments/:a) is the *teacher* view of the
// object. A student following it gets "Access Denied" — the page they are
// allowed to see lives at /courses/:c/quizzes/:quizId. Roughly 95% of the
// assignments in a course built out of Canvas quizzes are affected, so linking
// by html_url alone makes most calendar rows dead ends.
//
// Shared by the bridge, the dashboard, and sync-calendar so one rule governs
// every link we hand the user. Node builtins only — no imports at all.

// The course id must END at the segment boundary. Without the lookahead,
// (\d+) stops at the first non-digit and never checks what follows, so
// /courses/93903abc/ silently resolved to course 93903 — a real course that is
// not the one in the URL.
const BASE_RE = /^(https?:\/\/[^/]+)\/courses\/(\d+)(?=$|[/?#])/;

// Canvas object ids are integers. Anything else — an object, an array, a
// boolean, a path fragment — must not be pasted into a URL. The empty array is
// the dangerous one: it stringifies to '' and yields `.../quizzes/`, the course
// quiz INDEX, which loads perfectly well and is not the item the user clicked.
// Inventing a destination is worse than falling back to the one Canvas gave us.
function scalarId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return /^\d+$/.test(t) ? t : null;
}

// submission_types is an array in every Canvas payload, but mined and
// hand-rolled rows carry a bare string often enough that treating a non-array
// as "no types at all" skipped the exclusion list entirely and put a Submit
// button on ungraded work.
function submissionTypes(item) {
  const raw = item?.submission_types;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

// Nothing to submit to. `none`/`not_graded`/`on_paper` are Canvas saying so
// outright; `external_tool` is LTI work handed in inside the tool on the
// assignment page, which has no /submissions/new route at all — Roll Call
// Attendance is the sharpest case, where the student submits nothing ever and
// still got a Submit button.
const NO_SUBMISSION_TYPES = new Set(['none', 'not_graded', 'on_paper', 'external_tool']);

/**
 * Split an html_url into { base, courseId }. Returns null when the URL is not
 * a recognisable Canvas course URL — callers fall back to whatever they had.
 */
export function parseCourseUrl(htmlUrl) {
  const m = BASE_RE.exec(String(htmlUrl || ''));
  return m ? { base: m[1], courseId: m[2] } : null;
}

/**
 * The canonical student-facing URL for a Canvas item.
 *
 * `item` is a raw Canvas assignment (or anything carrying the same fields):
 *   html_url, quiz_id, is_quiz_assignment, submission_types, discussion_topic
 *
 * Precedence: quizzes and discussions get their own object URL; everything
 * else keeps html_url. A quiz_id is trusted over submission_types because
 * Canvas sometimes reports `online_quiz` on an assignment with no quiz object.
 */
export function canvasItemUrl(item) {
  if (!item) return null;
  const html = item.html_url || null;
  const parts = parseCourseUrl(html);
  if (!parts) return html;
  const { base, courseId } = parts;

  const quizId = scalarId(item.quiz_id ?? item.quizId);
  if (quizId) return `${base}/courses/${courseId}/quizzes/${quizId}`;

  const topicId = scalarId(item.discussion_topic?.id);
  if (topicId) return `${base}/courses/${courseId}/discussion_topics/${topicId}`;

  return html;
}

/**
 * Where the user submits. For quizzes that is the quiz itself (taking it IS
 * submitting); for everything else Canvas has a dedicated submission route.
 * Returns null when there is nothing to submit to — meetings, readings, and
 * anything Canvas marked `none`/`not_graded`, so callers can hide the button
 * rather than offer a link that goes nowhere.
 */
export function canvasSubmitUrl(item) {
  if (!item) return null;
  if (submissionTypes(item).some(t => NO_SUBMISSION_TYPES.has(t))) return null;

  const parts = parseCourseUrl(item.html_url);
  if (!parts) return null;
  const { base, courseId } = parts;

  const quizId = scalarId(item.quiz_id ?? item.quizId);
  if (quizId) return `${base}/courses/${courseId}/quizzes/${quizId}/take`;

  const assignmentId = scalarId(item.id);
  if (!assignmentId) return null;
  return `${base}/courses/${courseId}/assignments/${assignmentId}/submissions/new`;
}

/** True when following html_url would land a student on a denied page. */
export function needsUrlRewrite(item) {
  const fixed = canvasItemUrl(item);
  return Boolean(fixed && item?.html_url && fixed !== item.html_url);
}
