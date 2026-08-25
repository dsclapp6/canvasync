// progress-page.test.js — bridge/public/progress.html renders honestly.
//
// The page has one job the rest of the dashboard does not: it is read while
// the machine is under load, to answer "is the local model still running in
// the background?". Every failure mode below was picked because it turns that
// page from useful into actively misleading:
//
//   - a corrupt or half-written payload rendering "undefined", "NaN",
//     "[object Object]" or "Invalid Date" where a number belongs;
//   - a 0 that means "we never looked" being drawn the same as a 0 that means
//     "Canvas published nothing" (calendar_events.json is [] for all six real
//     classes — that is a correct empty, not a failed index);
//   - a bare percentage with no denominator, which is how "80% done" gets read
//     off a total nobody measured;
//   - a fetch failure blanking the page instead of saying so.
//
// The page is a single self-contained file, so the test extracts its inline
// <script> and runs it in a vm against a minimal DOM shim. That is enough to
// exercise every render path; it deliberately does not check CSS layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// fileURLToPath, never import.meta.url's raw pathname: a raw-pathname compare
// silently no-ops when the path contains characters the URL form escapes.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '..', 'public', 'progress.html');

const REGIONS = ['banner', 'topline', 'classes', 'global', 'foot', 'pulse', 'poll-note'];

function stubNode(id) {
  return {
    id, innerHTML: '', textContent: '', className: '', hidden: false, value: '',
    disabled: false, style: { setProperty() {} }, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    parentNode: { appendChild() {} },
    appendChild() {}, addEventListener() {}, closest: () => null,
  };
}

/**
 * Boot the page's script with a scripted /api/index-progress response.
 * `respond` returns either a payload (200) or {status} for an error case.
 */
async function renderPage(respond) {
  const html = await fs.readFile(PAGE, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'progress.html must carry exactly one inline <script>');

  const nodes = {};
  for (const id of REGIONS) nodes[id] = stubNode(id);

  const sandbox = {
    document: {
      hidden: false,
      getElementById: (id) => nodes[id] || null,
      createElement: () => stubNode('created'),
      addEventListener() {},
      body: stubNode('body'),
    },
    window: {},                                   // no window.canvasync: browser path
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0,                          // the poll loop must not run here
    clearTimeout() {},
    console,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    isFinite, isNaN, Intl,
    async fetch(url) {
      if (String(url).includes('class-colors')) {
        // Force the position-based fallback palette, which is the path that
        // runs whenever /api/class-colors is unreachable.
        return { ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) };
      }
      const r = respond();
      if (r && r.status) return { ok: false, status: r.status, statusText: 'Err', json: async () => ({}) };
      return { ok: true, status: 200, statusText: 'OK', json: async () => r };
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox, { filename: 'progress.inline.js' });
  // Let the boot IIFE's promise chain settle.
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

  return {
    nodes,
    sandbox,
    expandAll(folders) {
      const open = vm.runInContext('OPEN', sandbox);
      for (const f of folders) open.add(f);
      vm.runInContext('renderClasses(LAST)', sandbox);
    },
    markup() {
      return nodes.topline.innerHTML + nodes.classes.innerHTML
        + nodes.global.innerHTML + nodes.foot.innerHTML;
    },
    text() {
      return (nodes.topline.innerHTML + nodes.classes.innerHTML
        + nodes.global.innerHTML + nodes.foot.innerHTML).replace(/<[^>]*>/g, ' ');
    },
  };
}

