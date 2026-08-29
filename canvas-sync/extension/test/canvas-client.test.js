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
  throwForStatus,
  AuthError,
  ServerError,
  RateLimitError,
  PermissionError,
} from '../canvas-client.js';

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
