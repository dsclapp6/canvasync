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
| 2026-08-27 | "can you add more emphasis visually on all the different categories of items in the calendar?" |

Also standing, from the UI direction given 2026-08-24 13:08Z: **"simplify,
minimalistic, small features, soft colors, functional"** — and the cream palette
that superseded the old dark one.

---

## §1 — Three view modes

The calendar has exactly three interfaces, chosen by one segmented control, and
the choice persists across reloads.

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 1.1 | A `List / 2 days / Week / Month` segmented control sits in the calendar toolbar, ordered by span. | `document.querySelectorAll('[data-calview]').length === 4`, reading `list, twoday, week, month` | x | | |
| 1.2 | The chosen view is written to `localStorage.calView` and restored on reload. | Set Month, reload, `localStorage.calView === 'month'` and the Month button carries `.active` | x | | |
| 1.3 | **List view** is the current stacked-vertical list and keeps its own `Day / Class` grouping control. | With `calView=list`, `#cal-ops .cal-row` count equals the filtered op count, and the `[data-group]` control is visible | x | | |
| 1.4 | The `Day / Class` grouping control is hidden in 2-day, Week and Month view, where it has no meaning. | With `calView=week`, `getComputedStyle($('cal-group-seg')).display === 'none'` | x | | |
| 1.5 | **Week view** lays 7 days out side by side, Monday through Sunday, as 7 columns. | `getComputedStyle($('cal-week')).gridTemplateColumns` resolves to 7 track widths | x | | |
| 1.6 | **Month view** is a tiled grid: 7 columns wide, one tile per calendar day, whole weeks only (leading/trailing days of adjacent months shown but dimmed). | Tile count is a multiple of 7 and ≥ 28; `.cal-tile.adjacent` exists for a month that does not start on Monday | x | | |
| 1.7 | Week and Month each have `‹ prev`, `Today`, `next ›` controls, and a heading naming the period. The 2-day view has a heading and NO arrows — see 1.10. | Clicking `next ›` in Week advances the heading by exactly 7 days; `Today` returns to the period containing today | x | | |
| 1.8 | Opening the calendar lands on the period containing **today**, not on the first item in the worklist. | With `calView=week` on a cold load, the heading contains today's date | x | | |
| 1.9 | Switching views never loses the kind filter or the class selection. | Select one class + filter to Meetings, switch List→Week→Month→List, both still applied | x | | |
| 1.10 | **A `2 days` view shows today and tomorrow**, reusing the Week view's geometry with two columns instead of seven — against the clock or stacked, following the same `Times` toggle Week uses (§9.1, reversed by the user 2026-08-31). | `calView=twoday` renders `.cal-week.timed` with `--daycols:2`; `gridTemplateColumns` resolves to a gutter plus 2 tracks; at a 1200px grid each day column measures 577px against Week's 164.9px | x | | |
| 1.11 | **It is not steerable, and draws no control that would be.** The range is derived from today, never from `CAL_ANCHOR`, so it cannot be parked on a stale pair; there are no prev/next arrows, and `stepCalPeriod` refuses. | `twoDayDays()` reads `localTodayIso()` and never `CAL_ANCHOR`; the period strip in this view renders a `.period-label` and zero `[data-cal-step]`; the heading reads e.g. `Mon 8/31 – Tue 9/1` | x | | |
| 1.12 | **Tomorrow is shown even when it is empty** — the view has to be able to answer "is tomorrow clear?", and a range that skipped an empty day would make an empty day and a hidden day identical. Day columns keep their heads with nothing in them. | `twoDayDays()` does not consult the ops at all; with no ops on either day both `.cal-daycol` heads still render, and a globally empty calendar names its cause through `calEmptyReason` as in the other three views | x | | |
| 1.13 | **A pileup is drawn side by side here where the Week view would stack it**, because two columns are wider than seven — but only when the window is actually wide enough for it. This row originally read "the lane budget follows the column width" while the code keyed off the day COUNT, which is the same claim §9.16 had to correct: at 375px both views sit at the 120px column floor. | `renderCalendarWeekTimed` allows a ceiling of 4 when `days.length <= 2` and `MAX_LANES` (2) otherwise, and `laneBudgetFor` lowers it to what the measured width affords: 4 lanes at 144px each on a 1200px grid, 2 at 81.75px on a 375px one | x | | |

**Measured 2026-08-24.** 3 `[data-calview]` buttons. `calView` persisted and
restored across a reload (`week`). List: 240 `.cal-row` for 240 ops, group
control visible. Week: `grid-template-columns` = 7 tracks, heads `Mon 24 … Sun
30`, group control `display: none`. Month (August): 42 tiles, 42 % 7 = 0, 11
`.adjacent`, first tile a Monday, last a Sunday; October: 35 tiles. February
2027 — the month that starts Monday and ends Sunday — yields exactly 28 tiles
and 0 adjacent (`bridge/test/cal-grid.test.js`). `next ›` moved `Aug 24 – 30,
2026` → `Aug 31 – Sep 6, 2026`. Cold load with `calView=week` opened on `Aug 24
– 30, 2026` with today's column marked once. The class-filter portion was
re-measured after the 2026-08-26 selection change: BUSI 305 + Meetings survived
List→Week→Month→List with 16 / 1 / 2 / 16 items and 0 items from any other
class in any of them (see §6.10–6.15).

## §2 — Task control inside the calendar

This is the "full functionality control" ask. It must hold **in all four
views**, not only in List.

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 2.1 | Every deadline item (`calendar === 'due'`) renders a checkbox. | In each of the four views, `[data-cal-done]` count === the number of visible `due` ops | x | | |
| 2.2 | Ticking it POSTs `{done:true}` to `/api/class/:folderName/task/:taskId` and the row goes struck-through immediately, before the request returns. | Network shows the POST; the row gains `.is-done` synchronously | x | | |
| 2.3 | A failed POST puts the tick back and toasts. Nothing is left showing as saved that did not save. | Block the route, click, assert `checked === false` and a toast appeared | x | | |
| 2.4 | **`CAL_DONE` is seeded from the server on load**, so a tick survives a reload. | Tick an item, reload, the box is still ticked | x | | |
| 2.5 | A **done item can be un-done from the calendar** — a `Show completed` toggle re-renders finished work struck through and still checkable. | Tick an item, wait for the rebuild, turn on `Show completed`, the row is present, ticked, and un-tickable | x | | |
| 2.6 | The item **title is a button that opens the in-app assignment page**. | `[data-open-assignment]` count === visible `due` **+ `checkpoint`** op count in every view (2.12 made checkpoints openable); clicking one shows the assignment panel. **Scope the count to the calendar view** — 3.13 put the same control on the home Coming up list, so a document-wide `querySelectorAll` now over-counts by up to 8 | x | | |
| 2.7 | A **Submit link** goes straight to the Canvas submission URL, in the corrected `/quizzes/:id/take` form, and opens in a new tab. | Every `.cal-submit` href matches its op's `submit_url`; no quiz-backed row uses the `/assignments/` form | x | | |
| 2.8 | An item with **no URL says so** rather than rendering a dead control. | Those rows carry a muted `.cal-nolink` marker and no `<a>` — reading `AI-added` when 2.13 knows why, `no link` otherwise | x | | |
| 2.9 | Checkpoints are checkable too — they are the user's own prep blocks. | `[data-cal-done]` appears on checkpoint rows; ticking one round-trips | x | | |
| 2.10 | Meetings are **not** checkable and **not** openable, and must not render a dead checkbox or a dead link. | `.cal-row.meeting [data-cal-done]` count === 0 and `.cal-row.meeting .cal-title a[href]` count === 0 | x | | |
| 2.11 | The client must not re-derive the `folder` ↔ `slug` strip — `/api/classes` ships `slug`, so the join uses that. | `calFolder()` no longer contains a `/^[0-9]+-/` regex | x | | |
| 2.12 | **A checkpoint clicks in to the assignment it preps for** ("make it so all the check ins have click in", 2026-08-25): its title is the same in-app button a deadline has, and Canvas-backed parents put their URL on the op and in its description. | `[data-open-assignment]` count === visible due + checkpoint count in every view; clicking a prep block's title opens the parent's panel with its Canvas Open/Submit links; every checkpoint op whose item has a live Canvas row carries `url` | x | | |
| 2.13 | **AI-added work looks different from actual work** ("so I dont stress trying to figure out what to do/submit for an assignment that isnt actually a submitted assignment", 2026-08-25). Every due op carries `origin: 'canvas' \| 'syllabus'`; syllabus rows get a dashed edge, an italic title and an `AI-added` pill in all four views and the task list; the assignment panel states it in a sentence and hides Open/Submit. | `.cal-row.ai-added` count === due ops with `origin === 'syllabus'`; each carries `.cal-nolink.ai`; `.task.ai-added` matches items with `origin === 'syllabus'`; panel shows `.notice.ai-added` for a syllabus item and never for a Canvas-backed one | x | | |

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

