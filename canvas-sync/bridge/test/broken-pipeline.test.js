import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brokenPipelinePlan } from '../broken-pipeline.js';

const ALLOWED = ['parse', 'extract', 'index', 'mine', 'graph', 'build', 'calendar'];
const ENABLED = Object.fromEntries(ALLOWED.map(stage => [stage, true]));

test('broken plan retries only failed class stages and the broken global calendar', () => {
  const progress = {
    classes: [
      {
        folder: '101-live-course', inScope: true,
        stages: [
          { key: 'parse', state: 'done', counted: true },
          { key: 'mine', state: 'failed', counted: true },
          { key: 'build', state: 'stale', counted: true },
        ],
        categories: [],
      },
      {
        folder: '202-old-course', inScope: false,
        stages: [{ key: 'mine', state: 'failed', counted: true }],
        categories: [],
      },
    ],
    global: { calendar: { state: 'failed' } },
  };

  assert.deepEqual(brokenPipelinePlan(progress, {
    allowedStageKeys: ALLOWED,
    enabled: ENABLED,
  }), {
    targets: [{ folder: '101-live-course', stages: ['mine'] }],
    calendar: true,
    targetCount: 2,
  });
});

test('partial file failures retry extract once while successful files stay inside that job', () => {
  const progress = {
    classes: [{
      folder: '101-live-course', inScope: true,
      stages: [{ key: 'extract', state: 'done', counted: true }],
      categories: [{ key: 'files', state: 'error', failed: 3, indexed: 8 }],
    }],
    global: { calendar: { state: 'complete' } },
  };
  const plan = brokenPipelinePlan(progress, { allowedStageKeys: ALLOWED, enabled: ENABLED });
  assert.deepEqual(plan.targets, [{ folder: '101-live-course', stages: ['extract'] }]);
  assert.equal(plan.targetCount, 1, 'one selective extract job retries all three failed files');
});

test('a stage disabled in Settings is never offered as broken work', () => {
  const progress = {
    classes: [{
      folder: '101-live-course', inScope: true,
      stages: [
        { key: 'mine', state: 'failed', counted: true },
        { key: 'extract', state: 'failed', counted: true },
      ],
      categories: [],
    }],
    global: { calendar: { state: 'error' } },
  };
  const plan = brokenPipelinePlan(progress, {
    allowedStageKeys: ALLOWED,
    enabled: { ...ENABLED, mine: false, calendar: false },
  });
  assert.deepEqual(plan, {
    targets: [{ folder: '101-live-course', stages: ['extract'] }],
    calendar: false,
    targetCount: 1,
  });
});

test('an empty enabled configuration offers no broken stages', () => {
  const progress = {
    classes: [{
      folder: '101-live-course', inScope: true,
      stages: [
        { key: 'mine', state: 'failed', counted: true },
        { key: 'extract', state: 'done', counted: true },
      ],
      categories: [{ key: 'files', state: 'error', failed: 1 }],
    }],
    global: { calendar: { state: 'error' } },
  };

  assert.deepEqual(brokenPipelinePlan(progress, {
    allowedStageKeys: ALLOWED,
    enabled: {},
  }), { targets: [], calendar: false, targetCount: 0 });
});

test('target count equals the number of selections in the shared plan', () => {
  const progress = {
    classes: [
      {
        folder: '101-live-course', inScope: true,
        stages: [
          { key: 'mine', state: 'failed', counted: true },
          { key: 'build', state: 'error', counted: true },
        ],
        categories: [],
      },
      {
        folder: '202-live-course', inScope: true,
        stages: [{ key: 'extract', state: 'done', counted: true }],
        categories: [{ key: 'files', failed: 2 }],
      },
    ],
    global: { calendar: { state: 'interrupted' } },
  };
  const plan = brokenPipelinePlan(progress, { allowedStageKeys: ALLOWED, enabled: ENABLED });
  const planLength = plan.targets.reduce((sum, target) => sum + target.stages.length, 0)
    + Number(plan.calendar);

  assert.equal(plan.targetCount, planLength);
});
