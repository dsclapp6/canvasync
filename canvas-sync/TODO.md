# CANVASync — backlog

Captured 2026-08-24. **Nothing here is started.** Planning only until the user says "build."
Wording preserves the user's intent; decisions they have already made are marked **DECIDED**.

Priority order as stated: **§1 (AI chat + correlation graph) is the big one.**

---

## 1. Per-class AI chat over a correlation graph — TOP PRIORITY

An AI chat running on the local model, per class, informed by a correlation graph built from
everything already pulled. The user: *"this is definitely my big one I want — having the
correlation graphs & intelligent help will be amazing."*

**Graph construction**
- Every assignment and every piece of data previously pulled becomes a **node**.
- Each node gets **edges to every other item in that class**, weighted by how relevant they
  are to each other, or by what data references what.
- Weights should vary by class character: a math or CS class builds on itself, so it should
  show consistently high-degree nodes and heavy cross-referencing. A design class that changes
  theme week to week should be sparser. The graph should *reflect* that, not force uniformity.

**Query behavior — in order**
1. **Resolve the class first.** For a general question, work out which class is meant. Ask for
   clarification only when it is genuinely not obvious.
2. **Select sources programmatically** from the graph's nodes and edges — decide what to read
   from the correlation structure rather than reading everything.
3. **Answer from what it read.** Informed and relevant, with **no hallucinated data and no
   unverifiable claims.**

**Must also handle simple factual queries**, not just document retrieval:
- *"when does this class meet this week"*
- *"when is the next exam scheduled for"*

These are answerable from structured data (parsed syllabus, mined assignments, the calendar
worklist) and should be routed there rather than through retrieval over slide text.

**Answer style (hard requirement)**
- Concise and precise.
- **No preambles, no praise, no acknowledgements.**

**Depends on:** §2 (local model exercised end-to-end) and §3 (packs), since the packs are the
extracted-text layer the graph is built over.

---

## 2. Local model

Status: **present and detected in the app** — not a missing-model problem. Not yet exercised
end-to-end, so functionality is unverified.

- **Test actual functionality** (the app reports it present; nothing has run through it).
- **One-click setup.** A button in the app that auto-runs the setup script in a terminal —
  not a page of instructions.
- **A weaker model option** for friends without as powerful a machine. The current MLX model
  is ~20GB and assumes a beefy Mac; sharing the project requires a smaller tier.
- Constraint that governs all of the above: this machine cannot survive concurrent local-model
  loads. Every path must go through the machine-wide lock in `scripts/_util.js`.

**See also §7 — the Meetings populate toggle no longer needs a model at all.**

---

## 3. Context packs — DECIDED

The user chose the second of two options they raised:

> "the context pack can be ALL of the class files + a few context files to tell it what to do
> with them, which i think is the easier & cleaner approach. Include the correlation graph
> within those context files for claude to know what it needs to reference as well."

So: **all class files, plus a small number of context/index files that tell Claude what to do
with them, with the correlation graph embedded in those context files.**

Also raised, and still live within that structure:
- Per-class, and then **per-assignment within that** — organized by what is needed.
- Separate files "probably, to keep it clean" — but without exploding into hundreds of files.

Also: **test the context packs.** They are built (deterministic tier) but have never been
validated as actually useful when uploaded to a Claude project.

---

## 4. Calendar

- **Visual customization** generally — the calendar view needs to be configurable, not fixed.
- **Colors per class.**
- **Selectable class filtering** — all classes by default; selecting one or more narrows the view.
- **Improved populate** (beyond the current five on/off kinds).
- **Task completion indicators, and the ability to mark done from the calendar view** — today
  completion only exists on the class Tasks tab.
- **Multiple calendar interfaces** — more than the current three fixed ids
  (due / checkpoint / meeting); shape undecided.
- **Info hover boxes explaining what calendar ids are**, so the project can be shared with
  people who have no idea what a calendar id is or where to find one.
- **Meeting events must carry day, time AND room, and be titled `[LOC] - [CLASS] - [PROF]`** —
  e.g. `Virani 182 - BUSI380 - VanHorn`, all three pulled from the syllabus. See §8.

---

## 5. UI / UX redesign

The current dashboard and extension UI "suck right now." Direction:

- **Simplify.** Minimalistic. Small features rather than large panels.
- **Soft colors** — a step away from the current high-contrast dark + brass. This supersedes
  the existing design language; the brass/brick palette and the zero-radius rule are now open
  for renegotiation, not fixed.
