// safe-delete.test.js — unit tests for safeDeleteClass() and the
// DeleteValidationError rule enforcement path (plan 3a + 3f).
// Uses a temp dir fixture via CANVAS_SYNC_HOME so we never touch real data.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  safeDeleteClass,
  DeleteValidationError,
  isValidFolderName,
} from '../storage.js';

let tmpHome;
let classesDir;

// Create a valid class folder named `<id>-<slug>` under tmpHome/classes.
async function makeClass(folderName, { withMetadata = true } = {}) {
  const dir = path.join(classesDir, folderName);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (withMetadata) {
    await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ id: 1 }));
  }
  return dir;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-sd-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  classesDir = path.join(tmpHome, 'classes');
  await fs.mkdir(classesDir, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  delete process.env.CANVAS_SYNC_HOME;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

// --- isValidFolderName sanity ---
test('isValidFolderName: accepts valid names', () => {
  assert.equal(isValidFolderName('42-cs101'), true);
  assert.equal(isValidFolderName('87562-busi-310-003'), true);
});

test('isValidFolderName: rejects invalid names', () => {
  assert.equal(isValidFolderName(''), false);
  assert.equal(isValidFolderName('foo'), false);           // no id prefix
  assert.equal(isValidFolderName('42-'), false);           // empty slug
  assert.equal(isValidFolderName('42-CS101'), false);      // uppercase
  assert.equal(isValidFolderName('42-cs.101'), false);     // dot
  assert.equal(isValidFolderName('42-cs_101'), false);     // underscore
  assert.equal(isValidFolderName('42 cs101'), false);      // space
  assert.equal(isValidFolderName('42-cs101/foo'), false);  // slash
  assert.equal(isValidFolderName(null), false);
  assert.equal(isValidFolderName(undefined), false);
  assert.equal(isValidFolderName(42), false);
});

// --- Rule 1: arg type ---
test('rule 1: empty string rejected', () => {
  assert.throws(() => safeDeleteClass(''), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-1');
});

test('rule 1: multi-arg call rejected', () => {
  assert.throws(() => safeDeleteClass('42-cs101', 'extra'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-1');
});

test('rule 1: zero-arg call rejected', () => {
  assert.throws(() => safeDeleteClass(), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-1');
});

test('rule 1: non-string rejected', () => {
  assert.throws(() => safeDeleteClass(123), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-1');
});

// --- Rule 2: regex ---
test('rule 2: ".." rejected', () => {
  assert.throws(() => safeDeleteClass('..'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
});

test('rule 2: "../foo" rejected', () => {
  assert.throws(() => safeDeleteClass('../foo'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
});

test('rule 2: "foo/../bar" rejected', () => {
  assert.throws(() => safeDeleteClass('foo/../bar'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
});

test('rule 2: absolute path rejected', () => {
  assert.throws(() => safeDeleteClass('/tmp/foo'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
});

test('rule 2: slashes in name rejected', () => {
  assert.throws(() => safeDeleteClass('42-cs/101'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
});

test('rule 2: wildcard chars rejected', () => {
  assert.throws(() => safeDeleteClass('42-cs*'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
  assert.throws(() => safeDeleteClass('42-cs?'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
});

test('rule 2: spaces/quotes/semicolons rejected', () => {
  assert.throws(() => safeDeleteClass('42-cs 101'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
  assert.throws(() => safeDeleteClass("42-cs'101"), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
  assert.throws(() => safeDeleteClass('42-cs;101'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
});

test('rule 2: uppercase rejected', () => {
  assert.throws(() => safeDeleteClass('42-CS101'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
});

test('rule 2: dots in name rejected', () => {
  assert.throws(() => safeDeleteClass('42-cs.101'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
});

test('rule 2: missing numeric prefix rejected', () => {
  assert.throws(() => safeDeleteClass('cs101'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-2');
});

// --- Rule 5: existence ---
test('rule 5: valid-looking name, non-existent folder rejected', () => {
  assert.throws(() => safeDeleteClass('42-cs101'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-5');
});

// --- Rule 6: realpath match (symlink escape) ---
test('rule 6: symlink pointing outside classesDir rejected', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'metadata.json'), '{}');
    // Create a symlink at classesDir/99-evil -> outside
    fsSync.symlinkSync(outside, path.join(classesDir, '99-evil'));

    assert.throws(() => safeDeleteClass('99-evil'), (e) =>
      e instanceof DeleteValidationError && e.rule === 'rule-6');

    // Confirm the outside dir (and its contents) still exist.
    assert.ok(fsSync.existsSync(outside));
    assert.ok(fsSync.existsSync(path.join(outside, 'metadata.json')));
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

// --- Rule 7: sentinel check ---
test('rule 7: folder missing metadata.json rejected', async () => {
  await makeClass('42-nosentinel', { withMetadata: false });
  assert.throws(() => safeDeleteClass('42-nosentinel'), (e) =>
    e instanceof DeleteValidationError && e.rule === 'rule-7');
  // Folder must still exist.
  assert.ok(fsSync.existsSync(path.join(classesDir, '42-nosentinel')));
});

// --- Happy path ---
test('happy path: deletes folder, classesDir preserved, returns size/count', async () => {
  const dir = await makeClass('42-cs101');
  // Add some dummy content so we have file count > 1.
  await fs.writeFile(path.join(dir, 'assignments.json'), '[]');
  await fs.mkdir(path.join(dir, 'AI_CONTEXT'), { recursive: true });
  await fs.writeFile(path.join(dir, 'AI_CONTEXT', 'context.md'), '# hi');
  const sibling = path.join(classesDir, '99-other');
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'metadata.json'), '{}');

  const result = safeDeleteClass('42-cs101');
  assert.equal(result.folderName, '42-cs101');
  assert.ok(result.fileCount >= 3);
  assert.ok(result.sizeBytes >= 0);

  // The target folder is gone, classesDir still there, sibling untouched.
  assert.equal(fsSync.existsSync(dir), false);
  assert.ok(fsSync.existsSync(classesDir));
  assert.ok(fsSync.existsSync(sibling));
  assert.ok(fsSync.existsSync(path.join(sibling, 'metadata.json')));
});

test('happy path: writes DELETE_START + DELETE_COMPLETE to delete.log', async () => {
  await makeClass('42-cs101');
  safeDeleteClass('42-cs101');
  const log = await fs.readFile(path.join(tmpHome, 'logs', 'delete.log'), 'utf8');
  assert.match(log, /DELETE_START folder=42-cs101/);
  assert.match(log, /DELETE_COMPLETE folder=42-cs101/);
});

test('failure path: logs DELETE_FAILED with rule code', () => {
  assert.throws(() => safeDeleteClass('../etc'));
  const logPath = path.join(tmpHome, 'logs', 'delete.log');
  const log = fsSync.readFileSync(logPath, 'utf8');
  assert.match(log, /DELETE_FAILED reason=rule-2/);
});
