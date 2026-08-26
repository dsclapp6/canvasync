import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readingItemsFromSchedule,
  readingItemsFromDatedText,
  buildReadingIndex,
} from '../../reading-index.js';
import { indexClassReadings } from '../index-readings.js';

test('structured schedule readings become dated items without a model', () => {
  const items = readingItemsFromSchedule({ schedule: [
    { date: '2026-09-01', type: 'lecture', title: 'Customer strategy',
      description: 'Read Textbook Chapter 3 and the article "Customer Value".' },
    { date: '2026-09-03', type: 'lecture', title: 'Guest speaker', description: 'No preparation required.' },
    { date: '2026-09-08', type: 'lecture', title: 'Accounting', description: 'Pre-class reading: Ch. 4.' },
  ] }, { sourceFile: 'Current Syllabus.pdf' });

  assert.deepEqual(items.map(item => item.due_date), ['2026-09-01', '2026-09-08']);
  assert.ok(items.every(item => item.category === 'reading' && item.recurring === null));
  assert.equal(items[0].related_materials[0].file, 'Current Syllabus.pdf');
});

test('same-day reading rows are bunched into one complete session item', () => {
  const [item] = readingItemsFromSchedule({ schedule: [
    { date: '2026-10-01', type: 'lecture', title: 'Segmentation', description: 'Read Chapter 11.' },
    { date: '2026-10-01', type: 'discussion', title: 'Personalization', description: 'Read the algorithm case.' },
  ] });
  assert.equal(item.due_date, '2026-10-01');
  assert.match(item.title, /Segmentation.*Personalization/);
  assert.match(item.description, /Chapter 11.*algorithm case/);
});

test('optional-only, holiday, and undated prose never become required readings', () => {
  const items = readingItemsFromSchedule({ schedule: [
    { date: '2026-09-01', type: 'lecture', title: 'Optional Reading: bonus article', description: null },
    { date: '2026-09-02', type: 'holiday', title: 'Reading day', description: 'Read anything you like.' },
    { date: null, type: 'lecture', title: 'Required reading', description: 'Read Chapter 2.' },
  ] });
  assert.deepEqual(items, []);
});

test('raw extracted syllabus text recovers dated reading blocks the structured parser missed', () => {
  const items = readingItemsFromDatedText(`
September 1:
Prepare Before Class
1. Read: Textbook Chapter 3, pp. 71-78
2. View the channel strategy video

September 3:
Extra Insight Reading (Optional): A bonus article

September 8:
Session Overview
Read the Reed Supermarkets case and prepare answers.
`, { defaultYear: 2026, sourceFile: 'Syllabus.pdf' });

  assert.deepEqual(items.map(item => item.due_date), ['2026-09-01', '2026-09-08']);
  assert.match(items[0].description, /Chapter 3/);
  assert.ok(items.every(item => item.sources[0].ref.includes('Syllabus.pdf')));
});

test('the class index uses only the newest syllabus and does not rewrite unchanged content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reading-index-'));
  await mkdir(join(dir, 'materials'));
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ term: { name: 'Fall 2026' } }));
  await writeFile(join(dir, 'syllabus_parsed.json'), JSON.stringify({ schedule: [] }));
  await writeFile(join(dir, 'files_index.json'), JSON.stringify([
    { displayName: 'Old Syllabus.pdf', canvasUpdatedAt: '2026-08-01T12:00:00Z',
      extractionStatus: 'done', materialsPath: 'materials/old.txt' },
    { displayName: 'New Syllabus.pdf', canvasUpdatedAt: '2026-08-25T12:00:00Z',
      extractionStatus: 'done', materialsPath: 'materials/new.txt' },
  ]));
  await writeFile(join(dir, 'materials', 'old.txt'), 'September 1:\nRead Chapter 1.');
  await writeFile(join(dir, 'materials', 'new.txt'), 'September 8:\nRead Chapter 2.');

  const built = await buildReadingIndex(dir);
  assert.deepEqual(built.items.map(item => item.due_date), ['2026-09-08']);
  assert.equal(built.source.syllabus_file, 'New Syllabus.pdf');

  const first = await indexClassReadings(dir);
  const firstMtime = (await stat(first.outPath)).mtimeMs;
  const second = await indexClassReadings(dir);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal((await stat(second.outPath)).mtimeMs, firstMtime);
  await rm(dir, { recursive: true, force: true });
});

