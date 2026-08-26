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
const LONG_ID = 's2a-concept-check-consider-different-ways-to-define-your-customers';
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
    { id: 'proj-1', title: 'Course Project', category: 'project', canvas_assignment_id: 71,
      related_materials: [{ file: 'Project Brief.pdf', why: 'requirements' }] },
    { id: 'exam-1', title: 'Midterm Exam', kind: 'implicit', category: 'exam', due_date: '2026-10-07',
      related_materials: [{ file: 'Session 4 - Exam Review slides', why: 'review' }] },
    // A real 66-character id from BUSI 380's mined file. The model writes the
    // id, so its length is whatever the title was.
    { id: LONG_ID, title: 'S2a Concept Check: consider different ways to define your customers',
      category: 'homework', canvas_assignment_id: 71 },
  ] }));
  await fs.writeFile(path.join(classDir, 'files_index.json'), JSON.stringify([
    { canvasId: 901, displayName: 'Project Brief.pdf', localPath: 'files/Project Brief.pdf',
      materialsPath: 'materials/Project Brief.pdf.txt', extractionStatus: 'done' },
  ]));
  await fs.writeFile(path.join(classDir, 'pages.json'), JSON.stringify([
    { page_id: 44, title: 'Session 4 - Exam Review - 9/15',
      html_url: 'https://canvas.rice.edu/courses/92294/pages/session-4',
      body: '<p>Review chapters 1–4.</p>', updated_at: '2026-09-14T12:00:00Z' },
  ]));
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
  assert.equal(body.mined.related_materials[0].source.type, 'file');
  assert.equal(body.mined.related_materials[0].source.localPath, 'files/Project Brief.pdf');
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
  assert.equal(body.mined.related_materials[0].source.type, 'page');
  assert.equal(body.mined.related_materials[0].source.pageId, '44');
});

test('a linked Canvas page body is fetched only when the viewer opens it', async () => {
  const { status, body } = await get(`/api/class/${FOLDER}/page/44`);
  assert.equal(status, 200);
  assert.equal(body.title, 'Session 4 - Exam Review - 9/15');
  assert.match(body.body_html, /Review chapters/);
  assert.equal(body.canvas_url, 'https://canvas.rice.edu/courses/92294/pages/session-4');
});

test('the class task bundle carries the same material links', async () => {
  const { status, body } = await get(`/api/class/${FOLDER}`);
  assert.equal(status, 200);
  const project = body.mined.items.find(item => item.id === 'proj-1');
  assert.equal(project.related_materials[0].source.type, 'file');
});

test('a long mined id opens — the calendar addresses rows by exactly this id', async () => {
  // The route capped ids at 64 chars while the miner writes whatever the
  // model produced (BUSI 380 really holds ids of 65 and 66). Those calendar
  // rows 400'd into a toast and no panel — a dead link — while the tick
  // checkbox on the same row worked, because user-state allows 200.
  assert.equal(LONG_ID.length, 66);
  const res = await get(`/api/class/${FOLDER}/assignment/${LONG_ID}`);
  assert.equal(res.status, 200, 'a mined id the miner can write must be openable');
  assert.equal(res.body.origin, 'canvas', 'and it follows its claim to the Canvas row');
  assert.ok(res.body.url, 'with real Canvas links, not a dead panel');
});

test('an id longer than the shared 200-char ceiling is still refused', async () => {
  const res = await get(`/api/class/${FOLDER}/assignment/${'x'.repeat(201)}`);
  assert.equal(res.status, 400);
});
