// build-pack.test.js — the context pack v2 builder.
//
// The pack is read by a model, not a person, so the failures that matter are
// the quiet ones: a section that vanishes instead of saying it is missing, a
// material file on disk that 03-map.md never mentions (unreachable — the model
// is told to route through the map), a filename that changes between rebuilds
// so every citation in an old chat goes stale, and a set of documents too large
// to paste. Each test below pins one of those.
//
// Every test passes an explicit graphPath or graphModule: scripts/correlation-graph.js
// is owned by another module and may or may not exist on disk, and the suite
// must not change behaviour depending on which.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildPack, safeName } from '../build-pack.js';

const NOW = new Date('2026-09-15T12:00:00Z');
// A path that cannot resolve, so "the graph module is absent" is the default.
const NO_GRAPH = join(tmpdir(), 'build-pack-no-such-correlation-graph.js');

async function makeClass(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'build-pack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  }
  return dir;
}

function fileEntry(over = {}) {
  const displayName = over.displayName ?? 'Week 1 Slides.pptx';
  return {
    canvasId: '1001',
    displayName,
    filename: displayName,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 1234,
    canvasUpdatedAt: '2026-08-11T20:14:45Z',
    localPath: `files/${displayName}`,
    materialsPath: `materials/${displayName}.txt`,
    extractionStatus: 'done',
    duplicateOf: null,
    skipped: null,
    slideCount: 12,
    ...over,
  };
}

function quizAssignment(over = {}) {
  return {
    id: '5001',
    name: 'Concept Check 1',
    due_at: '2026-09-20T19:30:00Z',
    points_possible: 20,
    submission_types: ['online_quiz'],
    quiz_id: '9001',
    assignment_group_id: '77',
    html_url: 'https://canvas.example.edu/courses/93903/assignments/5001',
    description: '<p>Answer the questions.</p>',
    submission: { workflow_state: 'unsubmitted', grade: null, submitted_at: null, missing: false },
    ...over,
  };
}

async function readPack(dir, name) {
  return readFile(join(dir, name), 'utf8');
}

async function packBytesOnDisk(dir) {
  let total = 0;
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const child of await readdir(p)) total += (await stat(join(p, child))).size;
    } else {
      total += s.size;
    }
  }
  return total;
}

// --- safeName ---------------------------------------------------------------

test('safeName strips path separators so a Canvas title cannot escape the folder', () => {
  assert.equal(safeName('Week 1/2 notes'), 'week-1-2-notes');
  assert.equal(safeName('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeName('a\\b'), 'a-b');
  assert.ok(!safeName('Week 1/2 notes').includes('/'));
});

test('safeName folds unicode down to stable lowercase ASCII', () => {
  // macOS stores NFD and compares case-insensitively: an accented or
  // capitalised slug is not guaranteed to survive a write/readdir round trip.
  assert.equal(safeName('Wéék Ône — Résumé'), 'week-one-resume');
  assert.equal(safeName('课程 notes'), 'notes');
  assert.equal(safeName('Naïvé CAFÉ'), 'naive-cafe');
  assert.match(safeName('Ünïcödé'), /^[a-z0-9-]+$/);
});

test('safeName always yields a usable, non-reserved name', () => {
  assert.equal(safeName(''), 'file-x');
  assert.equal(safeName(null), 'file-x');
  assert.equal(safeName('!!!'), 'file-x');
  assert.equal(safeName('CON'), 'file-con');
  assert.equal(safeName('lpt1'), 'file-lpt1');
});

test('safeName caps length without leaving a trailing separator', () => {
  const long = safeName('A'.repeat(30) + ' ' + 'B'.repeat(90));
  assert.ok(long.length <= 60, long);
  assert.ok(!long.endsWith('-'), long);
});

// --- degrading on missing inputs -------------------------------------------

test('a class with nothing but metadata still produces all four documents', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { id: '93903', name: 'BUSI 380 002 F26', course_code: 'BUSI 380 002' },
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });

  assert.deepEqual(res.files, ['00-START-HERE.md', '01-course.md', '02-work.md', '03-map.md']);
  assert.ok(res.bytes > 0);
  assert.equal(res.dir, join(dir, 'AI_CONTEXT', 'pack2'));

  const course = await readPack(res.dir, '01-course.md');
  const work = await readPack(res.dir, '02-work.md');
  const map = await readPack(res.dir, '03-map.md');

  // Missing inputs must be stated, never silently omitted — an absent section
  // reads to a model as "the course has none of that".
  assert.match(course, /syllabus_parsed\.json` is missing/);
  assert.match(work, /assignments_mined\.json` is missing/);
  assert.match(map, /No course files have been extracted yet/);
  assert.match(map, /Not available: /);

  assert.ok(res.warnings.some(w => /syllabus_parsed\.json is missing/.test(w)));
  assert.ok(res.warnings.some(w => /assignments_mined\.json is missing/.test(w)));
  assert.ok(res.warnings.some(w => /Correlation graph unavailable/.test(w)));
});

