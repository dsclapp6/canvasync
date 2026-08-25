// correlation-graph.test.js — the per-class item graph.
//
// Three things must hold or the graph is worse than nothing:
//   1. A half-synced class must degrade to fewer nodes, never to an exception.
//      buildGraph runs inside the context build; a throw there loses the class.
//   2. Top-K must actually cap. The output goes in a file an LLM reads, so an
//      O(N^2) edge list is a correctness bug, not a performance one.
//   3. The premise — a course whose concepts build scores denser than one that
//      moves on every week — has to be measurable, not asserted. The two
//      synthetic corpora below differ ONLY in vocabulary reuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGraph, writeGraph, readGraph, neighbours, selectForQuery, toMarkdown,
  graphStats, tokenise, extractCodes, cosine, buildVectors, stripHtml,
  GRAPH_VERSION, DEFAULT_TOP_K,
} from '../correlation-graph.js';

async function tempClass(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cgraph-'));
  for (const [name, body] of Object.entries(files)) {
    const abs = join(dir, name);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

const cleanup = dir => rm(dir, { recursive: true, force: true });

// --- Units ----------------------------------------------------------------

test('tokenise drops stopwords, bare numbers and punctuation', () => {
  const t = tokenise('The Elaboration Likelihood Model, 2026: view the video below (6:43)');
  assert.ok(t.includes('elaboration'));
  assert.ok(t.includes('likelihood'));
  assert.ok(t.includes('model'));
  assert.ok(!t.includes('the'));
  assert.ok(!t.includes('2026'));
  assert.ok(!t.includes('43'));
  // "view", "video", "below" are Canvas boilerplate and are stoplisted.
  assert.ok(!t.includes('below'));
});

test('tokenise never throws on non-strings', () => {
  assert.deepEqual(tokenise(null), []);
  assert.deepEqual(tokenise(undefined), []);
  assert.deepEqual(tokenise(42), []);
});

test('accented words fold to their ASCII skeleton instead of being shredded', () => {
  // The token pattern is ASCII-only. Without folding, "résumé" splits on the
  // accents and yields "sum" — a different word, in a class about margins.
  const t = tokenise('Résumé du café — Übersicht der Kanäle');
  assert.ok(t.includes('resume'), `got ${JSON.stringify(t)}`);
  assert.ok(t.includes('cafe'));
  assert.ok(t.includes('ubersicht'));
  assert.ok(t.includes('kanale'));
  assert.ok(!t.includes('sum'));
  // Pure ASCII must be untouched by the folding path.
  assert.deepEqual(tokenise('pricing elasticity margin'), ['pricing', 'elasticity', 'margin']);
});

test('extractCodes reads the course-numbering forms', () => {
  assert.ok(extractCodes('Read Ch 4 before class').has('ch:4'));
  assert.ok(extractCodes('Chapter 12 problems').has('ch:12'));
  assert.ok(extractCodes('Week 3 - Segmentation').has('week:3'));
  assert.ok(extractCodes('S2a-Concept Check: Ladders').has('code:s2a'));
  assert.ok(extractCodes('Midterm Case 2 brief').has('case:2'));
  assert.ok(extractCodes('HW 7').has('hw:7'));
  assert.ok(extractCodes('§ 4.2 exercises').has('sec:4.2'));
});

test('extractCodes does not invent codes out of ordinary prose', () => {
  const codes = extractCodes('Understand the nature of channel conflict');
  assert.equal(codes.size, 0);
});

test('cosine is 1 for identical text and 0 for disjoint text', () => {
  const { vectors } = buildVectors([
    tokenise('pricing elasticity margin discount'),
    tokenise('pricing elasticity margin discount'),
    tokenise('photosynthesis chloroplast stomata membrane'),
  ]);
  assert.ok(cosine(vectors[0], vectors[1]) > 0.99);
  assert.equal(cosine(vectors[0], vectors[2]), 0);
});

test('a term present in every document contributes nothing', () => {
  const { vectors } = buildVectors([
    tokenise('canvasboilerplate alpha'),
    tokenise('canvasboilerplate beta'),
    tokenise('canvasboilerplate gamma'),
  ]);
  assert.equal(cosine(vectors[0], vectors[1]), 0);
});

test('stripHtml removes markup, scripts and entities', () => {
  const html = '<p>Read&nbsp;<b>Ch 4</b></p><script>var x = "hidden";</script><iframe src="x"></iframe>';
  const out = stripHtml(html);
  assert.equal(out, 'Read Ch 4');
  assert.equal(stripHtml(null), '');
});

// --- Degradation ----------------------------------------------------------

test('an empty class dir yields an empty graph, not a throw', async () => {
  const dir = await tempClass({});
  const g = await buildGraph(dir);
  assert.equal(g.version, GRAPH_VERSION);
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
  assert.equal(g.stats.nodeCount, 0);
  assert.equal(g.stats.density, 0);
  await cleanup(dir);
});

test('a class dir that is not there throws instead of returning an empty graph', async () => {
  // Missing FILES degrade to fewer nodes; a missing DIR is a caller bug. A
  // well-formed graph saying "this class has 0 items" is an invented answer,
  // and writeGraph would then mkdir the typo and store it.
  const gone = join(tmpdir(), `cgraph-missing-${process.pid}-${Date.now()}`);
  await assert.rejects(() => buildGraph(gone), /not a class directory/);

  const dir = await tempClass({ 'assignments.json': [{ id: 1, name: 'Case brief' }] });
  await assert.rejects(() => buildGraph(join(dir, 'assignments.json')), /not a class directory/);
  await cleanup(dir);
});

test('missing files degrade to fewer nodes', async () => {
  const dir = await tempClass({
    'assignments.json': [{ id: 1, name: 'Case brief', due_at: '2026-09-10T05:00:00Z' }],
  });
  const g = await buildGraph(dir);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.nodes[0].id, 'assignment:1');
  assert.equal(g.nodes[0].kind, 'assignment');
  await cleanup(dir);
});

test('corrupt JSON does not throw and does not poison the other sources', async () => {
  const dir = await tempClass({
    'modules.json': '{ this is not json',
    'quizzes.json': '[[[',
    'files_index.json': 'null',
    'pages.json': '{"message":"That page has been disabled for this course"}',
    'assignments.json': [{ id: 7, name: 'Reed Supermarkets case', due_at: '2026-10-06T05:00:00Z' }],
  });
  const g = await buildGraph(dir);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.nodes[0].id, 'assignment:7');
  await cleanup(dir);
});

