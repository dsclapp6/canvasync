import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, stat, mkdir, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..');
const FIXTURES_DIR = join(SCRIPTS_DIR, 'test-fixtures', 'sample-class');

function runSyncAll(canvasSyncHome) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_SKIP: '1', CANVAS_SYNC_HOME: canvasSyncHome };
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, 'sync-all-contexts.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

let tmpHome;
let classesDir;
let classDir;

before(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'ccsync-sync-test-'));
  classesDir = join(tmpHome, 'classes');
  await mkdir(classesDir, { recursive: true });
  classDir = join(classesDir, '12345-econ-370');
  await cp(FIXTURES_DIR, classDir, { recursive: true });
});

test('sync-all populates AI_CONTEXT on first run', async () => {
  const result = await runSyncAll(tmpHome);

  assert.ok(result.code === 0, `sync-all exited ${result.code}. stderr: ${result.stderr.slice(0, 500)}`);

  const contextMd = join(classDir, 'AI_CONTEXT', 'context.md');
  assert.ok(existsSync(contextMd), 'AI_CONTEXT/context.md not created');

  const contextJson = join(classDir, 'AI_CONTEXT', 'context.json');
  assert.ok(existsSync(contextJson), 'AI_CONTEXT/context.json not created');

  const lastBuilt = join(classDir, 'AI_CONTEXT', 'last_built.txt');
  assert.ok(existsSync(lastBuilt), 'AI_CONTEXT/last_built.txt not created');
});

test('sync-all prints summary table', async () => {
  const result = await runSyncAll(tmpHome);
  assert.ok(result.stdout.includes('CLASS'), 'Summary table header missing');
  assert.ok(result.stdout.includes('ACTION'), 'Summary table ACTION column missing');
  assert.ok(result.stdout.includes('OUTCOME'), 'Summary table OUTCOME column missing');
});

test('sync-all marks action=none on second run (nothing stale)', async () => {
  const result = await runSyncAll(tmpHome);
  assert.ok(result.code === 0, `sync-all exited ${result.code} on second run`);
  assert.ok(result.stdout.includes('none'), 'Expected action=none on second run, but not found in output');
  const lines = result.stdout.split('\n').filter(l => l.includes('12345-econ-370'));
  assert.ok(lines.length > 0, 'Class row not found in summary');
  assert.ok(!lines[0].includes('error'), `Expected no error outcome but got: ${lines[0]}`);
});

// Regression: the bridge rewrites syllabus.html on every ingest (atomic
// write+rename bumps the mtime) even when the bytes are identical. needsParse
// must NOT re-fire the expensive AI parse on a byte-identical rewrite — it has
// to confirm the mtime bump against the stored content hash. A prior version
// returned true on the mtime alone, re-parsing forever.
test('sync-all does not re-parse a byte-identical syllabus rewrite (mtime bump, matching hash)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccsync-reparse-'));
  const dir = join(home, 'classes', '55555-hist-200');
  await cp(FIXTURES_DIR, dir, { recursive: true });

  const body = '<html><body>Weekly reading due Fridays. Midterm week 8.</body></html>';
  const syllabus = join(dir, 'syllabus.html');
  await writeFile(syllabus, body);
  // Simulate the bridge's sidecar: sha256 of the stored syllabus file.
  await writeFile(join(dir, 'syllabus.hash'), createHash('sha256').update(body).digest('hex'));

  // Make syllabus.html strictly NEWER than the parsed output, so only the hash
  // guard (not mtime) can spare the re-parse.
  const parsed = join(dir, 'syllabus_parsed.json');
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  await utimes(parsed, past, past);
  await utimes(syllabus, future, future);
  const parsedMtimeBefore = (await stat(parsed)).mtimeMs;

  const result = await runSyncAll(home);
  assert.equal(result.code, 0, `sync-all exited ${result.code}. stderr: ${result.stderr.slice(0, 400)}`);

  const parsedMtimeAfter = (await stat(parsed)).mtimeMs;
  assert.equal(parsedMtimeAfter, parsedMtimeBefore,
    'syllabus was re-parsed despite identical content — the mtime bump bypassed the hash guard');
});

// Converse: a genuine content change (hash no longer matches) MUST re-parse.
test('sync-all re-parses when the syllabus content actually changes (hash mismatch)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccsync-reparse2-'));
  const dir = join(home, 'classes', '55556-hist-201');
  await cp(FIXTURES_DIR, dir, { recursive: true });

  const oldBody = '<html><body>Original syllabus.</body></html>';
  const syllabus = join(dir, 'syllabus.html');
  await writeFile(syllabus, '<html><body>REVISED syllabus — new midterm date.</body></html>');
  // The stored hash is for the OLD body; the file on disk differs → stale.
  await writeFile(join(dir, 'syllabus.hash'), createHash('sha256').update(oldBody).digest('hex'));

  const parsed = join(dir, 'syllabus_parsed.json');
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  await utimes(parsed, past, past);
  await utimes(syllabus, future, future);
  const before = (await stat(parsed)).mtimeMs;

  const result = await runSyncAll(home);
  assert.equal(result.code, 0, `sync-all exited ${result.code}. stderr: ${result.stderr.slice(0, 400)}`);

  const after = (await stat(parsed)).mtimeMs;
  assert.notEqual(after, before, 'changed syllabus was NOT re-parsed — the hash guard is too aggressive');
});
