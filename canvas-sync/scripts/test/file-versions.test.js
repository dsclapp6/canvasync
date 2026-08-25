// Re-uploads. Canvas does not version files, so a corrected syllabus arrives as
// a brand-new file object beside the old one and both get extracted into the
// same combined text under the same heading.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFileVersions, versionKey, diffSummary, describeDiff } from '../file-versions.js';

// The real pair from BUSI 305, from files_index.json on 2026-08-24.
const BUSI305 = [
  {
    canvasId: '7670924',
    displayName: 'syllabus_Busi 305-Fall 2026.pdf',
    localPath: 'files/syllabus_Busi 305-Fall 2026.pdf',
    canvasUpdatedAt: '2026-07-30T21:50:02Z',
    lastSyncedAt: '2026-08-23T06:21:38.165Z',
    textSha256: '0f1df3fd30dc3cf6da52db1be12c1c3189eaa9a6a1d60bd8ff02240e13bc462d',
  },
  {
    canvasId: '7735992',
    displayName: 'syllabus_Busi 305-Fall 2026.pdf',
    localPath: 'files/syllabus_Busi 305-Fall 2026-7735992.pdf',
    canvasUpdatedAt: '2026-08-24T17:31:15Z',
    lastSyncedAt: '2026-08-24T17:57:40.393Z',
    textSha256: '27bf41c5b53ecc11f913e2ad2489a565ce7a80b7cc124e944da8d893d618df3b',
  },
];

test('a re-uploaded syllabus supersedes the copy it replaced', () => {
  const r = resolveFileVersions(BUSI305);
  assert.deepEqual(r.current, ['7735992']);
  assert.equal(r.superseded.length, 1);
  assert.equal(r.superseded[0].canvasId, '7670924');
  assert.equal(r.superseded[0].supersededBy, '7735992');
  assert.equal(r.superseded[0].reason, 'canvas_updated_at');
  assert.deepEqual(r.ambiguous, []);
});

test('identity is the Canvas display name, never the local path', () => {
  // writeCourseFile appends -<canvasId> to the SECOND copy's filename so it
  // does not clobber the first, so the two local paths differ by construction.
  // Keying on them would mean no re-upload is ever detected.
  assert.notEqual(BUSI305[0].localPath, BUSI305[1].localPath);
  assert.equal(versionKey(BUSI305[0]), versionKey(BUSI305[1]));
});

test('different documents are never merged', () => {
  const r = resolveFileVersions([
    { canvasId: 1, displayName: 'Notes.pdf', canvasUpdatedAt: '2026-01-01T00:00:00Z' },
    { canvasId: 2, displayName: 'Notes.pptx', canvasUpdatedAt: '2026-02-01T00:00:00Z' },
    { canvasId: 3, displayName: 'Syllabus v2.pdf', canvasUpdatedAt: '2026-02-01T00:00:00Z' },
    { canvasId: 4, displayName: 'Syllabus.pdf', canvasUpdatedAt: '2026-01-01T00:00:00Z' },
  ]);
  assert.deepEqual(r.superseded, [], 'a different extension, or a different name, is a different document');
  assert.equal(r.current.length, 4);
});

test('case and whitespace are not a new document', () => {
  const r = resolveFileVersions([
    { canvasId: 1, displayName: 'Lecture  01.pdf', canvasUpdatedAt: '2026-01-01T00:00:00Z' },
    { canvasId: 2, displayName: 'lecture 01.pdf', canvasUpdatedAt: '2026-02-01T00:00:00Z' },
  ]);
  assert.deepEqual(r.current, [2]);
  assert.equal(r.superseded[0].canvasId, 1);
});

test('when Canvas states no update time, first-seen decides', () => {
  const r = resolveFileVersions([
    { canvasId: 1, displayName: 'a.pdf', lastSyncedAt: '2026-01-01T00:00:00Z' },
    { canvasId: 2, displayName: 'a.pdf', lastSyncedAt: '2026-03-01T00:00:00Z' },
  ]);
  assert.deepEqual(r.current, [2]);
  assert.equal(r.superseded[0].reason, 'first_seen');
});