test('rows with no usable identity are skipped, not emitted as junk nodes', async () => {
  // Canvas returns this exact shape for a course with the Pages tab disabled.
  const dir = await tempClass({
    'pages.json': [{ message: 'That page has been disabled for this course' }],
    'assignments.json': [{ name: 'no id here' }, { id: 3, name: 'Pricing exercise' }],
  });
  const g = await buildGraph(dir);
  assert.deepEqual(g.nodes.map(n => n.id), ['assignment:3']);
  assert.ok(g.stats.skipped.unusable >= 2);
  await cleanup(dir);
});

test('every node carries the documented shape', async () => {
  const dir = await tempClass({
    'syllabus.html': '<p><a href="/courses/1/files/900">Syllabus.pdf</a></p>',
    'files_index.json': [
      { canvasId: '900', displayName: 'Syllabus.pdf', materialsPath: 'materials/Syllabus.pdf.txt', canvasUpdatedAt: '2026-08-11T20:14:45Z' },
      { canvasId: '901', displayName: 'Week 1 deck.pptx', materialsPath: 'materials/Week 1 deck.pptx.txt' },
    ],
    'materials/Syllabus.pdf.txt': 'Grading policy attendance participation midterm final',
    'materials/Week 1 deck.pptx.txt': 'Segmentation targeting positioning fundamentals',
  });
  const g = await buildGraph(dir);
  for (const n of g.nodes) {
    for (const k of ['id', 'kind', 'label', 'date', 'textPath', 'canvasId', 'url']) {
      assert.ok(k in n, `node ${n.id} is missing ${k}`);
    }
  }
  // The syllabus node IS the syllabus file — one document, one node.
  const syl = g.nodes.find(n => n.id === 'syllabus');
  assert.equal(syl.canvasId, '900');
  assert.equal(syl.textPath, 'materials/Syllabus.pdf.txt');
  assert.equal(g.nodes.filter(n => n.canvasId === '900').length, 1);
  await cleanup(dir);
});

test('a file whose materials text is missing still becomes a node', async () => {
  const dir = await tempClass({
    'files_index.json': [
      { canvasId: '55', displayName: 'Deck.pptx', materialsPath: 'materials/gone.txt' },
    ],
  });
  const g = await buildGraph(dir);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.nodes[0].textPath, 'materials/gone.txt');
  await cleanup(dir);
});

test('materials text that cannot be read is counted, not silently dropped', async () => {
  // A moved or half-extracted materials dir costs every file node its
  // vocabulary. The graph then comes out confidently empty of edges, so the
  // count is the only thing that can tell a caller why.
  const index = Array.from({ length: 3 }, (_, i) => ({
    canvasId: String(100 + i), displayName: `Deck ${i}.pptx`, materialsPath: `materials/d${i}.txt`,
  }));
  const dir = await tempClass({ 'files_index.json': index });
  const g = await buildGraph(dir);
  assert.equal(g.nodes.length, 3, 'the nodes still exist');
  assert.equal(g.stats.skipped.missingText, 3);

  await mkdir(join(dir, 'materials'), { recursive: true });
  await writeFile(join(dir, 'materials', 'd0.txt'), 'pricing elasticity markup');
  const g2 = await buildGraph(dir);
  assert.equal(g2.stats.skipped.missingText, 2);
  await cleanup(dir);
});

