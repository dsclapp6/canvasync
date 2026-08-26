# CANVASync — working spec & accountability sheet

Written 2026-08-23 after a full diagnostic pass. Every requirement below is
checked off only when implemented **and** verified (tests + live where
possible). "Verified" means observed working against the real install at
`~/canvas-sync-data`, not just unit-tested.

Updated 2026-08-24 after the links / task-list / meeting-time pass. Sections A-E
are the 2026-08-23 pass as recorded then; section F carries what changed since,
including the module and route inventory for the new code. Where the two
disagree, F is the current behaviour.

## Diagnostic snapshot (state found at time of writing)

- 20 class dirs on disk; 5 in scope (`sync-scope.json` present, source: selection).
- Bridge + Electron app running but on pre-session code (needs restart to pick
  up new routes).
- `claude -p`: **OAuth expired** → AI stages (parse-syllabus, mine-assignments)
  blocked unless the local 20 GB model is used; deterministic stages fine.
- `syllabus_parsed.json`: only BUSI 395 (an out-of-scope Spring class);
  `assignments_mined.json`: only BUSI 305. `calendar_events.json`: empty everywhere.
- All test suites green at start of pass: bridge 109, scripts 70, plus new
  suites added this session.
- Extension UI (popup / courses / progress pages) still on two *older* palettes
  (cream paper + light Tailwind-ish) — inconsistent with the committed dark
  design language of the dashboard.

## A. Core requirements (user-stated, all sessions)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| A1 | One-click launch (`CANVASync.app`, `Start CANVASync.command`) | DONE | app relaunched cleanly this session; /app returns 200, auth + all views verified |
| A2 | Token editable after bridging (extension popup) | DONE (prior session) | popup edit flow |
| A3 | Sync scope: only selected classes sync / process / appear; stale-class cull with size reporting; unknown scope never hides or deletes | DONE | `scope.js`, 17 scope tests, cleanup UI, trigger + calendar + contexts filters |
| A4 | Sidebar shows only current classes, with All toggle + class picker | DONE | `#class-scope` seg, picker panel |
| A5 | Calendar grouped by day AND by class, decent looking | DONE (prior session) | seg controls, persisted prefs — per-class color, selection chips and row checkboxes added in F5 |
| A6 | Assignment management: complete, notes, flags (color coding), move date/time, checkpoints | DONE | `user-state.js` (17 tests), task editor UI, live-verified BUSI 305 — task list superseded by F3, in-app assignment page added in F4 |
| A7 | Files sorted by where they were pulled from | DONE | `file-origins.js` (17 tests); live-verified on BUSI 380 (34 files, Assignments+Syllabus groups, 3 sort modes) |
| A8 | Context packs for AI building made | DONE (deterministic tier) | packs built for all 5 in-scope classes via `CLAUDE_SKIP=1`; AI enrichment blocked on `claude login` (user action) |
| A9 | Calendar population buttons: Meetings / HW / Readings / Exams / Checkpoints / All, global + per class | DONE | `calendar-plan.js`, plan API (7 tests); live e2e verified (toggle → plan.json → rebuild → UI refresh) |
| A10 | Meetings on calendar with time + room from syllabus schedule | DONE (code+tests+live) | `cal-meetings.js` (21 tests): per-clause patterns, lab ≠ lecture slot. Extended by F1: `meeting-times.js` recovery chain + user override (55 tests); 28/28 sessions timed on BUSI 374, 26/28 on ENTR 222 |
| A11 | Concise, effective calendar event naming | DONE (code+tests) | `cal-names.js` (15 tests): `BUSI 395 · HW 3`, `Prep · BUSI 395 HW 3` |
| A12 | User marks respected by calendar: done items dropped, moves honoured, user checkpoints replace auto-prep | DONE (code+tests) | worklist tests in `calendar-plan.test.js` |
| A13 | De-AI-ified visual style, dark, clean edges, ≤2 hues | DONE | popup/courses/progress restyled to the dashboard palette; 0 `border-radius`, no light-palette remnants (grep-verified) |
| A14 | Thorough bug testing across everything | DONE | 186 tests green (bridge 116, scripts 70), `node --check` × 49 files, full live sweep post-restart |

## B. Bugs found this session (fix + regression-test each)

