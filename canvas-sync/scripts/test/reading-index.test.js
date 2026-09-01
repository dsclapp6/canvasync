import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readingItemsFromSchedule,
  readingItemsFromDatedText,
  readingItemsFromPages,
  pageSections,
  mergeReadingItems,
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


// --- Class pages ------------------------------------------------------------
//
// The user's rule for this round: *"there should be absolutely nothing that
// doesnt make it to the output."* Class pages are where several of these
// courses publish the week — topics, handouts, and what to read or watch
// before each class — and nothing in the pipeline read them at all.
//
// "Everything that exists" is not "everything imaginable", and the two halves
// below are deliberately split that way: the REAL pages prove the parser does
// not invent, the week-page fixture proves it extracts. Only the second is
// synthetic, and only because BUSI 374 has not synced real pages yet.

const FIXTURES = new URL('../test-fixtures/', import.meta.url);
const realPages = JSON.parse(await readFile(new URL('entr222-pages.json', FIXTURES), 'utf8'));
const weekPageBody = await readFile(new URL('busi374-week-page.html', FIXTURES), 'utf8');

test('a real session page that states no reading produces no reading', () => {
  // Copied verbatim out of the user's own ~/canvas-sync-data: three of ENTR
  // 222's 28 collected session pages. Every one is a Date/Topics/During
  // Class/Assignments Due/Slides table, and not one of the 28 carries a
  // reading, a prep block or a video. The correct output is nothing.
  assert.deepEqual(readingItemsFromPages(realPages, { defaultYear: 2026 }), []);
});

test('…and that emptiness is the pages having no readings, not the parser failing', () => {
  // Without this, the assertion above passes just as well on a parser that
  // cannot read the page at all — the vacuous-green trap. So: prove it saw the
  // structure it declined to promote.
  const sections = pageSections(realPages[0].body);
  assert.deepEqual(sections.map(section => section.label),
    ['Date', 'Topics', 'During Class', 'Assignments Due', 'Slides']);
  const topics = sections.find(section => section.label === 'Topics');
  assert.ok(topics && topics.html.trim(), 'the Topics cell was read');
  // It resolved the date too — 8/25 in the Date row of Session 1.
  const dated = readingItemsFromPages(
    [{ title: realPages[0].title, body: realPages[0].body.replace('<p>—</p>',
      '<p>Read Chapter 1 before class.</p>') }], { defaultYear: 2026 });
  assert.equal(dated.length, 1, 'the same page WITH a reading must produce one');
  assert.equal(dated[0].due_date, '2026-08-25');
});

test('a week page yields one item per class that states preparation', () => {
  const items = readingItemsFromPages([{ title: 'Week 2', body: weekPageBody }], { defaultYear: 2026 });
  assert.deepEqual(items.map(item => item.due_date), ['2026-08-31', '2026-09-02'],
    'three classes are on the page; the third states "Prep - Readings/Videos: —"');
  assert.match(items[0].title, /Process analysis, flow rates and bottlenecks/);
  assert.match(items[0].description, /Cachon & Terwiesch, Chapter 3/);
  assert.match(items[0].description, /Little's Law walkthrough \(12 min\)/,
    'a Panopto video is preparation as much as a chapter is');
  assert.equal(items[0].origin, 'page');
  assert.equal(items[0].sources[0].type, 'page');
});

test('a class whose page says its preparation is "—" is not given one', () => {
  // Every ENTR 222 page uses an em-dash this way. Reading it as content would
  // manufacture a reading for a class that explicitly states it has none —
  // the exact failure the deterministic index exists to prevent.
  const items = readingItemsFromPages([{ title: 'W', body: `
    <p><strong>Class: September 4 (F) 2:30pm-3:45pm</strong></p>
    <p>Topics: Guest speaker</p>
    <p>Prep - Readings/Videos: &mdash;</p>` }], { defaultYear: 2026 });
  assert.deepEqual(items, []);
  // The named entity must be decoded, or "&mdash;" reads as content and the
  // placeholder is never recognised.
  for (const marker of ['—', 'N/A', 'TBD', 'none', 'posted after class']) {
    const one = readingItemsFromPages([{ title: 'W', body:
      `<p><strong>Class: September 4 (F)</strong></p><p>Prep - Readings: ${marker}</p>` }],
      { defaultYear: 2026 });
    assert.deepEqual(one, [], `"${marker}" is a placeholder, not a reading`);
  }
});

test('an optional-only prep line is not promoted, but a mixed one is kept whole', () => {
  const items = readingItemsFromPages([{ title: 'W', body: `
    <p><strong>Class: September 2 (W)</strong></p>
    <p>Prep - Readings/Videos:</p>
    <ul><li>Cachon &amp; Terwiesch, Chapter 4</li></ul>
    <p>Optional Reading: the Erlang C appendix</p>` }], { defaultYear: 2026 });
  assert.equal(items.length, 1);
  assert.match(items[0].description, /Chapter 4/);
  assert.doesNotMatch(items[0].description, /Erlang/,
    'an optional-only section is not promoted into a required reading');
});

