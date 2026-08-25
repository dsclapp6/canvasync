// pipeline-control.test.js — crash-prevention behavior of the pipeline API:
// run refuses to double-start (409), cancel stops a pass, status reports
// pipeline state, and ingest rejects untracked classes server-side (410).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../test/helpers/server-factory.js';

let server, baseUrl, tmpHome;
const SECRET = 'pipe-secret-abc';
const EXT_ID = 'extpipelinetest';

function request(method, urlPath, { body = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: new URL(baseUrl).port,
      path: urlPath,
      method,
      headers: {
        'X-Bridge-Secret': SECRET,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-pipe-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';
  process.env.CLAUDE_SKIP = '1';           // stage scripts stub out AI calls

  const config = {
    bridgeSecret: SECRET,
    extensionId: EXT_ID,
    untracked: ['999-dead-class'],
  };
  await fs.writeFile(path.join(tmpHome, 'config.json'), JSON.stringify(config), { mode: 0o600 });

  // One class dir with a stale parse stage so a pipeline pass has real work
  // (the 1.5s spawn pacing then keeps it "running" long enough to observe).
  const classDir = path.join(tmpHome, 'classes', '101-test-course');
  await fs.mkdir(classDir, { recursive: true });
  await fs.writeFile(path.join(classDir, 'syllabus.html'), '<html><body>Test syllabus, weekly reading due Fridays.</body></html>');

  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Make sure nothing is left running before teardown.
  await request('POST', '/api/pipeline/cancel', { body: {} }).catch(() => {});
  await new Promise(resolve => server.close(resolve));
  delete process.env.CANVAS_SYNC_HOME;
  delete process.env.BRIDGE_PORT;
  delete process.env.CLAUDE_SKIP;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

test('status reports pipeline state with a sane concurrency cap', async () => {
  const r = await request('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.pipeline, 'object');
  assert.equal(r.json.pipeline.running, false);
  assert.ok(r.json.pipeline.maxConcurrent >= 1 && r.json.pipeline.maxConcurrent <= 8);
});

test('run starts a pass; a second run is refused with 409; cancel stops it', async () => {
  const first = await request('POST', '/api/pipeline/run', { body: {} });
  assert.equal(first.status, 200);
  assert.equal(first.json.started, true);

  // The pass is now running (spawn pacing keeps it alive well past this point).
  const second = await request('POST', '/api/pipeline/run', { body: {} });
  assert.equal(second.status, 409);
  assert.equal(second.json.pipeline.running, true);

  // Wait until the pass is demonstrably mid-flight (a job active or queued)
  // before cancelling — otherwise a cancel landing on an already-empty pass
  // can't distinguish real cancellation from natural completion.
  let midFlight = false;
  for (let i = 0; i < 20 && !midFlight; i++) {
    const st = await request('GET', '/api/status');
    midFlight = st.json.pipeline.running &&
      (st.json.pipeline.active.length > 0 || st.json.pipeline.queuedCount > 0);
    if (!midFlight) await new Promise(r => setTimeout(r, 150));
  }
  assert.equal(midFlight, true, 'pass never reached a running/queued job');

  const cancel = await request('POST', '/api/pipeline/cancel', { body: {} });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.ok, true);

  // The pass winds down: queued jobs skip, running children get SIGTERM.
  let running = true;
  for (let i = 0; i < 40 && running; i++) {
    await new Promise(r => setTimeout(r, 250));
    const st = await request('GET', '/api/status');
    running = st.json.pipeline.running;
  }
  assert.equal(running, false, 'pipeline should stop after cancel');

  // Behavioral proof the cancel actually happened (a no-op cancelPipeline
  // regression would let the pass finish naturally and this line disappears):
  // at least one queued job must have been SKIPped due to cancellation, and
  // the CANCEL marker must be in the log.
  const log = await fs.readFile(path.join(tmpHome, 'logs', 'trigger.log'), 'utf8');
  assert.match(log, /CANCEL requested/, 'cancelPipeline must log the cancel');
  assert.match(log, /SKIP .+\(cancelled\)/, 'queued jobs must be skipped due to cancel');
});

test('cancel while idle is a harmless no-op', async () => {
  const r = await request('POST', '/api/pipeline/cancel', { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.signalled, 0);
});

test('ingest rejects untracked classes with 410 (server-side backstop)', async () => {
  const origin = `chrome-extension://${EXT_ID}`;
  const r = await request('POST', '/ingest/course', {
    origin,
    body: { course: { id: 999, course_code: 'DEAD 101', name: 'Deleted Class' } },
  });
  assert.equal(r.status, 410);
  assert.equal(r.json.error, 'course untracked');

  const dir = path.join(tmpHome, 'classes', '999-dead-class');
  await assert.rejects(fs.stat(dir), 'untracked class folder must not be recreated');
});

test('ingest still accepts tracked classes', async () => {
  const origin = `chrome-extension://${EXT_ID}`;
  const r = await request('POST', '/ingest/course', {
    origin,
    body: { course: { id: 555, course_code: 'LIVE 101', name: 'Tracked Class' }, assignments: [] },
  });
  assert.equal(r.status, 200);
  const st = await fs.stat(path.join(tmpHome, 'classes', '555-live-101'));
  assert.ok(st.isDirectory());
});
