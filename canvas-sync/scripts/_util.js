import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { dataRoot } from '../data-root.js';

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

// Default model for all AI jobs in this repo. Claude Opus 5 unless overridden
// per-call or via CSYNC_CLAUDE_MODEL.
export const DEFAULT_MODEL = process.env.CSYNC_CLAUDE_MODEL || 'claude-opus-5';

// --- Anthropic API key -----------------------------------------------------
// The `claude` CLI authenticates with an OAuth session by default, and that
// session expires — when it does, every pipeline stage falls through to the
// local model and the machine slows to a crawl for jobs that used to take
// seconds. A key stored in config.json (or ANTHROPIC_API_KEY in the
// environment) is handed to the CLI so the user can restore the fast path
// without a terminal login.
//
// The value is never returned by any read path here: anthropicKeyStatus()
// reports presence and a masked hint, and nothing else.
export async function resolveAnthropicKey() {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return { key: fromEnv.trim(), source: 'env' };
  try {
    const cfg = JSON.parse(await readFile(join(dataRoot(), 'config.json'), 'utf8'));
    const k = cfg?.anthropicApiKey;
    if (typeof k === 'string' && k.trim()) return { key: k.trim(), source: 'config' };
  } catch { /* no config, or not readable — treat as unset */ }
  return { key: null, source: null };
}

export async function anthropicKeyStatus() {
  const { key, source } = await resolveAnthropicKey();
  if (!key) return { present: false, source: null, hint: null };
  // Enough to recognise which key it is, not enough to use it.
  const hint = key.length > 8 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '…';
  return { present: true, source, hint };
}

// claudeInvoke — run one headless `claude -p` job. The prompt goes in via
// stdin (never argv, so size and quoting are non-issues).
//
// Options:
//   timeoutMs     — hard kill after this long (default 5 min)
//   model         — model id/alias for --model (default: DEFAULT_MODEL)
//   allowedTools  — array of permission specifiers for --allowedTools. Headless
//                   -p runs DENY tools not allowlisted, so MCP jobs (calendar,
//                   gmail) must pass the mcp__<server> names they need.
//   extraArgs     — raw extra CLI args (escape hatch, e.g. --mcp-config)
export async function claudeInvoke(prompt, {
  timeoutMs = 300000,
  model = DEFAULT_MODEL,
  allowedTools = null,
  extraArgs = [],
} = {}) {
  const args = ['-p', '--output-format', 'text'];
  if (model) args.push('--model', model);
  if (Array.isArray(allowedTools) && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }
  args.push(...extraArgs);

  // A stored key beats the CLI's own OAuth session, which is what expires.
  const { key } = await resolveAnthropicKey();
  const env = key ? { ...process.env, ANTHROPIC_API_KEY: key } : null;

  const result = await _trySpawn('claude', args, prompt, timeoutMs, 'claude', env);
  return result.trim();
}

// --- Local model backend ----------------------------------------------------
// A local MLX model (default: Qwen3.6-35B-A3B, already in the HF cache) run
// via scripts/local_generate.py. Used as a fallback when the claude CLI is
// unavailable (not installed, not logged in), or as the primary backend with
// CSYNC_AI_BACKEND=local. Text-only — no tools/MCP, so calendar agent jobs
// must not route here.
export const LOCAL_MODEL_ID = process.env.CSYNC_LOCAL_MODEL || 'mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit';
export const LOCAL_PYTHON = process.env.CSYNC_LOCAL_PYTHON || join(homedir(), 'mlx-env', 'bin', 'python');

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
  try { await rename(dir, tomb); } catch { return; } // lost the race — fine
  await rm(tomb, { recursive: true, force: true }).catch(() => {});
}

async function _acquireModelLock(maxWaitMs) {
  const dir = _lockDir();
  const pidFile = join(dir, 'pid');
  const deadline = Date.now() + maxWaitMs;
  await mkdir(dirname(dir), { recursive: true }); // parent locks/ must exist
  for (;;) {
    try {
      await mkdir(dir, { recursive: false }); // atomic: fails if held
      await writeFile(pidFile, String(process.pid), 'utf8');
      _weHoldLock = true;
      return;
    } catch {
      // Held — reclaim if the holder is dead, otherwise wait our turn.
      let staleByAge = false;
      try {
        const pid = parseInt(await readFile(pidFile, 'utf8'), 10);
        if (pid > 0) {
          try { process.kill(pid, 0); } catch { await _reclaimLock(dir); continue; }
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
          if (Date.now() - st.mtimeMs > 10_000) {
            await _reclaimLock(dir);
            continue;
          }
        } catch { /* dir vanished — retry acquire */ continue; }
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for local-model lock');
      await new Promise(r => setTimeout(r, 5000));
    }
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

export async function localInvoke(prompt, { timeoutMs = 1200000, maxTokens = 8192, model = null } = {}) {
  const runner = join(__scriptsDir, 'local_generate.py');
  const modelId = model || await resolveLocalModel();
  const args = [runner, '--model', modelId, '--max-tokens', String(maxTokens)];
  // Wait up to 45 min for our turn (queued jobs each take minutes), then hold
  // the lock for the whole generation.
  await _acquireModelLock(45 * 60 * 1000);
  try {
    const result = await _trySpawn(LOCAL_PYTHON, args, prompt, timeoutMs, 'local model');
    return result.trim();
  } finally {
    await _releaseModelLock();
  }
}

// aiInvoke — backend-agnostic text generation for parse/mine/context jobs.
// CSYNC_AI_BACKEND: 'claude' (never fall back), 'local' (local model only),
// or 'auto' (default: claude first, local model if claude fails — e.g. OAuth
// expired). Jobs that need tools (calendar MCP) must call claudeInvoke directly.
export async function aiInvoke(prompt, { timeoutMs = 300000, model = DEFAULT_MODEL, maxTokens = 8192 } = {}) {
  const backend = (process.env.CSYNC_AI_BACKEND || 'auto').toLowerCase();
  if (backend === 'local') {
    return localInvoke(prompt, { timeoutMs: Math.max(timeoutMs, 1200000), maxTokens });
  }
  try {
    return await claudeInvoke(prompt, { timeoutMs, model });
  } catch (err) {
    if (backend === 'claude') throw err;
    process.stderr.write(`claude backend failed (${String(err.message).slice(0, 200)}); falling back to local model ${LOCAL_MODEL_ID}\n`);
    return localInvoke(prompt, { timeoutMs: Math.max(timeoutMs, 1200000), maxTokens });
  }
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

