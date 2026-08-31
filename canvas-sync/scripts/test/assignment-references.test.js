import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { repairMinedJson, validateMined } from '../mine-assignments.js';
import { sameOrStronger } from '../model-profiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MINING_PROMPT_PATH = join(__dirname, '..', 'prompts', 'assignment-mining.md');

const assignments = [
  { id: 71, name: 'Course Project' },
  { id: 72, name: 'Course Project Presentation' },
];
const filesIndex = [
  { canvasId: 901, displayName: 'Course Project Brief.pdf', localPath: 'files/Course Project Brief.pdf' },
];
const syllabusParsed = {
  textbooks: [{
    title: 'Managing Marketing in the 21st Century: Develop and Manage',
    author: 'Noel Capon',
    edition: 'Fifth Edition, 2024',
    isbn: '979-8-989-6021-1-7',
  }],
};

test('mined references are canonicalized to real Canvas rows, files, and syllabus textbooks', () => {
  const result = validateMined({ items: [{
    id: 'project',
    title: 'Course Project',
    kind: 'canvas',
    canvas_assignment_id: 999999,
    sources: [
      { type: 'canvas_assignment', ref: 'Canvas assignment 999999: invented' },
      { type: 'syllabus', ref: 'Project schedule' },
    ],
    related_materials: [
      { file: 'Project Brief', why: 'Instructions and rubric' },
      { file: 'Made-up Answer Key.pdf', why: 'hallucinated' },
    ],
    related_textbooks: [{
      title: 'Managing Marketing in the 21st Century',
      why: 'Read chapter 4',
    }],
  }] }, { assignments, filesIndex, syllabusParsed });

  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.kind, 'canvas');
  assert.equal(item.canvas_assignment_id, 71, 'unique exact title repairs an invalid model id');
  assert.deepEqual(item.sources, [
    { type: 'syllabus', ref: 'Project schedule' },
    { type: 'canvas_assignment', ref: 'Canvas assignment 71: Course Project' },
  ]);
  assert.deepEqual(item.related_materials, [
    { file: 'Course Project Brief.pdf', why: 'Instructions and rubric' },
  ]);
  assert.equal(item.related_textbooks.length, 1);
  assert.equal(item.related_textbooks[0].title,
    'Managing Marketing in the 21st Century: Develop and Manage');
  assert.equal(item.related_textbooks[0].isbn, '979-8-989-6021-1-7');
});

test('aggregate tasks keep every verified Canvas id and discard unknown ones', () => {
  const result = validateMined({ items: [{
    title: 'Course Project deliverables',
    canvas_assignment_id: 71,
    canvas_assignment_ids: [71, 72, 404],
  }] }, { assignments });
  const item = result.items[0];
  assert.equal(item.canvas_assignment_id, 71);
  assert.deepEqual(item.canvas_assignment_ids, [71, 72]);
  assert.deepEqual(item.covers, [71, 72]);
  assert.deepEqual(item.sources.map(source => source.ref), [
    'Canvas assignment 71: Course Project',
    'Canvas assignment 72: Course Project Presentation',
  ]);
});

test('an unsupported Canvas claim becomes implicit instead of a dead assignment link', () => {
  const result = validateMined({ items: [{
    title: 'Bring draft to class',
    kind: 'canvas',
    canvas_assignment_id: 404,
  }] }, { assignments });
  assert.equal(result.items[0].kind, 'implicit');
  assert.equal(result.items[0].canvas_assignment_id, null);
});

test('a bare chapter reference is assigned only to the sole syllabus textbook', () => {
  const result = validateMined({ items: [{
    title: 'Read before class',
    description: 'Read Chapter 4, pages 71–78.',
    related_textbooks: [],
  }] }, { syllabusParsed });
  assert.equal(result.items[0].related_textbooks.length, 1);
  assert.equal(result.items[0].related_textbooks[0].title,
    'Managing Marketing in the 21st Century: Develop and Manage');

  const withTwoBooks = validateMined({ items: [{
    title: 'Read before class',
    description: 'Read Chapter 4, pages 71–78.',
  }] }, { syllabusParsed: {
    textbooks: [...syllabusParsed.textbooks, { title: 'MBM Handbook: Customer Value' }],
  } });
  assert.deepEqual(withTwoBooks.items[0].related_textbooks, [], 'two books is ambiguous, so do not guess');
});

test('assignment JSON repair keeps the original 16384-token output budget', async () => {
  const promptTemplate = await readFile(MINING_PROMPT_PATH, 'utf8');
  let options;
  await repairMinedJson('{broken', promptTemplate, async (_prompt, invokeOptions) => {
    options = invokeOptions;
    return '{"items":[]}';
  });
  assert.equal(options.maxTokens, 16384);
});

