import { readFile, mkdir, stat, readdir, copyFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiInvoke, readJsonSafe, atomicWriteJson, atomicWriteText } from './_util.js';
import { canvasItemUrl, canvasSubmitUrl } from '../canvas-links.js';
import { tasksForClass } from '../canvas-tasks.js';

// OPEN: CLAUDE_SKIP=1 bypasses the external claude CLI call for the "Open
// questions / ambiguities" section. In skip mode the script uses a deterministic
// fallback generator. Set this env var in test environments.

const __dirname = dirname(fileURLToPath(import.meta.url));

import { buildGradingSection } from './grading-section.js';

function fmtDate(iso) {
  if (!iso) return 'No due date';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function sortAssignments(assignments) {
  return [...assignments].sort((a, b) => {
    if (!a.due_at && !b.due_at) return 0;
    if (!a.due_at) return 1;
    if (!b.due_at) return -1;
    return new Date(a.due_at) - new Date(b.due_at);
  });
}

function partitionAssignments(assignments) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const upcoming = [];
  const recentPast = [];
  const olderPast = [];

  for (const a of assignments) {
    if (!a.due_at) {
      upcoming.push(a);
      continue;
    }
    const d = new Date(a.due_at);
    if (isNaN(d) || d >= now) {
      upcoming.push(a);
    } else if (d >= thirtyDaysAgo) {
      recentPast.push(a);
    } else {
      olderPast.push(a);
    }
  }
  return { upcoming, recentPast, olderPast };
}

function getWeight(a) {
  if (a.assignment_group && typeof a.assignment_group === 'object' && a.assignment_group.group_weight != null) {
    return a.assignment_group.group_weight + '%';
  }
  return null;
}

function renderAssignmentFull(a) {
  const lines = [];
  lines.push(`**${a.name || 'Untitled'}**`);
  lines.push(`- Due: ${fmtDate(a.due_at)}`);
  if (a.submission_types) {
    const types = Array.isArray(a.submission_types) ? a.submission_types.join(', ') : a.submission_types;
    lines.push(`- Submission: ${types}`);
  }
  if (a.points_possible != null) lines.push(`- Points: ${a.points_possible}`);
  const w = getWeight(a);
  if (w) lines.push(`- Weight: ${w}`);
  // Through canvasItemUrl: a quiz-backed assignment's html_url is the teacher's
  // view, and a student following it is denied. These lines end up in
  // AI_CONTEXT/, which is what the assistant quotes back at the user.
  const link = canvasItemUrl(a);
  if (link) lines.push(`- Link: ${link}`);
  const submit = canvasSubmitUrl(a);
  if (submit && submit !== link) lines.push(`- Submit: ${submit}`);
  if (a.description && a.description.trim()) {
    lines.push(`- Description: ${a.description.trim()}`);
  }
  if (a.submission) {
    const sub = a.submission;
    if (sub.grade != null) lines.push(`- Grade: ${sub.grade}`);
    if (sub.submitted_at) lines.push(`- Submitted: ${fmtDate(sub.submitted_at)}`);
  }
  return lines.join('\n');
}

function renderAssignmentCondensed(a) {
  const grade = a.submission && a.submission.grade != null ? ` | Grade: ${a.submission.grade}` : '';
  return `- ${a.name || 'Untitled'} (${fmtDate(a.due_at)})${grade}`;
}