| # | Bug | Fix |
|---|---|---|
| B1 | Lab meetings inherited the lecture's time & room (single-pattern parse) | per-clause `parseWeeklyPatterns` + `patternFor`; ambiguous → no time |
| B2 | `SESSION_RE` matched "(Section 001:" before "Labs" (missing plural) | optional plural suffix; test |
| B3 | `shortCourseCode` trailing-section regex ate the course number ("BUSI" from "BUSI 305") | head-anchored SUBJ+NNN match; tests |
| B4 | `homework` abbreviation swallowed the following space ("HW3") | tightened regex; test |
| B5 | Old `stripClassPrefix` only knew `": "` — new `" · "` titles wouldn't strip in class groups | both separators |
| B6 | Meeting rows would show as overdue (brick) for past dates | meetings exempt from overdue styling |
| B7 | ROUTINE.md / cleanup prompt knew nothing of meeting calendar or recurrence | both updated; `CSYNC_CAL_MEET` plumbed bridge→cleanup env |

## C. Liberties taken (in service of core asks)

- `calendar/plan.json` with meetings OFF by default (a calendar that fills
  itself with 200 lectures unasked is a calendar the user stops trusting);
  everything else on, matching prior behaviour.
- Plan changes rebuild the worklist immediately (spawned deterministic script),
  so toggles are visible in seconds without a sync.
- Weekly-recurrence fallback (ONE recurring op) when a syllabus has prose but
  no dated schedule.
- File provenance derived at read time — works retroactively on already-synced
  classes, no migration.
- Files tab sort modes: Source (grouped) / Name / Newest, persisted.
- `CSYNC_CAL_MEET` settings field (optional third calendar).
- Deterministic context packs now, AI enrichment layered on later.

## D. Verification matrix (all must pass before "done")

- [x] `bridge: npm test` green — **116 pass, 0 fail**
- [x] `scripts: npm test` green — **70 pass, 0 fail** (51 of them are this
      session's calendar suites: cal-meetings 21, cal-names 15, calendar-plan 15;
      the "≥ 85" target double-counted the pre-session baseline)
- [x] `node --check` on every JS file outside node_modules — **49 files, all pass**
- [x] App restarted; live dashboard verified: auth via seeded secret, class list
      scoped (5 of 20), tasks CRUD (done-toggle round-trips to `user_state.json`,
      done items re-sort), files bunched by source category (current BUSI 380:
      Quizzes 33 + Syllabus 2) with Source/Name/Newest sort persisted, pack tab lists the new
      deterministic packs
- [x] Calendar Populate panel end-to-end: Readings + Homework toggles →
      `plan.json` written → spawned rebuild → worklist 98→18 ops → UI polled and
      refreshed ("18 items across 3 classes"); per-class Exams-off for BUSI 380
      wrote `classes:{busi-380-002:{exam:false}}` and dropped exactly those ops;
      reset link cleared it; Meetings greyed out on all 5 classes with the
      explanatory note (no parsed syllabus yet)
- [x] Worklist on real data: 98 ops (homework 80, exam 6, checkpoint 12),
      titles short (`BUSI 380 · S2a-Concept Check: Assess Multi-Channel…`),
      no out-of-scope class
- [x] Extension pages restyled (dark, brass+brick only, `border-radius` count = 0)
- [x] README updated: task management, file provenance, Populate plan +
      `CSYNC_CAL_MEET`, `claude login` requirement, repo/data layout, v1.2 scope
- [x] No stray test data in `~/canvas-sync-data`: plan.json = exact defaults,
      user_state.json has zero non-empty entries, worklist restored to 98 ops

## E. Optional QOL (room seen, not implemented — for the user to pick from)

Cheap liberties already taken are in section C. What remains, roughly in order
of expected value:

1. **Unified "This week" view** — one merged upcoming-task list across all
   classes on the dashboard landing, so you don't click through five classes
   every morning. (Highest value; medium effort — the data is already merged in
   the worklist.)
2. **Per-class "Parse syllabus now" button** — once `claude login` works, re-run
   just one class's AI stages instead of the whole Rebuild packs pipeline.
3. **Checkpoint templates** — one click applies "7d outline / 3d practice /
   1d review" to an exam instead of adding three checkpoints by hand.
4. **Plan-change preview** — show "+43 meetings / −6 exams" before a Populate
   toggle commits, instead of applying instantly.
5. **.ics export** — download the worklist as an .ics file as an alternative to
   the Claude routine for people who want plain calendar-app subscriptions.
