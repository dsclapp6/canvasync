// ingest-retry.test.js — the course-file ingest POST, and why a busy bridge
// must not cost a downloaded file.
//
// The failure: extract-course-files finalizes a class while a sync is running,
// so writeCourseFile's 2s cross-process deadline expires and the bridge
// refuses the write. The file was ALREADY downloaded, but the call at
// background.js's per-file loop was the one ingest call not wrapped in
// _withRetry — the only one of the four bridge POSTs without it — so the error
// fell to the loop's catch, the file was counted `errored`, left out of
// files_index.json until a later sync happened to re-diff it, and the whole
// files_download item ended the sync flagged red. A single retry 100ms later
// would have landed.
//
// SCOPE, stated plainly, in the same terms as sync-support.test.js: background.js
// cannot be imported here — it registers chrome.runtime/alarms/action listeners
// at module scope and throws under node before any assertion runs. So the wrap
// itself is pinned STRUCTURALLY against the source, and everything the wrap
// depends on to be worth having — that the bridge's 503 arrives as a retryable
// error rather than a fatal one — is pinned behaviourally against the real
// classes. What is NOT covered headlessly: the loop actually re-entering
// ingestCourseFile after a delay, which needs a loaded extension.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeIsTransient } from '../sync-support.js';

// fileURLToPath, never import.meta.url's pathname: a repo path containing a
// space arrives percent-encoded and every path built from it silently misses.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const readBackground = () => fs.readFile(path.join(HERE, '..', 'background.js'), 'utf8');

test('the course-file ingest POST is wrapped in _withRetry', async () => {
  const src = await readBackground();
  assert.ok(src.includes('await _withRetry(() => ingestCourseFile({'),
    'the course-file ingest must go through _withRetry — a lock timeout on the '
    + 'bridge otherwise throws away a file that is already downloaded');
  assert.ok(!/await ingestCourseFile\(\{/.test(src),
    'an unwrapped ingestCourseFile call is back: this is the exact shape the '
    + 'fix removed');
});

test('every bridge write in the sync loop is retried, so the count in the precondition comment is honest', async () => {
  const src = await readBackground();
  // The comment above _withRetry is load-bearing documentation — it is where
  // the idempotency precondition lives — and a stale count is how it stops
  // being read. Four POSTs now: publishScope, /ingest/course,
  // /ingest/course-file, /ingest/complete.
  const posts = ['publishScope', '/ingest/course', '/ingest/course-file', '/ingest/complete'];
  for (const name of posts) {
    assert.ok(src.includes(name), `${name} vanished from background.js`);
  }
  assert.ok(src.includes('Four of its six call'),
    'the precondition comment still claims a different number of retried call sites');
});

// --- What the wrap buys, against the real error classes ---------------------

test('the bridge\'s busy answer reaches the extension as a retryable error', async () => {
  const { ingestCourseFile, BridgeServerError, ConfigError }
    = await import('../bridge-client.js');
  // The real Canvas-side classes, not stand-ins: the predicate is an
  // instanceof sweep, so substituting Error for ServerError would make every
  // error transient and the boundary assertion below would prove nothing.
  const { NetworkError, ServerError, HttpError } = await import('../canvas-client.js');

  const priorChrome = globalThis.chrome;
  const priorFetch = globalThis.fetch;
  globalThis.chrome = {
    storage: { local: { get: (key, cb) => cb({ bridgeSecret: 'test-secret' }) } },
    runtime: {},
  };
  // Exactly what the hardened route now answers for a held files-index lock.
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ error: 'files index is busy, retry' }),
  });

  try {
    await assert.rejects(
      ingestCourseFile({ courseId: 1, fileId: 2, dataBase64: 'eA==' }),
      err => err instanceof BridgeServerError && err.status === 503,
      'a 503 must arrive typed, not as a plain Error');

    // And typed is only useful if the predicate the retry consults agrees.
    const isTransient = makeIsTransient({ NetworkError, ServerError, BridgeServerError });
    assert.equal(isTransient(new BridgeServerError(503, 'files index is busy, retry')), true);
    // The boundaries the same predicate must keep, or the wrap buys three
    // attempts at answers that will never change: a re-pair is permanent (the
    // user has to open the popup), and a 404 does not improve on the third ask.
    assert.equal(isTransient(new ConfigError('re-pair')), false);
    assert.equal(isTransient(new HttpError(404, 'gone')), false);
  } finally {
    if (priorChrome === undefined) delete globalThis.chrome; else globalThis.chrome = priorChrome;
    if (priorFetch === undefined) delete globalThis.fetch; else globalThis.fetch = priorFetch;
  }
});
