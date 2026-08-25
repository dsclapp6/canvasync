import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..');
const FIXTURES_DIR = join(SCRIPTS_DIR, 'test-fixtures', 'sample-class');

function runBuildContext(classDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_SKIP: '1' };
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, 'build-context.js'), classDir], {
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
  tmpDir = await mkdtemp(join(tmpdir(), 'ccsync-build-test-'));
  classDir = join(tmpDir, 'sample-class');
  await cp(FIXTURES_DIR, classDir, { recursive: true });
});

test('build-context writes context.md with required headings', async () => {
  const result = await runBuildContext(classDir);
  assert.equal(result.code, 0, `Expected exit 0 but got ${result.code}. stderr: ${result.stderr}`);

  const mdPath = join(classDir, 'AI_CONTEXT', 'context.md');
  const md = await readFile(mdPath, 'utf8');

  const requiredHeadings = [
    '## Grading breakdown',
    '## Complete task list',
    '## Full Canvas assignment list',
    '### Upcoming',
    '### Past (last 30 days)',
    '### Past (older)',
    '## Syllabus schedule',
    '## Course modules',
    '## Recent announcements',
    '## Discussions',
    '## Course calendar events',
    '## Policies',
    '## Open questions / ambiguities'
  ];

  for (const heading of requiredHeadings) {
    assert.ok(md.includes(heading), `Missing heading: "${heading}"`);
  }
});

test('build-context lists all 4 assignments in context.md', async () => {
  const mdPath = join(classDir, 'AI_CONTEXT', 'context.md');
  const md = await readFile(mdPath, 'utf8');

  const assignmentNames = ['Problem Set 3', 'Midterm Exam', 'Problem Set 2', 'Problem Set 1'];
  for (const name of assignmentNames) {
    assert.ok(md.includes(name), `Assignment not found in context.md: "${name}"`);
  }
});

test('build-context produces non-empty Open questions section', async () => {
  const mdPath = join(classDir, 'AI_CONTEXT', 'context.md');
  const md = await readFile(mdPath, 'utf8');

  const oqIdx = md.indexOf('## Open questions / ambiguities');
  assert.ok(oqIdx !== -1, 'Open questions section missing');

  const afterHeading = md.slice(oqIdx + '## Open questions / ambiguities'.length).trim();
  assert.ok(afterHeading.length > 0, 'Open questions section is empty');
});

test('build-context writes parseable context.json with correct top-level keys', async () => {
  const jsonPath = join(classDir, 'AI_CONTEXT', 'context.json');
  const raw = await readFile(jsonPath, 'utf8');
  const obj = JSON.parse(raw);

  const requiredKeys = ['last_synced', 'course', 'grading', 'assignments', 'modules', 'recent_announcements', 'policies', 'open_questions'];
  for (const key of requiredKeys) {
    assert.ok(key in obj, `Missing top-level key in context.json: "${key}"`);
  }

  assert.ok(obj.assignments && 'upcoming' in obj.assignments, 'assignments.upcoming missing');
  assert.ok(obj.assignments && 'recent_past' in obj.assignments, 'assignments.recent_past missing');
  assert.ok(obj.assignments && 'older_past' in obj.assignments, 'assignments.older_past missing');
});

test('build-context writes recent last_built.txt', async () => {
  const lastBuiltPath = join(classDir, 'AI_CONTEXT', 'last_built.txt');
  const raw = (await readFile(lastBuiltPath, 'utf8')).trim();
  const d = new Date(raw);
  assert.ok(!isNaN(d.getTime()), 'last_built.txt is not a valid ISO date');

  const ageMs = Date.now() - d.getTime();
  assert.ok(ageMs < 60000, `last_built.txt timestamp is too old (${ageMs}ms)`);
});
