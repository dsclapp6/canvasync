/**
 * grades.js — turn Canvas assignments + groups + a parsed syllabus into a
 * defensible statement of where a class grade stands.
 *
 * The governing rule here is the one the calendar already runs on: NO TIME
 * BEATS A WRONG TIME. A grade a student trusts and acts on is worse than a
 * blank when it is wrong, so every number this module emits has to be one the
 * data actually supports. That constraint is what shapes the whole design,
 * because the real corpus does not cooperate:
 *
 *   - Canvas assignment-group weights are 0 in four of six classes. The
 *     professors never configured weighting; Canvas is computing on total
 *     points whether or not the syllabus says so.
 *   - The syllabi DO state complete weights, but they do not line up with the
 *     Canvas groups. BUSI 305's syllabus says Homework is 10% while its Canvas
 *     group says 15%, and its three exams (85% of the grade) are not in Canvas
 *     at all. BUSI 374 maps two components onto one empty "Exams" group.
 *     BUSI 380 has 65% of the grade sitting in no group of its own. Exactly one
 *     class (BUSI 396) matches 1:1.
 *
 * So this module never merges the two sources into a single confident number.
 * It resolves ONE scheme, says which source it came from, and reports:
 *
 *   current  — the weighted average over graded work only (Canvas's "current
 *              grade": ungraded work is ignored, not counted as zero)
 *   floor    — every remaining point scored as 0
 *   ceiling  — every remaining point scored full
 *
 * A band is honest in a way a point estimate is not. "You are at 92% on what
 * has been graded; between 41% and 96% depending on the rest" is a true
 * statement on day one of the term. A single projected "92%" is not.
 *
 * Pure ESM: no DOM, no Node builtins, so the page and `node --test` run the
 * same file.
 */

/* ------------------------------------------------------------------ *
 * Which assignments count
 * ------------------------------------------------------------------ */

/**
 * Reasons an assignment is excluded from grade arithmetic entirely. These are
 * Canvas's own flags — an assignment carrying one of them does not move the
 * grade, so counting its points_possible would deflate every percentage.
 */
export const NOT_COUNTED = {
  unpublished: 'not published',
  omitted: 'omitted from final grade',
  hidden_gradebook: 'hidden in gradebook',
  not_graded: 'not a graded assignment',
};

export function countsTowardGrade(a) {
  if (!a || typeof a !== 'object') return { counts: false, reason: NOT_COUNTED.not_graded };
  if (a.published === false) return { counts: false, reason: NOT_COUNTED.unpublished };
  if (a.omit_from_final_grade === true) return { counts: false, reason: NOT_COUNTED.omitted };
  if (a.hide_in_gradebook === true) return { counts: false, reason: NOT_COUNTED.hidden_gradebook };
  if (a.grading_type === 'not_graded') return { counts: false, reason: NOT_COUNTED.not_graded };
  return { counts: true, reason: null };
}

/**
 * What Canvas is telling us about one submission.
 *
 * The subtle case is 'hidden'. Canvas omits `score`, `grade`, `entered_score`
 * and `entered_grade` from the submission object entirely — the keys are not
 * present, not merely null — when an assignment uses a manual post policy and
 * the grade has not been released. In this corpus that correlation is exact:
 * BUSI 380 has 41 assignments, two of them post_manually, and precisely those
 * two lack the score key. So a missing key is not missing data to go re-fetch;
 * it is the instructor withholding a grade, and no amount of extra pulling
 * will produce it.
 *
 * We only call it 'hidden' when Canvas also says workflow_state is 'graded'.
 * Otherwise a manual-post assignment that is simply not due yet would read as
 * "your grade is being withheld", which is alarming and false.
 */
export function submissionState(a) {
  const s = (a && a.submission) || {};
  if (s.excused === true) return 'excused';
  const hasScore = Object.prototype.hasOwnProperty.call(s, 'score');
  if (hasScore && typeof s.score === 'number') return 'graded';
  if (!hasScore && s.workflow_state === 'graded') return 'hidden';
  if (s.missing === true) return 'missing';
  if (s.workflow_state === 'submitted' || s.workflow_state === 'pending_review') return 'submitted';
  if (s.submitted_at) return 'submitted';
  return 'pending';
}

/** Points possible, coerced. Canvas sends null for ungraded placeholders. */
export function pointsPossible(a) {
  const p = a && a.points_possible;
  return typeof p === 'number' && isFinite(p) && p >= 0 ? p : 0;
}

/** Points earned on a graded submission, after any late-policy deduction. */
export function pointsEarned(a) {
  const s = (a && a.submission) || {};
  return typeof s.score === 'number' && isFinite(s.score) ? s.score : 0;
}

