import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brokenPipelinePlan, brokenRunFailure } from '../broken-pipeline.js';

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

// --- how a failure in the broken-run branch is reported ---------------------
//
// That branch is the only part of POST /api/pipeline/run that awaits, and it
// shipped with no try/catch. Express 4 does not forward an async rejection to
// the terminal handler, so the request hung and — with no unhandledRejection
// handler registered — Node >= 15 took the WHOLE BRIDGE down mid-request:
// every dashboard and the extension's ingest target, until the app was
// relaunched. routes/index-progress.js:356-362 states the same rule two files
// away. These pin the answer the route now gives instead.

test('a stale bridge is told to restart, not shown a missing-export message', () => {
  // The real trigger: the branch lazily imports scripts/index-progress.js, so
  // it links against the modules this process loaded at STARTUP. Editing that
  // file under a running bridge fails with a SyntaxError that reads like the
  // module is broken rather than like the process is old.
  const err = new SyntaxError("does not provide an export named 'indexProgress'");
  const { status, body } = brokenRunFailure(err);
  assert.equal(status, 503, 'a stale process is temporary — 503, not 500');
  assert.match(body.detail, /does not provide an export named/, 'keep the underlying cause');
  assert.match(body.detail, /Quit CANVASync and open it again/, 'and name the action that fixes it');
});

test('any other failure is a plain 500 that still says what happened', () => {
  // The other half. A mapping that answered 503 to everything would pass the
  // test above while telling a user with a genuine bug to keep restarting.
  const { status, body } = brokenRunFailure(new Error('ENOSPC: no space left on device'));
  assert.equal(status, 500);
  assert.equal(body.detail, 'ENOSPC: no space left on device');
  assert.doesNotMatch(body.detail, /Quit CANVASync/,
    'a disk fault is not a stale bridge and must not be reported as one');
});

test('a non-Error rejection still produces a shape-stable response', () => {
  // A rejection is not guaranteed to be an Error. The route must still answer
  // with the same JSON shape rather than throwing inside its own catch.
  for (const thrown of ['a bare string', null, undefined, 42]) {
    const { status, body } = brokenRunFailure(thrown);
    assert.equal(status, 500, `${JSON.stringify(thrown)} should map to 500`);
    assert.equal(body.error, 'run broken failed');
    assert.equal(typeof body.detail, 'string', `${JSON.stringify(thrown)} lost its detail`);
    assert.ok(body.detail.length > 0);
  }
});
