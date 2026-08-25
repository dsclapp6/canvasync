// file-origins.test.js — where each downloaded file came from.
//
// Provenance is derived at read time from the JSON the sync already stores, so
// the tests here are mostly about attribution rules: which source wins when a
// file appears in several, and what happens to a file we cannot attribute at
// all (it must still show up — silently dropping a file the user downloaded is
// worse than mislabelling it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractFileIds, deriveOrigins, attachOrigins, filesWithOrigins,
} from '../file-origins.js';

const file = (canvasId, displayName = `f${canvasId}.pdf`) => ({ canvasId, displayName });
const origins = (idx, f) => attachOrigins([f], idx)[0].origins;

test('extractFileIds pulls every /files/<id> out of a body', () => {
  const html = '<a href="/courses/1/files/123/download">a</a> <img src="/files/456/preview">';
  assert.deepEqual(extractFileIds(html).sort(), ['123', '456']);
});

test('extractFileIds is safe on non-strings and repeated calls', () => {
  assert.deepEqual(extractFileIds(null), []);
  assert.deepEqual(extractFileIds(undefined), []);
  assert.deepEqual(extractFileIds(42), []);
  // The module-level regex is /g — a stale lastIndex would make the second
  // call miss the first match.
  const html = '/files/7';
  assert.deepEqual(extractFileIds(html), ['7']);
  assert.deepEqual(extractFileIds(html), ['7']);
});

test('extractFileIds dedupes an id linked twice', () => {
  assert.deepEqual(extractFileIds('/files/9 and /files/9 again'), ['9']);
});

test('a module File item is attributed to its module, by name', () => {
  const idx = deriveOrigins({
    modules: [{ id: 'm1', name: 'Week 3 — Valuation', position: 3, items: [
      { type: 'File', content_id: '100', title: 'Lecture deck', position: 2 },
    ] }],
  });
  const [o] = origins(idx, file('100'));
  assert.equal(o.kind, 'module');
  assert.equal(o.label, 'Week 3 — Valuation');
  assert.equal(o.itemLabel, 'Lecture deck');
  assert.equal(o.sort, 3);
  assert.equal(o.itemSort, 2);
});

test("Canvas's older 'Attachment' item type counts as a module file", () => {
  const idx = deriveOrigins({
    modules: [{ id: 'm1', name: 'Week 1', items: [
      { type: 'Attachment', content_id: '101' },
    ] }],
  });
  assert.equal(origins(idx, file('101'))[0].kind, 'module');
});

test('a module item that only links the file by URL still attributes', () => {
  const idx = deriveOrigins({
    modules: [{ id: 'm1', name: 'Readings', items: [
      { type: 'ExternalUrl', title: 'Chapter 4', url: 'https://x.edu/courses/1/files/102' },
    ] }],
  });
  assert.equal(origins(idx, file('102'))[0].kind, 'module');
});

test('assignment / quiz / discussion / page / announcement bodies each attribute', () => {
  const idx = deriveOrigins({
    assignments:   [{ name: 'Case 2 brief', description: '<a href="/files/201">brief</a>' }],
    quizzes:       [{ title: 'Midterm',     description: '/files/202' }],
    discussions:   [{ title: 'Week 5 forum', message: '/files/203' }],
    pages:         [{ title: 'Session 7',   body: '/files/204' }],
    announcements: [{ title: 'Room change', message: '/files/205' }],
  });
  assert.equal(origins(idx, file('201'))[0].kind, 'assignment');
  assert.equal(origins(idx, file('201'))[0].itemLabel, 'Case 2 brief');
  assert.equal(origins(idx, file('202'))[0].kind, 'quiz');
  assert.equal(origins(idx, file('203'))[0].kind, 'discussion');
  assert.equal(origins(idx, file('204'))[0].kind, 'page');
  assert.equal(origins(idx, file('205'))[0].kind, 'announcement');
});

test('a file linked in a discussion reply is attributed to the discussion', () => {
  const idx = deriveOrigins({
    discussions: [{ title: 'Q&A', message: 'no links', replies_text: 'see /files/206' }],
  });
  assert.equal(origins(idx, file('206'))[0].kind, 'discussion');
});

test('a file linked from the syllabus page is attributed to the syllabus', () => {
  const idx = deriveOrigins({ syllabusHtml: '<a href="/files/207">schedule</a>' });
  assert.equal(origins(idx, file('207'))[0].kind, 'syllabus');
});

test('a file in several places keeps them all, module first', () => {
  const idx = deriveOrigins({
    modules:     [{ id: 'm1', name: 'Week 2', position: 2, items: [
      { type: 'File', content_id: '300' },
    ] }],
    assignments: [{ name: 'HW 2', description: '/files/300' }],
    pages:       [{ title: 'Session 4', body: '/files/300' }],
  });
  const os_ = origins(idx, file('300'));
  assert.equal(os_.length, 3);
  assert.equal(os_[0].kind, 'module');
  assert.deepEqual(os_.slice(1).map(o => o.kind), ['assignment', 'page']);
});

