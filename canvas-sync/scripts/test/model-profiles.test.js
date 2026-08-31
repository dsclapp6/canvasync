// model-profiles.test.js — the capability table, and aiInvoke's routing by it.
//
// The thing under test is a REFUSAL: a backend that cannot do a job must be
// skipped rather than tried, because a local model handed the 520K-char mining
// corpus does not crash — it answers, plausibly, with items missing. So most
// of these tests assert that a model was NOT invoked (a marker file the local
// stub would have written) and that the failure is typed, not swallowed.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  profileFor, satisfies, assertNeeds, tierAtLeast, PROFILE_KEYS,
} from '../model-profiles.js';
import { aiInvoke, ModelTierUnavailable } from '../_util.js';

const STANDARD_ID = 'mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit';
const LIGHT_ID = 'mlx-community/Qwen3-4B-Instruct-2507-4bit';

let root, marker;
const saved = {};
const KEYS = [
  'CANVAS_SYNC_HOME', 'CSYNC_AI_BACKEND', 'CSYNC_CLAUDE_BIN', 'CSYNC_CODEX_BIN',
  'CSYNC_LOCAL_PYTHON', 'CSYNC_LOCAL_MODEL', 'CSYNC_CLAUDE_MODEL', 'CSYNC_CODEX_MODEL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
];

// Same shape as ai-providers.test.js's fake: answers `auth status` /
// `login status` with the given exit code, otherwise echoes a fixed answer.
async function fakeCli(name, statusExit, answer, claudeLoggedIn = statusExit === 0) {
  const file = join(root, name);
  await writeFile(file, `#!/bin/sh
if [ "$1 $2" = "auth status" ] || [ "$1 $2" = "login status" ]; then
  if [ "$1 $2" = "auth status" ]; then
    printf '%s\\n' '{"loggedIn":${claudeLoggedIn ? 'true' : 'false'}}'
  fi
  exit ${statusExit}
fi
cat >/dev/null
printf '%s\\n' '${answer}'
`, 'utf8');
  await chmod(file, 0o755);
  return file;
}

/** Did the local model stub run since the last reset? */
async function localRan() {
  try { await stat(marker); return true; } catch { return false; }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'csync-profiles-'));
  marker = join(root, 'local-ran');
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.CANVAS_SYNC_HOME = root;

  // "python" that records the fact it was spawned at all, then answers.
  const stub = join(root, 'fake-generate.sh');
  await writeFile(stub, `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(marker)}\ncat >/dev/null\nprintf 'LOCAL ANSWER\\n'\n`, 'utf8');
  await chmod(stub, 0o755);
  process.env.CSYNC_LOCAL_PYTHON = stub;
  process.env.CSYNC_LOCAL_MODEL = STANDARD_ID;
});

beforeEach(async () => {
  await rm(marker, { force: true });
  delete process.env.CSYNC_CLAUDE_BIN;
  delete process.env.CSYNC_CODEX_BIN;
  delete process.env.CSYNC_CLAUDE_MODEL;
  delete process.env.CSYNC_CODEX_MODEL;
  process.env.CSYNC_LOCAL_MODEL = STANDARD_ID;
});

after(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(root, { recursive: true, force: true });
});

// --- The table --------------------------------------------------------------

test('the installed local model decides the local tier', () => {
  assert.equal(profileFor('local', STANDARD_ID).key, 'local-standard');
  assert.equal(profileFor('local', STANDARD_ID).tier, 'standard');
  assert.equal(profileFor('local', LIGHT_ID).key, 'local-light');
  assert.equal(profileFor('local', LIGHT_ID).tier, 'light');
  // Both are one model on one machine: concurrency 1, enforced by the lock.
  assert.equal(profileFor('local', STANDARD_ID).concurrency, 1);
});

