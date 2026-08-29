// index-progress-route.test.js — the transport around the progress model.
//
// These tests exercise the router directly against a scratch data root rather
// than through helpers/server-factory.js, because the router is not mounted in
// server.js yet (two other workflows own that file today). The mini app below
// reproduces server.js's mount EXACTLY — app.use('/api', dashRouter) with
// requireSecret applied to dashRouter first — so the auth test is a test of the
// documented mount, which is the thing that can actually be got wrong.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { indexProgressRouter, buildFallbackProgress, CLASS_DIR_RE } from '../routes/index-progress.js';

const SECRET = 'test-secret-index-progress';
let tmpHome;
let savedHome, savedBackend;

// Mirrors server.js:150. Copied, not imported: server.js has no export for it,
// and importing server.js would drag in the whole app for a two-line guard.
function requireSecretLike(req, res, next) {
  const header = req.headers['x-bridge-secret'] ?? '';
  if (header.length !== SECRET.length ||
      !crypto.timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(SECRET, 'utf8'))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

const idlePipeline = () => ({ running: false, active: [], queuedCount: 0, maxConcurrent: 3 });

function makeApp({ home = tmpHome, buildProgress = null, pipelineStatus = idlePipeline } = {}) {
  const app = express();
  const dashRouter = express.Router();
  dashRouter.use(requireSecretLike);
  dashRouter.use(indexProgressRouter({ syncHome: () => home, pipelineStatus, buildProgress, bridgePid: 4242 }));
  app.use('/api', dashRouter);
  return app;
}

async function withServer(app, fn) {
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(r => server.close(r));
  }
}

async function apiFetch(baseUrl, pathname, { secret = SECRET } = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    headers: secret ? { 'X-Bridge-Secret': secret } : {},
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body is itself a failure the caller asserts */ }
  return { status: res.status, headers: res.headers, json };
}

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'index-progress-route-'));
  savedHome = process.env.CANVAS_SYNC_HOME;
  savedBackend = process.env.CSYNC_AI_BACKEND;
  // modelLockStatus() resolves its path through dataRoot(), NOT through the
  // home injected into the router. Keep this fixture fully isolated and select
  // local explicitly so the test never depends on the developer's CLI logins.
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.CSYNC_AI_BACKEND = 'local';

  await fs.writeFile(path.join(tmpHome, 'config.json'), JSON.stringify({
    bridgeSecret: SECRET,
    legacyIgnoredApiKey: 'SHOULD-NOT-APPEAR-9999',
  }));
  await fs.writeFile(path.join(tmpHome, 'last_sync.json'), JSON.stringify({
    timestamp: '2026-08-24T17:58:12.136Z',
    coursesSeen: ['93903', '94038'],
  }));
  await fs.writeFile(path.join(tmpHome, 'sync-scope.json'), JSON.stringify({
    courseIds: ['93903'],
    updatedAt: '2026-08-24T17:58:12.136Z',
  }));
  await fs.mkdir(path.join(tmpHome, 'calendar'), { recursive: true });
  await fs.writeFile(path.join(tmpHome, 'calendar', 'worklist.json'), JSON.stringify({
    generated_at: '2026-08-24T18:21:18.349Z',
    window: { from: '2026-08-17', to: '2027-02-20' },
    counts: { meeting: 110, homework: 93, reading: 0, exam: 2, checkpoint: 24 },
    classes: ['busi-380-002'],
    ops: [],
  }));

  const inScope = path.join(tmpHome, 'classes', '93903-busi-380-002');
  await fs.mkdir(inScope, { recursive: true });
  await fs.writeFile(path.join(inScope, 'metadata.json'), JSON.stringify({
    course_code: 'BUSI 380 002',
    name: 'Marketing',
    // Canvas sends enrollment_term as an object and storage.js persists it
    // verbatim — the shape that once rendered as "[object Object]".
    term: { id: 61, name: 'Fall Semester 2026 Full Term', start_at: '2026-08-17T05:00:00Z' },
  }));

  const outOfScope = path.join(tmpHome, 'classes', '94038-entr-222-001');
  await fs.mkdir(outOfScope, { recursive: true });
  await fs.writeFile(path.join(outOfScope, 'metadata.json'), JSON.stringify({ course_code: 'ENTR 222 001' }));

  // The seventh entry. A bare readdir of classes/ returns this alongside the six
  // real folders on the user's machine.
  await fs.writeFile(path.join(tmpHome, 'classes', '.DS_Store'), 'binary junk');
});

