// build-graph.js — write one class's correlation_graph.json.
//
// A wrapper and nothing else: correlation-graph.js decides what relates to
// what, this gives sync-all-contexts.js something to spawn and gives a human
// with one stale class a single command to run.
//
// Deterministic and local. No AI backend, no network — the whole point of the
// graph is that it reproduces, and a build that phoned a model would cost more
// than every other stage combined and still not give the same answer twice.
//
// Usage: node build-graph.js <classDir>

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, writeGraph } from './correlation-graph.js';

async function main() {
  const classDir = process.argv[2];
  if (!classDir) {
    process.stderr.write('Usage: node build-graph.js <classDir>\n');
    process.exit(1);
  }

  const absClassDir = resolve(classDir);

  // buildGraph throws on a directory that is not there — a caller bug, and one
  // that must surface as a non-zero exit rather than as an empty graph on disk
  // claiming the class has no items.
  const graph = await buildGraph(absClassDir);
  const file = await writeGraph(absClassDir, graph);

  const s = graph.stats ?? {};
  const kb = Math.round(((await stat(file)).size / 1024) * 10) / 10;
  process.stderr.write(
    `Written: ${file} (${s.nodeCount} items, ${s.edgeCount} links, `
    + `density ${s.density}, median degree ${s.medianDegree}, ${kb}KB, ${s.buildMs}ms)\n`
  );
}

// Only run main() when invoked directly, not when imported (the test suite
// imports nothing here today, but every other script in this directory carries
// the guard and a future importer should not trigger a build as a side effect).
// Compare DECODED paths: a raw `file://${argv[1]}` comparison fails whenever the
// repo path contains a space, and the script then silently does nothing.
const isDirectInvocation = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  main().catch(err => {
    process.stderr.write(`FATAL: ${err.stack || err.message || String(err)}\n`);
    process.exit(1);
  });
}
