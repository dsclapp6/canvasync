# canvas-calendar

Pushes Canvas assignments — and Claude-generated essay checkpoints — into a dedicated Google Calendar. **Reads only from the local `canvas-sync` data folder; never touches Canvas directly.**

## How it works

1. `csync-calendar sync` iterates every synced class under `$CANVAS_SYNC_HOME/classes/`.
2. For each class, Claude (via the `claude` CLI) reads `AI_CONTEXT/context.md` + filtered future assignments and returns a JSON plan of calendar events:
   - one event per graded future assignment (title, time, rich description with readings/links, reminders),
   - 3–5 checkpoint events for essays / multi-day projects.
3. Deterministic code then inserts / patches / skips events via the Google Calendar API. Claude never touches the OAuth tokens.

Idempotency: each event carries `extendedProperties.private.canvasAssignmentId` + a `contentHash`; unchanged events are skipped, changed ones PATCHed.

All state lives under `$CANVAS_SYNC_HOME/calendar/`:
- `credentials.json`  Google OAuth Desktop client (chmod 600)
- `tokens.json`       refresh + access tokens (chmod 600)
- `config.json`       `{ calendarId, timeZone }`
- `mapping.json`      `canvasAssignmentId → googleEventId + contentHash`

## Setup (one-time)

1. Create a Google Cloud OAuth Desktop client (see `csync-calendar setup` for the walkthrough).
2. `npm install` in this directory.
3. `./bin/csync-calendar setup` — paste client ID + secret, complete the browser flow.

## Usage

```
csync-calendar classes                          # list synced classes
csync-calendar dry-run                          # preview — no writes
csync-calendar sync                             # plan + push all classes
csync-calendar sync --class busi-310            # one class only
csync-calendar sync --model claude-opus-4-7     # pick a specific Claude model
csync-calendar config                           # show calendarId + timezone
csync-calendar prune --dry-run                  # show stale mapping entries
csync-calendar reset --confirm                  # wipe tokens + mapping
```

## Testing without Google / Claude

```
CLAUDE_SKIP=1 node --test
```

Uses a deterministic stub planner (one event per future assignment, no checkpoints, no Claude call). Does not touch Google — the sync orchestrator is not exercised in tests because Google Calendar has no public fake.

## Non-negotiables

- Never calls Canvas; input is strictly the local JSON from canvas-sync.
- Claude plans; deterministic code writes. LLM never holds an OAuth token.
- Only future assignments (`due_at > now`) are pushed. Past items are left alone.
- Credentials / tokens `chmod 600`.
- Only runtime dep: `googleapis`.
