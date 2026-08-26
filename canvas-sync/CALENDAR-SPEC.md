# CALENDAR-SPEC — the calendar, specified so it can be checked

**This file is the contract.** It exists because the calendar has been reported
broken four separate times and each round of work was measured against my memory
of the request instead of the request itself. It is designed to survive context
compaction: it lives in the repo, it quotes the user verbatim, and every line of
it is checkable by a command or a number rather than by an opinion.

Last verified: **2026-08-24**, against the six real Fall 2026 classes.
Suites at that moment: `scripts/` **445 pass / 0 fail**, `bridge/` **261 pass / 0 fail**.

## How to use this file

1. **Never tick a box you have not checked in the exact way the Check column
   says.** A `~` with a named gap is worth more than an `x` that is wrong.
2. **Three ticks, three different meanings.** `Built` = the code exists and its
   unit tests pass. `Live` = I drove it in a real browser against real class
   data and measured the stated number. `User` = it is running on the bridge the
   user's own app talks to, so they can see it without me doing anything.
3. **A change to a file un-ticks `Live` and `User` for every row that file
   serves.** Code that has been edited since it was last driven is code that has
   not been driven.
4. Evidence is a file:line, a command's real output, or a number. Not an
   adjective.

## Source — the user's own words

| When | Said |
| --- | --- |
| 2026-08-24 03:01Z | "the calendar is ugly right now & doesnt bunch by day OR class. should do both." |
| 2026-08-24 13:08Z | "-multiple calendar interfaces" |
| 2026-08-24 13:15Z | "Calendar needs visual customization, colors per class, toggleable class visibility, improved populate, task completion indicators & ability to set as done, etc." |
| 2026-08-24 18:06Z | "the calendar is not fully populating correctly" |
| 2026-08-24 19:28Z | "fix the calendar so WITHIN the calendar there is full functionality control for marking assignments complete and going straight to the assignment link on canvas with the 'submit' button" |
| 2026-08-24 (later) | "meetings are not going in correctly. they should show class days, times, and location. Should be titled '[LOC] - [CLASS] - [PROF]', eg. 'Virani 182 - BUSI380 - VanHorn' as pulled from the syllabus." |
| 2026-08-24 (latest) | "the calendar doesnt look at all as its supposed to. I told you to give me different view options; stacked vertically like it is now, side by side week view, monthly tiled view. Also need to have the check boxes. Stop shortcutting… Calendar items still not even clickable." |
| 2026-08-25 (later) | "for all dated items, include the number of days/weeks until its due, not just the date. I have a hard time tracking how impending stuff is by date. And add some sort of emphasis, maybe color coding? g/y/r system or something. or some sort of bold emphasis or something depending on how soon? pick whatever is the cleanest and communicates status most effectively" |

Also standing, from the UI direction given 2026-08-24 13:08Z: **"simplify,
minimalistic, small features, soft colors, functional"** — and the cream palette
that superseded the old dark one.

---

## §1 — Three view modes

The calendar has exactly three interfaces, chosen by one segmented control, and
the choice persists across reloads.

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 1.1 | A `List / Week / Month` segmented control sits in the calendar toolbar. | `document.querySelectorAll('[data-calview]').length === 3` | x | x | x |
| 1.2 | The chosen view is written to `localStorage.calView` and restored on reload. | Set Month, reload, `localStorage.calView === 'month'` and the Month button carries `.active` | x | x | x |
| 1.3 | **List view** is the current stacked-vertical list and keeps its own `Day / Class` grouping control. | With `calView=list`, `#cal-ops .cal-row` count equals the filtered op count, and the `[data-group]` control is visible | x | x | x |
| 1.4 | The `Day / Class` grouping control is hidden in Week and Month view, where it has no meaning. | With `calView=week`, `getComputedStyle($('cal-group-seg')).display === 'none'` | x | x | x |
| 1.5 | **Week view** lays 7 days out side by side, Monday through Sunday, as 7 columns. | `getComputedStyle($('cal-week')).gridTemplateColumns` resolves to 7 track widths | x | x | x |
| 1.6 | **Month view** is a tiled grid: 7 columns wide, one tile per calendar day, whole weeks only (leading/trailing days of adjacent months shown but dimmed). | Tile count is a multiple of 7 and ≥ 28; `.cal-tile.adjacent` exists for a month that does not start on Monday | x | x | x |
| 1.7 | Week and Month each have `‹ prev`, `Today`, `next ›` controls, and a heading naming the period. | Clicking `next ›` in Week advances the heading by exactly 7 days; `Today` returns to the period containing today | x | x | x |
| 1.8 | Opening the calendar lands on the period containing **today**, not on the first item in the worklist. | With `calView=week` on a cold load, the heading contains today's date | x | x | x |
| 1.9 | Switching views never loses the kind filter or the class visibility selection. | Hide one class + filter to Meetings, switch List→Week→Month→List, both still applied | x | x | x |

**Measured 2026-08-24.** 3 `[data-calview]` buttons. `calView` persisted and
restored across a reload (`week`). List: 240 `.cal-row` for 240 ops, group
control visible. Week: `grid-template-columns` = 7 tracks, heads `Mon 24 … Sun
30`, group control `display: none`. Month (August): 42 tiles, 42 % 7 = 0, 11
`.adjacent`, first tile a Monday, last a Sunday; October: 35 tiles. February
2027 — the month that starts Monday and ends Sunday — yields exactly 28 tiles
and 0 adjacent (`bridge/test/cal-grid.test.js`). `next ›` moved `Aug 24 – 30,
2026` → `Aug 31 – Sep 6, 2026`. Cold load with `calView=week` opened on `Aug 24
– 30, 2026` with today's column marked once. Hiding BUSI 305 and filtering to
Meetings survived List→Week→Month→List with 90 / 6 / 31 / 90 items and 0 items
from the hidden class in any of them.

## §2 — Task control inside the calendar

