import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkRelatedMaterials, materialKey, materialSources, resolveMaterial,
} from '../public/material-links.js';

const files = [
  {
    displayName: '12. Assess Multi-Channel Management Opportunities & Challenges.pptx',
    filename: '12.+Assess+Multi-Channel+Management+Opportunities+%26+Challenges.pptx',
    localPath: 'files/12. Assess Multi-Channel Management Opportunities & Challenges.pptx',
    materialsPath: 'materials/12. Assess Multi-Channel Management Opportunities & Challenges.pptx.txt',
  },
  {
    displayName: 'Talking+to+Humans.pdf',
    localPath: 'files/Talking+to+Humans.pdf',
  },
  {
    displayName: 'Old syllabus.pdf',
    localPath: 'files/Old syllabus.pdf',
    supersededBy: 'new',
  },
];

const pages = [
  {
    page_id: 40,
    title: 'Session 4 - PM Mindset + Product Artifacts - 9/3',
    html_url: 'https://canvas.example/pages/session-4',
  },
  {
    page_id: 100,
    title: 'Session 10 - Opportunity Solution Tree - 9/24',
    html_url: 'https://canvas.example/pages/session-10',
  },
];

test('materialKey removes presentation noise but preserves meaningful session numbers', () => {
  assert.equal(materialKey('12. Assess Multi-Channel Management Opportunities & Challenges.pptx'),
    'assess multi channel management opportunities challenges');
  assert.equal(materialKey('Page: Session 4 - PM Mindset + Product Artifacts slides'),
    'session 4 pm mindset product artifacts');
  assert.notEqual(materialKey('Session 1 slides'), materialKey('Session 10 slides'));
});

test('materialSources excludes stale files and page bodies', () => {
  const out = materialSources(files, pages);
  assert.equal(out.length, 4);
  assert.ok(!out.some(s => s.displayName === 'Old syllabus.pdf'));
  assert.equal(out.find(s => s.type === 'page').body, undefined);
});

test('friendly file labels resolve across numeric prefixes and encoded plus signs', () => {
  const sources = materialSources(files, pages);
  assert.equal(resolveMaterial('Assess Multi-Channel Management Opportunities & Challenges.pptx', sources)?.type, 'file');
  assert.equal(resolveMaterial('Talking to Humans.pdf', sources)?.displayName, 'Talking+to+Humans.pdf');
});

test('slide labels resolve to the matching Canvas page, not a neighboring session', () => {
  const sources = materialSources(files, pages);
  assert.equal(resolveMaterial('Session 4 - PM Mindset + Product Artifacts slides', sources)?.pageId, '40');
  assert.equal(resolveMaterial('Page: Session 1', sources), null,
    'Session 1 must not match Session 10 by substring');
});

test('weak or ambiguous labels are not turned into confident links', () => {
  const sources = materialSources(files, pages);
  assert.equal(resolveMaterial('case document', sources), null);
  const ambiguous = materialSources([
    { displayName: 'Course Syllabus A.pdf', localPath: 'files/a.pdf' },
    { displayName: 'Course Syllabus B.pdf', localPath: 'files/b.pdf' },
  ]);
  assert.equal(resolveMaterial('Course Syllabus', ambiguous), null);
});

test('linkRelatedMaterials preserves labels and marks unavailable guesses as unresolved', () => {
  const linked = linkRelatedMaterials({ related_materials: [
    { file: 'Talking to Humans.pdf', why: 'read it' },
    { file: 'A file that was never synced', why: 'guess' },
  ] }, materialSources(files, pages));
  assert.equal(linked.related_materials[0].source.type, 'file');
  assert.equal(linked.related_materials[0].why, 'read it');
  assert.equal(linked.related_materials[1].source, null);
});
