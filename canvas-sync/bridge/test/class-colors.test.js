// class-colors.test.js — "the class colors should be just generics but I should
// be able to modify them."
//
// Two rules, and the failure modes are opposite. If defaults are not stable, a
// class changes colour when another class is added or a sidebar sorts
// differently, and the calendar stops being readable at a glance. If overrides
// are not durable, the user's edit is silently discarded and they have no way
// to tell whether it saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PALETTE, isHexColor, normaliseHex, resolveColors, applyColorPatch,
} from '../../class-colors.js';

// The five real classes on this machine.
const SLUGS = [
  '92294-busi-305-001-002-003',
  '92336-busi-374-001-002',
  '92354-busi-396-001-002-003-004',
  '93903-busi-380-002',
  '94038-entr-222-001',
];

test('the palette is distinct — no class silently shares a colour with another', () => {
  assert.equal(new Set(DEFAULT_PALETTE).size, DEFAULT_PALETTE.length);
  for (const hex of DEFAULT_PALETTE) assert.ok(isHexColor(hex), `${hex} is not #rrggbb`);
});

test('every class gets a colour, and they differ', () => {
  const colors = resolveColors(SLUGS);
  assert.deepEqual(Object.keys(colors).sort(), [...SLUGS].sort());
  assert.equal(new Set(Object.values(colors)).size, SLUGS.length);
});

test('a class keeps its colour whatever order it is asked for in', () => {
  const forward = resolveColors(SLUGS);
  const reversed = resolveColors([...SLUGS].reverse());
  const shuffled = resolveColors([SLUGS[3], SLUGS[0], SLUGS[4], SLUGS[1], SLUGS[2]]);
  assert.deepEqual(reversed, forward);
  assert.deepEqual(shuffled, forward);
});

test('duplicates in the slug list do not shift the palette', () => {
  assert.deepEqual(resolveColors([...SLUGS, SLUGS[0], SLUGS[2]]), resolveColors(SLUGS));
});

test('an override wins over the generic default', () => {
  const colors = resolveColors(SLUGS, { '93903-busi-380-002': '#B4442C' });
  assert.equal(colors['93903-busi-380-002'], '#b4442c');
  // and it does not disturb anyone else
  const untouched = resolveColors(SLUGS);
  for (const slug of SLUGS) {
    if (slug !== '93903-busi-380-002') assert.equal(colors[slug], untouched[slug]);
  }
});

test('a junk override falls back to the generic rather than rendering nothing', () => {
  const colors = resolveColors(SLUGS, { '93903-busi-380-002': 'chartreuse' });
  assert.equal(colors['93903-busi-380-002'], resolveColors(SLUGS)['93903-busi-380-002']);
});

test('an override for a class that no longer exists is simply not returned', () => {
  const colors = resolveColors(SLUGS, { '00000-gone-001': '#123456' });
  assert.ok(!('00000-gone-001' in colors));
});

test('more classes than palette entries wraps instead of returning undefined', () => {
  const many = Array.from({ length: DEFAULT_PALETTE.length + 3 }, (_, i) => `c${String(i).padStart(3, '0')}`);
  const colors = resolveColors(many);
  assert.equal(Object.keys(colors).length, many.length);
  for (const hex of Object.values(colors)) assert.ok(isHexColor(hex));
  assert.equal(colors.c000, colors[`c${String(DEFAULT_PALETTE.length).padStart(3, '0')}`]);
});

test('no classes yet is an empty map, not a crash', () => {
  assert.deepEqual(resolveColors([]), {});
  assert.deepEqual(resolveColors(null), {});
  assert.deepEqual(resolveColors(undefined, null), {});
});

test('hex is accepted case-insensitively and stored lowercase', () => {
  assert.equal(normaliseHex('#AbCdEf'), '#abcdef');
  assert.equal(normaliseHex('  #ABCDEF  '), '#abcdef');
  assert.equal(normaliseHex('#abc'), null);        // shorthand is not accepted
  assert.equal(normaliseHex('abcdef'), null);      // missing #
  assert.equal(normaliseHex('#abcdeg'), null);     // g is not hex
  assert.equal(normaliseHex(0x123456), null);
});

test('a patch merges into what is already stored', () => {
  const { overrides, rejected } = applyColorPatch({ a: '#111111' }, { b: '#222222' });
  assert.deepEqual(overrides, { a: '#111111', b: '#222222' });
  assert.deepEqual(rejected, []);
});

test('null clears one override — this is how "revert to generic" is spelled', () => {
  for (const clearing of [null, '', undefined]) {
    const { overrides } = applyColorPatch({ a: '#111111', b: '#222222' }, { a: clearing });
    assert.deepEqual(overrides, { b: '#222222' }, `${String(clearing)} should clear`);
  }
});

test('a bad hex is reported, not silently dropped, and leaves the old value alone', () => {
  const { overrides, rejected } = applyColorPatch({ a: '#111111' }, { a: 'red' });
  assert.deepEqual(overrides, { a: '#111111' });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].slug, 'a');
  assert.match(rejected[0].reason, /#rrggbb/);
});

test('a slug that could escape the colours file is rejected', () => {
  for (const slug of ['../../etc/passwd', 'a/b', 'A-CAPS', '', 'x'.repeat(81), '__proto__']) {
    const { overrides, rejected } = applyColorPatch({}, { [slug]: '#123456' });
    assert.deepEqual(overrides, {}, `${slug} should not be stored`);
    assert.equal(rejected.length, 1);
  }
});

test('the patch does not mutate what was stored', () => {
  const stored = { a: '#111111' };
  applyColorPatch(stored, { a: '#222222', b: null, c: '#333333' });
  assert.deepEqual(stored, { a: '#111111' });
});

test('an empty or absent patch is a no-op, and junk stored state is survivable', () => {
  assert.deepEqual(applyColorPatch({ a: '#111111' }, {}).overrides, { a: '#111111' });
  assert.deepEqual(applyColorPatch({ a: '#111111' }, null).overrides, { a: '#111111' });
  assert.deepEqual(applyColorPatch('not an object', { a: '#111111' }).overrides, { a: '#111111' });
});
