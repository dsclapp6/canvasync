// index-progress.test.js — the progress model must never flatter the data.
//
// Every test here is named after a way this page could lie to the user: a class
// that has never been touched reading as complete, a dead lock holder reading
// as a running job, a Canvas "feature disabled" body reading as one page, a
// truncated JSON file taking the whole report down with it.
//
// All fixtures are built under mkdtemp. Nothing in here reads or writes
// ~/canvas-sync-data — CANVAS_SYNC_HOME is pointed at the fixture before each
// call, because the model/provider status helpers resolve their own paths
// through dataRoot().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, readdir, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { indexProgress, formatProgress, STAGES } from '../index-progress.js';

const SENTINEL = { message: 'That page has been disabled for this course' };
const T0 = new Date('2026-08-01T12:00:00.000Z');
const at = seconds => new Date(T0.getTime() + seconds * 1000);

async function newRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'csync-progress-'));
  process.env.CANVAS_SYNC_HOME = root;
  return root;
}

async function writeJson(p, value) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
}

async function touch(p, when) {
  await utimes(p, when, when);
}

const SYLLABUS_HTML = '<html><body><p>BUSI 101 meets M/W 2:30-3:45pm in McNair 330.</p></body></html>';

/**
 * A class with every stage's inputs AND outputs on disk, and every anchor
 * stamped later than its sources so no stage is stale.
 */
async function writeFullClass(root, folder) {
  const dir = path.join(root, 'classes', folder);
  await mkdir(path.join(dir, 'files'), { recursive: true });
  await mkdir(path.join(dir, 'materials'), { recursive: true });

  const sources = {
    'metadata.json': { id: folder.split('-')[0], name: 'BUSI 101 F26', course_code: 'BUSI 101 001', term: { name: 'Fall Semester 2026 Full Term' } },
    'tabs.json': [{ id: 'assignments' }, { id: 'quizzes' }, { id: 'modules' }, { id: 'announcements' }, { id: 'grades' }],
    'assignments.json': [{ id: 1, name: 'HW1', due_at: '2026-09-01T04:59:00Z' }],
    'assignment_groups.json': [],
    // Five of the six real classes hold exactly this instead of a quiz list.
    'quizzes.json': [SENTINEL],
    'pages.json': [SENTINEL],
    'modules.json': [{ id: 1, name: 'Week 1', items: [{ id: 11 }, { id: 12 }] }],
    'announcements.json': [{ id: 9, title: 'Welcome' }],
    'discussions.json': [],
    'calendar_events.json': [],
    'grades.json': [{ grades: { current_score: 91, current_grade: 'A-' } }],
    'files_index.json': [
      { canvasId: 1, duplicateOf: null, extractionStatus: 'done', canvasUpdatedAt: '2026-01-01T00:00:00Z', lastSyncedAt: '2026-01-02T00:00:00Z' },
      // canvasUpdatedAt AFTER lastSyncedAt: the one genuine "Canvas has newer
      // data than we do" signal anywhere in this system.
      { canvasId: 2, duplicateOf: null, extractionStatus: 'done', canvasUpdatedAt: '2026-02-01T00:00:00Z', lastSyncedAt: '2026-01-02T00:00:00Z' },
    ],
  };
  for (const [name, value] of Object.entries(sources)) await writeJson(path.join(dir, name), value);
  await writeFile(path.join(dir, 'files', 'lecture01.pdf'), 'pretend pdf', 'utf8');
  await writeFile(path.join(dir, 'syllabus.html'), SYLLABUS_HTML, 'utf8');
  const hash = createHash('sha256').update(SYLLABUS_HTML).digest('hex');
  await writeFile(path.join(dir, 'syllabus.hash'), hash, 'utf8');

  // Outputs.
  await writeJson(path.join(dir, 'syllabus_parsed.json'), {
    extracted_at: at(1).toISOString(), source_file: path.join(dir, 'syllabus.html'),
    source_hash: hash, extraction_confidence: 'high',
  });
  await writeFile(path.join(dir, 'materials', 'last_extracted.txt'), at(2).toISOString(), 'utf8');
  await writeJson(path.join(dir, 'readings_index.json'), {
    version: 1, coverage: { structured: 0, raw_fallback: 0, total: 0 }, items: [],
  });
  await writeJson(path.join(dir, 'correlation_graph.json'), {
    builtAt: at(3).toISOString(),
    stats: { nodeCount: 5, edgeCount: 3, density: 0.3, medianDegree: 2, skipped: { unusable: 1 } },
  });
  await writeJson(path.join(dir, 'assignments_mined.json'), {
    mined_at: at(4).toISOString(),
    items: [
      { id: 'a', title: 'HW1', category: 'homework', due_date: '2026-09-01' },
      { id: 'b', title: 'Ch. 3', category: 'reading', due_date: null },
    ],
  });
  await writeJson(path.join(dir, 'AI_CONTEXT', 'context.json'), { last_synced: at(5).toISOString() });
  await writeFile(path.join(dir, 'AI_CONTEXT', 'context.md'), '# ctx', 'utf8');
  await mkdir(path.join(dir, 'AI_CONTEXT', 'pack'), { recursive: true });
  await writeFile(path.join(dir, 'AI_CONTEXT', 'pack', 'README.md'), 'pack', 'utf8');
  await writeFile(path.join(dir, 'AI_CONTEXT', 'last_built.txt'), at(5).toISOString(), 'utf8');

  // Stamp sources first, then each anchor after everything it depends on.
  for (const name of Object.keys(sources)) await touch(path.join(dir, name), T0);
  await touch(path.join(dir, 'files', 'lecture01.pdf'), T0);
  await touch(path.join(dir, 'syllabus.html'), T0);
  await touch(path.join(dir, 'syllabus.hash'), T0);
  await touch(path.join(dir, 'syllabus_parsed.json'), at(1));
  await touch(path.join(dir, 'materials', 'last_extracted.txt'), at(2));
  await touch(path.join(dir, 'readings_index.json'), at(3));
  await touch(path.join(dir, 'correlation_graph.json'), at(3));
  await touch(path.join(dir, 'assignments_mined.json'), at(4));
  await touch(path.join(dir, 'AI_CONTEXT', 'last_built.txt'), at(5));
  return dir;
}

