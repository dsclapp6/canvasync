// canvas-client.test.js — item 8: the rate-limit retry must read the retried
// response the same way it read the first one.
//
// canvas-client.js touches no chrome.* API, so unlike background.js it imports
// cleanly here; only global fetch needs standing in for. The 60-second wait
// between the 403 and the retry is driven with node's mock timers rather than
// waited out, so the whole file still runs in milliseconds.
//
// The token bucket is deliberately left alone: a freshly imported module starts
// with a full bucket, and no test here spends more than a few tokens, so
// _acquireToken never reaches its own sleep.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canvasFetch,
  fetchBinary,
  throwForStatus,
  AuthError,
  ServerError,
  RateLimitError,
  PermissionError,
  NetworkError,
  HttpError,
} from '../canvas-client.js';
import { BridgeServerError, ConfigError } from '../bridge-client.js';
import { makeIsTransient } from '../sync-support.js';

// A stand-in for the parts of Response this module reads.
function fakeResponse(status, body = '', headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    clone: () => fakeResponse(status, body, headers),
    text: async () => body,
    json: async () => JSON.parse(body || '{}'),
    headers: { get: (k) => headers[k] ?? null },
  };
}

const RATE_LIMIT_BODY = '403 Forbidden (Rate Limit Exceeded)';

/**
 * Drive one canvasFetch through the rate-limit retry without waiting 60s.
 * Returns a promise for the call's outcome; the 60s sleep is ticked past once
 * the code has actually reached it.
 */
async function withRetryClock(t, responses) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };

  const settled = canvasFetch('/api/v1/courses').then(
    value => ({ value }), error => ({ error }));

  // Let the 403 body read (a microtask chain) finish, then jump the wait.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(60_000);

  const outcome = await settled;
  return { ...outcome, seen };
}

test.afterEach(() => { delete globalThis.fetch; });

// --- throwForStatus, on its own ---------------------------------------------

test('throwForStatus types 401 and 5xx, and passes everything else through', () => {
  assert.throws(() => throwForStatus({ status: 401 }, 'u'), AuthError);
  assert.throws(() => throwForStatus({ status: 500 }, 'u'), ServerError);
  assert.throws(() => throwForStatus({ status: 503 }, 'u'), ServerError);
  // Not this function's business — the caller decides what these mean.
  assert.doesNotThrow(() => throwForStatus({ status: 200 }, 'u'));
  assert.doesNotThrow(() => throwForStatus({ status: 403 }, 'u'));
  assert.doesNotThrow(() => throwForStatus({ status: 404 }, 'u'));
});

test('the ServerError from throwForStatus carries the status', () => {
  try {
    throwForStatus({ status: 502 }, 'u');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ServerError);
    assert.equal(err.status, 502);
  }
});

// --- The retry path, end to end ---------------------------------------------

test('a 5xx on the RETRY becomes ServerError, not a body to parse', async (t) => {
  // The bug: this used to fall through `retry.status === 403`, be returned as a
  // Response, and blow up in paginate()'s .json() as a parse error — which also
  // hid it from _withRetry, the one thing that would have retried a 5xx.
  const { error, seen } = await withRetryClock(t, [
    fakeResponse(403, RATE_LIMIT_BODY),
    fakeResponse(500),
  ]);
  assert.ok(error instanceof ServerError, `expected ServerError, got ${error}`);
  assert.equal(error.status, 500);
  assert.equal(seen.length, 2, 'one original request, one retry');
});

test('a 401 on the RETRY becomes AuthError', async (t) => {
  const { error } = await withRetryClock(t, [
    fakeResponse(403, RATE_LIMIT_BODY),
    fakeResponse(401),
  ]);
  assert.ok(error instanceof AuthError, `expected AuthError, got ${error}`);
});

test('a 403 on the RETRY is still RateLimitError', async (t) => {
  const { error } = await withRetryClock(t, [
    fakeResponse(403, RATE_LIMIT_BODY),
    fakeResponse(403, RATE_LIMIT_BODY),
  ]);
  assert.ok(error instanceof RateLimitError, `expected RateLimitError, got ${error}`);
});

test('a successful retry is returned, unchanged', async (t) => {
  const { value, error } = await withRetryClock(t, [
    fakeResponse(403, RATE_LIMIT_BODY),
    fakeResponse(200, '[{"id":1}]'),
  ]);
  assert.equal(error, undefined, `unexpected error: ${error}`);
  assert.equal(value.status, 200);
  assert.deepEqual(await value.json(), [{ id: 1 }]);
});

// --- Untouched behaviour, guarded ------------------------------------------

test('a non-rate-limit 403 is still PermissionError and is not retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return fakeResponse(403, 'you may not'); };
  await assert.rejects(() => canvasFetch('/api/v1/courses/1/files'), PermissionError);
  assert.equal(calls, 1, 'a permission 403 must not trigger the 60s retry');
});

