# Canvas Sync

Read-only mirror of `canvas.rice.edu` into a local folder, using your already-authenticated Chrome session. No Canvas API token required. No cloud. No telemetry.

Produces `~/canvas-sync-data/classes/<id>-<slug>/` for each active course, with structured JSON for assignments / modules / announcements / pages / quizzes, the raw syllabus (PDF or HTML), a parsed syllabus JSON, and an exhaustive `AI_CONTEXT/context.md` ready to feed to any LLM.

## Run it (double-click)

**To open the app: double-click `CANVASync.app`.** That's the whole thing — it starts the
bridge and opens your dashboard in one window. Keep `CANVASync.app` inside this `canvas-sync`
folder (it finds `app/` and `bridge/` next to itself); to put it on your Dock or Desktop, drag
it there holding **⌘⌥** to make an alias rather than moving the original.

- **First launch takes a minute.** On a brand-new copy the app installs its own dependencies
  before the window appears — this happens once. Later launches open immediately.
- **If macOS says "unidentified developer":** right-click `CANVASync.app` → **Open** →
  **Open** (only needed the first time — the app is unsigned because it's yours, not
  App-Store distributed).
- **If double-clicking the .app does nothing:** double-click **`Start CANVASync.command`**
  instead — same launch, in a Terminal window that shows progress. Anything that goes wrong is
  logged to `~/Library/Logs/CANVASync-launcher.log`.
- **Needs Node.js only for that first install.** If the first launch reports Node is missing,
  install it from [nodejs.org](https://nodejs.org) and open the app again. After the one-time
  setup the app runs on Electron's own runtime — no Node needed to launch.

The one step that can't be a double-click is loading the Chrome extension (Chrome requires it
for an unpacked extension): open `chrome://extensions`, turn on **Developer mode**, click
**Load unpacked**, pick this repo's `extension/` folder — then in the app's **Settings** click
**Pair a Chrome extension**, copy the token it shows, and paste it into the extension popup.
You only do this once.

## Architecture

```
Chrome (authenticated canvas.rice.edu session)
  └─► Extension service worker
         ├─ fetch() with credentials: 'include'
         │    assignments (+rubrics/overrides/stats) · assignment groups
         │    modules (+items) · discussions (+thread replies, top 20 topics)
         │    announcements (back to term start) · pages (with bodies)
         │    quizzes · course calendar events · grades (own enrollment)
         │    course tabs · student groups · files listing
         │    file downloads (Files tab + module attachments + files linked
         │    inside any HTML body) · syllabus
         └─ POST JSON to http://127.0.0.1:3847
                      ▼
              Local bridge (Node/Express, loopback only)
                 ├─ writes <data root>/classes/<courseId>-<slug>/
                 ├─ serves the dashboard UI at /app + /api/* (secret-gated)
                 └─ per-class pipeline (mtime-cascaded, resource-adaptive):
                      1. parse-syllabus.js        (AI)  → syllabus_parsed.json
                      2. extract-course-files.js        → materials/*.txt
                         (+ ppt/doc/xls → materials/pdf/ when LibreOffice is installed)
                      3. mine-assignments.js      (AI)  → assignments_mined.json
                         every task incl. implicit ones buried in slides/pages
                      4. build-context.js               → AI_CONTEXT/context.md
                                                          AI_CONTEXT/pack/   ◄— upload to a Claude project
                    then once per pass:
                      sync-calendar.js (deterministic) → <data root>/calendar/worklist.{json,md}
                                                          + ROUTINE.md — consumed by your Claude calendar routine
                      ▲
              Desktop app (Electron shell, app/)
                 launches the bridge, provisions the data root + secret on
                 first run, and loads the same dashboard UI
```

**AI backends.** Steps marked (AI) run through `scripts/_util.js aiInvoke()`:
`CSYNC_AI_BACKEND=claude` (claude CLI only, default model `claude-opus-5`, override with
`CSYNC_CLAUDE_MODEL`), `local` (local MLX model only), or `auto` (default — claude first, falls
back to the local model if the CLI fails, e.g. logged out). The local backend runs
`scripts/local_generate.py` with `~/mlx-env/bin/python` (override `CSYNC_LOCAL_PYTHON`) and model
`mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit` (override `CSYNC_LOCAL_MODEL`), fully offline.