const stageOf = (cls, key) => cls.stages.find(s => s.key === key);
const catOf = (cls, key) => cls.categories.find(c => c.key === key);
const classOf = (p, folder) => p.classes.find(c => c.folder === folder);

const NO_SCAN = { scanProcesses: false };

// ---------------------------------------------------------------------------

test('a data root that does not exist must report nothing, not throw', async () => {
  const root = path.join(tmpdir(), `csync-progress-absent-${process.pid}-${Date.now()}`);
  process.env.CANVAS_SYNC_HOME = root;
  const p = await indexProgress(root, NO_SCAN);
  assert.equal(p.error, null);
  assert.deepEqual(p.classes, []);
  assert.ok(p.warnings.some(w => w.includes('does not exist')), 'the missing root must be stated, not silently rendered as "all done"');
  assert.equal(p.global.progress.percent, null, 'no denominator means no percentage');
  assert.doesNotThrow(() => formatProgress(p));
});

test('an empty data root must render as a first run, never as 100% complete', async () => {
  const root = await newRoot();
  const p = await indexProgress(root, NO_SCAN);
  assert.equal(p.error, null);
  assert.deepEqual(p.classes, []);
  assert.equal(p.global.progress.stagesTotal, 0);
  assert.equal(p.global.progress.percent, null,
    'zero stages out of zero is not 100% — that is the exact lie this module exists to prevent');
});

test('an empty class directory is a class that has not started, not a class that is done', async () => {
  const root = await newRoot();
  await mkdir(path.join(root, 'classes', '20005-chem-001-001'), { recursive: true });
  const p = await indexProgress(root, NO_SCAN);
  const c = classOf(p, '20005-chem-001-001');
  assert.ok(c, 'a class dir with nothing in it yet is the NORMAL first-run state');
  assert.equal(c.overall.total, 0);
  assert.equal(c.overall.percent, null);
  assert.equal(c.overall.state, 'not-started');
  for (const key of ['parse', 'extract', 'index', 'mine', 'build']) {
    assert.equal(stageOf(c, key).state, 'n-a', `${key} has no inputs, which is not a gap to be counted`);
  }
});

test('.DS_Store must never be enumerated as a class', async () => {
  const root = await newRoot();
  await mkdir(path.join(root, 'classes'), { recursive: true });
  await writeFile(path.join(root, 'classes', '.DS_Store'), 'binary junk', 'utf8');
  await mkdir(path.join(root, 'classes', 'Archive'), { recursive: true });
  await writeFullClass(root, '20001-busi-101-001');

  const p = await indexProgress(root, NO_SCAN);
  assert.deepEqual(p.classes.map(c => c.folder), ['20001-busi-101-001']);
  assert.ok(p.global.rejectedDirEntries.includes('.DS_Store'));
  assert.ok(p.global.rejectedDirEntries.includes('Archive'));
  assert.ok(p.warnings.some(w => w.includes('.DS_Store')),
    'the rejected entries must be reported — silently dropping them is how .DS_Store reached the meeting-time output');
});

test('a class holding only metadata.json must report the context stage not-started, not done', async () => {
  const root = await newRoot();
  const dir = path.join(root, 'classes', '20004-math-100-001');
  await writeJson(path.join(dir, 'metadata.json'), { id: '20004', course_code: 'MATH 100', name: 'Calc' });
  const p = await indexProgress(root, NO_SCAN);
  const c = classOf(p, '20004-math-100-001');

  assert.equal(c.code, 'MATH 100');
  assert.equal(stageOf(c, 'parse').state, 'n-a', 'no syllabus was ever delivered');
  assert.equal(stageOf(c, 'extract').state, 'n-a', 'no files_index.json');
  assert.equal(stageOf(c, 'index').state, 'not-started', 'metadata can supply the term year once a reading source arrives');
  assert.equal(stageOf(c, 'mine').state, 'n-a', 'metadata.json is deliberately not a mining source');
  assert.equal(stageOf(c, 'graph').state, 'not-started', 'metadata is enough to seed the relationship graph');
  assert.equal(stageOf(c, 'build').state, 'not-started');
  assert.equal(stageOf(c, 'build').stale, true, 'a source exists and the anchor does not');
  assert.equal(c.overall.total, 3);
  assert.equal(c.overall.done, 0);
  assert.equal(c.overall.percent, 0);
  assert.match(c.overall.denominator, /3 counted stage\(s\): index, graph, build/);
});

