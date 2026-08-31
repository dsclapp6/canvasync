// discussion-view.test.js — a file posted in a discussion REPLY becoming
// discoverable at all.
//
// The defect: the embedded-file scan built its corpus from topic BODIES only,
// and the reply walk stripped HTML as it went — so a reading a professor
// attaches in a reply was invisible twice over. Never scanned (not in the
// corpus), and unrecoverable from what was stored (replies_text has already
// had the anchor carrying /files/<id> replaced by a space). The user's
// instruction was files not cut off; this was a whole surface cut off.
//
// SCOPE: collectReplyMessages and stripHtml are tested directly — that is why
// they were lifted out of background.js, which cannot be imported here (it
// registers chrome.runtime/alarms/action listeners at module scope). What is
// pinned structurally instead: that background.js feeds the RAW messages into
// the corpus, and does so before stripping them. Not covered headlessly: the
// regex scan itself (_extractFileIdsFromHtml lives in background.js) and a
// real sync against a course whose readings live in replies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectReplyMessages, stripHtml, rankTopicsForView, VIEW_TOPIC_CEILING }
  from '../discussion-view.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readBackground = () => fs.readFile(path.join(HERE, '..', 'background.js'), 'utf8');

const VIEW = {
  view: [
    { message: '<p>Week 3 thread</p>' },
    {
      message: '<p>Reading: <a href="/courses/91/files/70123/download?wrap=1">Chapter 4</a></p>',
      replies: [
        { message: '<p>Thanks!</p>' },
        {
          message: '<p>Also <a href="/files/70124">the errata</a></p>',
          replies: [{ message: '<p>deepest</p>' }],
        },
      ],
    },
  ],
};

// --- What the scan needs: the href, intact -----------------------------------

test('reply HTML comes back raw, so the file link in it can still be found', () => {
  const messages = collectReplyMessages(VIEW);
  const corpus = messages.join('\n');
  // The two ids that only ever existed inside an anchor in a reply.
  assert.match(corpus, /\/files\/70123/);
  assert.match(corpus, /\/files\/70124/);
  // And the same corpus after the strip the stored text uses: gone. This is
  // the assertion that explains why the raw pass has to exist at all.
  const stripped = messages.map(stripHtml).join('\n');
  assert.ok(!/\/files\/70123/.test(stripped) && !/\/files\/70124/.test(stripped),
    'stripping destroys the href — capturing after it can never work');
});

test('the thread order is preserved: each message before its own replies', () => {
  assert.deepEqual(collectReplyMessages(VIEW).map(stripHtml), [
    'Week 3 thread',
    'Reading: Chapter 4',
    'Thanks!',
    'Also the errata',
    'deepest',
  ]);
});

test('an entry with no message still has its replies read', () => {
  // A deleted post keeps its children. Dropping the subtree with the parent
  // would lose exactly the follow-up a reading is usually posted in.
  const messages = collectReplyMessages({
    view: [{ replies: [{ message: '<a href="/files/9">here</a>' }] }],
  });
  assert.deepEqual(messages, ['<a href="/files/9">here</a>']);
});

test('shapes Canvas can actually return do not throw', () => {
  assert.deepEqual(collectReplyMessages(undefined), []);
  assert.deepEqual(collectReplyMessages({}), []);
  assert.deepEqual(collectReplyMessages({ view: null }), []);
  // An OBJECT where an array was expected: the old inline walk did
  // `for (const e of entries || [])`, which throws on this and would have
  // abandoned the whole topic mid-walk.
  assert.deepEqual(collectReplyMessages({ view: { 0: { message: 'x' } } }), []);
  assert.deepEqual(collectReplyMessages({ view: [{ message: 'a', replies: { nope: 1 } }] }), ['a']);
});

test('the strip is the one replies_text has always used', () => {
  assert.equal(stripHtml('<p>Hello   <b>there</b></p>'), 'Hello there');
  assert.equal(stripHtml('  <div>\n  x  \n</div> '), 'x');
  assert.equal(stripHtml(''), '');
  assert.equal(stripHtml(null), '');
});

// --- background.js's wiring --------------------------------------------------