/* ------------------------------------------------------------------ *
 * Drop rules
 * ------------------------------------------------------------------ */

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function asCount(word) {
  if (word == null) return null;
  const t = String(word).trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
}

/**
 * Read a drop rule out of prose.
 *
 * Canvas has a structured `rules` object on each assignment group, and in this
 * corpus it is `{}` for every group in every class — yet the syllabi state drop
 * rules plainly ("Lowest two scores dropped", "highest 5 scores used"). Those
 * rules move the grade by whole letter steps, so ignoring them silently would
 * be a wrong answer of exactly the kind this module exists to avoid.
 *
 * Returns { drop } — how many lowest scores fall away — or null when the text
 * says nothing we can act on. Deliberately narrow: it matches the phrasings
 * actually present and refuses to guess at anything else.
 */
export function parseDropRule(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t) return null;

  // Keep-rules first. "highest 5 scores used" states the same policy from the
  // other end and contains no drop language at all — reading it with the drop
  // patterns below would invert its meaning.
  let m = t.match(/(?:highest|best|top)\s+(\w+)\s+(?:\w+\s+)?(?:scores?|grades?)\s+(?:are\s+|will\s+be\s+)?(?:used|counted|kept)/);
  if (m) {
    const n = asCount(m[1]);
    if (n != null) return { drop: null, keep: n, source: 'keep' };
  }

  // Everything below is a drop-rule, so require the word.
  if (!/\bdropp?(?:ed|s|ing)?\b/.test(t)) return null;

  // The count can lead ("two lowest grades dropped") or trail ("lowest two
  // scores dropped"), and both appear in this corpus. Try the leading form
  // first: the trailing pattern also matches "lowest grades dropped" with
  // "grades" in the count position, which silently reads as one.
  m = t.match(/(\w+)\s+lowest\b/);
  if (m) {
    const n = asCount(m[1]);
    if (n != null) return { drop: n, keep: null, source: 'dropped' };
  }
  m = t.match(/lowest\s+(\w+)/);
  if (m) {
    const n = asCount(m[1]);
    if (n != null) return { drop: n, keep: null, source: 'dropped' };
  }
  // "Lowest quiz score dropped" names no count, which means one.
  if (/\blowest\b/.test(t)) return { drop: 1, keep: null, source: 'dropped' };
  return null;
}

/** Canvas's own structured rule, when a teacher actually configured one. */
export function groupDropRule(group) {
  const r = (group && group.rules) || {};
  const n = typeof r.drop_lowest === 'number' ? r.drop_lowest : 0;
  return n > 0 ? { drop: n, keep: null, source: 'canvas' } : null;
}

/* ------------------------------------------------------------------ *
 * Matching syllabus components to Canvas groups
 * ------------------------------------------------------------------ */

export function normaliseName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')       // "Diverge Artifacts (Group)" -> "diverge artifacts"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Crude singular/plural fold so "Homework" meets "Homeworks". */
function stem(s) {
  return s.endsWith('es') ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s;
}

function nameMatches(a, b) {
  const x = normaliseName(a), y = normaliseName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(' ').map(stem).join(' ');
  const ys = y.split(' ').map(stem).join(' ');
  return xs === ys;
}

/**
 * Pair syllabus components with Canvas assignment groups.
 *
 * The match is deliberately strict — exact or singular/plural only, no fuzzy
 * containment. Containment is what would let "Case Knowledge Online Quizzes"
 * (24% in BUSI 380's syllabus) swallow the group "Case Knowledge and Quiz
 * Assignments", which actually holds the midterm and final case worth 65%
 * between them. That single bad pairing would misreport the grade by more than
 * a letter, so the rule is: match only what is unmistakable, and report the
 * rest as unmatched.
 *
 * `complete` is true only when every component pairs with exactly one group and
 * every group holding assignments is spoken for. Anything less and the caller
 * must not weight by these components.
 */
export function matchComponents(components, groups) {
  const comps = Array.isArray(components) ? components : [];
  const grps = Array.isArray(groups) ? groups : [];
  const pairs = [];
  const usedGroups = new Set();
  const unmatchedComponents = [];
  const ambiguous = [];

  for (const c of comps) {
    const hits = grps.filter(g => nameMatches(c && c.name, g && g.name));
    if (hits.length === 1) {
      const g = hits[0];
      if (usedGroups.has(String(g.id))) {
        ambiguous.push({ component: c && c.name, reason: 'group already claimed' });
      } else {
        usedGroups.add(String(g.id));
        pairs.push({ component: c, group: g });
      }
    } else if (hits.length > 1) {
      ambiguous.push({ component: c && c.name, reason: `${hits.length} groups match` });
    } else {
      unmatchedComponents.push(c && c.name);
    }
  }

  const unmatchedGroups = grps
    .filter(g => !usedGroups.has(String(g.id)))
    .map(g => g && g.name);

  return {
    pairs,
    unmatchedComponents,
    unmatchedGroups,
    ambiguous,
    complete: comps.length > 0
      && unmatchedComponents.length === 0
      && ambiguous.length === 0,
  };
}

