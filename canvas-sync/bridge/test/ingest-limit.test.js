// ingest-limit.test.js — ONE body limit, read by the two things that must agree.
//
// The desync this closes: express.json read config.maxIngestMb while the
// extension hardcoded 200 MB and sized its own pre-flight gate from that. Lower
// the config and the extension would download a large file in full, post it,
// and take a 413 — every sync, forever, with the file never landing. The limit
// is now sent on the handshake response and on every /health probe, and the
// extension derives its gate from that (extension/background.js's
// _ingestLimit(), fallback BRIDGE_BODY_LIMIT_MB_FALLBACK for an old bridge).
//
// The default is 400 MB and the ceiling is not a preference: the body is base64
// inside ONE JSON string on both sides, and V8 caps a string at ~512 MB
// (buffer.constants.MAX_STRING_LENGTH = 536,870,888). A larger limit cannot be
// honoured by either end, whatever it claims — see the test at the bottom,
// which pins the default below that ceiling rather than trusting a comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { constants as bufferConstants } from 'node:buffer';

import { DEFAULT_MAX_INGEST_MB, maxIngestMb } from '../server.js';
import { createServer } from './helpers/server-factory.js';

const SECRET = 'test-secret-ingest-limit';

async function startBridge(extraConfig = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-ilimit-'));
  process.env.CANVAS_SYNC_HOME = home;
  process.env.BRIDGE_PORT = '0';
  await fs.writeFile(path.join(home, 'config.json'),
    JSON.stringify({ bridgeSecret: SECRET, ...extraConfig }), { mode: 0o600 });
  const server = await createServer();
  return {
    home,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      await new Promise(resolve => server.close(resolve));
      delete process.env.CANVAS_SYNC_HOME;
      delete process.env.BRIDGE_PORT;
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

function request(baseUrl, method, pathname, { body = null, secret = SECRET } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method,
        headers: {
          ...(secret ? { 'X-Bridge-Secret': secret } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        } },
      res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* body parser errors are HTML */ }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// --- The resolver, directly --------------------------------------------------

test('the configured limit wins, and anything unusable falls back to the default', () => {
  assert.equal(maxIngestMb({ maxIngestMb: 64 }), 64);
  assert.equal(maxIngestMb({ maxIngestMb: '64' }), 64, 'a hand-edited config.json holds strings');
  assert.equal(maxIngestMb({}), DEFAULT_MAX_INGEST_MB);
  assert.equal(maxIngestMb(), DEFAULT_MAX_INGEST_MB);
  for (const bad of [0, -1, NaN, null, 'plenty', {}]) {
    assert.equal(maxIngestMb({ maxIngestMb: bad }), DEFAULT_MAX_INGEST_MB,
      `${JSON.stringify(bad)} must not be able to set a limit`);
  }
});

// --- One source, both consumers ----------------------------------------------

test('the handshake tells the extension the same limit express.json enforces', async () => {
  // Deliberately a LOW limit: it proves the two halves read the same value,
  // which a test at the default could not distinguish from a coincidence.
  const bridge = await startBridge({ maxIngestMb: 2 });
  try {
    await fs.writeFile(path.join(bridge.home, 'install-token.txt'), 'tok-limit');
    const paired = await request(bridge.baseUrl, 'POST', '/handshake', {
      body: { extensionId: 'ext-limit', installToken: 'tok-limit' },
    });
    assert.equal(paired.status, 200);
    assert.equal(paired.body.maxIngestMb, 2,
      'the extension sizes its download gate from this number');

    // The same number, enforced: a body over it is refused by the parser
    // before any route sees it.
    const tooBig = JSON.stringify({ courseId: 1, blob: 'x'.repeat(3 * 1024 * 1024) });
    const refused = await request(bridge.baseUrl, 'POST', '/ingest/course', { body: tooBig });
    assert.equal(refused.status, 413,
      'express.json must enforce the limit the handshake advertises');

    // And one comfortably under it still reaches the route (a 413 for
    // everything would pass the assertion above for the wrong reason).
    const small = await request(bridge.baseUrl, 'POST', '/ingest/course', { body: { course: null } });
    assert.notEqual(small.status, 413);
  } finally {
    await bridge.stop();
  }
});

test('health carries the limit too, so a config change does not need a re-pair', async () => {
  const bridge = await startBridge({ maxIngestMb: 7 });
  try {
    const health = await request(bridge.baseUrl, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.maxIngestMb, 7);
    assert.equal(health.body.ok, true, 'the existing health contract must survive the addition');
  } finally {
    await bridge.stop();
  }
});

test('a bridge with no configured limit advertises the default', async () => {
  const bridge = await startBridge();
  try {
    const health = await request(bridge.baseUrl, 'GET', '/health');
    assert.equal(health.body.maxIngestMb, DEFAULT_MAX_INGEST_MB);
  } finally {
    await bridge.stop();
  }
});

test('express.json reads the same resolver the handshake answers from', async () => {
  // Structural, and it earns its place: the property that matters is that the
  // two consumers share a DEFAULT, and the only behavioural proof of that would
  // be posting a body larger than the old 200 MB — a quarter-gigabyte request
  // inside a unit test. A reader who changes one of the two lines must change
  // both, and this is what says so.
  const src = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(src.includes('express.json({ limit: `${maxIngestMb(config)}mb` })'),
    'the body parser must take its limit from maxIngestMb(config), or the bridge '
    + 'can advertise one number and enforce another');
  assert.ok(!/limit: `\$\{config\.maxIngestMb \?\?/.test(src),
    'the parser is back to reading config directly, which is how the default drifts');
});

// --- The ceiling this transport actually has ---------------------------------

test('the default stays under what a single JSON string can hold', () => {
  // base64 inflates by 4/3 and the whole body is ONE string on both sides, so a
  // body limit above V8's string cap is a promise neither end can keep. If a
  // future change raises DEFAULT_MAX_INGEST_MB past this, the answer is chunked
  // upload, not a bigger number — and this test is where that argument lands.
  const bodyBytes = DEFAULT_MAX_INGEST_MB * 1024 * 1024;
  assert.ok(bodyBytes < bufferConstants.MAX_STRING_LENGTH,
    `a ${DEFAULT_MAX_INGEST_MB} MB body cannot be held in one string `
    + `(cap ${bufferConstants.MAX_STRING_LENGTH} bytes)`);
  // The file that fits inside that body, which is what the extension gates on.
  const effectiveFileMb = Math.floor(DEFAULT_MAX_INGEST_MB * (3 / 4) * 0.97);
  assert.ok(effectiveFileMb >= 250,
    `the effective per-file ceiling fell to ${effectiveFileMb} MB — the user asked `
    + `for lecture-sized files to come through uncut`);
});
