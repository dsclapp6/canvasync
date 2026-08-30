// cal-recurrence.test.js — the calendar trio (audit I5, I2, I4).
//
// All three are app.js, which needs a DOM and cannot be imported, so the pure
// decisions were separated out and are executed here from the CURRENT source;
// what genuinely cannot be extracted is asserted structurally and labelled as
// such. Same technique as cal-format.test.js and file-view.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAiItemVisible } from '../public/cal-plan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = await readFile(path.join(HERE, '..', 'public', 'app.js'), 'utf8');

function declaration(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js no longer declares ${name}() — this test is stale, not passing`);
  let i = SRC.indexOf('(', start);
  for (let depth = 0; i < SRC.length; i++) {
    if (SRC[i] === '(') depth++;
    else if (SRC[i] === ')' && !--depth) { i++; break; }
  }
  for (let j = SRC.indexOf('{', i), depth = 0; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && !--depth) return SRC.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}
const constant = (name) => {
  const m = new RegExp(`const ${name} = \\{[^}]*\\};`).exec(SRC);
  assert.ok(m, `app.js no longer declares ${name}`);
  return m[0];
};

const NAMES = ['calRecurrenceLabel', 'calLastDate', 'calEmptyReason'];
const { calRecurrenceLabel, calLastDate, calEmptyReason } = new Function(
  `${constant('RRULE_DAYS')}\n${NAMES.map(declaration).join('\n')}\nreturn { ${NAMES.join(', ')} };`)();

// --- I5: a weekly op must say it repeats -----------------------------------

test('I5: a weekly op is labelled with the days it repeats on', () => {
  // Office hours are ONE op carrying recurrence, anchored on the first
  // occurrence. The adoption commit dropped the tag that said so, and grep for
  // `recurrence` across bridge/public/ then returned nothing: a standing
  // commitment for the whole term rendered as a single dated event, while
  // classes.ics — built from the same op — repeated it every week.
  assert.equal(calRecurrenceLabel({ recurrence: { freq: 'WEEKLY', byday: ['MO'] } }), 'weekly Mon');
  assert.equal(calRecurrenceLabel({ recurrence: { freq: 'WEEKLY', byday: ['MO', 'WE'] } }), 'weekly Mon, Wed');
  assert.equal(
    calRecurrenceLabel({ recurrence: { freq: 'WEEKLY', byday: ['MO', 'WE', 'FR'] } }),
    'weekly Mon, Wed, Fri', 'the three real shapes in the live worklist');
  // An unknown day code is passed through rather than dropped — a label that
  // silently loses a day is worse than one that shows a code.
  assert.equal(calRecurrenceLabel({ recurrence: { freq: 'WEEKLY', byday: ['ZZ'] } }), 'weekly ZZ');
});

test('I5: a non-recurring op gets no tag', () => {
  // The discriminating half. A label function that returned a string for
  // everything would satisfy every assertion above and put "weekly" on all 311
  // ops in the worklist.
  for (const op of [
    {},
    { recurrence: null },
    { recurrence: { freq: 'WEEKLY' } },                    // no byday
    { recurrence: { freq: 'WEEKLY', byday: [] } },         // empty byday
    { recurrence: { freq: 'DAILY', byday: ['MO'] } },      // not weekly
  ]) {
    assert.equal(calRecurrenceLabel(op), '', `expected no tag for ${JSON.stringify(op)}`);
  }
});

test('I5: past-ness for a repeat is measured from the series end, not its anchor', () => {
  // The second half of I5: once the anchor date passed, the past-schedule fold
  // hid a live weekly commitment. The anchor is the FIRST occurrence.
  assert.equal(
    calLastDate({ date: '2026-08-24', recurrence: { freq: 'WEEKLY', byday: ['MO'], until: '2026-12-13' } }),
    '2026-12-13', 'a weekly op lasts until its `until`');
  assert.equal(calLastDate({ date: '2026-09-10' }), '2026-09-10', 'a one-off is its own last day');
  // A malformed until must not be trusted into the comparison.
  assert.equal(calLastDate({ date: '2026-09-10', recurrence: { until: 'whenever' } }), '2026-09-10');
  assert.equal(calLastDate({ date: '2026-09-10', recurrence: { until: null } }), '2026-09-10');
});

test('I5: the row renders the tag, and BOTH past-ness sites use the series end', () => {
  // Structural: calOpRow needs a DOM. The count and the filter must use the
  // same rule — a summary that disagrees with what is drawn is worse than
  // either being wrong alone.
  const row = declaration('calOpRow');
  assert.match(row, /calRecurrenceLabel\(op\)/, 'calOpRow no longer computes the recurrence tag');
  assert.match(row, /\$\{recurs \?/, 'the tag is computed but never rendered');
  const pastSites = SRC.split('\n').filter(l => /daysUntil\(.*\)\s*<\s*0 &&.*office_hours/.test(l));
  assert.equal(pastSites.length, 2, `expected the count and the filter, found ${pastSites.length}`);
  for (const line of pastSites) {
    assert.match(line, /daysUntil\(calLastDate\(o\)\)/,
      `a past-schedule site still measures the anchor: ${line.trim()}`);
  }
});

// --- I2: Show completed outranks the AI filter -----------------------------

test('I2: the AI filter genuinely drops an AI-added row (the premise)', () => {
  // Establish the mechanism before asserting the exemption, or the next test
  // proves nothing: with the chip off, an AI-added item is not visible.
  assert.equal(isAiItemVisible(false, true), false, 'AI off hides AI-added items');
  assert.equal(isAiItemVisible(true, true), true);
  assert.equal(isAiItemVisible(false, false), true, 'and never touches Canvas-backed work');
});

test('I2: a completed row bypasses the AI-origin filter', () => {
  // Structural, because the filter is inline in a DOM renderer. With the AI
  // chip off, ticking an AI-added reading by mistake left a button reading
  // "Show 1 completed" that produced no row: the label counts the unfiltered
  // done list, the filter dropped the row again, and nothing named the second
  // chip you had to flip. Show completed is an explicit request to see
  // finished work, and spec 2.5 calls it the one control that can resurrect a
  // mis-ticked item.
  const renderer = declaration('renderCalendarOps');
  assert.match(renderer, /const byOrigin = byKind\.filter\(o =>\s*\n?\s*o\._completed \|\| isAiItemVisible\(/,
    'completed rows no longer bypass the AI-origin filter');
});

// --- I4: name the control that emptied the view ----------------------------

const reason = (o) => calEmptyReason({ shown: '', matching: 0, aiHidHere: 0, hiddenPast: 0, ...o });

test('I4: the AI toggle is named when it is what hid the selection', () => {
  // The shipped bug: the old guard only fired when AI-hidden items emptied the
  // view GLOBALLY, so a selected class whose items are all AI-added fell
  // through and blamed the class chips — sending the user to deselect a class
  // that was selected and did have items.
  const one = reason({ matching: 5, aiHidHere: 1 });
  assert.match(one, /AI-added/);
  assert.match(one, /turn on AI-added/);
  assert.doesNotMatch(one, /deselect/, 'the class chips are innocent here');
  assert.match(one, /1 matching item is/, 'singular reads correctly');
  assert.match(reason({ matching: 9, aiHidHere: 4 }), /4 matching items are/);
});

test('I4: past-only messaging cannot mask AI-hidden upcoming work', () => {
  // The subtler shape: a selection whose only VISIBLE rows are past meetings
  // while AI-hidden future items sit behind the chip. Naming only the past
  // toggle would send the user to a control that reveals nothing they want.
  const both = reason({ matching: 8, aiHidHere: 5, hiddenPast: 3 });
  assert.match(both, /AI-added/, 'the AI toggle must be named');
  assert.match(both, /already happened/, 'and so must the past one');
});

test('I4: the innocent controls are still named when they ARE the cause', () => {
  // The other half, and the one with teeth: a message that always blamed the
  // AI toggle would pass both tests above while being wrong every other time.
  assert.match(reason({ matching: 4, hiddenPast: 2 }), /already happened/);
  assert.doesNotMatch(reason({ matching: 4, hiddenPast: 2 }), /AI-added/);
  assert.match(reason({ matching: 4 }), /deselect one above/);
  assert.doesNotMatch(reason({ matching: 4 }), /AI-added/);
  assert.match(reason({ matching: 0, shown: 'readings' }), /No readings items in this window/);
  assert.match(reason({ matching: 0 }), /^No items in this window/);
});