test('page material links ride the item, with the href kept rather than dropped', () => {
  const [item] = readingItemsFromPages([{ title: 'Week 2', body: weekPageBody }], { defaultYear: 2026 });
  const names = item.related_materials.map(material => material.file);
  assert.ok(names.includes('Session 4 slides.pdf'), 'a handout linked for that class belongs to it');
  assert.ok(names.includes("Little's Law walkthrough (12 min)"));
  // related_materials.file is a NAME, resolved against the class's own files;
  // the schema has nowhere structured for a URL, so it is carried in the
  // reason instead of thrown away.
  assert.match(item.related_materials[0].why, /https:\/\/canvas\.rice\.edu/);
});

test('nothing is clipped on the way out', () => {
  // The standing no-cut-offs rule. A long reading list is a long reading list.
  const many = Array.from({ length: 40 }, (_, i) => `<li>Reading number ${i + 1}: a chapter with a deliberately long descriptive title</li>`).join('');
  const [item] = readingItemsFromPages([{ title: 'W', body:
    `<p><strong>Class: September 2 (W)</strong></p><p>Prep - Readings:</p><ul>${many}</ul>` }],
    { defaultYear: 2026 });
  assert.match(item.description, /Reading number 1:/);
  assert.match(item.description, /Reading number 40:/, 'the last item survived the trip');
});

test('the same reading from the syllabus and from a page merges into one item', () => {
  // Convergence half. A week page restating a syllabus line is the SAME
  // reading, and two near-identical "read before this class" reminders for one
  // session is the double-emit the order forbids.
  const [syllabus] = readingItemsFromSchedule({ schedule: [{
    date: '2026-08-31', type: 'lecture', title: 'Process analysis',
    description: 'Read Cachon & Terwiesch, Chapter 3.',
  }] }, { sourceFile: 'Syllabus.pdf' });
  const page = readingItemsFromPages([{ title: 'Week 2', body: weekPageBody }], { defaultYear: 2026 })
    .find(item => item.due_date === '2026-08-31');

  const merged = mergeReadingItems([syllabus], [page]);
  assert.equal(merged.length, 1, 'one class, one reading, one item');
  assert.equal(merged[0].sources.length, 2, 'both provenances survive the merge');
  assert.ok(merged[0].related_materials.some(material => material.file === 'Session 4 slides.pdf'),
    'the page contributed a handout the syllabus never had');
});

test('…while a page reading the syllabus never listed is kept, not swallowed', () => {
  // Discrimination half. Merging on date alone would silently drop exactly the
  // content this work exists to stop losing.
  const [syllabus] = readingItemsFromSchedule({ schedule: [{
    date: '2026-08-31', type: 'lecture', title: 'Process analysis',
    description: 'Read Cachon & Terwiesch, Chapter 3.',
  }] });
  const [page] = readingItemsFromPages([{ title: 'Week 2', body:
    `<p><strong>Class: August 31 (M)</strong></p><p>Prep - Readings/Videos:</p>
     <ul><li>Watch the Little's Law walkthrough, a video the syllabus never mentions</li></ul>` }],
    { defaultYear: 2026 });

  const merged = mergeReadingItems([syllabus], [page]);
  assert.equal(merged.length, 2, 'a different reading on the same date is a second item');
  assert.deepEqual(merged.map(item => item.due_date), ['2026-08-31', '2026-08-31']);
});