test('a missing syllabus falls back to Canvas metadata rather than to "Unknown"', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { id: '93903', name: 'BUSI 380 002 F26', course_code: 'BUSI 380 002', term: { name: 'Fall Semester 2026' } },
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const course = await readPack(res.dir, '01-course.md');
  assert.match(course, /^# BUSI 380 — course/m);
  assert.match(course, /\| Term \| Fall Semester 2026 \|/);
  // A Canvas term arrives as an object; printing it raw gives "[object Object]".
  assert.ok(!course.includes('[object Object]'));
});

test('an unreadable extracted text file leaves a placeholder file, not a hole', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ extractionStatus: 'failed', materialsPath: 'materials/gone.txt' })],
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const body = await readPack(res.dir, 'materials/1001-week-1-slides.txt');
  assert.match(body, /No extracted text for this file \(extraction status: failed\)/);
  assert.ok(res.warnings.some(w => /no extracted text/.test(w)));
});

// --- filenames --------------------------------------------------------------

test('unicode and slash-heavy Canvas titles become safe, unique filenames', async (t) => {
  const names = [
    'Wéék 1/2 — “Notes” (final)/v2.pptx',
    'Wéék 1/2 — “Notes” (final)/v2.pptx',
    '../../escape.pdf',
    '课程大纲.pdf',
  ];
  const files = {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': names.map((displayName, i) => fileEntry({
      canvasId: String(2000 + i), displayName, materialsPath: `materials/m${i}.txt`,
    })),
  };
  for (let i = 0; i < names.length; i++) files[`materials/m${i}.txt`] = `text ${i}\n`;
  const dir = await makeClass(t, files);

  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const written = await readdir(join(res.dir, 'materials'));
  assert.equal(written.length, names.length);
  for (const name of written) {
    assert.match(name, /^[a-z0-9][a-z0-9.-]*\.txt$/, name);
    assert.ok(!name.includes('/') && !name.includes('\\') && !name.includes('..'), name);
  }
  // Two files with the identical display name still get one file each.
  assert.equal(new Set(written).size, names.length);
});

test('every materials file on disk is referenced from 03-map.md', async (t) => {
  const names = ['Slides A.pptx', 'Réading — 2.pdf', 'weird/name?.txt', 'CON.pdf'];
  const files = {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': names.map((displayName, i) => fileEntry({
      canvasId: String(3000 + i), displayName, materialsPath: `materials/m${i}.txt`,
    })),
  };
  for (let i = 0; i < names.length; i++) files[`materials/m${i}.txt`] = `body ${i}\n`;
  const dir = await makeClass(t, files);

  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const map = await readPack(res.dir, '03-map.md');
  const written = await readdir(join(res.dir, 'materials'));
  assert.equal(written.length, names.length);
  for (const name of written) {
    assert.ok(map.includes(`materials/${name}`), `03-map.md does not reference ${name}`);
  }
  // …and the returned file list agrees with the disk.
  for (const name of written) assert.ok(res.files.includes(`materials/${name}`));
});

test('duplicates and skipped files get a map row explaining why they have no text', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [
      fileEntry({ canvasId: '4001', displayName: 'Original.pdf', materialsPath: 'materials/a.txt' }),
      fileEntry({ canvasId: '4002', displayName: 'Copy.pdf', duplicateOf: '4001' }),
      fileEntry({ canvasId: '4003', displayName: 'Huge.zip', skipped: 'too large' }),
    ],
    'materials/a.txt': 'original text\n',
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const map = await readPack(res.dir, '03-map.md');
  assert.equal((await readdir(join(res.dir, 'materials'))).length, 1);
  assert.match(map, /Copy\.pdf — duplicate of Canvas file 4001/);
  assert.match(map, /Huge\.zip — not downloaded \(too large\)/);
});

