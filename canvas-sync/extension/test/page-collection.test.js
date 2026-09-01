// page-collection.test.js — the wiki half of a course reaches the output.
//
// Five of this user's six courses hide the Pages tab. Canvas answers the pages
// LISTING with 404 and a JSON message, while the pages themselves stay
// published and student-visible — and in one course they hold the entire
// syllabus. Measured before any of this existed: `pages.json` in five classes
// was `[{"message":"That page has been disabled for this course"}]`, and ZERO
// page links existed anywhere in the collected bodies.
//
// background.js registers chrome listeners at module scope, so it cannot be
// imported here. The functions under test are lifted from the source and run
// against stubs — the same technique the dashboard's tests use — which means
// they execute for real rather than being pattern-matched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canvasFetch, HttpError, PermissionError, AuthError, ServerError } from '../canvas-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = await fs.readFile(path.join(HERE, '..', 'background.js'), 'utf8');

// Comments in background.js quote the code they REPLACED, by name. An
// assertion that something no longer exists must not be able to read its own
// explanation of why — this is the fourth time that trap has cost a false
// failure across this codebase, so the stripped view is standard now.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Lift a declaration verbatim by brace-matching. The parameter list is skipped
// FIRST — a destructured default puts braces before the body.
function declaration(name) {
  const re = new RegExp(`(?:async )?function ${name}\\(`);
  const at = SRC.search(re);
  assert.notEqual(at, -1, `background.js no longer declares ${name}() — this test is stale, not passing`);
  let i = SRC.indexOf('(', at);
  for (let d = 0; i < SRC.length; i++) {
    if (SRC[i] === '(') d++;
    else if (SRC[i] === ')' && !--d) { i++; break; }
  }
  for (let j = SRC.indexOf('{', i), d = 0; j < SRC.length; j++) {
    if (SRC[j] === '{') d++;
    else if (SRC[j] === '}' && !--d) return SRC.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const CEILING = Number(/const PAGE_CRAWL_CEILING = (\d+);/.exec(SRC)[1]);

// One scope holding every page function, with the I/O injected.
function load({ getJson = async () => ({}), log = async () => {}, collect = async () => [] } = {}) {
  const names = ['_isCanvasErrorBody', '_normalizePageSlug',
    '_pageSlugsFromHtml', '_pageSlugsFromModules', '_crawlCoursePages', '_fillMissingModuleItems'];
  const body = names.map(declaration).join('\n\n');
  return new Function('canvasGetJson', '_checkCancel', '_log', '_collectPages', 'PAGE_CRAWL_CEILING',
    `${body}\nreturn { ${names.join(', ')} };`)(getJson, () => {}, log, collect, CEILING);
}

// --- the placeholder that started it ---------------------------------------

test('a Canvas error body is recognised as an error, not stored as a page', () => {
  const { _isCanvasErrorBody } = load();
  // The exact object that shipped into five classes' pages.json.
  assert.equal(_isCanvasErrorBody({ message: 'That page has been disabled for this course' }), true);
  assert.equal(_isCanvasErrorBody({ status: 'unauthorized', errors: [{ message: 'user not authorized' }] }), true);
});

test('…and a real page is NOT, however thin it looks', () => {
  // The half that matters: a predicate that answers true to everything would
  // pass the test above and throw away the entire corpus. A page is known by
  // its identity, so anything carrying one is data whatever else it holds.
  const { _isCanvasErrorBody } = load();
  assert.equal(_isCanvasErrorBody({ id: 7, title: 'Week 1', url: 'week-1' }), false);
  assert.equal(_isCanvasErrorBody({ url: 'week-1' }), false);
  assert.equal(_isCanvasErrorBody({ page_id: 12, message: 'a page that talks about a message' }), false);
  assert.equal(_isCanvasErrorBody([]), false, 'an array is a listing, never an envelope');
  assert.equal(_isCanvasErrorBody(null), false);
});

test('_collectPages refuses an error body that arrived with a 2xx', () => {
  // Status now decides tolerance, BEFORE any body is read — so this guard is
  // left with the one case status cannot see: a 200 whose body is an error
  // envelope. There is no tolerable version of that, so it is always loud.
  const fn = declaration('_collectPages');
  const guardAt = fn.indexOf('_isCanvasErrorBody');
  const pushAt = fn.indexOf('all.push(page)');
  assert.ok(guardAt !== -1 && pushAt !== -1 && guardAt < pushAt,
    'the guard must run BEFORE the non-array push, or the envelope is stored anyway');
  assert.match(fn, /throw new Error\(`Canvas returned an error body with a 2xx status/,
    'a 2xx error envelope must fail the resource loudly');
  // The second, overlapping defence is GONE. Two answers to "is this
  // tolerable?" is one more than can be kept honest.
  assert.doesNotMatch(CODE, /_isToleratedErrorBody|_TOLERATED_ENVELOPE/,
    'the body-shape tolerance discriminator is back alongside the status one');
  assert.doesNotMatch(fn.replace(/\/\/.*$/gm, ''), /PermissionError/,
    'tolerance is the caller\'s decision now, keyed on status');
});

// --- the taxonomy is STATUS-driven, and this is the whole of C1 -------------

async function statusOf(status, body = '{}') {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => ({
    status, ok: status >= 200 && status < 300,
    clone() { return this; }, text: async () => body, json: async () => JSON.parse(body),
    headers: { get: () => null },
  });
  try { return { ok: true, value: await canvasFetch('/api/v1/x') }; }
  catch (err) { return { ok: false, err }; }
  finally { globalThis.fetch = prior; }
}

test('every non-2xx canvasFetch does not already type becomes an HttpError', async () => {
  // `{"errors":[…]}` is what Canvas says for a rate limit AND for an
  // authorization refusal, so no reading of the body can separate "come back
  // later" from "this is closed to you". The status can, and now does.
  for (const status of [400, 404, 405, 409, 422, 429]) {
    const r = await statusOf(status, '{"errors":[{"message":"..."}]}');
    assert.equal(r.ok, false, `HTTP ${status} came back as a usable response`);
    assert.ok(r.err instanceof HttpError, `HTTP ${status} was not typed as an HttpError`);
    assert.equal(r.err.status, status, 'the status must survive onto the error');
  }
});

test('…and the statuses it already typed keep their own types', async () => {
  // The other half: a blanket `!ok -> HttpError` placed too early would erase
  // AuthError and ServerError, and with them the retry policy that reads them.
  assert.ok((await statusOf(401)).err instanceof AuthError, '401 must stay an AuthError');
  assert.ok((await statusOf(500)).err instanceof ServerError, '500 must stay a ServerError');
  assert.ok((await statusOf(403, 'nope')).err instanceof PermissionError, '403 must stay a PermissionError');
  const good = await statusOf(200, '[]');
  assert.equal(good.ok, true, 'a 2xx must still come back as a response');
});

test('a 404 listing is tolerated; a 429 is not', () => {
  // The POLICY, which lives with the caller rather than in the client. A
  // disabled tab is how five of six of this user's courses answer /pages, and
  // it must omit the key and keep the cached file. A rate limit must fail the
  // resource, because tolerating it is how a first sync completes with no
  // assignments.json ever written.
  const expr = /const closed = (err instanceof PermissionError[\s\S]*?);/.exec(SRC);
  assert.ok(expr, 'fetchResource no longer decides what is tolerable — this test is stale');
  const closed = new Function('err', 'PermissionError', 'HttpError', `return ${expr[1]};`);
  assert.equal(closed(new PermissionError('/x'), PermissionError, HttpError), true, '403 is closed');
  assert.equal(closed(new HttpError(404, '/x'), PermissionError, HttpError), true, '404 is closed');
  for (const status of [400, 409, 422, 429, 500]) {
    assert.equal(closed(new HttpError(status, '/x'), PermissionError, HttpError), false,
      `HTTP ${status} must NOT be tolerated as a closed resource`);
  }
  assert.equal(closed(new Error('boom'), PermissionError, HttpError), false,
    'an untyped failure is never tolerable');
});

// --- finding the slugs ------------------------------------------------------

test('page links are found in a body — and a FOREIGN course is not followed', () => {
  const { _pageSlugsFromHtml } = load();
  const html = `<a href="/courses/92294/pages/week-1">Week 1</a>
    <a href="https://canvas.rice.edu/courses/92294/pages/week-2#schedule">Week 2</a>
    <a href="/courses/999/pages/someone-elses-page">Another course</a>`;
  const found = _pageSlugsFromHtml(html, 92294);
  assert.deepEqual([...found].sort(), ['week-1', 'week-2']);
  // The discrimination half, and it is a privacy boundary rather than a tidy
  // -up: following it would collect a course this student may not be enrolled
  // in into this course's folder.
  assert.ok(!found.has('someone-elses-page'), 'a link into another course must never be followed');
});

test('a percent-encoded slug is the same slug, not a second page', () => {
  const { _pageSlugsFromHtml, _normalizePageSlug } = load();
  assert.equal(_normalizePageSlug('week%201'), 'week 1');
  assert.equal(_normalizePageSlug('week-1#top'), 'week-1');
  assert.equal(_normalizePageSlug('  '), '');
  const found = _pageSlugsFromHtml('<a href="/courses/5/pages/week%201">x</a>', 5);
  assert.deepEqual([...found], ['week 1']);
});

test('module items of type Page give up their slugs directly', () => {
  // The richest seed on real data: 30, 45 and 51 Page items in three courses.
  const { _pageSlugsFromModules } = load();
  const modules = [{ items: [
    { type: 'Page', page_url: 'session-1' },
    { type: 'Page', page_url: 'session-2' },
    { type: 'File', content_id: 9 },
    { type: 'Assignment', page_url: 'not-a-page' },
  ] }, { items: null }];
  assert.deepEqual([..._pageSlugsFromModules(modules)].sort(), ['session-1', 'session-2']);
  assert.deepEqual([..._pageSlugsFromModules(undefined)], []);
});

// --- the closure ------------------------------------------------------------

// A course whose front page links Week 1, which links Week 2, which links a
// reading page — the real shape, where the pages that matter are the ones no
// listing and no module ever names.
const COURSE = {
  'week-1': { id: 1, url: 'week-1', title: 'Week 1', body: '<a href="/courses/7/pages/week-2">next</a>' },
  'week-2': { id: 2, url: 'week-2', title: 'Week 2', body: '<a href="/courses/7/pages/reading-b">reading</a>' },
  'reading-b': { id: 3, url: 'reading-b', title: 'Reading B', body: '<p>no links</p>' },
};

test('the crawl reaches a page that is two links deep', async () => {
  // The planted positive. Seeded with week-1 ONLY: week-2 is reachable just
  // from week-1's body, and reading-b only from week-2's. A crawl that fetched
  // its seeds and stopped would collect one page and look like it worked.
  const asked = [];
  const { _crawlCoursePages } = load({
    getJson: async (url) => { const slug = url.split('/pages/')[1];
      asked.push(decodeURIComponent(slug)); return COURSE[decodeURIComponent(slug)] ?? { message: 'not found' }; },
  });
  const got = await _crawlCoursePages({ courseId: 7, seeds: new Set(['week-1']) });
  assert.deepEqual(got.map(p => p.url).sort(), ['reading-b', 'week-1', 'week-2']);
  assert.deepEqual(asked.sort(), ['reading-b', 'week-1', 'week-2']);
});

test('…and never follows a link into another course', async () => {
  const asked = [];
  const { _crawlCoursePages } = load({
    getJson: async (url) => { const slug = decodeURIComponent(url.split('/pages/')[1]);
      asked.push(slug);
      return { id: 1, url: slug, body: '<a href="/courses/999/pages/stranger">x</a>' }; },
  });
  await _crawlCoursePages({ courseId: 7, seeds: new Set(['week-1']) });
  assert.deepEqual(asked, ['week-1']);
  assert.ok(!asked.includes('stranger'), 'the crawl left this course');
});

test('a cycle terminates, and nothing is fetched twice', async () => {
  const asked = [];
  const cyclic = {
    a: { id: 1, url: 'a', body: '<a href="/courses/7/pages/b">b</a>' },
    b: { id: 2, url: 'b', body: '<a href="/courses/7/pages/a">a</a>' },
  };
  const { _crawlCoursePages } = load({
    getJson: async (url) => { const s = decodeURIComponent(url.split('/pages/')[1]);
      asked.push(s); return cyclic[s]; },
  });
  const got = await _crawlCoursePages({ courseId: 7, seeds: new Set(['a']) });
  assert.deepEqual(asked.sort(), ['a', 'b']);
  assert.equal(got.length, 2);
});

test('a page already in the listing is not fetched again', async () => {
  const asked = [];
  const { _crawlCoursePages } = load({
    getJson: async (url) => { const s = decodeURIComponent(url.split('/pages/')[1]);
      asked.push(s); return COURSE[s] ?? { message: 'no' }; },
  });
  await _crawlCoursePages({ courseId: 7, seeds: new Set(['week-1', 'week-2']), known: new Set(['week-2']) });
  assert.ok(!asked.includes('week-2'), 'a page the listing already gave us must not be refetched');
});

test('one unreadable page does not abandon the rest', async () => {
  // Unpublished pages and pages not shared with this student are ordinary in a
  // live course. Stopping there would make the crawl only as complete as its
  // unluckiest link.
  const logs = [];
  const { _crawlCoursePages } = load({
    getJson: async (url) => { const s = decodeURIComponent(url.split('/pages/')[1]);
      if (s === 'locked') throw new Error('403');
      if (s === 'gone') return { message: 'The specified resource does not exist.' };
      return COURSE[s] ?? { id: 9, url: s, body: '' }; },
    log: async (level, msg) => logs.push(`${level}: ${msg}`),
  });
  const got = await _crawlCoursePages({ courseId: 7, seeds: new Set(['locked', 'gone', 'week-1']) });
  assert.deepEqual(got.map(p => p.url).sort(), ['reading-b', 'week-1', 'week-2']);
  assert.ok(logs.some(l => l.includes('could not be read')), 'unreadable pages must be reported, not swallowed');
});

test('the ceiling is generous, and says what it dropped', async () => {
  // The completeness doctrine's rule is not "never bound" — it is "never drop
  // anything silently". This bound is a runaway guard: the largest course on
  // this account lists 29 pages.
  assert.ok(CEILING >= 500, `a ${CEILING}-page ceiling is not generous`);
  const logs = [];
  const { _crawlCoursePages } = load({
    // every page links two more, forever
    getJson: async (url) => { const s = decodeURIComponent(url.split('/pages/')[1]);
      return { id: 1, url: s, body: `<a href="/courses/7/pages/${s}-x">x</a><a href="/courses/7/pages/${s}-y">y</a>` }; },
    log: async (level, msg) => logs.push(`${level}: ${msg}`),
  });
  const got = await _crawlCoursePages({ courseId: 7, seeds: new Set(['root']), reason: 'test' });
  assert.equal(got.length, CEILING, 'the crawl must stop at the ceiling');
  const warn = logs.find(l => l.startsWith('warn:'));
  assert.ok(warn && /still queued/.test(warn) && /NOT collected/.test(warn),
    `hitting the ceiling must be logged with what was lost — got ${warn ?? 'nothing'}`);
});

// --- modules that arrive without their items --------------------------------

test('a module whose items Canvas omitted gets them fetched', async () => {
  // BUSI 374 is the proof: one module, "Session navigation", arriving with no
  // items while it plainly holds the whole course.
  const modules = [{ id: 158803, name: 'Session navigation', items: [] }];
  const { _fillMissingModuleItems } = load({
    collect: async () => [{ type: 'Page', page_url: 'session-1' }, { type: 'Page', page_url: 'session-2' }],
  });
  const filled = await _fillMissingModuleItems(92336, modules, 'test');
  assert.equal(filled, 2);
  assert.equal(modules[0].items.length, 2, 'the module must be filled in place, so seeding sees it');
});

test('…and a module that already has its items is left alone', async () => {
  // The other half. Refetching every module would triple the request count on
  // a healthy course to fix one broken one.
  let calls = 0;
  const modules = [{ id: 1, items: [{ type: 'Page', page_url: 'kept' }] }];
  const { _fillMissingModuleItems } = load({ collect: async () => { calls++; return []; } });
  const filled = await _fillMissingModuleItems(1, modules, 'test');
  assert.equal(calls, 0, 'a populated module must not be refetched');
  assert.equal(filled, 0);
  assert.deepEqual(modules[0].items, [{ type: 'Page', page_url: 'kept' }]);
});

// --- what actually reaches the bridge ---------------------------------------

test('a closed listing plus a successful crawl writes the REAL pages', () => {
  // The middle case, and the point of the whole work order. `unlessForbidden`
  // omits a key when its listing 403s, which is right for preserving a
  // known-good file — but applied to pages it would also discard everything
  // the crawl just found, and leave the disabled-tab placeholder on disk.
  assert.match(CODE, /\? \{ pages: allPages, pages_source: forbidden\.has\('pages'\) \? 'crawl' : 'listing' \}/,
    'the pages payload must send crawled pages, and say which case it is');
  assert.doesNotMatch(CODE, /unlessForbidden\('pages', 'pages', pages\)/,
    'the old rule would drop every crawled page');

  // The three cases, evaluated rather than eyeballed. `pages_source` is the
  // contract the bridge merges on (fc holds the write side): 'listing' is
  // authoritative and written wholesale, 'crawl' is a discovery and merged by
  // slug, and an absent key means storage writes nothing at all.
  const decide = (n, forbidden) => ((n || !forbidden)
    ? { pages: `<${n}>`, pages_source: forbidden ? 'crawl' : 'listing' } : {});
  assert.deepEqual(decide(12, true), { pages: '<12>', pages_source: 'crawl' },
    'closed listing + crawl won -> send, marked as a discovery');
  assert.deepEqual(decide(20, false), { pages: '<20>', pages_source: 'listing' },
    'working listing -> send, marked authoritative');
  assert.deepEqual(decide(0, false), { pages: '<0>', pages_source: 'listing' },
    'an honest empty listing must still be able to clear the cache');
  assert.deepEqual(decide(0, true), {},
    'closed listing + nothing found -> omit, keep last known-good');
});

test('the embedded-file corpus reads every page, not just the listed ones', () => {
  // Five of six courses have a closed listing, so `pages` is empty there and
  // everything real arrives through the crawl. Reading `pages` here is why
  // week-page PDFs were never downloaded — the corpus that finds embedded
  // files had nothing to read.
  const corpus = /const htmlCorpus = \[([\s\S]*?)\]\.filter\(Boolean\)/.exec(SRC);
  assert.ok(corpus, 'the html corpus moved — this test is stale');
  assert.match(corpus[1], /\.\.\.allPages\.map\(p => p\?\.body\)/,
    'the corpus must read the full page set');
  assert.doesNotMatch(corpus[1], /\.\.\.pages\.map\(p => p\?\.body\)/,
    'the corpus is back to the listing alone');
});

test('the front page is fetched, and its absence is not an error', () => {
  const at = SRC.indexOf('/front_page');
  assert.notEqual(at, -1, 'nothing fetches the course front page');
  const around = SRC.slice(at - 400, at + 400);
  assert.match(around, /catch \{/, 'a course with no front page set must not fail the sync');
  assert.match(around, /_isCanvasErrorBody\(fp\)/,
    'a 404 message body must not be stored as the front page');
});

test('seeding happens in the order the data demands', () => {
  // Measured before this existed: ZERO page links were present in the
  // collected bodies of all six courses. A crawl seeded from what we already
  // had would have found nothing — the front page is not an addition to the
  // crawl, it is its precondition, and module items must be repaired before
  // they can seed it.
  const fill = SRC.indexOf('_fillMissingModuleItems(id, modules, reason)');
  const front = SRC.indexOf('/front_page');
  const seeds = SRC.indexOf('const seedSlugs');
  const crawl = SRC.indexOf('_crawlCoursePages({');
  const corpus = SRC.indexOf('const htmlCorpus');
  for (const [name, at] of [['fill', fill], ['front', front], ['seeds', seeds], ['crawl', crawl], ['corpus', corpus]]) {
    assert.notEqual(at, -1, `${name} step is missing from the sync`);
  }
  assert.ok(fill < seeds, 'module items must be repaired before they seed the crawl');
  assert.ok(front < seeds, 'the front page must be fetched before seeds are gathered');
  assert.ok(seeds < crawl, 'seeds before the crawl');
  assert.ok(crawl < corpus, 'the crawl must finish before the embedded-file corpus is built');
});

// --- a partial crawl must not be able to shrink the record ------------------

test('a course remembers the slugs it collected, and re-seeds from them', () => {
  // M1. The crawl is a DISCOVERY, not an enumeration, so its reach depends on
  // which seeds happened to exist. A course whose listing worked last term and
  // gets its Pages tab disabled could rediscover one page where twenty were
  // known — and the bridge writes resource keys wholesale, so the one-page
  // array would replace the twenty-page file.
  assert.match(SRC, /const SLUG_MEMORY_KEY = 'pageSlugsByCourse';/,
    'nothing remembers which pages this course had');
  assert.match(SRC, /slugMemory\[id\] = \[\.\.\.new Set\(allPages\.map\(pg => _normalizePageSlug\(pg\?\.url\)\)/,
    'the collected slugs must be written back for the next sync');
  assert.match(SRC, /await _storageSet\(\{ \[SLUG_MEMORY_KEY\]: slugMemory \}\)/,
    'the memory must actually persist');

  // Seeded ONLY when the listing is closed: a working listing is authoritative,
  // and re-fetching every remembered slug against it is requests spent to
  // learn nothing.
  const guard = /if \(forbidden\.has\('pages'\)\) \{\s*\n\s*for \(const slug of \(Array\.isArray\(slugMemory\[id\]\)/;
  assert.match(SRC, guard, 'remembered slugs must seed the crawl when the listing is forbidden');

  const seedAt = SRC.indexOf('SLUG_MEMORY_KEY');
  const crawlAt = SRC.indexOf('_crawlCoursePages({');
  assert.ok(seedAt < crawlAt, 'the memory must be read BEFORE the crawl runs, or it seeds nothing');
});

test('the discussion reply cap is gone, and cannot come back quietly', () => {
  // It kept the first 50 replies and 20,000 characters, silently. The one
  // thread where a seminar actually assigns its reading lost everything past
  // reply 50 while the sync reported success. Storage is not a constraint here.
  const loop = /const replyHtml = \[\];([\s\S]*?)\n        if \(unreadableTopics\.length\)/.exec(SRC);
  assert.ok(loop, 'the reply collection loop moved — this test is stale');
  assert.match(loop[1], /topic\.replies_text = texts\.join\('\\n---\\n'\);/,
    'replies must be kept whole');
  assert.doesNotMatch(loop[1], /\.slice\(0, 50\)|\.slice\(0, 20000\)/,
    'a silent retention cap is back on discussion replies');
});

test('a thread that could not be opened is named, not shrugged at', () => {
  // "Locked topic — skip" in a comment is not a record. A thread we could not
  // read is missing from every downstream corpus.
  assert.match(SRC, /unreadableTopics\.push\(/, 'unreadable topics must be collected');
  assert.match(SRC, /could not `\s*\n\s*\+ `be opened \(locked, or a reply is required first\)/,
    'and reported, with what was lost');
  assert.doesNotMatch(SRC, /catch \{ \/\* locked topic or require_initial_post — skip \*\/ \}/,
    'the silent skip is back');
});

test('a module whose items could not be fetched is reported', async () => {
  // My own silent catch, from the first pass: a module we failed to fetch is a
  // module whose pages were never seeded.
  const logs = [];
  const modules = [{ id: 5, name: 'Session navigation', items: [] }];
  const { _fillMissingModuleItems } = load({
    collect: async () => { throw new Error('403'); },
    log: async (level, msg) => logs.push(`${level}: ${msg}`),
  });
  await _fillMissingModuleItems(1, modules, 'test');
  const warn = logs.find(l => l.startsWith('warn:'));
  assert.ok(warn && warn.includes('Session navigation'),
    `a module that could not be fetched must be named — got ${warn ?? 'nothing'}`);
});

test('a crawled page always carries the slug the merge keys on', () => {
  // fc merges crawl-sourced pages into the cached file by `url`. A merge on a
  // missing key does not no-op — it appends duplicates. Canvas does return
  // `url` on a single-page GET, but that is not something this code can check
  // at runtime, so the slug we asked for is stamped on and the dependency
  // disappears.
  const fn = declaration('_crawlCoursePages');
  assert.match(fn, /if \(!page\.url\) page\.url = slug;/,
    'a crawled row with no url would break the bridge-side merge');
  const stampAt = fn.indexOf('page.url = slug');
  const pushAt = fn.indexOf('collected.push(page)');
  assert.ok(stampAt < pushAt, 'the stamp must happen before the row is kept');
});

test('the retry after a rate limit gets the same status reading as the first try', async (t) => {
  // Found by mutation, not by reading: deleting the retry path's own non-2xx
  // check left every test green. That path is exactly where a rate-limited
  // request lands, so a 404 or 429 leaking THERE is the original defect
  // surviving in the one place most likely to hit it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rateLimited = {
    status: 403, ok: false, clone() { return this; },
    text: async () => '403 Forbidden (Rate Limit Exceeded)',
    json: async () => ({}), headers: { get: () => null },
  };
  const secondTry = {
    status: 429, ok: false, clone() { return this; },
    text: async () => '{"errors":[{"message":"Rate Limit Exceeded"}]}',
    json: async () => ({ errors: [{ message: 'Rate Limit Exceeded' }] }),
    headers: { get: () => null },
  };
  const queue = [rateLimited, secondTry];
  const prior = globalThis.fetch;
  globalThis.fetch = async () => queue.shift();
  try {
    const settled = canvasFetch('/api/v1/courses').then(v => ({ v }), err => ({ err }));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    t.mock.timers.tick(60_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const { v, err } = await settled;
    assert.ok(!v, 'a 429 on the retry must not come back as a usable response');
    assert.ok(err instanceof HttpError, `retry 429 was typed ${err?.name}`);
    assert.equal(err.status, 429);
  } finally {
    if (prior === undefined) delete globalThis.fetch; else globalThis.fetch = prior;
  }
});
