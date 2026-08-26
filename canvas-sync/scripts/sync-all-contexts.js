import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { classHome, readJsonSafe, sha256File, stageEnabled } from './_util.js';
import { readSyncScope, isInScope, CLASS_DIR_RE } from '../scope.js';
// Name only — importing the constant keeps the output filename in one place.
// correlation-graph.js is pure and side-effect-free, so this costs a parse.
import { GRAPH_FILE } from './correlation-graph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getMtime(filePath) {
  try {
    const s = await stat(filePath);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

async function needsParse(classDir) {
  // Same three sources trigger.js watches — and the NEWEST of them decides,
  // so an updated syllabus.html next to an older pdf still re-fires parse.
  const sources = ['syllabus.pdf', 'syllabus.html', 'syllabus.docx']
    .map(n => join(classDir, n))
    .filter(p => existsSync(p));
  if (sources.length === 0) return false;

  const parsedPath = join(classDir, 'syllabus_parsed.json');
  if (!existsSync(parsedPath)) return true;

  const sourceMtimes = await Promise.all(sources.map(getMtime));
  const newestSource = Math.max(...sourceMtimes.map(m => m ?? 0));
  const parsedMtime = await getMtime(parsedPath);
  const mtimeNewer = !!(newestSource && parsedMtime && newestSource > parsedMtime);

  // Nothing looks newer than the parsed output → definitely not stale. (A real
  // content change always bumps the source mtime, so this can't hide one.)
  if (!mtimeNewer) return false;

  // mtime IS newer — but the bridge rewrites syllabus.html on every ingest even
  // when the bytes are identical, so mtime alone would re-fire the expensive AI
  // parse on every single sync, forever. Confirm with the content hash: stale
  // only if the stored hash matches NONE of the current sources (a genuine
  // change). syllabus.hash is the sha256 of whichever syllabus file the bridge
  // stored it for — not necessarily sources[0] — so compare against every one.
  const hashPath = join(classDir, 'syllabus.hash');
  if (existsSync(hashPath)) {
    try {
      const storedHash = (await import('node:fs')).readFileSync(hashPath, 'utf8').trim();
      const currentHashes = await Promise.all(sources.map(sha256File));
      return !currentHashes.includes(storedHash);
    } catch { /* fall through to the mtime signal */ }
  }

  // No usable hash to disprove the change — trust the mtime signal.
  return true;
}

const DATA_FILES = [
  'assignments.json', 'assignment_groups.json', 'modules.json', 'announcements.json',
  'pages.json', 'quizzes.json', 'discussions.json', 'calendar_events.json',
  'grades.json', 'tabs.json',
  'files_index.json', 'metadata.json', 'syllabus_parsed.json', 'assignments_mined.json',
  'readings_index.json',
  'materials/last_extracted.txt',
];

// Inputs to the mining stage — everything except its own output, and minus
// files that change constantly without affecting the task list (grades) so
// they don't re-fire the AI job on every sync.
const MINE_EXCLUDE = new Set(['assignments_mined.json', 'files_index.json', 'metadata.json', 'grades.json', 'tabs.json']);
const MINE_SOURCES = DATA_FILES.filter(f => !MINE_EXCLUDE.has(f));

async function outputStale(classDir, outRelPath, sourceRelPaths) {
  const outMtime = await getMtime(join(classDir, outRelPath));
  if (!outMtime) {
    // Only rebuild a missing output if at least one source exists.
    for (const f of sourceRelPaths) {
      if (await getMtime(join(classDir, f))) return true;
    }
    return false;
  }
  for (const f of sourceRelPaths) {
    const m = await getMtime(join(classDir, f));
    if (m && m > outMtime) return true;
  }
  return false;
}

async function needsExtract(classDir) {
  return outputStale(classDir, 'materials/last_extracted.txt', ['files_index.json']);
}

async function needsMine(classDir) {
  return outputStale(classDir, 'assignments_mined.json', MINE_SOURCES);
}

async function needsReadingIndex(classDir) {
  return outputStale(classDir, 'readings_index.json', [
    'metadata.json', 'syllabus_parsed.json', 'syllabus.html',
    'files_index.json', 'materials/last_extracted.txt',
  ]);
}

async function needsBuild(classDir) {
  return outputStale(classDir, join('AI_CONTEXT', 'last_built.txt'), DATA_FILES);
}

// Everything buildGraph() actually opens (see loadClass() in
// correlation-graph.js), plus the extraction stamp standing in for the
// materials/*.txt bodies it reads through files_index.json's materialsPath.
// Deliberately NOT DATA_FILES: that list carries files the graph never reads
// (grades.json, tabs.json, assignment_groups.json) and would rebuild the graph
// for a changed grade, and it omits syllabus.html, which the graph does read.
// Keep it in step with loadClass if the graph learns to read something new.
const GRAPH_SOURCES = [
  'files_index.json', 'assignments.json', 'modules.json', 'pages.json',
  'quizzes.json', 'announcements.json', 'discussions.json', 'metadata.json',
  'syllabus.html', 'materials/last_extracted.txt',
];

// correlation_graph.json is deliberately absent from DATA_FILES: nothing the
// build stage opens reads it off disk yet (build-pack.js calls buildGraph in
// process), so listing it there would only make every class's first graph
// re-fire the AI-backed context build for a file it never opens. When a
// consumer starts reading the file, add GRAPH_FILE to DATA_FILES — and to
// MINE_EXCLUDE at the same time, or the miner will re-fire on the graph its
// own run produced, every sync, forever.
async function needsGraph(classDir) {
  return outputStale(classDir, GRAPH_FILE, GRAPH_SOURCES);
}

function runScript(scriptName, classDir, label) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [join(__dirname, scriptName), classDir], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', () => {});

    child.on('close', (code) => {
      const duration = Date.now() - start;
      resolve({ ok: code === 0, duration, stderr });
    });

    child.on('error', (err) => {
      resolve({ ok: false, duration: Date.now() - start, stderr: err.message });
    });
  });
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

