// build-graph.test.js — the correlation graph's place in the sync pipeline.
//
// Two claims are under test, and only one of them is about the CLI:
//
//   1. build-graph.js turns a class directory into a correlation_graph.json
//      that readGraph() accepts, and fails LOUDLY on a directory that is not
//      there rather than leaving a well-formed graph on disk announcing that
//      the class has no items.
//
//   2. needsGraph() fires exactly when the graph is older than the data it was
//      derived from, and not otherwise. The build is cheap — tens of
//      milliseconds — but sync-all-contexts runs on every ingest over every
//      class, and a stage that always fires teaches the summary table to say
//      "graph" on runs where nothing changed, which is how a table stops being
//      read at all.
//
// No model and no network. Every fixture is built in a temp directory; the
// pipeline fixtures are mtime-stamped so the graph is the ONLY stage that can
// ever be stale; and CLAUDE_SKIP=1 is set as a backstop so that a fixture
// misjudged by this file would stub an AI stage rather than call one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGraph, GRAPH_FILE } from '../correlation-graph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..');
const CLASS_NAME = '42424-mktg-380-001';

function runNode(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, script), ...args], {
      env: { ...process.env, CLAUDE_SKIP: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

const runSyncAll = home => runNode('sync-all-contexts.js', [], { CANVAS_SYNC_HOME: home });
const runBuildGraph = (...args) => runNode('build-graph.js', args);

// --- Fixture --------------------------------------------------------------
// Shapes match what the bridge actually stores (files_index.json uses the
// normalised canvasId/displayName/materialsPath form, module items carry
// content_id), because provenance edges are derived from exactly those fields.

const SYLLABUS_HTML =
  '<p>MKTG 380. Two cases, one exam. Positioning and segmentation throughout.</p>';

const CLASS_FILES = {
  'metadata.json': { id: 42424, name: 'Consumer Behaviour', course_code: 'MKTG 380' },
  'files_index.json': [
    {
      canvasId: '9001', displayName: 'Week 1 — Segmentation.pdf',
      filename: 'week1.pdf', contentType: 'application/pdf', size: 1024,
      canvasUpdatedAt: '2026-08-25T12:00:00Z',
      localPath: 'files/week1.pdf', materialsPath: 'materials/week1.pdf.txt',
      extractionStatus: 'done', duplicateOf: null,
    },
    {
      canvasId: '9002', displayName: 'Week 2 — Positioning.pdf',
      filename: 'week2.pdf', contentType: 'application/pdf', size: 2048,
      canvasUpdatedAt: '2026-09-01T12:00:00Z',
      localPath: 'files/week2.pdf', materialsPath: 'materials/week2.pdf.txt',
      extractionStatus: 'done', duplicateOf: null,
    },
  ],
  'modules.json': [
    {
      id: '77001', name: 'Week 1: Segmentation', position: 1,
      items: [
        { id: '1', type: 'File', content_id: '9001', title: 'Week 1 — Segmentation.pdf' },
        { id: '2', type: 'Assignment', content_id: '8001', title: 'Case 1 memo' },
      ],
    },
    {
      id: '77002', name: 'Week 2: Positioning', position: 2,
      items: [
        { id: '3', type: 'File', content_id: '9002', title: 'Week 2 — Positioning.pdf' },
        { id: '4', type: 'Quiz', content_id: '6001', title: 'Quiz 2' },
        { id: '5', type: 'Page', page_url: 'week-2-notes', title: 'Week 2 notes' },
      ],
    },
  ],
  'assignments.json': [
    {
      id: '8001', name: 'Case 1 memo — segmentation of the running-shoe market',
      due_at: '2026-08-28T04:59:00Z', points_possible: 100,
      description: '<p>Segment the market and defend the segmentation you chose.</p>',
      html_url: 'https://canvas.example.edu/courses/42424/assignments/8001',
    },
    {
      id: '8002', name: 'Case 2 memo — positioning statement',
      due_at: '2026-09-04T04:59:00Z', points_possible: 100,
      description: '<p>Write a positioning statement and a perceptual map.</p>',
      html_url: 'https://canvas.example.edu/courses/42424/assignments/8002',
    },
  ],
  'quizzes.json': [
    {
      id: '6001', title: 'Quiz 2 — positioning', due_at: '2026-09-03T04:59:00Z',
      description: '<p>Covers positioning, perceptual maps and differentiation.</p>',
      html_url: 'https://canvas.example.edu/courses/42424/quizzes/6001',
    },
  ],
  'pages.json': [
    {
      url: 'week-2-notes', title: 'Week 2 notes', page_id: 5001,
      updated_at: '2026-09-01T12:00:00Z',
      body: '<p>Positioning follows segmentation and targeting.</p>',
    },
  ],
  'announcements.json': [
    {
      id: '3001', title: 'Case 1 memo deadline', posted_at: '2026-08-26T15:00:00Z',
      message: '<p>The segmentation memo is due Friday.</p>',
    },
  ],
  'discussions.json': [],
  'materials/week1.pdf.txt':
    'Market segmentation. Segmentation bases: demographic, psychographic, behavioural. '
    + 'Segment the running-shoe market. Targeting follows segmentation.\n',
  'materials/week2.pdf.txt':
    'Positioning. Perceptual maps, points of difference, points of parity. '
    + 'Positioning follows segmentation and targeting for the running-shoe market.\n',
  'syllabus.html': SYLLABUS_HTML,
  'syllabus.hash': createHash('sha256').update(SYLLABUS_HTML).digest('hex'),
  'syllabus_parsed.json': { extracted_at: '2026-08-24T00:00:00Z', textbooks: [], assignments: [] },
  // Must match what buildReadingIndex() now produces for this fixture, or the
  // content-aware writer rewrites it on every run and "only the graph is
  // stale" stops being true — index+mine+build would fire for a class whose
  // readings did not change. The pages_* counters arrived with the class-page
  // source: this fixture's one page carries no date, so it is scanned and
  // contributes nothing, which is exactly what these numbers say.
  'readings_index.json': {
    version: 1,
    source: {
      structured: 'syllabus_parsed.json', raw: 'syllabus.html',
      syllabus_file: null, pages: 'pages.json',
    },
    coverage: {
      structured: 0, raw_fallback: 0,
      pages_scanned: 1, pages: 0, pages_merged: 0, total: 0,
    },
    skipped: [],
    items: [],
    indexed_at: '2026-08-24T00:00:00Z',
  },
  'assignments_mined.json': { items: [], notes: 'fixture' },
  'materials/last_extracted.txt': '2026-08-24T00:00:00Z',
  'AI_CONTEXT/last_built.txt': '2026-08-24T00:00:00Z',
};

async function writeClass(dir, files = CLASS_FILES) {
  for (const [name, body] of Object.entries(files)) {
    const abs = join(dir, name);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

// Seconds-before-now for each tier. The gaps are what make "only the graph is
// stale" a fact about the fixture rather than a hope: every stage's output is
// newer than every input that stage watches.
const AGE = {
  data: 300,       // the raw Canvas JSON, syllabus.html, extracted text bodies
  extracted: 240,  // materials/last_extracted.txt, syllabus_parsed.json
  indexed: 210,    // readings_index.json
  mined: 180,      // assignments_mined.json
  graph: 120,      // correlation_graph.json, when the test wants one already there
  built: 60,       // AI_CONTEXT/last_built.txt
};

async function stampAge(path, secondsAgo) {
  const when = new Date(Date.now() - secondsAgo * 1000);
  await utimes(path, when, when);
}

const RAW_DATA = [
  'files_index.json', 'assignments.json', 'modules.json', 'pages.json',
  'quizzes.json', 'announcements.json', 'discussions.json', 'metadata.json',
  'syllabus.html', 'syllabus.hash', 'materials/week1.pdf.txt', 'materials/week2.pdf.txt',
];

async function stampClass(dir, { graphAge = null } = {}) {
  for (const f of RAW_DATA) await stampAge(join(dir, f), AGE.data);
  await stampAge(join(dir, 'materials/last_extracted.txt'), AGE.extracted);
  await stampAge(join(dir, 'syllabus_parsed.json'), AGE.extracted);
  await stampAge(join(dir, 'readings_index.json'), AGE.indexed);
  await stampAge(join(dir, 'assignments_mined.json'), AGE.mined);
  await stampAge(join(dir, 'AI_CONTEXT/last_built.txt'), AGE.built);
  if (graphAge !== null) await stampAge(join(dir, GRAPH_FILE), graphAge);
}

// A graph already on disk that no rebuild could have produced: zero nodes and
// a marker key. If it survives a run, the stage was skipped; if the marker is
// gone and there are nodes, the stage ran.
const SENTINEL = { version: 1, class: { slug: CLASS_NAME }, nodes: [], edges: [], sentinel: true };

async function makeHome({ withGraph = false, graphAge = AGE.graph } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ccsync-graph-'));
  const dir = join(home, 'classes', CLASS_NAME);
  await writeClass(dir);
  if (withGraph) await writeFile(join(dir, GRAPH_FILE), JSON.stringify(SENTINEL, null, 2));
  await stampClass(dir, { graphAge: withGraph ? graphAge : null });
  return { home, dir };
}

function actionFor(stdout, className = CLASS_NAME) {
  const line = stdout.split('\n').find(l => l.startsWith(className));
  assert.ok(line, `no summary row for ${className} in:\n${stdout}`);
  return line.trim().split(/\s{2,}/)[1];
}

// --- The CLI --------------------------------------------------------------

test('build-graph writes a correlation_graph.json readGraph accepts', async () => {
  const dir = await writeClass(await mkdtemp(join(tmpdir(), 'ccsync-cli-')));
  const res = await runBuildGraph(dir);

  assert.equal(res.code, 0, `exited ${res.code}: ${res.stderr}`);
  const graph = await readGraph(dir);
  assert.ok(graph, 'readGraph() rejected what the CLI wrote');
  assert.equal(graph.version, 1);
  assert.equal(graph.class.slug, basename(dir));
  assert.equal(graph.class.code, 'MKTG 380');
  assert.ok(graph.nodes.length >= 8, `expected the fixture's items as nodes, got ${graph.nodes.length}`);
  assert.ok(graph.edges.length > 0, 'a class whose two weeks share vocabulary produced no edges');
  assert.equal(graph.stats.nodeCount, graph.nodes.length);
  assert.equal(graph.stats.edgeCount, graph.edges.length);

  // Every edge has to land on nodes that exist, or the file is a liability to
  // anything that walks it.
  const ids = new Set(graph.nodes.map(n => n.id));
  for (const e of graph.edges) {
    assert.ok(ids.has(e.a) && ids.has(e.b), `edge ${e.a} → ${e.b} names a node that is not in the graph`);
    assert.ok(e.w > 0 && e.w <= 1, `edge weight out of range: ${e.w}`);
  }
});

test('build-graph reports one summary line to stderr and nothing to stdout', async () => {
  const dir = await writeClass(await mkdtemp(join(tmpdir(), 'ccsync-cli-')));
  const res = await runBuildGraph(dir);

  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, '', `stdout should stay clean for the pipeline: ${res.stdout}`);
  const lines = res.stderr.trim().split('\n');
  assert.equal(lines.length, 1, `expected one line, got:\n${res.stderr}`);
  assert.match(lines[0], /^Written: .*correlation_graph\.json \(\d+ items, \d+ links, density [\d.]+, median degree [\d.]+, [\d.]+KB, \d+ms\)$/);
});

test('build-graph reads the extracted materials, not just the Canvas metadata', async () => {
  // Same class twice: once with materials/*.txt populated, once with the text
  // emptied. "psychographic" exists nowhere in this class except inside the
  // extracted slide text, so its presence in the stored per-node terms is
  // direct evidence the graph consumed the extraction — which is why the stage
  // has to run after extract and not before it.
  const withText = await writeClass(await mkdtemp(join(tmpdir(), 'ccsync-cli-')));
  const noText = { ...CLASS_FILES, 'materials/week1.pdf.txt': '', 'materials/week2.pdf.txt': '' };
  const without = await writeClass(await mkdtemp(join(tmpdir(), 'ccsync-cli-')), noText);

  assert.equal((await runBuildGraph(withText)).code, 0);
  assert.equal((await runBuildGraph(without)).code, 0);

  const a = await readGraph(withText);
  const b = await readGraph(without);
  const termsOf = g => new Set(g.nodes.flatMap(n => Object.keys(n.terms ?? {})));

  assert.equal(a.nodes.length, b.nodes.length, 'node count should not depend on the text');
  assert.ok(termsOf(a).has('psychographic'), 'slide vocabulary never reached the graph');
  assert.ok(!termsOf(b).has('psychographic'), 'fixture leak: the word exists outside the materials');
});

test('build-graph exits non-zero on a class directory that is not there', async () => {
  const missing = join(await mkdtemp(join(tmpdir(), 'ccsync-cli-')), 'no-such-class');
  const res = await runBuildGraph(missing);

  assert.notEqual(res.code, 0, 'a missing class directory must not exit 0');
  assert.match(res.stderr, /not a class directory/);
  assert.ok(!existsSync(join(missing, GRAPH_FILE)), 'wrote a graph for a class that does not exist');
});

test('build-graph exits non-zero with no class directory argument', async () => {
  const res = await runBuildGraph();
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /Usage: node build-graph\.js/);
});

// --- needsGraph, through the pipeline that owns it -------------------------

test('missing graph is built, and the next run with nothing changed skips it', async () => {
  const { home, dir } = await makeHome();
  const file = join(dir, GRAPH_FILE);
  assert.ok(!existsSync(file), 'fixture should start without a graph');

  const first = await runSyncAll(home);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(actionFor(first.stdout), 'graph',
    `only the graph stage should have been stale:\n${first.stdout}`);
  const graph = await readGraph(dir);
  assert.ok(graph?.nodes.length > 0, 'the pipeline did not write a usable graph');

  const before = await stat(file);
  const builtAt = graph.builtAt;

  // Nothing on disk changed between the runs. The second run must not rebuild:
  // same file, same bytes, and the summary must say so.
  const second = await runSyncAll(home);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(actionFor(second.stdout), 'none',
    `second run re-ran a stage with nothing stale:\n${second.stdout}`);
  const after = await stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs, 'the graph was rewritten on an unchanged class');
  assert.equal((await readGraph(dir)).builtAt, builtAt, 'the graph was rebuilt on an unchanged class');
});

test('a graph newer than every source it derives from is left alone', async () => {
  const { home, dir } = await makeHome({ withGraph: true });

  const res = await runSyncAll(home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(actionFor(res.stdout), 'none');
  const graph = JSON.parse(await readFile(join(dir, GRAPH_FILE), 'utf8'));
  assert.equal(graph.sentinel, true, 'a fresh graph was rebuilt anyway');
});

test('a graph older than the class JSON is rebuilt', async () => {
  // Older than every raw data file: the ordinary "Canvas re-synced" case.
  const { home, dir } = await makeHome({ withGraph: true, graphAge: AGE.data + 60 });

  const res = await runSyncAll(home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(actionFor(res.stdout), 'graph', res.stdout);
  const graph = await readGraph(dir);
  assert.equal(graph.sentinel, undefined, 'the stale graph survived the run');
  assert.ok(graph.nodes.length > 0);
});

test('a graph older than the extraction stamp is rebuilt', async () => {
  // Newer than the class JSON, older than materials/last_extracted.txt only.
  // This is the case that makes the stage order load-bearing: freshly extracted
  // text is the graph's entire lexical dimension, and a graph built before the
  // extraction would score the class on titles alone.
  const { home, dir } = await makeHome({ withGraph: true, graphAge: AGE.data - 30 });

  const res = await runSyncAll(home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(actionFor(res.stdout), 'graph', res.stdout);
  assert.equal((await readGraph(dir)).sentinel, undefined, 'the stale graph survived the run');
});

test('a graph older than syllabus.html is rebuilt', async () => {
  // syllabus.html is not in DATA_FILES, so needsBuild cannot see this change.
  // The graph reads it (it is the syllabus node's body) and must.
  const { home, dir } = await makeHome({ withGraph: true });
  await stampAge(join(dir, 'syllabus.html'), AGE.graph - 30);
  await stampAge(join(dir, 'syllabus.hash'), AGE.graph - 30);

  const res = await runSyncAll(home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(actionFor(res.stdout), 'index+graph', res.stdout);
  assert.equal((await readGraph(dir)).sentinel, undefined, 'the stale graph survived the run');
});

test('a class directory with no data at all gets no graph', async () => {
  // outputStale rebuilds a missing output only when a source exists. An empty
  // (or not-yet-synced) class dir must not acquire a graph asserting it holds
  // nothing — and buildGraph must not be spawned just to write one.
  const home = await mkdtemp(join(tmpdir(), 'ccsync-graph-empty-'));
  const dir = join(home, 'classes', '99999-empty-000');
  await mkdir(dir, { recursive: true });

  const res = await runSyncAll(home);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(actionFor(res.stdout, '99999-empty-000'), 'none');
  assert.ok(!existsSync(join(dir, GRAPH_FILE)), 'wrote a graph for a class with no data');
});

test('the summary table has room for every stage that can run', async () => {
  // ACTION holds the '+'-joined stage list and the column TRUNCATES. With the
  // reading index + graph stages make the longest run
  // "parse+extract+index+mine+graph+build" — 36
  // characters — and a narrower column would report it as a run that stopped
  // somewhere in the middle.
  const { home } = await makeHome({ withGraph: true });
  const res = await runSyncAll(home);

  const header = res.stdout.split('\n').find(l => l.includes('CLASS') && l.includes('ACTION'));
  assert.ok(header, `no summary header in:\n${res.stdout}`);
  const actionStart = header.indexOf('ACTION');
  const actionWidth = header.indexOf('MS') - actionStart - 1;
  assert.ok(actionWidth >= 'parse+extract+index+mine+graph+build'.length,
    `ACTION column is ${actionWidth} wide — the full stage list would be truncated`);
});
