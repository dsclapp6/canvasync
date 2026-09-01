// bump-version.test.js — the release ritual, and the one property that made it
// worth writing a tool for.
//
// The failure it prevents: a hand bump truncates package.json before rewriting
// it, and node reads package.json to decide whether the .js beside it is ESM.
// For that instant every node process starting in that directory dies with
// ERR_INVALID_PACKAGE_CONFIG before any user code — which, against a 43-file
// parallel suite in a tree six sessions are editing, took whole test files down
// at load with nothing to debug. Reproduced in a scratch copy: one non-atomic
// rewrite of bridge/package.json killed 24 files.
//
// HOW ATOMICITY IS PINNED HERE, since "it is atomic" is the kind of claim that
// passes by assertion: a reader that opened the file BEFORE the bump still
// reads the whole original afterwards. That is the property — not "a temp file
// appeared" — and with rename it holds by construction, while any truncate-then-
// write fails it. The inode check beside it names the mechanism that delivers
// it. What no test here can do is catch a reader that opens DURING the write:
// that race has no deterministic hook, which is exactly why the fix has to be
// structural rather than timed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  TARGETS, patchVersionText, atomicWriteFile, bumpVersions, readVersions, parseArgs,
} from '../bump-version.js';

// Deliberately NOT canonical JSON.stringify output: the description carries a
// \\u2014 escape, exactly as canvas-sync/app/package.json does today. Reserialising
// that file — the obvious way to write this tool — silently turns the escape
// into a raw em dash. The fixture has to contain something a round trip would
// change, or the byte-identity test below asserts nothing. (Found by reverting:
// with a fully canonical fixture, replacing the surgical patch with
// JSON.stringify passed all thirteen tests.)
const PKG = (name, version) =>
  `{\n  "name": "${name}",\n  "version": "${version}",\n  "description": "shell \\u2014 for the bridge",\n  "private": true,\n  "scripts": {\n    "test": "node --test"\n  }\n}\n`;
const MANIFEST = (version) =>
  `{\n  "manifest_version": 3,\n  "name": "CANVASync",\n  "version": "${version}",\n  "permissions": ["storage"]\n}\n`;

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-bump-'));
  for (const rel of Object.values(TARGETS).flat()) {
    await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel),
      rel.endsWith('manifest.json') ? MANIFEST('1.0.0') : PKG(path.dirname(rel) || 'canvasync', '1.0.0'));
  }
  return root;
}
const read = (root, rel) => fs.readFile(path.join(root, rel), 'utf8');

// --- The property ------------------------------------------------------------

