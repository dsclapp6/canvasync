// ingest-limit.test.js — the extension sizing its download gate from the
// BRIDGE's limit instead of a constant of its own.
//
// The desync: extension/background.js hardcoded BRIDGE_BODY_LIMIT_MB = 200 and
// gated downloads at ~145 MB, while the bridge enforced config.maxIngestMb.
// Lower that config and every file between the two figures downloaded in full,
// posted, and took a 413 — each sync, forever, and the file never landed. The
// bridge now sends maxIngestMb on the handshake response and on every /health
// probe; this pins that the extension actually stores it.
//
// SCOPE: background.js cannot be imported here (module-scope chrome.runtime /
// alarms / action listeners), the same limit sync-support.test.js states — so
// the STORE side is tested behaviourally through bridge-client.js, and
// background.js's use of the stored value is pinned structurally. Not covered
// headlessly: a real download loop reading the gate, which needs a loaded
// extension and a bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readBackground = () => fs.readFile(path.join(HERE, '..', 'background.js'), 'utf8');

function withFakeChrome(store, fetchImpl, run) {
  const priorChrome = globalThis.chrome;
  const priorFetch = globalThis.fetch;
  globalThis.chrome = {
    runtime: { id: 'ext-under-test' },
    storage: { local: {
      get: (keys, cb) => cb(Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map(k => [k, store[k]]))),
      set: (obj, cb) => { Object.assign(store, obj); cb(); },
    } },
  };
  globalThis.fetch = fetchImpl;
  return (async () => run())().finally(() => {
    if (priorChrome === undefined) delete globalThis.chrome; else globalThis.chrome = priorChrome;
    if (priorFetch === undefined) delete globalThis.fetch; else globalThis.fetch = priorFetch;
  });
}

const jsonResponse = (payload, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
  headers: { get: () => 'application/json' },
});

// --- Storing what the bridge said -------------------------------------------

test('the handshake response is where the limit first arrives', async () => {
  const { handshake } = await import('../bridge-client.js');
  const store = {};
  await withFakeChrome(store, async () => jsonResponse({ secret: 's3cret', maxIngestMb: 400 }),
    async () => {
      const secret = await handshake('install-token');
      assert.equal(secret, 's3cret');
    });
  assert.equal(store.bridgeMaxIngestMb, 400);
  assert.equal(store.bridgeSecret, 's3cret', 'the secret must still be stored');
});

test('every health probe refreshes it, so changing the config needs no re-pair', async () => {
  const { bridgeHealth } = await import('../bridge-client.js');
  const store = { bridgeSecret: 's3cret', bridgeMaxIngestMb: 400 };
  const reachable = await withFakeChrome(store,
    async () => jsonResponse({ ok: true, version: '1.8.21', maxIngestMb: 64 }),
    () => bridgeHealth());
  assert.equal(reachable, true);
  assert.equal(store.bridgeMaxIngestMb, 64, 'a lowered limit must reach the extension');
});

test('an old bridge that sends no limit leaves the stored one alone', async () => {
  const { bridgeHealth } = await import('../bridge-client.js');
  const store = { bridgeSecret: 's3cret', bridgeMaxIngestMb: 400 };
  await withFakeChrome(store, async () => jsonResponse({ ok: true, version: '1.7.0' }),
    () => bridgeHealth());
  assert.equal(store.bridgeMaxIngestMb, 400);
});

test('a nonsense limit is ignored rather than believed', async () => {
  const { bridgeHealth } = await import('../bridge-client.js');
  for (const bad of [0, -5, 'plenty', null]) {
    const store = { bridgeSecret: 's3cret', bridgeMaxIngestMb: 400 };
    await withFakeChrome(store, async () => jsonResponse({ ok: true, maxIngestMb: bad }),
      () => bridgeHealth());
    assert.equal(store.bridgeMaxIngestMb, 400,
      `${JSON.stringify(bad)} must not become the download gate`);
  }
});

// --- background.js's use of it, and the cap that is gone ---------------------

test('the download gate is sized from the stored limit, not a constant', async () => {
  const src = await readBackground();
  assert.ok(src.includes('await _ingestLimit()'),
    'the download loop must resolve the bridge-advertised limit');
  assert.ok(!/MAX_INGEST_BYTES/.test(src),
    'the old module-level constant is back — it is the desync');
  assert.ok(src.includes('BRIDGE_BODY_LIMIT_MB_FALLBACK = 200'),
    'the fallback for a bridge too old to advertise a limit must stay');
  assert.ok(src.includes('size > maxIngestBytes') && src.includes('actualBytes > maxIngestBytes'),
    'BOTH gates — the declared-size pre-flight and the measured post-fetch one — '
    + 'must use the plumbed limit');
});

test('embedded file discovery is no longer capped, and its misses are said out loud', async () => {
  const src = await readBackground();
  // The EXPRESSION, not the whole file: the comment above it records the cap
  // by name, and a test that greps the file for "slice(0, 60)" fails on its
  // own history note. Read from the declaration to the loop that consumes it.
  const discovery = src.slice(src.indexOf('const embeddedIds'), src.indexOf('const embeddedFiles'));
  assert.ok(discovery.length > 0 && discovery.length < 400, 'the discovery expression moved');
  assert.ok(!/\.slice\(/.test(discovery),
    'embedded discovery truncates again — a reading-heavy course silently '
    + 'loses everything past the cap');
  // The cap is only half the defect: dropping ids without a word is what made
  // a truncated sync look complete.
  const loop = src.slice(src.indexOf('const embeddedIds'), src.indexOf('const coursePacks'));
  assert.ok(loop.includes('unresolved.push(fid)'),
    'an unreadable embedded id must be counted, not swallowed');
  assert.ok(/_log\('warn'/.test(loop),
    'the count must reach the sync log — it is the only surface these ids have');
});