**Calendar.** `sync-calendar.js` never touches your calendar itself by default. It compiles a
diffable worklist — due-date events, class sessions, and prep "checkpoint" events for
exams/projects/papers, each with a `[csync:...]` marker for idempotent create/update and a
strict never-delete rule — that a Claude routine with calendar MCP applies. Each operation
carries `url` and, where one exists, `submit_url` as fields rather than only inside the
description prose, so the event that lands in your calendar links to the assignment and to the
place you hand it in. Set `CSYNC_CAL_DUE` / `CSYNC_CAL_CHK` to embed target
calendar ids in the worklist. Optional: `CSYNC_CAL_AGENT=1` additionally spawns a headless
`claude -p` (tools allowlisted via `CSYNC_MCP_ALLOWED`) to apply the worklist immediately.

**Resource safety.** The pipeline is paced so a sync can never overwhelm the machine:
job concurrency is derived from CPU cores and free memory (1–3 jobs, override with
`CSYNC_MAX_JOBS`), job launches are spaced ≥1.5 s apart, and local-model generations hold a
machine-wide lock (`<data root>/locks/local-model.lock`) so only ONE ~20 GB model load can ever
exist at a time, no matter how many pipeline processes are running. A running sync can be
cancelled from the extension popup (the Force button becomes **Cancel sync**) or the dashboard
(**Rebuild packs** becomes **Cancel pipeline**); cancel SIGTERMs running jobs — which forward it
to their python/soffice children — and skips everything queued. Force sync is refused while a
sync is already running instead of queueing a second full pull.

## What gets scraped — and what can't be

Per tracked course, the extension pulls: assignments (with rubric, submission state, date
overrides, score statistics), assignment groups (grade weights), modules with items,
discussion topics **plus thread replies** for the 20 most relevant topics, announcements back
to term start, every page body, quizzes, course calendar events (−30 to +210 days), your own
enrollment/grades, the course tab list, student groups, and the file listing. It downloads
every reachable file: the Files tab, files attached to modules but hidden from the Files tab,
and files linked inline from any HTML body (syllabus, pages, assignments, announcements,
discussions, quiz descriptions) — diffed against the bridge index so unchanged files are never
re-downloaded, with a 200 MB per-file cap.

**Honest gaps** — things Canvas does not expose to a student session, so no scraper can get them:

- **Quiz questions.** The quizzes API lists quizzes and metadata; question content is only
  served inside an active quiz-taking session.
- **External LTI tools.** Content living in Piazza, Panopto, Gradescope, McGraw-Hill, etc. is
  hosted by those vendors — Canvas only stores the link. The context pack lists these tabs per
  class under "External course tools (content NOT synced — check these manually)".
- **Group spaces.** Student group memberships are captured; files/discussions *inside* a group
  space are a separate context the sync does not enter.
- **Unpublished/locked content.** Anything your instructor has not published or has
  date-locked is invisible to your session until it unlocks (it is picked up on the next sync
  after that).

## Local-only guarantees

- **Data path:** `~/canvas-sync-data/` (chmod 700). Can be relocated via `--base-path`.
- **Network egress — four endpoints:**
  - `canvas.rice.edu` (source, via your browser session)
  - `api.anthropic.com` (AI stages, via the `claude` CLI — not contacted when the backend is `local`)
  - `fonts.googleapis.com` / `fonts.gstatic.com` (dashboard typefaces; the dashboard falls back to system fonts offline)
  - `huggingface.co` (only when you explicitly download the local model from the desktop app)
  - All other domains blocked at the extension level by Content Security Policy.
- **Bridge binds 127.0.0.1 only.** It refuses to start if `HOST` or `BIND` env vars are set to anything non-loopback.
- **No cloud sync:** installer refuses to proceed if `~/Documents` is iCloud-managed or inside Dropbox / OneDrive / Google Drive.
- **No git:** data folder has a `.nogit` marker. Repo `.gitignore` blocks the path.
- **No telemetry:** `express` is the only runtime dependency of the bridge. No analytics SDKs, no auto-updaters, no error reporting services.
- **Shared secret:** 32-byte hex, generated at install. Extension stores it in `chrome.storage.local`; bridge stores it in `config.json` at `chmod 600`. Every request compared with `crypto.timingSafeEqual`.
- **Read-only against Canvas:** no POST/PUT/DELETE anywhere in the codebase that targets `canvas.rice.edu`. Grep for it.

