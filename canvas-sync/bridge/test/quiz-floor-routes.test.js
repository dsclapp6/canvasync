// quiz-floor-routes.test.js — the class page showing the same work the calendar does.
//
// tasksForClass gained a `quizzes` argument so a DATED practice quiz or ungraded
// survey — one with no assignment row behind it, living only in quizzes.json —
// stops depending on the model mentioning it (Codex H1). sync-calendar passes it;
// the bridge's three call sites did not, so the calendar would have shown a quiz
// the class page denied. One file for all three because they must agree with each
// other: a count on a card, a list on a page and a panel opened from either. A
// test that pinned only one would let the other two drift apart again, which is
// the exact failure being fixed.
//
// PLANTED POSITIVE, and worth repeating: all 39 dated quizzes in the user's six
// live classes have assignment rows behind them, so nothing here reproduces an
// outage. It closes a hole.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from './helpers/server-factory.js';

const SECRET = 'test-secret-quiz-floor';
const FOLDER = '93903-busi-380-002';
let server, baseUrl, tmpHome;

const PRACTICE_QUIZ = {
  id: 7001,
  title: 'Practice: Segmentation drill',
  quiz_type: 'practice_quiz',
  due_at: '2026-03-12T05:59:00Z',
  html_url: 'https://canvas.rice.edu/courses/93903/quizzes/7001',
};
const GRADED_ROW = {
  id: 532620,
  name: 'S9-Concept Check: Product Line Depth',
  due_at: '2026-03-10T05:59:00Z',
  quiz_id: 244811,
  html_url: 'https://canvas.rice.edu/courses/93903/assignments/532620',
};

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-quizfloor-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';
  await fs.writeFile(path.join(tmpHome, 'config.json'),
    JSON.stringify({ bridgeSecret: SECRET }), { mode: 0o600 });
  const dir = path.join(tmpHome, 'classes', FOLDER);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'metadata.json'),
    JSON.stringify({ name: 'Marketing', course_code: 'BUSI 380 002' }));
  await fs.writeFile(path.join(dir, 'assignments.json'), JSON.stringify([GRADED_ROW]));
  // The graded quiz is here too, exactly as Canvas reports it: it has an
  // assignment row, so the floor must leave it alone and only the practice one
  // should appear. A fixture with the unbacked quiz alone could not tell the
  // difference between "the floor works" and "the floor emits everything".
  await fs.writeFile(path.join(dir, 'quizzes.json'), JSON.stringify([
    PRACTICE_QUIZ,
    { id: 244811, title: 'S9 Concept Check', due_at: '2026-03-10T05:59:00Z' },
  ]));
  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  delete process.env.CANVAS_SYNC_HOME;
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
          let body = null;
          try { body = JSON.parse(raw); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body });
        });
      });
    req.on('error', reject);
    req.end();
  });
}

test('the class card counts the practice quiz', async () => {
  const { status, body } = await get('/api/classes');
  assert.equal(status, 200);
  const card = (body.classes ?? body).find?.(c => c.folder === FOLDER)
    ?? (body.classes ?? []).find(c => c.folder === FOLDER);
  assert.ok(card, 'the class is listed');
  assert.equal(card.taskCount, 2,
    'one graded assignment plus one unbacked practice quiz — the card must agree '
    + 'with the page and the calendar, which is the whole reason the count goes '
    + 'through the merge');
});

test('the class page lists it as Canvas work, not as an AI find', async () => {
  const { status, body } = await get(`/api/class/${FOLDER}`);
  assert.equal(status, 200);
  const items = body.mined?.items ?? [];
  const quiz = items.find(i => i.id === 'canvas-quiz-7001');
  assert.ok(quiz, `the practice quiz is missing from the class page: ${items.map(i => i.id)}`);
  assert.equal(quiz.origin, 'canvas',
    'Canvas holds it and it has a link to take — "syllabus" would tell the user '
    + 'the AI invented it');
  assert.match(quiz.submit_url, /\/quizzes\/7001\/take$/);
  // The graded quiz must still arrive exactly once, through its assignment row.
  const graded = items.filter(i => String(i.canvas_assignment_id ?? '') === '532620');
  assert.equal(graded.length, 1, 'a quiz with an assignment row must not be doubled');
  assert.ok(!items.some(i => i.id === 'canvas-quiz-244811'));
});

test('the assignment panel opens it', async () => {
  // The panel resolves through the same merge, so a quiz the merge does not
  // emit is a panel that answers "Untitled" for a real Canvas quiz.
  const { status, body } = await get(`/api/class/${FOLDER}/assignment/canvas-quiz-7001`);
  assert.equal(status, 200);
  assert.equal(body.name, 'Practice: Segmentation drill');
  // Derived from the fixture rather than written out: due_at is 05:59Z, which
  // is the previous day west of UTC-6, and a hardcoded date makes this a test
  // that only passes in some timezones.
  const local = new Date(PRACTICE_QUIZ.due_at);
  assert.equal(body.due_date,
    `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`);
});