test('an unrecognised local model is assumed light, and says so', () => {
  const p = profileFor('local', 'someone/private-finetune-7b');
  assert.equal(p.tier, 'light', 'guessing low costs a refusal; guessing high costs a silent wrong answer');
  assert.equal(p.assumed, true, 'callers must be able to render this as an assumption, not a fact');
  assert.equal(profileFor('local', STANDARD_ID).assumed, false);
});

test('only the claude CLI carries tools, and codex is strong but smaller', () => {
  assert.equal(profileFor('claude').tools, true);
  assert.equal(profileFor('codex').tools, false, 'non-interactive codex is a read-only sandbox');
  assert.equal(profileFor('claude').tier, 'strong');
  assert.equal(profileFor('codex').tier, 'strong');
  assert.ok(profileFor('codex').inputBudgetChars < profileFor('claude').inputBudgetChars);
  assert.equal(profileFor('nonesuch'), null);
});

test('a returned profile is a copy — a caller cannot corrupt the table', () => {
  const p = profileFor('claude');
  p.tier = 'light';
  assert.equal(profileFor('claude').tier, 'strong');
  assert.deepEqual(PROFILE_KEYS.slice().sort(), ['claude-cli', 'codex-cli', 'local-light', 'local-standard']);
});

test('tier comparison is ordered, not equality', () => {
  assert.equal(tierAtLeast('strong', 'standard'), true);
  assert.equal(tierAtLeast('standard', 'strong'), false);
  assert.equal(tierAtLeast('light', 'light'), true);
});

test('inputChars is judged against the working budget, not the hard ceiling', () => {
  const local = profileFor('local', STANDARD_ID);
  // The gap between the two numbers is the entire point of having both: a
  // 60K-char prompt fits in the context window and still extracts badly.
  assert.ok(local.inputBudgetChars > local.workingBudgetChars);
  const between = Math.round((local.workingBudgetChars + local.inputBudgetChars) / 2);
  assert.equal(satisfies(local, { inputChars: between }).ok, false);
  assert.equal(satisfies(local, { inputChars: local.workingBudgetChars }).ok, true);
  assert.match(satisfies(local, { inputChars: between }).reason, /working budget/);
});

test('no needs means no opinion', () => {
  assert.equal(satisfies(profileFor('local', LIGHT_ID), null).ok, true);
  assert.equal(satisfies(profileFor('local', LIGHT_ID), {}).ok, true);
});

test('a misspelled need is a loud error, never a silently empty requirement', () => {
  // `{ teir: 'strong' }` reading as "no requirements" would ship the mining
  // corpus to a 4-bit model — the exact failure the option exists to prevent.
  assert.throws(() => assertNeeds({ teir: 'strong' }), /unknown needs key/);
  assert.throws(() => assertNeeds({ tier: 'strongest' }), /unknown tier/);
  assert.throws(() => assertNeeds({ inputChars: 'lots' }), /inputChars/);
  assert.throws(() => assertNeeds({ tools: 'yes' }), /tools/);
  assert.doesNotThrow(() => assertNeeds({ tier: 'strong', inputChars: 10, tools: true }));
});

// --- aiInvoke routing -------------------------------------------------------

test('auto refuses a strong-tier job rather than answering it locally', async () => {
  process.env.CSYNC_AI_BACKEND = 'auto';
  process.env.CSYNC_CLAUDE_BIN = await fakeCli('claude-out', 1, 'CLAUDE');
  process.env.CSYNC_CODEX_BIN = await fakeCli('codex-out', 1, 'CODEX');

  await assert.rejects(
    aiInvoke('mine this', { needs: { tier: 'strong' } }),
    err => err instanceof ModelTierUnavailable && err.code === 'EMODELTIER',
  );
  assert.equal(await localRan(), false, 'the local model must not be loaded for a job it cannot do');
});