6. **New-assignment notification** — macOS notification from the desktop app
   when a sync discovers a task that wasn't there before.
7. **Per-file re-extract** — a retry button on files whose text extraction
   failed, without re-running the whole extract stage.
8. **Task search/filter** — a filter box on the Tasks tab (by text, flag color,
   or done state).
9. **Auto-refresh on sync completion** — the class list hot-reloads when the
   extension finishes a sync (the Activity view already tails the log).
10. **Term-end auto-suggest** — when a new term's classes appear, proactively
    surface the "Remove N old classes" cleanup instead of waiting for a visit
    to the sidebar.

Deliberately not done: anything that writes to Canvas, per-file delete, and
cross-class material linking (all out of scope per README).

## F. 2026-08-24 pass — links, task list, meeting times

Same bar as section A: implemented **and** verified. The link half of this pass
has its own accountability document, `LINK-AUDIT.md`; this section records the
behaviour, not the audit trail.

| # | What changed | Status | Evidence |
|---|---|---|---|
| F1 | Meeting-time recovery chain + per-class user override | DONE (code+tests+live) | `scripts/meeting-times.js`, 55 tests; run against all 5 real classes, results below |
| F2 | Canvas item/submit URLs corrected in one place | DONE (code+tests) | `canvas-links.js`, 35 tests; 39 of the 86 assignments on disk rewritten, every one matching that quiz's own `html_url` in `quizzes.json` (0 mismatches) |
| F3 | Task list = mined ∪ dated Canvas assignments | DONE (code+tests+live) | `canvas-tasks.js` `tasksForClass()`, 10 tests; read through by `GET /api/class/:folderName` in `bridge/server.js` and `buildWorklist()` in `scripts/sync-calendar.js`, so the class page and the calendar cannot disagree. Live: BUSI 380 = 9 mined + 32 unclaimed Canvas rows = 41 items, `mixed`; ENTR 222 = 18, `canvas`; BUSI 305 = 9, `mined` |
| F4 | Assignment pages inside the dashboard | DONE (code) | `GET /api/class/:folderName/assignment/:assignmentId`; sanitized description, `related_files`, Open/Submit anchors. The route has no test; the panel that renders it has none either |
| F5 | Calendar: one color per class, selection chips, row checkboxes | DONE (code) | `bridge/public/app.js` `classColor()` / `classHueMap()`, `cal-classes` chips, `data-cal-done` checkbox. The pure selection transitions are covered in `bridge/test/cal-plan.test.js`; the DOM wiring itself has no automated harness |
| F6 | `url` / `submit_url` as worklist fields, `Submit:` in event descriptions | DONE (code) | `scripts/sync-calendar.js`: op fields in `opsForItem`, `- url:` / `- submit_url:` in `renderWorklistMd`, `Submit: <url>` in the description builder. `submit_url` is emitted only when it differs from `url` |
| F7 | Truncated-JSON salvage for syllabus parses | DONE (code+tests+live) | `salvageTruncatedJson()` in `scripts/parse-syllabus.js`; all 5 classes have a `syllabus_parsed.json` |

### F1. The meeting-time recovery chain

`recoverMeetingTimes(classDir, opts)` in `scripts/meeting-times.js` returns
`{ source, confidence, patterns, warnings }`. `patterns` is shaped exactly like
`parseWeeklyPatterns()` output from `cal-meetings.js`, so it drops straight into
`meetingsFromSyllabus()` and `patternFor()`. Sources, strongest first
(`SOURCES` in that file):

| Source | Reads | Confidence |
|---|---|---|
| `override` | `<classDir>/meeting_override.json` | high with a time, low with days only |
| `syllabus-field` | `syllabus_parsed.json` → `course.meeting_schedule` | high with a time, low with days only |
| `syllabus-text` | syllabus-named `materials/*.txt` extracts, plus `syllabus.html` with its tags stripped — Canvas's own syllabus box | medium |
| `canvas` | `calendar_events.json` (2+ events before it counts as a pattern), then `pages.json` and `announcements.json` bodies | medium |
| `inferred` | recurring assignment due times — requires `opts.inferFromDueDates`, which nothing in the app sets | low |
| `none` | nothing found | low |