**What this does NOT protect against** (honest list):
- Other apps running as your macOS user can read the data folder. User-app sandboxing on macOS is limited.
- Spotlight indexes `context.md` as plaintext. To exclude: `mdutil -i off ~/canvas-sync-data`.
- If your Chrome profile is compromised, the attacker has your Canvas session regardless of this extension.

## Prerequisites

- macOS (primary). Linux mostly works; Windows not supported.
- Node.js 20+.
- Chrome (latest).
- [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) logged in — run `claude login` and re-run it whenever the OAuth session expires (the Activity log will show "OAuth session expired" when it has). Used when syllabi change or assignments shift (parse/mine/context rebuilds). If the CLI is unavailable or logged out, the pipeline falls back to the local MLX model automatically (`CSYNC_AI_BACKEND=auto`, see Architecture). Context packs and the calendar worklist are built deterministically either way — only syllabus parsing, assignment mining, and pack enrichment need an AI backend.

## Pre-install checklist

1. **iCloud Desktop & Documents.** Open *System Settings → [your name] → iCloud → iCloud Drive → Options*. If "Desktop & Documents Folders" is on, either uncheck it, or pass `--base-path ~/canvas-sync-data` to the installer. Installer will refuse otherwise.
2. **FileVault.** Run `fdesetup status`. If off, data at rest in `~/canvas-sync-data/` is unencrypted. Strongly recommended to enable before installing. Installer refuses unless you pass `--accept-unencrypted`.
3. **No cloud folders.** Don't install inside Dropbox / OneDrive / Google Drive. Installer checks.

## Install (5-minute path)

```bash
git clone <this repo>
cd canvas-sync
./bridge/install.sh
```

The installer will:
- Check iCloud / FileVault / cloud-drive status.
- Create `~/canvas-sync-data/` with correct permissions.
- Generate a 32-byte bridge secret and a 10-minute single-use install token.
- Install bridge dependencies (`npm install --no-audit --no-fund`).
- Run a local `npm audit` and fail on high/critical.
- Optionally install a launchd agent to auto-start the bridge on login (macOS).
- Print the install token — copy it within 10 minutes.

Then:

4. Open `chrome://extensions`. Turn on *Developer mode*. Click *Load unpacked*. Select the `extension/` directory of this repo.
5. Click the extension icon. Paste the install token. Click *Connect*. Extension handshakes with the bridge; secret is exchanged.
6. Open `canvas.rice.edu`. Within seconds the sync fires automatically. Verify `~/canvas-sync-data/classes/` fills up.
7. Leave it alone. Syncs run automatically:
   - On every Canvas visit (debounced — at most once per 12 hours per `canvas-opened` trigger).
   - Every Monday at 06:00 local time.
   - On demand via the popup's *Force sync now* button.

## Daily use

There is no daily use. The extension is passive. Open the popup to:

- See when the last sync ran and why (weekly / canvas-opened / manual).
- See next scheduled weekly sync.
- See how many courses are tracked and whether the bridge is reachable.
- Force a sync (for when you've just added a class and don't want to wait).
- View recent logs.

## Which classes sync (selection semantics)

- **No selection saved** (fresh install): the extension syncs the **current term only** — courses are grouped by term label ("Fall 2026" etc.) and the term containing today wins.
- **Selection saved in the popup's class picker**: it is an explicit allowlist. Only checked classes sync — an **empty** saved selection syncs **nothing** (it does not fall back to "everything").
- Past-semester courses that Canvas still reports as active no longer sneak in.

## Desktop app — your personal Canvas

`app/` is a thin Electron shell around the bridge's dashboard. First run provisions the data
root (`~/canvas-sync-data` by default), generates the bridge secret, and starts the bridge
using Electron's own Node runtime (`ELECTRON_RUN_AS_NODE`) — no separate Node install needed.

```bash
cd app && npm install && npm start
```

