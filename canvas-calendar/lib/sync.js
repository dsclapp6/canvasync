// Top-level sync orchestrator. Walks every class dir under the sync home,
// plans events per class via Claude, then performs idempotent diffs against
// Google Calendar.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { classesDir } from './sync-home.js';
import { planEventsForClass, contentHash } from './planner.js';
import { ensureCalendar, insertEvent, patchEvent, deleteEvent } from './calendar-api.js';
import { loadMapping, saveMapping, loadConfig, eventKey } from './state.js';

export async function listClassDirs() {
  const root = classesDir();
  let entries;
  try { entries = await readdir(root); } catch { return []; }
  const dirs = [];
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const full = join(root, e);
    try {
      const s = await stat(full);
      if (s.isDirectory()) dirs.push(full);
    } catch {}
  }
  return dirs;
}

export async function syncAll({ dryRun = false, onlyClass = null, model = null, logger = console } = {}) {
  const cfg = await loadConfig();
  const timeZone = cfg.timeZone || 'America/Chicago';
  const calendarId = dryRun ? (cfg.calendarId || null) : await ensureCalendar(timeZone);

  const mapping = await loadMapping();
  const allDirs = await listClassDirs();
  const dirs = onlyClass
    ? allDirs.filter(d => d.toLowerCase().includes(onlyClass.toLowerCase()))
    : allDirs;

  if (dirs.length === 0) {
    logger.log(onlyClass
      ? `No class matched "${onlyClass}".`
      : 'No synced classes found under ' + classesDir());
    return { created: 0, updated: 0, deleted: 0, skipped: 0, unchanged: 0 };
  }

  let created = 0, updated = 0, deleted = 0, skipped = 0, unchanged = 0;

  for (const dir of dirs) {
    const slug = dir.split('/').pop();
    logger.log(`\n--- ${slug} ---`);

    let plan;
    try {
      // Pass only the entries relevant to this class so Claude has context.
      const classMapping = filterMappingForClass(mapping, dir);
      plan = await planEventsForClass({
        classDir: dir,
        existingMapping: classMapping,
        model,
      });
    } catch (err) {
      logger.error(`  planner failed: ${err.message}`);
      continue;
    }

    for (const ev of plan.events) {
      const key = eventKey({
        canvasAssignmentId: ev.canvasAssignmentId,
        kind: ev.kind,
        checkpointIndex: ev.checkpointIndex,
      });
      const hash = contentHash(ev);
      const entry = mapping[key];
      const fullEv = { ...ev, contentHash: hash, timeZone };

      if (!entry) {
        logger.log(`  + ${ev.title}`);
        if (!dryRun) {
          const result = await insertEvent(calendarId, fullEv, timeZone);
          mapping[key] = {
            googleEventId: result.id,
            contentHash: hash,
            kind: ev.kind,
            classDir: dir,
            lastPushedAt: new Date().toISOString(),
          };
          await saveMapping(mapping); // persist eagerly
        }
        created++;
      } else if (entry.contentHash !== hash) {
        logger.log(`  ~ ${ev.title}`);
        if (!dryRun) {
          await patchEvent(calendarId, entry.googleEventId, fullEv, timeZone);
          mapping[key] = { ...entry, contentHash: hash, classDir: dir, lastPushedAt: new Date().toISOString() };
          await saveMapping(mapping);
        }
        updated++;
      } else {
        unchanged++;
      }
    }

    for (const s of plan.skipped) {
      logger.log(`  · skip ${s.canvasAssignmentId}: ${s.reason}`);
      skipped++;
    }
  }

  return { created, updated, deleted, skipped, unchanged };
}

function filterMappingForClass(mapping, classDir) {
  const out = {};
  for (const [k, v] of Object.entries(mapping)) {
    if (v.classDir === classDir) out[k] = v;
  }
  return out;
}

export async function prune({ dryRun = false, logger = console } = {}) {
  // OPEN: removing stale events (ones no longer in any assignments.json).
  // Not wired to the default sync — run with `csync-calendar prune --confirm`.
  const cfg = await loadConfig();
  const calendarId = cfg.calendarId;
  if (!calendarId) throw new Error('No calendar set up yet.');
  const mapping = await loadMapping();
  let deleted = 0;
  const now = new Date();
  for (const [key, entry] of Object.entries(mapping)) {
    // A very conservative heuristic: if lastPushedAt is older than 30 days,
    // assume stale. The real logic would re-read assignments.json and check
    // membership — left as a OPEN for iteration.
    const age = now - new Date(entry.lastPushedAt || 0);
    if (age > 30 * 24 * 3600 * 1000) {
      logger.log(`  - ${key}`);
      if (!dryRun) {
        await deleteEvent(calendarId, entry.googleEventId);
        delete mapping[key];
      }
      deleted++;
    }
  }
  if (!dryRun) await saveMapping(mapping);
  return { deleted };
}