// A payload shaped like the real one but deliberately damaged: the fields the
// endpoint cannot fill in yet arrive as null, and a stage/category the page has
// never heard of arrives alongside them.
function payload(overrides = {}) {
  return {
    generatedAt: '2026-08-24T18:12:40.000Z',
    home: '/Users/tempadmin/canvas-sync-data',
    bridgePid: 49964,
    scope: { courseIds: ['93903', '90805'], source: 'last-sync' },
    lastScrape: { at: '2026-08-24T17:58:12.136Z', coursesSeen: ['93903', '90805'] },
    pipeline: { running: true, activeCount: 1, queuedCount: 1, maxConcurrent: 3 },
    model: {
      backend: 'auto',
      lock: {
        held: true, alive: true, pid: 58564, heldForMs: 262000,
        holderKind: 'pipeline-stage',
        holder: { folder: '93903-busi-380-002', stage: 'mine', script: 'mine-assignments.js' },
      },
      waiting: [{ folder: '90805-econ-205-002', stage: 'build', basis: 'inferred' }],
    },
    jobs: [{ script: 'mine-assignments.js', folder: '93903-busi-380-002', elapsedSec: 262, holdsModelLock: true }],
    classes: [
      {
        folder: '93903-busi-380-002', courseId: '93903', code: 'BUSI 380 002',
        name: 'Marketing', term: 'Fall 2026', inScope: true,
        lastScrapedAt: '2026-08-24T17:58:12.136Z',
        overall: { done: 2, total: 4, state: 'running', blocked: null },
        stages: [
          { key: 'parse', state: 'done', script: 'scripts/parse-syllabus.js' },
          { key: 'extract', state: 'done', script: 'scripts/extract-course-files.js' },
          { key: 'mine', state: 'running', script: 'scripts/mine-assignments.js', elapsedSec: 262 },
          { key: 'graph', state: 'cli-only', script: 'scripts/build-graph.js' },
          { key: 'build', state: 'stale', script: 'scripts/build-context.js' },
          { key: 'pack2', state: 'not-wired', script: 'scripts/build-pack.js' },
        ],
        categories: [
          // state:'none-published' is what scripts/index-progress.js actually
          // emits once it has parsed calendar_events.json as an empty array.
          // The fixture said 'empty', which is the state a category that was
          // never read also carries — and the page keyed "none published" off
          // the category NAME, so it asserted a fact about Canvas even in a
          // cold install where nothing had ever been scraped.
          { key: 'calendarEvents', count: 0, state: 'none-published', updatedAt: '2026-08-24T17:58:12.136Z' },
          { key: 'minedTasks', count: 17, state: 'complete', updatedAt: '2026-08-24T09:02:00.000Z',
            extra: { byCategory: { homework: 14, reading: 0, exam: 0 } } },
        ],
      },
      {
        // The damaged one.
        folder: '92294-busi-305-001-002-003', courseId: '92294', code: 'BUSI 305',
        name: null, term: null, inScope: true,
        lastScrapedAt: '2026-08-24T17:58:12Z  (mtime(metadata.json) — annotated)',
        overall: { done: null, total: null, percent: 'NaN', state: 'wedged', blocked: null },
        stages: [
          { key: 'parse', state: null },
          { key: 'extract', state: 'done', script: 'scripts/extract-course-files.js', finishedAt: 'not-a-timestamp' },
          { key: 'brand-new-stage', state: 'a-state-from-the-future' },
        ],
        categories: [
          { key: 'quizzes', count: 'seven', state: null, updatedAt: 'yesterday' },
          { key: 'brand-new-category', count: 4, state: 'complete', updatedAt: '2026-08-24T04:11:53.000Z' },
        ],
      },
    ],
    global: {
      calendar: {
        generatedAt: '2026-08-24T13:02:44.000Z',
        window: { from: '2026-08-17', to: '2027-02-20' },
        counts: { meeting: 110, homework: 93, reading: 0, exam: 2, checkpoint: 24 },
      },
      unscopedClasses: { count: 0 },
    },
    requiresNewWrites: ['jobs[].pid', 'pipeline.queued[]'],
    ...overrides,
  };
}

const FOLDERS = ['93903-busi-380-002', '92294-busi-305-001-002-003'];

test('a null, non-numeric or unparseable field must never render as undefined, NaN or Invalid Date', async () => {
  const page = await renderPage(() => payload());
  page.expandAll(FOLDERS);
  const visible = page.text();
  for (const leak of ['undefined', 'NaN', '[object Object]', 'Invalid Date', 'null']) {
    assert.ok(
      !visible.includes(leak),
      `"${leak}" reached the reader; every unmeasured value must render as the word "unknown"`,
    );
  }
  assert.ok(visible.includes('unknown'), 'the damaged class produced no "unknown" markers at all');
});

test('a class with no usable overall counts must still show a denominator, never a bare percentage', async () => {
  const page = await renderPage(() => payload());
  page.expandAll(FOLDERS);
  const markup = page.markup();
  const damaged = markup.split('data-folder="92294-busi-305-001-002-003"')[1].split('</button>')[0];
  assert.match(damaged, /\d+ \/ \d+ stages|unknown/,
    'overall.done/total were null and the row fell back to nothing readable');
  assert.ok(!/\b0 \/ 0 stages\b/.test(markup), '"0 / 0 stages" is a denominator that means nothing');
  assert.ok(!/>\s*\d{1,3}%\s*</.test(markup), 'a bare percentage escaped into the row');
});

test('stages the pipeline will never run must not be counted against a class', async () => {
  // graph is CLI-only under the bridge orchestrator and pack2 is wired to
  // nothing. Counting either makes every class permanently incomplete for work
  // that is never going to happen.
  const page = await renderPage(() => payload());
  const markup = page.markup();
  const busi380 = markup.split('data-folder="93903-busi-380-002"')[1].split('</button>')[0];
  const segments = (busi380.match(/<i[ >]/g) || []).length;
  assert.equal(segments, 4, 'the meter should draw 4 countable stages, not all 6');
  assert.ok(busi380.includes('2/4'), 'the ratio must match the meter drawn beside it');
});

