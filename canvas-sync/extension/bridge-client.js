// bridge-client.js — ES module; all local bridge communication goes through here.

const BRIDGE_BASE = 'http://127.0.0.1:3847';

// --- Helpers --------------------------------------------------------------------

// Raised when the extension is not (or no longer) paired with the bridge. This
// is NOT a transient failure: retrying cannot fix it, only re-pairing can. It
// used to surface as a generic Error, get rewrapped as a NetworkError, and be
// retried on every Canvas page load forever, silently.
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Raised on a 5xx from the bridge — transient by definition (a busy disk, a
// half-written index, a restart mid-request). Callers wrap bridge writes in
// _withRetry, but that only retried canvas-client's ServerError; bridge 5xx
// arrived as a plain Error and aborted the whole sync on the first blip.
export class BridgeServerError extends Error {
  constructor(status, body = '') {
    super(`Bridge server error (${status})${body ? `: ${body}` : ''}`);
    this.name = 'BridgeServerError';
    this.status = status;
  }
}

async function _getSecret() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get('bridgeSecret', (result) => {
      if (chrome.runtime.lastError) {
        // A storage fault, not a pairing problem — keep it a plain Error.
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!result.bridgeSecret) {
        return reject(new ConfigError(
          'Not paired with the bridge yet. Open the Canvas Sync popup and connect with an install token.'
        ));
      }
      resolve(result.bridgeSecret);
    });
  });
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generic authed GET — used by v1.1 helpers below. Mirrors bridgePost's
// secret handling and error semantics so callers get a uniform experience.
async function _bridgeGet(path) {
  const secret = await _getSecret();
  const response = await fetch(`${BRIDGE_BASE}${path}`, {
    method: 'GET',
    headers: { 'X-Bridge-Secret': secret },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // 401 = the stored secret is no longer accepted (bridge re-keyed).
    // 403 = the bridge is paired to a different extension, or to none at all
    //       (someone force-unpaired). Both are re-pair situations, not
    //       transient faults — retrying cannot fix either.
    if (response.status === 401 || response.status === 403) {
      throw new ConfigError(
        'The bridge is no longer paired with this extension. Re-pair from the popup.');
    }
    if (response.status >= 500) throw new BridgeServerError(response.status, text);
    throw new Error(`Bridge responded ${response.status}: ${text}`);
  }
  const ct = response.headers.get('Content-Type') ?? '';
  if (ct.includes('application/json')) return response.json();
  return response.text();
}

// --- Public API -----------------------------------------------------------------

/**
 * bridgePost(path, payload)
 * POSTs JSON to the local bridge. Reads bridgeSecret from storage each call
 * so a rotated secret is picked up immediately.
 * Throws if bridgeSecret is missing or if the bridge returns a non-2xx status.
 */
export async function bridgePost(path, payload) {
  const secret = await _getSecret();

  const response = await fetch(`${BRIDGE_BASE}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-Bridge-Secret': secret,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // 401 = the stored secret is no longer accepted (bridge re-keyed).
    // 403 = the bridge is paired to a different extension, or to none at all
    //       (someone force-unpaired). Both are re-pair situations, not
    //       transient faults — retrying cannot fix either.
    if (response.status === 401 || response.status === 403) {
      throw new ConfigError(
        'The bridge is no longer paired with this extension. Re-pair from the popup.');
    }
    if (response.status >= 500) throw new BridgeServerError(response.status, text);
    throw new Error(`Bridge responded ${response.status}: ${text}`);
  }

  const ct = response.headers.get('Content-Type') ?? '';
  if (ct.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

/**
 * bridgeHealth()
 * Returns true if the bridge is reachable and responds 200 to GET /health.
 * Never throws — caller treats false as "bridge offline".
 */
export async function bridgeHealth() {
  // /health is secret-gated. Pre-pairing we have no secret and the probe will
  // return 401 — still counts as "bridge reachable" for status purposes, since
  // the server responded. Post-pairing we include the secret to get 200.
  let secret = null;
  try { secret = await _getSecret(); } catch { /* unpaired */ }

  try {
    const response = await fetch(`${BRIDGE_BASE}/health`, {
      method: 'GET',
      headers: secret ? { 'X-Bridge-Secret': secret } : {},
      signal: AbortSignal.timeout(4_000),
    });
    // 200 (authed) OR 401 (bridge up, not yet paired) both mean bridge is reachable.
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

/**
 * handshake(installToken)
 * Called once during setup. POSTs to /handshake with the installToken and
 * the extension's own ID; stores the returned secret in chrome.storage.local.
 *
 * OPEN: The bridge generates the shared secret. If the bridge is restarted and
 * the secret changes, the user must redo the handshake. Consider auto-retry.
 */
export async function handshake(installToken) {
  const response = await fetch(`${BRIDGE_BASE}/handshake`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      extensionId:  chrome.runtime.id,
      installToken,
    }),
  });

  if (!response.ok) {
    // The bridge answers with {"error": "..."} — a message written for a human.
    // Surfacing the raw body put `{"error":"...","paired":true}` in the popup,
    // so pull the field out and let the popup match on the prose.
    const text = await response.text().catch(() => '');
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === 'string') detail = parsed.error;
    } catch { /* not JSON — use the raw body */ }
    const err = new Error(
      detail ? `Handshake failed (${response.status}): ${detail}`
             : `Handshake failed (${response.status})`);
    err.status = response.status;
    throw err;
  }

  const { secret } = await response.json();
  if (!secret) throw new Error('Bridge did not return a secret during handshake.');

  await new Promise((resolve, reject) => {
    chrome.storage.local.set({ bridgeSecret: secret }, () => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve();
    });
  });

  return secret;
}

// --- v1.1: untracked / tracking config ------------------------------------------

/**
 * getUntracked()
 * Returns the `untracked` array from the bridge's config.json (folder names
 * the extension must NOT fetch or POST for). Empty array if none.
 */
export async function getUntracked() {
  const data = await _bridgeGet('/config/untracked');
  return Array.isArray(data?.untracked) ? data.untracked : [];
}

/**
 * addUntracked(folderName)
 * Explicit add. Usually not needed directly — /class/delete also adds. Kept
 * for symmetry with removeUntracked.
 */
export async function addUntracked(folderName) {
  return bridgePost('/config/untracked/add', { folderName });
}

/**
 * removeUntracked(folderName)
 * Re-track a previously-deleted class. Does NOT re-download data; next sync
 * will repopulate the folder from scratch.
 */
export async function removeUntracked(folderName) {
  return bridgePost('/config/untracked/remove', { folderName });
}

/**
 * publishScope(courseIds, enrolled)
 * Tells the bridge which courses this extension is syncing, so the dashboard,
 * the pipeline and the calendar can all narrow to the same set. `enrolled` is
 * the full course list, cached so the app's class picker works without Canvas.
 * Pass courseIds = null to clear the scope (bridge falls back to last_sync).
 *
 * Canvas ids are strings on the wire — canvas-client.js requests
 * `json+canvas-string-ids` — so they are sent as strings and never coerced.
 *
 * Callers should treat a failure here as cosmetic: the scope is a hint for the
 * desktop side, and a sync must never fail because the hint could not be sent.
 */
export async function publishScope(courseIds, enrolled) {
  const payload = {
    courseIds: Array.isArray(courseIds) ? courseIds.map(id => String(id)) : null,
  };
  if (Array.isArray(enrolled)) {
    payload.enrolled = enrolled.map(c => ({
      courseId: String(c.id ?? c.courseId ?? ''),
      code: c.course_code ?? c.code ?? null,
      name: c.name ?? null,
      // metadata.json stores Canvas's term object; the mirror wants its name.
      term: (typeof c.term === 'string' ? c.term : c.term?.name) ?? null,
    }));
  }
  return bridgePost('/config/scope', payload);
}

/**
 * fetchSelectionIntent()
 * A selection change the user made in the desktop app. The app cannot write
 * chrome.storage, so it leaves the change here for the next sync to apply.
 * Returns null when there is nothing pending.
 */
export async function fetchSelectionIntent() {
  const data = await _bridgeGet('/config/intent');
  return data?.intent ?? null;
}

/**
 * ackSelectionIntent(id)
 * Confirms an intent was applied. The id is echoed back so that an intent the
 * user created *while this sync was running* is not thrown away.
 */
export async function ackSelectionIntent(id) {
  return bridgePost('/config/intent/ack', { id });
}

// --- v1.1: destructive class delete ---------------------------------------------

/**
 * deleteClass(folderName)
 * Asks the bridge to safe-delete `<root>/classes/<folderName>` and add the
 * folder to `untracked`. Returns `{ ok, deleted, cleanupPid }`.
 * The bridge enforces all 8 safe-delete rules; this wrapper just proxies.
 */
export async function deleteClass(folderName) {
  return bridgePost('/class/delete', { folderName });
}

// --- v1.1: course-file ingest + index -------------------------------------------

/**
 * ingestCourseFile(payload)
 * Uploads one Canvas course file's binary (base64). Payload shape:
 *   { courseId, fileId, displayName, filename, contentType, size,
 *     canvasUpdatedAt, dataBase64 }
 * Bridge returns `{ ok, localPath, changed }`.
 */
export async function ingestCourseFile(payload) {
  return bridgePost('/ingest/course-file', payload);
}

/**
 * getFilesIndex(folderName)
 * Returns the bridge-authoritative `files_index.json` for a class. Shape:
 *   { files: [{ canvasId, size, canvasUpdatedAt, ... }, ...] }
 * Used by the extension to diff before re-downloading.
 */
export async function getFilesIndex(folderName) {
  const data = await _bridgeGet(`/files-index/${encodeURIComponent(folderName)}`);
  return Array.isArray(data?.files) ? data.files : [];
}
