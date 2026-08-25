import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countsTowardGrade, submissionState, parseDropRule, groupDropRule,
  matchComponents, normaliseName, resolveScheme, classGrades, NOT_COUNTED,
} from '../grades.js';

/** An assignment with sane defaults; override what a test cares about. */
function asg(o = {}) {
  return {
    id: o.id ?? 1, name: o.name ?? 'A', assignment_group_id: o.group ?? '1',
    points_possible: o.pts ?? 10, published: o.published ?? true,
    grading_type: o.grading_type ?? 'points',
    omit_from_final_grade: o.omit ?? false, hide_in_gradebook: o.hide ?? false,
    post_manually: o.post_manually ?? false,
    submission: { workflow_state: 'unsubmitted', ...(o.sub ?? {}) },
  };
}
const graded = (pts, score, group = '1') =>
  asg({ pts, group, sub: { score, workflow_state: 'graded', graded_at: 'x', posted_at: 'x' } });

describe('countsTowardGrade', () => {
  it('counts an ordinary published assignment', () => {
    assert.equal(countsTowardGrade(asg()).counts, true);
  });
  it('excludes each of Canvas\'s exclusion flags', () => {
    assert.equal(countsTowardGrade(asg({ published: false })).reason, NOT_COUNTED.unpublished);
    assert.equal(countsTowardGrade(asg({ omit: true })).reason, NOT_COUNTED.omitted);
    assert.equal(countsTowardGrade(asg({ hide: true })).reason, NOT_COUNTED.hidden_gradebook);
    assert.equal(countsTowardGrade(asg({ grading_type: 'not_graded' })).reason, NOT_COUNTED.not_graded);
  });
});

describe('submissionState', () => {
  it('reads a real score', () => {
    assert.equal(submissionState(graded(10, 8)), 'graded');
  });
  it('treats a zero score as graded, not as absent', () => {
    assert.equal(submissionState(graded(10, 0)), 'graded');
  });
  it('reports excused before anything else', () => {
    assert.equal(submissionState(asg({ sub: { excused: true, workflow_state: 'graded', score: 9 } })), 'excused');
  });
  it('calls a withheld grade hidden — Canvas drops the score key entirely', () => {
    // No `score` key at all, which is how Canvas signals an unposted grade on a
    // manual-post assignment. Every such case in the live corpus looks like this.
    assert.equal(submissionState(asg({ post_manually: true, sub: { workflow_state: 'graded' } })), 'hidden');
  });
  it('does NOT call an ungraded manual-post assignment hidden', () => {
    // The alarming false positive: due next month, nothing submitted, and the
    // student is told their grade is being withheld.
    assert.equal(submissionState(asg({ post_manually: true, sub: { workflow_state: 'unsubmitted' } })), 'pending');
  });
  it('distinguishes missing, submitted and pending', () => {
    assert.equal(submissionState(asg({ sub: { missing: true } })), 'missing');
    assert.equal(submissionState(asg({ sub: { workflow_state: 'submitted' } })), 'submitted');
    assert.equal(submissionState(asg({ sub: { submitted_at: 'x' } })), 'submitted');
    assert.equal(submissionState(asg()), 'pending');
  });
});

describe('parseDropRule — the phrasings that actually appear in the corpus', () => {
  it('BUSI 396: "Lowest two scores dropped"', () => {
    assert.deepEqual(parseDropRule('Lowest two scores dropped. Requirements-based grading.'),
      { drop: 2, keep: null, source: 'dropped' });
  });
  it('BUSI 396: "Lowest quiz score dropped" means one', () => {
    assert.equal(parseDropRule('Lowest quiz score dropped.').drop, 1);
  });
  it('BUSI 305: "Two lowest grades dropped"', () => {
    assert.equal(parseDropRule('Completed online via MBC. Two lowest grades dropped.').drop, 2);
  });
  it('ECON 205: "highest 5 scores used" is a keep-rule', () => {
    assert.deepEqual(parseDropRule('6 problem sets total; highest 5 scores used.'),
      { drop: null, keep: 5, source: 'keep' });
  });
  it('refuses prose that states no rule', () => {
    assert.equal(parseDropRule('Closed book and closed notes. Held on a Wednesday.'), null);
    assert.equal(parseDropRule(''), null);
    assert.equal(parseDropRule(null), null);
  });
  it('reads Canvas\'s own structured rule', () => {
    assert.deepEqual(groupDropRule({ rules: { drop_lowest: 3 } }), { drop: 3, keep: null, source: 'canvas' });
    assert.equal(groupDropRule({ rules: {} }), null);
  });
});

