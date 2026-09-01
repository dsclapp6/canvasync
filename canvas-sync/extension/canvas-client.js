// canvas-client.js — ES module; all Canvas API access goes through here.
// No DOM access, no cookie reads; credentials piggyback on the browser session.

export const CANVAS_BASE = 'https://canvas.rice.edu';

// --- Typed errors ----------------------------------------------------------------

export class AuthError extends Error {
  constructor(msg = 'Canvas session expired or unauthorized', url = null) {
    super(url ? `${msg} (${url})` : msg);
    this.name = 'AuthError';
    this.url  = url;
  }
}

export class RateLimitError extends Error {
  constructor(msg = 'Canvas rate limit exceeded') {
    super(msg);
    this.name = 'RateLimitError';
  }
}

export class NetworkError extends Error {
  constructor(msg = 'Network request failed') {
    super(msg);
    this.name = 'NetworkError';
  }
}

export class ServerError extends Error {
  constructor(status, msg = `Canvas server error (${status})`) {
    super(msg);
    this.name = 'ServerError';
    this.status = status;
  }
}

/**
 * A response arrived and was not usable, and it is none of the statuses above.
 *
 * fetchBinary types 401, 403 and 5xx before reaching its catch-all, so this
 * carries what is left: 404, 400, 405, 409, 410, 429, and 3xx that fetch did
 * not follow. It exists because those used to be thrown as NetworkError, which
 * put "this file is not there" and "the request never left the machine" behind
 * one type — and a retry policy cannot tell them apart from one type. A 404 is
 * never worth a second attempt; a dropped packet almost always is.
 */
export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export class PermissionError extends Error {
  constructor(url) {
    super(`Permission denied (${url})`);
    this.name = 'PermissionError';
    this.url = url;
  }
}

// --- Token-bucket rate limiter ---------------------------------------------------
// OPEN: These defaults were chosen conservatively; Canvas docs cite 403s above ~90 req/min.
// Adjust TOKEN_BUCKET_CAPACITY and REFILL_PER_MS after observing real-world behaviour.

const TOKEN_BUCKET_CAPACITY = 20;          // burst ceiling
const REFILL_RATE_PER_MIN   = 70;          // sustained requests per 60 s
const REFILL_PER_MS         = REFILL_RATE_PER_MIN / 60_000;

let _tokens     = TOKEN_BUCKET_CAPACITY;
let _lastRefill = Date.now();

function _refill() {
  const now  = Date.now();
  const dt   = now - _lastRefill;
  _tokens    = Math.min(TOKEN_BUCKET_CAPACITY, _tokens + dt * REFILL_PER_MS);
  _lastRefill = now;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function _acquireToken() {
  // Loop until a token is actually owned. Waking from the sleep is NOT
  // ownership: every waiter on an empty bucket computes the same msNeeded and
  // wakes together, so whoever runs first takes the one accrued token and the
  // rest must re-check and sleep again — otherwise N waiters all proceed on
  // one token (the old Math.max clamp absorbed the deficit silently) and the
  // limiter degrades to a fixed delay per request regardless of queue depth.
  for (;;) {
    _refill();
    if (_tokens >= 1) {
      _tokens -= 1;
      return;
    }
    const msNeeded = Math.ceil((1 - _tokens) / REFILL_PER_MS);
    await _sleep(msNeeded);
  }
}

// --- Core fetch wrapper ----------------------------------------------------------

/**
 * Throw the typed error a status deserves, or return for the caller to carry on.
 *
 * Exported for tests, and factored out because the rate-limit retry below used
 * to test `retry.status === 403` and nothing else: a 500 or a 401 on the second
 * attempt was handed back as a Response, and the caller — paginate(), usually —
 * called .json() on an error body. That surfaced as a JSON parse failure rather
 * than ServerError or AuthError, which also meant _withRetry never saw a 5xx it
 * would have retried.
 */
export function throwForStatus(response, url) {
  if (response.status === 401) throw new AuthError('Canvas session expired or unauthorized', url);
  if (response.status >= 500) throw new ServerError(response.status);
}

/**
 * canvasFetch(path, init?)
 * path — relative to CANVAS_BASE, e.g. '/api/v1/courses'
 * Returns the raw Response (caller checks status).
 */
export async function canvasGetJson(path, init = {}) {
  const response = await canvasFetch(path, init);
  return response.json();
}

export async function canvasFetch(path, init = {}) {
  await _acquireToken();

  const url     = path.startsWith('http') ? path : `${CANVAS_BASE}${path}`;
  const headers = {
    'Accept': 'application/json+canvas-string-ids',
    ...(init.headers ?? {}),
  };

  let response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: 'include',
      headers,
    });
  } catch (err) {
    throw new NetworkError(`fetch failed: ${err.message}`);
  }

  if (response.status === 401) throw new AuthError('Canvas session expired or unauthorized', url);

  if (response.status === 403) {
    // Clone so .text() doesn't consume the stream the caller will want to .json().
    const body = await response.clone().text();
    if (body.includes('Rate Limit Exceeded')) {
      // One retry after 60 s
      await _sleep(60_000);
      await _acquireToken();
      let retry;
      try {
        retry = await fetch(url, { ...init, credentials: 'include', headers });
      } catch (err) {
        throw new NetworkError(`fetch (retry) failed: ${err.message}`);
      }
      // The retry gets the SAME reading as the first attempt. A 403 here means
      // the rate limit is still in force; a 401 or 5xx is its own failure and
      // must be typed as one rather than returned as a body to parse.
      throwForStatus(retry, url);
      if (retry.status === 403) throw new RateLimitError();
      if (!retry.ok) throw new HttpError(retry.status, url);
      return retry;
    }
    // Non-rate-limit 403 = student doesn't have permission for this resource
    // (e.g. /api/v1/courses/:id/files is often hidden from students). Throw so
    // callers can selectively skip instead of trying to .json() an error body.
    throw new PermissionError(url);
  }

  if (response.status >= 500) throw new ServerError(response.status);

  // EVERY REMAINING NON-2xx IS AN ERROR, and is typed as one here.
  //
  // This function used to hand 400, 404, 405, 409 and 429 back to the caller
  // as an ordinary response. `paginate` then called `.json()` on the error
  // body, found it was not an array, and yielded it as data — so a rate-limited
  // page mid-listing became a row in the resource, and a disabled tab became
  // `pages.json = [{"message":"That page has been disabled for this course"}]`
  // in five of six classes. Neither failed; both produced a sync that reported
  // success over a hole.
  //
  // Deciding this by STATUS rather than by the shape of the body is the whole
  // point: `{"errors":[…]}` is what Canvas says for a rate limit AND for an
  // authorization refusal, so no amount of reading the body can separate
  // "come back later" from "this is closed to you". The status can.
  //
  // What is TOLERABLE is not decided here. This types the failure; the caller
  // owns the policy — background.js's fetchResource tolerates a 404 listing as
  // a closed resource (omit the key, keep the last known-good file) and lets
  // every other HttpError fail the resource loudly.
  if (!response.ok) throw new HttpError(response.status, url);

  return response;
}

