// killswitch.test.js — integration test for DISABLED kill switch
// OPEN: uses BRIDGE_PORT=0 (ephemeral) and CANVAS_SYNC_HOME=<tmpdir>.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../test/helpers/server-factory.js';

let server, baseUrl, tmpHome;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-ks-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';

  const config = {
    bridgeSecret: 'ks-secret-abc',
    extensionId: 'ext-killswitch-test',
  };
  await fs.writeFile(path.join(tmpHome, 'config.json'), JSON.stringify(config), { mode: 0o600 });

  // Create the DISABLED file.
  await fs.writeFile(path.join(tmpHome, 'DISABLED'), '');

  server = await createServer();
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  delete process.env.CANVAS_SYNC_HOME;
  delete process.env.BRIDGE_PORT;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function postIngest(url, body, secret, origin) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Bridge-Secret': secret,
        'Origin': origin,
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('killswitch: POST /ingest/course returns 503 when DISABLED', async () => {
  const res = await postIngest(
    `${baseUrl}/ingest/course`,
    { course: { id: 1, course_code: 'KS101' } },
    'ks-secret-abc',
    'chrome-extension://ext-killswitch-test'
  );
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'bridge disabled');
});

test('killswitch: GET /health still works when DISABLED', async () => {
  const res = await new Promise((resolve, reject) => {
    const urlObj = new URL(`${baseUrl}/health`);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'GET',
      headers: { 'X-Bridge-Secret': 'ks-secret-abc' },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

// Every route that spawns or schedules sync-calendar.js must be behind the
// switch too. These four were not: with DISABLED present the app refused
// /api/calendar/rebuild while a meeting save quietly spawned the very same
// child and rewrote worklist.json and all four .ics files.
function reqDash(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + pathname);
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'X-Bridge-Secret': 'ks-secret-abc' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { let p = null; try { p = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: p }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('killswitch: dashboard mutation routes are all 503', async () => {
  const folder = '92294-busi-305-001';
  const calls = [
    ['POST', `/api/class/${folder}/meetings`, { days: ['TU'], start: '10:50', end: '12:05' }],
    ['POST', `/api/class/${folder}/meetings/revert`, {}],
    ['DELETE', `/api/class/${folder}/meetings`, undefined],
    ['POST', `/api/class/${folder}/task/abc`, { done: true }],
    ['PUT', `/api/class/${folder}/textbooks/book-0123456789abcdef`, { url: null }],
  ];
  for (const [method, pathname, body] of calls) {
    const res = await reqDash(method, pathname, body);
    assert.equal(res.status, 503, `${method} ${pathname} must refuse while disabled`);
    assert.equal(res.body.error, 'bridge disabled');
  }
});

test('killswitch: /api/status still answers, and says it is disabled', async () => {
  // The one field that lets the dashboard tell the user why nothing works.
  const res = await reqDash('GET', '/api/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.disabled, true);
});