This is the "full functionality control" ask. It must hold **in all three
views**, not only in List.

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 2.1 | Every deadline item (`calendar === 'due'`) renders a checkbox. | In each of the three views, `[data-cal-done]` count === the number of visible `due` ops | x | x | x |
| 2.2 | Ticking it POSTs `{done:true}` to `/api/class/:folderName/task/:taskId` and the row goes struck-through immediately, before the request returns. | Network shows the POST; the row gains `.is-done` synchronously | x | x | x |
| 2.3 | A failed POST puts the tick back and toasts. Nothing is left showing as saved that did not save. | Block the route, click, assert `checked === false` and a toast appeared | x | x | x |
| 2.4 | **`CAL_DONE` is seeded from the server on load**, so a tick survives a reload. | Tick an item, reload, the box is still ticked | x | x | x |
| 2.5 | A **done item can be un-done from the calendar** — a `Show completed` toggle re-renders finished work struck through and still checkable. | Tick an item, wait for the rebuild, turn on `Show completed`, the row is present, ticked, and un-tickable | x | x | x |
| 2.6 | The item **title is a button that opens the in-app assignment page**. | `[data-open-assignment]` count === visible `due` **+ `checkpoint`** op count in every view (2.12 made checkpoints openable); clicking one shows the assignment panel | x | x | x |
| 2.7 | A **Submit link** goes straight to the Canvas submission URL, in the corrected `/quizzes/:id/take` form, and opens in a new tab. | Every `.cal-submit` href matches its op's `submit_url`; no quiz-backed row uses the `/assignments/` form | x | x | x |
| 2.8 | An item with **no URL says so** rather than rendering a dead control. | Those rows carry a muted `.cal-nolink` marker and no `<a>` — reading `AI-added` when 2.13 knows why, `no link` otherwise | x | x | x |
| 2.9 | Checkpoints are checkable too — they are the user's own prep blocks. | `[data-cal-done]` appears on checkpoint rows; ticking one round-trips | x | x | x |
| 2.10 | Meetings are **not** checkable and **not** openable, and must not render a dead checkbox or a dead link. | `.cal-row.meeting [data-cal-done]` count === 0 and `.cal-row.meeting .cal-title a[href]` count === 0 | x | x | x |
| 2.11 | The client must not re-derive the `folder` ↔ `slug` strip — `/api/classes` ships `slug`, so the join uses that. | `calFolder()` no longer contains a `/^[0-9]+-/` regex | x | x | x |
| 2.12 | **A checkpoint clicks in to the assignment it preps for** ("make it so all the check ins have click in", 2026-08-25): its title is the same in-app button a deadline has, and Canvas-backed parents put their URL on the op and in its description. | `[data-open-assignment]` count === visible due + checkpoint count in every view; clicking a prep block's title opens the parent's panel with its Canvas Open/Submit links; every checkpoint op whose item has a live Canvas row carries `url` | x | x | ~ |
| 2.13 | **AI-added work looks different from actual work** ("so I dont stress trying to figure out what to do/submit for an assignment that isnt actually a submitted assignment", 2026-08-25). Every due op carries `origin: 'canvas' \| 'syllabus'`; syllabus rows get a dashed edge, an italic title and an `AI-added` pill in all three views and the task list; the assignment panel states it in a sentence and hides Open/Submit. | `.cal-row.ai-added` count === due ops with `origin === 'syllabus'`; each carries `.cal-nolink.ai`; `.task.ai-added` matches items with `origin === 'syllabus'`; panel shows `.notice.ai-added` for a syllabus item and never for a Canvas-backed one | x | x | ~ |

**Measured 2026-08-24.** List view: 240 rows, **102 checkboxes** = 102 `due`
ops, **102** `[data-open-assignment]`, **74** Submit links, **20** `no link`
markers — matching the worklist exactly (102 due ops, 20 with neither `url` nor
`submit_url`). Week of Aug 31: 22 chips, 14 non-meeting, 13 checkboxes (the 14th
is a checkpoint — see 2.9). October month: 25 checkboxes across the tiles.
Ticking wrote `{"done": true, "doneAt": …}` to the fixture's `user_state.json`
and the row struck through before the response. With `fetch` blocked the tick
reverted and the toast read `Could not save that: blocked for test`. Tick →
reload → **box still ticked, row still struck** (this was a real defect: the set
was only ever written by the click handlers). `Show completed` brought the
finished row back ticked; un-ticking it from there put the item back in the
worklist (239 ops → 240) and emptied `user_state.json`. Submit links: 73
rendered, **0 mismatched hrefs**; of 101 deadline ops, 38 are quiz-backed and
**all 38** use `/quizzes/:id/take`, 43 are assignment-backed and **all 43** use
`/assignments/:id/submissions/new`; 0 wrong either way. 106 meeting rows, **0**
carrying a checkbox or a link. Clicking a calendar title opened the assignment
panel with the matching title.

**2.9 closed 2026-08-24.** It was a data gap, not a UI one: no checkpoint op
carried anything to POST, because a prep block is derived from the marker of the
item it prepares for (`[csync:s|busi-396…|a530964+7d|…]`). Three things closed
it. (a) `sync-calendar.js` now puts `item_id` **and** `checkpoint_id` on every
checkpoint op — `auto:7d` for a derived block, the uuid for one the user wrote.
The id is the **offset**, not the date, so moving a deadline moves the tick with
it instead of stranding it. (b) `patchTask` takes `{checkpointDone:{id,done}}`,
so one block ticks off without the client echoing the whole list back — which it
could not do for a derived block anyway, since those exist nowhere but the
worklist. (c) `calItemModel` keys `CAL_DONE` on `folder|item|checkpoint`, and
refuses to draw a checkbox on a checkpoint with no id of its own; without that
guard, ticking a prep block would have marked the whole assignment submitted.

