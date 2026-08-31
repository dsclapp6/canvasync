// index-progress-contract.test.js — the module and the page must agree.
//
// This test exists because three green suites shipped a page that rendered a
// blank Detail column on every stage of every real class.
//
//   scripts/test/index-progress.test.js  tests the MODULE against fixtures.
//   bridge/test/progress-page.test.js    tests the PAGE against a hand-written
//                                        fixture whose field names were copied
//                                        from a design document.
//   bridge/test/index-progress-route.test.js injects a fake progress model so
//                                        it will not break when the real one
//                                        lands.
//
// All three passed while the page read s.note / s.error / s.exit / s.elapsedSec
// / s.updatedAt and the module emitted staleReason / failureOutput / exitCode /
// durationMs / anchorAt. Nothing joined them, so nothing caught it. Worse, the
// failure was SILENT by design: the page renders anything missing as "unknown"
// rather than throwing, so a renamed field reads as a permanently empty cell.
//
// So: build a real data root, run the real indexProgress() over it, and render
// the real page against the real payload. No fixture anywhere in this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  indexProgress,
  STAGES,
  isUsableSyllabusSource as progressSyllabusSourcePredicate,
} from '../../scripts/index-progress.js';
import {
  isUsableSyllabusSource as triggerSyllabusSourcePredicate,
} from '../trigger.js';

// fileURLToPath, never a raw import.meta.url pathname: the repo path has no
// space and the tmp path does, so a raw compare silently no-ops on this machine.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '..', 'public', 'progress.html');

const REGIONS = ['banner', 'topline', 'pipeline-actions', 'classes', 'global', 'foot', 'pulse', 'poll-note'];

test('scheduler and progress model share the syllabus-source predicate', () => {
  assert.strictEqual(triggerSyllabusSourcePredicate, progressSyllabusSourcePredicate);
});

function stubNode(id) {
  return {
    id, innerHTML: '', textContent: '', className: '', hidden: false, value: '',
    disabled: false, style: { setProperty() {} }, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    parentNode: { appendChild() {} },
    appendChild() {}, addEventListener() {}, closest: () => null,
  };
}

