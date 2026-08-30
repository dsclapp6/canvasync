// file-view.test.js — the file viewer never paints a superseded render.
//
// renderFileView is browser code with a DOM, a fetch stack and six awaits; it
// cannot be imported and run here. What CAN be pinned is the invariant that
// made it wrong, and that invariant is structural: EVERY await in that function
// is a point where the user may have gone Back and opened a different file, and
// none of its callers await it, so two renders overlap freely.
//
// The bug this guards was the stuck variant. A render token already existed,
// but only renderPdfPages consumed it — so a slow slide deck's fetch would
// resolve after the user had opened something else, paint its own toolbar and
// an eternal "Rendering document…" box over the newer file, and then abort the
// page painting on the stale token BEFORE clearing that placeholder. The panel
// was left showing one file's content under another file's title, with no
// error and nothing to retry: a dead state with no named cause.
//
// Structural, and deliberately so — a future await added without a guard is
// exactly how this returns, and that is the thing a test can see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = await readFile(path.join(HERE, '..', 'public', 'app.js'), 'utf8');

function renderFileViewSource() {
  const start = SRC.indexOf('async function renderFileView() {');
  assert.notEqual(start, -1, 'app.js no longer declares renderFileView — this test is stale, not passing');
  const end = SRC.indexOf('\nfunction wireFileView(', start);
  assert.notEqual(end, -1, 'could not find the end of renderFileView');
  return SRC.slice(start, end);
}

const BAIL = 'if (stale()) return;';

test('the staleness guard compares the captured token, not a constant', () => {
  // Without this, every assertion below is satisfied by `const stale = () =>
  // false` — the guards would all be present and none would ever fire. The
  // structure half is worthless on its own.
  const fn = renderFileViewSource();
  assert.match(fn, /const renderId = FILE_PREVIEW_RENDER;/,
    'the render token must still be captured at entry');
  assert.match(fn, /const stale = \(\) => renderId !== FILE_PREVIEW_RENDER;/,
    'the guard must compare the captured token against the live one');
});

test('every await in renderFileView is followed by a staleness bail', () => {
  const lines = renderFileViewSource().split('\n');
  const unguarded = [];

  lines.forEach((line, i) => {
    const code = line.split('//')[0];
    if (!/\bawait\b/.test(code)) return;
    // Look ahead past blanks, comments and block-closers for the bail. The
    // extracted-text await sits inside its own try/catch, so its guard lands
    // after the closing brace rather than on the next line.
    let found = false;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const next = lines[j].trim();
      if (next.includes(BAIL)) { found = true; break; }
      // Blanks, comments, block closers and a trailing `catch {...}` are the
      // same statement still finishing — not code that can paint anything.
      // Anything else executing before the guard means this await is exposed.
      if (next === '' || next.startsWith('//') || next === '}' || next === '} else {'
        || /^catch\b/.test(next)) continue;
      break;   // real code before a guard — this await is unprotected
    }
    if (!found) unguarded.push(`  line ${i + 1}: ${line.trim()}`);
  });

  assert.deepEqual(unguarded, [],
    `these awaits can paint over a newer file's view:\n${unguarded.join('\n')}`);
});

test('the catch bails before writing an error about a file the user left', () => {
  // A superseded render's failure is not the current file's failure. Painting
  // it replaces the file on screen with an error about a different one.
  const fn = renderFileViewSource();
  const idx = fn.indexOf('} catch (err) {');
  assert.notEqual(idx, -1, 'renderFileView no longer has its catch — this test is stale');
  const afterCatch = fn.slice(idx).split('\n').slice(1)
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('//'));
  assert.equal(afterCatch[0], BAIL,
    `the catch must bail first; its first statement is ${JSON.stringify(afterCatch[0])}`);
});

test('the guard count matches the awaits it has to cover', () => {
  // A floor, so deleting guards in bulk fails loudly rather than shrinking
  // quietly past the per-await check above.
  const fn = renderFileViewSource();
  const bails = fn.split(BAIL).length - 1;
  const awaits = fn.split('\n').filter(l => /\bawait\b/.test(l.split('//')[0])).length;
  assert.ok(bails >= awaits,
    `${awaits} awaits but only ${bails} staleness bails in renderFileView`);
});
