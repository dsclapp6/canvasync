// local-python.test.js — the Settings field that reached half the app.
//
// The pipeline spawns its stages with settings.json's CSYNC_* folded into the
// environment, so a python chosen in Settings reaches every stage. Nothing
// folds it into the BRIDGE's process, and localInvoke spawned a module
// constant captured from that process's env at import. So a user whose MLX
// venv is not at ~/mlx-env — the only reason the field exists — got a working
// pipeline and an Ask sidebar that 500s on every question, after taking and
// releasing the machine-wide model lock for nothing. INTEGRATION-AUDIT.md I14.
//
// HOME is repointed at the temp root before _util.js is imported, on purpose:
// the pre-fix default is join(homedir(), 'mlx-env/bin/python'), and on a
// machine that HAS a real MLX venv there, a regression here would spawn the
// real runner and start a ~20 GB model load inside the test suite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tmpHome, stubPath, util;
const saved = {};
const KEYS = ['HOME', 'CANVAS_SYNC_HOME', 'CSYNC_LOCAL_PYTHON', 'CSYNC_AI_BACKEND'];

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-localpy-'));
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.HOME = tmpHome;              // must precede the import (see above)
  process.env.CANVAS_SYNC_HOME = tmpHome;
  delete process.env.CSYNC_LOCAL_PYTHON;   // the point: it is NOT in the env

  stubPath = path.join(tmpHome, 'settings-python.sh');
  await fs.writeFile(stubPath, '#!/bin/sh\ncat >/dev/null\necho "gen-done via settings"\n', { mode: 0o755 });
  await fs.writeFile(
    path.join(tmpHome, 'settings.json'),
    JSON.stringify({ env: { CSYNC_LOCAL_PYTHON: stubPath } }, null, 2),
    'utf8',
  );

  util = await import('../_util.js');
});

after(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await fs.rm(tmpHome, { recursive: true, force: true });
});

test('resolveLocalPython reads the Settings value the env never carried', async () => {
  assert.equal(await util.resolveLocalPython(), stubPath);
});

test('localInvoke spawns the python configured in Settings, not the frozen default', async () => {
  const out = await util.localInvoke('hello', { timeoutMs: 30000 });
  assert.match(out, /gen-done via settings/);
  // Same call, same process: the module constant still holds the default, so
  // this proves the resolution is per call and not a re-read of the env.
  assert.notEqual(util.LOCAL_PYTHON, stubPath);
});

test('an Ask-style call through aiInvoke reaches the same python', async () => {
  // /api/ask runs in the bridge process — the one whose env nothing populates.
  process.env.CSYNC_AI_BACKEND = 'local';
  const out = await util.aiInvoke('hello', { timeoutMs: 30000 });
  assert.match(out, /gen-done via settings/);
});

test('the environment still wins over Settings when both are set', async () => {
  const envStub = path.join(tmpHome, 'env-python.sh');
  await fs.writeFile(envStub, '#!/bin/sh\ncat >/dev/null\necho "gen-done via env"\n', { mode: 0o755 });
  process.env.CSYNC_LOCAL_PYTHON = envStub;
  try {
    assert.equal(await util.resolveLocalPython(), envStub);
    assert.match(await util.localInvoke('hello', { timeoutMs: 30000 }), /gen-done via env/);
  } finally {
    delete process.env.CSYNC_LOCAL_PYTHON;
  }
});
