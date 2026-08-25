// handshake.test.js — integration test for /handshake endpoint
// OPEN: uses BRIDGE_PORT=0 (ephemeral) and CANVAS_SYNC_HOME=<tmpdir> to isolate from real env.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../test/helpers/server-factory.js';

let server, baseUrl, tmpHome;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-hs-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';

  // Write config.json (no extensionId yet, but has bridgeSecret).
  const config = { bridgeSecret: 'test-secret-abc' };
  await fs.writeFile(path.join(tmpHome, 'config.json'), JSON.stringify(config), { mode: 0o600 });

  // Write install-token.txt.
  await fs.writeFile(path.join(tmpHome, 'install-token.txt'), 'valid-token-xyz');

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

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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

test('handshake: valid token pairs extension and deletes token file', async () => {
  const res = await post(`${baseUrl}/handshake`, {
    extensionId: 'ext-abc123',
    installToken: 'valid-token-xyz',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.secret, 'should return secret');

  // config.json should now have extensionId.
  const config = JSON.parse(await fs.readFile(path.join(tmpHome, 'config.json'), 'utf8'));
  assert.equal(config.extensionId, 'ext-abc123');

  // install-token.txt should be deleted.
  await assert.rejects(fs.access(path.join(tmpHome, 'install-token.txt')), 'token file should be deleted');
});

// Replaying an already-consumed token must still fail — single-use is the
// whole point of the token. (This used to assert 409 "already paired", which
// encoded a bug: the 409 fired BEFORE the token was even read, so the check
// being exercised was the wrong one.)
test('handshake: replaying a consumed token fails (single-use enforced)', async () => {
  const res = await post(`${baseUrl}/handshake`, {
    extensionId: 'ext-abc123',
    installToken: 'valid-token-xyz',
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /no install token/i);
});

// Regression: reloading an unpacked extension wipes chrome.storage.local, so
// the extension loses the bridge secret while config.extensionId still names
// that same id. Re-pairing with a FRESH token must work — otherwise recovering
// the secret would require the secret that was just lost.
test('handshake: same extension can re-pair with a fresh token', async () => {
  await fs.writeFile(path.join(tmpHome, 'install-token.txt'), 'second-token-123');

  const res = await post(`${baseUrl}/handshake`, {
    extensionId: 'ext-abc123',
    installToken: 'second-token-123',
  });
  assert.equal(res.status, 200, 'same-id re-pair with a valid fresh token must succeed');
  assert.ok(res.body.secret, 'should return the bridge secret again');

  const config = JSON.parse(await fs.readFile(path.join(tmpHome, 'config.json'), 'utf8'));
  assert.equal(config.extensionId, 'ext-abc123');
  await assert.rejects(fs.access(path.join(tmpHome, 'install-token.txt')),
    'fresh token should also be consumed');
});

// A DIFFERENT extension must not be able to take over an existing pairing on a
// token alone — that still requires an explicit force from the dashboard.
test('handshake: a different extension is refused with 409', async () => {
  await fs.writeFile(path.join(tmpHome, 'install-token.txt'), 'third-token-456');

  const res = await post(`${baseUrl}/handshake`, {
    extensionId: 'ext-someone-else',
    installToken: 'third-token-456',
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.paired, true);
  assert.match(res.body.error, /different extension/i);

  // The pairing must be unchanged and the token left unconsumed.
  const config = JSON.parse(await fs.readFile(path.join(tmpHome, 'config.json'), 'utf8'));
  assert.equal(config.extensionId, 'ext-abc123', 'existing pairing must survive');
  await assert.doesNotReject(fs.access(path.join(tmpHome, 'install-token.txt')),
    'a refused handshake must not consume the token');
});

test('handshake: missing fields returns 400', async () => {
  const res = await post(`${baseUrl}/handshake`, { extensionId: 'only-id' });
  assert.equal(res.status, 400);
});