// --- Link-header pagination ------------------------------------------------------

function _nextLink(linkHeader) {
  if (!linkHeader) return null;
  // Header looks like: <url>; rel="next", <url>; rel="last"
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * paginate(url, init?)
 * Async generator that yields parsed JSON arrays from each page.
 * Follows Link rel="next" until absent.
 */
export async function* paginate(url, init = {}) {
  let next = url.startsWith('http') ? url : `${CANVAS_BASE}${url}`;
  while (next) {
    const response = await canvasFetch(next, init);
    const data     = await response.json();
    if (Array.isArray(data)) {
      yield data;
    } else {
      // Unexpected shape — yield as-is and stop
      yield data;
      break;
    }
    next = _nextLink(response.headers.get('Link'));
  }
}

// --- Binary fetcher --------------------------------------------------------------

/**
 * fetchBinary(url)
 * For signed file download URLs (Canvas Files API).
 * Returns { contentType: string, base64: string }.
 *
 * Signed URLs expire, and an expired one 403s exactly like a file the student
 * may not read. This function cannot tell them apart on its own, so it does not
 * try: it throws PermissionError either way, and the caller decides. See
 * fetchFileWithFreshUrl in sync-support.js, which asks Canvas for a fresh URL
 * once before believing the first answer.
 */
export async function fetchBinary(url) {
  await _acquireToken();

  let response;
  try {
    // Signed URLs carry auth in query params; no credentials header needed,
    // but include anyway in case the server checks.
    response = await fetch(url, { credentials: 'include' });
  } catch (err) {
    throw new NetworkError(`fetchBinary failed: ${err.message}`);
  }

  if (response.status === 401) throw new AuthError('Canvas session expired or unauthorized', url);
  if (response.status === 403) throw new PermissionError(url);
  if (response.status >= 500) throw new ServerError(response.status);
  // Any other non-OK (404, expired signed URL, redirect to an error page):
  // without this check the error page's HTML would be base64'd and ingested
  // as the file's actual bytes.
  //
  // HttpError, not NetworkError: the response ARRIVED. Retrying a 404 is three
  // attempts at a URL that will never exist, per file, per sync — which is what
  // the old type would have bought once transport failures became retryable.
  if (!response.ok) throw new HttpError(response.status, url);

  const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
  const buffer      = await response.arrayBuffer();
  const bytes       = new Uint8Array(buffer);
  // Chunked fromCharCode: byte-at-a-time string append is quadratic-ish and
  // blocks the service-worker thread for large files (during which cancel
  // messages can't even be dispatched). 32K args stays under engine limits.
  const parts = [];
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  const base64 = btoa(parts.join(''));
  return { contentType, base64 };
}
