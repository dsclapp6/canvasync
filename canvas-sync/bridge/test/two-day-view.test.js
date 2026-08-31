// two-day-view.test.js — the 2-day view answers one question: what is on today
// and tomorrow. Everything it does not do is as deliberate as what it does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, MAX_LANES, laneBudgetFor } from '../public/cal-grid.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [APP, HTML, CSS] = await Promise.all([
  readFile(path.join(HERE, '..', 'public', 'app.js'), 'utf8'),
  readFile(path.join(HERE, '..', 'public', 'index.html'), 'utf8'),
  readFile(path.join(HERE, '..', 'public', 'style.css'), 'utf8'),
]);

function declaration(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js no longer declares ${name}() — stale test`);
  let i = APP.indexOf('(', start);
  for (let d = 0; i < APP.length; i++) {
    if (APP[i] === '(') d++;
    else if (APP[i] === ')' && !--d) { i++; break; }
  }
  for (let j = APP.indexOf('{', i), d = 0; j < APP.length; j++) {
    if (APP[j] === '{') d++;
    else if (APP[j] === '}' && !--d) return APP.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const makeTwoDayDays = (today) => new Function('localTodayIso', 'addDays',
  `${declaration('twoDayDays')}\nreturn twoDayDays;`)(() => today, addDays);

test('the range is today and LITERALLY tomorrow', () => {
  assert.deepEqual(makeTwoDayDays('2026-08-31')(), ['2026-08-31', '2026-09-01']);
  // Across a month boundary, and across a year one.
  assert.deepEqual(makeTwoDayDays('2026-09-30')(), ['2026-09-30', '2026-10-01']);
  assert.deepEqual(makeTwoDayDays('2026-12-31')(), ['2026-12-31', '2027-01-01']);
});

test('an empty tomorrow is still shown — the view must be able to say "nothing"', () => {
  // The design decision, pinned. "The next two days that have something on
  // them" would make an empty day and a hidden day look identical, and the
  // question this view exists to answer is "is tomorrow clear?".
  const fn = declaration('twoDayDays');
  assert.doesNotMatch(fn, /ops|CAL_WORKLIST|bucketByDate|length/,
    'the range must not depend on what is IN the days');
  assert.match(fn, /localTodayIso\(\)/, 'and must derive from today, not from CAL_ANCHOR');
  assert.doesNotMatch(fn, /CAL_ANCHOR/,
    'deriving from the anchor would let the view be parked on a stale pair');
});

test('the view is one of four, and the toggle offers all four', () => {
  assert.match(APP, /const CAL_VIEWS = \['list', 'twoday', 'week', 'month'\];/);
  const buttons = [...HTML.matchAll(/data-calview="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(buttons, ['list', 'twoday', 'week', 'month'],
    'the segmented control must offer every view, ordered by span');
});

test('no reachable state of the toggle empties the app', () => {
  // The no-dead-states rule applied to a view group: every option renders
  // something, and an empty result is explained rather than blank.
  for (const view of ['twoday', 'week', 'month']) {
    assert.ok(APP.includes(`CAL_VIEW === '${view}'`), `${view} has no render branch`);
  }
  // calEmptyReason runs before the view switch, so it covers all four.
  const render = /if \(!ops\.length\) \{[\s\S]*?\n  \}/.exec(APP);
  assert.ok(render && /calEmptyReason\(/.test(render[0]),
    'an empty calendar must name its cause in every view, including this one');
});

test('the view has no steering controls, because it has nothing to steer', () => {
  const period = declaration('renderCalPeriod');
  const branch = /if \(CAL_VIEW === 'twoday'\) \{[\s\S]*?\n  \}/.exec(period);
  assert.ok(branch, 'renderCalPeriod has no 2-day branch');
  assert.doesNotMatch(branch[0], /data-cal-step/,
    'arrows drawn here would be inert — the range is today+tomorrow by definition');
  assert.match(branch[0], /period-label/, 'but the range must still say what it is');
  // …and stepping is refused even if something reaches it.
  assert.match(declaration('stepCalPeriod'), /CAL_VIEW === 'twoday'\) return;/);
});

test('the day count CAPS the lane budget; the measured width decides it', () => {
  // This test used to assert `days.length <= 2 ? 4 : MAX_LANES` outright, on a
  // 1200px measurement: a 7-day column is 164.9px there and a 2-day column
  // 577px, so the counts stood in for widths. They do not. At 375px both
  // collapse to the 120px column floor, where four lanes is 40.88px of chip —
  // measured 38px of overflow out of each chip's own box. The count survives
  // as a CEILING (four slivers in one 2-day column reads as a wall even where
  // the pixels fit); the width may only lower it.
  const fn = declaration('renderCalendarWeekTimed');
  assert.match(fn, /laneBudgetFor\(days\.length, gridWidth, \{/,
    'the budget must be computed from a measured width');
  assert.match(fn, /cap: days\.length <= 2 \? 4 : MAX_LANES,/,
    'the day count belongs here, as the ceiling');
  assert.match(fn, /partitionDenseSlots\(timed, 3, \{ maxLanes: laneBudget \}\)/,
    'the budget must actually reach the partitioner');
  assert.equal(MAX_LANES, 2, 'the seven-day ceiling is unchanged');
  // and the two-day ceiling is really reachable — a cap nothing can reach is
  // a cap that has silently become the budget
  assert.equal(laneBudgetFor(2, 1200, { daycolMin: 120, gutter: 44, laneMin: 80, cap: 4 }), 4);
});

test('the timed renderer is shared, not forked', () => {
  // A second copy of the clock geometry would drift from the Week view within
  // a release — the whole S1-S5 batch was geometry drifting from itself.
  assert.match(APP, /function renderCalendarWeekTimed\(ops, days = weekDays\(CAL_ANCHOR\)(,|\))/,
    'the 2-day view must reuse the Week renderer with a different range');
  // The 2-day view enters the SHARED column renderer, which decides timed or
  // stacked from CAL_TIMES — it no longer calls the timed one directly, because
  // it is no longer always timed (§9.1, reversed by the user).
  assert.match(APP, /renderCalendarWeek\(inView, days\)/);
  assert.match(APP, /function renderCalendarWeek\(ops, days = weekDays\(CAL_ANCHOR\)\) \{\s*\n\s*if \(CAL_TIMES\) return renderCalendarWeekTimed\(ops, days\);/,
    'the untimed grid must take a range and hand the timed case straight on');
  assert.equal((APP.match(/function renderCalendarWeekTimed/g) || []).length, 1,
    'there must be exactly one timed renderer');
});

test('the grid gets its column count from the renderer and its geometry from CSS', () => {
  assert.match(APP, /--daycols:\$\{days\.length\}/,
    'JS supplies the count only');
  assert.doesNotMatch(APP, /grid-template-columns:[^`]*repeat\(/,
    'track sizes must not be inlined by the renderer — they belong in style.css');
});