The same UI is reachable from any browser at `http://127.0.0.1:3847/app` (it asks for the
bridge secret once; the app injects it automatically). Views: **Classes** (tasks grouped by
urgency, files, AI pack, course overview + current grade), **Calendar** (the worklist your
routine applies, plus the Populate panel), **Activity** (pipeline log), **Settings** (AI
backend, calendar ids, pairing, local-model check/download — the app can detect the MLX model
in your HF cache and offers a one-click download when absent).

**The task list is Canvas plus mining, not one or the other.** Every dated Canvas assignment
shows up as soon as the class is synced; mining adds the work that only exists in slides,
pages and the syllabus. Items the two agree on (same Canvas id, or the same title once
punctuation is stripped) appear once. Until mining has run the list says so, so a short list
never quietly reads as "not much due".

**Assignment pages.** Clicking a task on the Classes tab, or a due-date row on the calendar,
opens the assignment inside the app: the Canvas description (sanitized — scripts, event handlers and `javascript:` URLs
removed), what mining understood the work to be, the most relevant course materials, and the
files that came from that assignment, which open locally. Two links go out to Canvas from
there — the assignment page and, when there is somewhere to submit, the submission page.

**Links that actually open.** Canvas reports `html_url` on every assignment, but for a
quiz-backed one that URL is the teacher's view of the object and a student following it gets
Access Denied — 39 of the 86 assignments synced on this machine. `canvas-links.js` rewrites
those to `/courses/:id/quizzes/:quizId` (and discussion-backed ones to their topic) everywhere
a link is handed out: the dashboard, the context packs, the calendar worklist. Submit links are
left off entirely for work Canvas marks `none`, `not_graded`, `on_paper` or `external_tool`,
which have no submission route — an LTI attendance row had been offering a Submit button that
went nowhere.

**Task management.** Every task row has a checkbox (done items drop off the calendar
worklist immediately), and an Edit panel for notes, a color flag, moving the due date/time
(the calendar follows the move and says "Moved by you"), and personal checkpoints —
sub-deadlines that replace the automatic exam-prep events with your own plan. All of it
lives in `user_state.json` per class; syncs never overwrite it.

**Files by provenance.** The Files tab groups every file by where it was pulled from —
module, assignment, quiz, page, announcement, syllabus, or the bare Files tab — with the
exact item it came from under each name ("+2 more places" when a file is reused). Sort
modes: **Source** (grouped), **Name**, **Newest**. Provenance is derived from the synced
course data at read time, so it works retroactively on classes synced before this feature
existed.

**Sharing with friends.** Give a friend this repo (or the packaged app) + the extension. Their
app run provisions their own data root and their own secret; the Settings → "Pair a Chrome
extension" button creates a 10-minute install token their extension consumes to pair. Every
install is fully independent — nothing is shared.

**Sync scheduling — full customization.** The extension popup's "Sync schedule" section
controls when data is pulled: weekly day + hour, an optional repeating interval poll
(off/1/3/6/12/24 h), and the canvas-opened debounce window. The dashboard's Settings save
`CSYNC_*` env overrides into `<data root>/settings.json`, which the bridge merges into every
pipeline job — backend selection, model ids, calendar ids, concurrency — no restarts needed.

## Calendar routine (paste this into your Claude routine)

```
Read the file <data root>/calendar/ROUTINE.md and follow it exactly. It contains
the current instructions and points at the worklist to apply. If the file is missing,
report that and stop — do not improvise calendar changes.
```

Replace `<data root>` with your actual data root (this machine uses `~/canvas-sync-data`;
a default install uses `~/canvas-sync-data`). The dashboard's Calendar view shows a
copy-ready version of this prompt with the real path already filled in.

`ROUTINE.md` is copied on every pipeline pass from `scripts/prompts/calendar-routine.md`, so
the routine's behavior can be modernized any time by editing that one repo file — your routine
prompt never needs to change.

### What gets populated (the plan)

The Calendar view's **Populate** panel controls which kinds of events the worklist carries,
globally and per class: **Meetings** (lecture/lab sessions with time + room), **Homework**,
**Readings**, **Exams**, **Checkpoints** (automatic exam prep, or your own). Choices persist
in `<data root>/calendar/plan.json`; every change rebuilds the worklist within a few seconds —
no sync needed. Meetings are **off by default** (a calendar that fills itself with a
semester of lectures unasked is a calendar you stop trusting); the per-class matrix greys
out Meetings for a class that would produce no sessions. A corrupt or deleted plan file reads
as the defaults — never as "populate nothing".