**Measured 2026-08-24, on the fixture bridge, six real classes.** List view:
**134 checkboxes = 102 deadlines + 32 checkpoints**, and 106 meeting rows still
carrying a `.cal-check-gap` and no checkbox. All **32 of 32** checkpoint ops
carry both ids. Ticking `auto:7d` on BUSI 396's Benchmark Communication Package
wrote `{"checkpointsDone":["auto:7d"]}` to `user_state.json` — and **did not**
set `done` on the item; its sibling `auto:2d` and the deadline itself stayed
unticked and unstruck. The rebuild took the worklist 239 → 238 ops (32 → 31
checkpoints) and left a `dropped` record titled `Prep 7d · BUSI 396 Benchmark
Communication Package`. Reload: still ticked. `Show completed` drew it struck
through **with the op title, not the raw mined one** (the record carries
`event_title` for exactly this). Un-ticking from the calendar emptied
`user_state.json` and put the op back (238 → 239). Repeated the whole round trip
from a month-view chip: same result. Covered by tests in
`bridge/test/user-state.test.js` (6 new) and `scripts/test/sync-calendar.test.js`
(the offset survives the deadline moving).

## §3 — Looks and behaviour, in all three views

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 3.1 | Each class has one colour, visible on every one of its items in every view. | Every row/chip has a non-empty `--class-color`; no two of the 6 classes share one | x | x | x |
| 3.2 | Class visibility chips hide and show a class across all three views. | Hide BUSI 380: its op count drops to 0 in List, Week and Month | x | x | x |
| 3.3 | The kind filter (`All / Due / Checkpoints / Meetings`) applies in all three views. | Filter to Meetings in Month view: every chip rendered has `calendar === 'meeting'` | x | x | x |
| 3.4 | **Today** is visually marked in Week and Month. | `.cal-daycol.today` / `.cal-tile.today` exists exactly once when the period contains today | x | x | x |
| 3.5 | Overdue deadlines are marked; **past meetings are not**. | A past meeting row has no `.overdue` class | x | x | x |
| 3.6 | Cream palette, soft colours; states are shown in **ink weight, not opacity**. | No `opacity` rule on a done/off state in `style.css` outside genuinely disabled controls | x | x | x |
| 3.7 | **No horizontal overflow** at 375px, 768px and 1280px, in all three views. | `documentElement.scrollWidth <= clientWidth`, 9 combinations | x | x | x |
| 3.8 | A Month tile holding more items than fit shows `+N more`, and clicking expands that day. | A tile with 4+ items shows the marker; clicking expands | x | x | x |
| 3.9 | Keyboard reachable: every checkbox, title button and view control is tabbable. | No `tabindex="-1"` or `disabled` on an interactive calendar control | x | ~ | x |
| 3.10 | Empty states say which filter emptied the view. | Hide every class: the message names that cause | x | x | x |
| 3.11 | **Every dated item states its distance and grades it by urgency** ("include the number of days/weeks until its due… g/y/r system or something… pick whatever is the cleanest", 2026-08-25). One vocabulary (`relPhrase`: days inside two weeks, weeks beyond) and one ladder (`dueTier` → `.due-rel`: muted → amber `soon` ≤7d → brick `now` ≤1d → bold brick `overdue`) across the task list, checkpoints, home Coming up, the assignment page, and List-view day headings. Done items are never loud; day headings only grade when the day holds unfinished non-meeting work; past days are history, not alarms. | `relPhrase`/`dueTier` unit-tested in `cal-grid.test.js`; every `.cal-day-head` carries a `.cal-day-rel`; 0 tiered rels under `.cal-day.past`, `.task.is-done`, `.cp-row.done`; a meetings-only day inside the week has no tier; `--warn` ≥4.5:1 on ground/panel/sunk | x | x | x |

**Measured 2026-08-24.** 6 classes, **6 distinct colours** (`#3E6B8A #7A5C3E
#4E7A5B #8A4F5C #5C5A8A #8A7136`). Hiding a class removed all its items in all
three views. Filtering to Meetings left 0 non-meeting items in all three. Today
marked exactly once when in the period, **0 times** when the grid was moved off
it. 106 meeting rows, **0** with `.overdue`. Overflow: 9 of 9 combinations gave
`scrollWidth === clientWidth`; at 1280 both grids fit without scrolling at all.
`+3 more` on 2026-10-01 expanded 3 chips → 6 and became `show less`. 13
interactive controls, **0** untabbable. Hiding all six classes printed "Every
class is hidden. Turn one back on above."

**3.9 `Live` is a `~` on purpose.** Tabbability was measured; actual Enter/Space
activation of each control was not driven from a synthetic key event. The
controls are real `<button>` and `<input type=checkbox>` elements, so activation
is the platform's, but that is an argument rather than a measurement.

**A note on 3.7.** Both grids scroll inside their own box (`.cal-gridwrap`)
rather than stretching the page — a week is seven columns by definition and
collapsing it to one on a phone would just be the list again. `html` needed
`overflow-x: hidden` alongside `body`: with the root left visible the viewport
took body's value, body stopped clipping, and `documentElement.scrollWidth`
reported 652 against a 375px viewport for content that could not actually be
scrolled to. The page never scrolled; the measurement lied.

## §4 — Population correctness (the data behind the views)

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 4.1 | Meeting events are titled `[LOC] - [CLASS] - [PROF]`, from the syllabus. | `meetingTitle()` emits that shape; spot-check ENTR 222, the one class with a room | x | x | x |
| 4.2 | With **no room known** the title degrades to `[CLASS] - [PROF]` — never an empty leading `" - "`, never the literal `null`. | No op title matches `/^\s*-/` or contains `null` or `" -  - "` | x | x | x |
| 4.3 | The professor is a **surname** from `course.instructor.name`, surviving a title (`Dr. Leila Peyravan` → `Peyravan`) and an internal capital (`VanHorn` stays whole). | Unit test over all six real instructor strings | x | x | x |
| 4.4 | Meetings show days, times and location where known, and say plainly where not. `busi-305` and `busi-396` have `meeting_schedule: null`. | Those classes' ops are `all_day` with `time_known: false` and a description saying why | x | x | x |
| 4.5 | BUSI 396 contributes 0 meeting ops. The calendar must **state why**, not show an empty column. | The reason is rendered in the calendar UI, verbatim from the worklist | x | x | x |
| 4.6 | `reading` is 0 ops and the Readings toggle is structurally dead. Either it produces ops or the calendar says why it cannot. | The reason is rendered in the calendar UI | x | x | x |
| 4.7 | Asking what the calendar would say must not change it. | `buildWorklist(dir,{write:false})` writes nothing — 2 tests | x | x | x |

