import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planEventsForClass, filterFutureAssignments, contentHash } from '../lib/planner.js';

async function makeClassDir({ code = 'TEST 101', now = new Date(), dueInDays = 3 }) {
  const root = await mkdtemp(join(tmpdir(), 'csync-cal-'));
  const classDir = join(root, 'classes', '12345-test-101');
  await mkdir(join(classDir, 'AI_CONTEXT'), { recursive: true });

  await writeFile(join(classDir, 'metadata.json'), JSON.stringify({
    id: 12345,
    name: 'Test Course',
    course_code: code,
    time_zone: 'America/Chicago',
  }, null, 2));

  const due = new Date(now.getTime() + dueInDays * 86400 * 1000);
  await writeFile(join(classDir, 'assignments.json'), JSON.stringify([
    {
      id: '999',
      name: 'Problem Set 1',
      due_at: due.toISOString(),
      points_possible: 20,
      submission_types: ['online_upload'],
      html_url: 'https://canvas.rice.edu/courses/12345/assignments/999',
      description: '<p>Do the problems.</p>',
      assignment_group: { name: 'Homework', group_weight: 30 },
    },
    {
      id: '1000',
      name: 'Stale Assignment',
      due_at: new Date(now.getTime() - 86400 * 1000).toISOString(),
      points_possible: 10,
      submission_types: ['online_upload'],
      html_url: 'https://canvas.rice.edu/courses/12345/assignments/1000',
    },
  ], null, 2));

  await writeFile(join(classDir, 'AI_CONTEXT', 'context.md'),
    `# ${code}\n\nSyllabus: readings weeks 1-3.`);

  return { root, classDir };
}

test('filterFutureAssignments drops past due_at', () => {
  const now = new Date('2026-04-21T00:00:00Z');
  const future = filterFutureAssignments([
    { due_at: '2026-04-22T00:00:00Z' },
    { due_at: '2026-04-20T00:00:00Z' },
    { due_at: null },
    { due_at: 'not-a-date' },
  ], now);
  assert.equal(future.length, 1);
});

test('planner stub returns one event per future assignment under CLAUDE_SKIP', async () => {
  process.env.CLAUDE_SKIP = '1';
  const now = new Date();
  const { root, classDir } = await makeClassDir({ now });
  try {
    const plan = await planEventsForClass({ classDir, now });
    assert.equal(plan.events.length, 1);
    assert.equal(plan.events[0].canvasAssignmentId, '999');
    assert.equal(plan.events[0].kind, 'assignment');
    assert.ok(plan.events[0].title.startsWith('[TEST 101]'));
    assert.ok(plan.events[0].htmlUrl);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('contentHash is stable across runs', () => {
  const ev = {
    title: 't', startISO: 's', endISO: 'e', description: 'd', reminders: [60], location: null,
  };
  assert.equal(contentHash(ev), contentHash({ ...ev }));
  assert.notEqual(contentHash(ev), contentHash({ ...ev, description: 'x' }));
});
