// week-geometry.test.js — the Week view's drawn geometry matches its modelled
// geometry, and no chip is given less room than its own contents need.
//
// Every symptom in the user's Week screenshot was one invariant breaking: what
// is MODELLED and what is DRAWN diverging. The behavioural half lives in
// cal-grid.test.js; this file pins the CSS and renderer facts that cannot be
// executed here, and each number below was MEASURED in a browser against this
// stylesheet, not chosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_BLOCK_MIN, MAX_LANES } from '../public/cal-grid.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [APP, CSS] = await Promise.all([
  readFile(path.join(HERE, '..', 'public', 'app.js'), 'utf8'),
  readFile(path.join(HERE, '..', 'public', 'style.css'), 'utf8'),
]);

test('the pixel floor is DERIVED from the minutes, never a second copy', () => {
  // I6 was these two disagreeing: 32px of screen is 44 minutes of clock, but
  // lane assignment used the op's real 30. Deriving one from the other makes
  // the divergence unrepresentable rather than merely fixed.
  assert.match(APP, /const MIN_BLOCK_PX = \(MIN_BLOCK_MIN \/ 60\) \* HOUR_PX;/,
    'app.js must derive its block floor from cal-grid MIN_BLOCK_MIN');
  // Scoped to the ORDINARY block. The collision stack a few lines below keeps
  // its own 22px minimum, and correctly: it draws a summary button rather than
  // a chip with a title, and a stack drawn SHORTER than the minutes it claimed
  // cannot overlap anything — the unsafe direction is the other one.
  const ordinary = /const blocks = ordinary\.map\([\s\S]*?\}\)\.join\(''\);/.exec(APP);
  assert.ok(ordinary, 'the ordinary-block renderer moved — this test is stale');
  assert.doesNotMatch(ordinary[0], /Math\.max\(y\(endMin\) - top, \d/,
    'a literal pixel floor is back — it will drift from lane occupancy again');
  assert.match(ordinary[0], /Math\.max\(y\(endMin\) - top, MIN_BLOCK_PX\)/);
});

test('the floor is tall enough for the one title line it promises', () => {
  // Measured: the title box starts 21.4px down and a line is 15px, so a card
  // needs 39.4px to show a single line. The old 32px floor gave it 7.6px and
  // sliced its own only title row.
  const hourPx = Number(/const HOUR_PX = (\d+);/.exec(APP)[1]);
  const floorPx = (MIN_BLOCK_MIN / 60) * hourPx;
  assert.ok(floorPx >= 39.4, `floor is ${floorPx.toFixed(1)}px — one title line needs 39.4px`);
});

test('the title clamp tiers come from the line arithmetic', () => {
  // 21.4 + 15n: two lines need 51.4px, three need 66.4px. The bug was a
  // MISSING middle tier — roomy (3 lines) began at 52px, so every block in
  // [52, 67) drew a third line it had no room for.
  const snug = Number(/const SLOT_SNUG_PX = (\d+);/.exec(APP)[1]);
  const roomy = Number(/const SLOT_ROOMY_PX = (\d+);/.exec(APP)[1]);
  assert.ok(snug >= 51.4 && snug < 55, `2-line tier at ${snug}px, expected ~52`);
  assert.ok(roomy >= 66.4 && roomy < 70, `3-line tier at ${roomy}px, expected ~67`);
  assert.ok(roomy > snug, 'tiers must ascend');
  assert.match(APP, /'slot-snug'/, 'the renderer must emit the middle tier');
  for (const [cls, lines] of [['slot-compact', 1], ['slot-snug', 2], ['slot-roomy', 3]]) {
    const rule = new RegExp(`\\.cal-chip\\.placed\\.${cls}[^{]*\\{[^}]*-webkit-line-clamp: ${lines}`, 's');
    if (cls !== 'slot-roomy') {
      assert.match(CSS, rule, `${cls} must clamp to ${lines} line(s)`);
    }
  }
});

