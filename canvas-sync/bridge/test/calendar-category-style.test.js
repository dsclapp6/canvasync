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
  assert.match(APP, /Math\.max\(y\(endMin\) - top, 32\)/,
    'short deadlines need enough height to show both rows');
  assert.match(APP, /slot-compact[^\n]+lane-narrow/,
    'the renderer should mark short and side-by-side cards for responsive formatting');
  assert.match(CSS,
    /grid-template-areas:\s*"check kind when action"\s*"title title title title"/,
    'task controls and metadata belong above a full-width title');
  assert.match(CSS,
    /\.cal-chip\.placed\.meeting\s*\{[^}]*grid-template-areas:\s*"kind when"\s*"title title"/s,
    'meetings should not reserve empty checkbox space');
});
