#!/usr/bin/env node
// bump-version.js — the release ritual, done atomically.
//
// WHY THIS EXISTS, and it is not tidiness. Every version tag rewrites one or
// more package.json files, and a hand bump (an editor, `sed -i`, open(path,'w')
// in a throwaway script) TRUNCATES the file before writing it back. Node reads
// package.json to decide whether the .js files beside it are ESM — so for the
// microseconds that file is empty, every node process starting or resolving in
// that directory dies before any user code runs:
//
//   Error: Invalid package config .../bridge/package.json
//       at shouldUseESMLoader   code: 'ERR_INVALID_PACKAGE_CONFIG'
//
// With six sessions and a 43-file parallel test suite in one working tree, a
// bump landing during a verification run took whole test FILES down at load —
// no test executed, nothing to debug, green on the next run. Reproduced in a
// scratch copy: 24 files dead from one non-atomic rewrite of bridge/package.json,
// 7 from the root one. The repo already holds this doctrine for the data it
// writes (atomicWriteJson, write-lock.js); its own manifests were the one place
// it was never applied.
//
// So: write a temp file beside the target and rename it. Rename within a
// directory is atomic — a concurrent reader sees the whole old file or the
// whole new one, and there is no instant in between.
//
// This tool rewrites FILES ONLY. It does not stage, commit or tag: those are
// the release owner's to run, and a tool that quietly commits is a tool nobody
// can safely re-run.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// fileURLToPath, never import.meta.url's pathname: a repo path containing a
// space arrives percent-encoded and every path built from it silently misses.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The versioned manifests, by the name you bump them under.
 *
 * `extension` is a PAIR because Chrome reads manifest.json and node reads
 * package.json, and a version that moves in one but not the other is how a
 * reload gets tracked against the wrong build. They move together or not at
 * all — the two-phase write below makes that structural, not a habit.
 */
