// stage-toggles.test.js — the Functions switches must mean the same thing to
// every reader.
//
// stageEnabled() is the single answer to "is this function on?" for the CLI
// orchestrator (sync-all-contexts.js) and anything else in scripts/;
// bridge/trigger.js keeps a local reader with the same rule, and the
// dashboard's STAGE_OFF_RE mirrors the off-regex. These tests pin the rule
// itself: absent means on, "0"/"false"/"off"/"no" mean off, and a process env
// value overrides the stored file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { stageEnabled, STAGE_ENV, STAGE_OFF_RE } from '../_util.js';

async function rootWith(settings) {
  const root = await mkdtemp(path.join(tmpdir(), 'csync-toggles-'));
  process.env.CANVAS_SYNC_HOME = root;
  if (settings !== undefined) {
    await writeFile(path.join(root, 'settings.json'), JSON.stringify(settings), 'utf8');
  }
  return root;
}

test('no settings file at all means every function is on', async () => {
  await rootWith(undefined);
  delete process.env.CSYNC_STAGE_MINE;
  for (const key of Object.keys(STAGE_ENV)) {
    assert.equal(await stageEnabled(key), true, `${key} must default on`);
  }
});

test('a stored "0" turns exactly that function off', async () => {
  await rootWith({ env: { CSYNC_STAGE_CONTEXT: '0' } });
  delete process.env.CSYNC_STAGE_CONTEXT;
  delete process.env.CSYNC_STAGE_MINE;
  assert.equal(await stageEnabled('build'), false, 'build maps to CSYNC_STAGE_CONTEXT');
  assert.equal(await stageEnabled('mine'), true, 'its neighbour is untouched');
});

test('every documented off-spelling is off, and junk is on', async () => {
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
    assert.equal(STAGE_OFF_RE.test(v), true, `"${v}" must read as off`);
  }
  // An unrecognised value must fail SAFE — the pipeline keeps running rather
  // than silently dying to a typo.
  for (const v of ['', '1', 'true', 'disable', 'nope']) {
    assert.equal(STAGE_OFF_RE.test(v), false, `"${v}" must not read as off`);
  }
});

test('the process environment overrides the stored file', async () => {
  await rootWith({ env: { CSYNC_STAGE_MINE: '0' } });
  process.env.CSYNC_STAGE_MINE = '1';
  try {
    assert.equal(await stageEnabled('mine'), true, 'env "1" beats stored "0"');
  } finally {
    delete process.env.CSYNC_STAGE_MINE;
  }
  assert.equal(await stageEnabled('mine'), false, 'without the env, the file rules');
});

test('a corrupt settings.json fails open, not closed', async () => {
  const root = await rootWith(undefined);
  await writeFile(path.join(root, 'settings.json'), '{ not json', 'utf8');
  delete process.env.CSYNC_STAGE_PARSE;
  assert.equal(await stageEnabled('parse'), true,
    'an unreadable settings file must not silently stop the pipeline');
});
