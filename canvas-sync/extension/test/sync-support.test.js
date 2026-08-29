// sync-support.test.js — the three slice-1 fixes, each tested against the
// failure it was written for rather than against its own implementation.
//
// Scope, stated plainly: this covers sync-support.js only. background.js cannot
// be imported here — it is a service worker that registers chrome.runtime,
// chrome.alarms and chrome.action listeners at module scope, so importing it
// under node throws before any assertion runs. That is why the logic under test
// was lifted out with its dependencies as arguments. What is NOT covered
// headlessly, and would need a loaded extension to check:
//   - that chrome.storage.local really is the store the appender serialises;
//   - that Canvas really returns 403 for an expired signed URL (the ambiguity
//     this code is built on is documented behaviour, not something node can
//     demonstrate);
//   - the popup and history DOM rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeSerialAppender,
  emptyFileCounts,
  addFileCounts,
  rollUpFileCounts,
  formatFileCounts,
  fetchFileWithFreshUrl,
} from '../sync-support.js';

// --- A store that behaves like chrome.storage: async, and with no transaction.
// The delays are what make the race reproducible — a synchronous fake would
// pass against the buggy implementation too, which would make the test a
// decoration rather than a check.
function makeStore(initial = {}, { readDelay = 5, writeDelay = 5 } = {}) {
  const data = { ...initial };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  return {
    data,
    get: async (keys) => {
      await sleep(readDelay);
      const out = {};
      for (const k of keys) out[k] = data[k];
      return out;
    },
    set: async (obj) => {
      await sleep(writeDelay);
      Object.assign(data, obj);
    },
  };
}

// --- Item 3: serialised appends ---------------------------------------------

test('concurrent appends all survive — the read-modify-write race is closed', async () => {
  const store = makeStore({ logs: [] });
  const append = makeSerialAppender(store);

  // Fired together, exactly as three courses warning at once would.
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => append('logs', { n: i }, 50)),
  );

  assert.equal(store.data.logs.length, 12, 'every entry should be present');
  assert.deepEqual(
    store.data.logs.map(e => e.n).sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, i) => i),
  );
});

test('the unserialised version really does lose entries (the bug this replaces)', async () => {
  // Guards the test above: if a naive implementation also passed, the first
  // test would prove nothing about serialisation.
  const store = makeStore({ logs: [] });
  const naiveAppend = async (key, entry, cap) => {
    const data = await store.get([key]);
    const list = Array.isArray(data[key]) ? data[key].slice() : [];
    list.push(entry);
    await store.set({ [key]: list.slice(-cap) });
  };

  await Promise.all(
    Array.from({ length: 12 }, (_, i) => naiveAppend('logs', { n: i }, 50)),
  );

  assert.ok(store.data.logs.length < 12,
    'naive read-modify-write must drop entries, or the race is not being simulated');
});

test('appends stay ordered and respect the cap', async () => {
  const store = makeStore({ logs: [] });
  const append = makeSerialAppender(store);

  await Promise.all(
    Array.from({ length: 8 }, (_, i) => append('logs', { n: i }, 3)),
  );

  assert.equal(store.data.logs.length, 3, 'cap holds');
  assert.deepEqual(store.data.logs.map(e => e.n), [5, 6, 7], 'newest kept, in order');
});

test('one failed append does not wedge the appends behind it', async () => {
  const store = makeStore({ logs: [] });
  let failNext = true;
  const append = makeSerialAppender({
    get: store.get,
    set: async (obj) => {
      if (failNext) { failNext = false; throw new Error('storage hiccup'); }
      return store.set(obj);
    },
  });

  await assert.rejects(() => append('logs', { n: 'doomed' }, 50));
  await append('logs', { n: 'after' }, 50);

  assert.deepEqual(store.data.logs.map(e => e.n), ['after']);
});

test('a non-array value in storage is replaced, not appended to', async () => {
  const store = makeStore({ logs: 'corrupt' });
  const append = makeSerialAppender(store);
  await append('logs', { n: 1 }, 50);
  assert.deepEqual(store.data.logs, [{ n: 1 }]);
});

test('two different keys do not contaminate each other', async () => {
  const store = makeStore({ logs: [], syncHistory: [] });
  const append = makeSerialAppender(store);
  await Promise.all([
    append('logs', { n: 'a' }, 50),
    append('syncHistory', { n: 'b' }, 50),
    append('logs', { n: 'c' }, 50),
  ]);
  assert.equal(store.data.logs.length, 2);
  assert.equal(store.data.syncHistory.length, 1);
});

// --- Item 2: per-file counts -------------------------------------------------

test('empty counts are all zero, and adding is field-wise', () => {
  assert.deepEqual(emptyFileCounts(), {
    done: 0, total: 0, skippedForbidden: 0, skippedSize: 0,
    skippedUnchanged: 0, errored: 0, refreshed: 0,
  });
  const sum = addFileCounts({ done: 2, errored: 1 }, { done: 3, skippedSize: 4 });
  assert.equal(sum.done, 5);
  assert.equal(sum.errored, 1);
  assert.equal(sum.skippedSize, 4);
});

test('roll-up sums files_download across courses and ignores courses that never got there', () => {
  const courses = {
    101: { items: { files_download: { counts: { done: 10, skippedForbidden: 2 } } } },
    102: { items: { files_download: { counts: { done: 5, errored: 1 } } } },
    103: { items: { syllabus: { status: 'done' } } },          // never reached files
    104: {},                                                    // cancelled before start
  };
  const total = rollUpFileCounts(courses);
  assert.equal(total.done, 15);
  assert.equal(total.skippedForbidden, 2);
  assert.equal(total.errored, 1);
});