test('a fully indexed class reports every counted stage done, and says which stages it refused to count', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  const p = await indexProgress(root, NO_SCAN);
  const c = classOf(p, '20001-busi-101-001');

  for (const key of ['parse', 'extract', 'index', 'mine', 'build']) {
    assert.equal(stageOf(c, key).state, 'done', `${key}: ${stageOf(c, key).evidence}`);
  }
  assert.equal(c.overall.done, 6);
  assert.equal(c.overall.total, 6);
  assert.equal(c.overall.percent, 100);
  assert.match(c.overall.denominator, /6 counted stage\(s\): parse, extract, index, mine, graph, build/,
    'the denominator must appear next to the percentage, always');

  // Graph is now runnable from Status; pack2 remains experimental and unwired.
  assert.equal(stageOf(c, 'graph').counted, true);
  assert.equal(stageOf(c, 'graph').state, 'done');
  assert.equal(stageOf(c, 'pack2').state, 'not-wired');
  assert.deepEqual(c.overall.excluded.map(e => e.key), ['pack2']);
});

test('a Canvas disabled-feature body must not be counted as one page and one quiz', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  const p = await indexProgress(root, NO_SCAN);
  const c = classOf(p, '20001-busi-101-001');

  assert.equal(catOf(c, 'quizzes').count, 0, 'a one-element [{message}] array is zero quizzes, not one');
  assert.equal(catOf(c, 'quizzes').state, 'unavailable');
  assert.equal(catOf(c, 'pages').count, 0);
  assert.equal(catOf(c, 'pages').state, 'unavailable');
  assert.equal(catOf(c, 'modules').count, 1);
  assert.equal(catOf(c, 'modules').itemCount, 2);
  assert.equal(catOf(c, 'discussions').applicable, false, 'the discussions tab is not enabled for this course');
});

test('calendar_events being empty is a correct empty, not a failed index', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  const p = await indexProgress(root, NO_SCAN);
  const cat = catOf(classOf(p, '20001-busi-101-001'), 'calendarEvents');
  assert.equal(cat.count, 0);
  assert.equal(cat.state, 'none-published');
});

test('a file Canvas updated after our last sync must be counted, since it is the only such signal we have', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  const p = await indexProgress(root, NO_SCAN);
  const files = catOf(classOf(p, '20001-busi-101-001'), 'files');
  assert.equal(files.count, 2);
  assert.equal(files.indexed, 2);
  assert.equal(files.canvasNewer, 1);
  assert.equal(files.state, 'complete');
});

test('mined categories must report all nine, so reading:0 is visible instead of missing', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  const p = await indexProgress(root, NO_SCAN);
  const mined = catOf(classOf(p, '20001-busi-101-001'), 'minedTasks');
  assert.equal(mined.count, 2);
  assert.equal(mined.datedCount, 1);
  assert.equal(mined.byCategory.homework, 1);
  assert.equal(mined.byCategory.reading, 1);
  assert.equal(mined.byCategory.exam, 0, 'an empty category must be present as 0, not absent');
  assert.equal(Object.keys(mined.byCategory).length, 9);
});

test('a source newer than the mined output must read as stale, not as done', async () => {
  const root = await newRoot();
  const dir = await writeFullClass(root, '20002-econ-999-001');
  // A fresh scrape of modules.json, after mining ran.
  await touch(path.join(dir, 'modules.json'), at(600));

  const p = await indexProgress(root, NO_SCAN);
  const c = classOf(p, '20002-econ-999-001');
  assert.equal(stageOf(c, 'mine').state, 'stale');
  assert.match(stageOf(c, 'mine').staleReason, /modules\.json .* is newer than assignments_mined\.json/);
  assert.equal(stageOf(c, 'build').state, 'stale');
  assert.equal(stageOf(c, 'parse').state, 'done', 'a changed modules.json has nothing to do with the syllabus');
  assert.equal(c.overall.state, 'stale');
  assert.equal(c.overall.done, 3);
  assert.equal(c.overall.percent, 50);
});

test('a byte-identical syllabus rewrite must not re-fire the AI parse stage forever', async () => {
  const root = await newRoot();
  const dir = await writeFullClass(root, '20001-busi-101-001');
  // Exactly what the bridge does on every ingest: rewrite syllabus.html with
  // the same bytes. mtime alone would report this AI stage stale for eternity.
  await writeFile(path.join(dir, 'syllabus.html'), SYLLABUS_HTML, 'utf8');
  await touch(path.join(dir, 'syllabus.html'), at(900));

  const p = await indexProgress(root, NO_SCAN);
  const parse = stageOf(classOf(p, '20001-busi-101-001'), 'parse');
  assert.equal(parse.state, 'done');
  assert.equal(parse.stale, false);
  assert.match(String(parse.evidence), /byte-identically/);
});