test('the index counts what it scanned separately from what it emitted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reading-pages-'));
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ term: { name: 'Fall 2026' } }));
  await writeFile(join(dir, 'syllabus_parsed.json'), JSON.stringify({ schedule: [] }));
  await writeFile(join(dir, 'pages.json'), JSON.stringify(realPages));

  const built = await buildReadingIndex(dir);
  // The honest shape of ENTR 222's answer: three real pages read, nothing
  // emitted, because there is nothing in them to emit.
  assert.equal(built.coverage.pages_scanned, realPages.length);
  assert.equal(built.coverage.pages, 0);
  assert.equal(built.items.length, 0);
  assert.equal(built.source.pages, 'pages.json');

  await writeFile(join(dir, 'pages.json'), JSON.stringify(
    realPages.concat([{ title: 'Week 2', body: weekPageBody }])));
  const withWeek = await buildReadingIndex(dir);
  assert.equal(withWeek.coverage.pages, 2);
  assert.equal(withWeek.items.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test('pages update daily, so changed page content must change the index', async () => {
  // The writer is content-aware and skips an unchanged index — required for
  // staleness checks. That is only safe if a real edit still gets through.
  const dir = await mkdtemp(join(tmpdir(), 'reading-fresh-'));
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ term: { name: 'Fall 2026' } }));
  await writeFile(join(dir, 'syllabus_parsed.json'), JSON.stringify({ schedule: [] }));
  await writeFile(join(dir, 'pages.json'), JSON.stringify([{ title: 'Week 2', body: weekPageBody }]));

  const first = await indexClassReadings(dir);
  const firstMtime = (await stat(first.outPath)).mtimeMs;
  assert.equal(first.changed, true);

  const unchanged = await indexClassReadings(dir);
  assert.equal(unchanged.changed, false, 'an unchanged page must not rewrite the index');
  assert.equal((await stat(unchanged.outPath)).mtimeMs, firstMtime);

  // Planted positive: the professor adds a chapter to Monday's prep.
  await writeFile(join(dir, 'pages.json'), JSON.stringify([{ title: 'Week 2',
    body: weekPageBody.replace('Cachon &amp; Terwiesch, Chapter 3',
      'Cachon &amp; Terwiesch, Chapter 3 and the Reed Supermarkets case') }]));
  const edited = await indexClassReadings(dir);
  assert.equal(edited.changed, true, 'an edited page must reach the index');
  assert.match(edited.index.items.find(item => item.due_date === '2026-08-31').description,
    /Reed Supermarkets/);
  await rm(dir, { recursive: true, force: true });
});

// --- Guards, not caps -------------------------------------------------------
//
// The standing no-cut-offs rule, applied to what this module STORES. Three
// limits were tight enough to bind on ordinary syllabus text — a 180-character
// date heading, a 180-line dated block, an 1,800-character excerpt — so they
// were not protecting the parser from pathological input, they were quietly
// shortening the answer. What still binds is generous and says so.

test('a date heading longer than the old 180-character limit is indexed, not dropped', () => {
  // The bite: at 181 characters this line used to be skipped outright and its
  // reading never reached the calendar. Professors put the readings on the
  // heading line all the time.
  const heading = 'September 1: Read Cachon & Terwiesch Chapter 3, the Reed Supermarkets case, '
    + 'the Little\'s Law appendix, the two linked articles on queue discipline, '
    + 'and the supplementary note on flow rates and bottlenecks, before class begins';
  assert.ok(heading.length > 180 && heading.length < 400, `heading is ${heading.length} chars`);

  const items = readingItemsFromDatedText(heading, { defaultYear: 2026 });
  assert.equal(items.length, 1, 'a heading over 180 characters must still be a heading');
  assert.equal(items[0].due_date, '2026-09-01');
  assert.match(items[0].description, /Reed Supermarkets/);
  assert.match(items[0].description, /queue discipline/, 'and it must arrive whole');
});

test('a stored reading list is not clipped at 1,800 characters', () => {
  const long = Array.from({ length: 60 },
    (_, i) => `chapter ${i + 1} on a named topic of some length`).join(', ');
  const [item] = readingItemsFromDatedText(`September 1:\nRead ${long}.`, { defaultYear: 2026 });
  assert.ok(item.description.length > 1800, `only ${item.description.length} chars survived`);
  assert.match(item.description, /chapter 60 on a named topic/, 'the tail of the list survived');
});

test('what a guard still refuses is named in the index, not silently dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reading-skip-'));
  await mkdir(join(dir, 'materials'));
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ term: { name: 'Fall 2026' } }));
  await writeFile(join(dir, 'syllabus_parsed.json'), JSON.stringify({ schedule: [] }));
  await writeFile(join(dir, 'files_index.json'), JSON.stringify([
    { displayName: 'Syllabus.pdf', canvasUpdatedAt: '2026-08-25T12:00:00Z',
      extractionStatus: 'done', materialsPath: 'materials/s.txt' },
  ]));
  // Past the generous limit: a paragraph that happens to start with a month.
  await writeFile(join(dir, 'materials', 's.txt'),
    `September 1: Read ${'a very long narrative sentence about the course, '.repeat(12)}`);

  const built = await buildReadingIndex(dir);
  assert.equal(built.items.length, 0, 'prose this long is not a heading');
  assert.equal(built.skipped.length, 1, 'and the index has to SAY it refused it');
  assert.equal(built.skipped[0].reason, 'date-heading-too-long');
  assert.match(built.skipped[0].detail, /September 1/, 'the record names what was skipped');
  await rm(dir, { recursive: true, force: true });
});

test('an ordinary index reports nothing skipped', () => {
  // The empty list is the normal answer; a test that only ever saw a non-empty
  // one would not notice the record firing on every class.
  return buildReadingIndex(new URL('../test-fixtures/', import.meta.url).pathname)
    .then(index => assert.deepEqual(index.skipped, []));
});
