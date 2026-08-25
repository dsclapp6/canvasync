// Where each downloaded file actually came from.
//
// The sync writes every binary it can reach into files/ and records it in
// files_index.json — but that index says nothing about WHERE on Canvas the file
// was found. A flat alphabetical list of 78 PDFs is useless; "Module: Week 4"
// and "Assignment: Case 2 brief" are how the course itself is organised.
//
// Provenance is derived at READ time from the JSON the sync already stores
// (modules.json, assignments.json, pages.json, …) rather than recorded at
// download time. That means it works on data synced before this file existed,
// needs no re-sync or migration, and self-corrects when a prof moves a file
// between modules.
//
// Node builtins only — this is loaded by the bridge server on every class read.

import fs from 'node:fs/promises';
import path from 'node:path';

// Display order of the groups. Modules come first: they are the course's own
// organisation of its material. "files-tab" is last because it is the fallback
// for everything we could not attribute.
export const KIND_ORDER = [
  'module', 'assignment', 'quiz', 'discussion', 'page', 'announcement',
  'syllabus', 'files-tab',
];

export const KIND_LABELS = {
  module:       'Module',
  assignment:   'Assignments',
  quiz:         'Quizzes',
  discussion:   'Discussions',
  page:         'Pages',
  announcement: 'Announcements',
  syllabus:     'Syllabus',
  'files-tab':  'Files tab',
};

// Canvas file links are always /files/<id> — in module items, rich-text bodies
// and preview URLs alike.
const FILE_ID_RE = /\/files\/(\d+)/g;

