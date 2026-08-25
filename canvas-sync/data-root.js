// data-root.js — the single definition of where synced data lives.
//
// Every entry point needs this answer and they MUST agree. They did not: the
// Electron app (app/main.js) defaulted to ~/canvas-sync-data while the bridge,
// the pipeline scripts and install.sh each defaulted to ~/Documents/CANVASync.
// Running a script by hand therefore read and wrote a different root than the
// app, which looks exactly like "the sync silently does nothing".
//
// The default is ~/canvas-sync-data, NOT anything under ~/Documents. macOS
// gates ~/Documents behind TCC, and with "Desktop & Documents Folders" iCloud
// sync on it also evicts files to *.icloud placeholders and forks concurrent
// writes into "name 2.json" conflict copies. Both break a local data store.
//
// No imports beyond node builtins, so bridge/, scripts/ and app/ can all load
// this file directly despite having separate node_modules trees.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const DEFAULT_DATA_ROOT = path.join(os.homedir(), 'canvas-sync-data');
export const LEGACY_DATA_ROOT  = path.join(os.homedir(), 'Documents', 'CANVASync');

// The filesystem probe is cached, but CANVAS_SYNC_HOME is re-read on every
// call: the test suites set it in a before() hook, which runs long after this
// module is imported. Resolving eagerly would pin every test to the real home.
let _probed = null;

function _fallbackRoot() {
  if (_probed) return _probed;
  // Honour an existing pre-move install rather than silently orphaning it —
  // but only while the new default does not exist yet, so a user who has
  // already migrated is never dragged back into ~/Documents.
  try {
    if (!fs.existsSync(DEFAULT_DATA_ROOT) &&
        fs.existsSync(path.join(LEGACY_DATA_ROOT, 'config.json'))) {
      _probed = LEGACY_DATA_ROOT;
      return _probed;
    }
  } catch { /* unreadable — fall through to the default */ }
  _probed = DEFAULT_DATA_ROOT;
  return _probed;
}

export function dataRoot() {
  return process.env.CANVAS_SYNC_HOME || _fallbackRoot();
}

// True when we fell back to the legacy location, so callers can warn once at
// startup instead of leaving the user to wonder why files land in iCloud.
export function usingLegacyDataRoot() {
  return !process.env.CANVAS_SYNC_HOME && _fallbackRoot() === LEGACY_DATA_ROOT;
}