- **Functional first** — the flow should do the job, not display the job.
- Full **UX flow** rework, not a reskin.

Bound up with it:
- **Move Activity into Settings, or delete it entirely.** Decision pending.
- **Rename "AI pack" → "Class Summarized."**
- **In-app file viewer?** Open question — files currently download or open in a new tab.

---

## 6. Shareability

Both of these exist so the project can be handed to someone else:

- **Terminal subscription login** — Claude Code and Codex OAuth sessions replace the removed API-key path, so setup does not
  depend on provisioning an API credential.
- The weaker local model tier (§2) and the calendar-id hover explanations (§4) serve the same
  goal.

---

## 7. Meetings populate claimed a model was needed — FIXED 2026-08-24

User report, 2026-08-24:

> "when i tried to populate meeting days it says i need a model connected but i have a local
> model in there already so its just not running/working."

Diagnosis: no model was needed for any of it. The Meetings toggle gates on `meetings_available`
from `GET /api/calendar/plan`, which asks `countMeetings()` in `scripts/cal-meetings.js` how
many sessions the class would actually produce. That count came back zero, so the toggle greyed
itself out and the note beside it said the class had no parsed schedule — which reads as "run
the AI stages first". The syllabus was parsed. The meeting time was not in the part of it the
parser was looking at, and for two classes it is not in the syllabus at all.

Landed:

