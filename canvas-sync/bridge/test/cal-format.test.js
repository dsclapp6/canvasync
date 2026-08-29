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

const NAMES = ['fmtTime12', 'fmtTimeSpan', 'calPoints', 'calUrl'];
const { fmtTimeSpan, calPoints, calUrl } = new Function(
  `${NAMES.map(declaration).join('\n')}\nreturn { ${NAMES.join(', ')} };`)();

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