test('a course file removed from Canvas is pruned from the pack on rebuild', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '5100', displayName: 'Kept.pdf', materialsPath: 'materials/k.txt' })],
    'materials/k.txt': 'kept\n',
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  // Simulate a previous build's file for a material Canvas no longer lists.
  await writeFile(join(res.dir, 'materials', '5199-stale.txt'), 'stale\n', 'utf8');

  const again = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const written = await readdir(join(again.dir, 'materials'));
  assert.deepEqual(written, ['5100-kept.txt']);
});

// --- stability --------------------------------------------------------------

test('two builds of unchanged data are byte-identical', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { id: '93903', course_code: 'BUSI 380 002' },
    'syllabus_parsed.json': {
      course: { code: 'BUSI 380', title: 'Marketing', term: 'Fall 2026', instructor: { name: 'C. Porter', email: 'cp@example.edu' } },
      grading: { components: [{ name: 'Quizzes', weight_pct: 24, notes: 'six of them' }], late_policy: 'None accepted.' },
      policies: { attendance: 'Required.' },
      extraction_confidence: 'high',
      extracted_at: '2026-08-24T09:56:00Z',
    },
    'assignments.json': [quizAssignment(), quizAssignment({ id: '5002', name: 'Concept Check 2', quiz_id: '9002', due_at: null })],
    'assignment_groups.json': [{ id: '77', name: 'Quizzes', group_weight: 24, assignments: [1, 2] }],
    'files_index.json': [
      fileEntry({ canvasId: '6001', displayName: 'B deck.pptx', materialsPath: 'materials/b.txt' }),
      fileEntry({ canvasId: '6002', displayName: 'A deck.pptx', materialsPath: 'materials/a.txt' }),
    ],
    'materials/a.txt': 'alpha text\n',
    'materials/b.txt': 'bravo text\n',
  });

  const first = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const snapshot = {};
  for (const name of first.files) snapshot[name] = await readPack(first.dir, name);

  const second = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  assert.deepEqual(second.files, first.files);
  assert.equal(second.bytes, first.bytes);
  for (const name of second.files) {
    assert.equal(await readPack(second.dir, name), snapshot[name], `${name} changed between rebuilds`);
  }
  // No wall-clock stamp anywhere: that is what makes the above true.
  for (const body of Object.values(snapshot)) {
    assert.ok(!/Generated \d{4}-\d{2}-\d{2}T/.test(body));
  }
});

test('material order — and therefore every filename — does not depend on files_index order', async (t) => {
  const entries = [
    fileEntry({ canvasId: '7001', displayName: 'Zulu.pdf', materialsPath: 'materials/z.txt' }),
    fileEntry({ canvasId: '7002', displayName: 'Alpha.pdf', materialsPath: 'materials/a.txt' }),
  ];
  const base = { 'metadata.json': { course_code: 'BUSI 380' }, 'materials/z.txt': 'z\n', 'materials/a.txt': 'a\n' };
  const forward = await makeClass(t, { ...base, 'files_index.json': entries });
  const reversed = await makeClass(t, { ...base, 'files_index.json': [...entries].reverse() });

  const a = await buildPack(forward, { now: NOW, graphPath: NO_GRAPH });
  const b = await buildPack(reversed, { now: NOW, graphPath: NO_GRAPH });
  assert.deepEqual(a.files, b.files);
  assert.equal(await readPack(a.dir, '03-map.md'), await readPack(b.dir, '03-map.md'));
});

test('the reported byte count matches what is on disk', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '8001', materialsPath: 'materials/x.txt' })],
    'materials/x.txt': 'some extracted slide text\n',
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  assert.equal(res.bytes, await packBytesOnDisk(res.dir));
});

// --- work items -------------------------------------------------------------