export const TARGETS = {
  repo:      ['package.json'],
  bridge:    ['bridge/package.json'],
  scripts:   ['scripts/package.json'],
  extension: ['extension/package.json', 'extension/manifest.json'],
  app:       ['app/package.json'],
};

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// The FIRST "version": "..." in the file. Deliberately anchored on the quote
// before `version`, so manifest.json's `"manifest_version": 3` cannot match:
// the character before `version` there is an underscore, not a quote.
const VERSION_FIELD = /("version"\s*:\s*")([^"]*)(")/;

/**
 * Patch one manifest's version IN TEXT, not by re-serialising it.
 *
 * JSON.parse + JSON.stringify would reformat the whole file — key order,
 * indentation, trailing newline — turning a one-line bump into a diff nobody
 * reads. So the text is edited surgically, and parsed BEFORE and AFTER purely
 * to prove the edit was safe: an unparseable manifest is exactly the state
 * this tool exists to avoid ever writing.
 */
export function patchVersionText(text, next, label = 'manifest') {
  if (!SEMVER.test(next)) {
    throw new Error(`${label}: "${next}" is not a version (want x.y.z)`);
  }
  let before;
  try {
    before = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}: refusing to patch a file that does not parse (${err.message})`);
  }
  if (typeof before.version !== 'string') {
    throw new Error(`${label}: no string "version" field to bump`);
  }
  if (!VERSION_FIELD.test(text)) {
    throw new Error(`${label}: parsed a version but could not find it in the text`);
  }
  const patched = text.replace(VERSION_FIELD, (_m, open, _old, close) => `${open}${next}${close}`);
  let after;
  try {
    after = JSON.parse(patched);
  } catch (err) {
    throw new Error(`${label}: the patch produced invalid JSON (${err.message})`);
  }
  if (after.version !== next) {
    throw new Error(`${label}: patched the wrong field (version is "${after.version}")`);
  }
  return { text: patched, from: before.version };
}

/**
 * Write via a temp file in the SAME directory, then rename.
 *
 * Same directory because rename is only atomic within a filesystem, and a temp
 * in /tmp can land on a different one. Random suffix because two writers
 * aiming at one pid-named temp is a hazard this repo has already paid for
 * (see WRITE-SAFETY-AUDIT.md).
 */
export async function atomicWriteFile(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp.${crypto.randomBytes(6).toString('hex')}`);
  let mode = 0o644;
  try { mode = (await fs.stat(file)).mode & 0o777; } catch { /* new file — take the default */ }
  try {
    await fs.writeFile(tmp, text, { mode });
    // writeFile's mode is subject to umask; say it outright.
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Apply a plan like { repo: '1.8.28', extension: '1.11.0' }.
 *
 * TWO PHASES on purpose: every file is read and patched in memory first, and
 * nothing is written until all of them succeed. A typo in one version, or a
 * manifest someone left mid-edit, aborts with the tree untouched rather than
 * half-bumped — which for the extension pair is the difference between a
 * released version and a build the user cannot identify.
 */
export async function bumpVersions(plan, { root = REPO_ROOT, dryRun = false } = {}) {
  const groups = Object.keys(plan);
  if (!groups.length) throw new Error('nothing to bump');
  const unknown = groups.filter(g => !TARGETS[g]);
  if (unknown.length) {
    throw new Error(`unknown target${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`
      + ` (known: ${Object.keys(TARGETS).join(', ')})`);
  }

  const staged = [];
  for (const group of groups) {
    for (const rel of TARGETS[group]) {
      const file = path.join(root, rel);
      const text = await fs.readFile(file, 'utf8');
      const { text: patched, from } = patchVersionText(text, plan[group], rel);
      staged.push({ group, rel, file, text: patched, from, to: plan[group] });
    }
  }

  if (!dryRun) {
    for (const entry of staged) await atomicWriteFile(entry.file, entry.text);
  }
  return staged.map(({ group, rel, from, to }) => ({ group, rel, from, to }));
}

/** Current versions, for --list and for a report that says what moved. */
export async function readVersions({ root = REPO_ROOT } = {}) {
  const out = {};
  for (const [group, files] of Object.entries(TARGETS)) {
    out[group] = {};
    for (const rel of files) {
      try {
        out[group][rel] = JSON.parse(await fs.readFile(path.join(root, rel), 'utf8')).version ?? null;
      } catch { out[group][rel] = null; }
    }
  }
  return out;
}

export function parseArgs(argv) {
  const plan = {};
  let dryRun = false, list = false;
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') { dryRun = true; continue; }
    if (arg === '--list' || arg === '-l') { list = true; continue; }
    const m = /^([a-z]+)=(.+)$/.exec(arg);
    if (!m) throw new Error(`unrecognised argument "${arg}" (want target=x.y.z, --dry-run, --list)`);
    plan[m[1]] = m[2];
  }
  return { plan, dryRun, list };
}

const USAGE = `bump-version — rewrite version fields atomically (no git, files only)

  node scripts/bump-version.js repo=1.8.28 extension=1.11.0
  node scripts/bump-version.js --list
  node scripts/bump-version.js repo=1.8.28 --dry-run

Targets: ${Object.keys(TARGETS).join(', ')}   (extension moves package.json + manifest.json together)`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(argv.length ? 0 : 1);
  }
  try {
    const { plan, dryRun, list } = parseArgs(argv);
    if (list) {
      for (const [group, files] of Object.entries(await readVersions())) {
        for (const [rel, version] of Object.entries(files)) {
          console.log(`${group.padEnd(10)} ${String(version).padEnd(10)} ${rel}`);
        }
      }
    }
    if (Object.keys(plan).length) {
      const moved = await bumpVersions(plan, { dryRun });
      for (const m of moved) {
        console.log(`${dryRun ? 'would bump' : 'bumped'} ${m.rel}: ${m.from} → ${m.to}`);
      }
    }
  } catch (err) {
    console.error(`bump-version: ${err.message}`);
    process.exit(1);
  }
}
