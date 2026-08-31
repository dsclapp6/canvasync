// Turn the read-only progress payload into the smallest safe retry plan.
// This stays separate from trigger.js so deciding what is broken remains a
// pure operation that can be tested without spawning pipeline processes.

const RETRYABLE_STATES = new Set(['failed', 'interrupted', 'error']);

/**
 * Return per-class stage targets plus the one global calendar target.
 *
 * A failed course-file extraction is deliberately represented by the files
 * category rather than by a failed extract stage: extract-course-files.js can
 * finish successfully while one PDF is unreadable. Re-running that class's
 * extract stage is still selective because the script skips files already
 * marked done and retries only pending/failed entries.
 */
export function brokenPipelinePlan(progress, {
  allowedStageKeys = [],
  enabled = {},
} = {}) {
  const allowed = new Set(allowedStageKeys);
  const stageAvailability = Object.fromEntries(
    [...allowed].map(stage => [stage, enabled[stage] === true]));
  const byFolder = new Map();

  const add = (folder, stage) => {
    if (!folder || !allowed.has(stage) || stageAvailability[stage] !== true) return;
    if (!byFolder.has(folder)) byFolder.set(folder, new Set());
    byFolder.get(folder).add(stage);
  };

  const classes = Array.isArray(progress?.classes) ? progress.classes : [];
  const hasInScopeClass = classes.some(cls =>
    cls && cls.inScope !== false && typeof cls.folder === 'string');
  for (const cls of classes) {
    if (!cls || cls.inScope === false || typeof cls.folder !== 'string') continue;
    const stages = Array.isArray(cls.stages) ? cls.stages : [];
    for (const stage of stages) {
      if (!stage || stage.counted === false) continue;
      if (RETRYABLE_STATES.has(String(stage.state))) add(cls.folder, stage.key);
    }

    // Partial extraction failures do not make the stage itself fail. They are
    // nevertheless broken work and are exactly what this action should retry.
    const files = (Array.isArray(cls.categories) ? cls.categories : [])
      .find(category => category?.key === 'files');
    if (Number(files?.failed) > 0) {
      const extract = stages.find(stage => stage?.key === 'extract');
      if (extract?.counted !== false) add(cls.folder, 'extract');
    }
  }

  const calendarState = String(progress?.global?.calendar?.state ?? '');
  const calendar = hasInScopeClass
    && allowed.has('calendar')
    && stageAvailability.calendar === true
    && RETRYABLE_STATES.has(calendarState);

  const targets = [...byFolder.entries()].map(([folder, stages]) => ({
    folder,
    stages: [...stages],
  }));
  const targetCount = targets.reduce((sum, target) => sum + target.stages.length, 0)
    + (calendar ? 1 : 0);

  return { targets, calendar, targetCount, stageAvailability };
}

/**
 * How a failure inside the broken-run branch should be reported.
 *
 * Extracted for the same reason brokenPipelinePlan above is: the route's awaits
 * cannot be made to reject from a test — indexProgress is defensive enough to
 * survive an unreadable data root — so the decision is separated from the
 * plumbing and tested directly.
 *
 * The distinction that matters is STALE BRIDGE vs everything else. That branch
 * lazily imports scripts/index-progress.js, so it links against the modules
 * THIS process loaded at startup; a bridge left running across an edit to that
 * file fails with a SyntaxError whose message reads like a missing export
 * rather than a stale process. runAsk already answers that case with the one
 * instruction the user can act on, and this says the same thing.
 */
export function brokenRunFailure(err) {
  const stale = err instanceof SyntaxError;
  const message = err?.message ?? String(err);
  return {
    status: stale ? 503 : 500,
    body: {
      error: 'run broken failed',
      detail: stale
        ? `${message} — this bridge has been running since before that file changed. Quit CANVASync and open it again.`
        : message,
    },
  };
}