test('02-work.md links quiz-backed assignments to the page a student can open', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'assignments.json': [quizAssignment()],
    'quizzes.json': [
      { id: '9001', title: 'Concept Check 1', html_url: 'https://canvas.example.edu/courses/93903/quizzes/9001', assignment_id: '5001' },
      { id: '9500', title: 'Ungraded survey', html_url: 'https://canvas.example.edu/courses/93903/quizzes/9500', quiz_type: 'survey', due_at: null },
    ],
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const work = await readPack(res.dir, '02-work.md');

  // The teacher-only /assignments/ URL is what Canvas hands back; a student
  // following it gets Access Denied.
  assert.match(work, /Open: https:\/\/canvas\.example\.edu\/courses\/93903\/quizzes\/9001/);
  assert.ok(!work.includes('/assignments/5001'));
  // A quiz already backed by an assignment must not be listed twice…
  assert.equal((work.match(/### Concept Check 1/g) ?? []).length, 1);
  // …but a standalone quiz is real work and has to appear.
  assert.match(work, /### Ungraded survey/);
});

test('02-work.md reports status from the Canvas submission, and splits open from past due', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'assignments.json': [
      quizAssignment({ id: '1', name: 'Graded one', due_at: '2026-09-01T05:00:00Z', points_possible: 20, submission: { workflow_state: 'graded', grade: '18', submitted_at: '2026-08-31T22:00:00Z' } }),
      quizAssignment({ id: '2', name: 'Missed one', due_at: '2026-09-02T05:00:00Z', submission: { workflow_state: 'unsubmitted', grade: null, missing: true } }),
      quizAssignment({ id: '3', name: 'Still open', due_at: '2026-10-01T05:00:00Z', submission: null }),
      quizAssignment({ id: '4', name: 'Never due', due_at: null, submission: null }),
    ],
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const work = await readPack(res.dir, '02-work.md');

  assert.match(work, /Graded one \| 20 \| graded 18\/20/);
  assert.match(work, /Missed one \| 20 \| missing/);
  assert.match(work, /Still open \| 20 \| not submitted/);

  const open = work.slice(work.indexOf('## Open work'), work.indexOf('## Past due'));
  const past = work.slice(work.indexOf('## Past due'), work.indexOf('## Work that is not'));
  assert.match(open, /### Still open/);
  // Undated work is open work, not past work: an empty due date is not the epoch.
  assert.match(open, /### Never due/);
  assert.match(past, /### Graded one/);
  assert.match(past, /### Missed one/);
});

test('mined implicit work is listed, and its absence is stated outright', async (t) => {
  const mined = {
    mined_at: '2026-08-24T00:00:00Z',
    items: [
      { id: 'x', title: 'Pre-class slides review', kind: 'implicit', category: 'reading', due_date: null, recurring: 'before each class', weight_note: 'part of participation (5%)', description: 'Read the deck first.', sources: [{ type: 'announcement', ref: 'Welcome (2026-08-19)' }] },
      { id: 'y', title: 'Concept Check 1', kind: 'canvas', canvas_assignment_id: '5001', category: 'quiz', due_date: '2026-09-20' },
    ],
  };
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'assignments.json': [quizAssignment()],
    'assignments_mined.json': mined,
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const work = await readPack(res.dir, '02-work.md');

  assert.match(work, /### Pre-class slides review/);
  assert.match(work, /recurring: before each class/);
  assert.match(work, /Evidence: announcement — Welcome \(2026-08-19\)/);
  // Canvas-backed mined items would duplicate the Canvas list above.
  assert.equal((work.match(/### Concept Check 1/g) ?? []).length, 1);
  assert.ok(!res.warnings.some(w => /assignments_mined\.json is missing/.test(w)));
});

// --- correlation graph ------------------------------------------------------

const STUB_GRAPH = {
  buildGraph() {
    return {
      nodes: [
        { id: '1001', label: 'Week 1 Slides.pptx' },
        { id: '5001', label: 'Concept Check 1' },
        { id: '5002', label: 'Midterm Case' },
      ],
      edges: [
        { from: '1001', to: '5001', weight: 0.4 },
        { from: '5002', to: '1001', weight: 0.9 },
      ],
    };
  },
  toMarkdown() {
    return '### Edges\n\n- Week 1 Slides.pptx ↔ Concept Check 1 (0.40)\n- Week 1 Slides.pptx ↔ Midterm Case (0.90)';
  },
};

test('03-map.md carries the graph and each material header names its top related work', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '1001', materialsPath: 'materials/w1.txt' })],
    'materials/w1.txt': 'slide text\n',
  });
  const res = await buildPack(dir, { now: NOW, graphModule: STUB_GRAPH });

  const map = await readPack(res.dir, '03-map.md');
  assert.match(map, /## Correlation graph/);
  assert.match(map, /Week 1 Slides\.pptx ↔ Midterm Case \(0\.90\)/);
  assert.ok(!map.includes('Not available:'));

  const header = (await readPack(res.dir, 'materials/1001-week-1-slides.txt')).split('\n');
  assert.equal(header[0], '=== Week 1 Slides.pptx ===');
  assert.match(header[1], /^Canvas file 1001 · PPTX, 12 slides · updated 2026-08-11$/);
  assert.match(header[2], /^From: /);
  // Strongest edge first, so the first name in the line is the one to open.
  assert.equal(header[3], 'Related work: Midterm Case · Concept Check 1');
  assert.equal(header[4], '-'.repeat(72));
  assert.ok(!res.warnings.some(w => /Correlation graph unavailable/.test(w)));
});

test('a file is matched to its graph node by label when the ids do not line up', async (t) => {
  // The real graph folds the syllabus PDF into a node called `syllabus` and
  // tidies whitespace out of its label, so neither `file:<id>` nor an exact
  // display-name match finds it. Losing that link silently is the failure.
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '7692307', displayName: 'Marketing 380  Syllabus.pdf', materialsPath: 'materials/syl.txt' })],
    'materials/syl.txt': 'syllabus text\n',
  });
  const folded = {
    buildGraph() {
      return {
        nodes: [
          { id: 'syllabus', kind: 'syllabus', label: 'Marketing 380 Syllabus.pdf' },
          { id: 'assignment:1', kind: 'assignment', label: 'Final Case' },
        ],
        edges: [{ a: 'syllabus', b: 'assignment:1', w: 0.31, why: ['shared vocabulary'] }],
      };
    },
    toMarkdown() { return '- syllabus ↔ Final Case'; },
  };
  const res = await buildPack(dir, { now: NOW, graphModule: folded });
  assert.match(await readPack(res.dir, 'materials/7692307-marketing-380-syllabus.txt'), /Related work: Final Case/);
});