Event titles are deliberately terse: `BUSI 380 · HW 3`, `Read · BUSI 305 Ch 4`,
`Prep · BUSI 396 Midterm`, `BUSI 395 · Lab: Circuits II @ MCN 317`. Three target calendars
are supported — due dates (`CSYNC_CAL_DUE`), checkpoints (`CSYNC_CAL_CHK`), and optionally
meetings (`CSYNC_CAL_MEET`, defaults to the due-dates calendar) — all settable in
Settings → Calendar. When a syllabus has a weekly pattern but no dated schedule, the
worklist emits ONE weekly recurring event instead of a semester of copies.

### When your class meets

Plenty of syllabi name the days and never state a clock time — one of the five classes on this
machine says only "Tuesdays and Thursdays" and points at Canvas for the rest. Before an event
can be placed, `scripts/meeting-times.js` looks for the time in order, strongest source first:

1. Your own override for that class.
2. The syllabus `meeting_schedule` field, when it already states a time.
3. The full syllabus text — the extracted text under `materials/` and Canvas's own syllabus
   page. The time is often under a heading the field parser never looked at.
4. Canvas: course events first, then page and announcement bodies.
5. A guess from recurring assignment due times. Off unless a caller asks for it; nothing in
   the app does.

The rule throughout is that no time beats a wrong time. Every step can return the days with no
clock rather than invent one, so a session with an unconfirmed time is placed with no time on
it instead of a plausible wrong one, and the panel says which source the answer came from.
Office hours, study groups and homework deadlines are filtered out before they can be read as
a class time.

When that comes back empty, or comes back wrong, set it yourself: each class in the Populate
panel has a **set times** link that opens an editor for days, start, end and room. Your answer
outranks every other source, needs no AI backend, is stored in that class's
`meeting_override.json`, and rebuilds the worklist as soon as you save. **Use the syllabus
instead** clears it again. A class whose syllabus has no dated schedule at all still gets one
weekly recurring event from an override, as long as the override carries a start and end time.

### Reading the calendar

Each class holds one color — a hue at fixed saturation and lightness, assigned across the whole
set so no two classes collide, and stable from one visit to the next. Color identifies the
class and nothing else; it never means urgent. The chips above the list toggle a class in and
out of the view (hidden classes are remembered in the browser, per device), and every due-date
row has a checkbox that marks it done and drops it from the worklist. Past lectures are not
styled as missed deadlines.

## Downstream: the AI context pack

Each class gets `AI_CONTEXT/pack/` — a self-contained folder built for a Claude project:

- `README.md` — what the pack is and how to use it
- `01-course-overview.md` — course info, grading (Canvas group weights preferred over syllabus), the complete mined task list, schedule, modules, discussions, calendar events, policies, announcements
- `02-assignments.md` — every assignment, including implicit work found only in slides/pages/announcements, each with its evidence and the most relevant course materials in relevance order
- `materials-NN.txt` — full extracted text of every course file (slides, readings, handouts)

Upload the pack's files to a Claude project's knowledge, then ask about any homework in that class. `AI_CONTEXT/context.md` / `context.json` remain for CLI use:

```bash
cd ~/canvas-sync-data/classes/42891-econ-370
claude -p "I'm starting problem set 5 in this class: $(cat AI_CONTEXT/context.md)"
```

Calendar tooling reads `<data root>/calendar/worklist.md` — never directly from Canvas.

## Manual acceptance checklist

After install, confirm:

- [ ] `~/canvas-sync-data/classes/` has one folder per active course.
- [ ] Extension popup shows `✓ Auto-sync on` with a recent timestamp.
- [ ] At least one class has a `syllabus.pdf` or `syllabus.html`.
- [ ] At least one `AI_CONTEXT/context.md` is non-empty and well-formed.
- [ ] Closing and reopening canvas.rice.edu within 12 hours does NOT trigger another sync (debounce works).
- [ ] Clicking *Force sync now* always triggers a sync regardless of debounce.
- [ ] Next scheduled weekly sync in the popup points to next Monday 06:00.