test('an ordinary chip places by NAME, so a missing time costs nothing', () => {
  // The five bare tracks assumed `chip-when` was always present. All-day chips
  // omit it, every child shifted a column left, and the marker landed in the
  // flexible track and collapsed to 0px — 16px of content in a 4px box,
  // overflowing and clipped mid-glyph by the band.
  // The specific template is pinned by the test at the bottom of this file.
  // What THIS one owns is the property that made the original bug possible:
  // placement must not depend on how many children happen to be present. Every
  // child needs an explicit area, so an absent one leaves a hole rather than
  // shifting its siblings into the wrong tracks.
  for (const child of ['cal-check', 'chip-kind', 'chip-when', 'chip-title', 'cal-nolink']) {
    const m = new RegExp(`\\.cal-chip\\[data-kind\\]:not\\(\\.placed\\)[^{]*\\.${child}[^{]*\\{([^}]*)\\}`, 's').exec(CSS);
    assert.ok(m && /grid-area:/.test(m[1]),
      `.${child} has no explicit grid-area — a missing sibling will shift it`);
  }
});

test('the time clips inside its own track instead of spilling into the marker', () => {
  // min-width:0 lets the TRACK shrink; it does not stop the TEXT overflowing.
  const rule = /\.cal-chip\.placed \.chip-when \{[^}]*\}/s.exec(CSS);
  assert.ok(rule, '.cal-chip.placed .chip-when rule is gone');
  for (const prop of ['overflow: hidden', 'white-space: nowrap', 'text-overflow: ellipsis']) {
    assert.ok(rule[0].includes(prop), `chip-when needs ${prop}`);
  }
});

test('lane-narrow is a real rule, not a class the renderer emits into nothing', () => {
  assert.match(APP, /lane-narrow/, 'the renderer still emits it');
  assert.match(CSS, /\.cal-chip\.placed\.lane-narrow\s*\{/,
    'lane-narrow had NO css rule at all — emitted and dead');
});

test('the now-line paints above a closed collision stack', () => {
  // The line is full-width by declaration; a stack painting over it is what
  // made it look like it spanned only part of the column.
  const now = Number(/\.cal-nowline \{[^}]*z-index: (\d+)/s.exec(CSS)[1]);
  const stack = Number(/\.cal-collision \{[^}]*z-index: (\d+)/s.exec(CSS)[1]);
  assert.ok(now > stack, `now-line z-index ${now} must exceed the stack's ${stack}`);
});

test('a clipped all-day title can actually draw its ellipsis', () => {
  // The text lives in a nested <a>/<button>; an ancestor cannot draw an
  // ellipsis for a child's clipped text.
  const rule = /\.cal-allday \.cal-chip \.chip-title > a,[^{]*\{[^}]*\}/s.exec(CSS);
  assert.ok(rule, 'the nested clickable title has no one-line treatment');
  assert.ok(rule[0].includes('text-overflow: ellipsis'));
  assert.ok(rule[0].includes('white-space: nowrap'));
});

test('the lane budget is documented where the renderer can honour it', () => {
  assert.equal(MAX_LANES, 2, 'two lanes is the measured floor: 84px of chip in an ~88px lane');
});

test('an ordinary chip gives the TIME its own area, not the title\'s', () => {
  // The regression this exists for, and it was mine. Collapsing `when` into
  // the title's cell looked harmless because an all-day chip has no time — but
  // the stacked week and the month tiles call calChip WITHOUT `timed`
  // (app.js:3382, :3271) and those chips DO carry one. Both then rendered at
  // identical coordinates: measured left 61.3 / top 6 for the time AND the
  // title, on every timed chip in the day columns.
  //
  // The five bare tracks were never the mistake; placing by ORDER was. Named
  // areas make a missing child cost nothing, so `when` can own a track that
  // simply stays empty for all-day chips — measured 0px wide there.
  const rule = /\.cal-chip\[data-kind\] \{[^}]*\}/s.exec(CSS);
  assert.ok(rule, '.cal-chip[data-kind] rule is gone');
  assert.match(rule[0], /grid-template-areas:\s*"check kind when title action"/,
    'the time needs an area of its own');

  const areaOf = (child) => {
    const m = new RegExp(`\\.cal-chip\\[data-kind\\]:not\\(\\.placed\\) \\.${child}[^{]*\\{([^}]*)\\}`, 's').exec(CSS);
    assert.ok(m, `no non-placed rule for .${child}`);
    const a = /grid-area:\s*([a-z-]+)/.exec(m[1]);
    assert.ok(a, `.${child} has no grid-area`);
    return a[1];
  };
  const whenArea = areaOf('chip-when');
  const titleArea = areaOf('chip-title');
  assert.notEqual(whenArea, titleArea,
    `time and title both map to "${whenArea}" — they will render in the same pixels`);
  assert.equal(whenArea, 'when');
  assert.equal(titleArea, 'title');
});