async function renderReal(payload) {
  const html = await fs.readFile(PAGE, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'progress.html must carry exactly one inline <script>');

  const nodes = {};
  for (const id of REGIONS) nodes[id] = stubNode(id);

  const sandbox = {
    document: {
      hidden: false,
      getElementById: (id) => nodes[id] || null,
      createElement: () => stubNode('created'),
      addEventListener() {},
      body: stubNode('body'),
    },
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    console,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    isFinite, isNaN, Intl,
    async fetch(url) {
      if (String(url).includes('class-colors')) {
        return { ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) };
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => payload };
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox, { filename: 'progress.inline.js' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

  return {
    nodes,
    sandbox,
    expandAll() {
      const open = vm.runInContext('OPEN', sandbox);
      for (const c of payload.classes) open.add(c.folder || ('course:' + c.courseId));
      vm.runInContext('renderClasses(LAST)', sandbox);
    },
    markup() {
      return nodes.topline.innerHTML + nodes.classes.innerHTML
        + nodes.global.innerHTML + nodes.foot.innerHTML;
    },
  };
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * A data root shaped like the real one, exercising the states that matter:
 *   93903-x-101-001  fully indexed, but its correlation graph is STALE and the
 *                    graph stage is one the bridge never spawns — the exact
 *                    shape of all five real classes with a graph.
 *   90805-y-202-002  parse output present but TRUNCATED, and newer than its
 *                    source. mtimes alone call that "done".
 */
async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ipcontract-'));
  const classes = path.join(root, 'classes');
  const t0 = Date.now() - 600_000;

  const write = async (rel, body) => {
    const abs = path.join(classes, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, typeof body === 'string' ? body : JSON.stringify(body));
    return abs;
  };
  const touch = (abs, ms) => fs.utimes(abs, new Date(ms), new Date(ms));

  // --- the healthy-but-stale-graph class ---------------------------------
  const A = '93903-x-101-001';
  await write(`${A}/metadata.json`, { course_code: 'X 101 001', name: 'Stale Graph', term: { name: 'Fall 2026' } });
  await write(`${A}/assignments.json`, [{ id: 1, name: 'One' }]);
  await write(`${A}/quizzes.json`, []);
  await write(`${A}/modules.json`, [{ id: 9, items: [{ id: 1 }, { id: 2 }] }]);
  await write(`${A}/pages.json`, []);
  await write(`${A}/announcements.json`, []);
  await write(`${A}/discussions.json`, []);
  await write(`${A}/calendar_events.json`, []);
  await write(`${A}/grades.json`, []);
  // tabs.json deliberately omits "assignments" while assignments.json holds
  // one — an instructor hiding a nav tab, which must never render as
  // "tab is off in Canvas" beside a real count.
  await write(`${A}/tabs.json`, [{ id: 'home' }, { id: 'syllabus' }]);
  await write(`${A}/files_index.json`, [{ id: 5, extractionStatus: 'done', lastSyncedAt: iso(t0) }]);
  await write(`${A}/syllabus.html`, '<p>syllabus</p>');
  await write(`${A}/syllabus_parsed.json`, { extraction_confidence: 'high', schedule: [] });
  await write(`${A}/assignments_mined.json`, { items: [{ category: 'homework', due_date: '2026-09-01' }] });
  const aExtract = await write(`${A}/materials/last_extracted.txt`, iso(t0));
  const aBuild = await write(`${A}/AI_CONTEXT/last_built.txt`, iso(t0));
  await write(`${A}/AI_CONTEXT/context.json`, { last_synced: iso(t0) });
  await fs.mkdir(path.join(classes, A, 'AI_CONTEXT', 'pack'), { recursive: true });
  await fs.writeFile(path.join(classes, A, 'AI_CONTEXT', 'pack', '00.md'), 'x');
  // The graph is older than its inputs: stale, and no bridge button will fix it.
  const aGraph = await write(`${A}/correlation_graph.json`, { stats: { nodeCount: 4, edgeCount: 1 }, builtAt: iso(t0 - 400_000) });
  await touch(aGraph, t0 - 400_000);
  await touch(aExtract, t0 + 10_000);
  await touch(aBuild, t0 + 20_000);

  // --- the truncated-output class ----------------------------------------
  const B = '90805-y-202-002';
  await write(`${B}/metadata.json`, { course_code: 'Y 202 002', name: 'Truncated', term: { name: 'Fall 2026' } });
  await write(`${B}/tabs.json`, [{ id: 'syllabus' }]);
  const bSrc = await write(`${B}/syllabus.html`, '<p>syllabus</p>');
  const bOut = await write(`${B}/syllabus_parsed.json`, '{"extraction_confidence":"hi');
  await touch(bSrc, t0);
  await touch(bOut, t0 + 60_000);   // newer than its source: "done" by mtime alone

  await fs.writeFile(path.join(root, 'last_sync.json'),
    JSON.stringify({ timestamp: iso(t0), coursesSeen: ['93903', '90805'] }));
  await fs.mkdir(path.join(root, 'calendar'), { recursive: true });
  await fs.writeFile(path.join(root, 'calendar', 'worklist.json'), JSON.stringify({
    generated_at: iso(t0),
    window: { from: '2026-08-17', to: '2026-12-29' },
    counts: { meeting: 2, homework: 1, reading: 0, exam: 0, checkpoint: 0 },
    unscheduled_by_kind: { meeting: 0, homework: 0, reading: 1, exam: 0, checkpoint: 0 },
    ops: [
      { class: 'x-101-001', kind: 'meeting', all_day: true, time: null },
      { class: 'x-101-001', kind: 'meeting', all_day: true, time: null },
      { class: 'x-101-001', kind: 'homework', date: '2026-09-01' },
    ],
  }));
  return root;
}

async function realPayload(extra = {}) {
  const root = await makeRoot();
  // scanProcesses:false keeps the suite off the process table; nothing here
  // depends on a live stage.
  return indexProgress(root, { scanProcesses: false, ...extra });
}

test('every stage the module emits must render a non-empty Detail cell on the page', async () => {
  const p = await realPayload();
  const page = await renderReal(p);
  page.expandAll();
  const html = page.nodes.classes.innerHTML;

  // Only the STAGES table is asserted on. A category with nothing extra to say
  // (an empty quizzes.json has no counts, no confidence, no note) legitimately
  // renders an empty Detail; a stage never can — it always has at minimum its
  // script name plus the evidence for whatever state it is in. The exact
  // failure this file was created for is an empty <td class="c-detail"> in the
  // stages table, which is what an unrecognised field name produces.
  // The stages table became a fixed-width list, but the invariant is the same
  // one and for the same reason: every stage row carries a "why" — its evidence,
  // its stale reason, its failure output or why it is not counted. An empty one
  // is what reading a field name the module does not emit looks like.
  const cells = (html.match(/<span class="s-why">/g) || []).length;
  const empty = (html.match(/<span class="s-why"><\/span>/g) || []).length;
  assert.ok(cells > 0, 'no stage rows were rendered at all');
  assert.equal(empty, 0,
    'a stage rendered an empty why — the page is reading a field name the module does not emit');
});

test('the reason a stage is stale must reach the screen, not stop at the payload', async () => {
  const p = await realPayload();
  const cls = p.classes.find((c) => c.folder === '93903-x-101-001');
  const graph = cls.stages.find((s) => s.key === 'graph');
  assert.equal(graph.state, 'stale', 'fixture precondition: the graph must be stale');
  assert.ok(graph.staleReason, 'the module must say WHY it is stale');

  const page = await renderReal(p);
  page.expandAll();
  const html = page.markup();
  // The page compresses "A (<iso>) is newer than B (<iso>)" to "A > B" (escaped
  // to &gt;). What is pinned is that the two filenames — the whole of the
  // evidence — survive the compression, not the connecting phrase.
  assert.ok(/[\w./-]+\.(?:json|txt|md) &gt; [\w./-]+/.test(html),
    'the staleness reason was computed and shipped but never displayed');
});

test('the remaining unwired pack stage must say so where the state is shown', async () => {
  const p = await realPayload();
  const cls = p.classes.find((c) => c.folder === '93903-x-101-001');
  const pack = cls.stages.find((s) => s.key === 'pack2');
  assert.equal(pack.state, 'not-wired');
  const page = await renderReal(p);
  page.expandAll();
  const html = page.markup();
  assert.ok(html.includes('not counted'),
    'an unwired stage rendered as ordinary work the user can wait for');
  assert.ok(html.includes('not wired'),
    'the reason a stage is uncounted must reach the screen');
});

test('the meter and the ratio must agree, because they describe the same stages', async () => {
  const p = await realPayload();
  const page = await renderReal(p);
  const html = page.nodes.classes.innerHTML;

  // One <i> per counted stage, and the ratio's denominator must equal that count.
  const rows = html.split('<li class="cls"');
  for (const row of rows.slice(1)) {
    const bars = (row.match(/<i class="[^"]*"/g) || []).length;
    const m = row.match(/>(\d+)\/(\d+)\*?</);
    if (!m) continue;
    assert.equal(Number(m[2]), bars,
      `ratio says ${m[2]} stages but ${bars} segments were drawn — two sources for one number`);
  }
});

test('a truncated output newer than its source is a failure, not a completed stage', async () => {
  const p = await realPayload();
  const cls = p.classes.find((c) => c.folder === '90805-y-202-002');
  const parse = cls.stages.find((s) => s.key === 'parse');
  assert.equal(parse.state, 'failed',
    'a syllabus_parsed.json that does not parse must not read as done just because its mtime is newer');
  assert.notEqual(cls.overall.percent, 100,
    'a class whose only anchor is corrupt must not report 100%');

  const page = await renderReal(p);
  page.expandAll();
  // The endpoint says "... exists and is newer than its sources, but does not
  // read: <parser error>"; the page compresses that to "unreadable: <error>".
  // What is pinned is that the CAUSE survives the compression, not its wording.
  const why = page.markup();
  assert.ok(/unreadable/.test(why),
    'the page must show why the stage failed, not merely that it did');
});

test('a nav tab that is hidden must not be reported as a disabled feature when data exists', async () => {
  const p = await realPayload();
  const cls = p.classes.find((c) => c.folder === '93903-x-101-001');
  const assignments = cls.categories.find((c) => c.key === 'assignments');
  assert.equal(assignments.count, 1, 'fixture precondition: one assignment on disk');
  assert.notEqual(assignments.applicable, false,
    'tabs.json lists visible NAV entries; it cannot prove a feature is off when the data is right there');
  assert.equal(assignments.tabHidden, true, 'the raw observation should still be reported');

  const page = await renderReal(p);
  page.expandAll();
  assert.ok(!page.markup().includes('tab is off in Canvas'),
    'the page must not print a claim the tab list cannot support');
});

test('every stage key the module defines must have a label on the page', async () => {
  const html = await fs.readFile(PAGE, 'utf8');
  for (const s of STAGES) {
    assert.ok(html.includes("'" + s.key + "'") || html.includes(s.key + ':'),
      `stage "${s.key}" has no vocabulary entry in progress.html — it would render as a bare slug`);
  }
});

test('every category key the module emits must have a label on the page', async () => {
  const p = await realPayload();
  const html = await fs.readFile(PAGE, 'utf8');
  const labels = html.slice(html.indexOf('const CAT_LABEL'), html.indexOf('const CAT_LABEL') + 900);
  const keys = new Set();
  for (const c of p.classes) for (const cat of c.categories) keys.add(cat.key);
  assert.ok(keys.size >= 10, 'fixture precondition: the module emits a full category set');
  for (const k of keys) {
    assert.ok(labels.includes(k + ':'),
      `category "${k}" has no CAT_LABEL entry — it would render as a raw key`);
  }
});

test('the warnings the module raises must be visible on the page, not only in the payload', async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, 'classes', '.DS_Store'), 'junk');
  const p = await indexProgress(root, { scanProcesses: false });
  assert.ok(p.warnings.some((w) => w.includes('.DS_Store')),
    'fixture precondition: a stray entry must raise a warning');

  const page = await renderReal(p);
  assert.ok(page.nodes.global.innerHTML.includes('.DS_Store'),
    'the degradation channel the module was built to expose never reached the screen');
  assert.ok(!page.nodes.classes.innerHTML.includes('.DS_Store'),
    '.DS_Store must be a warning, never a class row');
});

test('a class in the sync scope with no folder on disk must appear, not vanish', async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, 'sync-scope.json'), JSON.stringify({
    courseIds: ['93903', '90805', '99999'], source: 'selection', updatedAt: iso(Date.now()),
  }));
  const p = await indexProgress(root, { scanProcesses: false });
  const ghost = p.classes.find((c) => c.courseId === '99999');
  assert.ok(ghost, 'a selected course with no folder yet was dropped from the report entirely');
  assert.equal(ghost.awaitingFirstSync, true);
  assert.equal(ghost.overall.percent, null, 'nothing measured must not become a percentage');

  const page = await renderReal(p);
  page.expandAll();
  const html = page.markup();
  assert.ok(html.includes('99999'), 'the class the user is most likely watching for was invisible');
  assert.ok(!/\b0 \/ 0 stages\b/.test(html),
    '"0 / 0 stages" claims a measured fraction of nothing');
});
