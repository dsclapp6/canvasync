// textbooks.test.js — syllabus names survive beside user-owned PDF/e-book links,
// and assignment references receive those links without guessing across books.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from './helpers/server-factory.js';
import {
  patchTextbookLink, readTextbookLinks, referencedTextbooks, resolveTextbooks,
  reconcileSyllabusTextbooks, textbooksFromSyllabus, TextbookError,
  TEXTBOOK_LINKS_FILE,
} from '../textbooks.js';

const SECRET = 'test-secret-textbooks';
const FOLDER = '92294-busi-305-001';
const SYLLABUS = {
  textbooks: [
    { title: 'Marketing Management', author: 'Philip Kotler', edition: '16th', isbn: '978-1-292-40481-3', required: true },
    { title: 'HBR Guide to Persuasive Presentations', author: 'Nancy Duarte', required: false },
  ],
};

let server, baseUrl, tmpHome, classDir;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-textbooks-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';
  await fs.writeFile(path.join(tmpHome, 'config.json'), JSON.stringify({ bridgeSecret: SECRET }), { mode: 0o600 });
  classDir = path.join(tmpHome, 'classes', FOLDER);
  await fs.mkdir(classDir, { recursive: true });
  await fs.writeFile(path.join(classDir, 'metadata.json'), JSON.stringify({ name: 'BUSI 305', course_code: 'BUSI 305' }));
  await fs.writeFile(path.join(classDir, 'syllabus_parsed.json'), JSON.stringify(SYLLABUS));
  await fs.writeFile(path.join(classDir, 'assignments.json'), JSON.stringify([
    { id: 71, name: 'Segmentation Memo', description: '<p>Use Marketing Management chapter 4.</p>',
      html_url: 'https://canvas.rice.edu/courses/92294/assignments/71' },
  ]));
  await fs.writeFile(path.join(classDir, 'assignments_mined.json'), JSON.stringify({ items: [
    { id: 'segmentation-memo', title: 'Segmentation Memo', canvas_assignment_id: 71,
      description: 'Use Marketing Management chapter 4.', related_textbooks: [{ title: 'Marketing Management' }] },
  ] }));
  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  const graveyard = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-textbooks-void-'));
  process.env.CANVAS_SYNC_HOME = graveyard;
  delete process.env.BRIDGE_PORT;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'X-Bridge-Secret': SECRET };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('syllabus books receive stable ids and required/recommended status', () => {
  const books = textbooksFromSyllabus(SYLLABUS);
  assert.equal(books.length, 2);
  assert.match(books[0].id, /^book-[a-f0-9]{16}$/);
  assert.equal(books[0].required, true);
  assert.equal(books[1].required, false);
});

test('optional reading lists are retained in the parse but omitted from needed textbooks', () => {
  const source = `Required Readings
See Canvas for free ebooks, articles, and videos that are required.
Optional Readings
Deploy Empathy by Michele Hansen
Inspired: How to Create Tech Products Customers Love by Marty Cagan`;
  const reconciled = reconcileSyllabusTextbooks([
    { title: 'Deploy Empathy', author: 'Michele Hansen', required: false },
    { title: 'Inspired: How to Create Tech Products Customers Love', author: 'Marty Cagan', required: true },
  ], source);

  assert.deepEqual(reconciled.map(book => book.status), ['optional', 'optional']);
  assert.deepEqual(textbooksFromSyllabus({ textbooks: reconciled }), []);
});