test('an empty Canvas feed must read as "none published", not as a zero score', async () => {
  // calendar_events.json is [] for all six real classes because Canvas returns
  // no course events. That is a correct empty, not a failed index.
  const page = await renderPage(() => payload());
  page.expandAll(FOLDERS);
  assert.ok(page.markup().includes('none published'),
    'a 0 count for calendarEvents was drawn the same as a failed index');
});

test('a cold install must not claim Canvas published nothing, because nothing was ever read', async () => {
  // The mirror of the test above, and the reason it now keys on state rather
  // than on the category name: "none published" is a claim about what CANVAS
  // did. In a cold install calendar_events.json has never been read, so the
  // only honest answer is "unknown".
  const p = payload();
  p.classes[0].categories = [
    { key: 'calendarEvents', count: null, state: 'not-indexed', updatedAt: null },
  ];
  const page = await renderPage(() => p);
  page.expandAll(FOLDERS);
  const row = page.markup();
  assert.ok(!row.includes('none published'),
    'a category that was never read must not assert what Canvas published');
});

test('a zero inside byCategory must be printed, because reading:0 is the finding', async () => {
  const page = await renderPage(() => payload());
  page.expandAll(FOLDERS);
  assert.ok(page.markup().includes('reading <b>0</b>'),
    'dropping zero-valued categories hides exactly what makes the worklist legible');
});

test('a state or category the page has never heard of must be shown verbatim, not swallowed', async () => {
  const page = await renderPage(() => payload());
  page.expandAll(FOLDERS);
  const markup = page.markup();
  assert.ok(markup.includes('a-state-from-the-future'), 'an unrecognised stage state vanished');
  assert.ok(markup.includes('brand-new-category'), 'an unrecognised category vanished');
});

test('the topline must name what is running, as a verb and a course code', async () => {
  // This replaced a "Local model" card that printed the backend, the MLX model
  // id, resident RAM, two pids, the lock holder and a paragraph explaining what
  // a lock can and cannot prove. What a reader actually needs from it is which
  // stage is running and on which class, so that is what is asserted now.
  const page = await renderPage(() => payload());
  const tile = page.nodes.topline.innerHTML;
  assert.ok(tile.includes('INDEXING'), 'the headline must say the pipeline is working');
  assert.ok(tile.includes('MINING'), 'the running stage must be named as what it does');
  // "BUSI380", not "BUSI 380 002". The fixture carries no `shortCode` on
  // purpose — that is what a bridge process older than the field answers with —
  // so this also pins the client-side fallback. What matters is that the class
  // is named by its course code and that the registrar's section list does not
  // ride along; the space was never the point.
  assert.ok(tile.includes('BUSI380'), 'the class must be named by course code, not by folder');
  assert.ok(!tile.includes('BUSI 380 002'), 'the full registrar code was not compacted');
  assert.ok(!tile.includes('93903-busi-380-002'), 'a folder name leaked into the topline');
  assert.ok(!/mlx|Qwen|backend|pid\b|GB/i.test(tile), 'model or process plumbing leaked back in');
});

test('a class row must name the class in the width the column actually has', async () => {
  // The row is a grid whose code column is a fixed 9ch, and .cls-code is
  // nowrap. When the payload carries the registrar's full code — which is what
  // a bridge process older than `shortCode` sends — "BUSI 396 001/002/003/004"
  // is 24 characters of ink in a 9-character box, and with overflow visible it
  // painted straight across the progress meter beside it. Both halves of the
  // fix are pinned here: compact the code, and never trust that it fits.
  const p = payload();
  p.classes[0].code = 'BUSI 396 001/002/003/004';
  delete p.classes[0].shortCode;
  // A Canvas shell name is not a course code and must survive untouched —
  // closing it up would invent "PowerofPersuasion".
  p.classes[1].code = 'Power of Persuasion';
  const page = await renderPage(() => p);
  const html = page.nodes.classes.innerHTML;
  assert.ok(html.includes('BUSI396'), 'the course code was not compacted to fit its column');
  assert.ok(!html.includes('001/002/003/004'), 'the section list rode along into a 9ch column');
  assert.ok(html.includes('Power of Persuasion'), 'a shell name was mangled into a fake course code');
});

test('shortCode from the endpoint wins over anything the page would derive', async () => {
  // The fallback is for old bridges only. When the endpoint has done the work,
  // its answer is the one that ships — scripts/cal-names.js knows things about
  // course codes this page deliberately does not.
  const p = payload();
  p.classes[0].code = 'BUSI 380 002';
  p.classes[0].shortCode = 'MKTG380';
  const page = await renderPage(() => p);
  assert.ok(page.nodes.classes.innerHTML.includes('MKTG380'),
    'the page re-derived a code the endpoint had already given it');
});

