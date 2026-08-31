import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, copyFile, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { repairJson } from '../parse-syllabus.js';
import { sameOrStronger } from '../model-profiles.js';

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

// --- Same-or-stronger repair pinning ----------------------------------------
//
// A repair prompt carries the broken output and the schema — never the
// syllabus — so a model answering it is reconstructing, not repairing. Under
// auto failover the backend can change between the first attempt and the
// repair (a CLI's auth expires mid-run, a status probe flaps), and a WEAKER
// model answering the repair is worse than no repair: it returns confident,
// well-formed, invented content instead of an error the caller can act on.

test('the repair is pinned to the tier that answered the first attempt', async () => {
  const promptTemplate = await readFile(PROMPT_PATH, 'utf8');
  let options;
  await repairJson('{broken', promptTemplate, async (_prompt, invokeOptions) => {
    options = invokeOptions;
    return '{}';
  }, sameOrStronger({ backend: 'claude', tier: 'strong', profile: 'claude-cli' }));
  assert.deepEqual(options.needs, { tier: 'strong' });
  // The pin must not disturb what v1.8.6 established on this same call.
  assert.equal(options.maxTokens, 16384);
});

test('a first attempt that never answered pins nothing at all', async () => {
  // aiInvoke leaves `info` untouched when it throws, so an attempt that failed
  // outright yields an empty object. There is no "same" to be stronger than,
  // and inventing a floor here would refuse a repair that is attempted today.
  const promptTemplate = await readFile(PROMPT_PATH, 'utf8');
  let options;
  await repairJson('{broken', promptTemplate, async (_prompt, invokeOptions) => {
    options = invokeOptions;
    return '{}';
  }, sameOrStronger({}));
  assert.ok(!('needs' in options), `expected no pin, got ${JSON.stringify(options.needs)}`);
});

test('a repair cannot fall to a weaker backend than the attempt it is repairing', async () => {
  // End to end through the real main(), with the failover the pin exists for:
  // the claude CLI is signed in for the first attempt and signed out by the
  // time the repair asks, leaving only the local model. Pinned to `strong`,
  // the repair refuses and the stage fails loudly with its .ERROR sidecar
  // rather than writing a syllabus reconstructed by a 4-bit model.
  const dir = join(tmpDir, 'failover-class');
  await mkdir(dir, { recursive: true });
  await copyFile(join(FIXTURES_DIR, 'sample-syllabus.html'), join(dir, 'syllabus.html'));

  const bin = join(tmpDir, 'bin');
  await mkdir(bin, { recursive: true });
  const claude = join(bin, 'claude');
  await writeFile(claude, `#!/bin/sh
STATE=${JSON.stringify(join(bin, 'status-calls'))}
if [ "$1 $2" = "auth status" ]; then
  n=$(cat "$STATE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STATE"
  if [ "$n" -eq 1 ]; then printf '{"loggedIn":true}\\n'; exit 0; fi
  printf '{"loggedIn":false}\\n'; exit 1
fi
cat >/dev/null
printf '{broken\\n'
`, { mode: 0o755 });
  const codex = join(bin, 'codex');
  await writeFile(codex, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const localPy = join(bin, 'local-python');
  await writeFile(localPy, '#!/bin/sh\ncat >/dev/null\nprintf \'{"course":{"title":"RECONSTRUCTED BY LOCAL"},"schedule":[]}\\n\'\n', { mode: 0o755 });

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, 'parse-syllabus.js'), dir], {
      env: {
        ...process.env,
        CLAUDE_SKIP: '',
        CANVAS_SYNC_HOME: tmpDir,
        CSYNC_AI_BACKEND: 'auto',
        CSYNC_CLAUDE_BIN: claude,
        CSYNC_CODEX_BIN: codex,
        CSYNC_LOCAL_PYTHON: localPy,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });

  assert.equal(result.code, 1, `the stage must fail rather than accept a weaker repair. stderr: ${result.stderr}`);
  assert.match(result.stderr, /tier strong/,
    'the failure must name the tier that could not be met, so it is actionable');
  // The broken output is preserved for reading, exactly as before.
  const sidecar = await readFile(join(dir, 'syllabus_parsed.json.ERROR'), 'utf8');
  assert.match(sidecar, /\{broken/);
  // And nothing invented by the weaker backend was written.
  await assert.rejects(readFile(join(dir, 'syllabus_parsed.json'), 'utf8'),
    'no syllabus_parsed.json may exist — the local model must never have answered');
});