## Troubleshooting

**Bridge not reachable.** The popup shows `⚠ Bridge offline`. Start it: `node bridge/server.js`. Or, if you installed launchd: `launchctl kickstart -k gui/$(id -u)/com.canvas-sync.bridge`.

**Canvas 401 (Duo / session expired).** Popup shows `⟳ Canvas login needed`. Open canvas.rice.edu and log back in. Next `CANVAS_OPENED` trigger resumes sync.

**Syllabus not found.** The extension matches files whose `display_name` contains `syllabus` (case-insensitive). If your instructor named it something else (e.g., `course-overview.pdf`), the `files_index.json` for that course will list it. Copy it manually to `syllabus.pdf` and run `node scripts/sync-all-contexts.js`.

**Class sessions have no time on them, or the Meetings toggle is greyed out.** The syllabus
never stated one, and nothing else did either — this is the app declining to guess, not a
failed sync. Open Calendar → Populate, find the class, and click **set times**. That needs no
AI backend and rebuilds the worklist on save.

**Parser errors.** Check `~/canvas-sync-data/logs/trigger.log`. The parser writes broken output to `<classDir>/syllabus_parsed.json.ERROR` when Claude returns malformed JSON. Delete that file and re-run `node scripts/sync-all-contexts.js`.

**Weekly alarm didn't fire.** Chrome aggressively throttles MV3 service workers. The weekly alarm is schedule-based, not polling-based, but Chrome may delay it by up to a few hours. Force with the popup.

**iCloud check false positive.** If `./bridge/install.sh` refuses but you've disabled Desktop & Documents, pass `--base-path ~/canvas-sync-data` explicitly.

**Bridge won't start — "config.json not found."** Run the installer. It creates `~/canvas-sync-data/config.json`.

**Handshake fails — "no install token found" or "install token expired."** Install tokens expire 10 minutes after the installer prints them. Re-run `./bridge/install.sh` to generate a new one (the bridge secret is preserved if config.json already exists).

## Kill switch

```bash
touch ~/canvas-sync-data/DISABLED
```

Bridge will reject all ingest requests with 503 until the file is removed.

## Uninstall

```bash
# 1. Stop bridge (if using launchd):
launchctl unload ~/Library/LaunchAgents/com.canvas-sync.bridge.plist
rm ~/Library/LaunchAgents/com.canvas-sync.bridge.plist

# 2. Remove data folder:
rm -rf ~/canvas-sync-data

# 3. Remove extension:
#    chrome://extensions → Canvas Sync → Remove

# 4. Delete this repo if desired.
```

There is no Canvas-side token to revoke. That's the point.

## Development

```bash
# Bridge tests
cd bridge && node --test

# Scripts tests (set CLAUDE_SKIP=1 to bypass claude CLI)
cd scripts && CLAUDE_SKIP=1 node --test

# Run bridge manually
node bridge/server.js

# Force a full re-parse + context rebuild
node scripts/sync-all-contexts.js
```

Override the data root for development: set `CANVAS_SYNC_HOME=/tmp/canvas-sync-dev` in the bridge and scripts.

## Repo layout

```
canvas-sync/
├── extension/      MV3 Chrome extension (background worker, popup, canvas client)
├── bridge/         Express server on 127.0.0.1:3847 + install.sh
│   ├── public/     dashboard UI (served at /app, shared by browser + desktop app)
│   ├── user-state.js    per-class task state (done/notes/flags/moves/checkpoints)
│   └── file-origins.js  file provenance derived from the synced course JSON
├── app/            Electron desktop shell (launches bridge, provisions data root)
├── scripts/        parse-syllabus, extract-course-files, mine-assignments,
│                   build-context, sync-calendar, local_generate.py, prompts/,
│                   cal-names.js (concise titles), cal-meetings.js (schedule parse),
│                   meeting-times.js (where the meeting time comes from)
├── calendar-plan.js    which event kinds populate (shared bridge ↔ scripts)
├── canvas-links.js     the Canvas URL a student can actually open
├── canvas-tasks.js     Canvas assignments + mined items, unioned into one task list
├── scope.js            sync-scope semantics (shared bridge ↔ scripts ↔ extension)
└── README.md
```