test('assignment JSON repair re-sends the full mining schema', async () => {
  const promptTemplate = await readFile(MINING_PROMPT_PATH, 'utf8');
  const schema = promptTemplate.match(/## Output schema[\s\S]*?```(?:json)?\s*([\s\S]*?)```/)[1].trim();
  let repairPrompt;
  await repairMinedJson('{broken', promptTemplate, async prompt => {
    repairPrompt = prompt;
    return '{"items":[]}';
  });
  assert.ok(repairPrompt.includes(schema));
  assert.ok(repairPrompt.includes('"due_confidence": "high | medium | low"'));
});

test('assignment JSON repair salvages a truncated repair response', async () => {
  const promptTemplate = await readFile(MINING_PROMPT_PATH, 'utf8');
  const repair = await repairMinedJson('{broken', promptTemplate, async () =>
    'Here is the JSON {as requested}:\n```json\n{"items":[{"id":"kept","title":"Complete"},{"id":"cut off');
  assert.equal(repair.truncated, true);
  assert.deepEqual(repair.parsed, {
    items: [{ id: 'kept', title: 'Complete' }],
  });
});

// --- Same-or-stronger repair pinning ----------------------------------------
//
// The mining repair is the worst case of the pattern: the longest JSON in the
// pipeline, and a repair prompt that carries the broken output and the schema
// but never the corpus. A backend weaker than the one that just failed does
// not repair that — it invents it.

test('the mining repair is pinned to the tier that answered the first attempt', async () => {
  const promptTemplate = await readFile(MINING_PROMPT_PATH, 'utf8');
  let options;
  await repairMinedJson('{broken', promptTemplate, async (_prompt, invokeOptions) => {
    options = invokeOptions;
    return '{"items":[]}';
  }, sameOrStronger({ backend: 'local', tier: 'standard', profile: 'local-standard' }));
  assert.deepEqual(options.needs, { tier: 'standard' });
  assert.equal(options.maxTokens, 16384, 'the pin must not disturb the v1.8.6 output budget');
});

test('a mining attempt that never answered pins nothing at all', async () => {
  const promptTemplate = await readFile(MINING_PROMPT_PATH, 'utf8');
  let options;
  await repairMinedJson('{broken', promptTemplate, async (_prompt, invokeOptions) => {
    options = invokeOptions;
    return '{"items":[]}';
  }, sameOrStronger({}));
  assert.ok(!('needs' in options), `expected no pin, got ${JSON.stringify(options.needs)}`);
});

test('a mining repair cannot fall to a weaker backend than the attempt it repairs', async () => {
  // End to end through the real main(), with the failover the pin exists for:
  // the claude CLI is signed in for the first attempt and signed out by the
  // time the repair asks, leaving only the local model. Pinned to `strong`,
  // the repair refuses, and mining fails with its .ERROR sidecar instead of
  // writing an item list reconstructed by a 4-bit model.
  const tmpDir = await mkdtemp(join(tmpdir(), 'ccsync-mine-pin-'));
  const classDir = join(tmpDir, 'class');
  await mkdir(classDir, { recursive: true });
  await writeFile(join(classDir, 'assignments.json'), '[]', 'utf8');

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
  await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const localPy = join(bin, 'local-python');
  await writeFile(localPy,
    '#!/bin/sh\ncat >/dev/null\nprintf \'{"items":[{"id":"invented","title":"RECONSTRUCTED BY LOCAL"}]}\\n\'\n',
    { mode: 0o755 });

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, '..', 'mine-assignments.js'), classDir], {
      env: {
        ...process.env,
        CLAUDE_SKIP: '',
        CANVAS_SYNC_HOME: tmpDir,
        CSYNC_AI_BACKEND: 'auto',
        CSYNC_CLAUDE_BIN: claude,
        CSYNC_CODEX_BIN: join(bin, 'codex'),
        CSYNC_LOCAL_PYTHON: localPy,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.stdout.on('data', () => {});
    child.on('close', code => resolve({ code, stderr }));
    child.on('error', reject);
  });

  assert.equal(result.code, 1, `mining must fail rather than accept a weaker repair. stderr: ${result.stderr}`);
  assert.match(result.stderr, /tier strong/, 'the failure must name the tier that could not be met');
  assert.match(await readFile(join(classDir, 'assignments_mined.json.ERROR'), 'utf8'), /\{broken/);
  await assert.rejects(readFile(join(classDir, 'assignments_mined.json'), 'utf8'),
    'nothing invented by the weaker backend may be written');
  await rm(tmpDir, { recursive: true, force: true });
});
