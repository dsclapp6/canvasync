// canvas-tasks.js — Canvas assignments, normalised into the shape the rest of
// the app calls a "task".
//
// Mining reads slides and syllabi to find work Canvas never lists, and its
// output (assignments_mined.json) is what the task list, the calendar and the
// context packs consume. But mining needs the AI backend, and until it has run
// a class has no tasks at all — which is how four of five real classes here
// ended up showing an empty task list while Canvas held 89 assignments between
// them.
//
// So Canvas is the floor: every class shows its Canvas work immediately, and
// mining adds to it later. sync-calendar and the bridge both read through this
// one function so the calendar and the class page cannot disagree about what
// the work is.
//
// Node builtins only, plus canvas-links — importable from bridge/, scripts/ and
// app/, which each have their own node_modules.

import { canvasItemUrl, canvasSubmitUrl } from './canvas-links.js';

function localIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Date AND time must both come from the same local-time view of due_at.
// Slicing the raw ISO string takes the UTC date, which for the typical 11:59 PM
// local deadline (stored as ~05:00Z the next day) lands the item a whole day
// late.
function dueParts(dueAt) {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return { due_date: String(dueAt).slice(0, 10), due_time: null };
  return {
    due_date: localIsoDate(d),
    due_time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  };
}

// "Exam" and "midterm" are nouns. "Final" usually is not: on this user's six
// classes a bare /\bfinal\b/ caught "Project: Final Project Report" (BUSI 374),
// "Final Presentation" (ENTR 222) and "Cumulative Final Case (Individual)"
// (BUSI 380) — three project deliverables that would have been scheduled as
// exams, with exam-shaped prep at 5 and 1 days instead of a project's 7 and 2.
// So "final" only counts when it is not modifying the thing that follows it.
const FINAL_MODIFIES =
  'project|paper|presentation|talk|report|draft|case|essay|submission|deliverable'
  + '|assignment|portfolio|pitch|memo|reflection|survey|grade|grades|review|showcase';
// Exported: class-chat's FACTS builder must apply the SAME reading of "final"
// — a bare \bfinal\b there reported "Final Presentation" as the next exam.
export const EXAM_RE = new RegExp(`\\b(?:exam|midterm)\\b|\\bfinals?\\b(?!\\s+(?:${FINAL_MODIFIES})\\b)`, 'i');
const QUIZ_RE = /\bquiz\b/i;
const READING_RE = /\b(read(ing)?s?|chapter|ch\.)\b/i;

/**
 * What kind of work a Canvas row is, from its title alone.
 *
 * Order matters and quiz deliberately beats reading: "Reading Quiz 3" and
 * "Chapter 5 Quiz" are graded submissions, not readings, and filing them under
 * `reading` would hand them to a toggle the student uses to hide optional
 * prep. A title with a reading token and no quiz token is the only reading.
 */
export function categoryOf(a) {
  const name = a?.name || '';
  if (EXAM_RE.test(name)) return 'exam';
  if (QUIZ_RE.test(name) || a?.quiz_id) return 'homework';
  if (READING_RE.test(name)) return 'reading';
  return 'homework';
}

/**
 * Canvas assignments as task items. Only dated work: an undated Canvas row has
 * nothing to place on a calendar and nothing to be late for.
 */
export function itemsFromCanvasAssignments(assignments) {
  return (assignments || [])
    .filter(a => a && a.due_at)
    .map(a => ({
      id: `canvas-${a.id}`,
      title: a.name || 'Untitled',
      canvas_assignment_id: a.id,
      category: categoryOf(a),
      canvas_category: categoryOf(a),
      ...dueParts(a.due_at),
      due_confidence: 'high',
      points_possible: a.points_possible ?? null,
      description: '',
      source: 'Canvas',
      origin: 'canvas',
      html_url: canvasItemUrl(a),
      submit_url: canvasSubmitUrl(a),
    }));
}

/**
 * A title, flattened for comparison. Mining rewrites Canvas titles lightly
 * ("Quiz 3 - Segmentation" vs "Quiz 3: Segmentation"), so an exact match misses
 * the duplicate it is meant to catch.
 */