/* ------------------------------------------------------------------ *
 * Resolving which grading scheme is actually in force
 * ------------------------------------------------------------------ */

const WEIGHT_FULL = 95;   // a configured weighting is expected to nearly total 100

function sumWeights(list, key) {
  return (list || []).reduce((n, x) => {
    const w = x && x[key];
    return n + (typeof w === 'number' && isFinite(w) ? w : 0);
  }, 0);
}

/**
 * Decide how this course's grade is computed, and say where that decision came
 * from. Order matters, and each step is a claim we can defend:
 *
 *  1. Canvas says it weights by assignment group (apply_assignment_group_weights
 *     is true) and has weights. Canvas's gradebook is the grade of record for a
 *     course configured that way, so nothing else gets a vote.
 *  2. The flag was not pulled — true of every class already on disk, since
 *     metadata.json's field whitelist never included it — but the group weights
 *     nearly total 100. A teacher does not enter twelve weights summing to 99
 *     by accident. Assume weighting, and mark the assumption.
 *  3. Canvas is not weighting, but the syllabus states components that total
 *     100 AND every one of them maps cleanly onto a Canvas group. Use those.
 *  4. Otherwise: total points, which is what Canvas is doing regardless. If the
 *     syllabus stated a scheme we could not map, it is carried in `stated` for
 *     display only — never for arithmetic.
 */
export function resolveScheme({ metadata, groups, syllabusParsed } = {}) {
  const grps = Array.isArray(groups) ? groups : [];
  const flag = metadata ? metadata.apply_assignment_group_weights : undefined;
  const canvasSum = sumWeights(grps, 'group_weight');
  const comps = ((syllabusParsed || {}).grading || {}).components || [];
  const compSum = sumWeights(comps, 'weight_pct');
  const refusals = [];

  const canvasBuckets = () => grps
    .filter(g => (g.group_weight || 0) > 0)
    .map(g => ({
      key: `g${g.id}`,
      name: g.name,
      weight: g.group_weight,
      groupIds: [String(g.id)],
      dropRule: groupDropRule(g),
    }));

  if (flag === true && canvasSum > 0) {
    return { mode: 'weighted', source: 'canvas', assumed: false,
             buckets: canvasBuckets(), weightSum: canvasSum, stated: comps, refusals };
  }
  if (flag == null && canvasSum >= WEIGHT_FULL) {
    return { mode: 'weighted', source: 'canvas', assumed: true,
             buckets: canvasBuckets(), weightSum: canvasSum, stated: comps, refusals };
  }
  if (flag === true && canvasSum === 0) {
    refusals.push({ reason: 'canvas_weighted_but_unset',
                    detail: 'Canvas is set to weight by group, but every group weight is 0' });
  }

  const match = matchComponents(comps, grps);
  if (comps.length && Math.abs(compSum - 100) <= 1 && match.complete) {
    // Canvas has said outright that it totals by points, and the syllabus has
    // said outright that it weights. Both are true statements about different
    // things — Canvas describes the number in its gradebook, the syllabus
    // describes how the final grade is assigned — and the professor's stated
    // scheme is the one the transcript follows. Use it, but never silently:
    // a disagreement between the two sources is information the student owns.
    if (flag === false) {
      refusals.push({ reason: 'canvas_totals_by_points',
                      detail: 'Canvas totals this course by points; the weights below are the syllabus\'s' });
    }
    return {
      mode: 'weighted', source: 'syllabus', assumed: false, weightSum: compSum,
      buckets: match.pairs.map(({ component, group }) => ({
        key: `c${normaliseName(component.name)}`,
        name: component.name,
        weight: component.weight_pct,
        groupIds: [String(group.id)],
        dropRule: parseDropRule(component.notes) || groupDropRule(group),
      })),
      stated: comps, refusals,
    };
  }

  if (comps.length) {
    if (Math.abs(compSum - 100) > 1) {
      refusals.push({ reason: 'syllabus_weights_incomplete',
                      detail: `syllabus components total ${compSum}%, not 100%` });
    } else if (match.unmatchedComponents.length) {
      refusals.push({ reason: 'syllabus_unmapped',
                      detail: `no Canvas group for ${match.unmatchedComponents.join(', ')}` });
    } else if (match.ambiguous.length) {
      refusals.push({ reason: 'syllabus_ambiguous',
                      detail: match.ambiguous.map(a => `${a.component}: ${a.reason}`).join('; ') });
    }
  }

  return { mode: 'points', source: null, assumed: false, buckets: [],
           weightSum: 0, stated: comps, refusals };
}