test('a genuinely changed syllabus must re-fire the parse stage', async () => {
  const root = await newRoot();
  const dir = await writeFullClass(root, '20001-busi-101-001');
  await writeFile(path.join(dir, 'syllabus.html'), SYLLABUS_HTML + '<p>Room changed to McNair 210.</p>', 'utf8');
  await touch(path.join(dir, 'syllabus.html'), at(900));

  const p = await indexProgress(root, NO_SCAN);
  const parse = stageOf(classOf(p, '20001-busi-101-001'), 'parse');
  assert.equal(parse.state, 'stale');
  assert.match(String(parse.staleReason), /syllabus\.hash matches none/);
});

test('corrupt JSON must degrade to an error state, not take the whole report down', async () => {
  const root = await newRoot();
  const dir = path.join(root, 'classes', '20003-hist-777-001');
  await writeJson(path.join(dir, 'metadata.json'), { course_code: 'HIST 777', name: 'Broken' });
  await writeFile(path.join(dir, 'assignments.json'), '[{"id": 1, "name": "trunc', 'utf8');
  await writeFile(path.join(dir, 'assignments_mined.json'), 'this is not json at all', 'utf8');
  await writeFile(path.join(dir, 'files_index.json'), '{oops', 'utf8');
  await writeJson(path.join(dir, 'tabs.json'), [{ id: 'assignments' }]);

  const p = await indexProgress(root, NO_SCAN);
  assert.equal(p.error, null, 'one truncated file must not fail the poll for every other class');
  const c = classOf(p, '20003-hist-777-001');
  assert.equal(catOf(c, 'assignments').state, 'error');
  assert.match(catOf(c, 'assignments').note, /invalid JSON/);
  assert.equal(catOf(c, 'minedTasks').state, 'error');
  assert.equal(catOf(c, 'files').state, 'error');
  assert.equal(catOf(c, 'assignments').count, null,
    'an unparseable file has an UNKNOWN count — reporting 0 would read as "Canvas has no assignments"');
  assert.doesNotThrow(() => formatProgress(p));
});

test('a model lock held by a live pid must be attributed, not reported as free', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  await mkdir(path.join(root, 'locks', 'local-model.lock'), { recursive: true });
  await writeFile(path.join(root, 'locks', 'local-model.lock', 'pid'), String(process.pid), 'utf8');

  const p = await indexProgress(root, NO_SCAN);
  assert.equal(p.model.lock.held, true);
  assert.equal(p.model.lock.alive, true);
  assert.equal(p.model.lock.pid, process.pid);
  // The bridge runs class-chat in-process, so localInvoke writes the BRIDGE's
  // pid — a lock whose holder is the reporting process is a chat, not a stage.
  assert.equal(p.model.lock.holderKind, 'class-chat');

  const asOther = await indexProgress(root, { ...NO_SCAN, hostPid: 1 });
  assert.equal(asOther.model.lock.holderKind, 'unknown',
    'without the process table a lock holder that is not us and not a known job is unidentifiable, and must say so');
});

test('a model lock held by a DEAD pid must not produce a phantom running job', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  await mkdir(path.join(root, 'locks', 'local-model.lock'), { recursive: true });
  // 999999 is beyond macOS's pid range, so it can never be alive.
  await writeFile(path.join(root, 'locks', 'local-model.lock', 'pid'), '999999', 'utf8');
  await touch(path.join(root, 'locks', 'local-model.lock', 'pid'), new Date(Date.now() - 60000));

  const p = await indexProgress(root, NO_SCAN);
  assert.equal(p.model.lock.held, true);
  assert.equal(p.model.lock.alive, false, 'a stale lock dir is held but not alive');
  assert.deepEqual(p.jobs, [], 'a dead lock holder is not a running job');
  assert.deepEqual(p.model.waiting, [], 'nothing is waiting behind a holder that no longer exists');
  const c = classOf(p, '20001-busi-101-001');
  for (const s of c.stages) assert.notEqual(s.state, 'running', `${s.key} must not be reported running on the strength of a dead lock`);
  assert.equal(c.overall.blocked, null);
});

test('a stage the bridge reports active is running, and a stale one beside it is queued, not done', async () => {
  const root = await newRoot();
  const dir = await writeFullClass(root, '20002-econ-999-001');
  await touch(path.join(dir, 'modules.json'), at(600)); // makes mine + build stale

  const p = await indexProgress(root, {
    ...NO_SCAN,
    pipelineStatus: () => ({
      running: true,
      active: ['20002-econ-999-001 · mine-assignments.js'],
      queuedCount: 1,
      maxConcurrent: 3,
    }),
  });
  const c = classOf(p, '20002-econ-999-001');
  assert.equal(stageOf(c, 'mine').state, 'running');
  assert.equal(stageOf(c, 'mine').stateBasis, 'pipelineStatus()');
  assert.equal(stageOf(c, 'build').state, 'queued');
  assert.equal(stageOf(c, 'build').queuedBasis, 'inferred',
    "the pipeline reports only how many jobs are queued, never which — so 'queued' can only ever be inference");
  assert.equal(c.overall.state, 'running');
  assert.equal(p.pipeline.available, true);
  assert.equal(p.jobs.length, 1);
  assert.equal(p.jobs[0].needsModel, true);
  assert.equal(p.pipeline.queued.length, 0);
  assert.match(p.pipeline._gap, /queued\[\] names/);
});