**Measured 2026-08-24**, on a worklist rebuilt from the six real classes:

```
entr-222-001 (28)  Cambridge Office Building 130 - ENTR222 - Wulf
busi-305-…   (16)  BUSI305 - Peyravan          ← "Dr." stripped, no room known
busi-374-…   (28)  BUSI374 - VanHorn           ← internal capital kept whole
busi-380-002 (23)  BUSI380 - Porter
econ-205-002 (11)  ECON205 - Dudey
busi-396-…    (0)  — see the note the calendar now shows
```

106 meeting ops, **0 forbidden title shapes**. The calendar renders, verbatim
from `worklist.kind_notes`:

- filtered to Meetings — *"BUSI 396 001/002/003/004 · Meetings: none on the
  calendar — 4 class meetings are module or unit boundaries heading date ranges,
  not class sessions."*
- filtered to Due — *"ECON 205 002 · Homework: none on the calendar — 1
  assignment recurs on no fixed date."* and *"Readings: none on the calendar — 1
  reading recurs on no fixed date."*

Vacuous notes ("no readings to schedule in this class", printed once per class)
are filtered out with the same rule `renderWorklistMd()` uses, so the page and
the routine's own markdown agree about what is worth saying.

**4.1/4.2 hardened 2026-08-24, after an adversarial pass found four ways to
rebuild the shapes 4.2 forbids.** None of them changed a live title — all four
are one field of professor-typed text away from doing so.

- **A cancelled Canvas session was titled with a room and a professor.**
  `meetingsFromCanvasEvents()` hardcoded `holiday: false` (Canvas has no holiday
  type to read), the call site asked only `m.holiday`, and Canvas events are the
  **first** source `collectMeetings()` merges. So a professor who keeps the
  event and renames it `No Class - Fall Break` got `Virani 182 - BUSI380 -
  Porter` — this file's own description of the failure it exists to prevent.
  Now the event's own words are read (`NO_CLASS_RE`), it emits `label: 'No
  class'`, `holiday: true`, no room and no clock time, and the call site asks
  the row's `label` as well as its flag.
- **A punctuation-only room.** `-` is what a professor types in a field they
  have nothing to put in; `stated()` filtered the WORD placeholders and no
  punctuation one, so the dash joined through as `- - BUSI380 - Porter`. Both
  ends of a room are now stripped of separators, so `Virani 182 -` (a label
  clipped with its dash) is `Virani 182`.
- **The course code was not placeholder-filtered** the way the other two fields
  were: a `metadata.json` holding the string `"null"` walked into 23 lecture
  titles of the term.
- **"break" and "holiday" were treated as no-class anywhere in the label.**
  They are lecture SUBJECTS in this user's own classes first — break-even
  analysis is BUSI 305, holiday demand is BUSI 380 — and titling that day `No
  class - BUSI380` tells a student to stay home on a day the class meets. The
  backstop now asks the word's POSITION: a term off is a short label whose head
  noun is the break itself (`Spring Break`), a lecture puts the word in front of
  what it is about (`Holiday Shopping Behaviour`).

The op's `location` **field** is normalised by the same `roomName()` the title
uses, so the event cannot print a location line reading `-` next to a title that
correctly says nothing.

Re-measured on the six real classes after the fix: 251 ops, **0 forbidden title
shapes**, one distinct meeting location (`Cambridge Office Building 130`), the
same seven distinct meeting titles as above plus `No class - BUSI380` and `No
class - ENTR222` (5 no-class ops, dated 10/06, 10/13 ×2 and 11/26 ×2). 9 new
tests in `scripts/test/cal-names.test.js` and
`scripts/test/sync-calendar.test.js`.

**Confirmed on the user's own bridge, 2026-08-24 16:30**, real data, read-only:
list view 251 rows / **145 checkboxes** (113 deadlines + 32 checkpoints) / 113
open buttons / 74 Submit links; week 9 chips; month 21 chips; `scrollWidth -
clientWidth === 0` in all three. The 5 `No class` rows render with **no**
checkbox, and ENTR 222 reads `10:50 AM–12:05 PM Cambridge Office Building 130 -
ENTR222 - Wulf`.

## §5 — It has to be running

The single most repeated failure in this project: work is finished, tested, and
the user cannot see any of it because their app is talking to a bridge process
older than the code.

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 5.1 | Every row above is on the bridge the user's own app talks to. | The bridge on `:3847` is newer than the files, and serves them byte-identically | x | x | x |
| 5.2 | Stray bridges from abandoned workstreams are not left listening. | Exactly one CANVASync bridge is listening | x | x | x |

**5.1, re-measured 2026-08-24 17:14** after the Populate rework. The topology
changed at the user's request: the app is launched from `CANVASync.app` and
`ensureBridge()` spawns the bridge as its own child (pid 29549 under app pid
29540), so there is no detached bridge to outlive the window. `sha256` on disk
equals what `:3847` serves for all **six** public files — `index.html`,
`app.js`, `style.css`, `cal-grid.js`, `cal-plan.js`, `progress.html` — each with
the right `Content-Type`, and `/api/classes` still 401s without a secret. The
Electron `Cache` (4.8 MB, Aug-23 response bodies) and `Code Cache` (88 KB,
Aug-23 V8 compilation of `app.js`) were deleted while the app was stopped;
`Local Storage`, which holds the app's stored secret and the user's class
colours and view preferences, was left untouched.

*Previous measurement, 16:30:* Any edit under `bridge/` un-ticks this
row, so it is re-done at the end of every change. The bridge was stopped and
restarted from the same working directory with the same environment (now pid
18912, `127.0.0.1:3847`); the earlier restart at 15:48 replaced a process that
had been up since 10:29. `sha256` of `index.html`, `app.js`, `style.css`,
`cal-grid.js` and `progress.html` on disk **equals** what `:3847` serves, for
all five, and `/api/classes` still 401s without a secret. `/app/progress.html`
returns 200 where it once 404'd and `/app/cal-grid.js` returns 200 with
`Content-Type: application/javascript`, so the `type="module"` tag resolves. The
worklist was rebuilt on the same code: **251 ops**, all 32 checkpoints carrying
both ids, 0 forbidden title shapes, 5 `No class` meetings (BUSI 380 on 10/06,
both classes on 10/13 and 11/26). The previous worklist is kept in the session
scratchpad.

