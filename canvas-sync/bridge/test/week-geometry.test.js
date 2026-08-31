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

// Comments in this stylesheet quote the measurements that justify each rule —
// including the values that were WRONG. An assertion about what the CSS now
// declares must not be able to read those, in either direction.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// The same brace-matching lift two-day-view.test.js uses: app.js is a browser
// module with a DOM and no exports, so a function is read out of the source and
// run against stubs. The parameter list is skipped FIRST — a destructured
// default puts braces before the body.
function declaration(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js no longer declares ${name}() — stale test`);
  let i = src.indexOf('(', start);
  for (let d = 0; i < src.length; i++) {
    if (src[i] === '(') d++;
    else if (src[i] === ')' && !--d) { i++; break; }
  }
  for (let j = src.indexOf('{', i), d = 0; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && !--d) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

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

test('the narrow-chip treatment keys off WIDTH, never off lane count', () => {
  // `lane-narrow` was assigned when `lanes > 1`, which asks a different
  // question: a 2-lane chip is 82px at 375px, 288px at 1200px, and 149px in
  // the 2-day view — where it fired and hid a time with room twice over. The
  // renderer cannot know how wide a column resolves to, so the chip is asked
  // directly.
  assert.doesNotMatch(APP, /lanes > 1 \? ' lane-narrow'/,
    'the narrow class is back on lane COUNT — it cannot know pixel width');
  assert.match(CSS, /\.cal-chip\.placed \{[^}]*container-type: inline-size/s,
    'the chip must be its own container so it can be measured');
  const q = /@container chip \(max-width: (\d+)px\) \{([^}]*\}[^}]*)\}/s.exec(CSS);
  assert.ok(q, 'no container query decides the narrow treatment');
  assert.ok(Number(q[1]) >= 72 && Number(q[1]) <= 100,
    `threshold ${q[1]}px is not near the 84px a timed row's controls measure`);
  assert.match(q[2], /\.chip-when[^}]*display: none/s,
    'the query must be what hides the time');
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


test('the metadata row is PINNED to the line box, not left to its contents', () => {
  // The 2px vertical cut, and the subtlest bug in this file. Every constant
  // above is arithmetic on a 14.4px first row — the title box starts 21.4px
  // down = 2px border + 3px padding + 14.4px row + 2px gap — but the row was
  // `auto`, so whichever control an op happened to carry could set its height.
  // A chip with a Canvas submit URL carries `.cal-submit.dense`, whose 12px
  // glyph sat in an 18.8px box at `line-height: 1.4`. Measured on the shipped
  // stylesheet: `grid-template-rows: 18.7969px 10.5312px` — the extra 4.4px
  // came out of the TITLE, the only flexible row, so a 15px line was drawn
  // into 10.5px and cut mid-glyph. Ops WITHOUT a submit URL carry the
  // borderless AI pill and measured 14.3984px / 14.9297px, which is why it
  // read as an ai-added-versus-real split rather than a geometry bug.
  const placed = /\.cal-chip\.placed,\s*\n\.cal-chip\[data-kind\]\.placed \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(placed, 'the placed-chip rule moved — this test is stale');
  assert.match(placed[1], /grid-template-rows: var\(--chip-meta-h\) minmax\(0, 1fr\)/,
    'the metadata row is back to `auto` — any taller child will take the title\'s pixels');
});

test('a control in the metadata row cannot be taller than the row', () => {
  // The pin above stops a tall child stealing the title's pixels; this stops
  // it overflowing the row it is now confined to. Both halves are needed: the
  // pin alone would draw the glyph over the title.
  const dense = /\.cal-submit\.dense \{([\s\S]*?)\n\}/.exec(stripComments(CSS));
  assert.ok(dense, '.cal-submit.dense rule is gone');
  assert.doesNotMatch(dense[1], /line-height: 1\.4/,
    'the 1.4 leading is back — it measured an 18.8px box for a 12px glyph');
  assert.match(dense[1], /height: var\(--chip-meta-h\)/,
    'the glyph must be capped to the row height, not left to its own leading');
  // and the row height must be DERIVED from the legend size, not a second copy
  const token = /--chip-meta-h: ([^;]+);/.exec(CSS);
  assert.ok(token, '--chip-meta-h is not defined');
  assert.match(token[1], /calc\(var\(--t-legend\) \* 1\.2\)/,
    `--chip-meta-h is ${token[1].trim()} — a literal will drift from the type scale`);
});