test('with no bridge state at all, the pipeline must say it cannot see, not say idle', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  const p = await indexProgress(root, NO_SCAN);
  assert.equal(p.pipeline.available, false);
  assert.equal(p.pipeline.running, null, 'null is "unknown"; false would be a claim we cannot support');
  assert.equal(p.pipeline.queuedCount, null);
});

test('a START with no END and no way to check liveness must say it is one of two things', async () => {
  const root = await newRoot();
  const dir = await writeFullClass(root, '20001-busi-101-001');
  await mkdir(path.join(root, 'logs'), { recursive: true });
  await writeFile(path.join(root, 'logs', 'trigger.log'),
    `2026-08-24T18:08:18.019Z START mine-assignments.js ${dir}\n`, 'utf8');

  const noWay = await indexProgress(root, NO_SCAN);
  const stage = stageOf(classOf(noWay, '20001-busi-101-001'), 'mine');
  assert.equal(stage.state, 'running-or-interrupted');
  assert.match(stage.evidence, /genuinely two situations/);
  assert.equal(noWay.jobs[0].state, 'running-or-interrupted');
  assert.equal(noWay.jobs[0].startedAt, '2026-08-24T18:08:18.019Z');

  // With the process table available and nothing alive, it is an orphan.
  const scanned = await indexProgress(root, { scanProcesses: true });
  const orphan = stageOf(classOf(scanned, '20001-busi-101-001'), 'mine');
  assert.equal(orphan.state, 'interrupted');
  assert.match(orphan.evidence, /orphaned/);
});

test('a stage that exited non-zero must read as failed, with the output block attached', async () => {
  const root = await newRoot();
  const dir = await writeFullClass(root, '20001-busi-101-001');
  await mkdir(path.join(root, 'logs'), { recursive: true });
  await writeFile(path.join(root, 'logs', 'trigger.log'), [
    `2026-08-24T18:00:00.000Z START mine-assignments.js ${dir}`,
    `2026-08-24T18:04:00.000Z END mine-assignments.js ${dir} exit=1`,
    `2026-08-24T18:04:00.001Z OUTPUT mine-assignments.js ${dir}`,
    'claude exited 1: Invalid API key · Please run /login',
    '--- end output ---',
    '',
  ].join('\n'), 'utf8');

  const p = await indexProgress(root, NO_SCAN);
  const stage = stageOf(classOf(p, '20001-busi-101-001'), 'mine');
  assert.equal(stage.state, 'failed');
  assert.equal(stage.exitCode, 1);
  assert.equal(stage.durationMs, 240000);
  assert.match(stage.failureOutput, /Invalid API key/,
    'the reason a stage failed is the whole point of showing that it failed');
});

test('a stage cancelled by the user must not be reported as a failure', async () => {
  const root = await newRoot();
  const dir = await writeFullClass(root, '20001-busi-101-001');
  await mkdir(path.join(root, 'logs'), { recursive: true });
  await writeFile(path.join(root, 'logs', 'trigger.log'), [
    `2026-08-24T18:00:00.000Z START mine-assignments.js ${dir}`,
    `2026-08-24T18:04:00.000Z END mine-assignments.js ${dir} exit=143`,
    '',
  ].join('\n'), 'utf8');

  const p = await indexProgress(root, NO_SCAN);
  const stage = stageOf(classOf(p, '20001-busi-101-001'), 'mine');
  assert.equal(stage.state, 'cancelled', 'exit 143 is SIGTERM — the user did this, it is not a defect');
});

test('a failed global calendar run is retryable even when an older worklist still reads', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  const classesDir = path.join(root, 'classes');
  await writeJson(path.join(root, 'calendar', 'worklist.json'), {
    generated_at: '2026-08-24T17:00:00.000Z',
    counts: { homework: 1 },
    ops: [],
  });
  await mkdir(path.join(root, 'logs'), { recursive: true });
  await writeFile(path.join(root, 'logs', 'trigger.log'), [
    `2026-08-24T18:00:00.000Z START sync-calendar.js ${classesDir}`,
    `2026-08-24T18:00:01.000Z END sync-calendar.js ${classesDir} exit=1`,
    `2026-08-24T18:00:01.001Z OUTPUT sync-calendar.js ${classesDir}`,
    'calendar write failed: disk full',
    '--- end output ---',
    '',
  ].join('\n'), 'utf8');

  const p = await indexProgress(root, NO_SCAN);
  assert.equal(p.global.calendar.state, 'failed');
  assert.equal(p.global.calendar.exitCode, 1);
  assert.match(p.global.calendar.failureOutput, /disk full/);
});

test('a mining error sidecar older than the output must not mark the class failed forever', async () => {
  const root = await newRoot();
  const dir = await writeFullClass(root, '20001-busi-101-001');
  // mine-assignments.js writes this sidecar on failure and NEVER removes it on
  // success, so a consumer that reads presence alone brands the class failed
  // for the rest of the term.
  await writeFile(path.join(dir, 'assignments_mined.json.ERROR'), 'garbled model output', 'utf8');
  await touch(path.join(dir, 'assignments_mined.json.ERROR'), at(2));

  const p = await indexProgress(root, NO_SCAN);
  const c = classOf(p, '20001-busi-101-001');
  assert.equal(stageOf(c, 'mine').state, 'done');
  assert.equal(stageOf(c, 'mine').errorSidecar.fresh, false);
  assert.match(stageOf(c, 'mine').errorSidecar.evidence, /predates the current output/);
  assert.equal(catOf(c, 'minedTasks').state, 'complete');

  // Newer than the output, it IS the current state.
  await touch(path.join(dir, 'assignments_mined.json.ERROR'), at(60));
  const p2 = await indexProgress(root, NO_SCAN);
  const c2 = classOf(p2, '20001-busi-101-001');
  assert.equal(stageOf(c2, 'mine').state, 'failed');
  assert.equal(catOf(c2, 'minedTasks').state, 'error');
});

