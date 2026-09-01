import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aiInvoke, cliProviderStatuses, resolveAIProvider } from '../_util.js';

let root;
const saved = {};
const KEYS = [
  'CANVAS_SYNC_HOME', 'CSYNC_AI_BACKEND', 'CSYNC_CLAUDE_BIN', 'CSYNC_CODEX_BIN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
];

async function fakeCli(name, statusExit, answer, claudeLoggedIn = statusExit === 0) {
  const file = join(root, name);
  await writeFile(file, `#!/bin/sh
if [ "$1 $2" = "auth status" ] || [ "$1 $2" = "login status" ]; then
  if [ "$1 $2" = "auth status" ]; then
    printf '%s\\n' '{"loggedIn":${claudeLoggedIn ? 'true' : 'false'}}'
  fi
  exit ${statusExit}
fi
if [ -n "$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN$OPENAI_API_KEY" ]; then
  echo "API credentials leaked" >&2
  exit 41
fi
cat >/dev/null
printf '%s\\n' '${answer}'
`, 'utf8');
  await chmod(file, 0o755);
  return file;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'csync-ai-cli-'));
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.CANVAS_SYNC_HOME = root;
});

// Both overrides are set for EVERY test, whether or not it cares about that
// CLI. providerBin() falls back to ~/.local/bin, /opt/homebrew/bin,
// /usr/local/bin and finally PATH, so an override left unset does not mean
// "no CLI" — it means the developer's own installed, signed-in binary, and
// cliProviderStatuses() probes BOTH providers on every call. The third test
// below sets only CSYNC_CLAUDE_BIN and used to inherit the codex fake from the
// first test; run it alone (`--test-name-pattern`) or insert a test above it,
// and it ran `codex login status` against the real thing instead. It still
// PASSED while doing so, because it only asserts the claude half — which is
// why this needed a structural answer and not a careful reading.
//
// A path that does not exist gives ENOENT, which _statusSpawn already reads as
// installed: false. That is the state a test asking for "no CLI" wants.
beforeEach(() => {
  const missing = join(root, 'no-such-cli');
  process.env.CSYNC_CLAUDE_BIN = missing;
  process.env.CSYNC_CODEX_BIN = missing;
});

after(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(root, { recursive: true, force: true });
});

test('auto selects a signed-in Codex CLI when Claude is not signed in', async () => {
  process.env.CSYNC_AI_BACKEND = 'auto';
  process.env.CSYNC_CLAUDE_BIN = await fakeCli('claude-fake', 1, 'CLAUDE');
  process.env.CSYNC_CODEX_BIN = await fakeCli('codex-fake', 0, 'CODEX SUBSCRIPTION');
  process.env.ANTHROPIC_API_KEY = 'must-not-be-used';
  process.env.OPENAI_API_KEY = 'must-not-be-used';

  const statuses = await cliProviderStatuses();
  assert.equal(statuses.claude.authenticated, false);
  assert.equal(statuses.codex.authenticated, true);
  assert.equal((await resolveAIProvider()).provider, 'codex');
  assert.equal(await aiInvoke('hello'), 'CODEX SUBSCRIPTION');
});

test('explicit Claude backend uses its terminal login and strips API credentials', async () => {
  process.env.CSYNC_AI_BACKEND = 'claude';
  process.env.CSYNC_CLAUDE_BIN = await fakeCli('claude-signed-in', 0, 'CLAUDE SUBSCRIPTION');
  process.env.ANTHROPIC_AUTH_TOKEN = 'must-not-be-used';
  assert.equal((await resolveAIProvider()).provider, 'claude');
  assert.equal(await aiInvoke('hello'), 'CLAUDE SUBSCRIPTION');
});

test('Claude status fails closed when the command exits zero but says loggedIn false', async () => {
  process.env.CSYNC_CLAUDE_BIN = await fakeCli('claude-zero-but-logged-out', 0, 'unused', false);
  const statuses = await cliProviderStatuses();
  assert.equal(statuses.claude.installed, true);
  assert.equal(statuses.claude.authenticated, false);
});