describe('matchComponents', () => {
  it('normalises parentheticals and punctuation away', () => {
    assert.equal(normaliseName('Diverge Artifacts (Group)'), 'diverge artifacts');
    assert.equal(normaliseName('Concept Check Quizzes-(Individual)'), 'concept check quizzes');
  });
  it('BUSI 396 matches 1:1 — the one class that does', () => {
    const m = matchComponents(
      [{ name: 'Practice Portfolio', weight_pct: 40 }, { name: 'Quizzes', weight_pct: 15 },
       { name: 'Major Projects', weight_pct: 45 }],
      [{ id: '1', name: 'Quizzes' }, { id: '2', name: 'Practice Portfolio' }, { id: '3', name: 'Major Projects' }],
    );
    assert.equal(m.complete, true);
    assert.equal(m.pairs.length, 3);
  });
  it('folds singular against plural (Homework / Homeworks)', () => {
    const m = matchComponents([{ name: 'Homework' }], [{ id: '1', name: 'Homeworks' }]);
    assert.equal(m.pairs.length, 1);
  });
  it('BUSI 380: refuses the containment match that would swallow 65% of the grade', () => {
    // "Case Knowledge Online Quizzes" is 24% of the syllabus. The Canvas group
    // "Case Knowledge and Quiz Assignments" also holds the midterm and final
    // case, worth 65% between them. A containment match here misreports the
    // grade by more than a letter.
    const m = matchComponents(
      [{ name: 'Case Knowledge Online Quizzes', weight_pct: 24 },
       { name: 'Midterm Case Assignment', weight_pct: 20 },
       { name: 'Final Case Assignment', weight_pct: 45 }],
      [{ id: '1', name: 'Case Knowledge and Quiz Assignments' }],
    );
    assert.equal(m.complete, false);
    assert.equal(m.pairs.length, 0);
    assert.equal(m.unmatchedComponents.length, 3);
  });
  it('reports an unmatched component rather than dropping it', () => {
    const m = matchComponents([{ name: 'Exam #1' }, { name: 'Homework' }], [{ id: '1', name: 'Homeworks' }]);
    assert.equal(m.complete, false);
    assert.deepEqual(m.unmatchedComponents, ['Exam #1']);
  });
});

