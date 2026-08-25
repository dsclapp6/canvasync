// Local state for canvas-calendar:
//   - credentials.json   Google OAuth Desktop client_id/client_secret (chmod 600)
//   - tokens.json        OAuth refresh+access tokens (chmod 600)
//   - config.json        { calendarId, defaultTimezone }
//   - mapping.json       { [canvasEventKey]: { googleEventId, contentHash, kind, lastPushedAt } }
//
// All live in $CANVAS_SYNC_HOME/calendar/.
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { calendarDir } from './sync-home.js';

const P = {
  credentials: () => join(calendarDir(), 'credentials.json'),
  tokens:      () => join(calendarDir(), 'tokens.json'),
  config:      () => join(calendarDir(), 'config.json'),
  mapping:     () => join(calendarDir(), 'mapping.json'),
};

async function atomicWrite(filePath, data, mode) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp.' + randomBytes(6).toString('hex');
  await writeFile(tmp, data, 'utf8');
  if (mode != null) await chmod(tmp, mode);
  await rename(tmp, filePath);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function loadCredentials() {
  return readJson(P.credentials());
}
export async function saveCredentials(obj) {
  await atomicWrite(P.credentials(), JSON.stringify(obj, null, 2), 0o600);
}

export async function loadTokens() {
  return readJson(P.tokens());
}
export async function saveTokens(obj) {
  await atomicWrite(P.tokens(), JSON.stringify(obj, null, 2), 0o600);
}

export async function loadConfig() {
  return readJson(P.config(), {});
}
export async function saveConfig(obj) {
  await atomicWrite(P.config(), JSON.stringify(obj, null, 2), 0o600);
}

export async function loadMapping() {
  return readJson(P.mapping(), {});
}
export async function saveMapping(obj) {
  await atomicWrite(P.mapping(), JSON.stringify(obj, null, 2), 0o600);
}

export function eventKey({ canvasAssignmentId, kind = 'assignment', checkpointIndex = null }) {
  const base = `${canvasAssignmentId}|${kind}`;
  return checkpointIndex != null ? `${base}|${checkpointIndex}` : base;
}

export const paths = P;