async function processClass(classDir, classDirName, limit) {
  const result = {
    class: classDirName,
    action: 'none',
    duration: 0,
    outcome: 'ok'
  };

  const startTotal = Date.now();
  const ran = [];

  // Full per-class pipeline, in dependency order. Each stage re-checks
  // staleness after the previous one ran, so one pass brings the class
  // fully up to date: parse → extract → reading index → mine → graph → context/pack.
  //
  // graph sits second-to-last on purpose. It scores every item against every
  // other from the text, so it MUST run after extract: the materials/*.txt
  // bodies are its entire lexical dimension, and a graph built before the
  // extraction scores a class on its titles alone. It MUST run before build,
  // so the context/pack stage can read a graph derived from the same data it
  // is packing, this run rather than next. Between those two, last: mining is
  // the final stage that adds to the class's own data, so ending the
  // derivation chain with the graph keeps it the newest artifact in the dir
  // and leaves the order already right if it ever reads the mined items.
  // Unlike its neighbours this stage is pure local CPU — tens of milliseconds
  // for a 93-node class, no model, no network.
  const stages = [
    ['parse',   'parse-syllabus.js',       needsParse],
    ['extract', 'extract-course-files.js', needsExtract],
    // Not model-backed and intentionally has no dashboard kill switch. The
    // readings floor is a correctness invariant, not an AI feature.
    ['index',   'index-readings.js',       needsReadingIndex],
    ['mine',    'mine-assignments.js',     needsMine],
    ['graph',   'build-graph.js',          needsGraph],
    ['build',   'build-context.js',        needsBuild],
  ];

  for (const [label, script, check] of stages) {
    // The dashboard's Functions switches (CSYNC_STAGE_* in settings.json)
    // govern this orchestrator too — a stage the user turned off must not run
    // from the CLI either, or "off" only means "off until someone force-syncs".
    if (label !== 'index' && !(await stageEnabled(label))) continue;
    if (!(await check(classDir))) continue;
    ran.push(label);
    const r = await runScript(script, classDir, label);
    if (!r.ok) {
      result.action = ran.join('+');
      result.outcome = 'error';
      result.duration = Date.now() - startTotal;
      process.stderr.write(`  [${classDirName}] ${label} failed: ${r.stderr.slice(0, 300)}\n`);
      return result;
    }
  }

  if (ran.length > 0) result.action = ran.join('+');
  result.duration = Date.now() - startTotal;
  return result;
}

async function withConcurrency(tasks, limit) {
  const results = [];
  const queue = [...tasks];
  const active = [];

  async function runNext() {
    if (queue.length === 0) return;
    const task = queue.shift();
    const p = task().then(r => {
      results.push(r);
      const idx = active.indexOf(p);
      if (idx !== -1) active.splice(idx, 1);
      return runNext();
    });
    active.push(p);
  }

  const initialBatch = Math.min(limit, tasks.length);
  for (let i = 0; i < initialBatch; i++) {
    runNext();
  }

  while (active.length > 0) {
    await Promise.race(active);
  }

  return results;
}

