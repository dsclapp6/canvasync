// Regression tests for the three ways this package could touch things it must
// not: pushing events for classes outside the saved selection, linking quiz
// assignments to the teacher-view URL, and prune deleting live events on
// missing bookkeeping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listClassDirs, prune } from '../lib/sync.js';
import { planEventsForClass } from '../lib/planner.js';

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'csync-cal-home-'));
  await mkdir(join(home, 'classes'), { recursive: true });
  return home;
}

async function withHome(home, fn) {
  const prev = process.env.CANVAS_SYNC_HOME;
  process.env.CANVAS_SYNC_HOME = home;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.CANVAS_SYNC_HOME;
    else process.env.CANVAS_SYNC_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

// --- selection scope --------------------------------------------------------

test('listClassDirs honors the saved selection as a strict allowlist', async () => {
  const home = await makeHome();
  await withHome(home, async () => {
    for (const d of ['93903-busi-305', '94001-busi-396', '80000-old-orientation']) {
      await mkdir(join(home, 'classes', d), { recursive: true });
    }
    await mkdir(join(home, 'classes', 'not-a-class-dir'), { recursive: true });
    await writeFile(join(home, 'sync-scope.json'),
      JSON.stringify({ courseIds: ['93903', '94001'] }));
    const dirs = await listClassDirs();
    const names = dirs.map(d => d.split('/').pop()).sort();
    assert.deepEqual(names, ['93903-busi-305', '94001-busi-396']);
  });
});

test('listClassDirs: an EMPTY saved selection syncs nothing', async () => {
  const home = await makeHome();
  await withHome(home, async () => {
    await mkdir(join(home, 'classes', '93903-busi-305'), { recursive: true });
    await writeFile(join(home, 'sync-scope.json'), JSON.stringify({ courseIds: [] }));
    assert.deepEqual(await listClassDirs(), []);
  });
});

test('listClassDirs: no saved scope means everything (never hide on no data)', async () => {
  const home = await makeHome();
  await withHome(home, async () => {
    await mkdir(join(home, 'classes', '93903-busi-305'), { recursive: true });
    const dirs = await listClassDirs();
    assert.equal(dirs.length, 1);
  });
});

// --- student-facing URLs ----------------------------------------------------

test('planner links quiz-backed assignments to the quiz URL, not the teacher view', async () => {
  process.env.CLAUDE_SKIP = '1';
  const root = await mkdtemp(join(tmpdir(), 'csync-cal-quiz-'));
  const classDir = join(root, 'classes', '93903-busi-305');
  await mkdir(join(classDir, 'AI_CONTEXT'), { recursive: true });
  await writeFile(join(classDir, 'metadata.json'),
    JSON.stringify({ id: 93903, course_code: 'BUSI 305' }));
  const due = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
  await writeFile(join(classDir, 'assignments.json'), JSON.stringify([{
    id: '532620',
    name: 'Quiz 4',
    due_at: due,
    quiz_id: 244811,
    submission_types: ['online_quiz'],
    html_url: 'https://canvas.rice.edu/courses/93903/assignments/532620',
  }]));
  try {
    const plan = await planEventsForClass({ classDir });
    assert.equal(plan.events.length, 1);
    assert.equal(plan.events[0].htmlUrl, 'https://canvas.rice.edu/courses/93903/quizzes/244811');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- prune safety -----------------------------------------------------------

test('prune skips entries with no lastPushedAt instead of treating them as 1970', async () => {
  const home = await makeHome();
  await withHome(home, async () => {
    await mkdir(join(home, 'calendar'), { recursive: true });
    await writeFile(join(home, 'calendar', 'config.json'),
      JSON.stringify({ calendarId: 'cal-1' }));
    await writeFile(join(home, 'calendar', 'mapping.json'), JSON.stringify({
      'a|assignment': { googleEventId: 'g1' },                                   // no timestamp — unknown, keep
      'b|assignment': { googleEventId: 'g2', lastPushedAt: new Date().toISOString() }, // fresh — keep
      'c|assignment': { googleEventId: 'g3', lastPushedAt: '2026-01-01T00:00:00Z' },   // actually stale
    }));
    const result = await prune({ dryRun: true, logger: { log() {} } });
    assert.equal(result.deleted, 1);
  });
});