test('with no stamps at all, the higher Canvas id is the later upload', () => {
  const r = resolveFileVersions([
    { canvasId: 500, displayName: 'a.pdf' },
    { canvasId: 900, displayName: 'a.pdf' },
  ]);
  assert.deepEqual(r.current, [900]);
  assert.equal(r.superseded[0].reason, 'canvas_id_order');
});

test('two copies that cannot be ordered are BOTH kept, and reported', () => {
  // The refusal. Promoting one of an unordered pair hides a file that may be
  // the current one — a worse failure than showing both and saying so.
  const r = resolveFileVersions([
    { canvasId: 'x', displayName: 'a.pdf' },
    { canvasId: 'y', displayName: 'a.pdf' },
  ]);
  assert.deepEqual(r.superseded, []);
  assert.equal(r.current.length, 2);
  assert.equal(r.ambiguous.length, 1);
  assert.deepEqual(r.ambiguous[0].canvasIds.sort(), ['x', 'y']);
});

test('an ambiguous pair does not drag a decidable third copy down with it', () => {
  const r = resolveFileVersions([
    { canvasId: 'x', displayName: 'a.pdf' },
    { canvasId: 'y', displayName: 'a.pdf' },
    { canvasId: 3, displayName: 'b.pdf', canvasUpdatedAt: '2026-01-01T00:00:00Z' },
    { canvasId: 4, displayName: 'b.pdf', canvasUpdatedAt: '2026-02-01T00:00:00Z' },
  ]);
  assert.equal(r.superseded.length, 1);
  assert.equal(r.superseded[0].canvasId, 3);
  assert.equal(r.ambiguous.length, 1);
});

test('three versions leave one current and two superseded by it', () => {
  const r = resolveFileVersions([
    { canvasId: 1, displayName: 'a.pdf', canvasUpdatedAt: '2026-01-01T00:00:00Z' },
    { canvasId: 2, displayName: 'a.pdf', canvasUpdatedAt: '2026-02-01T00:00:00Z' },
    { canvasId: 3, displayName: 'a.pdf', canvasUpdatedAt: '2026-03-01T00:00:00Z' },
  ]);
  assert.deepEqual(r.current, [3]);
  assert.deepEqual(r.superseded.map(s => s.canvasId).sort(), [1, 2]);
  assert.ok(r.superseded.every(s => s.supersededBy === 3), 'all point at the current one, not at each other');
});

test('junk in, nothing out', () => {
  for (const v of [null, undefined, [], [null], [{}], 'nope']) {
    const r = resolveFileVersions(v);
    assert.deepEqual(r.superseded, []);
    assert.deepEqual(r.ambiguous, []);
  }
});

test('the input array is never mutated', () => {
  const before = JSON.stringify(BUSI305);
  resolveFileVersions(BUSI305);
  assert.equal(JSON.stringify(BUSI305), before);
});

// --- what changed ---------------------------------------------------------

test('diffSummary counts added and removed lines, and samples them in order', () => {
  const oldText = 'Course policy\nLate work loses 10%\nExam 1 is 30 September\nOffice hours Friday';
  const newText = 'Course policy\nLate work loses 20%\nExam 1 is 7 October\nOffice hours Friday\nNew: attendance counts';
  const d = diffSummary(oldText, newText);
  assert.equal(d.identical, false);
  assert.equal(d.added, 3);
  assert.equal(d.removed, 2);
  assert.deepEqual(d.sample.added, ['Late work loses 20%', 'Exam 1 is 7 October', 'New: attendance counts']);
  assert.deepEqual(d.sample.removed, ['Late work loses 10%', 'Exam 1 is 30 September']);
});

test('re-formatted whitespace is not a change', () => {
  const d = diffSummary('a\n\n  b  \nc', 'a\nb\n\n\nc   ');
  assert.equal(d.identical, true);
  assert.equal(d.changedPct, 0);
  assert.equal(describeDiff(d), 'The text is identical to the version it replaced.');
});

test('describeDiff is one printable sentence', () => {
  assert.equal(
    describeDiff(diffSummary('a\nb\nc', 'a\nb\nd')),
    '1 line added, 1 line removed (33% of the document).',
  );
  assert.equal(describeDiff(null), null);
});

test('an empty old version reports the whole new one as added', () => {
  const d = diffSummary('', 'one\ntwo');
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
  assert.equal(d.changedPct, 100);
});
