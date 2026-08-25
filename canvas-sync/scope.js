// scope.js — which classes are "current", shared by every entry point.
//
// "Active enrollment" on Canvas includes every past semester, so a Canvas
// account that has been used for two years lists twenty-odd courses. The
// extension already narrows that to a sync scope (an explicit saved selection,
// or the current term when the user never saved one) — but nothing downstream
// knew about it. The dashboard listed all twenty classes in the sidebar, the
// pipeline re-ran extraction and the AI stages over all twenty on every sync,
// and dead orientation shells ("Power of Persuasion", "Emergency Information")
// turned up in the calendar worklist.
//
// This module is the one place that answers "is this class current?". It reads
// the answer off disk so the bridge, the dashboard API and the standalone
// pipeline scripts all agree without talking to the extension.
//
// Two sources, in order:
//   1. sync-scope.json → courseIds — pushed by the extension the moment the
//      selection changes or a sync computes its course list. Authoritative.
//      It is its own file rather than a key in config.json deliberately:
//      config.json holds the pairing secret at mode 0600 and is rewritten
//      whole, and per-sync churn has no business sharing that failure domain.
//   2. last_sync.json → coursesSeen — what the last completed sync covered.
//      Equivalent in practice (the extension records every course it set out
//      to sync, including ones that then failed) and survives a scope reset.
//
// When neither exists — a fresh install, or a pre-1.1 data folder — the scope
// is null, which every consumer must read as "everything is in scope". Nothing
// may be hidden or deleted on the strength of an unknown scope.
//
// No imports beyond node builtins: bridge/, scripts/ and app/ have separate
// node_modules trees and all need to load this file directly.

import fs from 'node:fs';
import path from 'node:path';

export const SCOPE_FILE = 'sync-scope.json';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Canvas ids arrive as numbers from the API and as strings from folder names.
// Everything here is normalised to strings so the two can never miss.
function normaliseIds(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const id of list) {
    const s = String(id).trim();
    if (/^\d+$/.test(s)) out.push(s);
  }
  return out;
}

/**
 * Read the current sync scope from a data root.
 * @returns {{courseIds: string[]|null, source: 'selection'|'last-sync'|'none', updatedAt: string|null}}
 */
export function readSyncScope(root) {
  const mirror = readJson(path.join(root, SCOPE_FILE));
  const fromMirror = normaliseIds(mirror?.courseIds);
  if (fromMirror) {
    return { courseIds: fromMirror, source: 'selection', updatedAt: mirror.updatedAt ?? null };
  }
  const lastSync = readJson(path.join(root, 'last_sync.json'));
  const fromSync = normaliseIds(lastSync?.coursesSeen);
  if (fromSync) {
    return { courseIds: fromSync, source: 'last-sync', updatedAt: lastSync.timestamp ?? null };
  }
  return { courseIds: null, source: 'none', updatedAt: null };
}

// The extension's view of every course the user is enrolled in, cached beside
// the scope so the dashboard can offer a class picker without Canvas access
// (and without the extension being awake). Empty until the first sync.
export function readEnrolledCourses(root) {
  const mirror = readJson(path.join(root, SCOPE_FILE));
  if (!Array.isArray(mirror?.enrolled)) return [];
  return mirror.enrolled
    .filter(c => c && /^[0-9]+$/.test(String(c.courseId ?? '').trim()))
    .map(c => ({
      courseId: String(c.courseId).trim(),
      code: typeof c.code === 'string' ? c.code : null,
      name: typeof c.name === 'string' ? c.name : null,
      term: typeof c.term === 'string' ? c.term : null,
    }));
}

/**
 * Class folders are always "<courseId>-<slug>" — anything else under classes/
 * is not ours.
 *
 * This lived as a private const in THREE places (bridge/trigger.js's
 * CLASS_DIR_RE, bridge/server.js's CLASS_RE, and every ad-hoc readdir), and the
 * places that forgot it paid for it: a bare readdir of classes/ enumerates
 * .DS_Store, which is how "class .DS_Store, meeting source=none" reached the
 * meeting-time recovery output. One exported matcher so a fourth consumer
 * cannot invent a fifth rule.
 */
export const CLASS_DIR_RE = /^[0-9]+-[a-z0-9-]+$/;

export function isClassDirName(name) {
  return CLASS_DIR_RE.test(String(name ?? ''));
}

// Class folders are always "<courseId>-<slug>".
export function courseIdOf(folderName) {
  const m = /^(\d+)-/.exec(String(folderName ?? ''));
  return m ? m[1] : null;
}

/**
 * Is this class folder inside the scope? An unknown scope includes everything —
 * see the note at the top: never hide or delete on the strength of no data.
 */
export function isInScope(scope, folderName) {
  if (!scope?.courseIds) return true;
  const id = courseIdOf(folderName);
  return id != null && scope.courseIds.includes(id);
}