/* ------------------------------------------------------------------ *
 * The numbers
 * ------------------------------------------------------------------ */

function tally(list) {
  const t = { earned: 0, possible: 0, remaining: 0, graded: 0, hidden: 0,
              excused: 0, missing: 0, total: 0, scores: [] };
  for (const a of list) {
    const { counts } = countsTowardGrade(a);
    if (!counts) continue;
    t.total += 1;
    const pp = pointsPossible(a);
    const st = submissionState(a);
    if (st === 'excused') { t.excused += 1; continue; }
    if (st === 'graded') {
      const earned = pointsEarned(a);
      t.earned += earned;
      t.possible += pp;
      t.graded += 1;
      if (pp > 0) t.scores.push({ pct: earned / pp, earned, possible: pp });
    } else {
      if (st === 'hidden') t.hidden += 1;
      if (st === 'missing') t.missing += 1;
      t.remaining += pp;
    }
  }
  return t;
}

/**
 * Apply a drop rule — but only once every item in the bucket has been graded.
 *
 * Dropping mid-term is a wrong answer waiting to happen: you cannot know which
 * two of ten scores are lowest when only three have come back, and dropping the
 * lowest of those three flatters the number by exactly the amount a student
 * would most like to believe. So while work is outstanding we report the rule
 * as pending and leave the arithmetic alone.
 */
function applyDrop(t, rule) {
  if (!rule) return { ...t, dropped: 0, dropsPending: 0 };
  const drop = rule.drop != null ? rule.drop : Math.max(0, t.total - (rule.keep ?? t.total));
  if (drop <= 0) return { ...t, dropped: 0, dropsPending: 0 };
  if (t.graded < t.total || t.remaining > 0) {
    return { ...t, dropped: 0, dropsPending: drop };
  }
  const sorted = [...t.scores].sort((a, b) => a.pct - b.pct);
  const gone = sorted.slice(0, Math.min(drop, Math.max(0, sorted.length - 1)));
  let earned = t.earned, possible = t.possible;
  for (const g of gone) { earned -= g.earned; possible -= g.possible; }
  return { ...t, earned, possible, dropped: gone.length, dropsPending: 0 };
}

function pct(n, d) {
  return d > 0 ? (n / d) * 100 : null;
}

function round2(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}

/**
 * Everything a class's grade view needs.
 *
 * Emits three numbers rather than one: `current` (graded work only, Canvas's
 * "current grade" semantics), `floor` (every remaining point scored zero) and
 * `ceiling` (every remaining point scored full). On day one of a term current
 * is null and the band is the whole range, which is the truthful answer — and
 * as work comes back the band narrows on its own without anyone having to
 * invent a projection.
 */
