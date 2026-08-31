// local-python.js — which python the desktop shell names, and whether it is there.
//
// ONE question, and the repo had TWO answers. scripts/_util.js's
// resolveLocalPython() honours CSYNC_LOCAL_PYTHON — env first, then
// settings.json, then the ~/mlx-env default — and spawns exactly that, for
// /api/ask and every pipeline stage. main.js used to walk a fallback chain
// instead: configured, ~/mlx-env, /usr/local/bin/python3,
// /opt/homebrew/bin/python3, reporting the first that EXISTED. So a configured
// path with a typo in it left the readiness card green — it had silently
// substituted Homebrew's python and answered for that one — while every Ask
// question and every pipeline stage failed on the name the user actually
// typed. A card whose whole job is to say whether the local model will run
// answered about a python nothing would ever run.
//
// The convergence (INTEGRATION-AUDIT.md I14's follow-up): choose the path the
// way _util.js chooses it, and keep the existence check as DIAGNOSIS — say the
// configured python is missing, rather than quietly using a different one.
// Silent substitution is what I14 removed from the other side; putting it back
// here would just move the lie.
//
// Mirrored by hand rather than imported: main.js is CommonJS and _util.js is
// ESM, the same reason main.js's dataRoot() mirrors ../data-root.js. Extracted
// into its own file because main.js requires electron at module scope and
// therefore cannot be imported under node --test at all.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const trimmed = (value) =>
  (typeof value === 'string' && value.trim()) ? value.trim() : null;

/** The default _util.js falls back to, spelled the same way. */
function defaultLocalPython(home = os.homedir()) {
  return path.join(home, 'mlx-env', 'bin', 'python');
}

/**
 * env → settings.json → default, and NOTHING else. Deliberately unconditional:
 * whether the path exists is a separate question, answered separately, because
 * folding the two is exactly how the substitution bug happened.
 *
 * `settingsEnv` is settings.json's `env` object (or null) — read by the
 * caller, so this stays a pure function of its inputs.
 */
function resolveLocalPython({ env = process.env, settingsEnv = null, home = os.homedir() } = {}) {
  const fromEnv = trimmed(env?.CSYNC_LOCAL_PYTHON);
  if (fromEnv) return { python: fromEnv, source: 'env' };
  const fromSettings = trimmed(settingsEnv?.CSYNC_LOCAL_PYTHON);
  if (fromSettings) return { python: fromSettings, source: 'settings' };
  return { python: defaultLocalPython(home), source: 'default' };
}

/**
 * The same answer, plus whether that exact file is there. `python` is the
 * configured path whether or not it exists — a caller reporting readiness has
 * to be able to NAME what is missing.
 */
function localPythonStatus(options = {}) {
  const { exists = fs.existsSync } = options;
  const resolved = resolveLocalPython(options);
  let ok = false;
  // An unreadable parent directory throws rather than answering false, and a
  // readiness probe must not take the app down with it.
  try { ok = !!exists(resolved.python); } catch { ok = false; }
  return { ...resolved, ok };
}

module.exports = { defaultLocalPython, resolveLocalPython, localPythonStatus };