test('a prompt too big for codex is not quietly sent to it', async () => {
  process.env.CSYNC_AI_BACKEND = 'auto';
  process.env.CSYNC_CLAUDE_BIN = await fakeCli('claude-out2', 1, 'CLAUDE');
  process.env.CSYNC_CODEX_BIN = await fakeCli('codex-in2', 0, 'CODEX ANSWER');

  const err = await aiInvoke('x', { needs: { inputChars: 400_000 } }).then(
    () => null, e => e);
  assert.ok(err instanceof ModelTierUnavailable, `expected EMODELTIER, got ${err}`);
  // The message has to name what was missing: it becomes the dashboard's
  // explanation of why a stage was deferred.
  assert.match(err.message, /400K chars/);
  assert.deepEqual(err.considered.map(c => c.name), ['codex', 'local']);
  assert.equal(await localRan(), false);
});

test('a strong CLI still answers a job that only needs standard', async () => {
  process.env.CSYNC_AI_BACKEND = 'auto';
  process.env.CSYNC_CLAUDE_BIN = await fakeCli('claude-out3', 1, 'CLAUDE');
  process.env.CSYNC_CODEX_BIN = await fakeCli('codex-in3', 0, 'CODEX ANSWER');

  const info = {};
  const text = await aiInvoke('hello', { needs: { tier: 'standard' }, info });
  assert.equal(text, 'CODEX ANSWER', 'the bare-string return is the contract');
  assert.deepEqual(info, { backend: 'codex', tier: 'strong', profile: 'codex-cli', model: null });
  assert.equal(await localRan(), false);
});

test('an explicitly pinned backend is still held to what it can do', async () => {
  // Pinning `local` in Settings is a preference, not a capability claim.
  process.env.CSYNC_AI_BACKEND = 'local';
  await assert.rejects(
    aiInvoke('needs a browser', { needs: { tools: true } }),
    err => err.code === 'EMODELTIER' && /text-only/.test(err.message),
  );
  assert.equal(await localRan(), false);
});

test('info is left exactly as passed when the invoke throws', async () => {
  process.env.CSYNC_AI_BACKEND = 'local';
  const info = { backend: 'from-a-previous-run' };
  await assert.rejects(aiInvoke('x', { needs: { tier: 'strong' }, info }));
  assert.deepEqual(info, { backend: 'from-a-previous-run' },
    'a failed call must never leave last run’s backend readable as this run’s');
});

test('info reports the local model that actually answered', async () => {
  process.env.CSYNC_AI_BACKEND = 'local';
  process.env.CSYNC_LOCAL_MODEL = LIGHT_ID;
  const info = {};
  const text = await aiInvoke('hello', { needs: { tier: 'light' }, info });
  assert.equal(text, 'LOCAL ANSWER');
  assert.deepEqual(info, {
    backend: 'local', tier: 'light', profile: 'local-light', model: LIGHT_ID,
  });
  assert.equal(await localRan(), true);
});

test('info names the pinned CLI model when one is configured', async () => {
  process.env.CSYNC_AI_BACKEND = 'claude';
  process.env.CSYNC_CLAUDE_BIN = await fakeCli('claude-in4', 0, 'CLAUDE ANSWER');
  process.env.CSYNC_CLAUDE_MODEL = 'opus-pinned';
  const info = {};
  assert.equal(await aiInvoke('hello', { info }), 'CLAUDE ANSWER');
  assert.equal(info.model, 'opus-pinned');
  assert.equal(info.backend, 'claude');
});

test('without needs, routing is unchanged — auto still ends at the local model', async () => {
  process.env.CSYNC_AI_BACKEND = 'auto';
  process.env.CSYNC_CLAUDE_BIN = await fakeCli('claude-out5', 1, 'CLAUDE');
  process.env.CSYNC_CODEX_BIN = await fakeCli('codex-out5', 1, 'CODEX');
  const text = await aiInvoke('hello');
  assert.equal(text, 'LOCAL ANSWER');
  assert.equal(await localRan(), true);
});

test('a bad info out-param is rejected before anything is invoked', async () => {
  process.env.CSYNC_AI_BACKEND = 'local';
  await assert.rejects(aiInvoke('x', { info: 'please fill me' }), /info must be an object/);
  assert.equal(await localRan(), false);
});