test('a file the graph found no link for says so, and does not claim the graph is missing', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '1001', materialsPath: 'materials/w1.txt' })],
    'materials/w1.txt': 'slide text\n',
  });
  const lonely = {
    buildGraph() { return { nodes: [{ id: 'file:1001', label: 'Week 1 Slides.pptx' }], edges: [] }; },
    toMarkdown() { return '_No edges cleared the threshold._'; },
  };
  const res = await buildPack(dir, { now: NOW, graphModule: lonely });
  const body = await readPack(res.dir, 'materials/1001-week-1-slides.txt');
  assert.match(body, /Related work: \(none — the graph found no strong link/);
  assert.ok(!body.includes('correlation graph unavailable'));
  assert.ok(!res.warnings.some(w => /Correlation graph unavailable/.test(w)));
});

test('a graph module that throws costs the graph section, not the pack', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '1001', materialsPath: 'materials/w1.txt' })],
    'materials/w1.txt': 'slide text\n',
  });
  const exploding = { buildGraph() { throw new Error('not finished yet'); }, toMarkdown() { return 'x'; } };
  const res = await buildPack(dir, { now: NOW, graphModule: exploding });

  const map = await readPack(res.dir, '03-map.md');
  assert.match(map, /Not available: buildGraph\(\) failed: not finished yet/);
  assert.match(await readPack(res.dir, 'materials/1001-week-1-slides.txt'), /Related work: \(correlation graph unavailable\)/);
  assert.ok(res.warnings.some(w => /Correlation graph unavailable/.test(w)));
});

test('buildGraph is also tried with just the class directory', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '1001', materialsPath: 'materials/w1.txt' })],
    'materials/w1.txt': 'slide text\n',
  });
  const dirOnly = {
    buildGraph(arg) {
      if (typeof arg !== 'string') throw new TypeError('classDir expected');
      return { nodes: [{ id: '1001', label: 'Deck' }, { id: 'q', label: 'Quiz 1' }], edges: [{ source: '1001', target: 'q', score: 1 }] };
    },
    toMarkdown() { return '- Deck ↔ Quiz 1'; },
  };
  const res = await buildPack(dir, { now: NOW, graphModule: dirOnly });
  assert.match(await readPack(res.dir, '03-map.md'), /- Deck ↔ Quiz 1/);
  assert.match(await readPack(res.dir, 'materials/1001-week-1-slides.txt'), /Related work: Quiz 1/);
});

