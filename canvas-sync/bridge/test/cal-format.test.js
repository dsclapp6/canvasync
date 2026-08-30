// cal-format.test.js — the calendar's small formatters, run rather than read.
//
// These four live in app.js, which is a browser module with a DOM and no
// exports, so a test cannot import them. progress-page.test.js has the same
// problem with progress.html and solves it the same way: lift the source out
// of the file and run it. That is deliberately literal — the functions below
// are executed from the CURRENT app.js text, so a fix that gets reverted fails
// here rather than passing against a stale copy.
//
// Each case is a defect that shipped, not a hypothetical:
//
//   fmtTimeSpan  printed an END time where a START goes when the start was
//                unreadable, so an item finishing at 3pm read as starting then;
//   calPoints    accepted any run of digits and dots, so a truncated
//                description put "... pts" on a calendar chip;
//   calUrl       kept the sentence's punctuation inside the href, so a link
//                followed by a full stop or a closing paren 404'd — while
//                content-format.js's autolinker, on the same URL in prose,
//                stripped it correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spanDates } from '../public/cal-grid.js';

// fileURLToPath, never import.meta.url's raw pathname — a raw-pathname compare
// silently no-ops when the path holds characters the URL form escapes.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = await readFile(path.join(HERE, '..', 'public', 'app.js'), 'utf8');

