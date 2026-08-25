import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGradingSection } from '../grading-section.js';

const SYLLABUS = { components: [
  { name: 'Exam #1', weight_pct: 25 }, { name: 'Exam #2', weight_pct: 30 },
  { name: 'Exam #3', weight_pct: 30 }, { name: 'Homework', weight_pct: 10 },
  { name: 'Class participation', weight_pct: 5 },
] };

describe('buildGradingSection', () => {
  it('BUSI 305: a lone 15% Canvas group must not replace a syllabus totalling 100', () => {
    // The bug this function shipped with: any non-zero group weight replaced the
    // syllabus outright and was labelled authoritative, so the course read as
    // "15% Homeworks" and nothing else — with 85% of the real grade suppressed.
    const md = buildGradingSection(
      [{ id: '1', name: 'Homeworks', group_weight: 15, assignments: [{}] }],
      SYLLABUS,
      { apply_assignment_group_weights: false },
    );
    assert.match(md, /_From the syllabus\._/);
    assert.doesNotMatch(md, /authoritative/);
    for (const c of SYLLABUS.components) assert.ok(md.includes(c.name), `${c.name} missing`);
    // Canvas's setting is not hidden — a disagreement is information.
    assert.match(md, /totalling 15%/);
    assert.match(md, /Canvas totals this course by points/);
  });

  it('ENTR 222: Canvas leads when Canvas says it weights by group', () => {
    const md = buildGradingSection(
      [{ id: '1', name: 'Quizzes', group_weight: 9, assignments: [{}, {}] },
       { id: '2', name: 'Final Presentation', group_weight: 90, assignments: [{}] }],
      SYLLABUS,
      { apply_assignment_group_weights: true },
    );
    assert.match(md, /Canvas weights this course by group/);
    assert.match(md, /_The syllabus states:_/);   // both are shown, neither suppressed
    assert.ok(md.indexOf('Quizzes') < md.indexOf('Exam #1'), 'Canvas table should lead');
  });

  it('an unset flag with weights totalling ~100 still leads with Canvas', () => {
    const md = buildGradingSection(
      [{ id: '1', name: 'A', group_weight: 40, assignments: [] },
       { id: '2', name: 'B', group_weight: 60, assignments: [] }],
      SYLLABUS, {},
    );
    assert.match(md, /Canvas weights this course by group/);
  });

  it('an unset flag with partial weights does NOT lead with Canvas', () => {
    const md = buildGradingSection(
      [{ id: '1', name: 'A', group_weight: 20, assignments: [] }], SYLLABUS, {});
    assert.match(md, /_From the syllabus\._/);
  });

  it('falls back to Canvas groups when the syllabus states nothing', () => {
    const md = buildGradingSection(
      [{ id: '1', name: 'A', group_weight: 20, assignments: [] }], {}, { apply_assignment_group_weights: false });
    assert.match(md, /From Canvas assignment groups/);
    assert.match(md, /Canvas totals this course by points/);
  });

  it('says so plainly when there is nothing to show', () => {
    assert.match(buildGradingSection([], {}, {}), /No grading breakdown available/);
  });

  it('pluralises the assignment count', () => {
    const md = buildGradingSection(
      [{ id: '1', name: 'A', group_weight: 100, assignments: [{}] }], {}, { apply_assignment_group_weights: true });
    assert.match(md, /\| 1 assignment \|/);
  });

  it('carries the late policy through', () => {
    const md = buildGradingSection([], { components: [], late_policy: 'No late work.' }, {});
    assert.match(md, /\*\*Late policy:\*\* No late work\./);
  });
});
