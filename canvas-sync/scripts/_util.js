import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { dataRoot } from '../data-root.js';
import {
  profileFor, satisfies, assertNeeds, tierUnavailable,
} from './model-profiles.js';

// Re-exported so a caller that already imports _util.js can catch the typed
// error and read a profile without learning a second module path.
export {
  ModelTierUnavailable, profileFor, satisfies, tierAtLeast, PROFILE_KEYS,
} from './model-profiles.js';

export function classHome() {
  return join(dataRoot(), 'classes');
}

export async function sha256File(filePath) {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

export async function readJsonSafe(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function atomicWriteJson(filePath, obj) {
  const str = JSON.stringify(obj, null, 2);
  await atomicWriteText(filePath, str);
}

export async function atomicWriteText(filePath, str) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, '.' + randomBytes(8).toString('hex') + '.tmp');
  await writeFile(tmp, str, 'utf8');
  await rename(tmp, filePath);
}

// A blank model means "use the signed-in CLI's default", which stays valid as
// subscription model aliases evolve. Either provider can be pinned explicitly
// in Settings when reproducibility matters.
export const DEFAULT_MODEL = process.env.CSYNC_CLAUDE_MODEL || null;

const CLI_PROVIDERS = new Set(['claude', 'codex']);

function providerBin(provider) {
  const name = provider === 'codex' ? 'codex' : 'claude';
  const override = process.env[provider === 'codex' ? 'CSYNC_CODEX_BIN' : 'CSYNC_CLAUDE_BIN'];
  if (override) return override;
  // A GUI-launched macOS app commonly has /usr/bin:/bin as PATH even though
  // both CLIs are installed in ~/.local/bin. Resolve the standard installers'
  // locations before relying on PATH.
  const candidates = [
    join(homedir(), '.local', 'bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  return candidates.find(existsSync) || name;
}

// CANVASync deliberately uses the CLIs' subscription OAuth sessions, never an
// API key inherited from the bridge's shell. Claude and Codex both give API
// credentials precedence over a saved account login, so merely "not passing a
// key" is insufficient: remove those variables from the child environment.
function subscriptionCliEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  return env;
}

async function _statusSpawn(cmd, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: subscriptionCliEnv() });
    } catch (err) {
      resolve({ code: null, error: err });
      return;
    }
    let stdout = '';
    let stderr = '';
    let finished = false;
    const done = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      done({ code: null, timeout: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', error => done({ code: null, error, stdout, stderr }));
    child.on('close', code => done({ code, stdout, stderr }));
  });
}

/**
 * Read a CLI's login state without reading credential files or making a model
 * request. Both official commands exit 0 when authenticated.
 */
export async function cliProviderStatus(provider, { timeoutMs = 5000 } = {}) {
  if (!CLI_PROVIDERS.has(provider)) throw new Error(`unknown AI provider: ${provider}`);
  const args = provider === 'codex' ? ['login', 'status'] : ['auth', 'status'];
  const result = await _statusSpawn(providerBin(provider), args, timeoutMs);
  const installed = !(result.error && result.error.code === 'ENOENT');
  let authenticated = installed && result.code === 0;
  if (provider === 'claude' && authenticated) {
    // `claude auth status` currently exits 0 even when its JSON says the user
    // is logged out. Fail closed if the documented JSON cannot be read.
    try { authenticated = JSON.parse(result.stdout).loggedIn === true; }
    catch { authenticated = false; }
  }
  return {
    provider,
    installed,
    authenticated,
    timedOut: Boolean(result.timeout),
  };
}

export async function cliProviderStatuses() {
  const [claude, codex] = await Promise.all([
    cliProviderStatus('claude').catch(() => ({ provider: 'claude', installed: false, authenticated: false, timedOut: false })),
    cliProviderStatus('codex').catch(() => ({ provider: 'codex', installed: false, authenticated: false, timedOut: false })),
  ]);
  return { claude, codex };
}

