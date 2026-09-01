import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PUBLIC = new URL('../public/', import.meta.url);
const [APP, CSS, HTML] = await Promise.all([
  readFile(new URL('app.js', PUBLIC), 'utf8'),
  readFile(new URL('style.css', PUBLIC), 'utf8'),
  readFile(new URL('index.html', PUBLIC), 'utf8'),
]);

// Comments here quote the rules that were REMOVED, `--kind-color` among them.
// An assertion about what the stylesheet now declares must not be able to read
// its own explanation — this exact trap already cost a false failure once, on a
// comment quoting the `line-height: 1.4` it had replaced.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const CSS_CODE = stripComments(CSS);

const KINDS = [
  'meeting', 'office_hours', 'homework', 'reading', 'exam', 'checkpoint', 'personal',
];

test('every calendar category has an explicit visual token ON ITEMS', () => {
  // The second half of this used to require a FILTER colour per kind too. The
  // user ruled that row colourless — twice — so requiring one would now pin
  // the defect. What the row needs is a label and a count, not a hue.
  for (const kind of KINDS) {
    assert.match(CSS, new RegExp(`\\[data-kind="${kind}"\\]`), `${kind} needs an item colour`);
  }
});

test('list rows, grid chips, and dense stacks expose their category', () => {
  assert.equal((APP.match(/data-kind="\$\{esc\(op\.kind \|\| 'other'\)\}"/g) || []).length, 2);
  assert.match(APP, /class="cal-collision" data-kind="\$\{esc\(sharedKind/);
  assert.match(APP, /class="cal-kind category-label"/);
  assert.match(APP, /class="chip-kind"/);
});

test('timed cards give metadata and titles separate rows, including narrow lanes', () => {
  // This asserted the literal 32 — the very value that could NOT show both
  // rows: measured, a 32px card leaves 7.6px for a 15px title line, so every
  // short deadline sliced its own only title row. The intent below is the
  // original one; the floor is now derived from cal-grid's MIN_BLOCK_MIN so
  // the drawn height and the minutes lane assignment reserves cannot drift.
  // week-geometry.test.js pins the arithmetic that makes it sufficient.
  assert.match(APP, /Math\.max\(y\(endMin\) - top, MIN_BLOCK_PX\)/,
    'short deadlines need enough height to show both rows');
  // Asserted separately rather than as one adjacency regex: the height tier is
  // now a three-way choice spread over several lines, and a proximity match on
  // source layout breaks on formatting rather than on behaviour.
  for (const tier of ["'slot-compact'", "'slot-snug'", "'slot-roomy'"]) {
    assert.ok(APP.includes(tier), `the renderer must emit ${tier}`);
  }
  // `lane-narrow` used to be asserted here, and by the end it was passing on a
  // COMMENT: the class was retired when the narrow treatment moved to a
  // container query (the renderer cannot know how wide a column resolves to),
  // and the only `lane-narrow` left in app.js was the note explaining its
  // absence. Rewording that note would have failed this test while the code
  // was correct — and did. The invariant the assertion was reaching for is
  // that side-by-side cards still get a responsive treatment; it now lives
  // where the pixels are known.
  assert.match(CSS, /@container chip \(max-width: \d+px\)/,
    'side-by-side cards need a responsive treatment keyed to their real width');
  assert.match(CSS,
    /grid-template-areas:\s*"check kind when action"\s*"title title title title"/,
    'task controls and metadata belong above a full-width title');
  assert.match(CSS,
    /\.cal-chip\.placed\.meeting\s*\{[^}]*grid-template-areas:\s*"kind when"\s*"title title"/s,
    'meetings should not reserve empty checkbox space');
});

// --- the filter row is CALM; the grid is where kind colour works ------------
//
// The user: *"there is too much going on with different colors on the calendar
// with the meetings vs. office hours vs. hw, etc. labels at the top."*
// Measured against the previous stylesheet, the default row (an empty
// selection means everything, so every chip was "on") put up 8 label colours,
// 8 tinted backgrounds, 8 border colours AND 8 dots — 32 coloured surfaces.
// Now 1 / 1 / 1, plus the same 8 dots at 7px.

test('the kind filter row carries NO kind colour anywhere', () => {
  // Ruled twice. First pass I moved the hue out of label/background/border and
  // left it in a 7px dot — 32 coloured surfaces down to 8. Verdict: *"you didnt
  // fix the colors they are all still there."* Eight dots is eight colours on
  // the row they named, and splitting the difference was me answering a
  // question they had not asked.
  //
  // Structural, not incidental: the token is not DEFINED for filter selectors,
  // so a future rule cannot reach for a hue that is merely unused here.
  assert.doesNotMatch(CSS_CODE, /\.filter-chip\[data-kind-filter="[a-z_]+"\]/,
    'a filter chip is defining a per-kind colour token again');
  const rules = CSS_CODE.split('}').filter(r => /\.filter-chip/.test(r));
  for (const rule of rules) {
    assert.doesNotMatch(rule, /--kind-color|--kind-soft/,
      `a .filter-chip rule reaches for the kind hue:\n${rule.trim().slice(0, 160)}`);
  }
  assert.doesNotMatch(CSS_CODE, /\.filter-chip[^{]*::before \{/,
    'the colour dot is back on the filter row');
});

test('…and still says which kinds are selected, without it', () => {
  // The other half. A row with no colour is trivially calm and useless if it
  // also stopped saying anything — the frame and the ink have to carry the
  // whole signal now that nothing else can.
  const on = /\.filter-chip\[data-kind-filter\]\.on,\s*\n\.filter-chip\.ai-filter\.on \{([^}]*)\}/.exec(CSS);
  assert.ok(on, 'the selected-chip rule moved — this test is stale');
  assert.match(on[1], /color: var\(--ink\)/, 'a selected chip must say so in ink');
  assert.match(on[1], /border-color: var\(--edge\)/, 'and in its frame');
  const base = /\n\.filter-chip \{([^}]*)\}/.exec(CSS);
  assert.ok(base && /color: var\(--muted\)/.test(base[1]),
    'an unselected chip must be muted, or on and off look identical');
});

test('…while the grid keeps kind colour, which is where it categorises', () => {
  // The other half, and the one that makes the change a REDUCTION rather than
  // a removal. Calming the filter row would be a straight loss if it took the
  // categorisation with it: on an item, the colour answers "what kind is this?"
  // — on a control, it was only decorating the control.
  const label = /\.cal-kind\.category-label \{([^}]*)\}/.exec(CSS);
  assert.ok(label && /color: var\(--kind-color/.test(label[1]),
    'the category label on a chip must still carry its kind colour');
  const row = /\.cal-row\[data-kind\] \{([^}]*)\}/.exec(CSS);
  assert.ok(row && /border-left: 3px solid var\(--kind-color/.test(row[1]),
    'the list row must still carry its kind colour');
});

test('off is said in ink and shape — dashed frame, muted label', () => {
  const off = /\.filter-chip:not\(\.on\) \{([^}]*)\}/.exec(CSS);
  assert.ok(off && /border-style: dashed/.test(off[1]), 'an unselected chip needs a dashed frame');
  // spec 3.6: never opacity. Fading a control on cream walks it into the paper.
  assert.doesNotMatch(off[1], /opacity/, 'state must never be carried by opacity');
});

