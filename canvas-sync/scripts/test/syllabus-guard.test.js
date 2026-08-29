// Regression tests for the two truncation points that hid BUSI 380's article
// lists: mine-assignments' flat 8K per-file clip cutting the syllabus before
// its weekly readings, and parse-syllabus accepting an empty "{}" model reply
// as a valid parse (which then overwrote a good extraction).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { migrateTextbookSchema, parseHasContent, parseIsCurrent } from '../parse-syllabus.js';
import { sectionSyllabusFullText } from '../mine-assignments.js';
import { TEXTBOOK_SCHEMA_VERSION } from '../../bridge/textbooks.js';

// --- parseHasContent -------------------------------------------------------

test('parseHasContent: empty scaffold is not content', () => {
  assert.equal(parseHasContent({}), false);
  assert.equal(parseHasContent(null), false);
  assert.equal(parseHasContent({
    course: {}, grading: { components: [] }, schedule: [], policies: { other: [] },
  }), false);
});

test('parseHasContent: any of course/grading/schedule counts', () => {
  assert.equal(parseHasContent({ course: { code: 'BUSI 380' } }), true);
  assert.equal(parseHasContent({ course: { title: 'Marketing' } }), true);
  assert.equal(parseHasContent({ textbooks: [{ title: 'Marketing Management' }] }), true);
  assert.equal(parseHasContent({ grading: { components: [{ name: 'Final', weight_pct: 45 }] } }), true);
  assert.equal(parseHasContent({ schedule: [{ title: 'Week 1' }] }), true);
});

// --- sectionSyllabusFullText -----------------------------------------------

let classDir;

// A syllabus long enough that the old 8K materials clip would cut it, with a
// recognisable reading list far past the clip point.
const DEEP_MARKER = 'Read Article: "The Elements of Value"';
const LONG_SYLLABUS = 'Course policies and preamble. '.repeat(500) // ~15K chars
  + '\nWeek 5 Prepare Before Class\n' + DEEP_MARKER + '\n'
  + 'More schedule. '.repeat(200);

before(async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ccsync-syllabus-guard-'));
  classDir = join(tmp, 'class');
  await mkdir(join(classDir, 'materials'), { recursive: true });
  await writeFile(join(classDir, 'materials', 'Syllabus.pdf.txt'), LONG_SYLLABUS, 'utf8');
  await writeFile(join(classDir, 'materials', 'Lecture 1.pptx.txt'), 'slide text', 'utf8');
});

const indexEntry = (displayName, materialsPath, extra = {}) => ({
  displayName,
  filename: displayName,
  materialsPath,
  extractionStatus: 'done',
  duplicateOf: null,
  supersededBy: null,
  ...extra,
});

test('syllabus text is included in full, past the 8K materials clip', async () => {
  const md = await sectionSyllabusFullText(classDir, [
    indexEntry('Marketing 380 Syllabus (Fall 2026).pdf', 'materials/Syllabus.pdf.txt'),
    indexEntry('Lecture 1.pptx', 'materials/Lecture 1.pptx.txt'),
  ]);
  assert.ok(md.includes(DEEP_MARKER), 'reading list past 8K chars must survive');
  assert.ok(!md.includes('slide text'), 'non-syllabus files stay out of this section');
});

test('falls back to syllabus.html when no syllabus file is indexed', async () => {
  await writeFile(join(classDir, 'syllabus.html'),
    '<html><body><p>Weekly readings:</p><p>' + DEEP_MARKER + '</p></body></html>', 'utf8');
  const md = await sectionSyllabusFullText(classDir, [
    indexEntry('Lecture 1.pptx', 'materials/Lecture 1.pptx.txt'),
  ]);
  assert.ok(md.includes(DEEP_MARKER), 'syllabus.html fallback must be used');
});

test('says so when no syllabus exists anywhere', async () => {
  const bare = await mkdtemp(join(tmpdir(), 'ccsync-syllabus-none-'));
  const md = await sectionSyllabusFullText(bare, []);
  assert.ok(md.includes('(no syllabus found)'));
});

// --- parseIsCurrent --------------------------------------------------------
// The bridge rewrites syllabus.html byte-identically on every ingest, so every
// mtime-based orchestrator calls the parse stage stale on every sync — and it
// is the most expensive stage there is (minutes on the local model, holding
// the machine-wide lock). The previous parse's own source_hash is the answer,
// and unlike syllabus.hash it exists for HTML-only classes too.

test('parseIsCurrent: same hash and real content means no re-parse', () => {
  const prev = {
    source_hash: 'abc123', course: { code: 'BUSI 380' }, textbooks: [],
    textbook_schema_version: TEXTBOOK_SCHEMA_VERSION,
  };
  assert.equal(parseIsCurrent(prev, 'abc123'), true);
});

test('parseIsCurrent: a pre-v2 textbook schema is not current until locally migrated', () => {
  const prev = { source_hash: 'abc123', course: { code: 'BUSI 380' }, textbooks: [] };
  assert.equal(parseIsCurrent(prev, 'abc123'), false);
});

test('an unchanged pre-v2 parse upgrades textbook detection without replacing other fields', () => {
  const previous = {
    source_hash: 'abc123',
    course: { code: 'ENTR 222' },
    schedule: [{ date: '2026-08-25', title: 'Introduction' }],
    textbooks: [{ title: 'Deploy Empathy', required: true }],
  };
  const migrated = migrateTextbookSchema(previous, `Required Readings
See Canvas for required ebooks and articles.
Optional Readings
Deploy Empathy by Michele Hansen`, 'abc123');

  assert.equal(migrated.textbook_schema_version, TEXTBOOK_SCHEMA_VERSION);
  assert.equal(migrated.textbooks[0].status, 'optional');
  assert.deepEqual(migrated.schedule, previous.schedule, 'non-textbook extraction is preserved');
  assert.equal(migrateTextbookSchema(previous, 'same text', 'different-hash'), null);
});

test('parseIsCurrent: a changed syllabus re-parses', () => {
  const prev = {
    source_hash: 'abc123', course: { code: 'BUSI 380' }, textbooks: [],
    textbook_schema_version: TEXTBOOK_SCHEMA_VERSION,
  };
  assert.equal(parseIsCurrent(prev, 'def456'), false);
});

test('parseIsCurrent: an empty previous parse is not an answer to keep', () => {
  // The empty-parse rejection path can leave a scaffold behind; matching
  // hashes must not make it permanent.
  assert.equal(parseIsCurrent({ source_hash: 'abc123', course: {}, schedule: [] }, 'abc123'), false);
  assert.equal(parseIsCurrent(null, 'abc123'), false);
  assert.equal(parseIsCurrent({ course: { code: 'X' } }, 'abc123'), false, 'no stored hash — cannot claim current');
  assert.equal(parseIsCurrent({ source_hash: undefined, course: { code: 'X' } }, undefined), false,
    'two undefined hashes must not compare equal');
});
