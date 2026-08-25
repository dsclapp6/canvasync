import test from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, KIND_LABELS, KIND_CALENDAR, KIND_NOUN, isKind } from '../../calendar-kinds.js';

test('every kind has a label, a target calendar and both nouns', () => {
  for (const k of KINDS) {
    assert.equal(typeof KIND_LABELS[k], 'string', k);
    assert.ok(['due', 'checkpoint', 'meeting'].includes(KIND_CALENDAR[k]), k);
    assert.equal(KIND_NOUN[k]?.length, 2, k);
  }
});

test('the tables carry nothing that is not a kind', () => {
  for (const table of [KIND_LABELS, KIND_CALENDAR, KIND_NOUN]) {
    assert.deepEqual(Object.keys(table).sort(), [...KINDS].sort());
  }
});

test('isKind refuses anything that is not one', () => {
  assert.equal(isKind('office_hours'), true);
  for (const v of ['', 'Meetings', 'due', null, undefined, 0, {}]) assert.equal(isKind(v), false, String(v));
});