/** One `function name(...) {...}` declaration, verbatim, by brace matching. */
function declaration(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js no longer declares ${name}() — this test is stale, not passing`);
  // Skip the parameter list first: a destructured default such as
  // `{ done = false } = {}` puts braces before the body.
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

const NAMES = [
  'esc', 'fmtTime12', 'fmtTimeChip', 'fmtTimeSpan', 'calPoints', 'calUrl',
  'calDate', 'fmtDayLabel', 'calWhenLabel', 'calSubmitHtml', 'stripClassPrefix',
  'calKindShort',
];
// calWhenLabel reads spanDates, which is a real import in app.js — hand it the
// genuine one from cal-grid.js rather than a stub, so span behaviour under test
// is the behaviour that ships.
const {
  fmtTimeChip, fmtTimeSpan, calPoints, calUrl, calWhenLabel, calSubmitHtml,
  stripClassPrefix, calKindShort,
} = new Function('spanDates',
  `${NAMES.map(declaration).join('\n')}\nreturn { ${NAMES.join(', ')} };`)(spanDates);

test('fmtTimeSpan never presents an end time as if it were a start', () => {
  // The defect: an unreadable start fell through to `return a || b`, so the
  // end was printed bare — indistinguishable from a start time.
  assert.equal(fmtTimeSpan('junk', '15:00'), 'until 3:00 PM');
  assert.doesNotMatch(fmtTimeSpan('junk', '15:00'), /^3:00 PM$/);
  // Neither end readable: say nothing rather than something wrong.
  assert.equal(fmtTimeSpan('junk', 'junk'), '');
  assert.equal(fmtTimeSpan('junk', null), '');
});

test('fmtTimeSpan still collapses a shared meridiem and keeps a crossing one', () => {
  assert.equal(fmtTimeSpan('14:30', '15:45'), '2:30–3:45 PM');
  assert.equal(fmtTimeSpan('11:30', '13:00'), '11:30 AM–1:00 PM');
  assert.equal(fmtTimeSpan('12:30', '13:45'), '12:30–1:45 PM');   // noon
  assert.equal(fmtTimeSpan('00:30', '01:45'), '12:30–1:45 AM');   // midnight
  assert.equal(fmtTimeSpan('09:00', null), '9:00 AM');
  assert.equal(fmtTimeSpan('14:00', 'junk'), '2:00 PM');
});

test('calPoints reads a number or nothing, never a run of dots', () => {
  assert.equal(calPoints('Points: ...'), null);
  assert.equal(calPoints('Points:   .'), null);
  assert.equal(calPoints('Points: '), null);
  assert.equal(calPoints('Points: 10'), '10');
  assert.equal(calPoints('Points: 10.5'), '10.5');
  assert.equal(calPoints('Points: 0'), '0');
  // A trailing full stop is the sentence's; the score is still 10.
  assert.equal(calPoints('Points: 10.'), '10');
  // Two decimal points is not a score. Take the number, not the wreckage.
  assert.equal(calPoints('Points: 1.2.3'), '1.2');
  assert.equal(calPoints(null), null);
});

test('calUrl leaves sentence punctuation outside the link', () => {
  assert.equal(calUrl('See https://canvas.edu/a/1. Then read.'), 'https://canvas.edu/a/1');
  assert.equal(calUrl('Link: https://canvas.edu/x)'), 'https://canvas.edu/x');
  assert.equal(calUrl('(https://canvas.edu/y)'), 'https://canvas.edu/y');
  assert.equal(calUrl('Ends here https://canvas.edu/z,'), 'https://canvas.edu/z');
  // A paren the URL opened itself belongs to the URL.
  assert.equal(calUrl('https://en.wikipedia.org/wiki/Foo_(bar)'),
    'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(calUrl('no link here'), null);
  assert.equal(calUrl(null), null);
});

// ---------------------------------------------------------------------------
// The column the phrase above is drawn into.
//
// .hu-rel was styled twice at the same specificity: an early block set
// `font-family: var(--mono); min-width: 11ch` with a comment explaining the
// reasoning, and a later one-liner set sans and 9.5ch. The later rule won, so
// the documented block never applied to a single render and the comment
// described a layout the browser had never produced. Nothing looked broken,
// which is exactly why it survived.
// ---------------------------------------------------------------------------
const CSS = await readFile(path.join(HERE, '..', 'public', 'style.css'), 'utf8');

/** Top-level rules only — an @media block may legitimately re-declare. */
function topLevelRules(css) {
  let depth = 0, start = 0, out = [], selector = null;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth === 0) { selector = css.slice(start, i); start = i + 1; }
      depth++;
    } else if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        // An at-rule body holds nested rules, not declarations of its own.
        if (!selector.trim().startsWith('@')) out.push([selector, css.slice(start, i)]);
        start = i + 1;
      }
    }
  }
  return out;
}

test('a .hu-rel property is declared in exactly one place', () => {
  const seen = new Map();
  for (const [selector, body] of topLevelRules(CSS)) {
    if (!/(^|[\s,])\.hu-rel(\s|,|$)/.test(selector)) continue;
    for (const decl of body.split(';')) {
      const prop = decl.split(':')[0].trim();
      if (!prop || prop.startsWith('/*')) continue;
      seen.set(prop, (seen.get(prop) ?? 0) + 1);
    }
  }
  assert.ok(seen.size > 0, '.hu-rel is not styled at all — this test is stale');
  const doubled = [...seen].filter(([, n]) => n > 1).map(([prop]) => prop);
  assert.deepEqual(doubled, [],
    `declared twice at equal specificity, so the earlier one never applies: ${doubled.join(', ')}`);
});

test('the .hu-rel column is a floor, not a cap, and says so honestly', () => {
  // relPhrase() genuinely emits past phrases, and its longest output is 13
  // characters. The floor is smaller than that on purpose — flex: none with no
  // overflow rule means a longer phrase widens the column instead of clipping.
  // The comment must not claim a width the CSS does not set.
  const block = CSS.slice(CSS.indexOf('.hu-rel'));
  assert.doesNotMatch(CSS, /the list never shows the past/,
    'relPhrase does show the past ("2 weeks ago"); the comment claimed otherwise');
  assert.match(block, /flex: none/, '.hu-rel must stay flex: none so the floor cannot clip');
});


// ---------------------------------------------------------------------------
// Chip and row markers.
//
// A calendar chip is ~170px wide with a two-line title clamp, so every glyph in
// it competes with the title. The rule these guard is that a marker must read
// as a MARKER: punctuation standing alone in a cramped chip is indistinguishable
// from a truncation artifact, and the calendar already spends dashes on time
// ranges ("2:30–3:45 PM") and on day spans ("Mon 24 – Wed 26").
// ---------------------------------------------------------------------------

test('a no-submit marker is a word, never a bare dash', () => {
  // The shipped bug: dense mode rendered `&mdash;`, and `.cal-chip .cal-nolink`
  // strips the pill border that makes it legible in the list. 73 of 143 due ops
  // in the live worklist carry one of these, so it was on half the chips.
  const ai = calSubmitHtml({ aiAdded: true }, { dense: true });
  const nolink = calSubmitHtml({ noLink: true }, { dense: true });

  const strip = (html) => html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, '');

  for (const [name, html] of [['ai-added', ai], ['no-link', nolink]]) {
    const text = strip(html);
    assert.ok(/[A-Za-z]/.test(text), `${name} marker has no letters: ${JSON.stringify(html)}`);
    assert.doesNotMatch(text, /^[\s–—-]*$/,
      `${name} marker is punctuation only: ${JSON.stringify(text)}`);
    assert.doesNotMatch(html, /&mdash;|&ndash;/,
      `${name} marker still emits a dash entity: ${html}`);
  }

  // The other half, and the half with teeth. "It says a word" is satisfied by
  // rendering the LIST form on a chip, which is the mistake this guards: the
  // marker sits in an `auto` grid track beside a two-line-clamped title, so a
  // long dense form steals the title's width and an internal space gives it
  // somewhere to wrap. Sameness without discrimination proves nothing.
  for (const [name, m] of [['ai-added', { aiAdded: true }], ['no-link', { noLink: true }]]) {
    const dense = strip(calSubmitHtml(m, { dense: true }));
    const full = strip(calSubmitHtml(m));
    assert.notEqual(dense, full, `${name} dense form is just the list form — the ternary is gone`);
    assert.ok(dense.length < full.length, `${name} dense form is not shorter: ${dense} vs ${full}`);
    assert.ok(dense.length <= 4, `${name} dense form too wide for the chip track: ${dense}`);
    assert.doesNotMatch(dense, /\s/, `${name} dense form has a space to wrap at: ${dense}`);
  }
});

test('the marker element CALENDAR-SPEC 2.8 and 2.13 count is still emitted', () => {
  // The fix changed the marker's TEXT, not its presence. 2.8 wants a
  // `.cal-nolink` on an item with no URL; 2.13 wants `.cal-nolink.ai` on
  // AI-added work, in all three views. Both verifications count the element.
  assert.match(calSubmitHtml({ aiAdded: true }, { dense: true }), /class="cal-nolink ai"/);
  assert.match(calSubmitHtml({ aiAdded: true }), /class="cal-nolink ai"/);
  assert.match(calSubmitHtml({ noLink: true }, { dense: true }), /class="cal-nolink"/);
  // …and an item that CAN be submitted gets a link, not a marker.
  const submit = calSubmitHtml({ submitUrl: 'https://canvas.edu/s/1' }, { dense: true });
  assert.match(submit, /class="cal-submit dense"/);
  assert.doesNotMatch(submit, /cal-nolink/);
  // A meeting is neither: no marker at all, so no dead control and no noise.
  assert.equal(calSubmitHtml({}, { dense: true }), '');
});

test('the marker escapes nothing user-controlled into the chip', () => {
  // submitUrl is the only caller-supplied value here; it must not break out.
  const html = calSubmitHtml({ submitUrl: 'https://x.edu/a"onmouseover=alert(1)' }, { dense: true });
  assert.doesNotMatch(html, /"onmouseover/, 'attribute broke out of its quotes');
  assert.match(html, /&quot;onmouseover/);
});

test('calWhenLabel: every shape a row can be', () => {
  assert.equal(calWhenLabel({ date: '2026-09-10', all_day: true }), 'All day');
  assert.equal(calWhenLabel({ date: '2026-09-10' }), '—', 'no time and not all-day is genuinely unknown');
  assert.equal(calWhenLabel({ date: '2026-09-10', time: '14:30', end_time: '15:45' }), '2:30–3:45 PM');
  assert.equal(calWhenLabel({ date: '2026-09-10', time: '14:30' }), '2:30 PM');
  // A multi-day run says so — "All day" over three days is a third of the truth.
  assert.equal(calWhenLabel({ date: '2026-09-10', end_date: '2026-09-12' }), 'Thu 9/10 – Sat 9/12');
  assert.equal(calWhenLabel({ date: '2026-09-10', end_date: '2026-09-12', time: '09:00' }),
    '9a Thu 9/10 – Sat 9/12');
  // An end before the start is not a span; spanDates degrades it to one day.
  assert.equal(calWhenLabel({ date: '2026-09-10', end_date: '2026-09-08', all_day: true }), 'All day');
});

test('calWhenLabel never emits a dangling range dash', () => {
  // The other half of the same rule: a range separator with nothing after it
  // reads exactly like the bug above.
  for (const op of [
    { date: '2026-09-10', time: '14:30', end_time: '' },
    { date: '2026-09-10', time: '14:30', end_time: null },
    { date: '2026-09-10', time: '14:30', end_time: 'garbage' },
    { date: '2026-09-10', time: '', end_time: '15:00' },
    { date: '2026-09-10', time: 'noon', end_time: '15:00' },
  ]) {
    const out = calWhenLabel(op);
    // A LONE em dash is the deliberate "no time known" placeholder, and in the
    // list it owns its own column, so it reads as an empty cell rather than as
    // stray punctuation beside text. That is the distinction: a dash may BE the
    // value, but it may never dangle off one.
    if (out === '—') continue;
    assert.doesNotMatch(out, /[–—-]\s*$/, `trailing range dash in ${JSON.stringify(out)}`);
    assert.doesNotMatch(out, /^\s*[–—]\s*\S/, `leading range dash in ${JSON.stringify(out)}`);
  }
  // The start we could not read must not be printed as if it were a start.
  assert.equal(calWhenLabel({ date: '2026-09-10', time: 'noon', end_time: '15:00' }),
    'until 3:00 PM');
});

test('stripClassPrefix removes the class only when it really is the prefix', () => {
  assert.equal(stripClassPrefix('BUSI 380 · Read Ch 4', 'busi-380'), 'Read Ch 4');
  assert.equal(stripClassPrefix('BUSI 380 002: Read ch. 4', 'busi-380-002'), 'Read ch. 4');
  // A different class's name is not a prefix to strip.
  assert.equal(stripClassPrefix('ECON 205 · Read Ch 4', 'busi-380'), 'ECON 205 · Read Ch 4');
  // A separator that is not the class prefix survives — this is the case that
  // would otherwise leave a title starting with a dangling separator.
  assert.equal(stripClassPrefix('Read: chapter 4', 'busi-380'), 'Read: chapter 4');
  assert.equal(stripClassPrefix('· leading dot', 'busi-380'), '· leading dot');
  assert.equal(stripClassPrefix('BUSI 380', 'busi-380'), 'BUSI 380', 'nothing after the code to keep');
  // Whatever it returns must never begin with a naked separator.
  for (const t of ['BUSI 380 · Read Ch 4', 'BUSI 380 002: Read ch. 4', 'Read: chapter 4']) {
    assert.doesNotMatch(stripClassPrefix(t, 'busi-380'), /^\s*[·:—–-]/,
      `left a dangling separator on ${JSON.stringify(t)}`);
  }
});

test('calKindShort is short, uppercase and never empty', () => {
  assert.equal(calKindShort('meeting'), 'CLASS');
  assert.equal(calKindShort('office_hours'), 'OH');
  assert.equal(calKindShort('homework'), 'HW');
  assert.equal(calKindShort('reading'), 'READ');
  // Every kind the live worklist actually contains is mapped, so the truncating
  // fallback below is a guard rather than a shipped path.
  for (const kind of ['homework', 'meeting', 'checkpoint', 'reading', 'exam', 'office_hours']) {
    assert.ok(calKindShort(kind).length <= 5, `${kind} badge too wide`);
  }
  // Unknown, absent and empty must still produce a readable badge.
  for (const kind of [undefined, null, '', 'quiz', 'some_new_kind']) {
    const out = calKindShort(kind);
    assert.ok(out.length > 0 && out.length <= 5, `bad badge for ${JSON.stringify(kind)}: ${out}`);
    assert.equal(out, out.toUpperCase());
  }
  assert.equal(calKindShort(undefined), 'ITEM');
  assert.equal(calKindShort(''), 'ITEM');
});

test('fmtTimeChip: the compact form at both meridiem hinges', () => {
  assert.equal(fmtTimeChip('00:00'), '12a');
  assert.equal(fmtTimeChip('00:30'), '12:30a');
  assert.equal(fmtTimeChip('12:00'), '12p');
  assert.equal(fmtTimeChip('12:30'), '12:30p');
  assert.equal(fmtTimeChip('23:59'), '11:59p');
  assert.equal(fmtTimeChip('9:05'), '9:05a');
  // Unreadable input yields nothing rather than a partial chip.
  for (const bad of ['', null, undefined, 'noon', 'TBD', '2:3']) {
    assert.equal(fmtTimeChip(bad), '', `expected empty for ${JSON.stringify(bad)}`);
  }
});