test('the same file linked twice on one page collapses to one origin', () => {
  const idx = deriveOrigins({
    pages: [{ title: 'Session 4', body: '/files/301 and /files/301' }],
  });
  assert.equal(origins(idx, file('301')).length, 1);
});

test('an unattributable file falls back to the Files tab, never disappears', () => {
  const idx = deriveOrigins({});
  const out = attachOrigins([file('400'), file('401')], idx);
  assert.equal(out.length, 2);
  assert.equal(out[0].origins[0].kind, 'files-tab');
});

test('an unattributable file named like a syllabus is filed under Syllabus', () => {
  const idx = deriveOrigins({});
  assert.equal(origins(idx, file('402', 'Syllabus_BUSI305.pdf'))[0].kind, 'syllabus');
  assert.equal(origins(idx, file('403', 'course syllabi.docx'))[0].kind, 'syllabus');
  // But a real module placement still wins over the name heuristic.
  const idx2 = deriveOrigins({
    modules: [{ id: 'm1', name: 'Start here', items: [{ type: 'File', content_id: '404' }] }],
  });
  assert.equal(origins(idx2, file('404', 'syllabus.pdf'))[0].kind, 'module');
});

test('attachOrigins preserves every original field', () => {
  const idx = deriveOrigins({});
  const [out] = attachOrigins([{ canvasId: '500', displayName: 'a.pdf', localPath: 'files/a.pdf', size: 12 }], idx);
  assert.equal(out.localPath, 'files/a.pdf');
  assert.equal(out.size, 12);
});

test('malformed course JSON does not throw or invent origins', () => {
  const idx = deriveOrigins({
    modules: 'not an array',
    assignments: [null, { description: null }, 42],
    pages: [{ title: {}, body: '/files/600' }],
  });
  assert.equal(origins(idx, file('600'))[0].kind, 'page');
  assert.equal(origins(idx, file('601'))[0].kind, 'files-tab');
});

test('non-numeric content ids are ignored', () => {
  const idx = deriveOrigins({
    modules: [{ id: 'm1', name: 'W1', items: [{ type: 'File', content_id: '../etc' }] }],
  });
  assert.equal(idx.size, 0);
});

test('filesWithOrigins reads a real class dir, tolerating missing JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origins-'));
  await fs.writeFile(path.join(dir, 'modules.json'), JSON.stringify([
    { id: 'm1', name: 'Week 1', position: 1, items: [{ type: 'File', content_id: '700', title: 'Deck' }] },
  ]));
  await fs.writeFile(path.join(dir, 'assignments.json'), JSON.stringify([
    { name: 'HW 1', description: '<a href="/files/701">rubric</a>' },
  ]));
  await fs.writeFile(path.join(dir, 'pages.json'), 'not json at all');
  // discussions.json / quizzes.json / announcements.json / syllabus.html absent.
  const out = await filesWithOrigins(dir, [file('700'), file('701'), file('702')]);
  assert.deepEqual(out.map(f => f.origins[0].kind), ['module', 'assignment', 'files-tab']);
  await fs.rm(dir, { recursive: true, force: true });
});

// --- quiz shells -----------------------------------------------------------
// Canvas publishes every quiz twice: once in quizzes.json and once in
// assignments.json as a gradebook row with the same title and the same body.
// Both copies link the same file, so a naive scan files one PowerPoint under
// "Assignments: S2a-Concept Check…" AND "Quizzes: S2a-Concept Check…". On the
// real BUSI 380 that happened to 33 of 34 files.
test('a quiz-backed assignment does not duplicate its quiz origin', () => {
  const body = '<p>See <a href="/courses/93903/files/7690637">the deck</a></p>';
  const origins = deriveOrigins({
    assignments: [{ id: 532620, name: 'S2a-Concept Check', quiz_id: 137979, description: body }],
    quizzes: [{ id: 137979, title: 'S2a-Concept Check', description: body }],
  });
  const list = origins.get('7690637');
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'quiz');
  assert.equal(list[0].itemId, '137979');
});

test('an assignment that is not a quiz shell keeps its own origin', () => {
  const origins = deriveOrigins({
    assignments: [{ id: 532645, name: 'Midterm Case', description: '<a href="/files/999">brief</a>' }],
    quizzes: [{ id: 137979, title: 'Something else', description: '' }],
  });
  assert.deepEqual(origins.get('999').map(o => o.kind), ['assignment']);
});

test('a quiz shell keeps its origin when the quiz itself was never synced', () => {
  // quizzes.json missing or empty: dropping the shell would leave the file with
  // no origin at all, which is worse than one that is merely redundant.
  const origins = deriveOrigins({
    assignments: [{ id: 532620, name: 'S2a-Concept Check', quiz_id: 137979, description: '<a href="/files/42">x</a>' }],
    quizzes: [],
  });
  assert.deepEqual(origins.get('42').map(o => o.kind), ['assignment']);
});