function titleKey(title) {
  return String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Every Canvas assignment id a mined item speaks for.
 *
 * Mining sometimes folds a whole session's worth of Canvas rows into one item
 * ("S2a Concept Check Quizzes (7 items)") but the schema only has room for a
 * single `canvas_assignment_id`, so the other six rows were never claimed and
 * each became its own calendar event beside the aggregate — 7 events for 7
 * quizzes, one of which already said it covered all 7, and 1300 points shown
 * for 700 points of work. `canvas_assignment_ids` / `covers` are the forward
 * contract: list them all and every one is absorbed.
 */
function coveredCanvasIds(it) {
  const out = [];
  const push = (v) => {
    if (v == null) return;
    const s = String(v);
    if (s && !out.includes(s)) out.push(s);
  };
  push(it?.canvas_assignment_id);
  for (const v of Array.isArray(it?.canvas_assignment_ids) ? it.canvas_assignment_ids : []) push(v);
  for (const v of Array.isArray(it?.covers) ? it.covers : []) push(v);
  return out;
}

// "S2a Concept Check Quizzes (7 items)" — a mined item that says out loud it
// stands for several deliverables.
const AGGREGATE_COUNT_RE = /\(\s*(\d+)\s*items?\s*\)/i;

function aggregateCount(title) {
  const m = AGGREGATE_COUNT_RE.exec(String(title ?? ''));
  return m ? Number(m[1]) : 0;
}

/**
 * The task list for a class: everything mining found, plus every dated Canvas
 * assignment mining did not already account for.
 *
 * It is a union, not a fallback. Mining reads slides and syllabi and finds work
 * Canvas never lists (recurring readings, participation, undated prep); Canvas
 * holds the graded rows with real deadlines. Letting mined output *replace*
 * Canvas would drop 41 real deadlines on BUSI 380 the first time mining ran
 * there — the class page and the calendar would quietly lose the work.
 *
 * Where the two sources disagree, each wins at what it actually knows: mining
 * owns the title, description and category (it read the syllabus); Canvas owns
 * the deadline and gets a veto on the category via `canvas_category`. Neither
 * gets to delete the other's work — see the claim rules inside.
 *
 * Returns { items, source } so the UI can say which it is looking at:
 *   'mined'  — mining only (Canvas has nothing dated to add)
 *   'canvas' — Canvas only (mining has not run)
 *   'mixed'  — both
 */
export function tasksForClass({ mined, assignments }) {
  const minedItems = Array.isArray(mined?.items) ? mined.items : [];
  const rows = (assignments || []).filter(a => a && a.id != null);
  const byId = new Map(rows.map(a => [String(a.id), a]));
  const datedIds = new Set(rows.filter(a => a.due_at).map(a => String(a.id)));

  // Ids only — a claim names the SPECIFIC Canvas rows a mined item stands
  // for. There used to be a claimedTitles set beside this one, suppressing
  // every Canvas row whose flattened title matched a mined item's; with two
  // distinct same-named dated rows ("Weekly Reflection" due Sep 1 and Sep
  // 15), it erased the second one outright. Title MATCHING still happens —
  // as resolution, below — and the resolved row's own id is what gets
  // claimed, so its same-named siblings survive as extras.
  const claimedIds = new Set();

  // Mined items describe the work; only Canvas knows its URL — and whether that
  // URL has to be the quiz form rather than the assignment page.
  const items = [];
  for (const it of minedItems) {
    const ids = coveredCanvasIds(it);
    // Resolve against the first id Canvas still HAS, not blindly ids[0]: a
    // mined item can carry a stale first id (deleted row) beside live ones,
    // and resolving by ids[0] alone flipped the whole item to 'syllabus' with
    // its mined date while the claim below swallowed the live dated rows —
    // a graded Canvas deadline vanishing is exactly what invariant "Canvas is
    // truth" forbids.
    const key = ids.find(id => byId.has(id)) ?? ids[0] ?? null;
    let a = key ? byId.get(key) : null;

    // An aggregate that names N deliverables but can only point at one Canvas
    // id, while Canvas holds that id as a dated row of its own, is a summary of
    // work Canvas already schedules. Keeping it double-books: BUSI 380 emitted
    // 24 extra homework ops this way, each at the same date and time as the
    // aggregate that claimed to cover them. An aggregate is only worth keeping
    // when Canvas has nothing dated to show.
    if (ids.length === 1 && aggregateCount(it.title) >= 2 && datedIds.has(key)) continue;

    const tk = titleKey(it.title);

    // No live id, but the item may still describe work Canvas HAS: mining
    // wrote no id at all, or the claimed row was deleted and re-created under
    // the same name. The union's dedupe rule is already the flattened title,
    // so resolve by title before declaring the item AI-only — a matched row
    // must supply the deadline and the links, not be suppressed by a
    // link-less ghost stamped 'syllabus' (that stamp is a lie about real
    // Canvas work, and the mined date overriding the live one is exactly
    // what "Canvas is truth" forbids).
    if (!a && tk) a = rows.find(r => r.due_at && titleKey(r.name) === tk) ?? null;

    if (!a) {
      // Mined an id Canvas no longer has (deleted, or assignments.json
      // missing), and no live row shares the title. Whatever link mining
      // stored is unverifiable, and an unverifiable Submit button is the
      // denied-access bug the links work exists to remove. Claim only the
      // dead ids (harmless — nothing live carries them).
      //
      // `origin` is the one provenance field the UI trusts: 'canvas' means a
      // live Canvas row stands behind this item, 'syllabus' means the AI read
      // it out of course materials and Canvas has nothing to open or submit.
      // An item whose Canvas row vanished is 'syllabus' — claiming otherwise
      // paints a Submit affordance on work Canvas cannot take.
      for (const id of ids) claimedIds.add(id);
      items.push({ ...it, submit_url: null, origin: 'syllabus' });
      continue;
    }

    // A mined item that will never produce a dated event must not silently
    // delete one. BUSI 380's re-mine turned its concept checks into a single
    // `recurring: "before each class"` item still carrying Canvas id 532620 —
    // which is a real, dated, 100-point assignment. Because recurring items are
    // routed to notes rather than ops, claiming that id made a graded deadline
    // vanish from the calendar entirely. The recurrence keeps its note; the
    // Canvas row keeps its date. The RESOLVED row counts too: a recurring
    // item that reached a dated row by title (stale id, re-created row) is
    // the same swallow through a different door.
    const swallowsDated = Boolean(it.recurring)
      && (ids.some(id => datedIds.has(id)) || Boolean(a.due_at));
    if (!swallowsDated) {
      for (const id of ids) claimedIds.add(id);
      claimedIds.add(String(a.id));
    }

    const merged = {
      ...it,
      origin: 'canvas',
      // The RESOLVED row's id, not whatever stale id mining wrote: the
      // assignment route follows this field to the Canvas row, and a dead id
      // there loses the panel its Open/Submit links.
      canvas_assignment_id: a.id,
      html_url: canvasItemUrl(a),
      submit_url: canvasSubmitUrl(a),
      // Canvas's own read of the title, kept beside the mined category so a
      // downstream kind cannot flip just because mining finished. Without it,
      // Canvas 532645 "Midterm Case Assignment-Group Assignment" is an exam
      // before mining and a homework after it.
      canvas_category: categoryOf(a),
    };

    // Canvas is the system of record for deadlines. Mining reads the syllabus,
    // and the syllabus is a plan: ENTR 222's "Choose Group Product" is listed
    // under the 9/10 session but Canvas closes it 2026-09-08 16:00Z. The mined
    // date used to win unconditionally, putting the event two days after the
    // real deadline. The syllabus date is not thrown away — it is written into
    // the description, because a disagreement is information.
    if (a.due_at && !it.recurring) {
      const { due_date, due_time } = dueParts(a.due_at);
      if (it.due_date && it.due_date !== due_date) {
        merged.description = [it.description, `Syllabus says ${it.due_date}; Canvas says ${due_date} — Canvas wins.`]
          .filter(Boolean).join('\n');
      }
      merged.due_date = due_date;
      merged.due_time = due_time;
      merged.due_confidence = 'high';
    }
    items.push(merged);
  }

  const extras = itemsFromCanvasAssignments(rows)
    .filter(it => !claimedIds.has(String(it.canvas_assignment_id)));

  const source = items.length
    ? (extras.length ? 'mixed' : 'mined')
    : 'canvas';
  return { items: items.concat(extras), source };
}