test('a first-response 401 is still AuthError', async () => {
  globalThis.fetch = async () => fakeResponse(401);
  await assert.rejects(() => canvasFetch('/api/v1/courses'), AuthError);
});

test('a first-response 5xx is still ServerError', async () => {
  globalThis.fetch = async () => fakeResponse(503);
  await assert.rejects(() => canvasFetch('/api/v1/courses'), ServerError);
});

test('a 200 is returned untouched', async () => {
  globalThis.fetch = async () => fakeResponse(200, '{"ok":true}');
  const res = await canvasFetch('/api/v1/courses');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

// ===========================================================================
// Slice 3 — item 6: transport failure vs a response that arrived.
// ===========================================================================

function binaryResponse(status, { body = '', bytes = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/pdf' },
    clone: () => binaryResponse(status, { body, bytes }),
    text: async () => body,
    arrayBuffer: async () => (bytes ?? new Uint8Array([1, 2, 3])).buffer,
  };
}

test('a 404 from fetchBinary is HttpError carrying the status, not NetworkError', async () => {
  // The regression guard. Before item 6 this threw NetworkError, which put "the
  // file is not there" and "the request never left the machine" behind one type
  // — and made a 404 retryable the moment transport failures became retryable.
  globalThis.fetch = async () => binaryResponse(404);
  await assert.rejects(() => fetchBinary('https://signed/gone'), (err) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${err?.name}`);
    assert.ok(!(err instanceof NetworkError),
      'HttpError must NOT be a NetworkError, or the top-level branch keeps catching it');
    assert.equal(err.status, 404);
    assert.equal(err.url, 'https://signed/gone');
    return true;
  });
});

test('a rejected fetch is still NetworkError — the request never completed', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => fetchBinary('https://signed/x'), NetworkError);
  await assert.rejects(() => canvasFetch('/api/v1/courses'), NetworkError);
});

test('fetchBinary keeps its existing types for 401, 403 and 5xx', async () => {
  globalThis.fetch = async () => binaryResponse(401);
  await assert.rejects(() => fetchBinary('https://signed/x'), AuthError);
  globalThis.fetch = async () => binaryResponse(403);
  await assert.rejects(() => fetchBinary('https://signed/x'), PermissionError);
  globalThis.fetch = async () => binaryResponse(500);
  await assert.rejects(() => fetchBinary('https://signed/x'), ServerError);
});

test('a 200 from fetchBinary still returns bytes', async () => {
  globalThis.fetch = async () => binaryResponse(200, { bytes: new Uint8Array([104, 105]) });
  const out = await fetchBinary('https://signed/ok');
  assert.equal(out.contentType, 'application/pdf');
  assert.equal(Buffer.from(out.base64, 'base64').toString(), 'hi');
});

// --- The retry boundary, enumerated against the REAL error classes ----------

const isTransient = makeIsTransient({ NetworkError, ServerError, BridgeServerError });

test('every error type sits on the side of the retry boundary it belongs on', () => {
  const retryable = [
    ['NetworkError',      new NetworkError('socket reset')],
    ['ServerError',       new ServerError(503)],
    ['BridgeServerError', new BridgeServerError(500, 'write failed')],
  ];
  const notRetryable = [
    ['HttpError 404',   new HttpError(404, 'https://signed/gone')],
    ['HttpError 400',   new HttpError(400, 'https://x')],
    ['AuthError',       new AuthError()],
    ['PermissionError', new PermissionError('https://x')],
    ['RateLimitError',  new RateLimitError()],
    ['ConfigError',     new ConfigError('not paired')],
    ['plain Error',     new Error('something else')],
  ];

  for (const [name, err] of retryable) {
    assert.equal(isTransient(err), true, `${name} should be retried`);
  }
  for (const [name, err] of notRetryable) {
    assert.equal(isTransient(err), false, `${name} must NOT be retried`);
  }
});

test('a 404 is not retried — the failure mode of widening this predicate', () => {
  // "Just retry HttpError too" costs three attempts at a URL that will never
  // exist, per file, per sync.
  assert.equal(isTransient(new HttpError(404, 'https://signed/gone')), false);
});

test('isTransient is safe on null and undefined', () => {
  assert.equal(isTransient(null), false);
  assert.equal(isTransient(undefined), false);
});

test('a deliberate-abort NetworkError is retryable BY TYPE — the abort is kept out of _withRetry by placement, not by type', () => {
  // background.js:621 throws NetworkError to abort a sync when the untracked
  // list cannot be read, so deleted classes are not resurrected. It is NOT
  // wrapped in _withRetry, and that is the only thing stopping it from being
  // retried now that NetworkError is transient. Pinned here so that if anyone
  // ever wraps that region, this comment is findable.
  assert.equal(isTransient(new NetworkError('Cannot read untracked-class list')), true);
});
