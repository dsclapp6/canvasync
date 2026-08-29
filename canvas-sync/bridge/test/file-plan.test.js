import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filePreviewPlan, groupFilesBySource, originDetail, sourceSectionKey,
} from '../public/file-plan.js';

const file = (name, origin) => ({ displayName: name, origins: [origin] });
const quiz = (id, title) => ({
  kind: 'quiz', label: 'Quizzes', group: `quiz:${id}`, sort: 102,
  itemLabel: title, itemId: String(id),
});
const moduleOrigin = (id, label, sort) => ({
  kind: 'module', label, group: `module:${id}`, sort,
});

test('different quizzes bunch into one Quizzes section', () => {
  const groups = groupFilesBySource([
    file('Deck B.pptx', quiz(20, 'Concept check B')),
    file('Deck A.pptx', quiz(10, 'Concept check A')),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].heading, 'Quizzes');
  assert.equal(groups[0].files.length, 2);
  assert.deepEqual(groups[0].files.map(f => f.displayName), ['Deck A.pptx', 'Deck B.pptx']);
});

test('different assignments and pages each get one category section', () => {
  const groups = groupFilesBySource([
    file('A.pdf', { kind: 'assignment', label: 'Assignments', group: 'assignment:1', sort: 101 }),
    file('B.pdf', { kind: 'assignment', label: 'Assignments', group: 'assignment:2', sort: 101 }),
    file('C.pdf', { kind: 'page', label: 'Pages', group: 'page:3', sort: 105 }),
  ]);
  assert.deepEqual(groups.map(g => [g.heading, g.files.length]), [
    ['Assignments', 2], ['Pages', 1],
  ]);
});

test('modules remain separate because their structure is meaningful', () => {
  const groups = groupFilesBySource([
    file('Week 2.pdf', moduleOrigin(2, 'Week 2', 2)),
    file('Week 1.pdf', moduleOrigin(1, 'Week 1', 1)),
  ]);
  assert.deepEqual(groups.map(g => g.heading), ['Module · Week 1', 'Module · Week 2']);
  assert.notEqual(sourceSectionKey(moduleOrigin(1, 'Week 1', 1)),
    sourceSectionKey(moduleOrigin(2, 'Week 2', 2)));
});

test('the exact originating item remains visible under a bunched file', () => {
  const f = file('Deck.pptx', quiz(10, 'S2a Concept Check'));
  f.origins.push({ kind: 'module', label: 'Week 2', group: 'module:2' });
  assert.equal(originDetail(f), 'S2a Concept Check · +1 more place');
});

test('PDFs keep their original pages while Office files use their PDF derivative', () => {
  assert.deepEqual(filePreviewPlan({
    displayName: 'Syllabus.pdf', localPath: 'files/Syllabus.pdf',
  }), { path: 'files/Syllabus.pdf', label: 'Original', source: 'original' });
  assert.deepEqual(filePreviewPlan({
    displayName: 'Lecture.pptx', localPath: 'files/Lecture.pptx',
    pdfPath: 'materials/pdf/Lecture.pptx.pdf',
  }), { path: 'materials/pdf/Lecture.pptx.pdf', label: 'Slides', source: 'converted' });
  assert.equal(filePreviewPlan({
    displayName: 'Notes.docx', localPath: 'files/Notes.docx',
  }), null, 'without a converted PDF the text fallback remains available');
});
