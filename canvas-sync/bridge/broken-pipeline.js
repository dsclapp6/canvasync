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
  const byFolder = new Map();

  const add = (folder, stage) => {
    if (!folder || !allowed.has(stage) || enabled[stage] !== true) return;
    if (!byFolder.has(folder)) byFolder.set(folder, new Set());
    byFolder.get(folder).add(stage);
  };

  const classes = Array.isArray(progress?.classes) ? progress.classes : [];
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
  const calendar = allowed.has('calendar')
    && enabled.calendar === true
    && RETRYABLE_STATES.has(calendarState);

  const targets = [...byFolder.entries()].map(([folder, stages]) => ({
    folder,
    stages: [...stages],
  }));
  const targetCount = targets.reduce((sum, target) => sum + target.stages.length, 0)
    + (calendar ? 1 : 0);

  return { targets, calendar, targetCount };
}