test('the raw replies reach the embedded-file corpus, and reach it unstripped', async () => {
  const src = await readBackground();
  const collected = src.indexOf('replyHtml.push(...messages)');
  const stripped = src.indexOf('messages.map(stripHtml)');
  const corpus = src.indexOf('...replyHtml,');
  assert.ok(collected > 0, 'the reply walk no longer keeps the raw messages');
  assert.ok(corpus > 0, 'the embedded-file corpus no longer includes the replies');
  assert.ok(collected < stripped,
    'the raw capture must happen BEFORE the strip, or there is no href left to keep');
  assert.ok(collected < corpus, 'the corpus reads replyHtml before it is filled');
});

// --- Which topics get opened, and what is said about the ones that do not ----

const topic = (id, { graded = false, posted = null, title = `T${id}` } = {}) =>
  ({ id, title, ...(graded ? { assignment: { id } } : {}), ...(posted ? { posted_at: posted } : {}) });

test('the ceiling is high enough never to bind on a real course', () => {
  // 20 was the old number and it bound on any weekly-thread seminar. The
  // ceiling exists to stop a pathological course, not to shape a normal one:
  // at the client's 70 requests/minute limiter, 100 topics is ~86 s of extra
  // sync in the worst case that never happens.
  assert.ok(VIEW_TOPIC_CEILING >= 100,
    'the ceiling dropped back to a number that shapes ordinary courses');
});

test('graded threads are opened first, then the newest', () => {
  const { targets } = rankTopicsForView([
    topic(1, { posted: '2026-01-01' }),
    topic(2, { graded: true, posted: '2025-09-01' }),
    topic(3, { posted: '2026-03-01' }),
    topic(4, { graded: true, posted: '2026-02-01' }),
  ]);
  assert.deepEqual(targets.map(t => t.id), [4, 2, 3, 1]);
});

test('a topic Canvas gives no posted_at sorts to the BACK of its group', () => {
  // Date.parse(0) is 2000-01-01, so the `?? 0` fallback reads as very old.
  // Preserved deliberately: it decides what a ceiling drops.
  const { targets } = rankTopicsForView([
    topic(1),
    topic(2, { posted: '2026-01-01' }),
  ]);
  assert.deepEqual(targets.map(t => t.id), [2, 1]);
});

test('everything past the ceiling is handed back, not dropped on the floor', () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    topic(i + 1, { posted: `2026-01-0${i + 1}` }));
  const { targets, skipped, total } = rankTopicsForView(many, 3);
  assert.equal(total, 7);
  assert.equal(targets.length, 3);
  assert.equal(skipped.length, 4);
  // Nothing vanishes between the two halves — the caller can only report a
  // miss it is actually handed.
  assert.deepEqual([...targets, ...skipped].map(t => t.id).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7]);
  // And the tail that gets dropped is the OLDEST, not an arbitrary slice.
  assert.deepEqual(skipped.map(t => t.id), [4, 3, 2, 1]);
});

test('the caller\'s own topic list is not reordered underneath it', () => {
  // `discussions` is sent to the bridge and scanned for embedded links after
  // this call. Sorting it in place would silently reshape the stored course.
  const original = [topic(1), topic(2, { graded: true }), topic(3)];
  const before = original.map(t => t.id);
  rankTopicsForView(original);
  assert.deepEqual(original.map(t => t.id), before);
});

test('a course with no discussions is not an error', () => {
  assert.deepEqual(rankTopicsForView(undefined), { targets: [], skipped: [], total: 0 });
  assert.deepEqual(rankTopicsForView([]), { targets: [], skipped: [], total: 0 });
});

test('a ceiling that ever bites is logged with named threads', async () => {
  const src = await readBackground();
  const at = src.indexOf('if (unopenedTopics.length)');
  assert.ok(at > 0, 'the skipped topics are no longer reported at all');
  const block = src.slice(at, at + 900);
  assert.ok(/_log\('warn'/.test(block), 'the remainder must reach the sync log');
  assert.ok(block.includes('t?.title'),
    'name the threads — an id the user cannot look up is not a paper trail');
  assert.ok(block.includes('VIEW_TOPIC_CEILING'),
    'say which ceiling bit, so the number can be argued with');
});
