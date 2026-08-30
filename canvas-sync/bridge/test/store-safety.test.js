// store-safety.test.js — the guard that refuses a mutation over an unreadable
// store, and the guard on the guard.
//
// preserveUnreadable's only effective path is a throw, which makes its FAILURE
// modes the interesting ones: a version that quietly returns is
// indistinguishable from a version that ran, and every caller would then
// overwrite the store it was supposed to protect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preserveUnreadable, UnreadableStoreError } from '../store-safety.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-store-safety-'));

test('a caller who passes the wrong thing is told, not silently unprotected', async () => {
  // The hazard this closes: `state.unreadable` on a non-state object is
  // undefined, which is falsy, so the guard fell through and the caller
  // overwrote the store with its protection switched off — no error, no
  // preserved copy, nothing to notice. A safety helper must not fail OPEN on
  // the one mistake its callers are most likely to make: handing it the parsed
  // value instead of the reader's state object.
  for (const [label, bad] of [
    ['the parsed value', { items: { 'essay-one': { done: true } } }],
    ['an empty object', {}],
    ['null', null],
    ['undefined', undefined],
    ['a non-boolean flag', { unreadable: 'yes' }],
  ]) {
    await assert.rejects(
      () => preserveUnreadable(bad, '/tmp/never-touched.json'),
      (err) => {
        assert.ok(err instanceof TypeError,
          `${label} should be a TypeError (a programming error), got ${err.constructor.name}`);
        assert.ok(!(err instanceof UnreadableStoreError),
          `${label} must not masquerade as a data condition`);
        assert.match(err.message, /pass the reader's state object, not the parsed value/);
        return true;
      },
      `${label} was accepted — the guard is failing open again`);
  }
});

test('a readable store falls through so the mutation proceeds', async () => {
  // The other half. A guard that rejected everything would pass every
  // assertion above while breaking every write in the app.
  assert.equal(await preserveUnreadable({ unreadable: false }, '/tmp/never-touched.json'), undefined);
  assert.equal(await preserveUnreadable({ unreadable: false, items: {} }, '/tmp/nope.json'), undefined);
});

test('an unreadable store is moved aside and the mutation refused', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'store.json');
  const contents = '{"half a store":';
  await fs.writeFile(file, contents, 'utf8');

  await assert.rejects(
    () => preserveUnreadable({ unreadable: true, reason: 'parse' }, file),
    (err) => {
      assert.ok(err instanceof UnreadableStoreError, 'a bad store is a data condition, not a TypeError');
      assert.match(err.message, /\(parse\)/, 'the message must name why it could not be read');
      return true;
    });

  const kept = (await fs.readdir(dir)).find(n => n.startsWith('store.json.unreadable-'));
  assert.ok(kept, 'the original bytes must be preserved, not deleted');
  assert.equal(await fs.readFile(path.join(dir, kept), 'utf8'), contents, 'preserved bytes must be verbatim');
  await assert.rejects(fs.access(file), { code: 'ENOENT' }, 'the unreadable file must be moved, not copied');
  await fs.rm(dir, { recursive: true, force: true });
});

test('a store that cannot even be moved aside still refuses, and says the original is intact', async () => {
  // The worst case: we cannot read it AND cannot preserve it. Refusing is
  // still right — the one thing that must never happen is overwriting it.
  const dir = await tmp();
  const file = path.join(dir, 'missing-entirely.json');   // rename will ENOENT
  await assert.rejects(
    () => preserveUnreadable({ unreadable: true, reason: 'EACCES' }, file),
    (err) => {
      assert.ok(err instanceof UnreadableStoreError);
      assert.match(err.message, /could not be preserved/);
      assert.match(err.message, /The original remains at/,
        'a caller that cannot preserve must still be told where the data is');
      return true;
    });
  await fs.rm(dir, { recursive: true, force: true });
});
