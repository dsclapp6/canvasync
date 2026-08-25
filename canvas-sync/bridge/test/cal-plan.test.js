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
  nextSelection, isSelected,
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