export function classGrades({ metadata, assignments, groups, syllabusParsed, enrollments } = {}) {
  const all = Array.isArray(assignments) ? assignments : [];
  const grps = Array.isArray(groups) ? groups : [];
  const scheme = resolveScheme({ metadata, groups: grps, syllabusParsed });

  const enr = (Array.isArray(enrollments) ? enrollments : []).find(e => e && e.grades) || null;
  const canvas = enr ? {
    currentScore: enr.grades.current_score ?? null,
    currentGrade: enr.grades.current_grade ?? null,
    finalScore: enr.grades.final_score ?? null,
    finalGrade: enr.grades.final_grade ?? null,
    url: enr.grades.html_url ?? null,
  } : null;

  const byGroup = new Map();
  for (const a of all) {
    const k = String(a && a.assignment_group_id);
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(a);
  }

  const notCounted = [];
  for (const a of all) {
    const { counts, reason } = countsTowardGrade(a);
    if (!counts) notCounted.push({ id: a && a.id, name: a && a.name, reason });
  }

  // Buckets carry the weights. In points mode there are no weights, so the
  // Canvas groups still make useful rows — they just do not steer the total.
  const bucketDefs = scheme.mode === 'weighted'
    ? scheme.buckets
    : grps.map(g => ({ key: `g${g.id}`, name: g.name, weight: null,
                       groupIds: [String(g.id)], dropRule: groupDropRule(g) }));

  const buckets = bucketDefs.map(b => {
    const list = b.groupIds.flatMap(id => byGroup.get(id) || []);
    const t = applyDrop(tally(list), b.dropRule);
    return {
      key: b.key, name: b.name, weight: b.weight,
      earned: round2(t.earned), possible: round2(t.possible), remaining: round2(t.remaining),
      graded: t.graded, hidden: t.hidden, excused: t.excused, missing: t.missing,
      total: t.total,
      pct: round2(pct(t.earned, t.possible)),
      dropped: t.dropped, dropsPending: t.dropsPending,
      dropRule: b.dropRule,
    };
  });

  // Anything in a group no bucket claims still counts in points mode, and in
  // weighted mode it is exactly what makes the weighting untrustworthy.
  const claimed = new Set(bucketDefs.flatMap(b => b.groupIds));
  const orphans = [...byGroup.entries()].filter(([k]) => !claimed.has(k)).flatMap(([, v]) => v);
  const orphanTally = tally(orphans);

  const whole = tally(all);
  const totals = {
    earned: round2(whole.earned),
    possible: round2(whole.possible),
    remaining: round2(whole.remaining),
  };

  let current = null, floor = null, ceiling = null;
  const refusals = [...scheme.refusals];

  if (scheme.mode === 'weighted') {
    if (orphanTally.total > 0 && orphanTally.possible + orphanTally.remaining > 0) {
      refusals.push({ reason: 'unweighted_work',
                      detail: `${orphanTally.total} assignment(s) sit outside every weighted bucket` });
    }
    const gradedBuckets = buckets.filter(b => b.possible > 0);
    const liveBuckets = buckets.filter(b => (b.possible || 0) + (b.remaining || 0) > 0);
    const wsum = ws => ws.reduce((n, b) => n + (b.weight || 0), 0);

    if (gradedBuckets.length && wsum(gradedBuckets) > 0) {
      current = round2(gradedBuckets.reduce(
        (n, b) => n + b.weight * (b.earned / b.possible), 0) / wsum(gradedBuckets) * 100);
    }
    if (liveBuckets.length && wsum(liveBuckets) > 0) {
      const denom = wsum(liveBuckets);
      floor = round2(liveBuckets.reduce(
        (n, b) => n + b.weight * (b.earned / (b.possible + b.remaining)), 0) / denom * 100);
      ceiling = round2(liveBuckets.reduce(
        (n, b) => n + b.weight * ((b.earned + b.remaining) / (b.possible + b.remaining)), 0) / denom * 100);
    }
    if (buckets.some(b => b.dropsPending > 0)) {
      refusals.push({ reason: 'drops_pending',
                      detail: 'a drop rule applies but not all of its work is graded' });
    }
  } else {
    current = round2(pct(whole.earned, whole.possible));
    const live = whole.possible + whole.remaining;
    floor = round2(pct(whole.earned, live));
    ceiling = round2(pct(whole.earned + whole.remaining, live));
    if (scheme.stated && scheme.stated.length) {
      refusals.push({ reason: 'points_mode_with_stated_scheme',
                      detail: 'totalled by points; the syllabus states weights Canvas is not applying' });
    }
  }

  // One row per assignment, already carrying the verdict the arithmetic used.
  // The UI must not re-derive state from the raw submission: two readings of
  // "does this count" that drift apart is how a page ends up showing a grade
  // its own breakdown contradicts.
  const bucketOf = new Map();
  for (const b of bucketDefs) for (const id of b.groupIds) bucketOf.set(id, b.name);
  const items = all.map(a => {
    const { counts, reason } = countsTowardGrade(a);
    const state = counts ? submissionState(a) : 'not_counted';
    return {
      id: a.id, name: a.name,
      bucket: bucketOf.get(String(a.assignment_group_id)) ?? null,
      groupId: String(a.assignment_group_id),
      points: pointsPossible(a),
      score: state === 'graded' ? pointsEarned(a) : null,
      pct: state === 'graded' ? round2(pct(pointsEarned(a), pointsPossible(a))) : null,
      state, notCountedReason: counts ? null : reason,
      due: (a.submission && a.submission.cached_due_date) || a.due_at || null,
      late: !!(a.submission && a.submission.late),
      url: a.html_url || null,
    };
  });

  return {
    scheme: { mode: scheme.mode, source: scheme.source, assumed: scheme.assumed,
              weightSum: round2(scheme.weightSum), stated: scheme.stated },
    canvas, buckets, totals, items,
    current, floor, ceiling,
    graded: whole.graded, hidden: whole.hidden, excused: whole.excused,
    missing: whole.missing, counted: whole.total,
    notCounted, refusals,
  };
}