test('a syllabus error sidecar is a current failure, because parse deletes it on success', async () => {
  const root = await newRoot();
  const dir = await writeFullClass(root, '20001-busi-101-001');
  await writeFile(path.join(dir, 'syllabus_parsed.json.ERROR'), 'not json', 'utf8');
  await touch(path.join(dir, 'syllabus_parsed.json.ERROR'), at(0));

  const p = await indexProgress(root, NO_SCAN);
  const c = classOf(p, '20001-busi-101-001');
  assert.equal(stageOf(c, 'parse').state, 'failed');
  assert.equal(catOf(c, 'syllabus').state, 'error');
});

test('classes outside the sync scope must be listed but marked, never silently dropped', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  await writeFullClass(root, '20009-dead-orientation-001');
  await writeJson(path.join(root, 'sync-scope.json'), { courseIds: ['20001'], updatedAt: '2026-08-24T17:57:36.903Z' });

  const p = await indexProgress(root, NO_SCAN);
  assert.equal(classOf(p, '20001-busi-101-001').inScope, true);
  assert.equal(classOf(p, '20009-dead-orientation-001').inScope, false);
  assert.equal(p.scope.source, 'selection');
  assert.equal(p.global.unscopedClasses.count, 1);
  assert.deepEqual(p.global.unscopedClasses.folders, ['20009-dead-orientation-001']);
  assert.equal(p.global.unscopedClasses.totalBytes, null,
    'a recursive size walk has no business on a 3-second poll, and null says so');
});

test('the worklist is read per class by slug, with every kind present including the zeroes', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  await writeJson(path.join(root, 'calendar', 'worklist.json'), {
    generated_at: '2026-08-24T18:21:18.349Z',
    window: { from: '2026-08-17', to: '2027-02-20' },
    counts: { meeting: 2, homework: 1, reading: 0, exam: 0, checkpoint: 0 },
    ops: [
      { class: 'busi-101-001', kind: 'meeting', all_day: true, time: null },
      { class: 'busi-101-001', kind: 'meeting', all_day: false, time: '14:30' },
      { class: 'busi-101-001', kind: 'homework' },
      { class: 'some-other-class', kind: 'exam' },
    ],
  });

  const p = await indexProgress(root, NO_SCAN);
  const ops = catOf(classOf(p, '20001-busi-101-001'), 'calendarOps');
  assert.equal(ops.count, 3, 'ops are matched on the slug, not the folder');
  assert.equal(ops.byKind.meeting, 2);
  assert.equal(ops.byKind.reading, 0);
  assert.equal(ops.timedMeetings, 1);
  assert.equal(p.global.calendar.generatedAt, '2026-08-24T18:21:18.349Z');
});

test('the report must not write a single byte into the data root', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  await writeJson(path.join(root, 'calendar', 'worklist.json'), { generated_at: 'x', ops: [] });
  await mkdir(path.join(root, 'locks', 'local-model.lock'), { recursive: true });
  await writeFile(path.join(root, 'locks', 'local-model.lock', 'pid'), String(process.pid), 'utf8');

  const snapshot = async dir => {
    const out = [];
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const st = await stat(full);
      if (st.isDirectory()) out.push(`${full}/`, ...(await snapshot(full)));
      else out.push(`${full} ${st.size} ${st.mtimeMs}`);
    }
    return out;
  };

  const before = await snapshot(root);
  await indexProgress(root, { scanProcesses: true });
  const after = await snapshot(root);
  assert.deepEqual(after, before,
    'this module is read-only; it must never create, touch or reclaim anything — least of all the model lock');
});

test('the CLI summary must render every state without throwing', async () => {
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  const dir = await writeFullClass(root, '20002-econ-999-001');
  await touch(path.join(dir, 'modules.json'), at(600));
  await mkdir(path.join(root, 'classes', '20005-chem-001-001'), { recursive: true });
  await writeFile(path.join(root, 'classes', '.DS_Store'), 'junk', 'utf8');

  const p = await indexProgress(root, NO_SCAN);
  const text = formatProgress(p);
  assert.match(text, /20001-busi-101-001/);
  assert.match(text, /20005-chem-001-001/);
  assert.ok(!text.includes('.DS_Store\n'), '.DS_Store must not appear as a table row');
  for (const s of STAGES) assert.ok(text.includes(s.key), `the ${s.key} column must be present`);
  assert.match(text, /counted stage\(s\)/, 'every percentage in the summary is printed next to its denominator');
});

test.after(async () => {
  delete process.env.CANVAS_SYNC_HOME;
  // Fixture roots are left to the OS tmp reaper only if this fails; clean the
  // ones we can still name.
  await rm(path.join(tmpdir(), 'csync-progress-nonexistent'), { recursive: true, force: true }).catch(() => {});
});