- `scripts/meeting-times.js` looks for the time wherever it exists, strongest source first:
  a user override, the syllabus `meeting_schedule` field, the full syllabus text (the
  `materials/` extracts and Canvas's syllabus box), Canvas course events, then Canvas pages
  and announcements, then an
  off-by-default guess from recurring assignment due times, then none. The governing rule is
  that no time beats a wrong time: every tier may return days with a null clock rather than
  invent one, and BUSI 380's "office hours are on Tuesdays, 4:15-5:15PM" is filtered out before
  the clause parser can read it as the class time. 55 tests in
  `scripts/test/meeting-times.test.js`.
- A per-class override at GET/POST/DELETE `/api/class/:folderName/meetings` — days, start, end,
  room — edited in the Calendar view's Populate panel. It outranks every other source, needs no
  model, and saving or clearing it rebuilds the worklist. An override pattern on its own makes
  `countMeetings()` return 1, so the toggle goes live even for a class whose syllabus carries no
  schedule.
- Two day-parser defects in `scripts/cal-meetings.js`. A compact day run stopped at its
  delimiter, so BUSI 374's `M/W 2:30-3:45pm` produced a Monday-only class — every Wednesday
  lecture missing, stated as confidently as the half it got right. And prose days matched
  nothing: BUSI 380's field is the string "Tuesdays and Thursdays", and it parsed to no days,
  no time and no events.
- Syllabus rows keyed by week rather than by session. A row dated Monday that names a week now
  expands across that week's meeting days, taking its time from the one pattern that governs
  that kind of session. ENTR 222 has two such rows.
- Where the five classes stand now: BUSI 374 28 of 28 sessions timed from the syllabus field,
  ENTR 222 26 of 28 (the two without a time are holidays, which carry none by design), BUSI 380
  days only (TuTh) until an override is set, BUSI 305 and BUSI 396 no days and no times because
  neither syllabus states any.

Also landed in the same pass, closing `LINK-AUDIT.md`:

- Quiz-backed assignment links. `canvas-links.js` rewrites `/assignments/:id` to
  `/quizzes/:quizId`, because Canvas serves the assignment object to teachers and denies it to
  students — 39 of BUSI 380's 41 assignments were dead ends. Submit URLs are suppressed for
  `none`, `not_graded`, `on_paper` and `external_tool`, none of which has a submission route.
- `tasksForClass()` in `canvas-tasks.js` is now a union of mined items and dated Canvas
  assignments instead of mined-replaces-Canvas, and reports `source` as `mined`, `canvas` or
  `mixed`. Mining has since run on BUSI 380, so the difference is live: 9 mined items plus 32
  Canvas rows no mined item claims, 41 in the list. Under the old behaviour it would have shown
  the 9.
- Assignment pages inside the dashboard. A task row, or a due-date row on the calendar, opens
  the assignment in the app — sanitized Canvas description, the files that came from that
  assignment, and links out to the Canvas page and the submission page. Calendar rows carry a
  Submit link when there is somewhere to submit.
- `worklist.md` carries `- url:` and `- submit_url:` per operation, and event descriptions carry
  a `Submit:` line, so both survive into the calendar event.
- `salvageTruncatedJson()` in `scripts/parse-syllabus.js` closes the open brackets at the last
  finished value when the model runs out of tokens mid-JSON. All five syllabi parse now; ENTR 222
  did not before.

That clears three items in §4: colors per class, selectable class filtering, and marking a task
done from the calendar view. Each class gets one hue at a fixed saturation and lightness,
assigned across the whole set so no two collide; all class chips start selected, selecting one
or more narrows the calendar to those classes, and deselecting the last returns to all. Every
due-date row has a checkbox that writes to `user_state.json` and drops the item from the worklist.

### Correction, 2026-08-24

The paragraph above says the calendar checkbox and Submit link clear three §4 items. The code is
there — `bridge/public/app.js:1683` and `:1693`, against `POST /api/class/:folderName/task/:taskId`
— but none of it has ever been seen running: the bridge on port 3847 has been up since before those
routes existed, so the app the user is looking at does not contain them. Built is not the same as
working, and the ledger in `VERIFY.md` now tracks the two separately (rows 34, 34a, 34b).

Four gaps survive even after a restart:

- A finished item is dropped from the worklist by design, so the row that would let you un-finish it
  disappears with it. There is no "show completed" view.
- 13 of 94 homework operations have no Canvas URL and 8 more have no submit URL — mined items with
  no Canvas row behind them. Those rows should say so rather than render a control that goes nowhere.
- `CAL_DONE` (`app.js:1500`) is only ever written by the click handlers, never seeded from
  `user_state.json`, so a reload between the click and the debounced rebuild loses the mark.
- Calendar operations carry `class` as the slug with the course id stripped, while the API wants the
  full `folderName`. `calFolder()` re-derives the strip in the browser, making three copies of that
  rule in the codebase. See `VERIFY.md` row 23a.

---

## 8. Meeting events: wrong title, missing room — DONE 2026-08-24

User request, 2026-08-24:

> "meetings are not going in correctly. they should show class days, times, and location.
> Should be titled '[LOC] - [CLASS] - [PROF]', eg. 'Virani 182 - BUSI380 - VanHorn' as pulled
> from the syllabus."

Explicitly queued behind the work in flight when it arrived; done the same day. The evidence
lives in **`CALENDAR-SPEC.md` §4** (rows 4.1–4.4 and the two `Measured 2026-08-24` blocks
under them), which is the permanent record for all calendar work. The short version:

    Cambridge Office Building 130 - ENTR222 - Wulf     ← the one class with a room
    BUSI305 - Peyravan                                 ← "Dr." stripped
    BUSI374 - VanHorn                                  ← internal capital kept whole
    BUSI380 - Porter
    ECON205 - Dudey
    No class - BUSI380                                 ← a day the class does not meet

106 meeting ops on the live worklist, **0** with a leading `" - "`, a doubled `" -  - "`, or
the word `null`. The topic moved into the event description, where the student reads it.

Still open under this heading, and it is a **data** gap, not a title one: the room reaches
1 class in 6 and the clock time 4 in 6. BUSI 305 and BUSI 396 state no meeting days anywhere
on disk, so §7's conclusion stands — those need a user-typed override, and a title format
cannot conjure a meeting that has no day.

The original analysis follows, kept because points 2 and 3 are what remains.

What the title is today, from `meetingTitle()` in `scripts/cal-names.js:147`:

    BUSI 305 · Week of Aug 24: Accounting overview…      ← code · label: topic

What it has to become:

    Virani 182 - BUSI380 - VanHorn                        ← location - code - instructor surname

Three separate gaps, and only one of them is the title:

1. **The title format.** One function, `meetingTitle({ code, label, topic })`. It has neither
   the room nor the instructor in its arguments today, so both have to be threaded in from
   `buildMeetingOps()` (`scripts/sync-calendar.js:344`). The class code loses its space
   (`BUSI380`, not `BUSI 380`) and the professor is a surname, not the full name — both are
   formatting decisions that belong in `cal-names.js` beside `shortCourseCode()`. The topic
   has to go somewhere; the event description is the obvious home, since it is what the
   student reads once the event is open.
2. **The professor is available and unused.** `syllabus_parsed.json` has
   `course.instructor.name` on all six classes — Marc Dudey, Dr. Leila Peyravan, David VanHorn,
   Matt Smith, Constance Porter, Adam Wulf. Nothing reads it into a calendar op; meeting ops
   have no instructor field at all. Note `Dr. Leila Peyravan` — the surname rule has to survive
   a title prefix, and `VanHorn` has to survive not being split on the capital.
3. **The room is available on one class in six.** 26 of 106 meeting ops carry `location`
   (all ENTR 222, "Cambridge Office Building 130"); the other 80 carry `null`. Location is not
   a parsed-syllabus field — `meeting-times.js` finds it by scanning syllabus prose for a room
   pattern (`cleanRoom`/`parseRoom`, lines 240 and 587). Either the room moves into
   `syllabus_parsed.course` as a first-class field, or the title needs a defined shape for the
   80 events that have no room. **It must not print an empty leading `" - "` or the word
   `null`** — same rule as the times: no room beats a wrong room.

And the standing precondition: `busi-305` and `busi-396` still have `meeting_schedule: null`
in their parsed syllabi, so days and times for those two do not exist in any source held. §7
established that the fix there is a user-typed override, not more parsing. A title format
cannot conjure a meeting that has no day.

## Completeness audit follow-ups (Codex, 2026-09-01 — logs/codex-completeness-audit.md)

Dispatched already: C1/M1 (extension error taxonomy + pages cache union — Agent 3's
revision), C2/H1 + op-or-ledger invariant (fail-closed assignment floor, quiz-only
rows — fc), reading-index silent caps (ff, inside work order F). Remaining, in
severity order, each with file:line evidence in the report:

1. **H3 — a failed scope publish strands a newly selected class.** The extension
   treats a `/config/scope` failure as cosmetic and syncs anyway; `sync-scope.json`
   outranks the newer `last_sync.json`, so class B is ingested but the pipeline and
   calendar keep filtering by the stale mirror, with no drop record. Either make
   scope publication a prerequisite for `/ingest/complete`, or have `readSyncScope`
   distrust a mirror older than the completed sync. Crosses extension + bridge
   custody — needs its own coordinated lane.
2. **H2 — peer-review / subassignment deadlines are never fetched.** Canvas exposes
   them (assignment peer-review inclusion, calendar `sub_assignment` rows, Learning
   Object Dates); a review deadline distinct from the parent due date has no path
   into any stored file. New collection capability — user sign-off before building.
3. **H4 — mining accepts a valid-but-incomplete model return.** No postcondition
   compares model output against the raw assignment corpus; `{"items":[]}` for a
   40-row class writes clean. The raw union downstream (v1.8.29) now repairs the
   CALENDAR, so this is mining-quality, not calendar loss — add a coverage warning
   (and the un-ledgered syllabus-budget skip at mine-assignments.js:227) rather
   than a hard gate.
4. **L1 — announcement window.** Term-start-to-tomorrow is right for the calendar,
   but announcements scheduled ahead or predating a late first sync never enter the
   corpus. Only matters to mining context; note kept for the next collection pass.
5. Dated raw rows with `id == null` are filtered before normalization with no
   ledger record (canvas-tasks.js:225) — malformed-cache guard, fold into fc's
   invariant work if cheap.

## Consolidate the four atomicWrite copies (routed to PM 2026-09-01, ruled: ticket)

write-lock.js, bridge/storage.js, scripts/_util.js and scripts/bump-version.js
each carry their own atomic-write primitive. The pid-keyed temp-name bug was
fixed in write-lock.js months before the same defect surfaced in storage.js —
a fix to one copy propagates to none of the others, and this instance needed a
second agent's sweep to converge. All four now agree; the risk is the
duplication itself. Shape when taken: a dependency-free root module (the
syllabus-source.js pattern) re-exported by all four sites with symbol-identity
tests, so divergence becomes impossible rather than unlikely. Crosses three
custodies — schedule as its own lane, not a rider.

## Orphan temp-home leak, logs/-only population (found 2026-09-01)

101 cvsync-scope-* orphans hold ONLY logs/delete.log with entries dated
2026-08-24 — a separate, older leak from the calendar/-writing bug fixed in
v1.8.35: something writes <home>/logs after teardown. Deliberately NOT swept
(they are the only evidence). Root-cause when a lane is free; the v1.8.35
commit and scope.test.js's updated comment carry the breakdown (151 total:
44 calendar/ swept, 6 seeded, 101 logs/-only kept).