test('the embedded graph markdown is demoted so it cannot outrank its own section', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '1001', materialsPath: 'materials/w1.txt' })],
    'materials/w1.txt': 'slide text\n',
  });
  const standalone = {
    buildGraph: STUB_GRAPH.buildGraph,
    toMarkdown() {
      return '# Correlation graph — BUSI 380\n\n## Nodes\n\n- one\n\n```\n# not a heading\n```\n';
    },
  };
  const res = await buildPack(dir, { now: NOW, graphModule: standalone });
  const map = await readPack(res.dir, '03-map.md');
  assert.match(map, /^### Correlation graph — BUSI 380$/m);
  assert.match(map, /^#### Nodes$/m);
  // The section heading the pack itself wrote still outranks everything in it.
  assert.match(map, /^## Correlation graph$/m);
  // Fenced content is content, not an outline.
  assert.match(map, /^# not a heading$/m);
});

test('a graph module with no toMarkdown still yields related-work headers', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '1001', materialsPath: 'materials/w1.txt' })],
    'materials/w1.txt': 'slide text\n',
  });
  const res = await buildPack(dir, {
    now: NOW,
    graphModule: { buildGraph: STUB_GRAPH.buildGraph },
  });
  assert.match(await readPack(res.dir, 'materials/1001-week-1-slides.txt'), /Related work: Midterm Case/);
  assert.match(await readPack(res.dir, '03-map.md'), /Not available: the graph module produced no markdown/);
});

// --- byte budget ------------------------------------------------------------

function bulkClass(count) {
  const assignments = [];
  for (let i = 0; i < count; i++) {
    assignments.push(quizAssignment({
      id: String(6000 + i),
      name: `Concept Check ${i + 1}`,
      quiz_id: String(9000 + i),
      due_at: `2026-${String(9 + (i % 3)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}T19:30:00Z`,
      description: `<p>${'This assignment has a very long rich-text description. '.repeat(40)}</p>`,
    }));
  }
  return assignments;
}

test('the four documents stay inside the byte budget, dropping detail rather than sections', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'assignments.json': bulkClass(40),
  });

  const roomy = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH, budgetBytes: 10_000_000, outDir: join(dir, 'roomy') });
  const detailed = await readPack(roomy.dir, '02-work.md');

  const tight = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH, budgetBytes: 20_000 });
  const trimmed = await readPack(tight.dir, '02-work.md');

  assert.ok(tight.warnings.some(w => /exceeded the 20000-byte budget/.test(w)));
  assert.ok(trimmed.length < detailed.length);
  // Trimming removes descriptions, never the routing information.
  assert.ok(!trimmed.includes('very long rich-text description'));
  assert.match(trimmed, /### Concept Check 40/);
  assert.match(trimmed, /## At a glance/);
  assert.match(trimmed, /Open: https:/);
  assert.match(trimmed, /descriptions were dropped/);
});

test('a large course fits the 150KB default budget for 00-03', async (t) => {
  const files = { 'metadata.json': { course_code: 'BUSI 380' }, 'assignments.json': bulkClass(80) };
  const index = [];
  for (let i = 0; i < 60; i++) {
    index.push(fileEntry({ canvasId: String(20000 + i), displayName: `Lecture ${i + 1} — Deck.pptx`, materialsPath: `materials/d${i}.txt` }));
    files[`materials/d${i}.txt`] = 'slide text\n'.repeat(500);
  }
  files['files_index.json'] = index;
  const dir = await makeClass(t, files);

  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  let docBytes = 0;
  for (const name of ['00-START-HERE.md', '01-course.md', '02-work.md', '03-map.md']) {
    docBytes += (await stat(join(res.dir, name))).size;
  }
  assert.ok(docBytes <= 150_000, `00-03 are ${docBytes} bytes`);
  // The materials themselves are outside the budget by design.
  assert.equal((await readdir(join(res.dir, 'materials'))).length, 60);
});

test('an oversized graph is clipped instead of crowding out the routing table', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '1001', materialsPath: 'materials/w1.txt' })],
    'materials/w1.txt': 'slide text\n',
  });
  const huge = {
    buildGraph: STUB_GRAPH.buildGraph,
    toMarkdown() { return Array.from({ length: 5000 }, (_, i) => `- edge ${i}`).join('\n'); },
  };
  const res = await buildPack(dir, { now: NOW, graphModule: huge, budgetBytes: 20_000 });
  const map = await readPack(res.dir, '03-map.md');
  assert.ok(map.length < 20_000, `03-map.md is ${map.length} bytes`);
  assert.match(map, /truncated to keep this file pasteable/);
  assert.match(map, /## Course materials \(1\)/);
  assert.ok(map.includes('materials/1001-week-1-slides.txt'));
});

// --- output location --------------------------------------------------------