async function settingValue(key) {
  const direct = process.env[key];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  try {
    const raw = await readFile(join(dataRoot(), 'settings.json'), 'utf8');
    const value = JSON.parse(raw)?.env?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch { return null; }
}

export async function resolveAIBackend() {
  return String(await settingValue('CSYNC_AI_BACKEND') || 'auto').toLowerCase();
}

/** Which backend would actually answer a request right now. */
export async function resolveAIProvider() {
  const backend = await resolveAIBackend();
  if (backend === 'local') return { provider: 'local', backend, statuses: null };
  if (backend === 'claude' || backend === 'codex') {
    const status = await cliProviderStatus(backend);
    return { provider: backend, backend, statuses: { [backend]: status } };
  }
  const statuses = await cliProviderStatuses();
  if (statuses.claude.authenticated) return { provider: 'claude', backend: 'auto', statuses };
  if (statuses.codex.authenticated) return { provider: 'codex', backend: 'auto', statuses };
  return { provider: 'local', backend: 'auto', statuses };
}

// claudeInvoke — run one headless `claude -p` job. The prompt goes in via
// stdin (never argv, so size and quoting are non-issues).
//
// Options:
//   timeoutMs     — hard kill after this long (default 5 min)
//   model         — optional model id/alias; otherwise use Settings/CLI default
//   allowedTools  — array of permission specifiers for --allowedTools. Headless
//                   -p runs DENY tools not allowlisted, so MCP jobs (calendar,
//                   gmail) must pass the mcp__<server> names they need.
//   extraArgs     — raw extra CLI args (escape hatch, e.g. --mcp-config)
export async function claudeInvoke(prompt, {
  timeoutMs = 300000,
  model = null,
  allowedTools = null,
  extraArgs = [],
} = {}) {
  const args = ['-p', '--output-format', 'text'];
  const configuredModel = model || await settingValue('CSYNC_CLAUDE_MODEL');
  if (configuredModel) args.push('--model', configuredModel);
  if (Array.isArray(allowedTools) && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  } else {
    // Parsing/mining are pure text transforms. Disabling tools prevents a
    // user's Claude project settings from turning one of these calls into an
    // unrelated filesystem or network agent run.
    args.push('--tools', '');
  }
  args.push('--no-session-persistence');
  args.push(...extraArgs);

  const result = await _trySpawn(
    providerBin('claude'), args, prompt, timeoutMs, 'claude', subscriptionCliEnv(),
  );
  return result.trim();
}

// Non-interactive Codex is constrained to read-only and receives the whole
// academic corpus on stdin. It may reason over the prompt, but it cannot edit
// the repository or persist a chat while acting as the pipeline's model.
export async function codexInvoke(prompt, { timeoutMs = 300000, model = null } = {}) {
  const configuredModel = model || await settingValue('CSYNC_CODEX_MODEL');
  const args = [
    'exec', '--sandbox', 'read-only', '--ephemeral', '--color', 'never',
    '--skip-git-repo-check',
  ];
  if (configuredModel) args.push('--model', configuredModel);
  args.push('-');
  const result = await _trySpawn(
    providerBin('codex'), args, prompt, timeoutMs, 'codex', subscriptionCliEnv(),
  );
  return result.trim();
}

// --- Local model backend ----------------------------------------------------
// A local MLX model (default: Qwen3.6-35B-A3B, already in the HF cache) run
// via scripts/local_generate.py. Used as a fallback when the claude CLI is
// unavailable (not installed, not logged in), or as the primary backend with
// CSYNC_AI_BACKEND=local. Text-only — no tools/MCP, so calendar agent jobs
// must not route here.
export const LOCAL_MODEL_ID = process.env.CSYNC_LOCAL_MODEL || 'mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit';
const DEFAULT_LOCAL_PYTHON = join(homedir(), 'mlx-env', 'bin', 'python');
// Frozen from the environment at module load. Kept exported for compatibility,
// but nothing in this file spawns it any more: see resolveLocalPython().
export const LOCAL_PYTHON = process.env.CSYNC_LOCAL_PYTHON || DEFAULT_LOCAL_PYTHON;

const __scriptsDir = dirname(fileURLToPath(import.meta.url));

// --- Cross-process local-model lock ----------------------------------------
// Loading the local model takes ~20 GB of RAM. Pipeline stages run as
// separate node processes, several classes at a time — without a machine-wide
// mutex they would each load their own copy simultaneously and hard-freeze
// the Mac. mkdir() is atomic, so a lock DIRECTORY at the data root serializes
// every localInvoke across all processes. Stale locks (crashed holder) are
// detected by PID liveness and reclaimed.

function _lockDir() {
  return join(dataRoot(), 'locks', 'local-model.lock');
}

// Reclaim a stale lock dir atomically: rename it aside to a unique tombstone,
// then delete the tombstone. rename is atomic, so when several waiters race
// only one wins — the losers get ENOENT and just retry acquire. A plain
// rm-by-path here would let a slow waiter delete the lock a live winner had
// already re-acquired, allowing two simultaneous ~20 GB model loads.
async function _reclaimLock(dir) {
  const tomb = `${dir}.stale-${process.pid}-${Date.now()}`;
  try { await rename(dir, tomb); } catch { return false; } // lost the race — fine
  await rm(tomb, { recursive: true, force: true }).catch(() => {});
  return true;
}

// A 45-minute hold wants a lazy poll; file-lock.js's 25 ms is right for its
// millisecond holds and absurd here.
const MODEL_LOCK_POLL_MS = 5000;

async function _acquireModelLock(maxWaitMs) {
  const dir = _lockDir();
  const pidFile = join(dir, 'pid');
  const deadline = Date.now() + maxWaitMs;
  await mkdir(dirname(dir), { recursive: true }); // parent locks/ must exist

  /**
   * The ONLY exit from an iteration that did not acquire. Every retry funnels
   * through here on purpose.
   *
   * A `continue` that skips this is how a retry loop becomes an unbounded busy
   * loop, and this function had one: the dir-vanished branch of the age check
   * went straight back to the top without sleeping and without ever looking at
   * the deadline. Leave a dangling symlink (or anything else that exists for
   * mkdir but not for stat) at the lock path and the loop spins a core
   * forever — maxWaitMs stops meaning anything. Suspected in the 2026-08-30
   * symptom recorded in WRITE-SAFETY-AUDIT.md, where model-lock.test's
   * pid-less case ran 192s under load against a 30s timeout. Same defect class
   * as file-lock.js F1, same fix.
   *
   * The one path that legitimately retries without sleeping is a SUCCESSFUL
   * reclaim: the dir we were waiting on has been renamed aside and deleted, so
   * the next mkdir either wins outright or loses to a new, live holder that
   * the next iteration will find and wait for. Bounded either way — and the
   * "reclaimed immediately" tests would otherwise pay a 5s poll to prove it.
   */
  const waitOrGiveUp = async justReclaimed => {
    if (Date.now() > deadline) throw new Error('timed out waiting for local-model lock');
    if (justReclaimed) return;
    // Clamped to what is left, so a caller that asked for a short wait gets a
    // short wait rather than one final full poll past its deadline.
    const remaining = deadline - Date.now();
    await new Promise(r => setTimeout(r, Math.max(0, Math.min(MODEL_LOCK_POLL_MS, remaining))));
  };

  for (;;) {
    try {
      await mkdir(dir, { recursive: false }); // atomic: fails if held
      await writeFile(pidFile, String(process.pid), 'utf8');
      _weHoldLock = true;
      return;
    } catch { /* held, or the write faulted — decide below, never spin */ }

    // Held — reclaim if the holder is dead, otherwise wait our turn.
    let reclaimed = false;
    let staleByAge = false;
    try {
      const pid = parseInt(await readFile(pidFile, 'utf8'), 10);
      if (pid > 0) {
        // EPERM means the holder EXISTS and simply is not ours to signal
        // (another user's job, a daemon). Only ESRCH — no such process —
        // licenses a reclaim. modelLockStatus was fixed for this and says
        // why; the READ-ONLY function got the fix while this one, the only
        // one that actually tears a lock down, kept collapsing them: a live
        // holder read as dead, its lock reclaimed, and two ~20 GB models
        // loaded at once — the exact failure this lock exists to prevent.
        let holderAlive = true;
        try { process.kill(pid, 0); } catch (err) { holderAlive = err?.code === 'EPERM'; }
        if (!holderAlive) reclaimed = await _reclaimLock(dir);
      } else {
        // Corrupt/empty pid file — holder identity unknowable. Fall through
        // to the age check so it can't wedge the lock forever.
        staleByAge = true;
      }
    } catch {
      // No pid file. Either the holder is between mkdir and writeFile
      // (sub-second) or it crashed in that gap. Age disambiguates.
      staleByAge = true;
    }
    if (staleByAge) {
      try {
        const st = await stat(dir);
        if (Date.now() - st.mtimeMs > 10_000) reclaimed = await _reclaimLock(dir);
      } catch { /* vanished mid-check — the next mkdir settles it */ }
    }
    await waitOrGiveUp(reclaimed);
  }
}

/**
 * Is the machine-wide model lock held right now, and by something still alive?
 *
 * Read-only — it never creates, reclaims or removes the lock. The bridge uses
 * it to answer a chat request with "the model is busy syncing" in a second
 * rather than queueing behind localInvoke's 45-minute wait, which to a user is
 * indistinguishable from a hang.
 */
export async function modelLockStatus() {
  const dir = _lockDir();
  let st = null;
  try { st = await stat(dir); } catch { return { held: false, pid: null, alive: false, heldForMs: 0, clockSkew: false }; }
  // `|| null` used to turn "-1" into -1 (truthy), and POSIX kill(-1, 0) means
  // "every process we may signal" and succeeds — so a pid file holding a
  // negative number reported a live holder that could never age out, while
  // _acquireModelLock, which guards with `if (pid > 0)`, would have reclaimed
  // the same lock and run. The dashboard and the pipeline must not disagree
  // about who holds the machine's one model slot.
  let pid = null;
  try {
    const parsed = parseInt(await readFile(join(dir, 'pid'), 'utf8'), 10);
    pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch { /* holder is mid-acquire */ }
  let alive = false;
  if (pid) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      // EPERM means the process EXISTS and simply is not ours to signal (pid 1,
      // or another user's job). Collapsing it into ESRCH reported a live holder
      // as "DEAD — stale lock" and invited a reclaim of a lock that is in use —
      // which is the two-concurrent-model-loads failure this lock exists for.
      alive = err && err.code === 'EPERM';
    }
  }
  const ageMs = Date.now() - st.mtimeMs;
  // A future mtime (clock step, NTP correction, a lock dir restored from a
  // backup) made `ageMs < 10_000` true forever, so a wedged lock rendered as a
  // healthy holder aged 0s. It is an anomaly and is reported as one.
  const clockSkew = ageMs < 0;
  if (!pid) alive = !clockSkew && ageMs < 10_000;
  return { held: true, pid, alive, heldForMs: Math.max(0, ageMs), clockSkew };
}