**NO TIME BEATS A WRONG TIME.** Every tier may return days with `start`/`end`
null rather than guess a clock. What the chain refuses is as load-bearing as
what it accepts: office hours, "by appointment", exams, deadlines, tutoring and
study groups never donate their time to a class (`NOT_A_CLASS_RE`); a single
dated occurrence — a review session, a guest lecture, the last day of class —
is refused outright rather than read as a weekly recurrence (`ONE_OFF_RE`);
a `meeting_schedule` field that names something other than class is dropped
entirely, days included (`MISLABELLED_FIELD_RE`), because office hours fall on
days the class need not meet; and a span shorter than 20 minutes, longer than 4
hours, or starting outside 06:00-22:30 is not a class (`plausibleClassTime`).
An override's time is dropped, never repaired, when it does not validate.

Also exported: `readMeetingOverride`, `writeMeetingOverride` (merge-patch, an
explicit null clears a field, throws rather than storing a time it cannot stand
behind, and never creates the class directory), `clearMeetingOverride`,
`describeMeetingSource` (one sentence for the UI), `OVERRIDE_FILE`, `SOURCES`.

Two parser defects in `scripts/cal-meetings.js` were fixed underneath it, both
of which had been producing a confident half-answer rather than a visible
failure — see B8 and B9 below. A third change: a syllabus row keyed by week
rather than by session (dated at the Monday the week starts, whatever days the
class meets) now expands across that week's meeting days, taking its time from
the one pattern that governs that kind of session; ambiguity yields no expansion.

Live results, all five in-scope classes, `recoverMeetingTimes` + `collectMeetings`
against `~/canvas-sync-data`:

| Class | Source | Sessions timed | Note |
|---|---|---:|---|
| BUSI 374 | `syllabus-field` | 28/28 | field is `M/W 2:30-3:45pm` — the B8 defect |
| ENTR 222 | `syllabus-field` | 26/28 | the 2 untimed are holidays, which carry no time by design; 2 rows are week-keyed |
| BUSI 380 | `syllabus-field`, days only | 0/23 | field is `Tuesdays and Thursdays` — the B9 defect; days recovered, time needs an override |
| BUSI 305 | `none` | 0/0 | syllabus states no schedule and no meeting days |
| BUSI 396 | `none` | 0/0 | same; the clock times its syllabus does state are office hours, refused by `NOT_A_CLASS_RE` |

### F1a. Routes — `/api/class/:folderName/meetings`

Registered on `dashRouter`, which `bridge/server.js` mounts with
`app.use('/api', dashRouter)`. All three validate `folderName` against
`CLASS_RE` and 404 on a class directory that does not exist.

| Route | Behaviour |
|---|---|
| `GET /api/class/:folderName/meetings` | `recoverMeetingTimes(dir)` plus `summary` from `describeMeetingSource` — source, confidence, patterns, warnings |
| `POST /api/class/:folderName/meetings` | `writeMeetingOverride(dir, req.body)`; a rejected override is a 400 carrying the reason, not a 500. Then re-runs the chain and calls `spawnWorklistRebuild()`, returning `rebuild_started` |
| `DELETE /api/class/:folderName/meetings` | `clearMeetingOverride(dir)`, re-runs the chain, rebuilds the worklist; `removed` says whether a file was actually there |

`GET /api/calendar/plan` (unchanged path) now runs the chain per class and
carries `meeting_times: { source, confidence, has_time, patterns, summary,
warnings }`, and gates `meetings_available` on `countMeetings()` with the
recovered patterns rather than on "a parsed syllabus exists". An override
pattern alone makes that count 1, so the Meetings toggle goes live for a class
whose syllabus has no schedule at all. This is what closes the user's report in
TODO §7 — the toggle never needed a model.

One edge left open: `countMeetings()` counts a days-only override as 1 and
enables the toggle, but `opsForMeetings()` requires `pattern.start` before it
emits the weekly recurrence, so an override saved with days and no time turns
the toggle on and then produces no events.

The editor lives in the Calendar view's Populate panel: days, start, end, room,
with **set times** / **change** and **Use the syllabus instead**.

### F2/F3. Modules shared by bridge, scripts and the dashboard

Both are at the repo root, Node builtins only, so `bridge/`, `scripts/` and
`app/` can each import them with their own `node_modules`.