test('the pack lands in pack2/ and leaves an existing pack/ untouched', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'AI_CONTEXT/pack/01-course-overview.md': '# v1 pack, must survive\n',
    'AI_CONTEXT/pack/materials-01.txt': 'v1 combined text\n',
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  assert.equal(res.dir, join(dir, 'AI_CONTEXT', 'pack2'));
  assert.equal(await readFile(join(dir, 'AI_CONTEXT', 'pack', '01-course-overview.md'), 'utf8'), '# v1 pack, must survive\n');
  assert.deepEqual((await readdir(join(dir, 'AI_CONTEXT', 'pack'))).sort(), ['01-course-overview.md', 'materials-01.txt']);
});

// --- sources that are absent vs. sources that are corrupt -------------------
// readJsonSafe() returns null for both, and the pack used to inherit that: a
// class whose assignments.json never synced produced "Every graded item Canvas
// reports for this course: 0 in total" with no warning at all. A model reading
// that tells a student they have nothing due. These pin the distinction.

test('a missing assignments.json is never reported as "no graded work"', async (t) => {
  const dir = await makeClass(t, { 'metadata.json': { course_code: 'BUSI 380' } });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const work = await readPack(res.dir, '02-work.md');

  assert.match(work, /This list is incomplete/);
  assert.match(work, /`assignments\.json` is missing/);
  assert.match(work, /`quizzes\.json` is missing/);
  // The count must not be phrased as Canvas's own answer.
  assert.ok(!work.includes('Every graded item Canvas reports'));
  assert.match(work, /a floor, not a total/);
  assert.ok(res.warnings.some(w => /^assignments\.json is missing/.test(w)));
  assert.ok(res.warnings.some(w => /^quizzes\.json is missing/.test(w)));
});

test('an empty-but-present assignments.json says the course really has no work', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'assignments.json': [], 'quizzes.json': [],
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const work = await readPack(res.dir, '02-work.md');

  // This is the one case where "there is nothing due" is a fact and not a gap.
  assert.match(work, /Canvas reports no graded work at all for this course/);
  assert.ok(!work.includes('This list is incomplete'));
  assert.ok(!res.warnings.some(w => /^assignments\.json/.test(w)));
  // An empty markdown table renders as an empty grid, which reads as an answer.
  assert.ok(!/\| Due \| Item \| Points \| Status \|/.test(work));
});

test('corrupt JSON is reported as corrupt, not as missing', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'assignments.json': '[{"id":"1","name":"Midterm"',
    'quizzes.json': [],
    'syllabus_parsed.json': '{ truncated',
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });

  // "Missing" sends the reader to re-run a sync; "corrupt" tells them the file
  // on disk is the problem. They are different repairs.
  assert.ok(res.warnings.some(w => /^assignments\.json is not valid JSON/.test(w)), JSON.stringify(res.warnings));
  assert.ok(res.warnings.some(w => /^syllabus_parsed\.json is not valid JSON/.test(w)));
  assert.ok(!res.warnings.some(w => /^assignments\.json is missing/.test(w)));

  const work = await readPack(res.dir, '02-work.md');
  assert.match(work, /`assignments\.json` could not be read/);
  assert.ok(!work.includes('`assignments.json` is missing'));
  const course = await readPack(res.dir, '01-course.md');
  assert.match(course, /`syllabus_parsed\.json` could not be read/);
});

test('a files_index.json that is not a list is reported, not silently emptied', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': { files: [] },
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  assert.ok(res.warnings.some(w => /files_index\.json is not a list/.test(w)), JSON.stringify(res.warnings));
});

// --- rows that are not files -----------------------------------------------

test('junk rows in files_index do not become phantom course materials', async (t) => {
  // attachOrigins() spreads every entry into an object, so null and 42 arrive
  // downstream looking like nameless files. Published, they become routing-table
  // rows for course material that does not exist — invented data, exactly what
  // the pack promises never to do.
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '9001', displayName: 'Real.pdf', materialsPath: 'materials/r.txt' }), null, 'garbage', 42, {}],
    'materials/r.txt': 'real text\n',
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });

  assert.deepEqual(await readdir(join(res.dir, 'materials')), ['9001-real.txt']);
  const map = await readPack(res.dir, '03-map.md');
  assert.match(map, /## Course materials \(1\)/);
  // Not silently dropped either — the count of Canvas rows still has to add up.
  assert.match(map, /files_index\.json entry 2 — not a file record/);
  assert.ok(res.warnings.some(w => /4 rows that are not file records/.test(w)), JSON.stringify(res.warnings));
});

// --- material text may only come from inside the class ----------------------