function typeLabelForEntry(entry) {
  const name = (entry.filename || entry.displayName || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const ct = (entry.contentType || '').toLowerCase();

  if (ext === 'pptx' || ct.includes('presentationml')) return 'PPTX';
  if (ext === 'docx' || ct.includes('wordprocessingml')) return 'DOCX';
  if (ext === 'xlsx' || ct.includes('spreadsheetml')) return 'XLSX';
  if (ext === 'pdf'  || ct === 'application/pdf') return 'PDF';
  if (ext === 'md') return 'MD';
  if (ext === 'txt' || ct === 'text/plain') return 'TXT';
  if (ext === 'html' || ext === 'htm' || ct.includes('html')) return 'HTML';
  if (['png','jpg','jpeg','gif'].includes(ext) || ct.startsWith('image/')) return 'IMG';
  return (ext || 'FILE').toUpperCase();
}

function renderMaterialsBullet(entry) {
  const name = entry.displayName || entry.filename || 'Untitled';
  const baseName = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  const label = typeLabelForEntry(entry);

  let qty = '';
  if (entry.slideCount != null) qty = ` (${entry.slideCount} slide${entry.slideCount === 1 ? '' : 's'})`;
  else if (entry.pageCount != null) qty = ` (${entry.pageCount} page${entry.pageCount === 1 ? '' : 's'})`;
  else if (entry.sheetCount != null) qty = ` (${entry.sheetCount} sheet${entry.sheetCount === 1 ? '' : 's'})`;

  const uploaded = entry.canvasUpdatedAt ? ` — uploaded ${entry.canvasUpdatedAt.slice(0, 10)}` : '';
  const ocrTag = label === 'IMG' || entry.lowConfidence ? ' *(OCR, low confidence)*' : '';
  return `- [${label}] ${baseName}${qty}${ocrTag}${uploaded}`;
}

function buildMaterialsSection(filesIndex) {
  const entries = (filesIndex || [])
    .filter(e => e && e.extractionStatus === 'done' && e.duplicateOf == null && e.supersededBy == null)
    .sort((a, b) => {
      const da = a.canvasUpdatedAt ? Date.parse(a.canvasUpdatedAt) : 0;
      const db = b.canvasUpdatedAt ? Date.parse(b.canvasUpdatedAt) : 0;
      return da - db;
    });

  let md = `## Course materials\n\n`;
  if (entries.length === 0) {
    md += '_No extracted materials yet._\n\n';
    return { md, entries: [] };
  }
  md += 'Full extracted text: `materials/_combined.txt` (split into `_combined-NN.txt` if large).\n\n';
  for (const e of entries) {
    md += renderMaterialsBullet(e) + '\n';
  }
  md += '\n';
  return { md, entries };
}

function materialsSummaryJson(entries) {
  return entries.map(e => ({
    canvas_id: e.canvasId ?? null,
    display_name: e.displayName || e.filename || null,
    type: typeLabelForEntry(e),
    page_count: e.pageCount ?? null,
    slide_count: e.slideCount ?? null,
    sheet_count: e.sheetCount ?? null,
    canvas_updated_at: e.canvasUpdatedAt || null,
    materials_path: e.materialsPath || null,
    low_confidence: e.lowConfidence === true || null,
  }));
}

// --- Mined task list rendering ---------------------------------------------
// assignments_mined.json is produced by mine-assignments.js: the exhaustive
// cross-referenced task list (Canvas + implicit work found in slides, pages,
// announcements). These renderers organize it by urgency and attach the
// relevance-ordered material references per item.

function partitionMined(items, now = new Date()) {
  // LOCAL date, not a UTC slice — during local evening hours the UTC date is
  // already tomorrow, which would file items due today under "Past".
  const p = n => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const upcoming = [];
  const recurring = [];
  const undated = [];
  const past = [];
  for (const it of items || []) {
    if (it.recurring) recurring.push(it);
    else if (!it.due_date) undated.push(it);
    else if (it.due_date >= today) upcoming.push(it);
    else past.push(it);
  }
  const byDate = (a, b) => String(a.due_date).localeCompare(String(b.due_date));
  upcoming.sort(byDate);
  past.sort((a, b) => byDate(b, a));
  return { upcoming, recurring, undated, past };
}

function renderMinedItem(it, canvasById, { condensed = false } = {}) {
  const lines = [];
  const due = it.due_date
    ? `${it.due_date}${it.due_time ? ' ' + it.due_time : ''}${it.due_confidence !== 'high' ? ` (${it.due_confidence} confidence)` : ''}`
    : (it.recurring ? `recurring: ${it.recurring}` : 'no date found');
  if (condensed) {
    return `- **${it.title}** [${it.category}] — ${due}`;
  }
  lines.push(`### ${it.title}`);
  const meta = [`Category: ${it.category}`, `Due: ${due}`];
  if (it.points_possible != null) meta.push(`Points: ${it.points_possible}`);
  if (it.weight_note) meta.push(`Weight: ${it.weight_note}`);
  // `origin` is the merge's provenance verdict and outranks the miner's own
  // `kind` claim; Canvas extras the miner never saw carry origin only.
  const backedByCanvas = it.origin ? it.origin === 'canvas' : it.kind === 'canvas';
  meta.push(backedByCanvas ? `Canvas assignment${it.canvas_assignment_id ? ` ${it.canvas_assignment_id}` : ''}` : 'Implicit (not a Canvas assignment)');
  lines.push(`_${meta.join(' · ')}_`);
  if (it.description) lines.push(`\n${it.description}`);

  const canvas = it.canvas_assignment_id != null ? canvasById.get(String(it.canvas_assignment_id)) : null;
  if (canvas) {
    const extras = [];
    const canvasLink = canvasItemUrl(canvas);
    if (canvasLink) extras.push(`[Canvas link](${canvasLink})`);
    if (canvas.submission_types) {
      const t = Array.isArray(canvas.submission_types) ? canvas.submission_types.join(', ') : canvas.submission_types;
      extras.push(`submit via: ${t}`);
    }
    if (canvas.submission?.grade != null) extras.push(`grade: ${canvas.submission.grade}`);
    if (extras.length) lines.push(`\n${extras.join(' · ')}`);
  }

  if (Array.isArray(it.sources) && it.sources.length > 0) {
    lines.push(`\n**Evidence:** ${it.sources.map(s => `${s.type} — ${s.ref}`).join('; ')}`);
  }
  if (Array.isArray(it.related_materials) && it.related_materials.length > 0) {
    lines.push('\n**Most relevant materials (in order):**');
    for (const m of it.related_materials) {
      lines.push(`- ${m.file}${m.why ? ` — ${m.why}` : ''}`);
    }
  }
  return lines.join('\n');
}

function buildMinedSection(mined, assignments, mergedItems) {
  let md = `## Complete task list (Canvas + implicit work mined from materials)\n\n`;
  if (!mined || !Array.isArray(mined.items) || mined.items.length === 0) {
    md += '_Assignment mining has not run yet — see the Canvas assignment list below._\n\n';
    return md;
  }
  const canvasById = new Map((assignments || []).map(a => [String(a.id), a]));
  // Through tasksForClass (invariant: ONE merge point). Rendering mined.items
  // raw printed the miner's own due_date even when a live Canvas row corrects
  // it — so this headline section told the assistant a deadline two days
  // after the assignment actually closed — and omitted every dated Canvas row
  // mining never claimed.
  const { upcoming, recurring, undated, past } = partitionMined(mergedItems);

  md += `_Mined ${mined.items.length} items (${mined.items.filter(i => i.kind === 'implicit').length} implicit) on ${String(mined.mined_at || '').slice(0, 10)}, merged with the Canvas assignment list — Canvas owns every deadline it has. Implicit items were found in slides, pages, announcements, or the syllabus — they do NOT appear as Canvas assignments._\n\n`;

  md += `### Upcoming\n\n`;
  md += upcoming.length ? upcoming.map(i => renderMinedItem(i, canvasById)).join('\n\n') + '\n\n' : '_None._\n\n';

  md += `### Recurring obligations\n\n`;
  md += recurring.length ? recurring.map(i => renderMinedItem(i, canvasById)).join('\n\n') + '\n\n' : '_None._\n\n';

  md += `### No date found (verify manually)\n\n`;
  md += undated.length ? undated.map(i => renderMinedItem(i, canvasById)).join('\n\n') + '\n\n' : '_None._\n\n';

  md += `### Past\n\n`;
  md += past.length ? past.map(i => renderMinedItem(i, canvasById, { condensed: true })).join('\n') + '\n\n' : '_None._\n\n';

  if (mined.notes) {
    md += `**Miner notes:** ${mined.notes}\n\n`;
  }
  return md;
}

function deterministic_ambiguities(syllabusParsed, assignments) {
  const lines = [];

  if (!syllabusParsed) {
    lines.push('- No `syllabus_parsed.json` found — syllabus has not been parsed yet.');
    return lines.join('\n');
  }

  if (syllabusParsed.extraction_confidence === 'low' || syllabusParsed.extraction_confidence === 'medium') {
    lines.push(`- Syllabus extraction confidence is **${syllabusParsed.extraction_confidence}**. Verify extracted data manually.`);
  }

  if (syllabusParsed.extraction_notes && syllabusParsed.extraction_notes.trim()) {
    lines.push(`- Parser notes: ${syllabusParsed.extraction_notes.trim()}`);
  }

  const syllabusItems = Array.isArray(syllabusParsed.schedule) ? syllabusParsed.schedule : [];
  const dueSyllabusItems = syllabusItems.filter(i => i.due);
  const assignmentNames = new Set((assignments || []).map(a => (a.name || '').toLowerCase().trim()));
  for (const item of dueSyllabusItems) {
    const title = (item.title || '').toLowerCase().trim();
    if (!assignmentNames.has(title) && title) {
      lines.push(`- Syllabus lists "${item.title}" as a due item but no matching Canvas assignment found.`);
    }
  }

  const dateCounts = {};
  for (const a of assignments || []) {
    if (a.due_at) {
      const d = a.due_at.slice(0, 10);
      dateCounts[d] = (dateCounts[d] || 0) + 1;
    }
  }
  for (const [d, count] of Object.entries(dateCounts)) {
    if (count > 1) {
      lines.push(`- ${count} assignments share the same due date (${d}) — confirm scheduling.`);
    }
  }

  if (!syllabusParsed.grading || !Array.isArray(syllabusParsed.grading.components) || syllabusParsed.grading.components.length === 0) {
    lines.push('- No grading breakdown found in syllabus.');
  }

  if (!syllabusParsed.grading || !syllabusParsed.grading.late_policy) {
    lines.push('- No late work policy found in syllabus.');
  }

  if (!syllabusParsed.course || !syllabusParsed.course.instructor || !syllabusParsed.course.instructor.email) {
    lines.push('- Instructor email not found in syllabus.');
  }

  if (lines.length === 0) {
    lines.push('- No discrepancies or ambiguities detected.');
  }

  return lines.join('\n');
}

async function getAmbiguities(syllabusParsed, assignments, classDir) {
  if (process.env.CLAUDE_SKIP === '1') {
    return deterministic_ambiguities(syllabusParsed, assignments);
  }

  try {
    const promptTemplate = await readFile(join(__dirname, 'prompts', 'context-builder.md'), 'utf8');
    const syllabusStr = JSON.stringify(syllabusParsed || {}, null, 2);
    const assignmentsSummary = (assignments || []).map(a => ({
      name: a.name,
      due_at: a.due_at,
      points_possible: a.points_possible,
      submission_types: a.submission_types
    }));
    const assignmentsStr = JSON.stringify(assignmentsSummary, null, 2);

    const prompt = promptTemplate
      .replace('<SYLLABUS_PARSED>', () => syllabusStr)
      .replace('<ASSIGNMENTS_SUMMARY>', () => assignmentsStr);

    const result = await aiInvoke(prompt, { timeoutMs: 60000 });
    if (result && result.trim()) return result.trim();
  } catch (err) {
    process.stderr.write(`Claude ambiguities call failed: ${err.message}\n`);
  }

  return deterministic_ambiguities(syllabusParsed, assignments);
}

async function main() {
  const classDir = process.argv[2];
  if (!classDir) {
    process.stderr.write('Usage: node build-context.js <classDir>\n');
    process.exit(1);
  }

  const absClassDir = resolve(classDir);
  process.stderr.write(`Building context for: ${absClassDir}\n`);

  const metadata = await readJsonSafe(join(absClassDir, 'metadata.json')) || {};
  const assignments = await readJsonSafe(join(absClassDir, 'assignments.json')) || [];
  const modules = await readJsonSafe(join(absClassDir, 'modules.json')) || [];
  const announcements = await readJsonSafe(join(absClassDir, 'announcements.json')) || [];
  const pages = await readJsonSafe(join(absClassDir, 'pages.json')) || [];
  const quizzes = await readJsonSafe(join(absClassDir, 'quizzes.json')) || [];
  const filesIndex = await readJsonSafe(join(absClassDir, 'files_index.json')) || [];
  const syllabusParsed = await readJsonSafe(join(absClassDir, 'syllabus_parsed.json'));
  const assignmentGroups = await readJsonSafe(join(absClassDir, 'assignment_groups.json')) || [];
  const discussions = await readJsonSafe(join(absClassDir, 'discussions.json')) || [];
  const calendarEvents = await readJsonSafe(join(absClassDir, 'calendar_events.json')) || [];
  const mined = await readJsonSafe(join(absClassDir, 'assignments_mined.json'));
  const gradesData = await readJsonSafe(join(absClassDir, 'grades.json')) || [];
  const tabsData = await readJsonSafe(join(absClassDir, 'tabs.json')) || [];
  const coursePacks = await readJsonSafe(join(absClassDir, 'course_packs.json')) || [];

  // The one sanctioned mined+Canvas merge (canvas-tasks.js): Canvas owns the
  // deadlines, mining owns titles/descriptions, and unclaimed dated Canvas
  // rows join the list. Both context.md's task section and context.json's
  // mined_tasks render THIS, never mined.items raw.
  const { items: mergedTaskItems } = tasksForClass({ mined, assignments });

  // What actually sits on disk: extract writes _combined.txt, or, past 1 MB,
  // _combined-NN.txt parts and deletes the unsplit file — a hardcoded path
  // was a dead link for every materials-heavy class.
  let combinedFiles = [];
  try {
    combinedFiles = (await readdir(join(absClassDir, 'materials')))
      .filter(n => /^_combined(-\d+)?\.txt$/.test(n)).sort()
      .map(n => `materials/${n}`);
  } catch { /* no materials dir yet */ }

  const course = syllabusParsed && syllabusParsed.course ? syllabusParsed.course : {};
  const courseCode = course.code || metadata.course_code || metadata.course?.code || 'Unknown';
  const courseTitle = course.title || metadata.name || metadata.course?.name || 'Unknown Course';
  // term can arrive as a plain string (from the syllabus parse) or as a Canvas
  // enrollment_term OBJECT ({id, name, ...}) from either source — reduce to its
  // name, otherwise the header prints "[object Object]".
  const rawTerm = course.term || metadata.term || '';
  const term = typeof rawTerm === 'string' ? rawTerm : (rawTerm?.name || '');
  const instructor = course.instructor || {};
  const instructorName = instructor.name || metadata.instructor || '';
  const instructorEmail = instructor.email || '';
  const officeHours = instructor.office_hours || '';
  const meetingSchedule = course.meeting_schedule || '';
  const now = new Date();
  const nowIso = now.toISOString();

  const sortedAssignments = sortAssignments(assignments);
  const { upcoming, recentPast, olderPast } = partitionAssignments(sortedAssignments);

  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const recentAnnouncements = (announcements || []).filter(a => {
    if (!a.posted_at) return false;
    return new Date(a.posted_at) >= thirtyDaysAgo;
  });

  const grading = syllabusParsed && syllabusParsed.grading ? syllabusParsed.grading : {};
  const gradingComponents = grading.components || [];

  const syllabusSchedule = syllabusParsed && Array.isArray(syllabusParsed.schedule) ? syllabusParsed.schedule : [];
  const assignmentTitlesLower = new Set(sortedAssignments.map(a => (a.name || '').toLowerCase().trim()));
  const syllabusOnlyItems = syllabusSchedule.filter(item => {
    const title = (item.title || '').toLowerCase().trim();
    return title && !assignmentTitlesLower.has(title);
  });

  const policies = syllabusParsed && syllabusParsed.policies ? syllabusParsed.policies : {};

  const ambiguities = await getAmbiguities(syllabusParsed, assignments, absClassDir);

  let md = '';
  md += `# ${courseCode} — ${courseTitle}\n\n`;
  md += `**Last synced:** ${nowIso}\n`;
  if (term) md += `**Term:** ${term}\n`;
  if (instructorName) md += `**Instructor:** ${instructorName}${instructorEmail ? ` (${instructorEmail})` : ''}\n`;
  if (meetingSchedule) md += `**Meeting:** ${meetingSchedule}\n`;
  if (officeHours) md += `**Office hours:** ${officeHours}\n`;
  md += '\n';

  const selfEnrollment = gradesData.find(e => e && e.grades);
  if (selfEnrollment?.grades?.current_score != null) {
    const g = selfEnrollment.grades;
    md += `**Current grade:** ${g.current_grade ? g.current_grade + ' — ' : ''}${g.current_score}%`;
    if (g.final_score != null && g.final_score !== g.current_score) md += ` (final incl. ungraded: ${g.final_score}%)`;
    md += '\n\n';
  }

  md += buildGradingSection(assignmentGroups, grading, metadata);

  md += buildMinedSection(mined, assignments, mergedTaskItems);

  md += `## Full Canvas assignment list (sorted by due date)\n\n`;

  md += `### Upcoming\n\n`;
  if (upcoming.length > 0) {
    for (const a of upcoming) {
      md += renderAssignmentFull(a) + '\n\n';
    }
  } else {
    md += '_No upcoming assignments._\n\n';
  }

  md += `### Past (last 30 days)\n\n`;
  if (recentPast.length > 0) {
    for (const a of recentPast) {
      md += renderAssignmentFull(a) + '\n\n';
    }
  } else {
    md += '_None._\n\n';
  }

  md += `### Past (older)\n\n`;
  if (olderPast.length > 0) {
    for (const a of olderPast) {
      md += renderAssignmentCondensed(a) + '\n';
    }
    md += '\n';
  } else {
    md += '_None._\n\n';
  }

  md += `## Syllabus schedule (if differs from or adds to assignments)\n\n`;
  if (syllabusOnlyItems.length > 0) {
    for (const item of syllabusOnlyItems) {
      const tentative = item.tentative ? ' _(tentative)_' : '';
      const due = item.due ? ' **(due)**' : '';
      md += `- ${item.date ? item.date + ': ' : ''}${item.title}${due}${tentative}\n`;
      if (item.description) md += `  ${item.description}\n`;
    }
  } else {
    md += '_All syllabus items match Canvas assignments or no syllabus parsed._\n';
  }
  md += '\n';

  md += `## Course modules\n\n`;
  if (modules.length > 0) {
    for (const mod of modules) {
      md += `**${mod.name || 'Unnamed module'}**\n`;
      const items = mod.items || [];
      for (const item of items) {
        md += `- ${item.title || item.type || 'Item'}\n`;
      }
    }
  } else {
    md += '_No modules._\n';
  }
  md += '\n';

  const materialsSection = buildMaterialsSection(filesIndex);
  md += materialsSection.md;

  md += `## Recent announcements (last 30 days)\n\n`;
  if (recentAnnouncements.length > 0) {
    for (const a of recentAnnouncements) {
      md += `**${fmtDate(a.posted_at)}** — ${a.title || 'Untitled'}\n\n`;
      if (a.message) md += `${a.message}\n\n`;
    }
  } else {
    md += '_No recent announcements._\n\n';
  }

  md += `## Discussions\n\n`;
  if (discussions.length > 0) {
    for (const d of discussions) {
      const due = d.assignment?.due_at ? ` (graded, due ${fmtDate(d.assignment.due_at)})` : '';
      md += `- **${d.title || 'Untitled'}**${due}${d.posted_at ? ` — posted ${fmtDate(d.posted_at)}` : ''}\n`;
    }
    md += '\n';
  } else {
    md += '_No discussions._\n\n';
  }

  md += `## Course calendar events\n\n`;
  if (calendarEvents.length > 0) {
    for (const e of calendarEvents) {
      md += `- ${e.start_at ? fmtDate(e.start_at) + ': ' : ''}${e.title || 'Untitled'}\n`;
    }
    md += '\n';
  } else {
    md += '_No course calendar events._\n\n';
  }

  // The course pack, when the extension recognised one: readings live there,
  // on the provider's site (HBP, Study.Net, …). Its content cannot be synced —
  // say so and link it, so an assignment naming a case is traceable to where
  // the case actually is.
  if (coursePacks.length > 0) {
    md += `## Course pack (readings live here — content NOT synced)\n\n`;
    for (const p of coursePacks) {
      const provider = p.provider_domain || p.provider_url || null;
      md += `- **${p.label || p.name || 'Course Pack'}**${provider ? ` — provider: ${provider}` : ''}${p.launch_url ? ` — open via ${p.launch_url}` : ''}\n`;
      if (p.description) md += `  - ${String(p.description).replace(/\s+/g, ' ').trim()}\n`;
    }
    md += '\n';
  }

  // External tools visible in the course nav that live OUTSIDE Canvas's API
  // (Piazza, Panopto, Gradescope, publisher platforms…). The scraper cannot
  // reach their content — surface them so nothing is silently invisible.
  const externalTabs = tabsData.filter(t => t && (t.type === 'external' || /^context_external_tool/.test(String(t.id ?? ''))));
  if (externalTabs.length > 0) {
    md += `## External course tools (content NOT synced — check these manually)\n\n`;
    for (const t of externalTabs) {
      md += `- ${t.label || t.id}${t.full_url ? ` — ${t.full_url}` : ''}\n`;
    }
    md += '\n';
  }

  md += `## Policies\n\n`;
  md += `- **Attendance:** ${policies.attendance || '_Not specified._'}\n`;
  md += `- **Academic integrity:** ${policies.academic_integrity || '_Not specified._'}\n`;
  md += `- **Accommodations:** ${policies.accommodations || '_Not specified._'}\n`;
  if (Array.isArray(policies.other) && policies.other.length > 0) {
    for (const p of policies.other) {
      md += `- **Other:** ${p}\n`;
    }
  }
  md += '\n';

  md += `## Open questions / ambiguities\n\n`;
  md += ambiguities + '\n';

  const contextJson = {
    last_synced: nowIso,
    course: {
      code: courseCode,
      title: courseTitle,
      term,
      instructor: { name: instructorName, email: instructorEmail, office_hours: officeHours },
      meeting_schedule: meetingSchedule
    },
    grading: {
      components: gradingComponents,
      late_policy: grading.late_policy || null
    },
    assignments: {
      upcoming,
      recent_past: recentPast,
      older_past: olderPast
    },
    syllabus_only_schedule: syllabusOnlyItems,
    mined_tasks: mergedTaskItems,
    modules,
    course_materials: {
      combined_path: combinedFiles[0] ?? null,
      combined_paths: combinedFiles,
      items: materialsSummaryJson(materialsSection.entries),
    },
    recent_announcements: recentAnnouncements,
    discussions,
    calendar_events: calendarEvents,
    current_grade: selfEnrollment?.grades ?? null,
    external_tools: externalTabs.map(t => ({ label: t.label ?? null, url: t.full_url ?? null })),
    course_packs: coursePacks,
    policies,
    open_questions: ambiguities
  };

  const aiContextDir = join(absClassDir, 'AI_CONTEXT');
  await mkdir(aiContextDir, { recursive: true });

  await atomicWriteText(join(aiContextDir, 'context.md'), md);
  await atomicWriteJson(join(aiContextDir, 'context.json'), contextJson);

  // --- Uploadable pack -----------------------------------------------------
  // AI_CONTEXT/pack/ is a self-contained folder sized for a Claude project's
  // knowledge: overview doc, per-assignment deep-dive doc, and the full
  // extracted text of every course material. Drag the folder (or its files)
  // into a Claude project and any chat in it can answer questions about any
  // assignment without further setup.
  const packDir = join(aiContextDir, 'pack');
  await mkdir(packDir, { recursive: true });

  const canvasById = new Map(sortedAssignments.map(a => [String(a.id), a]));
  let assignDoc = `# ${courseCode} — Assignment guide\n\n`;
  assignDoc += `_Generated ${nowIso}. Every task below includes its evidence and the course materials most relevant to completing it. Implicit items were mined from slides/pages/announcements and do not exist as Canvas assignments._\n\n`;
  if (mined && Array.isArray(mined.items) && mined.items.length > 0) {
    const { upcoming, recurring, undated, past } = partitionMined(mined.items);
    for (const [label, group] of [['Upcoming', upcoming], ['Recurring obligations', recurring], ['No date found', undated], ['Past', past]]) {
      assignDoc += `## ${label}\n\n`;
      assignDoc += group.length
        ? group.map(i => renderMinedItem(i, canvasById)).join('\n\n---\n\n') + '\n\n'
        : '_None._\n\n';
    }
    if (mined.notes) assignDoc += `**Miner notes:** ${mined.notes}\n`;
  } else {
    assignDoc += '_Assignment mining has not run yet — refer to the assignment list in the course overview._\n';
  }

  await atomicWriteText(join(packDir, '01-course-overview.md'), md);
  await atomicWriteText(join(packDir, '02-assignments.md'), assignDoc);

  // Copy extracted materials text into the pack so it's self-contained.
  // Prune existing materials-NN.txt first: if the combined set shrank since
  // the last build, stale parts would otherwise survive in the pack with
  // outdated content while README says "upload every file in this folder".
  const materialsDir = join(absClassDir, 'materials');
  const packedMaterials = [];
  try {
    for (const old of (await readdir(packDir)).filter(n => /^materials-\d+\.txt$/.test(n))) {
      try { await unlink(join(packDir, old)); } catch { /* best-effort */ }
    }
  } catch { /* pack dir freshly created */ }
  try {
    const entries = (await readdir(materialsDir)).filter(n => /^_combined(-\d+)?\.txt$/.test(n)).sort();
    let n = 0;
    for (const name of entries) {
      n++;
      const dest = `materials-${String(n).padStart(2, '0')}.txt`;
      await copyFile(join(materialsDir, name), join(packDir, dest));
      packedMaterials.push(dest);
    }
  } catch { /* no materials yet */ }

  const readme = [
    `# ${courseCode} — AI context pack`,
    '',
    `Generated ${nowIso} by canvas-sync. Upload every file in this folder to a`,
    'Claude project (Project knowledge) — then ask about any assignment in the class.',
    '',
    '- `01-course-overview.md` — course info, grading, complete task list, schedule, modules, policies, announcements',
    '- `02-assignments.md` — every assignment (incl. implicit work mined from slides/pages) with the most relevant materials per assignment',
    ...(packedMaterials.length
      ? [`- ${packedMaterials.map(m => `\`${m}\``).join(', ')} — full extracted text of all course files (slides, readings, handouts)`]
      : ['- (no extracted course materials yet)']),
    '',
    'Not in this pack (Canvas does not expose them to a student session): quiz',
    'question content, material inside external tools (Piazza, Panopto, Gradescope',
    '— see "External course tools" in the overview), and files/discussions inside',
    'student group spaces. Check those in Canvas directly.',
  ].join('\n') + '\n';
  await atomicWriteText(join(packDir, 'README.md'), readme);

  await atomicWriteText(join(aiContextDir, 'last_built.txt'), nowIso);

  process.stderr.write(`Written: ${aiContextDir}/context.md, context.json, pack/ (${2 + packedMaterials.length + 1} files)\n`);
  process.exit(0);
}

main();
