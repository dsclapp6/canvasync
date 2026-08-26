// cal-plan.test.js — the Populate selection.
//
// Every test here is named after the failure that made this file exist: on
// 2026-08-24 the panel's five independent switches were all turned off in one
// gesture, the worklist went from 251 events to 105, and nothing on the
// calendar said a switch had been touched. A selection cannot express "none",
// so that state is now unreachable rather than merely discouraged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextSelection, isSelected, pruneSelection,
} from '../public/cal-plan.js';

const KINDS = ['meeting', 'office_hours', 'homework', 'reading', 'exam', 'checkpoint'];

// --- reading a stored plan ------------------------------------------------

test('clicking one chip from the default narrows to only that kind', () => {
  // "If one (or more) are selected, then it becomes only those ones on the
  // calendar" — the user's words, and the whole point of the change.
  assert.deepEqual(nextSelection([], KINDS, 'meeting'), ['meeting']);
});

test('clicking the only selected chip goes back to everything, not to nothing', () => {
  // This is the All button's job, done by the chip the user is already
  // pointing at. Returning [] here is what makes the empty calendar
  // unreachable: there is no sequence of clicks that turns the last one off.
  assert.deepEqual(nextSelection(['meeting'], KINDS, 'meeting'), []);
});

test('adding a second chip keeps the first, and the order stays the panel’s', () => {
  assert.deepEqual(nextSelection(['exam'], KINDS, 'meeting'), ['meeting', 'exam']);
  assert.deepEqual(nextSelection(['meeting'], KINDS, 'checkpoint'), ['meeting', 'checkpoint']);
});

test('removing one of several leaves the rest selected', () => {
  assert.deepEqual(nextSelection(['meeting', 'exam', 'checkpoint'], KINDS, 'exam'),
    ['meeting', 'checkpoint']);
});

test('a kind the panel does not offer is ignored rather than stored', () => {
  assert.deepEqual(nextSelection(['meeting'], KINDS, 'nonsense'), ['meeting']);
  assert.deepEqual(nextSelection([], KINDS, 'nonsense'), []);
});

// --- writing it back --------------------------------------------------------

test('nothing selected lights every chip, because nothing selected is everything', () => {
  // A panel with no chip lit next to a calendar showing every kind would read
  // as broken. The lit state has to mean what the calendar is doing.
  for (const k of KINDS) assert.equal(isSelected([], k), true, k);
});

test('a selection lights only its members', () => {
  const sel = ['meeting', 'exam'];
  // Derived from KINDS rather than written out, so adding a kind (office_hours
  // did exactly this) cannot silently shift a hand-typed row of booleans.
  assert.deepEqual(KINDS.map(k => isSelected(sel, k)), KINDS.map(k => sel.includes(k)));
  assert.equal(isSelected(sel, 'office_hours'), false);
});

test('no sequence of clicks can hide everything', () => {
  // The guarantee, walked exhaustively rather than argued: from every reachable
  // selection, clicking every chip, at least one kind is always showing. This
  // is the failure the panel actually shipped — five switches, all off, an
  // empty calendar that looked like a broken sync.
  for (let mask = 0; mask < (1 << KINDS.length); mask += 1) {
    const sel = KINDS.filter((_, i) => mask & (1 << i));
    for (const clicked of KINDS) {
      const next = nextSelection(sel, KINDS, clicked);
      assert.equal(
        KINDS.some(k => isSelected(next, k)), true,
        `from [${sel}] clicking ${clicked} left nothing showing`,
      );
    }
  }
});

test('an unknown kind is a no-op, not a wipe', () => {
  assert.deepEqual(nextSelection(['exam'], KINDS, 'nonsense'), ['exam']);
  assert.deepEqual(nextSelection([], KINDS, 'nonsense'), []);
});

test('a corrupt selection still shows everything', () => {
  for (const junk of [null, undefined, 'exam', 42, {}]) {
    assert.equal(isSelected(junk, 'exam'), true, String(junk));
    assert.deepEqual(nextSelection(junk, KINDS, 'exam'), ['exam'], String(junk));
  }
});

// --- the class chips run on this same selection -----------------------------
//
// Since 2026-08-26 the calendar's class chips are the same selection shape as
// the kinds — the user's words: "make it so the class selectors in the
// calendar page behave the same as the categories; all selected by default,
// if one (or more) is selected it should only show selected ones." The
// vocabulary differs (six class slugs plus 'personal', and it changes when
// classes come and go), so the no-empty guarantee is walked again at that
// size rather than assumed to generalise from five kinds.

const CLASS_SLUGS = [
  'busi-305', 'busi-374', 'busi-380', 'busi-396', 'econ-205', 'entr-222',
  'personal',
];

test('class chips: no sequence of clicks can deselect every class into an empty view', () => {
  for (let mask = 0; mask < (1 << CLASS_SLUGS.length); mask += 1) {
    const sel = CLASS_SLUGS.filter((_, i) => mask & (1 << i));
    for (const clicked of CLASS_SLUGS) {
      const next = nextSelection(sel, CLASS_SLUGS, clicked);
      assert.equal(
        CLASS_SLUGS.some(s => isSelected(next, s)), true,
        `from [${sel}] clicking ${clicked} left every class filtered out`,
      );
    }
  }
});

test('a selection of departed classes prunes to everything, not to nothing', () => {
  // Without the prune, a stored selection whose slugs have all left fails
  // isSelected() for every chip on screen: an empty calendar with every chip
  // lit, which is §6.4's failure wearing a different hat.
  const pruned = pruneSelection(['a-class-that-graduated'], CLASS_SLUGS);
  assert.deepEqual(pruned, []);
  for (const s of CLASS_SLUGS) assert.equal(isSelected(pruned, s), true, s);
});

test('pruning keeps the classes that are still offered, in stored order', () => {
  assert.deepEqual(
    pruneSelection(['econ-205', 'gone', 'busi-305'], CLASS_SLUGS),
    ['econ-205', 'busi-305'],
  );
  assert.deepEqual(pruneSelection([], CLASS_SLUGS), []);
  // A vocabulary that has not loaded yet must not be read as "everything
  // departed" and silently discard a real selection... it does prune to empty,
  // which means everything shows. Never an empty calendar.
  assert.deepEqual(pruneSelection(['busi-305'], []), []);
});

test('a corrupt stored class selection prunes rather than throwing', () => {
  for (const junk of [null, undefined, 'busi-305', 42, {}]) {
    assert.deepEqual(pruneSelection(junk, CLASS_SLUGS), [], String(junk));
  }
  assert.deepEqual(pruneSelection(['busi-305'], null), []);
});

test('clicking the last VISIBLE chip returns to everything even with a stale slug stored', () => {
  // The defect this pins: the click handler used to resolve against the raw
  // stored selection, so with a departed class still in it, clicking the only
  // chip that actually looked selected did not read as "the last one" and left
  // the invisible slug behind — which re-narrowed the calendar by itself the
  // day that class came back. Handler and display must agree about what is
  // selected, so both resolve against the pruned list.
  const stored = ['busi-305', 'a-class-that-graduated'];
  const visible = pruneSelection(stored, CLASS_SLUGS);
  assert.deepEqual(visible, ['busi-305'], 'only one chip draws as selected');

  const naive = nextSelection(stored, CLASS_SLUGS, 'busi-305');
  assert.deepEqual(naive, ['a-class-that-graduated'],
    'resolving against the raw selection leaves an invisible residue');

  const actual = nextSelection(visible, CLASS_SLUGS, 'busi-305');
  assert.deepEqual(actual, [], 'resolving against what is on screen means everything');
});
