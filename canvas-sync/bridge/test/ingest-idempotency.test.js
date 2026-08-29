// ingest-idempotency.test.js — the bridge half of a cross-package contract.
//
// extension/background.js retries transport failures through _withRetry, and
// three of its five call sites are POSTs to this server. A transport failure on
// a POST is ambiguous by nature: the write may have landed and only the reply
// been lost. So the extension re-sends, and these endpoints may see the same
// request twice.
//
// That is safe today because these writes overwrite rather than accumulate.
// "Today" is the problem — it is a property nothing enforced, so an
// append-style ingest endpoint written later would break the extension's retry
// policy silently, and the first sign would be duplicated data in a user's
// folder. A comment at each handler says so; this file is what makes the
// contract fail a suite instead.
//
// Companion to the comment at _withRetry in extension/background.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from './helpers/server-factory.js';

const SECRET = 'test-secret-ingest-idempotency';
let server, baseUrl, tmpHome;

const COURSE = {
  id: 92294,
  course_code: 'BUSI 380 002',
  name: 'Marketing Analytics',
  syllabus_body: '<p>Read chapter 1.</p>',
};

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-ingest-idem-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';
  // No extensionId: requireOrigin lets a header-less request through, which is
  // what these tests are — the origin rules are covered in handshake.test.js.
  await fs.writeFile(path.join(tmpHome, 'config.json'),
    JSON.stringify({ bridgeSecret: SECRET }), { mode: 0o600 });
  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  // /ingest/complete schedules a pipeline pass. Point the home at an empty
  // directory first so nothing it does later can reach real data.
  const graveyard = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-ingest-void-'));
  process.env.CANVAS_SYNC_HOME = graveyard;
  delete process.env.BRIDGE_PORT;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function call(method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method,
        headers: {
          'X-Bridge-Secret': SECRET,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        } },
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
    if (payload) req.write(payload);
    req.end();
  });
}

const classDirs = () => fs.readdir(path.join(tmpHome, 'classes')).catch(() => []);

test('a re-sent /ingest/course leaves ONE class, not two', async () => {
  const first = await call('POST', '/ingest/course', { course: COURSE });
  assert.equal(first.status, 200);
  const afterFirst = await classDirs();
  assert.equal(afterFirst.length, 1, 'one course in, one directory out');

  // The retry: byte-identical payload, exactly as _withRetry would re-send it.
  const second = await call('POST', '/ingest/course', { course: COURSE });
  assert.equal(second.status, 200);

  const afterSecond = await classDirs();
  assert.deepEqual(afterSecond, afterFirst,
    'a re-sent course must not create a second directory');
});

test('a re-sent /ingest/course leaves the metadata byte-identical', async () => {
  const [dir] = await classDirs();
  const metaPath = path.join(tmpHome, 'classes', dir, 'metadata.json');

  const before = await fs.readFile(metaPath, 'utf8');
  const { status } = await call('POST', '/ingest/course', { course: COURSE });
  assert.equal(status, 200);
  const after = await fs.readFile(metaPath, 'utf8');

  assert.equal(after, before, 'the write overwrites; it must not accumulate');
  // And it is still one object, not an array something was pushed onto.
  const parsed = JSON.parse(after);
  assert.ok(!Array.isArray(parsed));
  assert.equal(String(parsed.id ?? parsed.course_id ?? COURSE.id), String(COURSE.id));
});

test('a re-sent /ingest/complete leaves one last_sync record, not a list', async () => {
  const seen = [String(COURSE.id)];
  assert.equal((await call('POST', '/ingest/complete', { coursesSeen: seen })).status, 200);
  assert.equal((await call('POST', '/ingest/complete', { coursesSeen: seen })).status, 200);

  const raw = await fs.readFile(path.join(tmpHome, 'last_sync.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(!Array.isArray(parsed), 'last_sync.json is one record');
  assert.deepEqual(parsed.coursesSeen, seen,
    'coursesSeen must be overwritten, not appended to');
  assert.match(parsed.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('the retry contract holds for three attempts, not just two', async () => {
  // SEQUENTIAL on purpose: _withRetry awaits its backoff between attempts, so
  // three re-sends arrive one after another, never at once. Do not "improve"
  // this to Promise.all — concurrent same-destination writes fail for an
  // unrelated reason (storage.js's atomicWrite derives its temp path from the
  // destination plus the pid, so two writers in one process race on one temp
  // file), which the retry policy cannot actually produce. A red test here
  // should mean the write stopped being idempotent, not that someone made the
  // test do something the extension never does.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { status } = await call('POST', '/ingest/course', { course: COURSE });
    assert.equal(status, 200, `attempt ${attempt + 1} accepted`);
  }
  const dirs = await classDirs();
  assert.equal(dirs.length, 1, 'three identical writes, one course');
});