**5.2 closed 2026-08-24 17:00** — see the Ledger. All three stray bridges were
stopped once the user asked for it, and the topology changed so the row cannot
recur on its own: the app spawns and owns the bridge, so quitting the app stops
it. The `5.2` row's tick columns are ticked on that basis.

## §6 — Populate: one selection, never an off switch

Added 2026-08-24 17:0x, after the panel emptied the user's calendar. At 17:02:42
— 36 seconds after a fresh app window opened — the five independent switches
were all turned off and then Homework turned back on. The worklist went **251 →
105 ops**, four of the six classes lost every event, and the only thing the
calendar said about it was four lines reading *"Meetings: none on the calendar —
the Meetings switch is off."*

The user's rule, verbatim: *"populate should remove the all option & that should
be default. If one (or more) are selected, then it becomes only those ones on
the calendar."* And: *"i want you to remove per-class overrides."*

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 6.1 | The five kinds are a **selection**, not five switches. Nothing selected means every kind. | `planSelection()` returns `[]` when all five are stored true | x | x | x |
| 6.2 | Selecting one or more shows **only those** on the calendar. | Click Meetings → worklist and list hold meeting ops only | x | x | x |
| 6.3 | Clicking the only selected chip goes back to **everything**, not to nothing. | `nextSelection(['meeting'], …, 'meeting')` === `[]` | x | x | x |
| 6.4 | **No sequence of clicks can select nothing.** The 251→105 failure must be unreachable, not merely discouraged. | Exhaustive test over all 32 selections × 5 chips: every stored result has at least one kind true | x | x | x |
| 6.5 | There is **no All button**. 6.3 is what it was for. | `[data-plan-all]` count === 0 | x | x | x |
| 6.6 | **Per-class overrides are gone.** One selection governs the whole calendar. | `#cal-perclass` absent; `plan.classes` === `{}`; no `[data-plan-class]` | x | x | x |
| 6.7 | The **meeting-times editor survives** the removal — it was the one control that panel was hiding, and two of six classes state no class time anywhere on disk. | Superseded by §7.1 — the editor lives on each class's Overview tab AND in the calendar's `#cal-meettimes` list | x | x | x |
| 6.8 | Nothing selected lights **every** chip, because that is what the calendar is doing. | `isSelected([], k)` is true for all five | x | x | x |
| 6.9 | A kind that is off gets **no note**. A kind that is on and still produced nothing keeps its reason. | No `kind_notes` string matches `/switch is off/`; the Readings note survives | x | x | x |

**Measured live 2026-08-24 17:15**, on the user's own app-owned bridge and their
six real classes:

```
default (nothing selected)  5 chips lit   251 items across 6 classes
click Meetings              1 chip lit    106 items across 5 classes
click Exams   (adds)        2 chips lit   114 items across 5 classes
click Exams   (removes)     1 chip lit    back to meetings only
click Meetings (the last)   5 chips lit   251 items across 6 classes
```

`plan.json` ends `{meeting, homework, reading, exam, checkpoint}` all true with
`classes: {}`. 14 tests in `bridge/test/cal-plan.test.js`, including the
exhaustive 6.4 sweep. The logic lives in `bridge/public/cal-plan.js` — pure, no
DOM — so the page and `node --test` run the same file, the way `cal-grid.js`
does for the grid maths.

**6.9 in the calendar's own words.** Before: four notes reading *"Meetings:
none on the calendar — the Meetings switch is off"* and its three siblings.
After: one note, *"Readings: none on the calendar — 1 reading recurs on no fixed
date."* The first four restated a control directly above them; the survivor
states a fact about the data that nothing on the screen can otherwise give.

**What the panel lost, and why that is the point.** Four lines of the calendar
now say nothing instead of restating a control the user can see; the per-class
matrix (6 classes × 5 kinds = 30 buttons) is gone; the `All` button is gone. The
Populate panel is five chips and a collapsed `Meeting times` list.

## §7 — Class times: set, change, and undo

Added 2026-08-25. The user's request: *"add ability to input/modify a class
time if it is not existing. also incl. a revert option in case its accidentally
changed or put in wrong."* The editor already lived on each class's Overview
tab; 6.7's `#cal-meettimes` check described a calendar-side list that never
actually existed until now, and nothing anywhere could undo a bad save.

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 7.1 | The calendar carries a collapsed `Class times` list: every in-scope class, its current time and where it came from, and a `set times` (nothing known) or `change` (any time on record) control opening the same editor used on the Overview tab. | `#cal-meettimes` holds one `.meet-row` per class; a class with `has_time` shows `change`, one without shows `set times`; submitting the row's form POSTs `/api/class/:folder/meetings` | x | x | |
| 7.2 | The list's summary states how many classes still need a time, so a collapsed disclosure never hides the actionable fact. | `#cal-meettimes-summary` counts the classes whose `meeting_times.has_time` is false — on the six real classes it reads `Class times · 3 not set`, and drops to `2 not set` the moment one is given a time | x | x | |
| 7.3 | Every save or clear stashes what it replaced (`meeting_override.prev.json`), and an `undo` control appears wherever the editor does, saying what it lands on — `undo — back to TuTh 1:00-2:15 PM`, or `undo — back to the syllabus` when no override stood before. | `writeMeetingOverride`/`clearMeetingOverride` write `PREVIOUS_FILE`; `describeRevertTarget` unit-tested; `[data-meet-revert]` renders only when the server says `revert.available` | x | x | |
| 7.4 | Undo is itself undoable: revert swaps states, so a second click is redo, and no click can strand the user. | `revertMeetingOverride` twice restores the newer override again (unit-tested); driven live: set → undo → undo returns the typed time and its calendar events | x | x | |
| 7.5 | A revert lands on the calendar, not just in the file: the worklist rebuilds behind it exactly as it does behind a save. | POST `/api/class/:folder/meetings/revert` responds `rebuild_started: true`; driven live: undo removed the override's meetings from the grid within the poll window | x | x | |
| 7.6 | A save that changes nothing does not eat the undo target, and a stash that no longer validates offers no undo at all. | Unit tests: identical re-save keeps the older stash; corrupt/day-less stash → `readMeetingRevert` null and the override left alone | x | | |

