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

// The launch child used to be spawned with no 'error' listener. A launch that
// fails asynchronously — ENOENT here, EAGAIN/EMFILE on a loaded machine — then
// reached the EventEmitter's rethrow as an uncaughtException, and the bridge
// registers no process-level handler, so the BRIDGE DIED after having already
// answered 200 'Terminal opened'.
//
// Reverted in a scratch copy of the tree, this fails on the FIRST assertion:
// the route answers 200 'Terminal opened' for a child that never started, so
// 200 !== 500. What it does NOT prove is the crash itself — node:test installs
// its own uncaughtException handler, so under the runner the unhandled 'error'
// is downgraded to a diagnostic line ("would have caused the test to fail, but
// instead triggered an uncaughtException event") and the process survives. The
// crash was shown separately, outside the runner: the same spawn shape
// (detached, stdio ignore, unref, no listener) exits node with code 1 while
// the surrounding try/catch never sees it. That is why the fix is a listener
// and not only a status code.
test('a launch failure answers 500 with the manual command — and leaves the bridge alive',
  { skip: process.platform !== 'darwin' ? 'darwin-only: the route 501s elsewhere' : false },
  async () => {
    const previous = process.env.CSYNC_OPEN_BIN;
    // A path that cannot spawn. The real /usr/bin/open would open a Terminal
    // window on the user's desktop during a test run.
    process.env.CSYNC_OPEN_BIN = path.join(tmpHome, 'no-such-open-binary');
    let answer;
    try {
      answer = await request('/api/ai-cli/login', {
        method: 'POST', body: JSON.stringify({ provider: 'claude' }),
      });
    } finally {
      if (previous === undefined) delete process.env.CSYNC_OPEN_BIN;
      else process.env.CSYNC_OPEN_BIN = previous;
    }

    assert.equal(answer.status, 500);
    assert.match(answer.body.error, /could not open the login terminal/);
    assert.match(answer.body.detail, /ENOENT/);
    // A dead end has to name its own way out, the way the non-macOS branch does.
    assert.equal(answer.body.command, 'claude auth login');

    // Reached at all only because the process survived the failed spawn.
    const { status } = await request('/api/ai-cli');
    assert.equal(status, 200);
  });

test('a codex launch failure names the codex login command',
  { skip: process.platform !== 'darwin' ? 'darwin-only: the route 501s elsewhere' : false },
  async () => {
    const previous = process.env.CSYNC_OPEN_BIN;
    process.env.CSYNC_OPEN_BIN = path.join(tmpHome, 'no-such-open-binary');
    let answer;
    try {
      answer = await request('/api/ai-cli/login', {
        method: 'POST', body: JSON.stringify({ provider: 'codex' }),
      });
    } finally {
      if (previous === undefined) delete process.env.CSYNC_OPEN_BIN;
      else process.env.CSYNC_OPEN_BIN = previous;
    }
    assert.equal(answer.status, 500);
    assert.equal(answer.body.command, 'codex login');
  });