test('existing classes reconcile against extracted syllabus text without waiting for a re-parse', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-textbook-reconcile-'));
  try {
    await fs.mkdir(path.join(dir, 'materials'));
    await fs.writeFile(path.join(dir, 'materials', 'Syllabus.pdf.txt'), `Required Readings
See Canvas for free ebooks, articles, and videos that are required.
Optional Readings
Deploy Empathy by Michele Hansen`);
    await fs.writeFile(path.join(dir, 'files_index.json'), JSON.stringify([{
      displayName: 'Course Syllabus.pdf',
      extractionStatus: 'done',
      materialsPath: 'materials/Syllabus.pdf.txt',
      canvasUpdatedAt: '2026-08-25T00:00:00Z',
      duplicateOf: null,
      supersededBy: null,
    }]));
    const resolved = await resolveTextbooks(dir, {
      textbooks: [{ title: 'Deploy Empathy', author: 'Michele Hansen', required: true }],
    });
    assert.deepEqual(resolved, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('clear required-textbook and labelled-title formats provide a deterministic floor', () => {
  const source = `Course Material
Required textbook: Financial Accounting (7e), by Hanlon, Magee, Pfeiffer, Dyckman,
Cambridge Business Publishers, 2023 (978-1-61853-431-6).

TEXTBOOKS
Title: The Goal: A Process of Ongoing Improvement
Authors: Eliyahu M. Goldratt and Jeff Cox
Publisher: North River Press; 30th Anniversary Edition`;
  const reconciled = reconcileSyllabusTextbooks([], source);

  assert.deepEqual(reconciled.map(book => book.title), [
    'Financial Accounting',
    'The Goal: A Process of Ongoing Improvement',
  ]);
  assert.equal(reconciled[0].isbn, '9781618534316');
  assert.equal(reconciled[0].role, 'primary');
  assert.equal(reconciled[1].edition, '30th Anniversary Edition');
});

test('a saved link is separate from parser output and survives a syllabus rewrite', async () => {
  const [book] = textbooksFromSyllabus(SYLLABUS);
  await patchTextbookLink(classDir, SYLLABUS, book.id, 'https://books.example.edu/marketing.pdf');
  assert.equal((await readTextbookLinks(classDir)).links[book.id].url, 'https://books.example.edu/marketing.pdf');

  const reparsed = { textbooks: [{ ...SYLLABUS.textbooks[0] }, SYLLABUS.textbooks[1]] };
  const resolved = await resolveTextbooks(classDir, reparsed);
  assert.equal(resolved[0].url, 'https://books.example.edu/marketing.pdf');
  assert.ok(await fs.stat(path.join(classDir, TEXTBOOK_LINKS_FILE)));
});

test('a link saved under the v1 combined-ISBN id survives the corrected ISBN identity', async () => {
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-textbook-isbn-'));
  try {
    const isbn = 'ISBN-10: 0195128958 or ISBN-13: 9780195128956';
    const legacyIdentity = isbn.toUpperCase().replace(/[^0-9X]/g, '');
    const legacyId = `book-${crypto.createHash('sha256').update(legacyIdentity).digest('hex').slice(0, 16)}`;
    await fs.writeFile(path.join(legacyDir, TEXTBOOK_LINKS_FILE), JSON.stringify({
      version: 1,
      links: { [legacyId]: { url: 'https://books.example.edu/game-theory.pdf' } },
    }));
    const [resolved] = await resolveTextbooks(legacyDir, {
      textbooks: [{ title: 'An Introduction to Game Theory', isbn, status: 'required' }],
    });
    assert.equal(resolved.url, 'https://books.example.edu/game-theory.pdf');
    assert.notEqual(resolved.id, legacyId, 'the current id uses the canonical ISBN-13');
  } finally {
    await fs.rm(legacyDir, { recursive: true, force: true });
  }
});

test('only web links without embedded credentials are accepted', async () => {
  const [book] = textbooksFromSyllabus(SYLLABUS);
  await assert.rejects(
    patchTextbookLink(classDir, SYLLABUS, book.id, 'file:///tmp/book.pdf'),
    TextbookError,
  );
  await assert.rejects(
    patchTextbookLink(classDir, SYLLABUS, book.id, 'https://student:secret@example.edu/book'),
    /username or password/,
  );
});

test('references match exact titles, while a bare chapter never guesses between two books', () => {
  const books = textbooksFromSyllabus(SYLLABUS);
  assert.deepEqual(
    referencedTextbooks(books, { description: 'Read Marketing Management, chapter 6.' }).map(book => book.title),
    ['Marketing Management'],
  );
  assert.deepEqual(referencedTextbooks(books, { description: 'Read chapter 6.' }), []);
  assert.equal(referencedTextbooks([books[0]], { description: 'Read chapter 6.' })[0].title, 'Marketing Management');
});

test('a generic chapter reference uses the one explicitly primary textbook', () => {
  const books = textbooksFromSyllabus({ textbooks: [
    { title: 'Managing Marketing', role: 'primary', status: 'required' },
    { title: 'Customer Value Handbook', role: 'supplemental', status: 'required' },
  ] });
  assert.deepEqual(
    referencedTextbooks(books, { description: 'Read Textbook Chapter 4, pp. 71–78.' })
      .map(book => book.title),
    ['Managing Marketing'],
  );
});

test('class and assignment APIs carry the saved hyperlink', async () => {
  const [book] = textbooksFromSyllabus(SYLLABUS);
  await patchTextbookLink(classDir, SYLLABUS, book.id, 'https://books.example.edu/marketing.pdf');
  const classResult = await request('GET', `/api/class/${FOLDER}`);
  assert.equal(classResult.status, 200);
  const marketing = classResult.body.textbooks.find(book => book.title === 'Marketing Management');
  assert.equal(marketing.url, 'https://books.example.edu/marketing.pdf');
  const task = classResult.body.mined.items.find(item => item.id === 'segmentation-memo');
  assert.equal(task.textbooks[0].url, marketing.url);

  const assignment = await request('GET', `/api/class/${FOLDER}/assignment/segmentation-memo`);
  assert.equal(assignment.status, 200);
  assert.equal(assignment.body.textbooks[0].url, marketing.url);
});

test('the textbook route updates and clears a link', async () => {
  const [book] = textbooksFromSyllabus(SYLLABUS);
  let result = await request('PUT', `/api/class/${FOLDER}/textbooks/${book.id}`, {
    url: 'https://reader.example.edu/title/123',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.textbook.url, 'https://reader.example.edu/title/123');

  result = await request('PUT', `/api/class/${FOLDER}/textbooks/${book.id}`, { url: null });
  assert.equal(result.status, 200);
  assert.equal(result.body.textbook.url, null);
});

test('a corrupt textbook link store stays readable as empty but cannot be overwritten', async () => {
  const [book] = textbooksFromSyllabus(SYLLABUS);
  const linksPath = path.join(classDir, TEXTBOOK_LINKS_FILE);
  const corrupt = '{"paid link":';
  await fs.writeFile(linksPath, corrupt);

  const view = await request('GET', `/api/class/${FOLDER}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.textbooks.find(candidate => candidate.id === book.id).url, null);

  const refused = await request('PUT', `/api/class/${FOLDER}/textbooks/${book.id}`, {
    url: 'https://reader.example.edu/replacement',
  });
  assert.equal(refused.status, 500);
  const preserved = (await fs.readdir(classDir))
    .find(name => name.startsWith(`${TEXTBOOK_LINKS_FILE}.unreadable-`));
  assert.ok(preserved, 'the unreadable link store must be preserved');
  assert.match(refused.body.error, new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await fs.readFile(path.join(classDir, preserved), 'utf8'), corrupt);
  await assert.rejects(fs.access(linksPath), { code: 'ENOENT' });

  const retry = await request('PUT', `/api/class/${FOLDER}/textbooks/${book.id}`, {
    url: 'https://reader.example.edu/replacement',
  });
  assert.equal(retry.status, 200, 'ENOENT remains a legitimate empty link store');
  assert.equal((await readTextbookLinks(classDir)).links[book.id].url,
    'https://reader.example.edu/replacement');
  assert.equal(await fs.readFile(path.join(classDir, preserved), 'utf8'), corrupt);
});

test('a valid-JSON textbook store with non-object links is preserved and refuses an update', async () => {
  const [book] = textbooksFromSyllabus(SYLLABUS);
  const linksPath = path.join(classDir, TEXTBOOK_LINKS_FILE);
  const wrongShape = JSON.stringify({ version: 1, links: ['must not be erased'] });
  const entriesBefore = new Set(await fs.readdir(classDir));
  await fs.writeFile(linksPath, wrongShape);

  assert.deepEqual((await readTextbookLinks(classDir)).links, {}, 'wrong-shape reads stay empty');
  const refused = await request('PUT', `/api/class/${FOLDER}/textbooks/${book.id}`, {
    url: 'https://reader.example.edu/wrong-shape-replacement',
  });
  assert.equal(refused.status, 500);
  const preserved = (await fs.readdir(classDir))
    .find(name => name.startsWith(`${TEXTBOOK_LINKS_FILE}.unreadable-`) && !entriesBefore.has(name));
  assert.ok(preserved, 'the wrong-shape textbook store must be moved aside');
  assert.match(refused.body.error, /could not be read \(shape\)/);
  assert.match(refused.body.error, new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await fs.readFile(path.join(classDir, preserved), 'utf8'), wrongShape);
  await assert.rejects(fs.access(linksPath), { code: 'ENOENT' });
});

test('the written textbook links carry their contract keys and no reader sentinels', async () => {
  // WHY THIS ASSERTS EXACT KEYS rather than just the payload: the reader now
  // returns `unreadable` and `reason` alongside the data, so a writer that
  // spreads the whole state persists those sentinels into the store. Reverting
  // this writer to `{...state}` passed the entire bridge suite — 93/93 — which
  // is how the hardening would quietly be undone. It matters because
  // `unreadable` is already a live idiom in this repo (scripts/meeting-times.js
  // uses it on its own file-state objects), so a future reader writing
  // `if (parsed.unreadable)` would be reading a stale flag off disk.
  const [book] = textbooksFromSyllabus(SYLLABUS);
  await patchTextbookLink(classDir, SYLLABUS, book.id, 'https://books.example.edu/keys.pdf');
  const written = JSON.parse(await fs.readFile(path.join(classDir, TEXTBOOK_LINKS_FILE), 'utf8'));
  assert.deepEqual(Object.keys(written).sort(), ['links', 'updatedAt', 'version']);
  assert.equal(Object.hasOwn(written, 'unreadable'), false, 'the unreadable sentinel reached disk');
  assert.equal(Object.hasOwn(written, 'reason'), false, 'the reason sentinel reached disk');
});