**Measured live 2026-08-26**, in a real browser against **all six real Fall
2026 classes** — a byte copy of the user's data root, so the real syllabi are
read and the user's own files are never written. Re-driven on `3bbea94`, whose
`app.js`/`server.js` edits un-ticked the first (fixture) drive under rule 3.

The list, cold: **6 `.meet-row`, 6 edit controls, 0 undo controls** (nothing
changed yet), summary `Class times · 3 not set`. The three are the three the
corpus actually lacks — BUSI 305 and BUSI 396 (`meeting_schedule: null`, 4.4)
and BUSI 380 (days-only `TuTh`, the case this module exists for). The other
three read their real times: BUSI 374 `MW 2:30-3:45 PM`, ECON 205 `Tu 6:30-7:45
PM`, ENTR 222 `TuTh 10:50 AM-12:05 PM, Cambridge Office Building 130 (room from
the Canvas course pages)`.

```
BUSI 380  set times → From your override — TuTh 10:50 AM-12:05 PM, McNair 214
          summary 3 not set → 2 not set;  20 of 24 meeting rows take the time,
          titled "McNair 214 - BUSI380 - Porter" (4.1's shape, prof from the syllabus)
          undo  → Days only (TuTh)… Set it yourself.  ·  0 timed rows  ·  3 not set
          undo  → override and all 20 timed rows back  ·  2 not set
ECON 205  change  → editor prefilled Tu 18:30-19:45 from the SYLLABUS, not blank
                  → TuTh 6:00-7:15 PM
          "Use the syllabus instead" → From the syllabus — Tu 6:30-7:45 PM
          undo  → TuTh 6:00-7:15 PM restored   (the mis-clicked-clear case)
reload    → both changed classes still offer undo; the four untouched offer none
```

That last line is the one worth keeping: the stash is on disk, so an undo is
still there after the app is closed and reopened — not just within a session.

7.6 stays `Built`-only by design: a corrupt stash and a no-op re-save are
states the UI cannot be made to produce on demand, so unit tests are the
evidence. `User` waits until this runs on the app-owned bridge. Suites at this
note: `scripts/` **580 pass / 0 fail** (7 new revert tests), `bridge/` **285
pass / 0 fail**.

---

## Ledger

**Open rows: 8 of 57** — every one of them open in the `User` column only.
2.12 and 2.13 are `~` (they ride on `server.js`, so they wait for the app to be
relaunched); 7.1–7.6 are blank, because §7 has been driven on a byte copy of
the real data root but not yet on the app-owned bridge. Nothing is open in
`Built`, and only 7.6 is open in `Live`.

**5.2 closed 2026-08-24 17:00.** The user said *"kill anything old so I can run
just the newest version of this"*. The three stray bridges on `:3848` (pid
55984), `:3850` (pid 53167) and `:3860` (pid 59308) were stopped — all three
pointed at scratchpad test homes, none at the real data root. The detached
bridge on `:3847` was stopped too, and the app relaunched from `CANVASync.app`
so it spawns and **owns** its own bridge: quitting the app now takes the bridge
with it, instead of leaving the orphan that caused this row in the first place.
Exactly one Electron app and exactly one bridge are listening.

Everything in §1–§6 is built, driven against the six real classes with the
stated number measured, and running on the user's own bridge.

**Re-verification 2026-08-25 — full visual rebuild ("warm print").** style.css
was rewritten from scratch, index.html gained the Settings Functions card and
the Plex Serif face, app.js gained the Functions wiring and the
composedPath() picker fix — so every Live/User tick above was void under rule 3
and the affected checks were re-driven on a fixture bridge (`:3849`, real
class data, dummy secret, symlinked read-only):

- §1: 3 `[data-calview]` buttons; List 223 `.cal-row`; Week 7 tracks; Month 42
  tiles / 11 adjacent / today ×1; grouping control hidden outside List. NEW:
  the grids now FILL the viewport (grid bottom within 16px of the window edge
  at 900×600, 1240×840 and 1280×800) — the user's "calendar isn't filling full
  screen" report.
- §1.9/§3.2/§3.3: hid busi-305 + filtered Meetings, cycled
  List→Week→Month→List: 67/5/10/67 items, 0 from the hidden class; restored to
  223 with all kind chips lit.
- §2 counts: 135 checkboxes, 105 open buttons, 74 Submit links, 12 `no link`
  markers — consistent with the current 223-op worklist. The POST/tick round
  trips were NOT re-driven live (they would write the user's real
  user_state.json); they are unchanged code covered by
  bridge/test/user-state.test.js.
- §3.6: cream palette retained; done/off states still ink-weight (the only
  opacity rule is button:disabled).
- §3.7: 9/9 combinations at 375/768/1280 give `scrollWidth - clientWidth = 0`.
  Chrome's phone mode initially promoted the month grid's min-width into the
  layout viewport (a 61px pan at 375); fixed with `contain: layout` on
  `.cal-gridwrap`, then re-measured 0.
- §3 chips: month/week items now clamp titles at TWO lines instead of one
  ellipsized line — the user's "items get terribly cut off" report.
- Colour picker (§3.1 adjacent): open → pick → server override → revert → `{}`
  driven end-to-end; the open-then-instantly-close defect was a detached-node
  `closest()` in the outside-click handler, fixed with `composedPath()`. The
  user's own bridge wrote a real pick (busi-380 → #4e7a5b, 13:59) after ⌘R,
  which is §5-grade confirmation for the picker.