test('a materialsPath outside the class dir is refused, not read', async () => {
  // materialsPath is written by the sync and only ever names something under
  // the class dir. Anything else would put an unrelated file's words into
  // node.terms and from there into the context pack an LLM reads.
  const outside = await mkdtemp(join(tmpdir(), 'cgraph-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'confidential payroll ledger salary');
  const dir = await tempClass({
    'files_index.json': [
      { canvasId: '1', displayName: 'Innocent.pdf', materialsPath: join(outside, 'secret.txt') },
      { canvasId: '2', displayName: 'Escape.pdf', materialsPath: '../secret.txt' },
    ],
  });
  const g = await buildGraph(dir);
  const terms = g.nodes.flatMap(n => Object.keys(n.terms));
  assert.ok(!terms.includes('payroll'), `absorbed an outside file: ${JSON.stringify(terms)}`);
  assert.ok(!terms.includes('ledger'));
  assert.equal(g.stats.skipped.outsideClassDir, 2);
  await cleanup(dir);
  await cleanup(outside);
});

test('duplicate files are not emitted twice', async () => {
  const dir = await tempClass({
    'files_index.json': [
      { canvasId: '1', displayName: 'Deck.pptx' },
      { canvasId: '2', displayName: 'Deck (1).pptx', duplicateOf: '1' },
    ],
  });
  const g = await buildGraph(dir);
  assert.deepEqual(g.nodes.map(n => n.id), ['file:1']);
  assert.equal(g.stats.skipped.duplicateFiles, 1);
  await cleanup(dir);
});

// --- Provenance -----------------------------------------------------------

const MODULE_CLASS = {
  'modules.json': [{
    id: '500', position: 1, name: 'Week 2 - Assess Your Customers',
    items: [
      { id: 'i1', position: 1, type: 'Quiz', content_id: '77', title: 'S2a-Concept Check: Ladders', content_details: { due_at: '2026-09-01T19:30:00Z' } },
      { id: 'i2', position: 2, type: 'Quiz', content_id: '78', title: 'S2a-Concept Check: Channels', content_details: { due_at: '2026-09-01T19:30:00Z' } },
      { id: 'i3', position: 3, type: 'File', content_id: '900', title: 'Ladders deck' },
    ],
  }],
  'quizzes.json': [
    { id: '77', title: 'S2a-Concept Check: Ladders', due_at: '2026-09-01T19:30:00Z', description: '<p>Customer needs ladder attributes consequences values</p>' },
    { id: '78', title: 'S2a-Concept Check: Channels', due_at: '2026-09-01T19:30:00Z', description: '<p>Intermediaries disintermediation wholesale retail</p>' },
  ],
  'files_index.json': [{ canvasId: '900', displayName: 'Ladders deck.pptx', materialsPath: 'materials/ladders.txt' }],
  'materials/ladders.txt': 'Customer needs ladder attributes consequences values means end chain',
};

test('module membership creates a containment edge, tagged for the reader', async () => {
  const dir = await tempClass(MODULE_CLASS);
  const g = await buildGraph(dir);
  const e = g.edges.find(x =>
    (x.a === 'module:500' && x.b === 'quiz:77') || (x.b === 'module:500' && x.a === 'quiz:77'));
  assert.ok(e, 'expected an edge between the module and the quiz it contains');
  assert.ok(e.why.includes('in this module'), `why was ${JSON.stringify(e.why)}`);
  assert.ok(e.w > 0.4, `containment should be strong, got ${e.w}`);
  await cleanup(dir);
});

test('two items in the same module are siblings, and say so', async () => {
  const dir = await tempClass(MODULE_CLASS);
  const g = await buildGraph(dir);
  const e = g.edges.find(x =>
    [x.a, x.b].includes('quiz:77') && [x.a, x.b].includes('quiz:78'));
  assert.ok(e, 'expected an edge between two quizzes in the same module');
  assert.ok(e.why.includes('same module'));
  await cleanup(dir);
});

test('shared course numbering is reported with the code that matched', async () => {
  const dir = await tempClass(MODULE_CLASS);
  const g = await buildGraph(dir);
  const e = g.edges.find(x =>
    [x.a, x.b].includes('quiz:77') && [x.a, x.b].includes('quiz:78'));
  assert.ok(e.why.some(w => /shares "S2A"/i.test(w)), `why was ${JSON.stringify(e.why)}`);
  await cleanup(dir);
});

test('a file linked from an assignment body attaches to that assignment', async () => {
  const dir = await tempClass({
    'assignments.json': [{
      id: '42', name: 'Midterm Case Assignment', due_at: '2026-10-06T05:00:00Z',
      description: '<p>Use <a href="/courses/1/files/901">the case packet</a>.</p>',
    }],
    'files_index.json': [{ canvasId: '901', displayName: 'Reed Supermarkets case packet.pdf' }],
  });
  const g = await buildGraph(dir);
  const e = g.edges.find(x => [x.a, x.b].includes('file:901') && [x.a, x.b].includes('assignment:42'));
  assert.ok(e, 'expected the file to attach to the assignment that links it');
  assert.ok(e.why.includes('attached here'));
  await cleanup(dir);
});

test('quiz shells merge into the quiz by default, and split on request', async () => {
  const files = {
    // The quiz row has no due date; only the gradebook's assignment copy does.
    'quizzes.json': [{ id: '77', title: 'S2a-Concept Check: Ladders' }],
    'assignments.json': [
      { id: '532620', name: 'S2a-Concept Check: Ladders', quiz_id: '77', due_at: '2026-09-01T19:30:00Z' },
      { id: '532645', name: 'Midterm Case Assignment', due_at: '2026-10-06T05:00:00Z' },
    ],
  };
  const dir = await tempClass(files);
  const merged = await buildGraph(dir);
  assert.deepEqual(merged.nodes.map(n => n.id).sort(), ['assignment:532645', 'quiz:77']);
  assert.equal(merged.stats.skipped.quizShells, 1);
  const quiz = merged.nodes.find(n => n.id === 'quiz:77');
  assert.equal(quiz.assignmentId, '532620');
  assert.equal(quiz.date, '2026-09-01T19:30:00.000Z', 'the merged node must inherit the missing due date');

  const split = await buildGraph(dir, { dedupeQuizShells: false });
  assert.equal(split.nodes.length, 3);
  assert.equal(split.stats.skipped.quizShells, 0);
  await cleanup(dir);
});

// --- Temporal -------------------------------------------------------------

// Same words in all three, so lexical is identical across every pair and the
// only thing left to separate them is the gap between their due dates.
const DATED_CLASS = {
  'assignments.json': [
    { id: '1', name: 'Pricing elasticity workshop', due_at: '2026-09-01T05:00:00Z' },
    { id: '2', name: 'Pricing elasticity review', due_at: '2026-09-01T18:00:00Z' },
    { id: '3', name: 'Pricing elasticity retrospective', due_at: '2027-02-01T05:00:00Z' },
    { id: '4', name: 'Brand equity seminar', due_at: '2026-11-01T05:00:00Z' },
  ],
};

test('items due the same day rank above the same items months apart', async () => {
  const dir = await tempClass(DATED_CLASS);
  const g = await buildGraph(dir, { minWeight: 0.02 });
  const near = g.edges.find(e => [e.a, e.b].includes('assignment:1') && [e.a, e.b].includes('assignment:2'));
  const far = g.edges.find(e => [e.a, e.b].includes('assignment:1') && [e.a, e.b].includes('assignment:3'));
  assert.ok(near, 'expected an edge between the two same-day items');
  assert.ok(near.why.includes('same day'), `why was ${JSON.stringify(near?.why)}`);
  assert.ok(far, 'expected an edge between the two distant items');
  assert.ok(!far.why.some(w => /same day|same week|nearby/.test(w)), `why was ${JSON.stringify(far.why)}`);
  assert.ok(near.w > far.w, `same-day ${near.w} should beat months-apart ${far.w}`);
  await cleanup(dir);
});

test('date proximity alone never creates an edge', async () => {
  // Two items with nothing in common but a due date. The temporal term is
  // capped below the floor on purpose, so a class does not turn into a chain
  // of "things that happen to be due the same Tuesday".
  const dir = await tempClass({
    'assignments.json': [
      { id: '1', name: 'Photosynthesis chloroplast stomata', due_at: '2026-09-01T05:00:00Z' },
      { id: '2', name: 'Procurement governance compliance', due_at: '2026-09-01T06:00:00Z' },
    ],
  });
  const g = await buildGraph(dir);
  assert.equal(g.edges.length, 0);
  await cleanup(dir);
});

// --- Size control ---------------------------------------------------------

// A sliding window over a shared vocabulary: every pair overlaps, adjacent
// items heavily, distant items lightly. Without capping this is a complete
// graph, and unlike a corpus where every word appears everywhere, the
// similarities are all distinct — so top-K has something to choose between.
const WINDOW_VOCAB = Array.from({ length: 40 }, (_, i) => `termword${i}`);

async function saturatedClass(n) {
  const quizzes = [];
  for (let i = 0; i < n; i++) {
    const words = Array.from({ length: 20 }, (_, j) => WINDOW_VOCAB[(i + j) % WINDOW_VOCAB.length]);
    quizzes.push({
      id: String(1000 + i),
      title: `Pricing elasticity margin exercise ${i}`,
      due_at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T05:00:00Z`,
      description: `<p>${words.join(' ')}</p>`,
    });
  }
  return tempClass({ 'quizzes.json': quizzes });
}

test('top-K capping holds: the edge list is O(N*K), not O(N^2)', async () => {
  const n = 24;
  const dir = await saturatedClass(n);
  const uncapped = (n * (n - 1)) / 2;

  const g = await buildGraph(dir, { topK: 3 });
  assert.ok(g.edges.length <= n * 3, `${g.edges.length} edges exceeds the N*K bound`);
  assert.ok(g.edges.length < uncapped / 2, `capping did nothing: ${g.edges.length} of ${uncapped}`);

  const wide = await buildGraph(dir, { topK: 12 });
  assert.ok(wide.edges.length > g.edges.length, 'a larger K must keep more edges');
  await cleanup(dir);
});

test('no edge survives below the floor weight', async () => {
  const dir = await saturatedClass(12);
  const g = await buildGraph(dir, { minWeight: 0.5 });
  for (const e of g.edges) assert.ok(e.w >= 0.5, `edge ${e.a}-${e.b} at ${e.w} is below the floor`);
  const loose = await buildGraph(dir, { minWeight: 0.01 });
  assert.ok(loose.edges.length >= g.edges.length);
  await cleanup(dir);
});

test('a zero floor still does not manufacture zero-weight edges', async () => {
  // Three items with nothing whatever in common. Dropping the floor must widen
  // what counts as a link, not assert N^2 links that every scorer scored 0.
  const dir = await tempClass({
    'assignments.json': [
      { id: '1', name: 'Photosynthesis chloroplast stomata' },
      { id: '2', name: 'Procurement governance compliance' },
      { id: '3', name: 'Kerning leading baseline' },
    ],
  });
  const g = await buildGraph(dir, { minWeight: 0 });
  assert.deepEqual(g.edges, [], `got ${JSON.stringify(g.edges)}`);
  await cleanup(dir);
});

test('edges are canonical and never self-referential', async () => {
  const dir = await saturatedClass(10);
  const g = await buildGraph(dir);
  const seen = new Set();
  for (const e of g.edges) {
    assert.notEqual(e.a, e.b);
    const key = [e.a, e.b].sort().join('~');
    assert.ok(!seen.has(key), `duplicate edge ${key}`);
    seen.add(key);
    assert.ok(e.w > 0 && e.w <= 1);
    assert.ok(Array.isArray(e.why));
  }
  await cleanup(dir);
});

// --- The premise: do concept-building courses come out denser? -------------

// Both corpora have 14 items, identical titles ("Lecture N", which yields a
// per-item code that matches nothing), no modules and no dates. The ONLY
// difference is whether later items reuse earlier vocabulary.
const BUILDING = [
  'vector', 'matrix', 'eigenvalue', 'determinant', 'basis', 'span', 'linear',
  'transformation', 'orthogonal', 'projection', 'subspace', 'rank', 'kernel', 'diagonal',
];
const DISJOINT = [
  ['persona', 'empathy', 'journey', 'wireframe'],
  ['heuristic', 'affordance', 'signifier', 'mapping'],
  ['prototype', 'fidelity', 'storyboard', 'sketch'],
  ['accessibility', 'contrast', 'screenreader', 'caption'],
  ['ethnography', 'diary', 'contextual', 'inquiry'],
  ['ideation', 'brainstorm', 'divergent', 'convergent'],
  ['critique', 'rubric', 'portfolio', 'presentation'],
  ['typography', 'kerning', 'leading', 'baseline'],
  ['colour', 'palette', 'saturation', 'hue'],
  ['motion', 'easing', 'choreography', 'transition'],
  ['sustainability', 'lifecycle', 'material', 'disposal'],
  ['governance', 'stakeholder', 'procurement', 'compliance'],
  ['deployment', 'handoff', 'documentation', 'annotation'],
  ['retrospective', 'metric', 'adoption', 'telemetry'],
];

async function conceptBuildingClass() {
  const quizzes = BUILDING.map((_, i) => ({
    id: String(2000 + i),
    title: `Lecture ${i + 1}`,
    // Each lecture uses everything introduced so far plus its own term: the
    // definition of a subject whose concepts build.
    description: `<p>${BUILDING.slice(0, i + 1).join(' ')}</p>`,
  }));
  return tempClass({ 'quizzes.json': quizzes });
}

async function weekToWeekClass() {
  const quizzes = DISJOINT.map((words, i) => ({
    id: String(3000 + i),
    title: `Lecture ${i + 1}`,
    description: `<p>${words.join(' ')}</p>`,
  }));
  return tempClass({ 'quizzes.json': quizzes });
}

test('a concept-building corpus comes out denser than a week-to-week one', async () => {
  const dense = await conceptBuildingClass();
  const sparse = await weekToWeekClass();
  const a = await buildGraph(dense);
  const b = await buildGraph(sparse);

  assert.equal(a.stats.nodeCount, b.stats.nodeCount, 'the two corpora must be the same size');
  assert.ok(
    a.stats.meanLexical > b.stats.meanLexical * 3,
    `mean lexical similarity: building ${a.stats.meanLexical} vs week-to-week ${b.stats.meanLexical}`,
  );
  assert.ok(
    a.stats.density > b.stats.density,
    `density: building ${a.stats.density} vs week-to-week ${b.stats.density}`,
  );
  assert.equal(b.stats.edgeCount, 0, 'a corpus with no shared vocabulary should have no links at all');
  await cleanup(dense);
  await cleanup(sparse);
});

test('density tracks vocabulary reuse monotonically, including the middle case', async () => {
  // A course that carries two terms over from last week and otherwise moves
  // on. It must land between the two extremes, not with either of them.
  const mixed = await tempClass({
    'quizzes.json': DISJOINT.map((words, i) => ({
      id: String(5000 + i),
      title: `Lecture ${i + 1}`,
      description: `<p>${words.join(' ')} ${(DISJOINT[i - 1] ?? []).slice(0, 2).join(' ')}</p>`,
    })),
  });
  const dense = await conceptBuildingClass();
  const sparse = await weekToWeekClass();
  // Below the default floor the middle case has no edges at all: lexical alone
  // contributes at most W_LEXICAL, so a bare 0.04 cosine cannot clear 0.12.
  // Lowering the floor is what makes the ordering visible at this corpus size.
  const opts = { minWeight: 0.02 };
  const [a, m, b] = await Promise.all([
    buildGraph(dense, opts), buildGraph(mixed, opts), buildGraph(sparse, opts),
  ]);
  assert.ok(a.stats.density > m.stats.density, `${a.stats.density} !> ${m.stats.density}`);
  assert.ok(m.stats.density > b.stats.density, `${m.stats.density} !> ${b.stats.density}`);
  assert.ok(a.stats.meanLexical > m.stats.meanLexical);
  assert.ok(m.stats.meanLexical > b.stats.meanLexical);
  await Promise.all([cleanup(dense), cleanup(mixed), cleanup(sparse)]);
});

// --- Retrieval ------------------------------------------------------------

const RETRIEVAL_CLASS = {
  'quizzes.json': [
    { id: '10', title: 'Concept Check: Price Elasticity', description: '<p>elasticity demand curve markup margin willingness to pay</p>' },
    { id: '11', title: 'Concept Check: Brand Equity', description: '<p>brand equity awareness loyalty associations salience</p>' },
    { id: '12', title: 'Concept Check: Distribution Channels', description: '<p>wholesaler retailer intermediary logistics fulfilment</p>' },
  ],
  'files_index.json': [
    { canvasId: '20', displayName: 'Pricing deck.pptx', materialsPath: 'materials/pricing.txt' },
    { canvasId: '21', displayName: 'Branding deck.pptx', materialsPath: 'materials/branding.txt' },
  ],
  'materials/pricing.txt': 'elasticity demand curve markup margin willingness to pay penetration skimming',
  'materials/branding.txt': 'brand equity awareness loyalty associations salience architecture',
};

test('selectForQuery finds the obviously relevant item', async () => {
  const dir = await tempClass(RETRIEVAL_CLASS);
  const g = await buildGraph(dir);
  const hits = selectForQuery(g, 'how does price elasticity affect our markup?', { limit: 3 });
  assert.ok(hits.length > 0, 'expected at least one hit');
  assert.ok(
    hits[0] === 'quiz:10' || hits[0] === 'file:20',
    `top hit was ${hits[0]}, expected the pricing quiz or the pricing deck`,
  );
  assert.ok(!hits.includes('quiz:12'), 'the distribution quiz is not relevant to pricing');
  await cleanup(dir);
});

test('selectForQuery expands one hop, so the deck comes along with the quiz', async () => {
  const dir = await tempClass(RETRIEVAL_CLASS);
  const g = await buildGraph(dir);
  const hits = selectForQuery(g, 'brand equity', { limit: 5 });
  assert.ok(hits.includes('quiz:11'));
  assert.ok(hits.includes('file:21'), `expected the branding deck in ${JSON.stringify(hits)}`);
  await cleanup(dir);
});

test('selectForQuery returns nothing rather than something irrelevant', async () => {
  const dir = await tempClass(RETRIEVAL_CLASS);
  const g = await buildGraph(dir);
  assert.deepEqual(selectForQuery(g, 'photosynthesis chloroplast stomata'), []);
  assert.deepEqual(selectForQuery(g, ''), []);
  assert.deepEqual(selectForQuery(g, null), []);
  assert.deepEqual(selectForQuery({ nodes: [], edges: [] }, 'anything'), []);
  await cleanup(dir);
});

test('a query word that names a JS builtin does not delete the results', async () => {
  // node.terms is a plain object, so terms['constructor'] reaches
  // Object.prototype.constructor. Multiplying a number by that function takes
  // the whole node's score to NaN, which fails the s > 0 test and drops the
  // node — so adding a word to the query REMOVED the item that word matches.
  // "constructor" is an ordinary query in any programming course.
  const dir = await tempClass({
    'quizzes.json': [
      { id: '1', title: 'Java constructors', description: '<p>constructor initialiser chaining</p>' },
      { id: '2', title: 'Method overloading', description: '<p>overloading dispatch signature arity</p>' },
      { id: '3', title: 'Recursion', description: '<p>recursion basecase stackframe</p>' },
    ],
  });
  const g = await buildGraph(dir);
  assert.deepEqual(selectForQuery(g, 'overloading'), ['quiz:2'], 'control');
  const both = selectForQuery(g, 'constructor overloading');
  assert.ok(both.includes('quiz:2'), `adding "constructor" lost the overloading quiz: ${JSON.stringify(both)}`);
  assert.ok(both.includes('quiz:1'));
  assert.ok(selectForQuery(g, 'constructor recursion').includes('quiz:3'));
  // Same hazard through the other inherited keys, whatever the node's terms.
  for (const word of ['constructor', 'tostring', 'valueof', 'hasownproperty']) {
    assert.ok(selectForQuery(g, `${word} recursion`).includes('quiz:3'), `lost on "${word}"`);
  }
  await cleanup(dir);
});

test('selectForQuery respects the limit', async () => {
  const dir = await saturatedClass(20);
  const g = await buildGraph(dir);
  assert.equal(selectForQuery(g, 'pricing elasticity margin', { limit: 4 }).length, 4);
  await cleanup(dir);
});

test('neighbours ranks by weight and honours n', async () => {
  const dir = await tempClass(MODULE_CLASS);
  const g = await buildGraph(dir);
  const all = neighbours(g, 'quiz:77');
  assert.ok(all.length > 0);
  assert.equal(neighbours(g, 'quiz:77', 1).length, 1);
  assert.deepEqual(neighbours(g, 'nope:1'), []);

  const byId = new Map(g.edges.flatMap(e => [
    [`${e.a}~${e.b}`, e.w], [`${e.b}~${e.a}`, e.w],
  ]));
  const ws = all.map(id => byId.get(`quiz:77~${id}`));
  for (let i = 1; i < ws.length; i++) assert.ok(ws[i - 1] >= ws[i], 'neighbours must be ranked');
  await cleanup(dir);
});

test('neighbours does not serve one graph from another graph adjacency', async () => {
  // adjacency() is memoised on the edge array so a router can call
  // neighbours() per node without rebuilding it N times. The cache must key on
  // that array, and must notice an appended edge.
  const a = await tempClass(MODULE_CLASS);
  const b = await tempClass(RETRIEVAL_CLASS);
  const [ga, gb] = [await buildGraph(a), await buildGraph(b)];
  assert.ok(neighbours(ga, 'quiz:77').length > 0);
  assert.deepEqual(neighbours(gb, 'quiz:77'), [], 'the other class has no quiz:77');
  assert.deepEqual(neighbours(gb, 'quiz:11'), ['file:21']);

  const before = neighbours(ga, 'quiz:77').length;
  ga.edges.push({ a: 'quiz:77', b: 'nonesuch:1', w: 0.99, why: [] });
  assert.equal(neighbours(ga, 'quiz:77').length, before + 1, 'an appended edge must invalidate');
  assert.equal(neighbours(ga, 'quiz:77')[0], 'nonesuch:1');
  await cleanup(a);
  await cleanup(b);
});

// --- Persistence ----------------------------------------------------------

test('writeGraph and readGraph round-trip', async () => {
  const dir = await tempClass(MODULE_CLASS);
  const g = await buildGraph(dir);
  const file = await writeGraph(dir, g);
  assert.ok(file.endsWith('correlation_graph.json'));
  const back = await readGraph(dir);
  assert.deepEqual(back.nodes.map(n => n.id), g.nodes.map(n => n.id));
  assert.equal(back.edges.length, g.edges.length);
  await cleanup(dir);
});

test('readGraph returns null for missing or corrupt files', async () => {
  const dir = await tempClass({});
  assert.equal(await readGraph(dir), null);
  await writeFile(join(dir, 'correlation_graph.json'), '{ nope');
  assert.equal(await readGraph(dir), null);
  await writeFile(join(dir, 'correlation_graph.json'), '{"version":1}');
  assert.equal(await readGraph(dir), null);
  await cleanup(dir);
});

test('buildGraph is deterministic: same input, byte-identical graph', async () => {
  const dir = await tempClass(MODULE_CLASS);
  const a = await buildGraph(dir);
  const b = await buildGraph(dir);
  const strip = g => JSON.stringify({ ...g, builtAt: null, stats: { ...g.stats, buildMs: 0 } });
  assert.equal(strip(a), strip(b));
  await cleanup(dir);
});

// --- Stats and rendering --------------------------------------------------

test('graphStats reports the shape of the graph', async () => {
  const dir = await tempClass(MODULE_CLASS);
  const g = await buildGraph(dir);
  const s = graphStats(g);
  // Counted independently rather than re-reading .length off the same arrays,
  // which would only restate the implementation.
  const ids = new Set(g.nodes.map(n => n.id));
  const pairs = new Set(g.edges.map(e => [e.a, e.b].sort().join('~')));
  assert.equal(s.nodeCount, ids.size);
  assert.equal(s.edgeCount, pairs.size);
  assert.equal(s.density, Math.round((pairs.size / ((ids.size * (ids.size - 1)) / 2)) * 10000) / 10000);

  const degree = new Map([...ids].map(id => [id, 0]));
  for (const e of g.edges) {
    degree.set(e.a, degree.get(e.a) + 1);
    degree.set(e.b, degree.get(e.b) + 1);
  }
  const sorted = [...degree.values()].sort((a, b) => a - b);
  assert.equal(s.medianDegree, sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  // Hubs rank by summed weight, not by raw degree.
  const strength = new Map([...ids].map(id => [id, 0]));
  for (const e of g.edges) {
    strength.set(e.a, strength.get(e.a) + e.w);
    strength.set(e.b, strength.get(e.b) + e.w);
  }
  assert.equal(s.hubs[0].strength, Math.round(Math.max(...strength.values()) * 100) / 100);
  assert.ok(s.hubs.every(h => typeof h.label === 'string' && h.degree > 0));
  for (let i = 1; i < s.hubs.length; i++) assert.ok(s.hubs[i - 1].strength >= s.hubs[i].strength);

  const empty = graphStats({ nodes: [], edges: [] });
  assert.deepEqual(empty, { nodeCount: 0, edgeCount: 0, density: 0, medianDegree: 0, hubs: [] });
  assert.deepEqual(graphStats(null).nodeCount, 0);
});

test('toMarkdown stays under budget for a 100-node class', async () => {
  const quizzes = [];
  for (let i = 0; i < 100; i++) {
    quizzes.push({
      id: String(4000 + i),
      // Long labels, because real Canvas titles are long.
      title: `S${(i % 12) + 1}a-Concept Check: Understand the Nature of ${BUILDING[i % BUILDING.length]} Management Opportunities and Challenges (${i}:43)`,
      due_at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T19:30:00Z`,
      description: `<p>${BUILDING.slice(0, (i % BUILDING.length) + 1).join(' ')} topic${i}</p>`,
    });
  }
  const dir = await tempClass({ 'quizzes.json': quizzes });
  const g = await buildGraph(dir, { topK: DEFAULT_TOP_K });
  assert.equal(g.stats.nodeCount, 100);

  const md = toMarkdown(g);
  const bytes = Buffer.byteLength(md, 'utf8');
  assert.ok(bytes < 40 * 1024, `markdown was ${bytes} bytes, over the 40KB budget`);
  assert.ok(md.includes('# Correlation graph'));
  assert.ok(md.includes('| Item | Kind | When | Related to |'));
  await cleanup(dir);
});

test('toMarkdown holds the budget on a class the ladder cannot shrink far enough', async () => {
  // The five rungs bottom out. Past that the old renderer returned the last
  // rung whatever it weighed — 281KB for 1600 items against a 40KB budget.
  // A pack that quietly runs 7x over is what blows up the context window it
  // was sized for, so drop rows instead and say how many.
  const quizzes = [];
  for (let i = 0; i < 300; i++) {
    quizzes.push({
      id: String(6000 + i),
      title: `S${(i % 12) + 1}a-Concept Check: Understand the Nature of ${BUILDING[i % BUILDING.length]} Management Opportunities and Challenges (${i}:43)`,
      due_at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T19:30:00Z`,
      description: `<p>${BUILDING.slice(0, (i % BUILDING.length) + 1).join(' ')} topic${i}</p>`,
    });
  }
  const dir = await tempClass({ 'quizzes.json': quizzes });
  const g = await buildGraph(dir);

  const md = toMarkdown(g);
  assert.ok(Buffer.byteLength(md, 'utf8') <= 40 * 1024, `${Buffer.byteLength(md, 'utf8')} bytes, over budget`);
  assert.match(md, /_\d+ of \d+ linked items omitted to fit the size budget\._/);
  // The header must still report the whole graph, not the clipped rendering.
  assert.ok(md.includes(`${g.stats.nodeCount} items`));

  // An explicit budget is honoured too, and the strongest rows are the ones kept.
  const tight = toMarkdown(g, { maxBytes: 4096 });
  assert.ok(Buffer.byteLength(tight, 'utf8') <= 4096, `${Buffer.byteLength(tight, 'utf8')} bytes, over 4096`);
  assert.ok(tight.includes(g.stats.hubs[0].label.slice(0, 20)), 'the top hub should survive the clip');
  // Infinity means one pass at the given settings, not a budget of zero rows.
  assert.ok(Buffer.byteLength(toMarkdown(g, { maxBytes: Infinity }), 'utf8') > 40 * 1024);
  await cleanup(dir);
});

test('toMarkdown recomputes a stats block it cannot trust', async () => {
  // A hand-assembled or partially-written graph used to render
  // "undefined items, undefined links" straight into the pack.
  const g = { version: 1, class: {}, stats: {}, edges: [], nodes: [{ id: 'a', kind: 'file', label: 'A', date: null }] };
  const md = toMarkdown(g);
  assert.ok(md.includes('1 items, 0 links'), md.split('\n').slice(0, 4).join('\n'));
  assert.ok(!md.includes('undefined'));
  // A kind that happens to name an Object.prototype key must not print a function.
  const odd = toMarkdown({ nodes: [{ id: 'a', kind: 'constructor', label: 'A', date: null }], edges: [{ a: 'a', b: 'b', w: 0.5, why: [] }] });
  assert.ok(!odd.includes('native code'), odd);
});

test('toMarkdown survives an empty graph and lists unconnected items', async () => {
  const sparse = await weekToWeekClass();
  const g = await buildGraph(sparse);
  const md = toMarkdown(g);
  assert.ok(md.includes('## Unconnected'));
  assert.ok(!md.includes('undefined'));
  assert.ok(toMarkdown({ nodes: [], edges: [] }).includes('# Correlation graph'));
  await cleanup(sparse);
});

test('toMarkdown carries the why tags an LLM is meant to read', async () => {
  const dir = await tempClass(MODULE_CLASS);
  const g = await buildGraph(dir);
  const md = toMarkdown(g);
  assert.ok(/in this module|same module/.test(md), md);
  await cleanup(dir);
});