test('the grid geometry JS divides by lives in the stylesheet, once', () => {
  // The lane budget is computed from the column width CSS will resolve. If
  // those numbers were restated in app.js they would be a second copy, which
  // is exactly how the budget came to disagree with the layout.
  for (const token of ['--gutter-w', '--daycol-min', '--lane-min']) {
    assert.match(CSS, new RegExp(`\\n\\s*${token}:\\s*\\d`),
      `${token} must be declared in the stylesheet`);
  }
  // and the tracks must USE them, or the token is decoration
  const declarations = CSS.split('\n').filter(l => !l.trim().startsWith('/*') && !l.trim().startsWith('*'));
  const literal = declarations.filter(l => /minmax\(120px/.test(l));
  assert.deepEqual(literal, [],
    `a day-column track still hardcodes its minimum:\n${literal.join('\n')}`);
  assert.match(CSS, /minmax\(var\(--daycol-min\), 1fr\)/,
    'the day-column track must read the token');
  // Run it, rather than pattern-matching it: a test that only looks for the
  // string `getPropertyValue(` is satisfied by a stub that returns nothing,
  // which is precisely the regression it should catch. These stub values are
  // deliberately NOT the real ones, so a function that quietly fell back to
  // its own literals returns 120/44/80 and fails.
  const stub = { '--gutter-w': '50px', '--daycol-min': '130px', '--lane-min': '90px' };
  const geometry = new Function('getComputedStyle', 'document',
    `${declaration(APP, 'calGridGeometry')}\nreturn calGridGeometry;`)(
    () => ({ getPropertyValue: (n) => stub[n] ?? '' }), { documentElement: {} });
  assert.deepEqual(geometry(), { daycolMin: 130, gutter: 50, laneMin: 90 },
    'calGridGeometry is not reading these from the stylesheet');

  // and a stylesheet that did not load must not produce NaN lanes
  const blind = new Function('getComputedStyle', 'document',
    `${declaration(APP, 'calGridGeometry')}\nreturn calGridGeometry;`)(
    () => ({ getPropertyValue: () => '' }), { documentElement: {} });
  for (const [k, v] of Object.entries(blind())) {
    assert.ok(Number.isFinite(v) && v > 0, `${k} fell back to ${v}`);
  }
});

test('the renderer asks how WIDE the grid is, not how many days it holds', () => {
  // `days.length <= 2 ? 4 : MAX_LANES` was the whole bug: a count chosen off a
  // 1200px screen, applied at 375px where the column is at its 120px floor.
  assert.doesNotMatch(APP, /const laneBudget = days\.length <= 2 \? 4 : MAX_LANES;/,
    'the lane budget is back to a bare day count — it cannot know pixel width');
  assert.match(APP, /laneBudgetFor\(days\.length, gridWidth, \{/,
    'the budget must be computed from a measured width');
  assert.match(APP, /function calGridWidth\(\)[\s\S]{0,200}\$\('cal-ops'\)\?\.clientWidth/,
    'the width must come from the panel the grid mounts into');
});

test('a resized window re-renders only when the budget actually changed', () => {
  // The lane count is baked into the DOM, so CSS cannot fix a stale one — but
  // re-rendering on every resize event would drop the user's open collision
  // stacks for a layout CSS was already handling fluidly.
  assert.match(APP, /window\.addEventListener\('resize'/, 'nothing watches for a resize');
  const fn = /function wireCalendarResize\(\) \{[\s\S]*?\n\}/.exec(APP);
  assert.ok(fn, 'wireCalendarResize is gone');
  assert.match(fn[0], /setTimeout\(check, \d+\)/, 'the resize check must be debounced');
  assert.match(fn[0], /if \(budget === CAL_LANE_BUDGET\) return;/,
    'it must compare against the budget the DOM was BUILT with, not its own history');
  assert.match(APP, /CAL_LANE_BUDGET = laneBudget;/,
    'the renderer must record the budget it used');
  // Scoped to the render path on purpose: the module-level declaration is
  // `let CAL_LANE_BUDGET = null`, which satisfies a bare search for the
  // assignment while the reset itself has been deleted.
  const render = declaration(APP, 'renderCalendarOps');
  assert.match(render, /CAL_LANE_BUDGET = null;/,
    'renderCalendarOps must clear the budget, or a resize re-renders a List view');
});

test('an unbreakable title breaks rather than being cut mid-glyph', () => {
  // A clamped box draws its ellipsis at the end of the last LINE, so it only
  // tidies text that WRAPPED. One long run — a pasted URL, or
  // "Entrepreneurship" in an 81px lane — overflowed sideways instead and was
  // cut with no ellipsis: measured 97px of word inside a 66px box, and 350px
  // for a URL. Breaking it makes the overflow vertical, which the clamp ends.
  const rule = /\.chip-title \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(rule, '.chip-title rule is gone');
  assert.match(rule[1], /-webkit-line-clamp/, 'this test assumes the clamp is still what truncates');
  assert.match(rule[1], /overflow-wrap: anywhere/,
    'a single long word will be clipped mid-glyph with no ellipsis');
});
