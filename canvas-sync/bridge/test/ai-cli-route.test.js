import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './helpers/server-factory.js';

const SECRET = 'test-secret-ai-cli';
let server, baseUrl, tmpHome;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-ai-cli-route-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.CSYNC_AI_BACKEND = 'local';
  process.env.CSYNC_CLAUDE_BIN = path.join(tmpHome, 'missing-claude');
  process.env.CSYNC_CODEX_BIN = path.join(tmpHome, 'missing-codex');
  await fs.writeFile(path.join(tmpHome, 'config.json'), JSON.stringify({ bridgeSecret: SECRET }));
  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  delete process.env.CANVAS_SYNC_HOME;
  delete process.env.CSYNC_AI_BACKEND;
  delete process.env.CSYNC_CLAUDE_BIN;
  delete process.env.CSYNC_CODEX_BIN;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function request(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: {
      'X-Bridge-Secret': SECRET,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  return { status: response.status, body: await response.json() };
}

test('terminal AI status reports subscription providers without an API-key path', async () => {
  const { status, body } = await request('/api/ai-cli');
  assert.equal(status, 200);
  assert.equal(body.backend, 'local');
  assert.equal(body.selectedProvider, 'local');
  assert.equal(body.apiKeysUsed, false);
  assert.deepEqual(body.providers.claude, {
    provider: 'claude', installed: false, authenticated: false, timedOut: false,
  });
  assert.deepEqual(body.providers.codex, {
    provider: 'codex', installed: false, authenticated: false, timedOut: false,
  });
});

test('login endpoint refuses unknown terminal providers', async () => {
  const { status, body } = await request('/api/ai-cli/login', {
    method: 'POST', body: JSON.stringify({ provider: 'api-key' }),
  });
  assert.equal(status, 400);
  assert.match(body.error, /claude or codex/);
});