// --- what the verify pass found: five ways this page still lied -------------

test('an anchor that exists but does not parse must read as failed, never as done', async () => {
  // The 100%-over-garbage bug. Stage state was decided purely by "is the anchor
  // file newer than its inputs?" — so a truncated assignments_mined.json, which
  // is exactly what a killed mine-assignments.js leaves behind, satisfied the
  // freshness test and the class reported every stage done while the pipeline's
  // one real output was unreadable.
  const root = await newRoot();
  const dir = await writeFullClass(root, '20001-busi-101-001');
  await writeFile(path.join(dir, 'assignments_mined.json'), '{"mined_at":"2026-08-01T12:00:04.000Z","items":[{"id":"a"', 'utf8');
  await touch(path.join(dir, 'assignments_mined.json'), at(4)); // still newer than every source

  const p = await indexProgress(root, NO_SCAN);
  const c = classOf(p, '20001-busi-101-001');
  const mine = stageOf(c, 'mine');
  assert.equal(mine.state, 'failed', 'a file that does not read is not a finished stage');
  assert.equal(mine.stateBasis, 'anchor content');
  assert.match(mine.evidence, /does not read/);
  assert.notEqual(c.overall.percent, 100, 'the class must not report 100% on top of unusable output');
});

test('a stage whose category merely errs on one item is not marked failed', async () => {
  // The other half of the same rule. extract-course-files' `files` category
  // goes 'error' when a single PDF fails to extract — that is partial output,
  // not an unreadable anchor, and calling it a failed stage would flag a class
  // that is working. Only the four anchors in ANCHOR_CATEGORY are cross-checked.
  const root = await newRoot();
  const dir = await writeFullClass(root, '20001-busi-101-001');
  await writeFile(path.join(dir, 'files_index.json'), '{truncated', 'utf8');
  await touch(path.join(dir, 'files_index.json'), T0);

  const p = await indexProgress(root, NO_SCAN);
  const c = classOf(p, '20001-busi-101-001');
  assert.equal(catOf(c, 'files').state, 'error');
  assert.notEqual(stageOf(c, 'extract').state, 'failed',
    'one unextractable PDF is not a failed extraction stage');
});

test('a nav tab Canvas does not list must not be reported as a disabled feature when data was synced anyway', async () => {
  // tabs.json lists the NAV entries a course shows, not the features it has
  // enabled. Reading it as "feature off" printed "disabled" beside 7 synced
  // assignments sitting on disk — the page asserting a fact the disk refutes.
  const root = await newRoot();
  const dir = await writeFullClass(root, '20001-busi-101-001');
  await writeJson(path.join(dir, 'tabs.json'), [{ id: 'modules' }, { id: 'grades' }]);
  await touch(path.join(dir, 'tabs.json'), T0);

  const p = await indexProgress(root, NO_SCAN);
  const a = catOf(classOf(p, '20001-busi-101-001'), 'assignments');
  assert.equal(a.count, 1, 'the synced items are still on disk and still counted');
  assert.equal(a.tabHidden, true);
  assert.equal(a.applicable, null, 'not listed + data present = unknown, and unknown is the honest answer');
  assert.match(a.note, /lists visible NAV entries, not enabled features/);
});

test('a nav tab that is absent with nothing synced behind it is a genuinely absent feature', async () => {
  const root = await newRoot();
  const dir = await writeFullClass(root, '20001-busi-101-001');
  await writeJson(path.join(dir, 'tabs.json'), [{ id: 'assignments' }, { id: 'modules' }]);
  await writeJson(path.join(dir, 'discussions.json'), []);
  await touch(path.join(dir, 'tabs.json'), T0);

  const p = await indexProgress(root, NO_SCAN);
  const d = catOf(classOf(p, '20001-busi-101-001'), 'discussions');
  assert.equal(d.applicable, false);
  assert.equal(d.tabHidden, true);
  assert.match(d.note, /nothing was synced/);
});

test('a course in the sync scope with no folder yet must appear as awaiting sync, not vanish', async () => {
  // The user selects classes in the extension; folders appear only after the
  // extension delivers them. A scoped course with no folder was invisible —
  // indistinguishable from "not selected", which is how a class silently
  // missing from the report reads as a class that is fine.
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  await writeJson(path.join(root, 'sync-scope.json'), { courseIds: ['20001', '20077'], updatedAt: T0.toISOString() });

  const p = await indexProgress(root, NO_SCAN);
  const waiting = p.classes.find(c => c.courseId === '20077');
  assert.ok(waiting, 'a scoped course with no folder must still get a row');
  assert.equal(waiting.folder, null);
  assert.equal(waiting.awaitingFirstSync, true);
  assert.equal(waiting.overall.state, 'awaiting-first-sync');
  assert.equal(waiting.overall.percent, null, 'nothing has failed and nothing has arrived — there is no percentage');
  assert.deepEqual(waiting.stages, [], 'no folder means no stage has any evidence either way');
  assert.ok(p.warnings.some(w => w.includes('20077')));
  assert.doesNotThrow(() => formatProgress(p));
});