test('an idle lock must read as idle, with no claim that work is happening', async () => {
  const idle = payload();
  idle.pipeline = { running: false, activeCount: 0, queuedCount: 0, maxConcurrent: 3 };
  idle.model.lock = { held: false, alive: false, pid: null, heldForMs: null };
  idle.model.waiting = [];
  idle.jobs = [];
  const page = await renderPage(() => idle);
  const tile = page.nodes.topline.innerHTML;
  assert.ok(tile.includes('IDLE'), 'an idle pipeline must say so');
  assert.ok(!tile.includes('INDEXING'), 'the page claimed work over an idle machine');
  // The pulse only animates while something actually runs.
  assert.ok(!page.nodes.pulse.className.includes('live'),
    'the live indicator animated over an idle machine');
});

test('an unreported pipeline must read as unknown rather than as idle', async () => {
  // The invariant this has always guarded: a state we could not read must never
  // be drawn as a state we did read. It used to be asked of the model lock;
  // with that card gone, the pipeline is the thing that can come back unknown.
  const murky = payload();
  murky.pipeline = { running: undefined, activeCount: null, queuedCount: null };
  murky.jobs = [];              // no evidence either way is what "unknown" means
  const page = await renderPage(() => murky);
  const tile = page.nodes.topline.innerHTML;
  assert.ok(tile.includes('UNKNOWN'), 'an unreadable pipeline state was not said to be unknown');
  assert.ok(!tile.includes('IDLE'), 'unknown was drawn as idle');
});

test('a failed fetch must leave an error banner, never a blank page', async () => {
  for (const [status, expected] of [[401, /rejected this page/i], [404, /not mounted/i], [500, /Could not reach the bridge/i]]) {
    const page = await renderPage(() => ({ status }));
    const banner = page.nodes.banner.innerHTML;
    assert.ok(banner.length > 0, `${status} produced an empty banner`);
    assert.equal(page.nodes.banner.hidden, false, `${status} left the banner hidden`);
    assert.match(banner.replace(/<[^>]*>/g, ' '), expected);
  }
});

test('the 401 banner must explain the secret without ever containing one', async () => {
  const page = await renderPage(() => ({ status: 401 }));
  const banner = page.nodes.banner.innerHTML;
  assert.match(banner, /64 hex characters/, 'the shape check that turns a dead end into an answerable error');
  assert.ok(!/[0-9a-f]{32,}/i.test(banner), 'a long hex string appeared in the auth banner');
});

test('the rendered markup must be balanced, or a later poll shreds the layout', async () => {
  const page = await renderPage(() => payload());
  page.expandAll(FOLDERS);
  const VOID = new Set(['br', 'hr', 'img', 'input']);
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(page.markup()))) {
    const [, closing, rawName, , selfClose] = m;
    const name = rawName.toLowerCase();
    if (VOID.has(name) || selfClose === '/') continue;
    if (!closing) stack.push(name);
    else assert.equal(stack.pop(), name, `</${name}> closed the wrong element`);
  }
  assert.equal(stack.length, 0, `unclosed elements: ${stack.join(', ')}`);
});

test('progress.html must stay self-contained so a font CDN or an app.js rewrite cannot break it', async () => {
  const html = await fs.readFile(PAGE, 'utf8');
  const body = html.replace(/<!--[\s\S]*?-->/g, '');   // prose in comments is not a tag
  assert.ok(!/<link\b/i.test(body), 'a <link> would couple the page to style.css or a font CDN');
  assert.ok(!/<script[^>]+\bsrc\b/i.test(body), 'a <script src> would couple the page to app.js');
  // Quoted inline data: URIs are elided first: the embedded SVG grain
  // necessarily carries the xmlns identifier "http://www.w3.org/2000/svg"
  // (an XML name, not a fetch) and a nested url(%23…) fragment reference.
  // The elision runs to the matching quote so the whole URI goes at once;
  // everything OUTSIDE a data: URI keeps the tripwire at full strength.
  const scanned = body.replace(/url\((["'])data:.*?\1\)/gi, 'url(DATA_ELIDED)');
  assert.ok(!/https?:\/\//i.test(scanned), 'no absolute URL may appear; a status page must not need the network');
  // url() is allowed ONLY for an inline data: URI — the paper-grain texture
  // is embedded in the file, which pulls in nothing. Any other url() is a
  // reference to somewhere else, which is exactly what this test forbids.
  assert.ok(!/@import/i.test(body), 'no CSS may be pulled in from elsewhere');
  assert.ok(!/url\(\s*(?!DATA_ELIDED\))/i.test(scanned), 'url() may only carry an inline data: URI');
});
