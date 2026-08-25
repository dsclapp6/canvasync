# Link audit — every Canvas URL surface

Audited 2026-08-24 against `canvas-links.js` (repo root, mtime 09:59).

**The bug.** Canvas returns `html_url` on every assignment. For a quiz-backed
assignment that URL is `/courses/:c/assignments/:a` — the *teacher's* view of
the object. A student following it gets Access Denied. The page they may open is
`/courses/:c/quizzes/:quizId`. `canvasItemUrl()` performs that rewrite;
`canvasSubmitUrl()` gives the matching submit route (or `null` when there is
nothing to submit to); `needsUrlRewrite()` reports whether the URL moved.

**Scope of the damage on this machine:** 39 of 89 synced assignments (44%) — all
of them in BUSI 380 — were dead ends. See [Per-class exposure](#per-class-exposure).

Line numbers in `bridge/public/app.js`, `bridge/public/index.html`,
`bridge/server.js` and `scripts/sync-calendar.js` were read while another process
was editing them; anchor text is quoted alongside each so the reference survives
a shift.

---

## Summary

| Verdict | Count | Meaning |
| --- | ---: | --- |
| fixed | 16 | goes through `canvasItemUrl` / `canvasSubmitUrl` |
| still-raw | 0 | — |
| gap | 0 | — |
| not-applicable | 21 | API paths, host permissions, file URLs, fixtures, mocks |

**Closed 2026-08-24.** Every surface this audit found now routes through
`canvas-links.js`. The two still-raw hits (R1, R2 in `scripts/build-context.js`)
and the three gaps (G1-G3) have all landed, as have the five defects the review
pass found in `canvas-links.js` itself — including the only one with live
impact, six `external_tool` rows that offered a Submit button going nowhere.

Per-item status is in [Checklist](#checklist--all-items-closed) at the foot of
this document; the diagnosis sections below are left as written so the reasoning
stays readable, each with its original verdict plus what shipped.

---

## FIXED

### bridge — the dashboard's assignment panel

| # | Location | Links to | Verdict |
| --- | --- | --- | --- |
| 1 | `bridge/server.js:29` — `import { canvasItemUrl, canvasSubmitUrl } from '../canvas-links.js'` | — | **fixed** |
| 2 | `bridge/server.js:989` — `url: a ? canvasItemUrl(a) : null` | the assignment/quiz/discussion page, on `GET /api/class/:folder/assignment/:id` | **fixed** |
| 3 | `bridge/server.js:990` — `submit_url: a ? canvasSubmitUrl(a) : null` | `/take` or `/submissions/new`, `null` when unsubmittable | **fixed** |
| 4 | `bridge/public/index.html:125` — `<a id="assignment-open" … >Open in Canvas</a>` | href set from `a.url` | **fixed** |
| 5 | `bridge/public/index.html:126` — `<a id="assignment-submit" … >Submit</a>` | href set from `a.submit_url`; hidden when null | **fixed** |
| 6 | `bridge/public/app.js:703` — `if (a.url) open.href = a.url` | corrected item URL | **fixed** |
| 7 | `bridge/public/app.js:706` — `if (a.submit_url) submit.href = a.submit_url` | corrected submit URL | **fixed** |

Both anchors carry `target="_blank" rel="noopener noreferrer"`, and in the
Electron shell `app/main.js:237` (`setWindowOpenHandler`) hands them to
`shell.openExternal`, so the corrected URL is what reaches the real browser.

### scripts/sync-calendar.js — the calendar worklist

| # | Location | Links to | Verdict |
| --- | --- | --- | --- |
| 8 | `scripts/sync-calendar.js:48` — import | — | **fixed** |
| 9 | `scripts/sync-calendar.js:306` — `html_url: canvasItemUrl(a)` (in `itemsFromCanvasAssignments`) | unmined classes: every Canvas assignment | **fixed** |
| 10 | `scripts/sync-calendar.js:307` — `submit_url: canvasSubmitUrl(a)` | same | **fixed** |
| 11 | `scripts/sync-calendar.js:410-411` — `it.html_url = canvasItemUrl(a); it.submit_url = canvasSubmitUrl(a)` | mined classes: joined back to Canvas by `canvas_assignment_id` | **fixed** — see gap G3 |

Downstream of those, both consumers inherit the corrected value:

- `scripts/sync-calendar.js:136` — `if (it.html_url) descLines.push(it.html_url)`
  puts the URL in the event description. **fixed** (transitively).
- `scripts/sync-calendar.js:158-159` — `url: it.html_url || null, submit_url:
  it.submit_url || null` carries them as first-class op fields into
  `worklist.json`. **fixed**.

**Existing calendar events self-heal.** `markerOp` (`sync-calendar.js:103`)
derives `marker_prefix` by cutting at the last `|`, so the prefix stays
`[csync:a|532620|` while only the trailing content hash changes. The routine's
own instructions (`sync-calendar.js:322`) say prefix-match ⇒ UPDATE in place.
The 39 BUSI 380 events already on the calendar will be rewritten, not duplicated.

---

## STILL-RAW

### R1 — `scripts/build-context.js:71`

```js
if (a.html_url) lines.push(`- Link: ${a.html_url}`);
```

In `renderAssignmentFull()`. Emits `- Link: https://canvas.rice.edu/courses/93903/assignments/532620`
into `AI_CONTEXT/context.md` and `AI_CONTEXT/pack/01-course-overview.md`.
For BUSI 380 that is 39 denied links per regeneration.

**VERDICT at audit time: still-raw.** `build-context.js` did not import
`canvas-links.js` at all (imports checked at lines 1-11; file mtime Aug 23
10:03, predating the fix).

**FIXED.** It now imports both helpers and emits `- Link: ${canvasItemUrl(a)}`,
plus a `- Submit:` line when `canvasSubmitUrl(a)` gives a different route.

### R2 — `scripts/build-context.js:201`

```js
if (canvas.html_url) extras.push(`[Canvas link](${canvas.html_url})`);
```

In the per-task section, joining a mined item back to its Canvas row. Emits a
markdown link that the dashboard turns into a live anchor via the `inlineMd`
renderer at `bridge/public/app.js:55`. So this one is not just text in a file —
it becomes a clickable dead link in the UI.

**VERDICT at audit time: still-raw.**

**FIXED.** `extras.push(\`[Canvas link](${canvasItemUrl(canvas)})\`)`, so the
anchor the dashboard renders now points at the quiz form for quiz-backed work.
The artifacts on disk were regenerated afterwards — see
[Stale artifacts](#stale-artifacts-on-disk).

---

## GAPS — right today, but not robustly

### G1 — the calendar row in the dashboard reads the URL out of prose

`bridge/public/app.js:1334` —

```js
function calUrl(description) {
  const m = /(https?:\/\/\S+)/.exec(description || '');
  return m ? m[1] : null;
}
```

used at `:1349` (`const url = calUrl(op.description)`) and rendered at `:1352`.

The op already carries `op.url` and `op.submit_url` as structured fields
(`sync-calendar.js:158-159`, added by this fix, with the comment "Carried as
fields (not just inside the description) so the dashboard can render Open/Submit
without re-parsing prose"). The renderer does not use them yet.

It happens to produce the corrected link, because `sync-calendar.js:136` pushes
the already-rewritten `it.html_url` into the description. But it takes the
**first** `http(s)` run in the description, and `it.description` is pushed first
(`sync-calendar.js:129`) — any URL inside a mined description wins over the
Canvas link. There is also no Submit affordance on a calendar row.

**VERDICT at audit time: fixed by accident.**

**FIXED.** `calOpRow` reads `op.url` and `op.submit_url` as fields and renders a
Submit chip from the latter; no prose is parsed.

### G2 — `worklist.md` drops the structured URL fields

`renderWorklistMd` (`scripts/sync-calendar.js:346-355`) emits `calendar`,
`date`, `location`, `recurrence`, `description`, `marker`, `marker_prefix` — but
not `url` or `submit_url`. The calendar routine that consumes the markdown gets
the corrected item URL only because it is embedded in the description string;
`submit_url` never reaches it at all, so no calendar event can offer Submit.

**VERDICT at audit time: gap.**

**FIXED.** `renderWorklistMd` prints `- url:` and, when it differs,
`- submit_url:`. The event description gained a matching `Submit: <url>` line,
so the link survives into the calendar event itself.

### G3 — mined classes with no `assignments.json` get no URL

The join at `sync-calendar.js:407-412` only fires when the mined item has a
`canvas_assignment_id` **and** that id is present in `assignments.json`.

On disk today, BUSI 305 (`92294-busi-305-001-002-003`) is the only class with
mined items — 7 of them — and its `assignments.json` is `[]`. All 7 come out
with `html_url` and `submit_url` undefined, so those calendar events have no
link at all.

**VERDICT at audit time: gap, not a regression** (they had no link before
either).

**FIXED, and it turned out to be hiding a second, larger bug.** The join moved
into `canvas-tasks.js`, where a mined item whose `canvas_assignment_id` has no
matching Canvas row now has its `submit_url` cleared — an unverifiable Submit
button is exactly the denied-access failure this work exists to remove, so no
button beats a dead one.

The larger bug: `tasksForClass` treated mined output as a *replacement* for the
Canvas rows. BUSI 305 is the only class mined so far and its `assignments.json`
is `[]`, so nothing was visibly wrong — but the first time mining ran on BUSI
380 its 41 dated Canvas assignments would have vanished from both the class page
and the calendar. It is now a union: mined items first, then every dated Canvas
row that no mined item claims by id or by flattened title. `source` reports
`mined`, `canvas` or `mixed`. Ten tests in `bridge/test/canvas-tasks.test.js`.

---

## NOT-APPLICABLE

These matched the greps (`html_url`, `canvas.rice`, `/courses/`, `https?://`)
but are not student-facing item links.

| Location | What it is |
| --- | --- |
| `bridge/server.js:991` — `raw_url: a?.html_url ?? null` | Deliberately the raw URL. Consumed only by `app.js:729`, which renders it as `<span class="mono">` **text**, never an href, to explain why the button points elsewhere. Correct as-is. |
| `bridge/public/app.js:729-731` | The explanatory footnote above. Text, not a link. |
| `bridge/server.js:402-408` — `GET /files-index/:folderName` | Serves `files_index.json`. Its `url` is a Canvas **file** download URL; the quiz rule does not touch `/files/:id`. |
| `bridge/storage.js:51` — `avatar_url` | Instructor avatar image. |
| `bridge/file-origins.js:40` — `/\/files\/(\d+)/g` | File-id extraction for provenance, not link building. |
| `extension/canvas-client.js:4` — `CANVAS_BASE = 'https://canvas.rice.edu'` | API host for `fetch`. |
| `extension/canvas-client.js:96,160` | Joins API paths to the host; pagination `Link` headers. |
| `extension/background.js:733-744` | `/api/v1/courses/:id/...` sync fetches. |
| `extension/background.js:766` | `/api/v1/.../discussion_topics/:id/view`. |
| `extension/background.js:800,1205` | `/api/v1/courses/:id/files/:id` metadata probes. |
| `extension/bridge-client.js:3` — `http://127.0.0.1:3847` | Local bridge base. |
| `extension/manifest.json:12,14,25,43` | Host permissions and CSP `connect-src`. |
| `extension/popup.js:280-293,503` | `chrome.runtime.getURL` for the extension's own pages. |
| `extension/content-script.js`, `extension/courses.js` | No Canvas item links rendered. |
| `app/main.js:237-253` | `setWindowOpenHandler` / `will-navigate` → `shell.openExternal`. Transport for the fixed links, not a source of them. |
| `app/main.js:267-268` | `openPath` / `showItemInFolder` for local files. |
| `scripts/build-context.js:544,592` | `full_url` of external LTI tool tabs from `tabs.json`. Not assignments. |
| `bridge/install.sh:259` | Prose in the installer. |
| `scripts/test-fixtures/sample-class/{assignments,quizzes,files_index}.json` | Test fixtures. |
| `extension/test/mock-canvas-server.js:65` | Mock server response. |
| `bridge/test/file-origins.test.js:21,66` | Test input strings. |

**Files with no Canvas URL surface at all** (grepped, clean):
`scripts/mine-assignments.js`, `scripts/cal-meetings.js`, `scripts/cal-names.js`,
`scripts/cleanup-class-calendar.js`, `scripts/_util.js`,
`scripts/parse-syllabus.js`, `scripts/extract-course-files.js`,
`scripts/sync-all-contexts.js`, `calendar-plan.js`, `scope.js`, `data-root.js`,
`app/preload.js`, `bridge/user-state.js`, `bridge/trigger.js`.

---

## Per-class exposure

Counted by running `needsUrlRewrite()` over each class's real `assignments.json`
under `~/canvas-sync-data/classes/`.

| Class folder | Assignments | Would have been broken | Share |
| --- | ---: | ---: | ---: |
| `92294-busi-305-001-002-003` | 0 | 0 | — (no `assignments.json` content; 7 mined items only) |
| `92336-busi-374-001-002` | 11 | 0 | 0% |
| `92354-busi-396-001-002-003-004` | 18 | 0 | 0% |
| `93903-busi-380-002` | 41 | **39** | **95%** |
| `94038-entr-222-001` | 19 | 0 | 0% |
| **Total** | **89** | **39** | **44%** |

BUSI 380 is the whole of the exposure and is entirely quiz-backed: 39 rows with
`submission_types: ['online_quiz']`, `is_quiz_assignment: true`, `quiz_id` set.
The remaining 2 are `online_upload` case assignments and were always fine.

**Corroboration.** For each of the 39, the rewritten URL is byte-identical to
that quiz's own `html_url` in the same course's `quizzes.json` — Canvas agrees
with the rewrite. `bridge/test/canvas-links.test.js` pins this for one real pair
(assignment `532620` ↔ quiz `137979`).

### Submit button correctly suppressed

`canvasSubmitUrl()` returns `null` for 7 items across the other classes —
`not_graded` (BUSI 374: 3, ENTR 222: 1) and `none` (BUSI 396: 1, ENTR 222: 2).
Those rows should render no Submit affordance rather than a link to a route
Canvas does not have.

### Discussion branch is untested against real data

Every class's `discussions.json` is `[]`, and no assignment on disk carries a
`discussion_topic`. The `/discussion_topics/:id` branch of `canvasItemUrl` is
therefore covered only by a synthesised fixture in the test file. Flagged so
nobody mistakes "no failures" for "exercised".

---

## Stale artifacts on disk

Generated **before** the fix landed and still containing the broken form. None
of these are code defects; they need a regeneration pass.

| Artifact | Broken links | Note |
| --- | ---: | --- |
| `~/canvas-sync-data/calendar/worklist.json` | 39 | Written 09:56, three minutes before `canvas-links.js`. Has **zero** ops carrying `url` / `submit_url` — those fields did not exist yet. |
| `~/canvas-sync-data/calendar/worklist.md` | 39 | Same run. |
| `…/93903-busi-380-002/AI_CONTEXT/context.md` | 39 | Will stay broken after regeneration until R1/R2 are fixed. |
| `…/93903-busi-380-002/AI_CONTEXT/context.json` | 78 | 39 distinct assignments, each URL stored twice (raw field + rendered markdown). Same caveat. |
| `…/93903-busi-380-002/AI_CONTEXT/pack/01-course-overview.md` | 39 | Same. |

The three other classes' `AI_CONTEXT` files also contain raw `/assignments/`
URLs, but none of their assignments are quiz-backed, so those links work.

---

## Review findings — defects in `canvas-links.js` itself

Added by an adversarial review pass on 2026-08-24. The audit above covers
*callers*; these are defects in the module they all call. Each one is recorded
as an executable expectation in `bridge/test/canvas-links.test.js`, marked
`{ todo: … }` so the suite stays green (exit 0, `fail 0`) while printing the
failure on every run. Clearing a defect means deleting its `todo` flag.

The whole corpus was re-checked independently: all 89 assignments across the
five classes, cross-referenced against each course's `quizzes.json`. The
rewrite is correct on all 39 quiz-backed rows — **zero** mismatches against the
quiz objects' own `html_url`. The headline numbers in this document hold.

| # | Defect | Real-data impact | Status |
| --- | --- | --- | --- |
| D1 | Ids are pasted into paths unvalidated | latent | fixed |
| D2 | `external_tool` is missing from the no-submit list | **6 live rows** | fixed |
| D3 | A bare-string `submission_types` skips the exclusion list | latent | fixed |
| D4 | The "non-Canvas URLs are left alone" guarantee is about the path, not the host | doc only | fixed |
| D5 | A course segment with trailing junk parses as a course id | latent | fixed |

All five landed in `canvas-links.js` on 2026-08-24. The `todo` flags that marked
them in `bridge/test/canvas-links.test.js` are gone; the suite runs 161 tests
with none skipped.

### D2 — `external_tool` assignments get a Submit button that goes nowhere

The only finding with live consequences. `canvasSubmitUrl()` excludes `none`,
`not_graded` and `on_paper`, but not `external_tool`. LTI work is handed in
*inside* the tool embedded on the assignment page; Canvas has no
`/submissions/new` route for it. Six real rows are affected:

| Class | Id | Name |
| --- | --- | --- |
| BUSI 396 | 531987, 531994, 531996, 531998, 531595 | `… Module Quiz` / `Start Here Knowledge Check` |
| ENTR 222 | 527391 | `Roll Call Attendance` |

`Roll Call Attendance` is the sharpest case: attendance the *instructor* takes,
worth 0 points, with nothing for the student to submit — yet the dashboard
offers a Submit button for it today. Adding `external_tool` to the exclusion set
takes the corpus from 7 correctly-suppressed Submit buttons to 13.

### D1 — a non-scalar id becomes a well-formed URL to the wrong page

`quiz_id`, `discussion_topic.id` and `id` are interpolated with no check that
they are ids. Observed outputs:

| Input | Produces |
| --- | --- |
| `quiz_id: {}` | `…/quizzes/[object Object]` |
| `quiz_id: []` | `…/quizzes/` |
| `quiz_id: [1,2]` | `…/quizzes/1,2` |
| `quiz_id: '13/../../x'` | `…/quizzes/13/../../x` |
| `id: []` (submit) | `…/assignments//submissions/new` |

The empty-array case is the dangerous one: `…/quizzes/` is the course quiz
**index** — a real page that loads fine and is not the item the user clicked.
That is the failure mode this codebase forbids: not a crash, not an obviously
broken link, but a confident wrong answer. Falling back to `html_url` is the
honest degradation. Every id in the corpus today is a digit string, so this is
latent — but `canvasItemUrl` deliberately accepts camelCase `quizId` for
hand-rolled and mined rows, which are exactly the rows likely to carry junk.

### D3 — a bare-string `submission_types` silently skips the exclusion list

`Array.isArray('not_graded')` is `false`, so `types` becomes `[]` and the row
gets a submit URL. The contract calls this "treated as no exclusions", which is
the wrong default: a scalar `submission_types` is a shape mined rows plausibly
carry, and the safe reading of `'not_graded'` is the same as `['not_graded']`.

### D4 — the host guarantee is really a path guarantee

The contract says a non-Canvas `html_url` is returned unchanged "since we cannot
know a foreign host's routing". `BASE_RE` matches **any** `http(s)` origin, so
that only holds for URLs whose path is not `/courses/<digits>/…`;
`https://not-canvas.example/courses/1/assignments/2` with a `quiz_id` *is*
rewritten. No corpus row hits this, and a hostname allowlist would be wrong —
the extension's mock Canvas is `http://localhost:<port>`. This is a
documentation fix, not a code fix. The test that appeared to cover it used an
HBR URL with no `/courses/` segment, so it passed for the wrong reason; it has
been retitled and a companion test now pins the real behaviour.

### D5 — `/courses/93903abc/` resolves to course 93903

`(\d+)` stops at the first non-digit and never checks what follows. A
`(?=[/?#]|$)` lookahead closes it. Latent; no corpus row hits it.

### The fix, as shipped

All five were covered by one small patch, verified against a scratchpad copy
first: every `todo` flag removed, and the corpus re-run unchanged at 39 rewrites
/ 0 oracle mismatches, with no-submit rising 7 → 13.

`scalarId(v)` is the id guard (D1); it rejects anything that is not a positive
safe integer or a digit string, so an array id yields `null` and no URL rather
than a URL to the wrong page. `submissionTypes(item)` coerces the bare-string
form (D3), and `NO_SUBMISSION_TYPES` gained `external_tool` (D2).

- `BASE_RE` → `/^(https?:\/\/[^/]+)\/courses\/(\d+)(?=[/?#]|$)/` *(D5)*
- add `const asId = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? String(v).trim() : null)`
  and wrap the three id reads *(D1)*
- `NO_SUBMIT = new Set(['none','not_graded','on_paper','external_tool'])`, tested
  with `types.some(t => NO_SUBMIT.has(t))` *(D2)*
- coerce a string `submission_types` to a one-element array *(D3)*
- correct the contract wording *(D4)*

### Not defects

- **Performance.** Linear, not quadratic. `BASE_RE` is `^`-anchored, so `[^/]+`
  backtracks over one start position only: 10 MB of non-slash input parses in
  ~10 ms, and 890k `canvasItemUrl` calls take ~45 ms. The real corpus is 89
  items. Nothing here is accidentally superlinear.
- **File and JSON failure modes.** `canvas-links.js` is pure — it opens no
  files and imports nothing, so missing-file, corrupt-JSON, empty-array and
  unicode-filename cases do not reach it. They belong to the callers. A class
  with zero assignments (BUSI 305) and a class with one are both exercised by
  the corpus run without incident.
- **Error swallowing.** No `try/catch` anywhere, and no `catch {}`. The module
  returns `null` or the untouched input rather than inventing values — with the
  D1 and D2 exceptions above, which are precisely where it does invent one.

### Staleness — resolved

`canvas-tasks.js` and `scripts/build-pack.js` (both mtime 10:25) postdated this
audit's 10:09 sweep and were left unclassified. Both have since been swept:
`canvas-tasks.js` produces `html_url`/`submit_url` only from `canvasItemUrl` /
`canvasSubmitUrl`, and `build-pack.js` routes both its assignment and its quiz
rows through `canvasItemUrl` (lines 394 and 411). Neither reads a raw
`html_url`. The only bare URLs left in `build-pack.js` are external LTI tool
`full_url` values from `tabs.json`, which are not Canvas item links — the same
not-applicable class as `build-context.js:544,592`.

---

## Checklist — all items closed

| # | Item | Status |
| ---: | --- | --- |
| 1 | `scripts/build-context.js:71` — `a.html_url` → `canvasItemUrl(a)` *(R1)* | done, plus a `- Submit:` line |
| 2 | `scripts/build-context.js:201` — `canvas.html_url` → `canvasItemUrl(canvas)` *(R2)* | done |
| 3 | `bridge/public/app.js` `calOpRow` — read `op.url` / `op.submit_url`, add a Submit affordance *(G1)* | done |
| 4 | `scripts/sync-calendar.js` `renderWorklistMd` — emit `- url:` and `- submit_url:` *(G2)* | done |
| 5 | Decide the fallback for a mined item whose class has no `assignments.json` rows *(G3)* | done — and it exposed the mined-replaces-Canvas bug, now a union |
| 6 | Regenerate `worklist.{json,md}` and every class's `AI_CONTEXT/` after 1-2 | done |
| 7 | Spot-check one real BUSI 380 quiz link end to end in a signed-in browser | pending — needs the user's Canvas session |
| 8 | `canvas-links.js` — add `external_tool` to the no-submit set *(D2)* | done |
| 9 | `canvas-links.js` — validate ids, coerce a string `submission_types`, tighten `BASE_RE`, correct the contract wording *(D1, D3, D4, D5)* | done |
| 10 | Re-sweep `canvas-tasks.js` and `scripts/build-pack.js`, which postdate the audit | done — both import `canvas-links.js` and hold no raw `html_url` |

Item 7 is the one thing this repo cannot verify for itself: every check here is
against Canvas's own reported URLs, and only a signed-in browser proves the page
actually opens. The strongest evidence short of that is in the FIXED section —
`canvasItemUrl(assignment)` reproduces the quiz object's self-reported
`html_url` on all 39 quiz-backed rows, byte for byte.

### Test coverage as of closing

| Suite | Tests |
| --- | ---: |
| `scripts/test/*.test.js` | 211 |
| `bridge/test/*.test.js` | 161 |

Zero failures, zero skipped, zero `todo`.