| Module | Exports | Rule it enforces |
|---|---|---|
| `canvas-links.js` | `canvasItemUrl`, `canvasSubmitUrl`, `parseCourseUrl`, `needsUrlRewrite` | A quiz-backed assignment links to `/quizzes/:quizId`; Canvas denies students the `/assignments/:id` object view. Discussion-backed work links to its topic. Ids are validated before they are pasted into a path, so a junk id falls back to `html_url` instead of resolving to a course index page. `canvasSubmitUrl` returns null for `none`, `not_graded`, `on_paper` and `external_tool` |
| `canvas-tasks.js` | `tasksForClass`, `itemsFromCanvasAssignments` | The task list is a union, not a fallback: mined items first, then every dated Canvas row no mined item claims by id or by flattened title. `source` reports `mined`, `canvas` or `mixed`. A mined item whose `canvas_assignment_id` has no Canvas row keeps its description and loses its `submit_url` |

### Bugs fixed this pass

Continuing the numbering in section B.

| # | Bug | Fix |
|---|---|---|
| B8 | A compact day run stopped at its delimiter: BUSI 374's `M/W 2:30-3:45pm` parsed as Monday alone, dropping every Wednesday lecture while stating the Mondays as confidently as if both were right | `DAY_TOKEN_RE` repeats the run across `,` `/` `&`; test in `meeting-times.test.js` |
| B9 | Days written as prose matched nothing at all: BUSI 380's field is the string `Tuesdays and Thursdays`, which parsed to no days, no time, no events, and a Populate toggle that claimed there was nothing to populate | `normaliseDayProse()` rewrites plurals and conjunctions into the compact form the existing parsers handle |
| B10 | `tasksForClass` treated mined output as a replacement for the Canvas rows. Mining has since run on BUSI 380, so this is no longer hypothetical: its 9 mined items would have stood in for 41 dated Canvas assignments, taking 32 real deadlines off the class page and the calendar | union, claiming a Canvas row by id or by flattened title; 10 tests |
| B11 | Quiz-backed assignments linked to the teacher's view of the object. 39 of the 86 assignments on this machine were Access Denied for the student who owns them, all of them BUSI 380's | `canvasItemUrl` rewrite, applied at every call site the audit found |
| B12 | Six `external_tool` rows offered a Submit button with no route behind it, `Roll Call Attendance` — 0 points, taken by the instructor — among them | `external_tool` added to the no-submit set; suppression goes from 6 rows to 12 (3 `none`, 3 `not_graded`, 6 `external_tool`) |
| B13 | A syllabus row that names a week rather than a session took the weekday of its own date, so a week-keyed syllabus produced Monday-only meetings | week rows expand across the governing pattern's days |
| B14 | A model running out of tokens mid-JSON failed the whole syllabus over one unfinished trailing field; ENTR 222 did not parse | `salvageTruncatedJson()` closes open brackets at the last finished value, or returns null — an empty salvage is worse than an honest failure |

### Verification

- [x] `cd scripts && node --test "test/*.test.js"` — **223 pass, 0 fail, 0 skipped, 0 todo**
- [x] `cd bridge && node --test "test/*.test.js"` — **164 pass, 0 fail, 0 skipped, 0 todo**
      (both counted 2026-08-24 12:5x; the suites were 211 and 161 earlier the same
      day, so treat the totals as a floor, not a fixed number)
- [x] Suites carrying this pass: `scripts/test/meeting-times.test.js` 55,
      `bridge/test/canvas-links.test.js` 35, `bridge/test/canvas-tasks.test.js` 10
- [x] Recovery chain run against all five real classes; the table in F1 is that run,
      not a fixture. So are the link counts in F2 and the union counts in F3
- [ ] **Not re-verified in a browser this pass.** F4 and F5 are dashboard behaviour
      read out of `bridge/public/app.js`, and no test in either suite touches that
      file
- [ ] **Not verified — needs a signed-in browser.** That a rewritten BUSI 380 quiz
      URL opens the page for the student. Every check this repo can run compares
      against Canvas's own reported URLs; only a live session proves the page
      loads. `LINK-AUDIT.md` item 7.
- [ ] **Not covered by tests.** The week-keyed expansion in `meetingsFromSyllabus`
      has no regression test in either suite. It is exercised on real data — 2 rows
      on ENTR 222 — and nowhere else.
- [ ] **Half-done.** `calOpRow` in `bridge/public/app.js` reads `op.submit_url` as a
      field, but the item link for a row it cannot open in-app still comes from
      `calUrl(op.description)`, which takes the first URL in the description prose.
      `op.url` is never read. It produces the right link today only because
      `sync-calendar.js` pushes the corrected URL into the description.
