// local-model-venv.test.js — which python environment the /api/local-model
// routes describe, and which ones they refuse to install into.
//
// The gap (INTEGRATION-AUDIT.md I14, server half): Settings offers a python
// PATH, setup-local-model.sh:29 offers a venv ROOT ("VENV=${CSYNC_LOCAL_VENV:-
// $HOME/mlx-env}") and reads no other python variable, so the two routes
// spawned the script with a bare environment and it judged ~/mlx-env no matter
// what the user configured. Forwarding CSYNC_LOCAL_PYTHON would have changed
// nothing — the script has no concept of a python path — so the root is
// derived here instead.
//
// SCOPE, stated plainly. Two things these tests deliberately do NOT drive:
//   - GET /api/local-model over HTTP. It spawns the real script, which walks
//     the user's HF cache with du -sh; a hermetic test must not read the
//     machine's real state, and there is no stub seam (the routes have no
//     caller today, so adding one would be surface for nobody).
//   - the ACCEPTED setup path over HTTP. POST /api/local-model/setup with a
//     usable venv runs the installer for real: python -m venv, pip install
//     mlx-lm, and a ~23 GB model download. Nothing in a test suite may start
//     that. Only the refusals are driven end to end; the accept path is
//     covered by localVenvState's own cases plus the structural check that
//     both spawn sites pass the variable.
// Reachability, so nobody re-files this as urgent: nothing in the repo calls
// these three routes today — the app's readiness card is Electron IPC
// (app/main.js:287/:296), and that path already honours the setting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { venvRootForPython, localVenvState } from '../server.js';
import { createServer } from './helpers/server-factory.js';

// fileURLToPath, not import.meta.url's pathname: a repo path with a space in
// it arrives percent-encoded and every path built from it silently misses.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- The derivation, as a pure function -------------------------------------

test('a venv python yields its root, and nothing else does', () => {
  const cases = [
    ['/Users/x/mlx-env/bin/python',      '/Users/x/mlx-env', 'the ordinary case'],
    ['/Users/x/mlx-env/bin/python3.12',  '/Users/x/mlx-env', 'venvs make python3.x too'],
    ['  /Users/x/mlx-env/bin/python  ',  '/Users/x/mlx-env', 'a pasted Settings value keeps its spaces'],
    ['/opt/homebrew/bin/python3.12',     '/opt/homebrew',    'shape alone cannot reject a system prefix — pyvenv.cfg does'],
    ['python3',                   null, 'a bare name is whatever PATH says and belongs to no venv'],
    ['./mlx-env/bin/python',      null, 'relative: the bridge and the script need not share a cwd'],
    ['/Users/x/mlx-env/lib/python', null, 'the script only ever runs "$VENV/bin/python"'],
    ['/bin/python',               null, 'would claim the filesystem root as a venv'],
    ['',                          null, 'an empty Settings field'],
    [null,                        null, 'no value at all'],
    [undefined,                   null, 'undefined'],
    [12,                          null, 'a non-string from a hand-edited settings.json'],
  ];
  for (const [input, expected, why] of cases) {
    assert.equal(venvRootForPython(input), expected, `${JSON.stringify(input)}: ${why}`);
  }
});

// --- The derivation, with the one proof that a directory is a venv ----------

