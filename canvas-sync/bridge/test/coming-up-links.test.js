// coming-up-links.test.js — a Coming up row clicks in to the ITEM, and never
// invents a destination it does not have.
//
// The user's words for this are "click in": the item, not the container. Rows
// used to open the class page, so eight deadlines on the home screen all led to
// the same four places.
//
// The resolution is NOT re-derived here — Coming up calls the same
// calItemModel/calTitleHtml the calendar rows and chips use, so the two cannot
// drift and neither matches on titles. These cases are the real first-eight
// upcoming ops from the user's own worklist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = await readFile(path.join(HERE, '..', 'public', 'app.js'), 'utf8');

function declaration(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js no longer declares ${name}() — stale test`);
  let i = SRC.indexOf('(', start);
  for (let d = 0; i < SRC.length; i++) {
    if (SRC[i] === '(') d++;
    else if (SRC[i] === ')' && !--d) { i++; break; }
  }
  for (let j = SRC.indexOf('{', i), d = 0; j < SRC.length; j++) {
    if (SRC[j] === '{') d++;
    else if (SRC[j] === '}' && !--d) return SRC.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const NAMES = ['esc', 'calUrl', 'calDoneKey', 'calItemModel', 'calTitleHtml'];
const { calItemModel, calTitleHtml } = new Function(
  'calFolder', 'CAL_DONE', 'CAL_CUSTOM', 'PERSONAL_SLUG', 'CAL_WORKLIST',
  `${NAMES.map(declaration).join('\n')}\nreturn { ${NAMES.join(', ')} };`,
)((slug) => slug ? `900-${slug}` : null, new Set(), [], '__personal__', null);

const render = (op) => calTitleHtml(op, calItemModel(op), op.title);

// The real shapes, taken from the user's worklist.
const CANVAS_HW = {
  title: 'BUSI 305 · HW Ch 1 (practice HW)', class: 'busi-305-001', kind: 'homework',
  calendar: 'due', origin: 'canvas', item_id: 'hw-ch-1',
  url: 'https://canvas.rice.edu/courses/92294/assignments/522239', date: '2026-08-31',
};
const AI_READING = {
  title: 'BUSI 305 · Read for Transaction analysis', class: 'busi-305-001', kind: 'reading',
  calendar: 'due', origin: 'syllabus', item_id: 'reading-2026-08-31', date: '2026-08-31',
};
const ECON_AI_HW = {
  title: 'ECON 205 · Obtain the correct edition of the text', class: 'econ-205-002',
  kind: 'homework', calendar: 'due', origin: 'syllabus', item_id: 'obtain-required-text',
  date: '2026-09-01',
};
const ENTR_CHECKPOINT = {
  title: 'Prep 7d · ENTR 222 Choose Group Product', class: 'entr-222-001', kind: 'checkpoint',
  calendar: 'checkpoint', origin: 'canvas', item_id: 'choose-group-product',
  // checkpoint_id is what makes a prep block checkable, and therefore openable
  // (spec 2.9 / 2.12). Omitting it from this fixture made the test fail against
  // correct code — the shape was mine, not the app's.
  checkpoint_id: 'auto:7d',
  url: 'https://canvas.rice.edu/courses/94038/assignments/527365', date: '2026-09-01',
};

test('a Canvas-backed deadline clicks in to the item', () => {
  const html = render(CANVAS_HW);
  assert.match(html, /data-open-assignment="hw-ch-1"/, 'must carry the item id, not the class');
  assert.match(html, /data-assignment-class="900-busi-305-001"/, 'and the folder to open it in');
  assert.match(html, /BUSI 305 · HW Ch 1/, 'the row still says what it is');
});

test('a checkpoint clicks in to the assignment it preps for', () => {
  // CALENDAR-SPEC 2.12. This is the ENTR 222 case: a prep block has no Canvas
  // page of its own, but it knows the one it belongs to.
  const html = render(ENTR_CHECKPOINT);
  assert.match(html, /data-open-assignment="choose-group-product"/);
  assert.match(html, /data-assignment-class="900-entr-222-001"/);
});

test('an AI-added item with no Canvas page gets NO manufactured link', () => {
  // The no-dead-links invariant, and the half with teeth: it would be trivial
  // to point every row at a Canvas URL built from the course id.
  for (const [name, op] of [['BUSI 305 reading', AI_READING], ['ECON 205 homework', ECON_AI_HW]]) {
    const html = render(op);
    assert.doesNotMatch(html, /canvas\.rice\.edu/, `${name}: invented a Canvas URL`);
    assert.doesNotMatch(html, /<a\s/, `${name}: rendered an anchor with nowhere to go`);
    // It DOES get a control — the in-app item page, which states plainly that
    // there is nothing to submit (spec 2.13). That is the honest destination
    // for syllabus-mined work: somewhere real, that says what it is.
    assert.match(html, /data-open-assignment=/, `${name}: should still click in to the item`);
  }
});

// An op with no item id is not openable, so it falls through to the URL
// branch — the ONLY place a dead anchor could be minted. Every op in the
// current worklist IS openable, so without this fixture that branch is never
// exercised and the no-dead-links assertion above passes for the wrong reason.
// Found by mutation: removing the `&& m.url` guard changed nothing.
const UNANCHORED = {
  title: 'BUSI 396 · Something mined with no id and no page', class: 'busi-396-001',
  kind: 'reading', calendar: 'due', origin: 'syllabus', date: '2026-09-02',
};

test('an item with no id and no page renders TEXT, not an empty link', () => {
  const html = render(UNANCHORED);
  assert.doesNotMatch(html, /<a\s/, 'minted an anchor with no destination');
  assert.doesNotMatch(html, /href="(null|undefined|)"/, 'minted an empty href');
  assert.match(html, /Something mined with no id/, 'the row must still say what it is');
});

test('every row renders something clickable OR plain text, never a dead control', () => {
  // A control that looks live and does nothing is worse than plain text.
  for (const op of [CANVAS_HW, AI_READING, ECON_AI_HW, ENTR_CHECKPOINT, UNANCHORED]) {
    const html = render(op);
    const hasControl = /<a\s|<button/.test(html);
    if (hasControl) {
      const targeted = /href="https?:\/\/[^"]+"/.test(html) || /data-open-assignment="[^"]+"/.test(html);
      assert.ok(targeted, `control with no destination: ${html}`);
    } else {
      assert.ok(html.trim().length > 0, 'a row with no link must still say its title');
    }
  }
});

test('Coming up reuses the calendar resolver rather than re-deriving one', () => {
  // If this ever stops being true the two surfaces can disagree about the same
  // op, which is the drift the reuse exists to prevent.
  const row = declaration('homeRowHtml');
  assert.match(row, /calItemModel\(o\)/, 'must resolve through calItemModel');
  assert.match(row, /calTitleHtml\(o, m, o\.title\)/, 'must render through calTitleHtml');
  assert.doesNotMatch(row, /<span class="hu-title">\$\{esc\(o\.title\)\}/,
    'the title is plain text again — rows are back to opening the class');
  // Both home lists draw through that one renderer, so Completed cannot drift
  // from Coming up any more than Coming up can drift from the calendar.
  const home = declaration('renderHome');
  assert.match(home, /\$\('home-up-list'\)\.innerHTML = next\.map\(o => homeRowHtml\(o, cards\)\)/,
    'Coming up must render every row through homeRowHtml');
  assert.match(home, /\$\('home-done-list'\)\.innerHTML = completed\.map\(o => homeRowHtml\(o, cards\)\)/,
    'Completed must render every row through homeRowHtml');
});

test('a click on a row control does not ALSO open the class behind it', () => {
  // Both handlers are live: the document-level [data-open-assignment] listener
  // and the row's own class-page fallback. Without the guard a deep-link
  // opened the item and the class page in the same click.
  const wire = declaration('homeRowClick');
  assert.match(wire, /closest\('a, button, input'\)/,
    'controls must own their own click — the checkbox included, or every tick opens the class');
  assert.match(wire, /openClass\(row\.dataset\.folder\)/,
    'the rest of the row must still go somewhere — no reachable dead click');
  const home = declaration('wireHome');
  assert.match(home, /\$\('home-up-list'\)\.addEventListener\('click', homeRowClick\)/,
    'Coming up must be wired to the shared row handler');
  assert.match(home, /\$\('home-done-list'\)\.addEventListener\('click', homeRowClick\)/,
    'Completed must be wired to the same handler — its rows have the same controls');
});
