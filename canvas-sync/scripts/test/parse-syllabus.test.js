import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, copyFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { repairJson } from '../parse-syllabus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..');
const FIXTURES_DIR = join(SCRIPTS_DIR, 'test-fixtures');
const PROMPT_PATH = join(SCRIPTS_DIR, 'prompts', 'syllabus-extraction.md');

function runParseSyllabus(classDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_SKIP: '1' };
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, 'parse-syllabus.js'), classDir], {
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

let tmpDir;
let classDir;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ccsync-parse-test-'));
  classDir = join(tmpDir, 'test-class');
  await mkdir(classDir, { recursive: true });
  await copyFile(
    join(FIXTURES_DIR, 'sample-syllabus.html'),
    join(classDir, 'syllabus.html')
  );
});

test('parse-syllabus writes syllabus_parsed.json in CLAUDE_SKIP mode', async () => {
  const result = await runParseSyllabus(classDir);
  assert.equal(result.code, 0, `Expected exit 0. stderr: ${result.stderr}`);

  const parsedPath = join(classDir, 'syllabus_parsed.json');
  const raw = await readFile(parsedPath, 'utf8');
  const obj = JSON.parse(raw);

  assert.ok(obj, 'syllabus_parsed.json is not valid JSON');
});

test('parse-syllabus output has required top-level keys', async () => {
  const parsedPath = join(classDir, 'syllabus_parsed.json');
  const raw = await readFile(parsedPath, 'utf8');
  const obj = JSON.parse(raw);

  const requiredKeys = ['extracted_at', 'source_file', 'source_hash', 'textbook_schema_version', 'course', 'textbooks', 'grading', 'schedule', 'policies', 'extraction_confidence', 'extraction_notes'];
  for (const key of requiredKeys) {
    assert.ok(key in obj, `Missing required key: "${key}"`);
  }
  assert.ok(Array.isArray(obj.textbooks), 'textbooks must be an array');
});

test('parse-syllabus output has valid source_hash (sha256 hex, 64 chars)', async () => {
  const parsedPath = join(classDir, 'syllabus_parsed.json');
  const raw = await readFile(parsedPath, 'utf8');
  const obj = JSON.parse(raw);

  assert.match(obj.source_hash, /^[a-f0-9]{64}$/, 'source_hash is not a valid sha256 hex string');
});

test('parse-syllabus output has valid extracted_at ISO date', async () => {
  const parsedPath = join(classDir, 'syllabus_parsed.json');
  const raw = await readFile(parsedPath, 'utf8');
  const obj = JSON.parse(raw);

  const d = new Date(obj.extracted_at);
  assert.ok(!isNaN(d.getTime()), 'extracted_at is not a valid date');

  const ageMs = Date.now() - d.getTime();
  assert.ok(ageMs < 60000, `extracted_at is too old (${ageMs}ms)`);
});

test('parse-syllabus sets source_file to syllabus.html', async () => {
  const parsedPath = join(classDir, 'syllabus_parsed.json');
  const raw = await readFile(parsedPath, 'utf8');
  const obj = JSON.parse(raw);

  assert.equal(obj.source_file, 'syllabus.html');
});

test('syllabus JSON repair keeps the original 16384-token output budget', async () => {
  const promptTemplate = await readFile(PROMPT_PATH, 'utf8');
  let options;
  await repairJson('{broken', promptTemplate, async (_prompt, invokeOptions) => {
    options = invokeOptions;
    return '{}';
  });
  assert.equal(options.maxTokens, 16384);
});

test('syllabus JSON repair re-sends the full extraction schema', async () => {
  const promptTemplate = await readFile(PROMPT_PATH, 'utf8');
  const schema = promptTemplate.match(/## Output schema[\s\S]*?```(?:json)?\s*([\s\S]*?)```/)[1].trim();
  let repairPrompt;
  await repairJson('{broken', promptTemplate, async prompt => {
    repairPrompt = prompt;
    return '{}';
  });
  assert.ok(repairPrompt.includes(schema));
  assert.ok(repairPrompt.includes('"textbook_schema_version": 2'));
});

test('syllabus JSON repair salvages a truncated repair response', async () => {
  const promptTemplate = await readFile(PROMPT_PATH, 'utf8');
  const repair = await repairJson('{broken', promptTemplate, async () =>
    '{"course":{"title":"Kept"},"schedule":[{"title":"Complete"},{"title":"cut off');
  assert.equal(repair.truncated, true);
  assert.deepEqual(repair.parsed, {
    course: { title: 'Kept' },
    schedule: [{ title: 'Complete' }],
  });
});