test('a materialsPath pointing outside the class directory is refused', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'files_index.json': [fileEntry({ canvasId: '1001', materialsPath: '../../../../../../etc/hosts' })],
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const body = await readPack(res.dir, 'materials/1001-week-1-slides.txt');

  // Publishing it would put an arbitrary local file under a header claiming
  // Canvas posted it, and 00-START-HERE.md tells the model these are verbatim.
  assert.ok(!body.includes('localhost'), 'read a file outside the class directory');
  assert.match(body, /No extracted text for this file/);
  assert.ok(res.warnings.some(w => /resolves outside the class directory/.test(w)));
});

// --- the budget is a promise, so a broken one has to be stated --------------

test('a budget that trimming cannot meet is reported, not implied to be met', async (t) => {
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'assignments.json': bulkClass(200),
    'quizzes.json': [],
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH, budgetBytes: 20_000 });

  let docBytes = 0;
  for (const name of ['00-START-HERE.md', '01-course.md', '02-work.md', '03-map.md']) {
    docBytes += (await stat(join(res.dir, name))).size;
  }
  assert.ok(docBytes > 20_000, 'expected this course to be unbudgetable');
  // The first warning alone reads as "trimmed, therefore fine".
  assert.ok(res.warnings.some(w => /STILL over the 20000-byte budget/.test(w)), JSON.stringify(res.warnings));
  // And the reader of the pack sees it, not just the caller.
  assert.match(await readPack(res.dir, '01-course.md'), /STILL over the 20000-byte budget/);
});

// --- caller mistakes fail before anything is written ------------------------

test('an invalid opts.now is refused before a half-built pack exists', async (t) => {
  const dir = await makeClass(t, { 'metadata.json': { course_code: 'BUSI 380' } });
  // `new Date('nonsense') instanceof Date` is true, so this used to survive the
  // guard and throw from toISOString() after every material file was written.
  await assert.rejects(
    () => buildPack(dir, { now: new Date('nonsense'), graphPath: NO_GRAPH }),
    /opts\.now must be a valid Date/,
  );
  await assert.rejects(() => readdir(join(dir, 'AI_CONTEXT', 'pack2')), { code: 'ENOENT' });
});

test('the graph note reports why the documented call failed, not the retry', async (t) => {
  const dir = await makeClass(t, { 'metadata.json': { course_code: 'BUSI 380' } });
  const twoFaced = {
    buildGraph(arg) {
      throw new Error(typeof arg === 'string' ? 'class dir has no modules.json' : 'expected a string');
    },
  };
  const res = await buildPack(dir, { now: NOW, graphModule: twoFaced });
  const map = await readPack(res.dir, '03-map.md');
  // The retry's complaint describes the retry; printing it hides the diagnosis.
  assert.match(map, /buildGraph\(\) failed: class dir has no modules\.json/);
  assert.ok(!map.includes('expected a string'));
});

test('a source holding valid JSON null is not reported as missing either', async (t) => {
  // `null` parses cleanly, so neither "missing" nor "corrupt" fits — and telling
  // the reader to re-run a sync that already ran wastes the one repair they get.
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'syllabus_parsed.json': 'null',
    'assignments.json': [], 'quizzes.json': [],
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  assert.ok(res.warnings.some(w => /^syllabus_parsed\.json holds no data/.test(w)), JSON.stringify(res.warnings));
  const course = await readPack(res.dir, '01-course.md');
  assert.match(course, /`syllabus_parsed\.json` holds no data/);
  assert.ok(!course.includes('The file on disk is damaged'));
});

test('an item due earlier today is filed as open but still reports past due, and the file says so', async (t) => {
  // Two definitions of "past due" live in this document: the section split is by
  // day, the Status line by timestamp. Leaving the reader to reconcile them is
  // how a model ends up asserting the wrong one.
  const dir = await makeClass(t, {
    'metadata.json': { course_code: 'BUSI 380' },
    'quizzes.json': [],
    'assignments.json': [quizAssignment({ id: '1', name: 'Due earlier today', due_at: '2026-09-15T05:00:00Z', submission: null })],
  });
  const res = await buildPack(dir, { now: NOW, graphPath: NO_GRAPH });
  const work = await readPack(res.dir, '02-work.md');
  const open = work.slice(work.indexOf('## Open work'), work.indexOf('## Past due'));

  assert.match(open, /### Due earlier today/);
  assert.match(open, /Status: past due, nothing submitted/);
  assert.match(open, /its Status line is the one that knows the time of day/);
});