export function extractFileIds(html) {
  if (typeof html !== 'string' || !html) return [];
  const ids = new Set();
  FILE_ID_RE.lastIndex = 0;
  let m;
  while ((m = FILE_ID_RE.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
}

async function readJsonOrNull(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

async function readTextOrNull(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

function asArray(v) { return Array.isArray(v) ? v : []; }

function trimLabel(s, max = 80) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// A file can legitimately appear in several places (in a module AND linked from
// an assignment). Record every origin, but rank them so the UI has one place to
// file it under. Lower rank wins.
function rankOf(kind) {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

/**
 * Build canvasId -> origins[] from already-synced course JSON.
 * Every origin is { kind, label, group, sort } where `group` is the grouping key
 * the UI buckets by and `sort` orders the buckets.
 */
export function deriveOrigins(sources = {}) {
  const {
    modules = [], assignments = [], pages = [], announcements = [],
    discussions = [], quizzes = [], syllabusHtml = null,
  } = sources;

  const byId = new Map();
  const add = (fileId, origin) => {
    const id = String(fileId);
    if (!/^\d+$/.test(id)) return;
    const list = byId.get(id) ?? [];
    // Same group twice (a file linked twice in one page) collapses to one.
    if (!list.some(o => o.group === origin.group)) list.push(origin);
    byId.set(id, list);
  };

  // --- Modules: both File items and files linked from item bodies ------------
  asArray(modules).forEach((mod, modIdx) => {
    const name = trimLabel(mod?.name) ?? 'Untitled module';
    const pos  = Number.isFinite(Number(mod?.position)) ? Number(mod.position) : modIdx + 1;
    const origin = {
      kind: 'module', label: name, group: `module:${mod?.id ?? name}`, sort: pos,
    };
    asArray(mod?.items).forEach((item, itemIdx) => {
      const itemPos = Number.isFinite(Number(item?.position)) ? Number(item.position) : itemIdx + 1;
      if ((item?.type === 'File' || item?.type === 'Attachment') && item?.content_id != null) {
        add(item.content_id, { ...origin, itemLabel: trimLabel(item?.title), itemSort: itemPos });
      }
      // Module items can also be an external URL pointing at a course file.
      for (const id of extractFileIds(item?.url ?? '')) {
        add(id, { ...origin, itemLabel: trimLabel(item?.title), itemSort: itemPos });
      }
    });
  });

  // --- Rich-text bodies -----------------------------------------------------
  const scanBodies = (list, kind, titleKey, bodyKeys) => {
    asArray(list).forEach(entry => {
      const label = trimLabel(entry?.[titleKey]) ?? KIND_LABELS[kind];
      // itemId alongside itemLabel: the label is trimmed for display, so a
      // consumer matching on it silently misses every item with a long title.
      const itemId = entry?.id != null ? String(entry.id) : null;
      for (const key of bodyKeys) {
        for (const id of extractFileIds(entry?.[key])) {
          add(id, { kind, label: KIND_LABELS[kind], group: kind, sort: 100 + rankOf(kind), itemLabel: label, itemId });
        }
      }
    });
  };

  // Canvas mirrors every quiz as a gradebook assignment carrying the same title
  // and the same description, so attributing a file to both prints the same
  // item twice — "Assignments: S2a-Concept Check…" directly above "Quizzes:
  // S2a-Concept Check…" — which it did for 33 of BUSI 380's 34 files. The quiz
  // is the real item, because the quiz page is where the student actually goes.
  // Only drop the shell when the quiz it mirrors is genuinely present to be
  // attributed to; otherwise the file would lose its only origin.
  const quizIds = new Set(asArray(quizzes).map(q => q?.id).filter(v => v != null).map(String));
  const realAssignments = asArray(assignments).filter(a => {
    const qid = a?.quiz_id ?? a?.quizId;
    return !(qid != null && quizIds.has(String(qid)));
  });

  scanBodies(realAssignments, 'assignment',   'name',  ['description']);
  scanBodies(quizzes,       'quiz',         'title', ['description']);
  scanBodies(discussions,   'discussion',   'title', ['message', 'replies_text']);
  scanBodies(pages,         'page',         'title', ['body']);
  scanBodies(announcements, 'announcement', 'title', ['message']);

  for (const id of extractFileIds(syllabusHtml)) {
    add(id, {
      kind: 'syllabus', label: KIND_LABELS.syllabus, group: 'syllabus',
      sort: 100 + rankOf('syllabus'), itemLabel: 'Linked from the syllabus page',
    });
  }

  for (const list of byId.values()) {
    list.sort((a, b) => rankOf(a.kind) - rankOf(b.kind) || (a.sort - b.sort));
  }
  return byId;
}

const SYLLABUS_NAME_RE = /syllab(us|i)/i;

// Attach `origins` to every files_index entry. Anything we cannot attribute
// came from the course's Files tab — that listing is the only download path
// that leaves no trace in the JSON we keep.
export function attachOrigins(filesIndex, originsById) {
  return asArray(filesIndex).map(f => {
    const found = originsById.get(String(f?.canvasId)) ?? [];
    const origins = found.length ? found.slice() : [];
    if (!origins.length && SYLLABUS_NAME_RE.test(f?.displayName ?? f?.filename ?? '')) {
      origins.push({
        kind: 'syllabus', label: KIND_LABELS.syllabus, group: 'syllabus',
        sort: 100 + rankOf('syllabus'), itemLabel: 'Course syllabus',
      });
    }
    if (!origins.length) {
      origins.push({
        kind: 'files-tab', label: KIND_LABELS['files-tab'], group: 'files-tab',
        sort: 100 + rankOf('files-tab'), itemLabel: null,
      });
    }
    return { ...f, origins };
  });
}

/** Read a class dir and return its files_index enriched with `origins`. */
export async function filesWithOrigins(classDir, filesIndex) {
  const [modules, assignments, pages, announcements, discussions, quizzes, syllabusHtml] =
    await Promise.all([
      readJsonOrNull(path.join(classDir, 'modules.json')),
      readJsonOrNull(path.join(classDir, 'assignments.json')),
      readJsonOrNull(path.join(classDir, 'pages.json')),
      readJsonOrNull(path.join(classDir, 'announcements.json')),
      readJsonOrNull(path.join(classDir, 'discussions.json')),
      readJsonOrNull(path.join(classDir, 'quizzes.json')),
      readTextOrNull(path.join(classDir, 'syllabus.html')),
    ]);
  const origins = deriveOrigins({
    modules, assignments, pages, announcements, discussions, quizzes, syllabusHtml,
  });
  return attachOrigins(filesIndex, origins);
}