describe('resolveScheme', () => {
  const comps = { grading: { components: [{ name: 'Quizzes', weight_pct: 40 }, { name: 'Exams', weight_pct: 60 }] } };
  const grps = [{ id: '1', name: 'Quizzes', group_weight: 0 }, { id: '2', name: 'Exams', group_weight: 0 }];

  it('Canvas wins outright when it says it is weighting', () => {
    const s = resolveScheme({ metadata: { apply_assignment_group_weights: true },
      groups: [{ id: '1', name: 'Q', group_weight: 30 }, { id: '2', name: 'E', group_weight: 70 }],
      syllabusParsed: comps });
    assert.equal(s.source, 'canvas');
    assert.equal(s.assumed, false);
    assert.equal(s.weightSum, 100);
  });
  it('ENTR 222 shape: flag not pulled, weights total 99 — assume weighting, and say so', () => {
    const s = resolveScheme({ metadata: {},
      groups: [{ id: '1', name: 'Q', group_weight: 9 }, { id: '2', name: 'E', group_weight: 90 }],
      syllabusParsed: null });
    assert.equal(s.source, 'canvas');
    assert.equal(s.assumed, true);
  });
  it('falls to the syllabus only when its components map completely', () => {
    const s = resolveScheme({ metadata: {}, groups: grps, syllabusParsed: comps });
    assert.equal(s.mode, 'weighted');
    assert.equal(s.source, 'syllabus');
    assert.deepEqual(s.buckets.map(b => b.weight), [40, 60]);
  });
  it('BUSI 305 shape: syllabus totals 100 but does not map — points, with a reason', () => {
    const s = resolveScheme({
      metadata: {}, groups: [{ id: '1', name: 'Homeworks', group_weight: 15 }],
      syllabusParsed: { grading: { components: [
        { name: 'Exam #1', weight_pct: 25 }, { name: 'Exam #2', weight_pct: 30 },
        { name: 'Exam #3', weight_pct: 30 }, { name: 'Homework', weight_pct: 10 },
        { name: 'Class participation', weight_pct: 5 }] } },
    });
    assert.equal(s.mode, 'points');
    assert.equal(s.refusals[0].reason, 'syllabus_unmapped');
    assert.match(s.refusals[0].detail, /Exam #1/);
  });
  it('refuses syllabus weights that do not total 100', () => {
    const s = resolveScheme({ metadata: {}, groups: grps,
      syllabusParsed: { grading: { components: [{ name: 'Quizzes', weight_pct: 40 }] } } });
    assert.equal(s.mode, 'points');
    assert.equal(s.refusals[0].reason, 'syllabus_weights_incomplete');
  });
  it('flags a course set to weight whose every weight is zero', () => {
    const s = resolveScheme({ metadata: { apply_assignment_group_weights: true }, groups: grps, syllabusParsed: null });
    assert.equal(s.refusals[0].reason, 'canvas_weighted_but_unset');
  });
});

describe('classGrades — the three numbers', () => {
  const weighted = {
    metadata: { apply_assignment_group_weights: true },
    groups: [{ id: '1', name: 'A', group_weight: 60 }, { id: '2', name: 'B', group_weight: 40 }],
    assignments: [graded(50, 45, '1'), asg({ pts: 100, group: '2' })],
  };

  it('current ignores ungraded work and renormalises over the weights that have any', () => {
    assert.equal(classGrades(weighted).current, 90);   // 45/50 in A; B has nothing graded
  });
  it('floor scores every remaining point zero; ceiling scores them all', () => {
    const g = classGrades(weighted);
    assert.equal(g.floor, 54);            // 60*(45/50) + 40*0
    assert.equal(g.ceiling, 94);          // 60*(45/50) + 40*1
  });
  it('a fresh term yields no current at all rather than a made-up number', () => {
    const g = classGrades({ ...weighted, assignments: [asg({ pts: 50, group: '1' }), asg({ pts: 100, group: '2' })] });
    assert.equal(g.current, null);
    assert.equal(g.floor, 0);
    assert.equal(g.ceiling, 100);
  });
  it('points mode totals raw points', () => {
    const g = classGrades({ metadata: {}, groups: [{ id: '1', name: 'A', group_weight: 0 }],
      assignments: [graded(50, 45, '1'), asg({ pts: 100, group: '1' })] });
    assert.equal(g.scheme.mode, 'points');
    assert.equal(g.current, 90);
    assert.equal(g.floor, 30);            // 45/150
    assert.equal(g.ceiling, 96.67);       // 145/150
  });
  it('excused work leaves the grade untouched', () => {
    const g = classGrades({ metadata: {}, groups: [{ id: '1', name: 'A', group_weight: 0 }],
      assignments: [graded(10, 10, '1'), asg({ pts: 90, group: '1', sub: { excused: true } })] });
    assert.equal(g.current, 100);
    assert.equal(g.totals.possible, 10);
    assert.equal(g.excused, 1);
  });
  it('counts a hidden grade as hidden, not as zero', () => {
    const g = classGrades({ metadata: {}, groups: [{ id: '1', name: 'A', group_weight: 0 }],
      assignments: [graded(10, 10, '1'),
        asg({ pts: 10, group: '1', post_manually: true, sub: { workflow_state: 'graded' } })] });
    assert.equal(g.hidden, 1);
    assert.equal(g.current, 100);         // the hidden one is not folded in as a zero
    assert.equal(g.floor, 50);            // but it is still outstanding points
  });
  it('refuses to weight when work sits outside every weighted bucket', () => {
    const g = classGrades({ ...weighted, assignments: [...weighted.assignments, asg({ pts: 25, group: '9' })] });
    assert.ok(g.refusals.some(r => r.reason === 'unweighted_work'));
  });
});

describe('classGrades — drop rules', () => {
  const meta = { apply_assignment_group_weights: true };
  const grp = { id: '1', name: 'Quizzes', group_weight: 100, rules: { drop_lowest: 1 } };
  const syl = { grading: { components: [{ name: 'Quizzes', weight_pct: 100, notes: 'Lowest score dropped.' }] } };

  it('holds the drop back while any of the work is ungraded', () => {
    const g = classGrades({ metadata: meta, groups: [grp], syllabusParsed: syl,
      assignments: [graded(10, 10, '1'), graded(10, 4, '1'), asg({ pts: 10, group: '1' })] });
    assert.equal(g.buckets[0].dropsPending, 1);
    assert.equal(g.buckets[0].dropped, 0);
    assert.equal(g.current, 70);          // 14/20 — the 4 is NOT dropped yet
    assert.ok(g.refusals.some(r => r.reason === 'drops_pending'));
  });
  it('applies the drop once every item is graded', () => {
    const g = classGrades({ metadata: meta, groups: [grp], syllabusParsed: syl,
      assignments: [graded(10, 10, '1'), graded(10, 4, '1'), graded(10, 8, '1')] });
    assert.equal(g.buckets[0].dropped, 1);
    assert.equal(g.current, 90);          // 18/20 after the 4 falls away
  });
  it('never drops away the last remaining score', () => {
    const g = classGrades({ metadata: meta, groups: [{ ...grp, rules: { drop_lowest: 3 } }], syllabusParsed: syl,
      assignments: [graded(10, 6, '1')] });
    assert.equal(g.buckets[0].possible, 10);
    assert.equal(g.current, 60);
  });
});

describe('Canvas is the system of record', () => {
  // The syllabus supplies weights and nothing else. It can never introduce an
  // assignment, a due date or a score — where Canvas speaks, Canvas is truth,
  // and where Canvas is silent the engine stays silent too rather than filling
  // the gap from a document that describes a plan.
  const syl = { grading: { components: [
    { name: 'Quizzes', weight_pct: 50 }, { name: 'Exams', weight_pct: 50 } ] } };

  it('a syllabus component with no Canvas assignments contributes no work', () => {
    const g = classGrades({
      metadata: { apply_assignment_group_weights: true },
      groups: [{ id: '1', name: 'Quizzes', group_weight: 50 }, { id: '2', name: 'Exams', group_weight: 50 }],
      syllabusParsed: syl,
      assignments: [graded(10, 9, '1')],           // Canvas lists one quiz, no exam
    });
    assert.equal(g.counted, 1);
    assert.equal(g.totals.possible, 10);
    assert.equal(g.current, 90);                   // the empty Exams bucket does not dilute it
    assert.equal(g.items.length, 1);
  });

  it('every due date on an item comes from Canvas', () => {
    const a = asg({ pts: 10, group: '1' });
    a.due_at = '2026-10-28T05:00:00Z';
    a.submission.cached_due_date = '2026-10-28T05:00:00Z';
    const g = classGrades({ metadata: {}, groups: [{ id: '1', name: 'A', group_weight: 0 }], assignments: [a],
      syllabusParsed: { grading: { components: [] }, schedule: [{ due: '2026-10-26' }] } });
    assert.equal(g.items[0].due, '2026-10-28T05:00:00Z');
  });

  it('a score is only ever Canvas\'s score', () => {
    const g = classGrades({ metadata: {}, groups: [{ id: '1', name: 'A', group_weight: 0 }],
      syllabusParsed: syl, assignments: [asg({ pts: 10, group: '1' })] });
    assert.equal(g.items[0].score, null);
    assert.equal(g.current, null);
  });
});
