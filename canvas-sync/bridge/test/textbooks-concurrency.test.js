// textbooks-concurrency.test.js — two textbook links saved at once, both kept.
//
// textbook_links.json holds EVERY book of a class under `links`, and
// patchTextbookLink is read-modify-write across two awaits (the syllabus read
// and the links read). Two of them in flight together therefore lose one edit
// even though they name different books: the second write is computed from a
// snapshot taken before the first landed.
//
// Reachable from ordinary use, not a stress case. Saving a link disables only
// that row's button, so pasting URLs for two books of one class in quick
// succession sends two concurrent PUTs — and the result is a link the user
// typed, saw accepted, and finds missing on reload.
//
// WHAT THIS PINS: in-process serialization of patchTextbookLink per class.
// WHAT IT DOES NOT: cross-process safety, which write-lock.js does not offer.
// Nothing outside the bridge writes this file (patchTextbookLink has one
// caller, the PUT route), so in-process is the whole fix here — unlike
// files_index.json, whose second writer is a spawned stage.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  patchTextbookLink, readTextbookLinks, resolveTextbooks, TEXTBOOK_LINKS_FILE,
} from '../textbooks.js';

const FOLDER = '92294-busi-305-001';
const SYLLABUS = {
  textbooks: [
    { title: 'Marketing Management', author: 'Philip Kotler', edition: '16th', required: true },
    { title: 'HBR Guide to Persuasive Presentations', author: 'Nancy Duarte', required: false },
    { title: 'Contagious', author: 'Jonah Berger', required: false },
  ],
};

let tmpHome, classDir, bookIds;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-tb-conc-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  classDir = path.join(tmpHome, 'classes', FOLDER);
  await fs.mkdir(classDir, { recursive: true });
  await fs.writeFile(path.join(classDir, 'metadata.json'),
    JSON.stringify({ name: 'BUSI 305', course_code: 'BUSI 305' }));
  await fs.writeFile(path.join(classDir, 'syllabus_parsed.json'), JSON.stringify(SYLLABUS));
  bookIds = (await resolveTextbooks(classDir, SYLLABUS)).map(b => b.id);
  assert.equal(bookIds.length, 3, 'fixture should resolve three books');
});

after(async () => {
  delete process.env.CANVAS_SYNC_HOME;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(classDir, TEXTBOOK_LINKS_FILE), { force: true });
});

const linkedCount = async () =>
  Object.keys((await readTextbookLinks(classDir)).links ?? {}).length;

test('two links pasted at once are both saved', async () => {
  const outcomes = await Promise.allSettled([
    patchTextbookLink(classDir, SYLLABUS, bookIds[0], 'https://books.example.edu/kotler.pdf'),
    patchTextbookLink(classDir, SYLLABUS, bookIds[1], 'https://books.example.edu/duarte.pdf'),
  ]);
  const rejected = outcomes.filter(o => o.status === 'rejected');
  assert.equal(rejected.length, 0,
    `no write may fail: ${rejected.map(r => r.reason?.message).join('; ')}`);

  const { links } = await readTextbookLinks(classDir);
  assert.equal(links[bookIds[0]]?.url, 'https://books.example.edu/kotler.pdf');
  assert.equal(links[bookIds[1]]?.url, 'https://books.example.edu/duarte.pdf');
});

test('a burst across every book of a class loses none', async () => {
  await Promise.all(bookIds.map((id, i) =>
    patchTextbookLink(classDir, SYLLABUS, id, `https://books.example.edu/${i}.pdf`)));
  assert.equal(await linkedCount(), bookIds.length);
});

test('a clear racing a save does not resurrect the cleared link', async () => {
  await patchTextbookLink(classDir, SYLLABUS, bookIds[0], 'https://books.example.edu/first.pdf');
  await Promise.all([
    patchTextbookLink(classDir, SYLLABUS, bookIds[0], null),
    patchTextbookLink(classDir, SYLLABUS, bookIds[1], 'https://books.example.edu/second.pdf'),
  ]);
  const { links } = await readTextbookLinks(classDir);
  assert.equal(links[bookIds[0]], undefined, 'the clear stuck');
  assert.equal(links[bookIds[1]]?.url, 'https://books.example.edu/second.pdf', 'the save stuck');
});

test('two classes are not serialized against each other', async () => {
  // Guards a lock keyed too coarsely: a per-process lock would pass every test
  // above while putting every class behind every other.
  const otherDir = path.join(tmpHome, 'classes', '92295-busi-374-002');
  await fs.mkdir(otherDir, { recursive: true });
  await fs.writeFile(path.join(otherDir, 'metadata.json'),
    JSON.stringify({ name: 'BUSI 374', course_code: 'BUSI 374' }));
  await fs.writeFile(path.join(otherDir, 'syllabus_parsed.json'), JSON.stringify(SYLLABUS));
  const otherIds = (await resolveTextbooks(otherDir, SYLLABUS)).map(b => b.id);

  await Promise.all([
    patchTextbookLink(classDir, SYLLABUS, bookIds[0], 'https://books.example.edu/here.pdf'),
    patchTextbookLink(otherDir, SYLLABUS, otherIds[0], 'https://books.example.edu/there.pdf'),
  ]);

  assert.equal((await readTextbookLinks(classDir)).links[bookIds[0]]?.url,
    'https://books.example.edu/here.pdf');
  assert.equal((await readTextbookLinks(otherDir)).links[otherIds[0]]?.url,
    'https://books.example.edu/there.pdf');
});

test('no orphan temp files are left beside the links file', async () => {
  await Promise.all(bookIds.map((id, i) =>
    patchTextbookLink(classDir, SYLLABUS, id, `https://books.example.edu/${i}.pdf`)));
  const left = (await fs.readdir(classDir)).filter(n => n.includes(`${TEXTBOOK_LINKS_FILE}.tmp.`));
  assert.deepEqual(left, []);
});