async function main() {
  const home = classHome();
  process.stderr.write(`Scanning: ${home}\n`);

  let classDirs = [];
  try {
    const entries = await readdir(home, { withFileTypes: true });
    // CLASS_DIR_RE, not a bare isDirectory(). This loop is the EXPENSIVE
    // enumerator — it fans the whole AI pipeline out per entry — and it used
    // to accept any directory at all under classes/, so a stray folder got
    // parse-syllabus, mine-assignments and build-context spawned on it, each
    // one queueing behind a ~12 GB model load. bridge/trigger.js fixed the same
    // bug on its own copy of this loop; scope.js now exports the matcher so
    // there is only one rule left to get right.
    const rejected = entries.filter(e => e.isDirectory() && !CLASS_DIR_RE.test(e.name)).map(e => e.name);
    if (rejected.length) {
      process.stderr.write(`Ignoring ${rejected.length} non-class director${rejected.length === 1 ? 'y' : 'ies'} under classes/: ${rejected.join(', ')}\n`);
    }
    classDirs = entries
      .filter(e => e.isDirectory() && CLASS_DIR_RE.test(e.name))
      .map(e => ({ name: e.name, path: join(home, e.name) }));
  } catch (err) {
    process.stderr.write(`Failed to read classes dir: ${err.message}\n`);
    process.exit(1);
  }

  if (classDirs.length === 0) {
    process.stderr.write('No class directories found.\n');
    printSummary([]);
    process.exit(0);
  }

  // Only pipeline the classes the extension is actually syncing. Canvas keeps
  // every past semester's enrollment "active", so without this the AI stages
  // re-ran over two years of dead classes on every sync — the slowest and most
  // expensive part of the run, spent entirely on data the user never asked for.
  // Derive the data root from the classes dir rather than calling dataRoot()
  // directly, so a caller pointed at a fixture tree reads that tree's scope
  // (i.e. none) instead of the real installation's.
  const scope = readSyncScope(dirname(home));
  if (scope.courseIds) {
    const before = classDirs.length;
    classDirs = classDirs.filter(d => isInScope(scope, d.name));
    const skipped = before - classDirs.length;
    if (skipped > 0) {
      process.stderr.write(`Scope (${scope.source}): skipping ${skipped} class(es) outside the current selection.\n`);
    }
  }

  if (classDirs.length === 0) {
    process.stderr.write('No class directories in the current sync scope.\n');
    printSummary([]);
    process.exit(0);
  }

  process.stderr.write(`Found ${classDirs.length} class(es).\n`);

  // Resource-adaptive concurrency (same policy as bridge/trigger.js): the AI
  // stages additionally serialize on the machine-wide local-model lock, so
  // this cap mostly paces the cheap extraction work.
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  const freeGb = os.freemem() / (1024 ** 3);
  const envN = parseInt(process.env.CSYNC_MAX_JOBS ?? '', 10);
  const limit = envN >= 1 ? Math.min(envN, 8)
    : (cores <= 4 || freeGb < 2) ? 1
    : (freeGb < 4 || cores <= 8) ? 2
    : 3;
  process.stderr.write(`Concurrency: ${limit}\n`);

  const tasks = classDirs.map(({ name, path }) => () => processClass(path, name, limit));
  const results = await withConcurrency(tasks, limit);

  // Refresh the calendar worklist for the user's Claude routine (deterministic, cheap).
  if (await stageEnabled('calendar')) {
    const cal = await runScript('sync-calendar.js', home, 'calendar');
    if (!cal.ok) process.stderr.write(`  calendar worklist failed: ${cal.stderr.slice(0, 200)}\n`);
  } else {
    process.stderr.write('  calendar worklist: off in settings, skipped\n');
  }

  printSummary(results);

  // Exit code policy: partial failure is normal (one bad PDF must not turn a
  // launchd job red), but EVERY class failing means the orchestration itself
  // is broken — expired OAuth, missing model — and a wrapper that sees exit 0
  // lets AI_CONTEXT quietly stay weeks stale.
  const allFailed = results.length > 0 && results.every(r => r.outcome === 'error');
  process.exit(allFailed ? 1 : 0);
}

function printSummary(results) {
  // ACTION holds the '+'-joined stage list, and pad() TRUNCATES. The full
  // chain is now "parse+extract+index+mine+graph+build" — 36 characters — so a
  // narrower column would report a run that did everything as one that stopped
  // at "…+graph+b". Widen it with the pipeline, or the table starts lying
  // about the slowest runs, which are the ones anyone reads it for.
  const header = `${'CLASS'.padEnd(40)} ${'ACTION'.padEnd(38)} ${'MS'.padEnd(8)} OUTCOME`;
  const sep = '-'.repeat(header.length);
  process.stdout.write('\n' + sep + '\n' + header + '\n' + sep + '\n');
  for (const r of results) {
    const line = `${pad(r.class, 40)} ${pad(r.action, 38)} ${pad(r.duration, 8)} ${r.outcome}`;
    process.stdout.write(line + '\n');
  }
  process.stdout.write(sep + '\n');
  const errors = results.filter(r => r.outcome === 'error').length;
  process.stdout.write(`${results.length} class(es) processed. ${errors} error(s).\n\n`);
}

main();