test('pyvenv.cfg is what separates a venv from a directory containing a python', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-venv-state-'));
  try {
    // A real venv: python -m venv writes pyvenv.cfg and nothing else does.
    const real = path.join(tmp, 'mlx-env');
    await fs.mkdir(path.join(real, 'bin'), { recursive: true });
    await fs.writeFile(path.join(real, 'pyvenv.cfg'), 'home = /usr/bin\n');
    assert.deepEqual(await localVenvState(path.join(real, 'bin', 'python')),
      { venv: real, state: 'venv', root: real });

    // Not created yet. This is the case a stricter guard would have broken:
    // the default ~/mlx-env on a fresh machine, which is the ONLY thing these
    // routes were built to install.
    const fresh = path.join(tmp, 'not-yet');
    assert.deepEqual(await localVenvState(path.join(fresh, 'bin', 'python')),
      { venv: fresh, state: 'absent', root: fresh });

    // A real directory that python -m venv did not make — /opt/homebrew from a
    // perfectly reasonable /opt/homebrew/bin/python3.12. Deriving from it would
    // point --check at a python Settings never named, and aim `python -m venv`
    // at a system prefix.
    const prefix = path.join(tmp, 'homebrew');
    await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
    assert.deepEqual(await localVenvState(path.join(prefix, 'bin', 'python3.12')),
      { venv: null, state: 'not-a-venv', root: prefix });

    // A shape that cannot support the claim at all.
    assert.deepEqual(await localVenvState('python3'),
      { venv: null, state: 'unusable-path', root: null });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// --- Both spawn sites, structurally ----------------------------------------

test('both local-model spawns carry the derived venv', async () => {
  // Structural, because the alternative is running the real installer. Each
  // route is located by the arguments it passes the script, and the whole
  // spawn call is then read for the variable.
  const src = await fs.readFile(path.join(HERE, '..', 'server.js'), 'utf8');
  for (const [anchor, what] of [
    ["SETUP_SCRIPT, '--check', '--tier', tier", 'GET /local-model'],
    ["SETUP_SCRIPT, '--tier', tier", 'POST /local-model/setup'],
  ]) {
    const at = src.indexOf(anchor);
    assert.ok(at > 0, `${what}'s spawn moved — this test is stale, not passing`);
    const call = src.slice(at, src.indexOf('});', at));
    assert.ok(call.includes('CSYNC_LOCAL_VENV'),
      `${what} spawns the setup script without the derived venv, so it judges `
      + `~/mlx-env whatever Settings says`);
    assert.ok(!/env: \{ \.\.\.process\.env \},/.test(call),
      `${what} still passes a bare environment`);
  }
});

// --- The refusal, end to end ------------------------------------------------

let server, baseUrl, tmpHome, priorPython;
const SECRET = 'test-secret-local-model-venv';

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-lmvenv-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';
  priorPython = process.env.CSYNC_LOCAL_PYTHON;
  await fs.writeFile(path.join(tmpHome, 'config.json'),
    JSON.stringify({ bridgeSecret: SECRET }), { mode: 0o600 });
  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  delete process.env.CANVAS_SYNC_HOME;
  delete process.env.BRIDGE_PORT;
  if (priorPython === undefined) delete process.env.CSYNC_LOCAL_PYTHON;
  else process.env.CSYNC_LOCAL_PYTHON = priorPython;
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

test('setup refuses a python that is not a venv, and says what to do instead', async () => {
  const prefix = path.join(tmpHome, 'homebrew');
  await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
  const python = path.join(prefix, 'bin', 'python3.12');
  process.env.CSYNC_LOCAL_PYTHON = python;

  const refused = await call('POST', '/api/local-model/setup', { tier: 'light' });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.state, 'not-a-venv');
  assert.equal(refused.body.python, python);
  assert.match(refused.body.error, /is not a virtual environment/);
  // No dead end: the refusal names both ways out.
  assert.match(refused.body.detail, /bin\/python/);
  assert.match(refused.body.detail, /install mlx-lm into that python/);
  // Nothing was started — a refusal that still spawned the installer would be
  // the whole defect, wearing a 409.
  await assert.rejects(fs.access(path.join(tmpHome, 'logs', 'local-model-setup.log')),
    { code: 'ENOENT' });
});

test('setup refuses a bare python name too', async () => {
  process.env.CSYNC_LOCAL_PYTHON = 'python3';
  const refused = await call('POST', '/api/local-model/setup', { tier: 'light' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.state, 'unusable-path');
  assert.match(refused.body.error, /is not a virtual environment's python/);
});