after(async () => {
  if (savedHome === undefined) delete process.env.CANVAS_SYNC_HOME; else process.env.CANVAS_SYNC_HOME = savedHome;
  if (savedBackend === undefined) delete process.env.CSYNC_AI_BACKEND; else process.env.CSYNC_AI_BACKEND = savedBackend;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

// --- the mount -------------------------------------------------------------

test('mounted anywhere but under the secret guard, the route publishes the class list to any process on the box', async () => {
  await withServer(makeApp({ buildProgress: buildFallbackProgress }), async (base) => {
    const { status, json } = await apiFetch(base, '/api/index-progress', { secret: null });
    assert.equal(status, 401);
    assert.equal(json.error, 'unauthorized');
    assert.equal(json.classes, undefined);
  });
});

test('a wrong secret is rejected before any disk read', async () => {
  await withServer(makeApp({ buildProgress: buildFallbackProgress }), async (base) => {
    const { status } = await apiFetch(base, '/api/index-progress', { secret: 'x'.repeat(SECRET.length) });
    assert.equal(status, 401);
  });
});

// --- payload shape ---------------------------------------------------------
//
// The fallback builder is injected explicitly in these tests rather than left to
// the default lazy import of scripts/index-progress.js. Once that module exists
// the default path returns ITS object, and a test that asserted the fallback's
// fields through the default path would start failing for a reason that has
// nothing to do with the route.

test('the payload carries every top-level field the progress page reads', async () => {
  await withServer(makeApp({ buildProgress: buildFallbackProgress }), async (base) => {
    const { status, json, headers } = await apiFetch(base, '/api/index-progress');
    assert.equal(status, 200);
    for (const key of ['generatedAt', 'home', 'bridgePid', 'scope', 'lastScrape',
      'pipeline', 'model', 'jobs', 'classes', 'global', 'requiresNewWrites']) {
      assert.ok(key in json, `payload is missing ${key}`);
    }
    assert.equal(json.home, tmpHome);
    assert.equal(json.bridgePid, 4242);
    assert.ok(!Number.isNaN(Date.parse(json.generatedAt)));
    // A poll served from Chrome's heuristic cache is indistinguishable from a
    // pipeline that has stopped moving.
    assert.equal(headers.get('cache-control'), 'no-store');
  });
});

test('.DS_Store must not be enumerated as a class — that is how it reached the meeting-time recovery table', async () => {
  await withServer(makeApp({ buildProgress: buildFallbackProgress }), async (base) => {
    const { json } = await apiFetch(base, '/api/index-progress');
    const folders = json.classes.map(c => c.folder);
    assert.deepEqual(folders, ['93903-busi-380-002', '94038-entr-222-001']);
    assert.ok(!folders.includes('.DS_Store'));
    assert.ok(!CLASS_DIR_RE.test('.DS_Store'));
  });
});

test("a term object from Canvas must not reach the UI as '[object Object]'", async () => {
  await withServer(makeApp({ buildProgress: buildFallbackProgress }), async (base) => {
    const { json } = await apiFetch(base, '/api/index-progress');
    const cls = json.classes.find(c => c.folder === '93903-busi-380-002');
    assert.equal(cls.term, 'Fall Semester 2026 Full Term');
    assert.equal(cls.code, 'BUSI 380 002');
    assert.equal(cls.courseId, '93903');
    assert.equal(cls.slug, 'busi-380-002');
    assert.equal(cls.inScope, true);
    // The mtime of metadata.json is the whole course's write time — all twelve
    // Canvas JSONs land in one Promise.all.
    assert.ok(!Number.isNaN(Date.parse(cls.lastScrapedAt)));
  });
});

test('a class outside the saved scope is listed, not hidden — the page reports what is on disk', async () => {
  await withServer(makeApp({ buildProgress: buildFallbackProgress }), async (base) => {
    const { json } = await apiFetch(base, '/api/index-progress');
    const cls = json.classes.find(c => c.folder === '94038-entr-222-001');
    assert.equal(cls.inScope, false);
    assert.deepEqual(json.scope.courseIds, ['93903']);
    assert.equal(json.scope.source, 'selection');
  });
});

test('an unmeasured class reports state "unknown" rather than 0 of 0 done', async () => {
  await withServer(makeApp({ buildProgress: buildFallbackProgress }), async (base) => {
    const { json } = await apiFetch(base, '/api/index-progress');
    const cls = json.classes[0];
    assert.deepEqual(cls.stages, []);
    assert.deepEqual(cls.categories, []);
    assert.equal(cls.overall.state, 'unknown');
    assert.equal(cls.overall.percent, null);
    assert.ok(Array.isArray(json.degraded.missing));
  });
});

test('lastScrape stays global and the worklist counts pass through unchanged', async () => {
  await withServer(makeApp({ buildProgress: buildFallbackProgress }), async (base) => {
    const { json } = await apiFetch(base, '/api/index-progress');
    assert.equal(json.lastScrape.at, '2026-08-24T17:58:12.136Z');
    assert.deepEqual(json.lastScrape.coursesSeen, ['93903', '94038']);
    assert.equal(json.global.calendar.generatedAt, '2026-08-24T18:21:18.349Z');
    assert.deepEqual(json.global.calendar.window, { from: '2026-08-17', to: '2027-02-20' });
    // reading:0 across a whole term is the real number, not a missing one.
    assert.equal(json.global.calendar.counts.reading, 0);
    assert.equal(json.global.calendar.counts.meeting, 110);
  });
});

test('API keys are never used or exposed by the subscription CLI status', async () => {
  await withServer(makeApp({ buildProgress: buildFallbackProgress }), async (base) => {
    const { json } = await apiFetch(base, '/api/index-progress');
    assert.equal(json.model.apiKeysUsed, false);
    assert.ok(['auto', 'claude', 'codex', 'local'].includes(json.model.backend));
    assert.ok(['claude', 'codex', 'local'].includes(json.model.provider));
    // The whole payload, not just that field: nothing anywhere may carry the key.
    assert.ok(!JSON.stringify(json).includes('SHOULD-NOT-APPEAR-9999'));
  });
});

test('pipelineStatus is passed through with activeCount, and cancelRequested stays null because trigger.js never reports it', async () => {
  const busy = () => ({
    running: true,
    active: ['93903-busi-380-002 · mine-assignments.js', '92354-busi-396-001 · build-context.js'],
    queuedCount: 1,
    maxConcurrent: 3,
  });
  await withServer(makeApp({ buildProgress: buildFallbackProgress, pipelineStatus: busy }), async (base) => {
    const { json } = await apiFetch(base, '/api/index-progress');
    assert.equal(json.pipeline.running, true);
    assert.equal(json.pipeline.activeCount, 2);
    assert.equal(json.pipeline.queuedCount, 1);
    assert.equal(json.pipeline.maxConcurrent, 3);
    assert.equal(json.pipeline.cancelRequested, null);
    assert.equal(json.pipeline.queued, null);
    assert.equal(json.pipeline.active.length, 2);
  });
});

test('a pipelineStatus that throws must not take the poll down with it', async () => {
  const broken = () => { throw new Error('trigger module reloaded'); };
  await withServer(makeApp({ buildProgress: buildFallbackProgress, pipelineStatus: broken }), async (base) => {
    const { status, json } = await apiFetch(base, '/api/index-progress');
    assert.equal(status, 200);
    assert.equal(json.pipeline.running, false);
    assert.equal(json.pipeline.activeCount, 0);
  });
});

// --- empty and broken inputs ----------------------------------------------

test('a data root with no classes/ directory answers 200 with an empty list, not 500 — a fresh install polls this every 3s', async () => {
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'index-progress-empty-'));
  try {
    await withServer(makeApp({ home: emptyHome, buildProgress: buildFallbackProgress }), async (base) => {
      const { status, json } = await apiFetch(base, '/api/index-progress');
      assert.equal(status, 200);
      assert.deepEqual(json.classes, []);
      assert.equal(json.home, emptyHome);
      assert.equal(json.lastScrape.at, null);
      assert.deepEqual(json.lastScrape.coursesSeen, []);
      assert.equal(json.global.calendar.generatedAt, null);
      assert.equal(json.global.calendar.counts, null);
      assert.equal(json.scope.source, 'none');
    });
  } finally {
    await fs.rm(emptyHome, { recursive: true, force: true });
  }
});

