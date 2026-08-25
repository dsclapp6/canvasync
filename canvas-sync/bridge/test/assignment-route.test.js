// assignment-route.test.js — one assignment, looked up every way a client asks.
//
// The calendar opens items by their MINED id (that is what an op's item_id
// holds), and until 2026-08-25 the route only looked the Canvas row up by the
// id in the URL — so a merged item opened from the calendar arrived with no
// Canvas links and would have worn a "not a Canvas assignment" notice it does
// not deserve. These tests pin the claim-following lookup and the `origin`
// field the panel keys that notice on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from './helpers/server-factory.js';

const SECRET = 'test-secret-assignment';
const FOLDER = '92294-busi-305-001';
let server, baseUrl, tmpHome;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-assign-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';
  await fs.writeFile(path.join(tmpHome, 'config.json'),
    JSON.stringify({ bridgeSecret: SECRET }), { mode: 0o600 });
  const classDir = path.join(tmpHome, 'classes', FOLDER);
  await fs.mkdir(classDir, { recursive: true });
  await fs.writeFile(path.join(classDir, 'metadata.json'), JSON.stringify({ name: 'BUSI 305', course_code: 'BUSI 305 001' }));
  await fs.writeFile(path.join(classDir, 'assignments.json'), JSON.stringify([
    { id: 71, name: 'Course Project', due_at: '2026-10-01T04:59:00Z',
      html_url: 'https://canvas.rice.edu/courses/92294/assignments/71',
      submission_types: ['online_upload'] },
  ]));
  await fs.writeFile(path.join(classDir, 'assignments_mined.json'), JSON.stringify({ items: [
    { id: 'proj-1', title: 'Course Project', category: 'project', canvas_assignment_id: 71 },
    { id: 'exam-1', title: 'Midterm Exam', kind: 'implicit', category: 'exam', due_date: '2026-10-07' },
  ] }));
  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // GET-only tests schedule no rebuild, but the graveyard swap costs nothing
  // and keeps a future edit here from ever reaching real data.
  await new Promise(resolve => server.close(resolve));
  const graveyard = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-assign-void-'));
  process.env.CANVAS_SYNC_HOME = graveyard;
  delete process.env.BRIDGE_PORT;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function get(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET',
        headers: { 'X-Bridge-Secret': SECRET } },
      res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
    req.on('error', reject);
    req.end();
  });
}

test('asked by mined id, the route follows the claim to the Canvas row', async () => {
  const { status, body } = await get(`/api/class/${FOLDER}/assignment/proj-1`);
  assert.equal(status, 200);
  assert.equal(body.canvas_id, 71);
  assert.equal(body.origin, 'canvas');
  assert.equal(body.url, 'https://canvas.rice.edu/courses/92294/assignments/71');
  assert.ok(body.submit_url, 'submittable work shows its submit link');
});

test('asked by Canvas id, same answer', async () => {
  const { status, body } = await get(`/api/class/${FOLDER}/assignment/canvas-71`);
  assert.equal(status, 200);
  assert.equal(body.canvas_id, 71);
  assert.equal(body.origin, 'canvas');
});

test('a mined-only item is origin syllabus, with nothing to open or submit', async () => {
  const { status, body } = await get(`/api/class/${FOLDER}/assignment/exam-1`);
  assert.equal(status, 200);
  assert.equal(body.origin, 'syllabus');
  assert.equal(body.canvas_id, null);
  assert.equal(body.url, null);
  assert.equal(body.submit_url, null);
});
