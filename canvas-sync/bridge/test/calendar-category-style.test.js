import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PUBLIC = new URL('../public/', import.meta.url);
const [APP, CSS] = await Promise.all([
  readFile(new URL('app.js', PUBLIC), 'utf8'),
  readFile(new URL('style.css', PUBLIC), 'utf8'),
]);

const KINDS = [
  'meeting', 'office_hours', 'homework', 'reading', 'exam', 'checkpoint', 'personal',
];

test('every calendar category has an explicit visual token', () => {
  for (const kind of KINDS) {
    assert.match(CSS, new RegExp(`\\[data-kind="${kind}"\\]`), `${kind} needs an item colour`);
    assert.match(CSS, new RegExp(`data-kind-filter="${kind}"`), `${kind} needs a filter colour`);
  }
});

test('list rows, grid chips, and dense stacks expose their category', () => {
  assert.equal((APP.match(/data-kind="\$\{esc\(op\.kind \|\| 'other'\)\}"/g) || []).length, 2);
  assert.match(APP, /class="cal-collision" data-kind="\$\{esc\(sharedKind/);
  assert.match(APP, /class="cal-kind category-label"/);
  assert.match(APP, /class="chip-kind"/);
});

test('timed cards give metadata and titles separate rows, including narrow lanes', () => {
  // This asserted the literal 32 — the very value that could NOT show both
  // rows: measured, a 32px card leaves 7.6px for a 15px title line, so every
  // short deadline sliced its own only title row. The intent below is the
  // original one; the floor is now derived from cal-grid's MIN_BLOCK_MIN so
  // the drawn height and the minutes lane assignment reserves cannot drift.
  // week-geometry.test.js pins the arithmetic that makes it sufficient.
  assert.match(APP, /Math\.max\(y\(endMin\) - top, MIN_BLOCK_PX\)/,
    'short deadlines need enough height to show both rows');
  // Asserted separately rather than as one adjacency regex: the height tier is
  // now a three-way choice spread over several lines, and a proximity match on
  // source layout breaks on formatting rather than on behaviour.
  for (const tier of ["'slot-compact'", "'slot-snug'", "'slot-roomy'"]) {
    assert.ok(APP.includes(tier), `the renderer must emit ${tier}`);
  }
  assert.match(APP, /lane-narrow/,
    'the renderer should mark side-by-side cards for responsive formatting');
  assert.match(CSS,
    /grid-template-areas:\s*"check kind when action"\s*"title title title title"/,
    'task controls and metadata belong above a full-width title');
  assert.match(CSS,
    /\.cal-chip\.placed\.meeting\s*\{[^}]*grid-template-areas:\s*"kind when"\s*"title title"/s,
    'meetings should not reserve empty checkbox space');
});