test('a reader holding the file open still sees the whole old version', async () => {
  const root = await fixture();
  try {
    const target = path.join(root, 'bridge/package.json');
    const before = await fs.readFile(target, 'utf8');
    const held = await fs.open(target, 'r');           // opened BEFORE the bump
    try {
      await bumpVersions({ bridge: '2.0.0' }, { root });
      const buf = Buffer.alloc(before.length * 2);
      const { bytesRead } = await held.read(buf, 0, buf.length, 0);
      assert.equal(buf.subarray(0, bytesRead).toString('utf8'), before,
        'the open handle saw the write — this is the truncation that kills node at load');
    } finally {
      await held.close();
    }
    // And a reader opening after the rename gets the new file, whole.
    assert.match(await read(root, 'bridge/package.json'), /"version": "2\.0\.0"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the write is a rename — new inode, and no temp left behind', async () => {
  const root = await fixture();
  try {
    const target = path.join(root, 'package.json');
    const inoBefore = (await fs.stat(target)).ino;
    await bumpVersions({ repo: '1.8.28' }, { root });
    assert.notEqual((await fs.stat(target)).ino, inoBefore,
      'same inode means the bytes were written in place, not renamed over');
    const leftovers = (await fs.readdir(root)).filter(n => n.includes('.tmp.'));
    assert.deepEqual(leftovers, [], 'a temp file survived the write');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the file keeps its mode across the rename', async () => {
  const root = await fixture();
  try {
    const target = path.join(root, 'app/package.json');
    await fs.chmod(target, 0o600);
    await bumpVersions({ app: '1.3.0' }, { root });
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Only the version moves --------------------------------------------------

test('everything except the version line is byte-identical afterwards', async () => {
  const root = await fixture();
  try {
    const before = await read(root, 'scripts/package.json');
    assert.ok(before.includes('\\u2014'), 'the fixture stopped being hand-written JSON');
    await bumpVersions({ scripts: '1.6.0' }, { root });
    const after = await read(root, 'scripts/package.json');
    assert.equal(after, before.replace('"version": "1.0.0"', '"version": "1.6.0"'),
      'the file was reserialised — a one-line bump must stay a one-line diff, and '
      + 'an escape in a description must not silently become a raw character');
    assert.ok(after.includes('\\u2014'), 'the \\u2014 escape was rewritten');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('manifest_version is not mistaken for the version', async () => {
  const root = await fixture();
  try {
    await bumpVersions({ extension: '1.11.0' }, { root });
    const manifest = await read(root, 'extension/manifest.json');
    assert.match(manifest, /"manifest_version": 3/, 'Chrome would reject this manifest');
    assert.match(manifest, /"version": "1\.11\.0"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the extension pair moves together', async () => {
  const root = await fixture();
  try {
    const moved = await bumpVersions({ extension: '1.11.0' }, { root });
    assert.deepEqual(moved.map(m => m.rel).sort(),
      ['extension/manifest.json', 'extension/package.json']);
    const versions = await readVersions({ root });
    assert.deepEqual(Object.values(versions.extension), ['1.11.0', '1.11.0']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Nothing half-applied ----------------------------------------------------

test('a bad version anywhere leaves the WHOLE tree untouched', async () => {
  const root = await fixture();
  try {
    const before = await Promise.all(
      Object.values(TARGETS).flat().map(rel => read(root, rel)));
    await assert.rejects(
      bumpVersions({ repo: '1.8.28', extension: 'v1.11' }, { root }),
      /not a version/);
    const after = await Promise.all(
      Object.values(TARGETS).flat().map(rel => read(root, rel)));
    assert.deepEqual(after, before,
      'the good half was written before the bad one was noticed — a half-bumped '
      + 'extension pair is a build the user cannot identify');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a manifest caught mid-edit aborts the run instead of being overwritten', async () => {
  const root = await fixture();
  try {
    await fs.writeFile(path.join(root, 'extension/manifest.json'), '{ "version": "1.0.0",');
    const repoBefore = await read(root, 'package.json');
    await assert.rejects(
      bumpVersions({ repo: '1.8.28', extension: '1.11.0' }, { root }),
      /does not parse/);
    assert.equal(await read(root, 'package.json'), repoBefore);
    assert.equal(await read(root, 'extension/package.json'), PKG('extension', '1.0.0'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('--dry-run reports the move and writes nothing', async () => {
  const root = await fixture();
  try {
    const before = await read(root, 'package.json');
    const moved = await bumpVersions({ repo: '9.9.9' }, { root, dryRun: true });
    assert.deepEqual(moved, [{ group: 'repo', rel: 'package.json', from: '1.0.0', to: '9.9.9' }]);
    assert.equal(await read(root, 'package.json'), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- The edges ---------------------------------------------------------------

test('unknown targets and empty plans are refused by name', async () => {
  const root = await fixture();
  try {
    await assert.rejects(bumpVersions({ brdige: '1.0.1' }, { root }), /unknown target: brdige/);
    await assert.rejects(bumpVersions({}, { root }), /nothing to bump/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('patchVersionText refuses what it cannot do safely', () => {
  const good = PKG('x', '1.0.0');
  assert.equal(patchVersionText(good, '1.0.1').from, '1.0.0');
  assert.match(patchVersionText(good, '1.0.1').text, /"version": "1\.0\.1"/);
  assert.equal(patchVersionText(good, '2.0.0-rc.1').text.includes('2.0.0-rc.1'), true);
  for (const bad of ['1.0', 'v1.0.0', '1.0.0.0', 'latest', '']) {
    assert.throws(() => patchVersionText(good, bad), /not a version/, `accepted "${bad}"`);
  }
  assert.throws(() => patchVersionText('{ nope', '1.0.1'), /does not parse/);
  assert.throws(() => patchVersionText('{"name":"x"}', '1.0.1'), /no string "version"/);
  assert.throws(() => patchVersionText('{"version": 3}', '1.0.1'), /no string "version"/);
});

test('atomicWriteFile creates a file that did not exist yet', async () => {
  const root = await fixture();
  try {
    const target = path.join(root, 'brand-new.json');
    await atomicWriteFile(target, '{"ok":true}\n');
    assert.equal(await fs.readFile(target, 'utf8'), '{"ok":true}\n');
    assert.deepEqual((await fs.readdir(root)).filter(n => n.includes('.tmp.')), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the command line says what it means', () => {
  assert.deepEqual(parseArgs(['repo=1.8.28', 'extension=1.11.0']),
    { plan: { repo: '1.8.28', extension: '1.11.0' }, dryRun: false, list: false });
  assert.deepEqual(parseArgs(['--list']), { plan: {}, dryRun: false, list: true });
  assert.equal(parseArgs(['repo=1.0.0', '-n']).dryRun, true);
  assert.throws(() => parseArgs(['--bump', 'repo']), /unrecognised argument/);
});
