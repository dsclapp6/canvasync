// local-python.test.js — the desktop shell answering about the SAME python the
// rest of the app runs.
//
// The defect this pins: main.js used to resolve the local python by walking a
// fallback chain — configured, ~/mlx-env, /usr/local/bin/python3,
// /opt/homebrew/bin/python3 — and reporting the first that EXISTED, while
// scripts/_util.js's resolveLocalPython() honours the configured value and
// spawns exactly that. One typo in Settings and the readiness card answered
// about Homebrew's python (green, "model present") while every Ask question
// and every pipeline stage failed on the path the user actually typed.
//
// SCOPE: main.js itself cannot be imported here — it requires electron at
// module scope — so the resolver was extracted into local-python.js and is
// tested directly, and main.js's USE of it is pinned structurally. What is not
// covered headlessly: the IPC round trip, and the dashboard card's rendering
// of pythonOk (bridge/public/app.js, another session's file).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { defaultLocalPython, resolveLocalPython, localPythonStatus } =
  require('../local-python.js');

const HOME = '/home/tester';
const DEFAULT = path.join(HOME, 'mlx-env', 'bin', 'python');

// --- Which path, and from where --------------------------------------------

test('env beats settings beats the default, exactly as _util.js orders them', () => {
  assert.deepEqual(
    resolveLocalPython({
      env: { CSYNC_LOCAL_PYTHON: '/from/env/bin/python' },
      settingsEnv: { CSYNC_LOCAL_PYTHON: '/from/settings/bin/python' },
      home: HOME,
    }),
    { python: '/from/env/bin/python', source: 'env' });

  assert.deepEqual(
    resolveLocalPython({
      env: {},
      settingsEnv: { CSYNC_LOCAL_PYTHON: '/from/settings/bin/python' },
      home: HOME,
    }),
    { python: '/from/settings/bin/python', source: 'settings' });

  assert.deepEqual(
    resolveLocalPython({ env: {}, settingsEnv: null, home: HOME }),
    { python: DEFAULT, source: 'default' });

  assert.equal(defaultLocalPython(HOME), DEFAULT);
});

test('blank values fall through and pasted ones are trimmed', () => {
  // settingValue() in _util.js requires a non-empty trimmed string before it
  // will answer; an empty Settings field must not beat the default here either.
  assert.equal(
    resolveLocalPython({ env: { CSYNC_LOCAL_PYTHON: '   ' }, settingsEnv: null, home: HOME }).python,
    DEFAULT);
  assert.equal(
    resolveLocalPython({ env: {}, settingsEnv: { CSYNC_LOCAL_PYTHON: '' }, home: HOME }).python,
    DEFAULT);
  assert.equal(
    resolveLocalPython({ env: {}, settingsEnv: { CSYNC_LOCAL_PYTHON: ' /venv/bin/python \n' }, home: HOME }).python,
    '/venv/bin/python');
});

// --- Existence as diagnosis, never as substitution --------------------------

test('a configured python that is not there is REPORTED, not replaced', () => {
  // The whole defect in one assertion — and it only bites if the fake models
  // the real shape of it: the configured python is MISSING while another one
  // is present. A stub that says "nothing exists" passes against the buggy
  // implementation too, because a substitution has nothing to substitute.
  // (Found by reverting: with `exists: () => false` this test stayed green
  // with the silent fallback put back in.)
  const status = localPythonStatus({
    env: { CSYNC_LOCAL_PYTHON: '/typo/bin/pythn' },
    home: HOME,
    exists: (p) => p !== '/typo/bin/pythn',
  });
  assert.equal(status.ok, false);
  assert.equal(status.python, '/typo/bin/pythn');
  assert.equal(status.source, 'env');
});

test('a python that is there reads ok, and the existence check sees the resolved path', () => {
  const asked = [];
  const status = localPythonStatus({
    env: {},
    settingsEnv: { CSYNC_LOCAL_PYTHON: '/venv/bin/python' },
    home: HOME,
    exists: (p) => { asked.push(p); return true; },
  });
  assert.deepEqual(status, { python: '/venv/bin/python', source: 'settings', ok: true });
  // Only the resolved path is probed — no chain of candidates behind it.
  assert.deepEqual(asked, ['/venv/bin/python']);
});

test('an existence check that throws answers false instead of taking the app down', () => {
  // An unreadable parent directory throws EACCES rather than returning false,
  // and this runs inside an Electron ipcMain handler.
  const status = localPythonStatus({
    env: { CSYNC_LOCAL_PYTHON: '/locked/bin/python' },
    home: HOME,
    exists: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
  });
  assert.equal(status.ok, false);
  assert.equal(status.python, '/locked/bin/python');
});

// --- main.js's use of it, structurally --------------------------------------

test('main.js resolves through the shared module and keeps no chain of its own', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(src.includes("require('./local-python.js')"),
    'main.js must resolve the local python through the shared rules');
  assert.ok(src.includes('localPythonStatus({ settingsEnv })'),
    'main.js must ask for the status rather than re-deriving it');
  for (const fallback of ['/usr/local/bin/python3', '/opt/homebrew/bin/python3']) {
    assert.ok(!src.includes(fallback),
      `main.js still falls back to ${fallback} — that is the silent substitution `
      + `that made the readiness card disagree with every spawn`);
  }
  assert.ok(!/candidates\.find/.test(src), 'the candidate chain is back in main.js');
});