- §5: sha256 of index.html, app.js, style.css, progress.html on disk equals
  what `:3847` serves (static files are read per request), so the visual
  rebuild is already User-visible after ⌘R. The server-side changes of the day
  (trigger.js Functions gating, index-progress off-in-settings and shortCode)
  still need the app relaunched.

Suites at this note: `bridge/` **271 pass / 0 fail**, `scripts/` **556 pass /
0 fail**. The fixture bridge was torn down and the scratch home deleted.

**2026-08-25, later — checkpoints click in, AI-added work says so (rows 2.12,
2.13; 2.6/2.8 amended).** The user's words: *"make it so all the check ins
have click in. also make AI added tasks/assignments look different from actual
ones so I dont stress trying to figure out what to do/submit for an assignment
that isnt actually a submitted assignment."*

- **Provenance is one field, stamped at the source.** `tasksForClass` marks
  every item `origin: 'canvas'` (a live Canvas row stands behind it) or
  `'syllabus'` (the AI mined it; nothing to open or submit — including a
  claimed Canvas row that no longer exists). `sync-calendar` carries it onto
  every due op, checkpoint op and done-drop record; the assignment route
  computes the same answer server-side. Fallback for a pre-field worklist:
  "no link anywhere", true of exactly the same rows.
- **Checkpoint ops carry their parent's URL** (op field + description line, so
  the ICS files get it too). Auto-prep markers hash title/date/dueDate — not
  the description — so no calendar event churns.
- **The route now follows a mined claim to its Canvas row**: the calendar
  opens items by mined id, and a merged item opened that way used to arrive
  with no Canvas links (`bridge/test/assignment-route.test.js`, 3 tests).
- Driven on a fixture bridge (`:3849`, the six real classes copied, dummy
  secret): worklist **222 ops — 104 due (93 canvas + 11 syllabus) + 30
  checkpoints (18 carrying parent URLs; the 12 without belong to syllabus-only
  items)**. List: 222 rows, **134 checkboxes = 134 open buttons** (was 105 —
  the 30 checkpoints, minus one due/cp visibility difference, are the gain),
  74 Submit links unchanged, **11 `.ai-added` rows each carrying the
  `AI-added` pill**, titles italic, task-list edge and badge dashed. Week and
  Month: open buttons === checkboxes (2/2, 9/9), AI chips' class-colour edge
  `dashed`. Clicking `Prep 7d · BUSI 396 Benchmark Communication Package`
  opened the parent panel with real Open/Submit links and **no** AI notice;
  clicking `BUSI 305 · Exam 1` showed the notice, hid Open/Submit, and Back
  returned to the calendar. The panel notice keys **strictly** on the
  server-sent `origin` — inferring from a null `canvas_id` would pin it on
  merged items served by an old bridge.
- The real worklist was rebuilt on the new code: same 222 ops, now carrying
  `origin` and checkpoint URLs, and `:3847` serves `app.js`/`style.css`/
  `index.html` byte-identical to disk — rows 2.12/2.13 are User-visible after
  ⌘R **except** the panel halves (origin field, claim-following lookup) and
  the course-pack API, which ride on `server.js` and wait for the app to be
  relaunched; their User ticks are `~` on that basis.
- Extension **1.3.0** (course packs; see README): out of this file's scope but
  synced in the same change — `external_tools` + `course_packs` ingest, the
  class page's `Course Pack ↗` link, and the context pack's course-pack
  section were driven on the same fixture.

Suites at this note: `bridge/` **277 pass / 0 fail** (canvas-tasks +2,
assignment-route +3), `scripts/` **562 pass / 0 fail** (sync-calendar +2).
The stray fixture bridge a previous session left on `:3849` was stopped first
(§5.2); this session's fixture bridge was torn down after the drive.

**2026-08-25, later still — every dated item says how far away it is, graded
by urgency (row 3.11).** The user's words are in the Source table: days/weeks
until due on every dated item, with colour or weight by how soon, "whatever is
the cleanest". The chosen design is one ladder, not a literal g/y/r: the
distance phrase itself ("in 3 days", "in 2 weeks") is the mark — muted ink,
amber (`--warn #7A4E12`) inside a week, brick today/tomorrow, bold brick past —
and there is no green rung because calm is the paper's own voice. Petrol keeps
marking today **as a place** (Week column, Month tile); the ladder grades
today **as a distance** (the token sheet now states the distinction).

- **The vocabulary is pure and tested.** `relPhrase(diff)` / `dueTier(diff)`
  live in `cal-grid.js` (+2 tests incl. a monotonicity walk over ±45 days);
  `bridge/` **278 pass / 0 fail**. One HTML renderer, `dueRelHtml()`, feeds
  every surface: task list (`fmtDue` now returns escaped HTML), checkpoint
  rows, home Coming up (`.hu-rel`, floored at 11ch), the assignment page
  (`assignment-sub` moved to escaped innerHTML; `daysUntilIso` keeps the
  local-day rule), and List-view day headings in both groupings
  (`calDayRelHtml`, which replaced `relativeDay`/`daysFromToday`).
- **Quiet is enforced, not hoped for.** A done item's rel is muted/400 in the
  task list, the checkpoint list, and on the assignment page (payload
  `user_state.done`); a day heading only grades when the day holds unfinished
  non-meeting work — a lecture-only Thursday reads muted "in 2 days"; past
  days never tier. Driven: BUSI 305's Aug 31 heading went quiet the moment its
  HW was ticked done.
- **Driven on a fixture bridge** (`:3849`, six real classes; `busi-305` and
  `calendar/` copied so ticks and moves write the fixture — real
  `user_state.json` mtime Aug 23 before and after — rest symlinked; dummy
  secret; torn down after, §5.2 rechecked). List 223 rows, 135 checkboxes =
  135 open buttons, 74 Submit, 11 `.ai-added`, 0 dead meeting controls; 85 of
  85 day heads carry a rel, 0 tiered under `.past`; Week 7 tracks, Month
  42/11 adjacent/today ×1; §3.7 overflow 12/12 at 375/768/1280. Ladder states
  measured live: `soon` = `#7A4E12`/500, `now` = `#96382C`/500, `overdue`
  (via a due-move to yesterday, then reset) = `#96382C`/700, done = muted
  `#6A6152`/400. `--warn` contrast computed: 6.1 ground / 7.1 panel / 5.6
  sunk.