Per-class on-disk layout (v1.1):

```
~/canvas-sync-data/classes/<id>-<slug>/
  metadata.json
  assignments.json  assignment_groups.json  modules.json  pages.json
  announcements.json  quizzes.json  discussions.json  calendar_events.json
  grades.json  tabs.json  groups.json
  syllabus.{pdf,docx,html}   syllabus_parsed.json
  assignments_mined.json     exhaustive AI-mined task list (incl. implicit tasks)
  files/           raw downloads (Files tab + module attachments + embedded links)
  materials/       extracted text per file + last_extracted.txt completion marker
  materials/pdf/   ppt/doc/xls converted to PDF (when LibreOffice is installed)
  files_index.json canonical per-file state (sha256, extractionStatus, duplicateOf…)
  user_state.json  your task state: done, notes, flags, date moves, checkpoints
  meeting_override.json  when this class meets, as you typed it (only if you set it)
  AI_CONTEXT/      context.md + context.json + last_built.txt
  AI_CONTEXT/pack/ uploadable pack for a Claude project
```

## Scope

**v1 builds exactly:** Chrome extension, local bridge, syllabus parser, AI context generator.

**v1.1 adds:**
- **Course-files extraction.** Every file in each tracked class's Files section is downloaded into `classes/<slug>/files/` and text-extracted into `classes/<slug>/materials/*.txt` + a catted `materials/_combined.txt`. Formats: pdf, pptx, docx, xlsx, txt/md, html, png/jpg/jpeg/gif (OCR). OCR fallback only if native text < 200 chars. Duplicate slides/readings are deduped by SHA-256 of the extracted text. Canvas `updated_at` is authoritative. Large combined files split at section boundaries into `_combined-01.txt`, etc.
- **Popup class-list checkboxes.** The popup now shows every tracked class with a checkbox. Uncheck to stop syncing and hard-delete the local folder. Re-check to resume (next sync repopulates fresh).
- **Safe delete.** One `safeDeleteClass(folderName)` entry point in `bridge/storage.js` with 8 enforced rules (regex whitelist, symlink check, sentinel check, realpath match, `fs.rmSync` only). No shell. No wildcards. Audited to `~/canvas-sync-data/logs/delete.log`.
- **Per-class calendar cleanup.** Unchecking a class fires a tightly-scoped `claude -p` routine that deletes ONLY that class's future events on the two CanvaSync calendars (requires `CSYNC_CAL_DUE` and `CSYNC_CAL_CHK` env vars on the bridge process — otherwise the cleanup exits 0 with a log note). The daily sync routine's never-delete invariant is preserved. On cleanup failure, a Gmail draft is created for the user.

**v1.2 adds:** sync-scope everywhere (only selected classes sync, process, and render; stale-class cleanup with size reporting), task management (`user_state.json`: done / notes / flags / moves / checkpoints — the calendar obeys it), file provenance grouping, the calendar Populate plan (`calendar/plan.json`, five kinds, global + per-class), syllabus meeting parsing with per-clause lecture/lab patterns, concise event naming, an optional meetings calendar (`CSYNC_CAL_MEET`), and the dark design language across the dashboard and all extension pages.

**Added since v1.2:** meeting-time recovery with a per-class override you can type
(`meeting_override.json`, GET/POST/DELETE `/api/class/:folderName/meetings`); assignment pages
inside the dashboard, with sanitized Canvas HTML and the files that came from that assignment;
Canvas item and submit URLs corrected once, centrally (`canvas-links.js`), so quiz-backed work
no longer links to a page Canvas denies students; a task list that is the union of Canvas
assignments and mined items rather than one replacing the other (`canvas-tasks.js`); per-class
calendar colors, class visibility chips, and done-checkboxes on calendar rows; `url` and
`submit_url` carried as worklist fields; and JSON salvage for syllabus parses the model
truncates.

**Out of scope for v1.1** (supported by the data layout but not implemented here): per-class assignment-support agents, "busywork" automation, any Canvas write path, cross-class material linking, per-file delete, auto-archive.

## License

Personal use. Not affiliated with Rice University or Instructure.