// --- the clock is a MODE of the view, not a property of the range ----------
//
// Reversed on 2026-08-31 by the user, who saw the always-timed 2-day view
// built and said "2 week should also have the time toggle". The original
// reasoning — an untimed 2-day view is List with two days in it — was a
// defensible design call and simply not theirs to lose.

test('the Times control is offered in BOTH column views', () => {
  const sync = declaration('syncCalControls');
  assert.match(sync, /times\.classList\.toggle\('hidden', CAL_VIEW !== 'week' && CAL_VIEW !== 'twoday'\)/,
    'the 2-day view must offer the clock toggle too');
});

test('…and hidden, not dead, in the two views that cannot draw a clock', () => {
  // The other half. `hidden` on nothing at all would satisfy the assertion
  // above; what makes it right is that List and Month still do NOT get it —
  // a month tile has no room for a scale and a list is not a grid, and a
  // control that is present but does nothing reads as broken.
  const sync = declaration('syncCalControls');
  const rule = /times\.classList\.toggle\('hidden', ([^)]*)\)/.exec(sync);
  assert.ok(rule, 'nothing decides whether the Times control shows');
  for (const [view, shown] of [['week', true], ['twoday', true], ['list', false], ['month', false]]) {
    const hidden = new Function('CAL_VIEW', `return ${rule[1]};`)(view);
    assert.equal(hidden, !shown,
      `the Times control is ${hidden ? 'hidden' : 'shown'} in ${view} view`);
  }
});

test('an untimed 2-day view is the stacked grid scoped to two columns', () => {
  // Not a third renderer, and not the seven-column default with five empty
  // gaps: the same grid, told how many days it holds.
  const fn = declaration('renderCalendarWeek');
  assert.match(fn, /style="--daycols:\$\{days\.length\}"/,
    'the untimed grid must declare its own column count');
  assert.doesNotMatch(fn, /weekDays\(CAL_ANCHOR\)(?![\s\S]*\))/,
    'the range must come from the caller, not be recomputed inside');
  assert.equal((APP.match(/function renderCalendarWeek\(/g) || []).length, 1,
    'there must be exactly one untimed column renderer');
});

test('the toggle re-renders whichever column view is up', () => {
  // The handler is deliberately view-agnostic — it flips the mode and asks the
  // view to redraw itself, so a new column view costs it nothing.
  const handler = /\$\('cal-times'\)\.addEventListener\('click', \(\) => \{([\s\S]*?)\n  \}\);/.exec(APP);
  assert.ok(handler, 'the Times control has no click handler');
  assert.match(handler[1], /CAL_TIMES = !CAL_TIMES;/);
  assert.match(handler[1], /localStorage\.setItem\('calTimes'/, 'the mode must survive a reload');
  assert.match(handler[1], /renderCalendarOps\(\);/);
  assert.doesNotMatch(handler[1], /CAL_VIEW/,
    'the handler must not special-case which view it is in');
});

test('the switch says on or off in SHAPE and ink, never opacity', () => {
  // CALENDAR-SPEC 3.6. The user asked for "an on/off bubble thingy", and a
  // switch earns its place over a toggle button by being legible on its own —
  // you can see it is off without a neighbour to compare it against.
  assert.match(HTML, /id="cal-times"[^>]*class="switch-btn/,
    'the Times control must be the switch, not a ghost button');
  assert.match(HTML, /<span class="switch-track"[\s\S]*?<span class="switch-knob">/,
    'the switch needs a track and a knob to move in it');
  const on = /\.switch-btn\.active \.switch-knob \{([^}]*)\}/.exec(CSS);
  assert.ok(on, 'nothing moves the knob when the switch is on');
  assert.match(on[1], /transform: translateX\(\d+px\)/, 'the knob must MOVE — shape, not colour alone');
  const track = /\.switch-btn\.active \.switch-track \{([^}]*)\}/.exec(CSS);
  assert.ok(track && /background: var\(--accent\)/.test(track[1]),
    'the track must fill, so the state does not rest on knob position alone');
  // and never the thing the spec forbids
  for (const rule of [on[1], track[1]]) {
    assert.doesNotMatch(rule, /opacity/, 'state must never be carried by opacity');
  }
});