- **A four-dimension adversarial review** (2 skeptics per finding) confirmed
  and got fixes for: a pre-existing unescaped `due_confidence` in the task
  template (now `esc()`d, with `flag-` too), the assignment page shouting at
  finished work (now keyed on `user_state.done`), `.hu-rel` at 10ch breaking
  column alignment past 9 weeks (now 11ch), and day headings tiering on mere
  proximity (now gated on unfinished work). The typeface mix is deliberate
  and documented: the ladder is colour and weight; the phrase speaks its
  line's voice. Named gap: the correctness reviewer died on a session limit —
  that dimension rests on the 278 unit tests and the live drive, not an
  independent reader. Home page bonus fix: `upcomingOps`/`renderHome` computed
  "today" via `toISOString().slice()` — the UTC slice that drops today's own
  deadlines from Coming up every evening — now `localTodayIso()`/`addDays`.
- **§5.1 re-measured:** all six public files sha256-identical on disk and at
  `:3847`; `/api/classes` still 401s bare. Everything here is `public/`-only,
  so it is User-visible on ⌘R with no app relaunch.

Suites at this note: `bridge/` **278 pass / 0 fail**, `scripts/` untouched.

**2026-08-25, later still — repo-wide bug hunt: the calendar's share.** A
59-agent adversarial review (8 finders, 1–2 skeptics per finding) swept every
package; 40 findings survived verification and all are fixed. The
calendar-relevant ones, so this file stays the ledger:

- **ICS correctness** (`scripts/cal-ics.js`): `escText` now really escapes
  `;` — the old replacement string was the literal `'\;'`, which IS `;`, and
  the test pinned the typo rather than the header's stated RFC 5545 rule.
  Timed deadline blocks now END at the deadline (15:45–16:00 for a 16:00
  due) instead of starting there — the old test only exercised 23:59, the
  one time where the clamp hid the direction error. The push-then-filter
  `X-WR-TIMEZONE:` scaffolding is gone.
- **One session, one meeting** (`scripts/cal-meetings.js`): the collect
  dedupe key dropped its label term. Canvas hardcodes `Class`, syllabus rows
  default `Lecture`, so a class listed by both sources put every session on
  the calendar twice; the old guard test passed only because its 00:00Z
  fixture crossed midnight into a different local date. New test drives the
  genuine collision: one row, Canvas wins the slot, the topic merges.
- **No phantom occurrences** (`scripts/sync-calendar.js`): weekly recurring
  ops (office hours, the weekly-meeting fallback) now anchor DTSTART on the
  first date their BYDAY actually names — clients render DTSTART as an
  occurrence, so a M/W/F rule anchored on the Tuesday the window opened
  painted an office-hours block on a day it never happens. User-checkpoint
  markers now hash the parent's due date (as auto-prep already did), so a
  moved deadline updates the routine's event instead of matching-and-skipping
  forever.
- **The merge defends itself** (`canvas-tasks.js`): a stale FIRST covered id
  no longer flips an item to `syllabus` while swallowing the live rows behind
  it (resolution now picks the first id Canvas still HAS); an item whose row
  was deleted-and-recreated under the same name now merges with the live row
  by title instead of suppressing it with a link-less AI-added ghost carrying
  the mined date; merged items carry the RESOLVED row's id so the panel's
  claim-follow lands. The assignment route resolves through `tasksForClass`
  itself now, so panel origin can never disagree with the task list (2.13).
- **Ticks survive the nav** (`bridge/public/app.js`): `seedCalDone` carries a
  session-pending overlay across refetches, so Calendar → Classes → Calendar
  inside the rebuild debounce no longer redraws a SAVED tick as unchecked
  (2.2/2.4's failure mode via the nav path). Home's Coming up finally honors
  ticks — it filtered `CAL_DONE` by `op.marker`, a key format the set never
  holds; it keys on `calDoneKey` now. Show-completed survives an all-ticked
  window (2.5: the one control that resurrects a mis-ticked item no longer
  hides with the toolbar). The Status anchor no longer trips the view
  switcher (a Cmd-click left the origin tab an empty shell). `slugOf()` is
  gone — 2.11 finished: every consumer reads the server-shipped `slug`.
- **Deleted classes leave the calendar** (`bridge/server.js`):
  `/api/classes/cleanup` now spawns the worklist rebuild its own comment
  promised — the rebuild IS the event-removal mechanism, so cleaned-up
  classes' events used to squat in every subscribed .ics until an unrelated
  rebuild. Class-card `taskCount` also goes through `tasksForClass` now, so
  the card and the detail view count the same work.

Not driven in a browser this session — every fix above is locked by unit
tests instead (new: stale-covered-id, recreated-row, two-source collision,
deadline-block direction, TEXT escaping, off-stage state, excused-drop,
exam-vs-deliverable, prune safety, selection scope). Suites at this note:
`bridge/` **282 pass / 0 fail**, `scripts/` **572 pass / 0 fail**,
`canvas-calendar/` **8 pass / 0 fail** (its first tests beyond the planner).

**2026-08-25, last round — the audit's front-end tail.** The cross-model
audit's four remaining dashboard findings, verified and fixed: tick POSTs for
one item are now SERIALIZED per key with the latest intent winning (two
overlapping toggles could land out of order, leaving the server at the stale
state while the pending overlay pinned the newer one — a tick redrawn
unchecked on every reload, spec 2.2/2.4's failure mode through a new door);
"Select current term" picks the latest term at or before TODAY parsed from
the label, never merely the newest-id group (a preregistered next-spring
shell used to win); Show-in-Finder resolves the viewed file's OWN class
rather than the sidebar's last selection; and a slow class response can no
longer overwrite a faster later one (openClass sequence guard). server.js's
VERSION now derives from package.json instead of being a copy. Unit-suite
verified (bridge 284/284); not browser-driven this session.