test('roll-up survives a missing or malformed progress map', () => {
  assert.deepEqual(rollUpFileCounts(undefined), emptyFileCounts());
  assert.deepEqual(rollUpFileCounts({}), emptyFileCounts());
  assert.equal(rollUpFileCounts({ 1: { items: null } }).done, 0);
});

test('a clean run says nothing — silence is the point', () => {
  assert.equal(formatFileCounts({ done: 142, total: 142 }), null);
  assert.equal(formatFileCounts(null), null);
  assert.equal(formatFileCounts(emptyFileCounts()), null);
});

test('a run that dropped files says so, and names each reason', () => {
  const line = formatFileCounts({
    done: 100, total: 145, skippedForbidden: 40, skippedSize: 3, errored: 2, refreshed: 7,
  });
  assert.match(line, /100 files synced/);
  assert.match(line, /40 not permitted/);
  assert.match(line, /3 too large/);
  assert.match(line, /2 failed/);
  assert.match(line, /7 recovered after link expiry/);
});

test('skippedUnchanged alone is not a complaint', () => {
  // Nothing was missed — those files were already on disk.
  assert.equal(formatFileCounts({ done: 0, total: 90, skippedUnchanged: 90 }), null);
});

// --- Item 1: expired URL vs real permission denial ---------------------------

class FakePermissionError extends Error {}
const isPermissionError = err => err instanceof FakePermissionError;

test('the happy path fetches once and reports no refresh', async () => {
  const calls = [];
  const out = await fetchFileWithFreshUrl({
    file: { id: 7, url: 'https://signed/original' },
    courseId: 1,
    fetchBinary: async (url) => { calls.push(url); return { base64: 'AAA' }; },
    getFileMeta: async () => assert.fail('must not ask for metadata on success'),
    isPermissionError,
  });
  assert.deepEqual(calls, ['https://signed/original']);
  assert.equal(out.refreshed, false);
  assert.equal(out.binary.base64, 'AAA');
});

test('an expired URL is retried once with a fresh one and counts as refreshed', async () => {
  const calls = [];
  const out = await fetchFileWithFreshUrl({
    file: { id: 7, url: 'https://signed/expired' },
    courseId: 42,
    fetchBinary: async (url) => {
      calls.push(url);
      if (url === 'https://signed/expired') throw new FakePermissionError('403');
      return { base64: 'BBB' };
    },
    getFileMeta: async (cid, fileId) => {
      assert.equal(cid, 42);
      assert.equal(fileId, 7);
      return { id: 7, url: 'https://signed/fresh' };
    },
    isPermissionError,
  });
  assert.deepEqual(calls, ['https://signed/expired', 'https://signed/fresh']);
  assert.equal(out.refreshed, true);
  assert.equal(out.binary.base64, 'BBB');
});

test('a genuinely forbidden file still throws — a fresh URL 403s too', async () => {
  let fetches = 0;
  await assert.rejects(
    () => fetchFileWithFreshUrl({
      file: { id: 9, url: 'https://signed/a' },
      courseId: 1,
      fetchBinary: async () => { fetches++; throw new FakePermissionError('403'); },
      getFileMeta: async () => ({ id: 9, url: 'https://signed/b' }),
      isPermissionError,
    }),
    FakePermissionError,
  );
  assert.equal(fetches, 2, 'exactly one retry, then give up');
});

test('an unchanged URL is not re-fetched — refreshing bought nothing', async () => {
  let fetches = 0;
  await assert.rejects(
    () => fetchFileWithFreshUrl({
      file: { id: 9, url: 'https://signed/same' },
      courseId: 1,
      fetchBinary: async () => { fetches++; throw new FakePermissionError('403'); },
      getFileMeta: async () => ({ id: 9, url: 'https://signed/same' }),
      isPermissionError,
    }),
    FakePermissionError,
  );
  assert.equal(fetches, 1, 'no second fetch against an identical URL');
});

test('a failing metadata lookup re-throws the ORIGINAL 403, not its own error', async () => {
  await assert.rejects(
    () => fetchFileWithFreshUrl({
      file: { id: 9, url: 'https://signed/a' },
      courseId: 1,
      fetchBinary: async () => { throw new FakePermissionError('the real 403'); },
      getFileMeta: async () => { throw new Error('lookup exploded'); },
      isPermissionError,
    }),
    (err) => {
      assert.ok(err instanceof FakePermissionError,
        'the caller classifies on error type; a lookup failure must not change it');
      assert.match(err.message, /the real 403/);
      return true;
    },
  );
});

test('metadata without a url falls back to the original error', async () => {
  let fetches = 0;
  await assert.rejects(
    () => fetchFileWithFreshUrl({
      file: { id: 9, url: 'https://signed/a' },
      courseId: 1,
      fetchBinary: async () => { fetches++; throw new FakePermissionError('403'); },
      getFileMeta: async () => ({ id: 9 }),
      isPermissionError,
    }),
    FakePermissionError,
  );
  assert.equal(fetches, 1);
});

test('a non-403 failure is never retried and never asks for metadata', async () => {
  let fetches = 0;
  await assert.rejects(
    () => fetchFileWithFreshUrl({
      file: { id: 9, url: 'https://signed/a' },
      courseId: 1,
      fetchBinary: async () => { fetches++; throw new Error('socket reset'); },
      getFileMeta: async () => assert.fail('metadata lookup is for 403s only'),
      isPermissionError,
    }),
    /socket reset/,
  );
  assert.equal(fetches, 1);
});