async function _releaseModelLock() {
  _weHoldLock = false;
  await rm(_lockDir(), { recursive: true, force: true }).catch(() => {});
}

// A SIGTERM path that calls process.exit() skips every `finally`, so the lock
// has to come off synchronously or the next run waits out the full 45 minutes
// behind a holder that no longer exists.
let _weHoldLock = false;
function _releaseModelLockSync() {
  if (!_weHoldLock) return;
  _weHoldLock = false;
  try { rmSync(_lockDir(), { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Which local model to load, resolved per call rather than at import.
 *
 * The pipeline spawns its stages with settings.json's CSYNC_* folded into the
 * environment, so a model chosen in the dashboard reaches them. Nothing folds
 * it into the BRIDGE's own process, so anything the bridge runs in-process —
 * the class chat, most obviously — was pinned to the compiled-in default and
 * quietly ignored the setting. Reading the file here makes both paths agree.
 */
/**
 * Per-function kill switches, set from the dashboard's Functions card and
 * stored as settings.json env values ("0" = off, absent = on). Every
 * orchestrator asks before spawning a stage: bridge/trigger.js (its own
 * reader, same rule), scripts/sync-all-contexts.js and index-progress's
 * counted/denominator logic all go through this table, so a switch turns the
 * stage off EVERYWHERE or it is not a switch.
 *
 * The off-regex is mirrored in bridge/public/app.js (STAGE_OFF_RE); the two
 * must agree or the dashboard switch lies about what the pipeline will do.
 */
export const STAGE_OFF_RE = /^(0|false|off|no)$/i;
export const STAGE_ENV = {
  parse:    'CSYNC_STAGE_PARSE',
  extract:  'CSYNC_STAGE_EXTRACT',
  mine:     'CSYNC_STAGE_MINE',
  graph:    'CSYNC_STAGE_GRAPH',      // env-only: no dashboard switch, the stage is CLI-only
  build:    'CSYNC_STAGE_CONTEXT',
  calendar: 'CSYNC_STAGE_CALENDAR',
};

export async function stageEnabled(stageKeyOrEnv) {
  const envKey = STAGE_ENV[stageKeyOrEnv] ?? stageKeyOrEnv;
  let v = process.env[envKey];
  if (v == null || v === '') {
    try {
      const raw = await readFile(join(dataRoot(), 'settings.json'), 'utf8');
      const s = JSON.parse(raw)?.env?.[envKey];
      if (typeof s === 'string') v = s;
    } catch { /* no settings file — every function defaults on */ }
  }
  return !(typeof v === 'string' && STAGE_OFF_RE.test(v.trim()));
}

export async function resolveLocalModel() {
  if (process.env.CSYNC_LOCAL_MODEL) return process.env.CSYNC_LOCAL_MODEL;
  try {
    const raw = await readFile(join(dataRoot(), 'settings.json'), 'utf8');
    const v = JSON.parse(raw)?.env?.CSYNC_LOCAL_MODEL;
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch { /* no settings file, or unreadable — use the default */ }
  return LOCAL_MODEL_ID;
}

/**
 * Which python runs local_generate.py, resolved per call rather than at import.
 *
 * Same asymmetry resolveLocalModel() exists for, one field over. The pipeline
 * spawns its stages with settings.json's CSYNC_* folded into the environment,
 * so a python chosen in Settings reaches them; nothing folds it into the
 * BRIDGE's own process, so anything the bridge runs in-process — /api/ask,
 * above all — spawned the module constant instead. A user whose MLX venv is
 * not at ~/mlx-env (the reason the Settings field exists) got working pipeline
 * stages and an Ask sidebar that 500s on every question, after pointlessly
 * taking and releasing the machine-wide model lock. INTEGRATION-AUDIT.md I14.
 */
export async function resolveLocalPython() {
  return (await settingValue('CSYNC_LOCAL_PYTHON')) || DEFAULT_LOCAL_PYTHON;
}

export async function localInvoke(prompt, {
  timeoutMs = 1200000,
  maxTokens = 8192,
  model = null,
  // Wait up to 45 min for our turn by default (queued jobs each take minutes),
  // then hold the lock for the whole generation. A caller serving an HTTP
  // request should pass something far smaller: a request held open for minutes
  // is indistinguishable from a hang, which is the reasoning behind the
  // bridge's existing local-lock 503 pre-check.
  lockWaitMs = 45 * 60 * 1000,
} = {}) {
  const runner = join(__scriptsDir, 'local_generate.py');
  const modelId = model || await resolveLocalModel();
  const python = await resolveLocalPython();
  const args = [runner, '--model', modelId, '--max-tokens', String(maxTokens)];
  await _acquireModelLock(lockWaitMs);
  try {
    const result = await _trySpawn(python, args, prompt, timeoutMs, 'local model');
    return result.trim();
  } finally {
    await _releaseModelLock();
  }
}

// aiInvoke — backend-agnostic text generation for parse/mine/context/chat.
// CSYNC_AI_BACKEND: 'claude', 'codex', 'local', or 'auto'. Auto uses a signed-
// in subscription CLI first (Claude, then Codex) and loads the local model only
// when neither CLI is authenticated or both fail. Jobs that need Claude tools
// (calendar MCP) must call claudeInvoke directly.
//
// Two options beyond the invoke knobs, both opt-in — omit them and routing is
// bit for bit what it always was, including the bare-string return every call
// site depends on:
//
//   needs — { tier, inputChars, tools }: what the JOB requires, checked
//     against scripts/model-profiles.js. A backend whose profile cannot
//     satisfy it is SKIPPED rather than tried. This applies in explicit mode
//     as well as auto: a user who pinned `local` still must not have the
//     520K-char mining corpus silently extracted wrong by a 4-bit model, and
//     "it answered" is not the same as "it answered correctly" — that is the
//     whole failure this is for. When nothing available fits, it throws
//     ModelTierUnavailable (code EMODELTIER) so the caller can choose between
//     its deterministic path and deferring the stage with a reason a user can
//     act on. An unsatisfiable `needs` is never quietly downgraded.
//
//   info — an out-param object, filled on SUCCESS with
//     { backend, model, tier, profile }. Left EXACTLY as passed on every
//     failure path, so a throw can never leave a caller reading the previous
//     run's backend as this one's. `model` is null when the CLI's own default
//     was used, because that is the honest answer.
export async function aiInvoke(prompt, {
  timeoutMs = 300000,
  model = null,
  codexModel = null,
  maxTokens = 8192,
  needs = null,
  info = null,
} = {}) {
  assertNeeds(needs);
  if (info != null && (typeof info !== 'object' || Array.isArray(info))) {
    throw new TypeError('info must be an object to fill, e.g. aiInvoke(p, { info: {} })');
  }
  const backend = await resolveAIBackend();

  // Resolved at most once per call, and only if a local profile or a local
  // invoke actually needs it — localInvoke would otherwise read it again.
  let localModelId;
  const resolveLocal = async () => (localModelId ??= await resolveLocalModel());

  const consider = async name => {
    const profile = profileFor(name, name === 'local' ? await resolveLocal() : null);
    return { name, profile, ...satisfies(profile, needs) };
  };

  // Filled only once the text is in hand. Everything above this line can throw
  // without the caller's object being touched.
  const fill = async profile => {
    if (!info) return;
    info.backend = profile.backend;
    info.tier = profile.tier;
    info.profile = profile.key;
    info.model = profile.backend === 'local' ? profile.modelId
      : profile.backend === 'codex' ? (codexModel || await settingValue('CSYNC_CODEX_MODEL'))
        : (model || await settingValue('CSYNC_CLAUDE_MODEL'));
  };

  const runCli = async (name, profile) => {
    const text = name === 'claude'
      ? await claudeInvoke(prompt, { timeoutMs, model })
      : await codexInvoke(prompt, { timeoutMs, model: codexModel });
    await fill(profile);
    return text;
  };
  const runLocal = async profile => {
    const text = await localInvoke(prompt, {
      timeoutMs: Math.max(timeoutMs, 1200000), maxTokens, model: profile.modelId,
    });
    await fill(profile);
    return text;
  };

  if (backend === 'local' || backend === 'claude' || backend === 'codex') {
    const only = await consider(backend);
    if (!only.ok) throw tierUnavailable(needs, [only]);
    return backend === 'local' ? runLocal(only.profile) : runCli(backend, only.profile);
  }

  const statuses = await cliProviderStatuses();
  const authenticated = [];
  if (statuses.claude.authenticated) authenticated.push('claude');
  if (statuses.codex.authenticated) authenticated.push('codex');

  const rejected = [];
  let lastError = null;
  for (const name of authenticated) {
    const candidate = await consider(name);
    if (!candidate.ok) {
      rejected.push(candidate);
      process.stderr.write(`${name} backend skipped: ${candidate.reason}\n`);
      continue;
    }
    try { return await runCli(name, candidate.profile); }
    catch (err) {
      lastError = err;
      process.stderr.write(`${name} backend failed (${String(err.message).slice(0, 200)}); trying the next signed-in backend\n`);
    }
  }

  const local = await consider('local');
  if (!local.ok) {
    rejected.push(local);
    process.stderr.write(`local backend skipped: ${local.reason}\n`);
    // A backend that FIT and then failed is a different fact from nothing
    // fitting at all, and the caller's remedy differs — retry, versus sign in
    // or fall back to the deterministic path. Report the one that happened.
    if (lastError) throw lastError;
    throw tierUnavailable(needs, rejected);
  }
  process.stderr.write(`No signed-in terminal AI completed the request; falling back to local model ${local.profile.modelId}\n`);
  return runLocal(local.profile);
}

async function _trySpawn(cmd, args, stdinData, timeoutMs, label = 'claude', env = null) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    } catch (err) {
      err.code = 'SPAWN_ERROR';
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // If this script is cancelled (bridge pipeline cancel sends SIGTERM),
    // take the child down too — otherwise a 20 GB model load keeps running
    // headless after its parent dies.
    const onTerm = () => {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      _releaseModelLockSync();
      process.exit(143);
    };
    process.once('SIGTERM', onTerm);

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('error', (err) => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', onTerm);
      err.code = 'SPAWN_ERROR';
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', onTerm);
      if (timedOut) return;
      if (code !== 0) {
        // The claude CLI reports auth failures on stdout, not stderr, so an
        // stderr-only message renders as "exited 1:" with nothing after it —
        // which is how an expired OAuth session stayed invisible for weeks.
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ').slice(0, 500);
        return reject(new Error(`${label} exited ${code}: ${detail || '(no output)'}`));
      }
      resolve(stdout);
    });

    // A prompt larger than the 64 KiB pipe buffer can fault this write. Without
    // a listener that is an unhandled 'error' event, which kills the process
    // outright — skipping the caller's fallback and its lock release.
    proc.stdin.on('error', (err) => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', onTerm);
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      reject(new Error(`${label} stdin failed (${err.code || err.message}) after ${stdinData.length} bytes`));
    });
    proc.stdin.write(stdinData, 'utf8');
    proc.stdin.end();
  });
}
