// text-search.test.js — the retriever that reads the words themselves.
//
// It exists because the correlation graph, which represents each item by its
// top twelve tf-idf terms, cannot represent a thirty-page syllabus. On the real
// BUSI 380 data "what is the grading breakdown" selected nothing at all while
// the answer sat in the syllabus. These tests pin the behaviour that fixes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  toPassages, scorePassage, searchClassText, isPolicyQuestion, findSyllabusDoc,
} from '../text-search.js';

async function classWith(files) {
  const dir = await mkdtemp(join(tmpdir(), 'csync-ts-'));
  await mkdir(join(dir, 'materials'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, 'materials', name), body, 'utf8');
  }
  return dir;
}

test('passages pack paragraphs instead of slicing at a fixed width', () => {
  const text = ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300), 'd'.repeat(300)].join('\n\n');
  const p = toPassages(text, { target: 700, max: 1600 });
  assert.ok(p.length >= 2);
  // No passage may cut a block in half: every block appears whole somewhere.
  const joined = p.join('\n');
  for (const ch of ['a', 'b', 'c', 'd']) assert.ok(joined.includes(ch.repeat(300)));
});

test('a paragraph longer than the ceiling is split, and only then', () => {
  const p = toPassages('x'.repeat(5000), { target: 900, max: 1600 });
  assert.ok(p.length >= 3);
  for (const one of p) assert.ok(one.length <= 1600);
});

test('empty and whitespace text yield no passages', () => {
  assert.deepEqual(toPassages(''), []);
  assert.deepEqual(toPassages('   \n\n  \n'), []);
  assert.deepEqual(toPassages(null), []);
});

test('coverage beats frequency', () => {
  const terms = new Set(['grading', 'breakdown']);
  const both = 'The grading breakdown for this course is listed in the table below.';
  const oneRepeated = 'grading grading grading grading grading grading of assignments';
  assert.ok(scorePassage(both, terms) > scorePassage(oneRepeated, terms));
});

test('a passage with no query term scores zero', () => {
  assert.equal(scorePassage('nothing relevant in here at all', new Set(['grading'])), 0);
});

test('an empty query scores nothing rather than everything', () => {
  assert.equal(scorePassage('grading breakdown', new Set()), 0);
});

test('the syllabus wins a policy question over a topic deck', async () => {
  const dir = await classWith({
    'Syllabus Fall 2026.pdf.txt': [
      'Course Overview',
      'Grading Point Allocation and Assignment Due Dates. The grading breakdown is: quizzes 30 percent, midterm case 30 percent, final 40 percent.',
      'Attendance: missing nine or more classes lowers your final grade by one letter.',
    ].join('\n\n'),
    '12. Channel Management.pptx.txt': 'Channel management strategies and disintermediation across retail intermediaries.',
  });
  try {
    const hits = await searchClassText(dir, 'what is the grading breakdown', { limit: 3 });
    assert.ok(hits.length > 0, 'the question that used to return nothing now returns something');
    assert.match(hits[0].label, /Syllabus/);
    assert.match(hits[0].text, /quizzes 30 percent/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('_combined.txt is skipped so hits are not returned twice', async () => {
  const body = 'Grading Point Allocation and Assignment Due Dates for every assignment.';
  const dir = await classWith({
    'Syllabus.pdf.txt': body,
    '_combined.txt': body,           // pack v1 concatenates every file into this
    'last_extracted.txt': '2026-08-24T00:00:00Z',
  });
  try {
    const hits = await searchClassText(dir, 'grading point allocation', { limit: 5 });
    assert.equal(hits.length, 1);
    assert.match(hits[0].name, /^Syllabus/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('one verbose document cannot crowd out the rest', async () => {
  const para = 'Grading policy paragraph about grading and grades.';
  const dir = await classWith({
    'Long.pdf.txt': Array.from({ length: 20 }, (_, i) => `${para} Section ${i}.`).join('\n\n'),
    'Short.pdf.txt': 'Grading policy summary for the course.',
  });
  try {
    const hits = await searchClassText(dir, 'grading policy', { limit: 6 });
    const fromLong = hits.filter(h => h.name === 'Long.pdf.txt').length;
    assert.ok(fromLong <= 2, `expected at most 2 passages from one doc, got ${fromLong}`);
    assert.ok(hits.some(h => h.name === 'Short.pdf.txt'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('nothing relevant returns nothing, not a best guess', async () => {
  const dir = await classWith({ 'Deck.pptx.txt': 'Supply chain logistics and inventory turns.' });
  try {
    assert.deepEqual(await searchClassText(dir, 'photosynthesis chloroplast'), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a class with no materials directory is empty, not an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csync-ts-bare-'));
  try {
    assert.deepEqual(await searchClassText(dir, 'grading'), []);
    assert.equal(await findSyllabusDoc(dir), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a question of only stopwords retrieves nothing', async () => {
  const dir = await classWith({ 'Syllabus.pdf.txt': 'Grading breakdown here.' });
  try {
    assert.deepEqual(await searchClassText(dir, 'is the a of and'), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('policy questions are recognised, subject questions are not', () => {
  for (const q of [
    'what is the grading breakdown', 'attendance policy', 'is there a late penalty',
    'how many points is the midterm', 'what is the honor code', 'when are office hours',
  ]) assert.ok(isPolicyQuestion(q), q);

  for (const q of [
    'explain disintermediation', 'what is a customer ladder', 'summarise week 4',
  ]) assert.ok(!isPolicyQuestion(q), q);
});

test('findSyllabusDoc picks the syllabus out of a full materials directory', async () => {
  const dir = await classWith({
    '12. Channels.pptx.txt': 'x',
    'Marketing 380 Syllabus (Fall 2026).pdf.txt': 'y',
    '7. Customers.pptx.txt': 'z',
  });
  try {
    const doc = await findSyllabusDoc(dir);
    assert.match(doc.name, /Syllabus/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
