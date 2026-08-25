// origin.test.js — requireOrigin guards the extension-only routes.
//
// Regression: a force-unpair (/api/pair-token {force:true}) clears extensionId
// but deliberately keeps bridgeSecret so the desktop app and dashboard keep
// working. requireOrigin used to treat "no extensionId" as "no expectation",
// so the extension that had just been unpaired — still holding that same
// secret — passed both the Origin check and the secret check and kept
// ingesting. Unpairing revoked nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../test/helpers/server-factory.js';

const SECRET = 'test-secret-origin';
let server, baseUrl, tmpHome, configPath;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-origin-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';
  configPath = path.join(tmpHome, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ bridgeSecret: SECRET }), { mode: 0o600 });
  await fs.writeFile(path.join(tmpHome, 'install-token.txt'), 'origin-token-1');

  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  delete process.env.CANVAS_SYNC_HOME;
  delete process.env.BRIDGE_PORT;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function request(method, pathname, { origin, secret, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (origin) headers['Origin'] = origin;
    if (secret) headers['X-Bridge-Secret'] = secret;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// The route is reached only after requireOrigin and requireSecret pass, so any
// status other than 403 proves the origin gate let the request through.
const GUARDED = '/config/untracked';

test('origin: unpaired bridge rejects chrome-extension traffic even with a valid secret', async () => {
  const res = await request('GET', GUARDED, {
    origin: 'chrome-extension://abcdefghijklmnop',
    secret: SECRET,
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /not paired/i);
});

test('origin: paired extension is allowed, a different extension is not', async () => {
  const paired = await request('POST', '/handshake', {
    body: { extensionId: 'abcdefghijklmnop', installToken: 'origin-token-1' },
  });
  assert.equal(paired.status, 200);
  const secret = paired.body.secret;

  const ok = await request('GET', GUARDED, {
    origin: 'chrome-extension://abcdefghijklmnop',
    secret,
  });
  assert.equal(ok.status, 200, `paired extension should be served, got ${ok.raw}`);

  // Same valid secret, wrong extension id — the Origin check must still refuse.
  const impostor = await request('GET', GUARDED, {
    origin: 'chrome-extension://zzzzzzzzzzzzzzzz',
    secret,
  });
  assert.equal(impostor.status, 403);
  assert.match(impostor.body.error, /forbidden origin/i);
});

test('origin: dashboard and Electron requests (no chrome-extension Origin) are unaffected', async () => {
  // /api/* is deliberately exempt — browser and Electron callers carry no
  // chrome-extension Origin, and enforcing this on them would 403 the whole UI.
  const res = await request('GET', '/api/classes', { secret: SECRET });
  assert.notEqual(res.status, 403, `dashboard must not be blocked by the origin gate (got ${res.raw})`);
});