test('a data root that does not exist at all answers 200, not ENOENT', async () => {
  const missing = path.join(tmpHome, 'no-such-root');
  await withServer(makeApp({ home: missing, buildProgress: buildFallbackProgress }), async (base) => {
    const { status, json } = await apiFetch(base, '/api/index-progress');
    assert.equal(status, 200);
    assert.deepEqual(json.classes, []);
  });
});

test('a class folder with unreadable metadata still appears, named after its folder', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'index-progress-corrupt-'));
  try {
    const dir = path.join(home, 'classes', '90805-econ-205-002');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'metadata.json'), '{ this is not json');
    await withServer(makeApp({ home, buildProgress: buildFallbackProgress }), async (base) => {
      const { status, json } = await apiFetch(base, '/api/index-progress');
      assert.equal(status, 200);
      assert.equal(json.classes.length, 1);
      assert.equal(json.classes[0].name, '90805-econ-205-002');
      assert.equal(json.classes[0].term, null);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// --- delegation to the progress model --------------------------------------

test('the progress model object is returned verbatim, not merged or reshaped', async () => {
  const model = async (home, opts) => ({
    generatedAt: '2026-08-24T18:12:40.000Z',
    home,
    bridgePid: opts.bridgePid,
    classes: [{ folder: '93903-busi-380-002', overall: { done: 2, total: 4, percent: 50, state: 'running' } }],
    somethingOnlyTheModelKnows: true,
  });
  await withServer(makeApp({ buildProgress: model }), async (base) => {
    const { status, json } = await apiFetch(base, '/api/index-progress');
    assert.equal(status, 200);
    assert.equal(json.somethingOnlyTheModelKnows, true);
    assert.equal(json.classes[0].overall.percent, 50);
    assert.equal(json.bridgePid, 4242);
    assert.equal(json.home, tmpHome);
    // No envelope fields bolted on top of a model that did not ask for them.
    assert.equal(json.degraded, undefined);
  });
});

test('a progress model that throws degrades to the envelope instead of killing the bridge process', async () => {
  const model = async () => { throw new Error('worklist.json is truncated'); };
  await withServer(makeApp({ buildProgress: model }), async (base) => {
    const { status, json } = await apiFetch(base, '/api/index-progress');
    assert.equal(status, 200);
    assert.match(json.degraded.reason, /progress model threw: worklist\.json is truncated/);
    assert.equal(json.classes.length, 2); // the envelope still lists what is on disk
  });
});

test('a progress model that returns a string is not forwarded as the payload', async () => {
  const model = async () => 'nope';
  await withServer(makeApp({ buildProgress: model }), async (base) => {
    const { status, json } = await apiFetch(base, '/api/index-progress');
    assert.equal(status, 200);
    assert.match(json.degraded.reason, /non-object/);
    assert.ok(Array.isArray(json.classes));
  });
});

test('with no model injected the route still answers a valid payload', async () => {
  // Deliberately loose: this passes both before scripts/index-progress.js exists
  // (fallback envelope) and after it lands (the model's own object).
  await withServer(makeApp({}), async (base) => {
    const { status, json } = await apiFetch(base, '/api/index-progress');
    assert.equal(status, 200);
    assert.equal(typeof json, 'object');
    assert.ok(Array.isArray(json.classes));
    assert.ok(!Number.isNaN(Date.parse(json.generatedAt)));
  });
});

test('a mount that forgets syncHome fails at startup, not by reporting zero classes forever', async () => {
  assert.throws(() => indexProgressRouter({ pipelineStatus: idlePipeline }), /syncHome must be a function/);
});

test('two polls arriving together run one build, not two — the Electron shell and a browser tab both poll at 3s', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const model = async () => { calls += 1; await gate; return { generatedAt: new Date().toISOString(), classes: [] }; };
  await withServer(makeApp({ buildProgress: model }), async (base) => {
    const first = apiFetch(base, '/api/index-progress');
    const second = apiFetch(base, '/api/index-progress');
    await new Promise(r => setTimeout(r, 100));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(calls, 1);
    // The coalesced build must be released for the NEXT poll, not latched.
    const third = await apiFetch(base, '/api/index-progress');
    assert.equal(third.status, 200);
    assert.equal(calls, 2);
  });
});