test('a data root with no classes/ directory must say so instead of reporting an empty course list', async () => {
  const root = await newRoot();
  await writeJson(path.join(root, 'last_sync.json'), { at: T0.toISOString() });
  const p = await indexProgress(root, NO_SCAN);
  assert.deepEqual(p.classes, []);
  assert.ok(p.warnings.some(w => /no classes\/ directory/.test(w)),
    'an empty list and a missing directory are different facts and must not render alike');
});

test('a class-shaped entry that is not a directory must be reported, not silently dropped', async () => {
  // Only the regex-reject path fed `rejected`; a name that MATCHED the class
  // pattern but was a file (or unreadable) got no row and no warning at all.
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  await writeFile(path.join(root, 'classes', '20042-phil-200-001'), 'not a directory', 'utf8');

  const p = await indexProgress(root, NO_SCAN);
  assert.equal(p.classes.length, 1);
  assert.ok(p.warnings.some(w => w.includes('20042-phil-200-001') && /not a directory/.test(w)));
});

test('a two-hour-old pid-less lock is abandoned, not a holder still mid-acquire', async () => {
  // "mid-acquire" names the microseconds between mkdir and writeFile in
  // _acquireModelLock. Applying it to a lock hours old produced the sentence
  // "model lock: HELD ... for 7412s, holder mid-acquire", which reads as a
  // healthy job and is why nobody reclaimed it.
  const root = await newRoot();
  await writeFullClass(root, '20001-busi-101-001');
  const lock = path.join(root, 'locks', 'local-model.lock');
  await mkdir(lock, { recursive: true });
  const old = new Date(Date.now() - 7_412_000);
  await utimes(lock, old, old);

  const p = await indexProgress(root, NO_SCAN);
  assert.equal(p.model.lock.held, true);
  assert.equal(p.model.lock.pid, null);
  assert.equal(p.model.lock.holderKind, 'abandoned');
  assert.equal(p.model.lock.alive, false);

  const fresh = path.join(root, 'locks2');
  await mkdir(path.join(fresh, 'locks', 'local-model.lock'), { recursive: true });
  process.env.CANVAS_SYNC_HOME = fresh;
  const p2 = await indexProgress(fresh, NO_SCAN);
  assert.equal(p2.model.lock.holderKind, 'mid-acquire',
    'inside the 10s window the same shape genuinely is a holder between mkdir and writeFile');
});

test('the newly runnable graph can queue, while the unwired pack still cannot', async () => {
  const root = await newRoot();
  const dir = await writeFullClass(root, '20002-econ-999-001');
  await touch(path.join(dir, 'modules.json'), at(600)); // makes graph, mine and build stale

  const p = await indexProgress(root, {
    ...NO_SCAN,
    pipelineStatus: () => ({ running: true, active: [], queuedCount: 2, maxConcurrent: 3 }),
  });
  const c = classOf(p, '20002-econ-999-001');
  assert.equal(stageOf(c, 'graph').counted, true);
  assert.equal(stageOf(c, 'graph').state, 'queued', 'the Status-page graph action makes this real queued work');
  assert.notEqual(stageOf(c, 'pack2').state, 'queued', 'the unwired pack must never promise queued work');
  assert.equal(stageOf(c, 'mine').state, 'queued', 'a counted stale stage beside a live pipeline still is');
});

test('a stage switched off in Settings is uncounted, never stale or queued', async () => {
  // The Functions card writes CSYNC_STAGE_MINE="0" into settings.json and
  // trigger.js stops spawning the stage. From that moment "stale" and
  // "queued" are both promises no orchestrator will keep — the honest report
  // is the same shape cli-only stages use: not counted, with the reason.
  const root = await newRoot();
  delete process.env.CSYNC_STAGE_MINE;
  const dir = await writeFullClass(root, '20003-busi-777-001');
  await touch(path.join(dir, 'modules.json'), at(600)); // mine + build go stale
  await writeJson(path.join(root, 'settings.json'), { env: { CSYNC_STAGE_MINE: '0' } });

  const p = await indexProgress(root, {
    ...NO_SCAN,
    pipelineStatus: () => ({ running: true, active: [], queuedCount: 2, maxConcurrent: 3 }),
  });
  const c = classOf(p, '20003-busi-777-001');
  assert.equal(stageOf(c, 'mine').counted, false);
  assert.equal(stageOf(c, 'mine').notCountedReason, 'off-in-settings');
  assert.notEqual(stageOf(c, 'mine').state, 'queued', 'trigger.js skips this stage, so nothing is queued');
  assert.notEqual(stageOf(c, 'mine').state, 'stale', 'stale is the same unkeepable promise as queued');
  assert.equal(stageOf(c, 'mine').state, 'done', 'the anchor exists; off means nothing will refresh it');
  assert.equal(stageOf(c, 'mine').stale, true, 'the raw staleness fact stays available to the detail view');
  // The denominator agrees: build (stale but on) still counts, mine does not.
  assert.ok(!c.overall.denominator.includes('mine'),
    'an off stage must leave the progress denominator');
  assert.equal(stageOf(c, 'build').state, 'queued', 'the stage beside it is untouched');

  // Absent settings — or the switch back on — restores the stage.
  await writeJson(path.join(root, 'settings.json'), { env: {} });
  const p2 = await indexProgress(root, NO_SCAN);
  assert.equal(stageOf(classOf(p2, '20003-busi-777-001'), 'mine').counted, true);
});
