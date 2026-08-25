/**
 * grading-section.js — the "Grading breakdown" table in a class's context.md.
 *
 * Lives apart from build-context.js because build-context.js runs main() on
 * import and cannot be loaded by a test. This function had a real wrong answer
 * in it (see below) and no test could reach it; now one can.
 */

// Grading table.
//
// This used to let ANY non-zero Canvas group weight replace the syllabus's
// components outright, under the heading "(authoritative)". On BUSI 305 that
// printed a single row — Homeworks, 15% — as the whole grading scheme, while
// suppressing the five syllabus components that sum to 100 and while Canvas's
// own apply_assignment_group_weights is false. A reader, and the AI context
// built from this file, would conclude the course is 15% homework and nothing
// else. Canvas group weights are only authoritative when Canvas says it is
// using them; otherwise they are a partial gradebook setting, and the syllabus
// is the stated scheme. Where both exist, print both rather than choosing.
export function buildGradingSection(assignmentGroups, grading, metadata) {
  const applyWeights = metadata ? metadata.apply_assignment_group_weights : undefined;
  const groupRows = (assignmentGroups || [])
    .filter(g => g && g.group_weight != null && g.group_weight > 0)
    .map(g => {
      const n = (g.assignments || []).length;
      return { name: g.name, weight_pct: g.group_weight, notes: `${n} ${n === 1 ? 'assignment' : 'assignments'}` };
    });
  const components = grading.components || [];
  const groupSum = groupRows.reduce((n, g) => n + g.weight_pct, 0);
  // Canvas is authoritative only when it says it weights by group. An unset
  // flag (data synced before the field was stored) is not a yes, but weights
  // that nearly total 100 are strong enough evidence to lead with.
  const canvasLeads = groupRows.length > 0
    && (applyWeights === true || (applyWeights == null && groupSum >= 95));

  const table = rows => `| Component | Weight | Notes |\n|---|---|---|\n`
    + rows.map(c => `| ${c.name || ''} | ${c.weight_pct != null ? c.weight_pct + '%' : ''} | ${c.notes || ''} |\n`).join('');

  let md = `## Grading breakdown\n\n`;
  if (canvasLeads) {
    md += `_From Canvas assignment groups — Canvas weights this course by group._\n\n`;
    md += table(groupRows);
    if (components.length) md += `\n_The syllabus states:_\n\n` + table(components);
  } else if (components.length) {
    md += `_From the syllabus._\n\n` + table(components);
    if (groupRows.length) {
      md += `\n_Canvas assignment groups carry weights totalling ${groupSum}%`
        + `${applyWeights === false ? ', but Canvas totals this course by points' : ''}:_\n\n`
        + table(groupRows);
    }
  } else if (groupRows.length) {
    md += `_From Canvas assignment groups (weights total ${groupSum}%`
      + `${applyWeights === false ? '; Canvas totals this course by points' : ''})._\n\n`;
    md += table(groupRows);
  } else {
    md += '_No grading breakdown available._\n';
  }
  if (grading.late_policy) md += `\n**Late policy:** ${grading.late_policy}\n`;
  md += '\n';
  return md;
}