## §3 — Looks and behaviour, in all four views

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 3.1 | Each class has one colour, visible on every one of its items in every view. | Every row/chip has a non-empty `--class-color`; no two of the 6 classes share one | x | | |
| 3.2 | Class chips select which classes are drawn, across all four views. Same selection semantics as the kind chips — see §6.10. | Select BUSI 380: every other class's op count drops to 0 in List, Week and Month | x | | |
| 3.3 | The kind filter (`All / Due / Checkpoints / Meetings`) applies in all four views. | Filter to Meetings in Month view: every chip rendered has `calendar === 'meeting'` | x | | |
| 3.4 | **Today** is visually marked in Week and Month. | `.cal-daycol.today` / `.cal-tile.today` exists exactly once when the period contains today | x | | |
| 3.5 | Overdue deadlines are marked; **past meetings are not**. | A past meeting row has no `.overdue` class | x | | |
| 3.6 | Cream palette, soft colours; states are shown in **ink weight, not opacity**. | No `opacity` rule on a done/off state in `style.css` outside genuinely disabled controls | x | | |
| 3.7 | **No horizontal overflow** at 375px, 768px and 1280px, in all four views. | `documentElement.scrollWidth <= clientWidth`, 9 combinations | x | | |
| 3.8 | A Month tile holding more items than fit shows `+N more`, and clicking expands that day. | A tile with 4+ items shows the marker; clicking expands | x | | |
| 3.9 | Keyboard reachable: every checkbox, title button and view control is tabbable. | No `tabindex="-1"` or `disabled` on an interactive calendar control | x | | |
| 3.10 | Empty states say which filter emptied the view. | Select a class + a kind it has none of: the message names that cause and the way out | x | | |
| 3.11 | **Every dated item states its distance and grades it by urgency** ("include the number of days/weeks until its due… g/y/r system or something… pick whatever is the cleanest", 2026-08-25). One vocabulary (`relPhrase`: days inside two weeks, weeks beyond) and one ladder (`dueTier` → `.due-rel`: muted → amber `soon` ≤7d → brick `now` ≤1d → bold brick `overdue`) across the task list, checkpoints, home Coming up, the assignment page, and List-view day headings. Done items are never loud; day headings only grade when the day holds unfinished non-meeting work; past days are history, not alarms. | `relPhrase`/`dueTier` unit-tested in `cal-grid.test.js`; every `.cal-day-head` carries a `.cal-day-rel`; 0 tiered rels under `.cal-day.past`, `.task.is-done`, `.cp-row.done`; a meetings-only day inside the week has no tier; `--warn` ≥4.5:1 on ground/panel/sunk | x | | |
| 3.12 | Category is visually distinct from class ownership: class colour stays on the item edge, while kind colour marks the ITEMS — list rows, grid chips, dense collision stacks. **The kind filter row carries no colour at all**: a label, a count, and a frame. **Ruled twice by the user** — first *"there is too much going on with different colors on the calendar with the meetings vs. office hours vs. hw, etc. labels at the top"*, and of the compromise that moved the hue into a 7px dot, *"you didnt fix the colors they are all still there."* Colour on an item answers "what kind is this?"; colour on a control was decorating the control. The class chip row keeps its swatches — those map to the column and edge colours in the grid, and the complaint named the kind labels. | A reading and a homework item from the same class share a class-colour edge but carry different kind bands/labels in List, Week and Month. On the default filter row (an empty selection means everything, so every chip is selected): 8 label colours, 8 tinted backgrounds, 8 border colours and 8 dots before; 1 / 1 / 1 and no dot at all now, with `::before` computing to `content: none`. `--kind-color` is no longer DEFINED for any `.filter-chip` selector, so a future rule cannot reach a hue that is merely unused. On/off is solid+ink vs dashed+muted; computed opacity 1 throughout (§3.6) | x | | |
| 3.13 | **Coming up clicks in to the ITEM, not the class that contains it** ("click in", the user's own word for it). The home list uses the SAME `calItemModel`/`calTitleHtml` resolution the calendar rows and chips use, so the two surfaces cannot disagree about one op, and it resolves through the op's own `url`/`origin` rather than by matching titles. A row whose item has no page of its own still opens the class — nothing in a row is a dead click. | All 8 real Coming up rows render `[data-open-assignment]` carrying the item id and its folder — including the ENTR 222 prep block (2.12) and syllabus-mined ECON 205 work, which opens the in-app page that states there is nothing to submit (2.13) rather than a manufactured Canvas URL; an op with no id and no url renders TEXT, never an empty `<a>`; a click on a row control does not also open the class behind it | x | | |
| 3.14 | **Every dated Canvas row is its own calendar item — an AI aggregate may enrich, never swallow.** Ruled 2026-09-01: *"a lot of assignments, just regular ones in canvas like quizzes, arent showing up at all. make sure that EVERYTHING is showing up."* Mining had bundled 32 dated BUSI 380 quizzes into 8 "Session N Concept Check" items; each bundle emitted one op carrying one member's id, so 24 dated rows had no representation and 8 wore the aggregate's title. Now an aggregate reaching TWO OR MORE LIVE Canvas rows releases them: each surfaces with its exact Canvas title, own `html_url`/`submit_url`, points and due parts, inheriting the aggregate's `weight_note` and a `Part of: <aggregate>` provenance line; the aggregate itself emits nothing (double-booking is the failure the old rule guarded, and it stays guarded). Same ruling, second half: **stored titles are never truncated** — `clip()` is gone from `cleanItemTitle`/`dueTitle`/`prepTitle`/`checkpointTitle`; the two survivors (meeting and office-hours titles, SYNTHESISED strings, not names anyone typed) are disclosed in canvas-tasks.test.js/cal-names.test.js rather than silent. Display layers ellipsize; data does not. | Audit over real data: dated Canvas assignments visible as their own item 70/94 → 94/94, hidden 0; stored titles ending "…" 85 → 0; fixture worklist Sep 1 shows 7 individual S2a ops where 1 bundle stood; `.cal-collision` expands to 7 chips each with `[data-open-assignment]` and a Submit affordance | x | | |

**Measured 2026-08-24.** 6 classes, **6 distinct colours** (`#3E6B8A #7A5C3E
#4E7A5B #8A4F5C #5C5A8A #8A7136`). Filtering to Meetings left 0 non-meeting items in all three. Today
marked exactly once when in the period, **0 times** when the grid was moved off
it. 106 meeting rows, **0** with `.overdue`. Overflow: 9 of 9 combinations gave
`scrollWidth === clientWidth`; at 1280 both grids fit without scrolling at all.
`+3 more` on 2026-10-01 expanded 3 chips → 6 and became `show less`. 13
interactive controls, **0** untabbable.

**3.2 and 3.10 re-measured 2026-08-26**, after the class chips became a
selection (§6.10–6.14). The class-hiding sentences of the 2026-08-24 note above
described the superseded model and were removed rather than left to read as
current; the numbers that did not depend on it stand. Selecting BUSI 305 and
filtering to Meetings gave 16 rows / 1 / 2 / 16 across List→Week→Month→List with
**0** items from any other class. The "Every class is hidden" message is gone
because that state is now unreachable; the reachable empty state (ENTR 222 +
Exams) prints "Nothing from the selected classes in this window — deselect one
above to widen the view." It does not say "lit chip": a selected class chip is
drawn plainly and the *unselected* ones carry the dashed, struck `.off`
treatment, so "lit" would have named a mark the class row does not make.

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
| 4.6 | Explicit dated readings must not depend on a model choosing to emit them. The calendar unions a deterministic syllabus reading index and schedules dated items even if a model also marked them recurring. | Real-data dry-run: 39 reading ops (ECON 205 1, BUSI 305 15, BUSI 380 23), 0 unscheduled readings | x | x | x |
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

**Re-measured 2026-08-26 after 4.6 was fixed at the source.** The model output
still contains only one reading, but the source files do not: BUSI 305's parsed
schedule has 15 dated Pre-class Reading rows and BUSI 380 has 23 dated session
blocks with explicit Read/Skim instructions. `readings_index.json` now treats
those stated facts as a deterministic floor, with the newest extracted
syllabus providing a raw-text fallback if the structured parse misses a dated
block. A write-free build against the real six-class root produces **39 reading
ops** (1 + 15 + 23) and **0 unscheduled readings**. The older zero above is kept
as the measurement that exposed the failure, not as current behavior.

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

### §6.10–6.14 — the class chips run on this same selection

Added 2026-08-26. The user's words: *"make it so the class selectors in the
calendar page behave the same as the categories; all selected by default, if one
(or more) is selected it should only show selected ones."*

The class chips were the last inverted control on the page: a **hidden set**
(`localStorage.calHidden`) where clicking a chip turned a class *off*, with a
`show all` link to undo it. Two controls one row apart with opposite polarity —
the kind chips select what you want, the class chips deselected what you did
not — and only one of them could empty the calendar. Both are now the same pure
`nextSelection()` / `isSelected()` pair from `bridge/public/cal-plan.js`.

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 6.10 | The class chips are a **selection**, not visibility switches. Nothing selected means every class, and every chip is lit. | Cold load with no `calClassSel`: 6 chips lit, all classes drawn | x |  |  |
| 6.11 | Selecting one or more draws **only those** classes. Clicking the only selected chip goes back to everything. | The §6-style sequence below | x |  |  |
| 6.12 | **No sequence of clicks can select no classes.** | Exhaustive sweep over all 2⁷ selections × 7 chips in `cal-plan.test.js`, asserting at least one class always shows | x |  |  |
| 6.13 | There is **no `show all` link** — 6.11 is what it was for. | `[data-cal-show-all]` count === 0 | x |  |  |
| 6.14 | **Every drawn item answers to exactly one chip.** An op with no class is the `Personal` chip's, so no item can be filtered out by a control that does not list it. | Inject a classless op — **future-dated and not a meeting**, or the past-meeting filter masks what you are testing (see the trap note below) — then: it draws by default, hides when another class is selected, and returns when `Personal` is | x |  |  |
| 6.15 | **A click resolves against the chips on screen, not a stored superset.** A slug the chips no longer offer is pruned out of both the drawn selection and the click transition, so it cannot survive a "deselect the last one" as an invisible residue. | Store `['busi-305','a-class-that-graduated']`: one chip draws selected, and clicking it returns to all six with `calClassSel` === `[]` | x |  |  |

**Measured live 2026-08-26**, on a fixture bridge (`:3849`) over the six real
classes, worklist of 354 ops:

```
default (nothing selected)   6 chips lit   354 items across 6 classes
click BUSI 305               1 chip lit     56 items across 1 class · 298 hidden
click ECON 205  (adds)       2 chips lit    76 items across 2 classes
click ECON 205  (removes)    1 chip lit     back to BUSI 305 only
click BUSI 305  (the last)   6 chips lit   354 items across 6 classes
```

`calClassSel` ends `[]`, which is the default rather than a stored state. The
selection survived a reload and the List→Week→Month→List cycle — 16 / 1 / 2 / 16
items with BUSI 305 selected and Meetings filtered, **0** from any other class in
any view (§1.9, §3.2).

**`User` ticks rest on the served bytes**, the same evidence §5 uses: the user's
Electron app runs `canvas-sync/bridge/server.js` out of this checkout and
`express.static` reads per request, so `sha256(bridge/public/app.js)` on disk and
`GET :3847/app/app.js` are the same
`246f5b1b1c484f057dd06baa0a3bb0953f32ecf2fcfcee3fb60f609a5646be76` — their app
shows this after ⌘R with nothing else to install.

**The old key is retired, not migrated.** A `calHidden` holding two hidden
classes is *deleted* on first load and the user lands on everything-showing.
Migrating it (hidden → "select the other four") would have been faithful to the
old state and wrong for the request: the user asked for all-selected-by-default,
and inheriting a filter they set under opposite polarity would open the calendar
already narrowed with no memory of why. Verified live: `calHidden` seeded with
`["busi-305","econ-205"]` was gone after one load and all 6 chips were lit.

**6.14 is the one this change created.** Under a hidden set a classless op was
always drawn — nothing was hiding it. Under a selection it is drawn only if its
slug is selected, so an op whose slug had no chip would have vanished on the
first class click with no control able to recover it: a filtered-out item with
no filter to un-set. `opClassSlug()` maps a falsy class to `PERSONAL_SLUG` (the
same mapping `customRenderOp()` already applied to classless custom items) and
`chipRowsSource()` lists the `Personal` chip when any classless *op* exists, not
only a classless custom item. No such op exists in the current worklist — all
354 carry one of the six slugs — so this is a hole closed before it was fallen
into, verified by injecting one.

**6.14 and 6.15 `User` are blank on purpose.** Both were driven on the fixture
bridge from a state constructed by hand — an injected classless op, and a stored
selection holding a departed slug. Neither exists on the user's bridge, so there
is nothing there to observe. Both are `Built` and `Live`; a `User` tick would be
a tick for something unobservable.

**6.15 is the defect an adversarial pass found in my own first cut.** The read
path pruned and the write path did not, so with `['busi-305', 'a-departed-class']`
stored, only BUSI 305 drew as selected — but `nextSelection()` saw a two-member
selection, so clicking that one chip did not read as "the last one". It returned
`['a-departed-class']`: the calendar correctly showed everything (an all-stale
selection prunes to "everything"), while the stored state quietly held a filter
the user had just cleared and could not see, ready to re-narrow the calendar by
itself the day that class came back. Handler and display now resolve against the
same pruned list. `pruneSelection()` lives in `cal-plan.js` — pure, no DOM — for
the reason the rest of that file exists: `app.js` exports nothing and cannot be
imported by `node --test`, so logic that is only reachable through the page is
logic no test can hold. The first version of this test asserted on a value its
own inline filter had computed two lines earlier, which proved nothing about the
code under test; that is what moving the function fixed.

**What the class chips do NOT filter.** The `Meeting times` list
(`renderCalMeetTimes`) still renders every in-scope class and its summary still
counts all of them — measured at "Class times · 3 not set" with a single class
selected. It is the control that *repairs* a class whose time is missing, and
three of the six real classes state no time anywhere on disk; hiding the repair
behind the filter would make a wrong class time unfixable. Deliberate
asymmetry, recorded so it is not "fixed" later.

### §6.16–6.21 — the AI-added toggle, and which control gets blamed for an empty view

Added 2026-08-26, adopted from an ended session and verified before landing (its
author's session closed with the work uncommitted and unspecified). Provenance
itself is not new — §2.13 already marks AI-mined items — but until now there was
no way to *stop drawing* them.

It is a binary toggle, not a selection, and deliberately so: AI-added is
orthogonal to kind and class. An AI-mined reading and a Canvas-backed reading
share a kind, so hiding the former through the kind chips would take the latter
with it. `isAiItemVisible()` is therefore its own filter stage, and non-AI items
pass it unconditionally.

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 6.16 | An `AI-added` chip carries the count of mined items and toggles them in every view. | Chip reads `AI-added 78`; clicking it drops the list from 341 to 263 | x |  |  |
| 6.17 | The choice persists across reloads, like every other calendar control. | Toggle off, reload: `localStorage.calShowAiAdded === '0'`, `aria-pressed="false"`, 263 items | x |  |  |
| 6.18 | **A filter for an empty category is not drawn.** With no AI-mined items at all, the chip does not exist. | Strip every `origin: 'syllabus'` op from the worklist: `[data-ai-added-filter]` count === 0, while 7 kind chips and 6 class chips still draw | x |  |  |
| 6.19 | The summary **attributes** what it withheld, per cause. | With AI off and past hidden: `91 hidden (78 AI-added, 13 past schedule)` | x |  |  |
| 6.20 | **Each empty view names the control that emptied it** — never a control that is innocent. AI-emptied says AI; past-emptied says past; otherwise the class chips. | `reading` is 100% AI here (33/33): AI off + Readings gives 0 rows and "All matching items are AI-added…", not the class message | x |  |  |
| 6.21 | The chip's off state is said in **ink, not opacity** (§3.6). | `getComputedStyle` on the chip: `opacity === '1'` in both states; off is `color: rgb(98,108,100)` with a lighter rule, on is `rgb(36,72,61)` | x |  |  |

**Measured live 2026-08-26** on the fixture bridge (`:3849`), six real classes:

```
default (AI shown)          chip "AI-added 78"   341 items · 13 hidden (13 past schedule)
click AI-added (off)        aria-pressed=false   263 items · 91 hidden (78 AI-added, 13 past schedule)
reload                      still off            263 items, calShowAiAdded='0'
AI off + Readings only                             0 items · 33 hidden (33 AI-added)
AI on  + Readings only                            33 items
worklist stripped of AI                            chip absent, 7 kind + 6 class chips still drawn
```

**6.20 needs no precedence rule, because the branches are disjoint by
construction.** `hiddenPast` is computed from `selectedOps`, `selectedOps` from
`byOrigin`. The AI branch is guarded by `!byOrigin.length`, and when `byOrigin`
is empty `selectedOps` is empty, so `hiddenPast` is necessarily `0`. The two
messages therefore cannot both be eligible, whatever order they are written in —
this is a property of the filter chain, not a choice about which to prefer, and
it should not be "fixed" later by reordering the ternary.

**The past-items branch is the defect this adoption surfaced.** The past filter
runs *after* the class filter, so before this row existed a view emptied by
hidden past meetings fell through to the class message and told the user to
deselect a class that was in fact selected and did have items — they were merely
behind. That is a 3.10 violation: it named an innocent control. Verified by
injecting a class whose only two ops are past meetings, selecting it, and
reading back "Everything here has already happened — turn on past items above to
show them." with `0 items · 356 hidden (2 past schedule)`; the injected data was
then removed and the fixture restored to 354 ops.

**`User` is blank across 6.16–6.21 on purpose.** At the time of writing this
feature is uncommitted and is being staged by another session; nothing has
reached the user's bridge, so a `User` tick would be a tick for something
unobservable. 6.18 additionally was driven against a deliberately stripped
fixture worklist, a state the user's own data does not have.

**Adoption note.** `.filter-chip.ai-filter:not(.on) { opacity: .72; }` shipped in
the inherited working copy and violated 3.6 — an off-state opacity rule on a
control that is not disabled, against a convention the stylesheet states in its
own voice twice (`style.css`: "On, in ink weight and a border — never opacity",
and "ink says off, not opacity" above `.class-chip.off`). Replaced with the
muted-ink treatment `.filter-chip.empty` already uses. The dashed border is
kept: it echoes the `.ai-added` provenance idiom, so the control looks like the
thing it governs.

**Re-verified 2026-08-29 at HEAD `9b9e8b9` (v1.8.3).** v1.8.2 landed four
formatting fixes touching `bridge/public/app.js` (`fmtTimeSpan`, `calPoints`,
`calUrl`) and a render-neutral removal of dead declarations from `style.css`.
Under rule 3 that voided every `Live` tick on the rows those two files serve, so
§6.10–6.15 and §6.16–6.21 were driven again rather than assumed. All rows hold;
nothing changed but the numbers, and those moved because the worklist is now
**311 ops** rather than the 354 of 2026-08-26. The blocks above are left as the
dated records they are — a spec that rewrites its own history stops being
evidence.

```
class chips   default 6 lit / 298 items · BUSI 305 -> 59 · +ECON 205 -> 63
              -ECON 205 -> 59 · deselect the last -> 298, calClassSel []
              [data-cal-show-all] === 0
AI toggle     chip "AI-added 73" · toggle 298 -> 225 · reload keeps it (calShowAiAdded '0')
              summary "86 hidden (73 AI-added, 13 past schedule)"
              AI off + Readings (39/39 AI) -> 0 rows + the AI message; AI on -> 39
              AI ops stripped -> 0 ai chips, 7 kind + 6 class chips still drawn
              opacity '1' in BOTH states; on rgb(36,72,61), off rgb(98,108,100)
6.14          classless op draws by default, hides under another class, returns via Personal
past branch   past-only class -> 0 rows, "Everything here has already happened…"
```

`app.js` and `style.css` were clean in the working tree at drive time — only
Codex's in-flight `scripts/` work was dirty — so this exercised the committed
bytes, not a local variant.

**A trap in driving 6.14, recorded so the next person does not lose an hour to
it.** The first pass of this re-drive showed the classless op *not* drawing, and
it looked like a regression. It was the fixture, not the product: the injected op
was cloned from a meeting and inherited that meeting's date, `2026-08-24` — in
the past — so the past-meeting filter removed it before the class filter was ever
consulted. The row under test says nothing about dates, which is exactly why the
wrong date is easy to miss. Re-dated to `2026-10-15` and typed `homework`, the
row passed on the first attempt. An injected op for 6.14 must be future-dated and
non-meeting, or you are testing `hiddenPast` while believing you are testing
`opClassSlug`.

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
evidence. `User` waits until this runs on the app-owned bridge.

**Re-driven 2026-08-26 on `c8df6cf`**, whose audit fixed four defects in this
feature — so the rows were re-checked rather than left ticked on the strength
of a drive that predated the fixes (rule 3). Each fix, exercised against the
six real classes:

| Fixed | Driven |
| --- | --- |
| `saveMeetEditor`'s `!res.ok` branch was unreachable (`api()` throws), so a rejected save read `Saving…` forever | End 13:00 before start 14:00 → editor prints the server's own reason, stays open, keeps the typed days and times |
| A background rebuild tick repainted the open editor once a second | Saved on ECON 205 to start the poll, then typed into BUSI 380's editor mid-poll: `09:25`, a typed room and a newly ticked `FR` all survived 4+ ticks |
| A failed undo left its button disabled and dead | Deleted the stash behind the UI, clicked undo → 409, button re-enabled, toast `nothing to revert`, refetch dropped the stale control |
| Clearing an *unreadable* override left an older stash as the undo target | Corrupted the override, `DELETE` → stash becomes `previous: null`, so undo offers `back to the syllabus` and not a state the user never left |

That first fix made the error path reachable for the first time, which
immediately showed it was speaking the wrong language: it borrowed
`validateOverride`'s **load-path** warnings, so a student who typed an end
before a start was told `meeting_override.json: … — keeping the days only` —
a file they have never heard of, and a salvage a rejected save never performs
(it keeps nothing). The write path now states its own terms and separates the
two failures the load path collapses: `the end time has to come after the
start time` vs `a start and end must be times on a 24-hour clock, like 14:30`
— told the former about `25:00`, a user checks the one thing that is not
wrong. Pinned by `a rejected save explains itself in the words of someone
typing…`, which asserts the copy AND the two rules behind it (never name an
internal file, never claim a salvage that did not happen) — a looser
assertion would have passed the very message that caused this.

Suites at this note: `scripts/` **585 pass / 0 fail**, `bridge/` **291 pass /
0 fail** — measured at `cc57f03`, which touches no `bridge/` file, so the
number is unchanged from `c8df6cf`.

**Measure `bridge/` with `npm test`, not with a bare `node --test`** — the
two always differ by exactly one, and the extra one is not a test. This line
read 292 briefly and two sessions disagreed about it, so the cause is written
down rather than the count: a suite count is one of rule 4's checkable
numbers, and a right number with a wrong explanation attached still sends the
next reader somewhere there is nothing to find.

`npm test` runs `node --test test/*.test.js`. A bare `node --test` uses
Node's own recursive discovery, which treats **every `.js` under a `test/`
directory** as a test file — so it also loads `test/helpers/server-factory.js`,
which defines no tests, and counts that file itself as one passing test. The
gap is discovery, not content, so it holds at any count (291/292 at `cc57f03`,
311/312 at `7ec8fef`) and is reproducible on a clean tree:

```
node --test --test-reporter=tap test/*.test.js   # what npm test runs
node --test --test-reporter=tap                  # exactly one more
comm -23 …   →   # Subtest: test/helpers/server-factory.js
```

So a count one higher than expected is **not** evidence of a stray scratch
file in `bridge/test/`; looking for one finds nothing. `scripts/` has no
`test/helpers/`, and both commands agree there (600 at `7ec8fef`).

**A stray file inflates the count too — a different mechanism, same symptom.**
The glob `test/*.test.js` matches ANY file named that way, so a scratch probe
left in `bridge/test/` is counted by `npm test` itself (it would also be found
by the bare form; that is why it cannot explain the one-test gap above). This
is not hypothetical: review agents write probes there, and `bridge/ 312` in
`05df819`'s commit message is one — the real count at that commit is **311**,
measured after removing `zz-concurrency-probe.test.js`. Before quoting a
suite count, run `git status --porcelain` and make sure nothing untracked is
sitting in a test directory. Two ways to be wrong about this number have now
been found the hard way, one per session; the fix for both is the same, which
is to measure on a clean tree and say which command you ran.

## §8 — The calendar is something you can write on

Added 2026-08-26. The user's words: *"add calendar item adding function by
either selecting a section on the cal like with apple cal, or by using an add
function. Also make calendar items draggable so I can move them around. Make
sure this doesnt break functionality of just clicking into them. also allow
extending them by dragging an edge in either direction. Make the cal item add
functionality pretty thorough; it should ask what class to add, or if to put in
'personal' cal as independent item. and then make it so it presents similarly to
all the other cal items where there is a desc in them. also add 'notes' where
user can add info to any assignment or calendar items descriptions on the
clicked-in page."*

Until now every item on this calendar was DERIVED — mined from a syllabus, read
from Canvas, or generated from a meeting pattern — and the only thing the user
could do to one was tick it off. This section is the calendar becoming
writable.

**"Make sure this doesnt break functionality of just clicking into them" is the
load-bearing sentence,** and row 8.4 is where it is measured. Every control the
previous seven sections built — the checkbox, the title that opens a page, the
Submit link — sits *inside* the thing that is now draggable.

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 8.1 | Two ways to add: a `+ Add` button in the toolbar, and dragging across empty space in Week or Month, which opens the editor with those dates already filled in. | `#cal-add` exists; a drag from one day's blank area to another opens the dialog with `date`/`end_date` set to the ends of the range, in either drag direction | x | x | |
| 8.2 | The editor asks **what class, or personal** — one select listing every synced class plus `Personal (no class)` — and carries a title, a date, an optional end date, optional start/end times, and a notes field that becomes the item's description. | The select holds `1 + CLASSES.length` options; a saved item filed under a class wears that class's colour and code, one with none wears the reserved `personal` slug | x | x | |
| 8.3 | An added item **presents like every other item**: the same row in List, the same chip in Week and Month, a checkbox, a click-in page, and its description where the others carry theirs. | An added item's row is `.cal-row.custom` with a `[data-cal-custom-done]` checkbox and a title button; its kind chip reads `Added by you` | x | x | |
| 8.4 | **Dragging never costs a click.** Nothing happens until the pointer has moved 4px; under that the gesture is a click and reaches the control untouched. Over it, the click the browser synthesises at the end of the drag is swallowed once, so dropping on a title does not also open it. | Click a chip title → its page opens and nothing moves. Drag the same title 200px → the item moves and the page does NOT open. Both, in Week and in Month | x | x | |
| 8.5 | **An edge drags in either direction.** The two ends of an item the user added carry grab handles; dragging the end edge later or the start edge earlier stretches it, and dragging either past the other is refused rather than silently inverting the item. | `resizedDates` unit-tested in both directions incl. the refusals; live, an item stretched across days renders as ONE bar (`.span-start`/`.span-mid`/`.span-end`) and stores `end_date` | x | x | |
| 8.6 | **Notes on anything with a page.** An assignment's notes live on its panel above the description; an added item's live in its editor; a lecture's or an office-hours block's live on a small page of its own, keyed on the marker prefix so the note survives a date correction. Every note reaches the calendar event's description. | Type a note on an assignment → `user_state.json` holds it, the due op carries `note`, and the `.ics` DESCRIPTION ends `Note: …`. Same for a lecture, filed under its `note_key` | x | x | |
| 8.7 | Only what is genuinely movable moves, and a refusal **says why**. A deadline drags (writing the same `dueOverride` the task editor writes); an item the user added drags and stretches; a user-written prep block drags. A lecture, an office-hours block and an automatic prep block do not — and trying tells you what does govern them. | Dragging a lecture toasts *"Class meetings come from the syllabus — change them under Class times."*; office hours and auto-prep get their own sentences; a click on any of them still opens its page silently | x | x | |
| 8.8 | Added items are the one thing on this calendar no rebuild can regenerate, so they live in their own file, are never written by `scripts/`, and get their own `.ics` a subscriber can colour apart. | `calendar/custom_items.json`; `personal.ics` in `ICS_FILES`; a multi-day timed item is ONE VEVENT spanning both days, not one per day | x | x | |
| 8.9 | Ticking an added item off obeys 2.5: it drops from the calendar but not from the file, and `Show completed` brings it back tickable. | Tick → the row goes; `Show N completed` → it returns struck and checked; un-tick → it is live again and `done: false` on disk | x | x | |
| 8.10 | An in-progress span is **not overdue**. A run of days is late only once its LAST day is past. | A span starting yesterday and ending tomorrow carries no `.overdue` | x | x | |

**Driven 2026-08-26** in a real browser on a fixture bridge (`:3851`) holding
the six real Fall 2026 classes — every class-root JSON copied so writes land in
the fixture, only `files/`, `materials/`, `AI_CONTEXT/` symlinked; torn down
after. Real pointer gestures throughout (CDP mouse input, not synthetic
events):

```
baseline                        271 ops — identical to the real worklist's 271
+ Add → BUSI 380 item           273 ops · counts.personal 2
drag Thu 8/27 → Sat 8/29        chip on 8/29 AND stored date 2026-08-29, 18:00 kept
drag end grip Sat → Sun         span-start + span-end, end_date 2026-08-30
click the same title            "Edit item" opens, all six fields prefilled
drag the same title 200px       item moves; dialog does NOT open  ← 8.4
select Mon→Wed on blank space   "New calendar item", date 8/24, end 8/26
drag a real deadline Thu → Fri  user_state.json: dueOverride 2026-08-28
drag a lecture                  toast: "Class meetings come from the syllabus…"
month view drag 8/27 → 8/29     stored 2026-08-29, time preserved
```

Counts after, on 273 ops: List **273 rows, 161 checkboxes, 74 Submit links, 38
AI-added, 0 dead meeting controls**; `[data-open-assignment]` **159 = 131 due +
28 checkpoints** — §2.6's invariant is untouched, and §2.10 still measures 0
checkboxes and 0 `<a href>` titles on meetings (their new click-in is a
`<button>` to a page that exists, not a dead link). Week: 7 tracks, today ×1.
Month: 42 tiles, 42 % 7 = 0, 11 adjacent, today ×1. Overflow: **12 of 12** at
375 / 768 / 1280 across all three views plus the dialog on a phone
(`scrollWidth - clientWidth = 0`, dialog 341px inside 375px).

`personal.ics`, unfolded:

```
UID:[csync:u|8809c30e-…|91164cf3]   SUMMARY:BUSI 380 · Study group — case prep
DTSTART:20260829T180000  DTEND:20260829T200000  TRANSP:OPAQUE
UID:[csync:u|5868df4f-…|cc5d1ea6]   SUMMARY:Conference
DTSTART:20260910T090000  DTEND:20260912T170000  TRANSP:OPAQUE
```

The second is the shape that made 8.8 worth stating: a conference from Thursday
morning to Saturday evening is **one** event, and an all-day span's `DTEND` is
the day AFTER its last (`20260824`→`20260827` for Mon–Wed), because an all-day
DTEND is exclusive and getting it wrong renders every multi-day item a day
short. `TRANSP:OPAQUE` because an item the user put there by hand is time that
is spoken for — the opposite of a deadline, which is a point and stays
TRANSPARENT.

**Three refusals worth keeping.** A timed item that runs over days must state
an end time — *"Friday 9:00 through Sunday"* names no end and every honest
rendering would have to invent one; the dialog prints the bridge's own sentence
and stays open. An item stretched onto a single day stores `end_date: null`
rather than a same-day span, so the stored shape has exactly one reading. And a
span past 60 days is refused at the store and degrades to its start day in the
grid, because a field that is wrong must not put a chip on every tile of the
month.

**What a keyboard can do here.** Dragging is a pointer gesture and has no
keyboard equivalent; the *outcome* does. Every date and time a drag can change
is a real form field in the item's editor, which is reached by the same
tabbable title button every other row has. The resize grips are decorative
(`aria-hidden`) for that reason: they are a second way to reach a control that
already exists, not the only way.

**Two bugs this drive caught before they shipped.** Office-hours ops are
written to the `meeting` calendar, so the `isMeeting` branch claimed them and
told the user to go and edit their class times — which is not where a
professor's office hours come from; the refusal now asks the KIND first. And
the refusal explanation was first wired to a *click*, so clicking a lecture to
open its notes page also toasted "you cannot move this" — it now fires when a
drag actually begins, which is the only moment the user has asked the question.

**A note on where spans sit.** `sortDayOps` now puts a multi-day run above the
appointments inside the day. Each column stacks independently, so this is the
only way the pieces of one span line up into one bar across a week — it is the
same reason every other calendar keeps an all-day row at the top.

Suites at this note: `bridge/` **311 pass / 0 fail** (cal-grid +7,
custom-items-route +10), `scripts/` **599 pass / 0 fail** (custom-items +15).

**Reviewed adversarially straight afterwards** — four lenses over the diff, two
independent skeptics per finding, default-to-refuted; 32 agents. Twelve
findings survived, and the two that matter most are worth recording here
because both are invisible to every count above:

- **A drag could un-tick work.** A prep block's date lives in a LIST that
  `patchTask` replaces wholesale, so moving one block sends every sibling
  back — and the list was read from `CURRENT`, the snapshot taken when the
  class was last opened. Ticking a prep block off *in the calendar* never
  touches `CURRENT`, so tick-then-drag-a-sibling echoed the stale
  `done: false` over the tick. The list is now re-read inside the queued
  write. This is 2.9's failure mode reached through a §8 gesture, which is
  why it is noted under both.
- **A tick and a drag of the same task were not serialized** — they queued on
  different keys while writing one JSON object. `taskWriteKey` now names the
  FILE (`folder|id`), and `calDoneKey` keeps naming the tickable THING
  (`folder|id|cp`), because a prep block is not its parent.

Also fixed: a refused drag delivered its click, so trying to drag a lecture
opened the lecture on top of the toast explaining why it would not move; a
cancelled drag could leave a click-swallower armed forever (pointercancel is
not a pointerup); `touch-action: none` made the month grid unscrollable by
touch, now `pan-y` since every gesture here is horizontal; the assignment note
debounce read the textarea when the timer fired rather than when the user
typed, so switching assignments inside 600ms filed one page's text under the
other's id; `renderCalendarOps` threw when items existed with no worklist yet;
`personal.ics` was written but never offered to a subscriber; and editing an
item belonging to an unsynced class silently re-filed it as Personal.

Suites after the fixes: `bridge/` **311 pass / 0 fail**, `scripts/` **605 pass
/ 0 fail** (the custom-items store gained concurrency tests in a parallel
session's 1bc383d, which fixed the same lost-update race this review's data
lens raised).

## §9 — The week against a clock, and a page with no filler on it

Added 2026-08-26. The user's words: *"have a toggleable item for showing
calendar time, which toggles horizontal time lines for each day & moves items
to when on that day they are due. this is only for week view."* And, of the
item page §8 built: *"remove all filler text in attached screenshot page, way
too much. CONCISE. concise everywhere. info should also all be editable in this
page."*

The two are one change. The page they were looking at spent four paragraphs
explaining that a class's hour was unknown and that the fix lived on another
screen — while the grid behind it had nowhere to put an hour even if you knew
one. Now the hour is a field on that page, and the week has a clock to show it
on.

| # | Requirement | Check | Built | Live | User |
| ---: | --- | --- | :---: | :---: | :---: |
| 9.1 | A `Times` toggle in the calendar toolbar, in **both column views** — Week and 2-day — persisted across reloads. It is hidden, not disabled, in List and Month, which have no scale to draw. **Reversed 2026-08-31 by the user:** *"2 week should also have the time toggle."* This row previously read "Week only… a 2-day view that could go untimed is List with two days in it", which was a defensible call and not ours to make once they had seen it built. | `#cal-times` is hidden in List and Month and visible in Week and 2-day; toggling writes `localStorage.calTimes`, survives a reload, and re-renders whichever column view is up | x | | |
| 9.2 | On, the week is drawn against a clock: hour lines across all seven columns, hour labels in a gutter, every timed item positioned and sized by its own hours. | `.cal-week.timed` exists; every `.cal-chip.placed` carries a `top`/`height` from its own time; the gutter labels run the window's hours | x | | |
| 9.3 | **One scale for the whole week.** Every column's clock starts at the same y and the same hour line runs straight across, whatever each day holds. | The 7 `.cal-slots` have one distinct `top`; the first `.cal-hourline` of every column has one distinct `top` | x | | |
| 9.4 | The window is computed from the data but never narrower than 8am–8pm, so one 2pm lecture does not produce a one-hour strip. | `timeWindow` unit-tested: `[]` and a single 2pm item both give 8:00–20:00; a 07:20 and a 21:45 widen it to whole hours | x | | |
| 9.5 | Things that are genuinely **not on a clock** — an all-day marker, a lecture whose hour the syllabus never stated, a multi-day run — go in a banner band above the grid, never at an invented 9am. | `opSlot` returns null for all-day, timeless and multi-day ops; they render in `.cal-allday` | x | | |
| 9.6 | Overlapping items sit **side by side**, and only the ones that actually collide. | `layoutDay` unit-tested: two overlapping get lanes 0/1 at 50%; an unrelated 4pm item keeps the full width; items that merely touch do not split | x | | |
| 9.7 | Turning Times on changes nothing else: clicking still opens, dragging still moves, and List and Month are untouched. | In the timed grid, a click on a chip's title opens its page and moves nothing; a drag moves the item to the new day and keeps its time; the toggle is absent in the other two views | x | | |
| 9.8 | The item page carries **no explanatory prose**: a heading, one meta line, the topic, the fields, the notes. | The BUSI 380 lecture page holds 3 `<p>` and ~250 characters total, against ~700 of generated paragraphs before | x | | |
| 9.9 | **Its information is editable there.** A lecture's days, start, end and room are fields on the page, and saving them writes the class's own override. | Set 13:00/14:15/Virani 182 on a BUSI 380 lecture and Save: `/api/class/…/meetings` reports `source: override`, and the rebuilt worklist carries the time on that class's sessions | x | | |
| 9.10 | Saving a note must not silently stamp a times override the user never touched. | `meetTimesChanged` compares against the stored pattern; a Save that only edited the note sends no meetings POST | x | | |
| 9.11 | Office hours say nothing they cannot do. They have no override store, so their page shows their facts and a note, and offers no time fields at all rather than dead ones. | An office-hours op's page renders no `[name=start]` | x | | |
| 9.12 | **A pileup stays usable.** Two overlapping items remain side by side; a cluster becomes one count-and-time stack when three or more share the exact same slot **or when it would need more lanes than the column can afford** (§9.16 — `MAX_LANES` is the ceiling on that number, not the number itself) — four items starting together with different end times evaded the exact-slot rule and rendered as ~44px slivers. Opening it reveals every ordinary full-width chip with its checkbox, title, Submit link and drag behaviour intact. | `partitionDenseSlots` unit-tests the 2/3 boundary; the real seven BUSI 380 deadlines at Tue Sep 1 2:30 PM render as `7 due · 2:30p`, then expand to 7 chips / 7 checkboxes / 7 title buttons | x | | |
| 9.13 | **An ordinary chip places by NAME, so an optional child cannot shift the row.** All-day chips omit the time; nothing else may move because of it. | `.cal-chip[data-kind]` declares `grid-template-areas: "check kind title action"`; measured at a 176px column an all-day chip's `scrollWidth === clientWidth` (168/168) and its marker is 18.3px, not the 4px it collapsed to under the five bare tracks | x | | |
| 9.14 | **A block is never drawn shorter than one title line, and it occupies the minutes it is drawn for.** The derivation now runs from the PIXELS: the one-line floor is measured, and the minutes are that floor converted at the current scale, rounded up. `MIN_BLOCK_MIN` was hand-tuned to 55 against a 44px hour, and a hand-tuned number stops being right silently — at 54px it reserved ten minutes of lane that nothing is drawn in, inventing collisions between items that do not touch. | `TITLE_FLOOR_PX` 40.4 (measured: 2px border + 3px padding + 14.4px metadata row + 2px gap + a 15px line + 3px padding + 1px border); `MIN_BLOCK_MIN = ceil(40.4 / 54 * 60)` = 45, drawing 40.5px — clear of the floor, where the old 55/44 pair drew 40.33px and was 0.07px UNDER it; `layoutDay` assigns lanes on `renderedEnd`, so the minutes reserved still cover the pixels drawn | x | | |
| 9.15 | **The title clamp is the number of lines that fit**, and the boundaries are ONE ladder rather than a reading of the same arithmetic twice. The tiers were 52 and 67, written as `21.4 + 15n` — the title's TOP offset plus its lines, forgetting the 3px bottom padding and 1px bottom border that close the box. Each sat 3.4px too low, so a block in [52, 55.4) was clamped to two lines with room for one. Live at the old 44px hour on 75-minute blocks; raising the hour moved it onto 60-minute blocks, which is most classes. | `slotFloorPx(n)` = 40.4 + 15(n-1). Swept in a browser at 0.1px against this stylesheet, the smallest heights affording 1/2/3 lines are 40.4 / 55.4 / 70.4 — exactly the ladder. At HOUR_PX 54 every duration tried (15/30/45/60/75/90/120/180 min) affords at least the lines its tier clamps to; at 44 a 75-minute block was clamped to 2 and afforded 1 | x | | |
| 9.16 | **No lane is narrower than the chip's own controls, at any window size.** The lane budget is computed from the MEASURED grid width, not from the day count. The day count survives only as a ceiling (2 in Week, 4 in the 2-day view); width may lower it, never raise it. A lane too narrow for the clock time still drops it — the block's own position states the hour against a labelled gutter. | The budget formula predicts the rendered column width to within 0.29px (7-day) and 1px (2-day) and predicts the same lane count as the real grid in all 14 width/day-count combinations tried; at 375px and 768px a 7-day column yields 1 lane (119px chip, `scrollWidth === clientWidth`) and a 2-day column 2 lanes (81.75px), against 2 lanes/59.5px and 4 lanes/40.88px before — measured 19px and 38px of overflow out of each chip's own box | x | | |
| 9.17 | **A resized window re-derives the budget.** The lane count is baked into the DOM, so CSS cannot correct a stale one; dragging a window narrow must not leave behind the lanes a wider one chose. Re-rendered only when the budget actually changes, so an open collision stack survives an ordinary resize. | `wireCalendarResize` compares against `CAL_LANE_BUDGET` — the budget the DOM on screen was BUILT with — and is debounced; `renderCalendarOps` clears it on every path, so a List or Month view is never re-rendered by a resize | x | | |
| 9.18 | **The metadata row is one line tall, whatever control the op happens to carry.** Its height is pinned to the line box its text draws, and no control in it may be taller — the row's pixels are the title's otherwise. | `grid-template-rows: var(--chip-meta-h) minmax(0, 1fr)`, `--chip-meta-h` derived as `calc(var(--t-legend) * 1.2)`. Measured on the shipped stylesheet: an op with a Canvas submit URL rendered `grid-template-rows: 18.7969px 10.5312px` — the `.cal-submit.dense` glyph's `line-height: 1.4` made an 18.8px box, and the 4.4px came out of the title, drawing a 15px line into 10.5px. Now `14.3984px 14.9297px` and title top 21.4px for BOTH an op with a submit link and one with the borderless AI pill, at every lane width tried | x | | |
| 9.19 | **A title that cannot wrap is broken rather than cut mid-glyph.** A clamped box draws its ellipsis at the end of the last line, so it can only tidy text that wrapped; one long run overflowed sideways and was clipped with no ellipsis at all. | `.chip-title` carries `overflow-wrap: anywhere`. Measured in an 81px lane: `Entrepreneurship` was 97px of word in a 66px box and a pasted Canvas URL 350px; both now report title `scrollWidth === clientWidth` | x | | |
| 9.20 | **The hour is drawn tall enough to read.** Raised from 44px to 54px on the user's word: *"you should spread out the times vertically a little more to make the display cleaner."* Everything below it follows — the minute floor and the clamp ladder are both derived, so the scale moved without a single number being re-tuned by hand. | `HOUR_PX` 54 in cal-grid.js, imported by app.js rather than copied; `MIN_BLOCK_MIN` and `SLOT_SNUG_PX`/`SLOT_ROOMY_PX` all derive from it or from the measured line ladder. The trade, measured and accepted: at 375px a 12-hour window is 1.8 phone screens against 1.47 before, and a tight 9am-5pm day stops fitting on one (0.98 -> 1.2) | x | | |
| 9.21 | **The `Times` control is a chip of the filter family, not a drawn switch.** The user asked for *"an on/off bubble thingy"*; the first build filled a switch track with `--accent` (*"the times toggle looks ugly"*), the second kept the switch hardware in neutrals, and of that: *"the times bubble is still ugly"* (2026-09-01) — three strikes names the HARDWARE, not the palette. The control now SHARES `.filter-chip` so its metrics cannot drift from the kind chips, with `.mode-chip` supplying only the selected treatment (scoped so the kind-filter delegation can never reach it, and the old accent `.filter-chip.on` rule can never reach IT). It remains a MODE where `Show past`/`Show completed` are filters. | `#cal-times` carries `class="filter-chip mode-chip"`; off is 1px dashed `--rule-2` with a `--muted` label, on is 1px solid `--edge` with an `--ink` label, `--panel` ground and opacity 1 in both; measured 30.59px tall against the kind chips' 30.59px, and 54.03px wide in BOTH states so the toolbar cannot shift; no `.switch-btn`/`.switch-track`/`.switch-knob` selector remains in the stylesheet | x | | |
| 9.17 | **The now-line is continuous across its column.** | `.cal-nowline` z-index 5 against `.cal-collision`'s 4 — the line was always full-width (its rect equals the column) but a closed stack painted over it | x | | |

**Driven 2026-08-26**, real browser, fixture bridge on the six real classes
(354 ops), real pointer input for the gestures:

```
Times on            .cal-week.timed · 17 hour lines/col · gutter 8a…11p
                    11 placed chips · 8 banner chips · 1 now-line
alignment           7 slot columns, 1 distinct top; 8 bands, 1 distinct height
toggle off/on       stacked week returns (0 placed) and comes back (11)
in Month / in List   #cal-times hidden; 42 tiles / 354 rows unchanged
drag Tue→Thu        moved to 2026-08-27, kept 13:00–14:00, dialog did NOT open
click the same chip  opens its editor with every field prefilled
overflow            12/12 at 375 / 768 / 1280 across all three views + dialog
```

**9.12 driven on the reported collision, 2026-08-26.** The live Fall fixture
contains exact-slot groups of 7, 4, 3, 8, 3 and 6 items. In the affected Aug
31–Sep 6 timed week, Tuesday now carries one `7 due · 2:30p` stack beside the
2:30 lecture instead of seven sub-20px lanes. Opening it produced 7 full-width
chips, 7 checkboxes and 7 title buttons; the browser console remained clean.
The top-layer paper remained wholly visible outside the clock's scroll clipping.
The two-item overlap path is unchanged and still unit-tested as two 50% lanes.

**9.9 end to end, on the exact page in the report.** BUSI 380's syllabus names
the days and never states an hour, which is why its sessions were all-day
markers and why the old page had a paragraph about it. Typing 13:00–14:15 and
`Virani 182` into the page and pressing Save gave:

```
/api/class/93903-busi-380-002/meetings
  → "From your override — TuTh 1:00-2:15 PM, Virani 182"   source: override
worklist, after the rebuild
  → 18 of 21 BUSI 380 sessions now 13:00–14:15 at Virani 182
  → titled "Virani 182 - BUSI380 - Porter"      ← §4.1's shape, earned
  → the 3 without a time are the No-class days, correctly
week view → those lectures leave the banner band and land at 1p
```

The three remaining rows in the band are the right ones, and the title gaining
its room is §4.1 being satisfied by data the user supplied rather than by data
the syllabus failed to.

**What the page lost.** Four paragraphs: the one explaining that the hour was
unknown and why, the one naming the source, the one saying the day and time
were not editable here and pointing at another screen, and the sentence "Your
note is yours." All four were either restated by a field or answered by making
the field exist. What is left is a heading, `Tue 8/25 · All day · BUSI 380
002`, the session's topic clipped to one line with its redundant `Class:`
label stripped, the fields, and the notes box — 253 characters where there
were roughly 700.

One line survives on purpose: *"Applies to every BUSI 380 002 session."* It is
the only thing on the page a user cannot see for themselves, and it is the
difference between correcting a class's schedule and thinking you moved one
lecture.

**A note on where the hour lines live.** `HOUR_PX` in `app.js` and the
`44px` track in `style.css` are the same number twice, and the banner band's
`ALLDAY_ROW_PX` / `ALLDAY_PAD_PX` are pinned to a fixed chip height in the CSS.
Both pairs are commented in both files, because the band's height is computed
arithmetically rather than measured — the first version let each column size
its own band, and Monday's three markers against Thursday's one put 10am on a
different row in every column, which is 9.3's failure exactly one level below
where it was being enforced.

Suites at this note: `bridge/` **320 pass / 0 fail** (cal-grid +9), `scripts/`
**614 pass / 0 fail**.

---

## Ledger

**Open rows: 29 of 78** — every one of them open in the `User` column only.
2.12 and 2.13 are `~` (they ride on `server.js`, so they wait for the app to be
relaunched); 7.1–7.6 and 8.1–8.10 are blank for the same reason — both sections
have been driven against the six real classes on a fixture bridge, and both add
routes to `server.js`, so the app has to be relaunched before the user can
reach them. §9 (9.1–9.11) is `public/`-only and so is User-visible on ⌘R, but
it is left blank until it has been seen on the app's own bridge rather than a
fixture. Nothing is open in `Built`, and only 7.6 is open in `Live`.

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
- §1.9/§3.2/§3.3: the original hidden-set measurement was superseded on
  2026-08-26 and re-driven with the selection control: BUSI 305 + Meetings,
  List→Week→Month→List, gave 16/1/2/16 items and 0 from any other class;
  clicking the last selected class returned to all classes (see §6.10–6.15).
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
