// index-readings.js — persist the deterministic reading index for one class.
//
// CLI: node scripts/index-readings.js <classDir>
//
// The writer is content-aware: an unchanged index is not rewritten. That is
// required for pipeline staleness checks — touching readings_index.json on
// every pass would re-fire task mining and context building forever.

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReadingIndex } from '../reading-index.js';
import { atomicWriteJson } from './_util.js';

function stable(value) {
  if (!value || typeof value !== 'object') return value;
  const { indexed_at, ...rest } = value;
  return rest;
}

export async function indexClassReadings(classDir) {
  const dir = resolve(classDir);
  const outPath = join(dir, 'readings_index.json');
  const next = await buildReadingIndex(dir);
  let previous = null;
  try { previous = JSON.parse(await readFile(outPath, 'utf8')); } catch { /* first index */ }
  if (previous && JSON.stringify(stable(previous)) === JSON.stringify(next)) {
    return { changed: false, index: previous, outPath };
  }
  const index = { ...next, indexed_at: new Date().toISOString() };
  await atomicWriteJson(outPath, index);
  return { changed: true, index, outPath };
}

async function main() {
  const classDir = process.argv[2];
  if (!classDir) {
    process.stderr.write('Usage: node scripts/index-readings.js <classDir>\n');
    process.exit(1);
  }
  const result = await indexClassReadings(classDir);
  process.stderr.write(`${result.changed ? 'Written' : 'Current'}: ${result.outPath} (${result.index.items.length} readings)\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    process.stderr.write(`FATAL: ${err.stack || err.message || String(err)}\n`);
    process.exit(1);
  });
}