test('the AI chip keeps its dashed provenance frame in BOTH states', () => {
  // Dashed means "mined by AI" there, so it cannot also mean "off" — which is
  // why that chip gained a dot: its on/off is carried by the label's ink and
  // the dot's fill instead.
  assert.match(CSS, /\.filter-chip\.ai-filter \{ border-style: dashed; \}/,
    'the AI chip must be dashed whether or not it is selected');
  const onRule = /\.filter-chip\[data-kind-filter\]\.on,\s*\n\.filter-chip\.ai-filter\.on \{/.test(CSS);
  assert.ok(onRule, 'the AI chip must share the neutral selected treatment');
  // Its on/off now rests on the label's ink alone — one signal where a kind
  // chip has two. That is what the row had before I briefly gave it a dot, and
  // it is the cost of a colourless row on the one chip whose frame is spoken
  // for. Noted rather than hidden; the user has not objected to this chip.
  assert.match(CSS, /\.filter-chip\.ai-filter:not\(\.on\) \{[^}]*color: var\(--muted\)/,
    'the AI chip must mute its label when off, or its state is unreadable');
});

// --- Times: a MODE control that stopped being its own object ----------------
//
// Third verdict on the same control: *"the times bubble is still ugly."* The
// first two rounds re-tuned the drawn switch's COLOURS (accent fill, then
// --muted); this one was about the object. A 22x11 track with a travelling
// knob was the only thing of its kind on the page, so it read as an
// afterthought however it was painted. It now wears the kind chips' frame.

test('the retired Times switch leaves no hardware behind', () => {
  // Not "the rule is unused" — the selectors are GONE, so a later rule cannot
  // reach for a track or a knob that is merely sitting there. Comments are
  // stripped first: the note explaining the removal names .switch-btn, and an
  // assertion that can read its own explanation is the trap this file's header
  // already records paying for once.
  for (const dead of ['.switch-btn', '.switch-track', '.switch-knob']) {
    assert.doesNotMatch(CSS_CODE, new RegExp(dead.replace('.', '\\.') + '\\b'),
      `${dead} survives the switch it belonged to`);
  }
  assert.doesNotMatch(HTML, /switch-track|switch-knob/, 'the track and knob are still in the markup');
  // The unrelated .switch (a real checkbox input, used outside the calendar)
  // must NOT have been swept up in the removal.
  assert.match(CSS_CODE, /\.switch input:checked \+ \.knob/, 'the unrelated .switch input was removed too');
});

test('the Times control is a chip in the kind-filter family', () => {
  assert.match(HTML, /id="cal-times"[^>]*class="filter-chip mode-chip/,
    'Times must share .filter-chip, not copy its metrics');
  // Shared class, not a copied one: height, radius, padding and type come from
  // the family, so tuning either side cannot drift them apart.
  assert.doesNotMatch(CSS_CODE, /\.mode-chip \{/,
    'a bare .mode-chip rule means the metrics were copied instead of shared');
  // And it must not be reachable by the kind-filter delegation.
  assert.doesNotMatch(HTML, /id="cal-times"[^>]*data-kind-filter/);
});

test('Times says on and off in the row’s own vocabulary', () => {
  const on = /\.filter-chip\.mode-chip\.on \{([^}]*)\}/.exec(CSS);
  assert.ok(on, 'Times has no selected treatment — it would fall through to the accent rule');
  const kindOn = /\.filter-chip\[data-kind-filter\]\.on,\s*\n\.filter-chip\.ai-filter\.on \{([^}]*)\}/.exec(CSS);
  assert.ok(kindOn, 'the kind chips’ selected rule moved — this test is stale');
  // Same words, not merely a similar look.
  for (const decl of ['color: var(--ink)', 'border-color: var(--edge)', 'background: var(--panel)']) {
    assert.ok(on[1].includes(decl), `Times must say on with ${decl}, as the kind chips do`);
    assert.ok(kindOn[1].includes(decl), `the kind chips no longer say on with ${decl} — this test is stale`);
  }
  // Off is the shared dashed rule, not a second opinion about what off means.
  assert.doesNotMatch(CSS_CODE, /\.filter-chip\.mode-chip:not\(\.on\)/,
    'Times must inherit the row’s dashed off-state, not define its own');
  assert.doesNotMatch(on[1], /opacity/, 'state must never be carried by opacity (spec 3.6)');
  assert.doesNotMatch(on[1], /--accent/, 'the toolbar stays colourless');
});

test('toggling Times cannot move anything beside it', () => {
  // The chip is in a toolbar with two ghost buttons; if `on` changed any
  // dimension, every toggle would nudge its neighbours. On and off may differ
  // only in border STYLE and colour — dashed and solid are both 1px.
  const on = /\.filter-chip\.mode-chip\.on \{([^}]*)\}/.exec(CSS)[1];
  for (const dimension of ['padding', 'font-size', 'border-width', 'letter-spacing', 'gap', 'width']) {
    assert.doesNotMatch(on, new RegExp(`(^|;|\\s)${dimension}\\s*:`),
      `the selected chip changes ${dimension}, so the toolbar shifts when Times is toggled`);
  }
  const base = /\n\.filter-chip \{([^}]*)\}/.exec(CSS)[1];
  const weightOf = (rule) => (/font-weight:\s*([^;]+)/.exec(rule) || [])[1]?.trim();
  assert.equal(weightOf(on), weightOf(base),
    'a heavier selected label re-measures the text and shifts the row');
});

test('the Times chip takes the family’s state class, not the ghost buttons’', () => {
  assert.match(APP, /times\.classList\.toggle\('on', CAL_TIMES\)/,
    'the chip family says selected with .on; .active would leave it styled as off');
});
