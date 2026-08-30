<!-- Written by the PM session (canvasync-76), 2026-08-29, from a read-only
classification sweep of every `${file}.tmp.${process.pid}` write site, run
after the user-state race (fixed in v1.8.5) proved the defect class is
user-reachable. Two hazards per site were assessed: (a) temp-path collision —
two same-process writers to one destination share a temp file, first rename
orphans the rest; (b) lost update — read-modify-write across an await lets a
stale read discard a concurrent write even with unique temp paths. The
house-pattern fix exists twice: custom-items.js and user-state.js (per-path
promise chain + crypto.randomBytes temp suffix). -->

# Write-safety audit — pid-temp and read-modify-write sites

STATUS: slice A LANDED v1.8.7 (write-lock.js; custom-items + user-state
converted behavior-preserving; site 3 fixed, lock load-bearing; site 8
defence-in-depth only — prediction falsified, see below). Slice B LANDED
v1.8.8 (sites 4,5,6,7 all load-bearing — per-site lock-removal mutations fail
3/2/2/4 of 10; the app-vs-extension intent race reproduced and closed; site 7
gained its missing try/catch; site 4's five routes unified through one
mutateConfig(fn) reading inside the lock; key normalization added to
write-lock.js via lockKey(scope, target) — fast-follow on v1.8.7, latent
there, reachable once slice B added global keys). Site 8 locks by CLASS DIR:
each mutator touches both override and stash files. Site 1 LANDED v1.8.9
(canvasync-96, per the accepted design below: canvas-sync/file-lock.js,
real child-process control+treatment race tests, 7 of 8 mutations bite, the
eighth — rm-by-path reclaim — accepted-silent and documented at the reclaim
line as verified by provenance, not CI). Site 2 follow-up. Site 9 safe.
CAMPAIGN COMPLETE: 8 of 9 sites resolved across v1.8.5–v1.8.9.

## Verdict table

| # | Site | Destination | Same-dest concurrency | RMW across await | Verdict |
|---|------|-------------|----------------------|------------------|---------|
| 1 | bridge/storage.js:25 atomicWrite | metadata.json, resource JSONs, **files_index.json**, last_sync.json … | Yes — unguarded HTTP routes, no server-side lock | Yes for files_index.json (storage.js:270→330) | **LOST-UPDATE-RISK** (files_index); rest collision-only |
| 2 | bridge/storage.js:31 atomicWriteBinary | class files, syllabus.<ext> | Only via duplicate same-course ingest | No — wholesale | COLLISION-ONLY |
| 3 | bridge/textbooks.js:357 | <classDir>/textbook_links.json | **Yes** — two PUTs for two rows of one class (app.js:1872 disables only that row's button) | Yes (textbooks.js:411→416, wide window incl. syllabusBooksForClass read) | **LOST-UPDATE-RISK** |
| 4 | bridge/server.js:128 saveConfig | <home>/config.json (global) | Yes — 5 unlocked routes (:327,:550,:589,:610,:2034) | Yes (loadConfig→mutate→saveConfig) | **LOST-UPDATE-RISK** |
| 5 | bridge/server.js:143 atomicWriteJson | sync-scope.json; **dashboard-state.json** | **Yes** — app POST /api/scope (:966) vs extension POST /config/intent/ack (:691) | Yes — both read→mutate intent→write | **LOST-UPDATE-RISK** |
| 6 | bridge/server.js:1844 | <home>/class_colors.json (ONE global file for all classes) | **Yes** — un-awaited saveClassColor calls (app.js:4646,4652); multiple tabs | Yes (:1842 read → :1843 merge → write) | **LOST-UPDATE-RISK** |
| 7 | bridge/server.js:1937 | <home>/settings.json (global) | Yes — POST /api/settings double-save, two tabs | Yes — explicit merge (:1929→:1937), the merge is the lost-update shape | **LOST-UPDATE-RISK** |
| 8 | scripts/meeting-times.js:446 | meeting_override.json + meeting_override_previous.json | **Yes** — clear/DELETE handler has NO double-click guard (app.js:5067; only revert at :5077 disables); save form doesn't either (:5036) | Yes — all three mutators (write :583-589, revert :491-501, clear :604-615) | **LOST-UPDATE-RISK** |
| 9 | scripts/correlation-graph.js:724 | <classDir>/correlation_graph.json | No — one dedicated child process per classDir, deduped at trigger.js:379-382 | No — wholesale derived rebuild | SAFE |

## Highest-value concrete failures

- **#5 dashboard-state**: the app saving a new selection while the extension
  acks the previous sync's intent. server.js:685-690 already reasons about
  exactly this ordering ("a newer intent must survive this ack") but enforces
  it with an id comparison across an unserialized RMW — the race defeats it.
  A cleared intent can resurrect, or a new selection can vanish.
- **#8 meeting overrides**: PREDICTION FALSIFIED during slice A (canvasync-0e,
  200-run direct attack: zero stash destructions). clearMeetingOverride
  returns early when its unlink fails, BEFORE reaching stashPrevious, so a
  double-click's second clear writes no stash rather than a null one. The RMW
  is still genuinely unserialized; the conversion stands as defence-in-depth
  protecting the next edit to those three functions, and its tests state
  invariants — they pass with and without the lock and are not mutation-grade
  evidence.
- **#6 colors**: :1848's `fs.unlink(tmp)` on failure can delete the OTHER
  writer's in-flight temp file under collision.
- **#7 settings**: only site of the nine with NO try/catch around
  write+rename — a collision ENOENT rejects into Express unhandled, client
  gets no response, an orphaned settings.json.tmp.<pid> remains.

## Testing convention (captured from this campaign)

**An equivalence or normalization test needs BOTH halves: these inputs must
converge, AND those must not. Only the second half has teeth.** The first half
alone is satisfied by `return 'constant'` — an assertion that holds whether or
not the mechanism works. This caught two sessions independently on the same
day: a lock-key test that a symlink and its target share a key (a constant
passes, while queueing every class behind every other), and the slice-A site-8
tests of the same shape. Sameness + discrimination + shape, always. Corollary
from the same campaign: mutation testing's value is that it tells you which of
your tests are load-bearing — including the ones it cannot close, which get
documented instead of faked.

## Follow-up items from the post-ship lock review (Codex F1/F2/F5, fixed v1.8.11)

- **scripts/_util.js:296 latent busy-loop**: `_acquireModelLock`'s
  dir-vanished `continue` skips its deadline check — the same shape fixed in
  file-lock.js (F1). Unreachable today only because `<dataRoot>/locks/` is
  never deleted. Owned by the item-1 pass (d8's file); take it in the same
  edit, do not orphan it. OBSERVED SYMPTOM 2026-08-30: under heavy load (two
  concurrent full-suite runs + external profiling processes) model-lock.test's
  "pid-less lock shell" case ran 192s against a 30s timeoutMs before failing —
  the deadline is not being honored on some contended path. Alone: 8/8 in 10s,
  every clean full-suite run green. Evidence for the fix, not a new ticket.
- **F5's second half — orchestrator stderr discard**: extract's lock-timeout
  fallback warning is still effectively silent because trigger.js and
  sync-all-contexts.js discard successful-stage stderr. Needs a durable
  signal (stage marker field or a status-page-readable record), not a bigger
  log line. Open ticket; the fault-vs-contention rethrow itself IS fixed.

## Store-safety notes (recorded, deliberately not done — v1.8.12 review)

- `preserveUnreadable` naming: it either no-ops or throws — `refuseIfUnreadable`
  would telegraph the control flow; renaming touches three call-site files, do
  it whenever the module is next opened for real work.
- The `.unreadable-<ISO ms>` stamp collides only within one millisecond on one
  file, unreachable under the lock (first preserve removes the source). Same
  analysis class as the reclaim window: verified by reasoning, not CI.

## Follow-up items (not in the sites-3–8 conversion)

- **files_index.json cross-process race**: SUPERSEDED — the accepted design
  is the "Site 1" section below (cross-process file lock, RMW-scoped,
  canvasync-96). Kept here only as the original finding: bridge
  (storage.js:330 via /ingest/course-file) vs spawned extract stage
  (scripts/extract-course-files.js:326,604); pid suffixes hide the temp
  collision but not the lost update.
- **#2** collision-only path becomes reachable with any second extension
  instance (second Chrome profile) or future parallel ingest.
  bridge/test/ingest-idempotency.test.js:129-136 documents why its retries
  are sequential — that comment is the tripwire.

---

<!-- Section below written by canvasync-96 (design), accepted by the PM session
2026-08-29. Custody of this section is the author's; the rest of the doc is the
PM's. It supersedes the "files_index.json cross-process race" follow-up bullet
above, which posed the question this answers. -->

## Site 1 — accepted design (cross-process file lock)

Scope: the CROSS-PROCESS half of site 1 only. The in-process half
(writeCourseFile's read-modify-write across two awaits) is `write-lock.js`'s
job and is not re-solved here.

### 1. What the race actually is

Two directions, and they are not symmetric — which is what decides the design.

**Direction A — bridge clobbers extract.** `writeCourseFile` reads the whole
index (storage.js:270), then `await atomicWriteBinary` (a real file write,
possibly megabytes), then writes the whole array back (:330). If extract
finalizes inside that window, every per-file result of the pass —
`extractionStatus`, `materialsPath`, `textSha256` for ALL entries — reverts to
the bridge's snapshot. Damage: a whole extract pass discarded (LibreOffice/OCR,
minutes). SELF-HEALING, though: the bridge's write leaves files_index.json
newer than materials/last_extracted.txt, so trigger's mtime gate re-runs
extract. Loud, wasteful, temporary.

**Direction B — extract clobbers bridge.** A file ingested inside extract's
finalize window disappears from the index: invisible in the UI, never
extracted, until some later sync happens to re-upsert it. SILENT, and permanent
until coincidence fixes it.

B is the one that matters. It is a data set that fails by looking complete.

### 2. What is already mitigated — do not rebuild it

Extract is NOT naive. extract-course-files.js:611-637 already re-reads disk at
finalize and merges: entries the pass never saw are kept, and an entry the
bridge re-downloaded mid-pass (newer `lastSyncedAt`) keeps the DISK copy. There
is also a deliberate write-order protocol at :638-657 — marker FIRST when the
merge kept unprocessed entries so the stage stays stale, marker LAST on a clean
pass — with a comment explaining that swapping it strands mid-run ingests as
`pending` forever.

So direction B is roughly 90% closed already. The RESIDUAL window is real but
narrow: between `readJsonSafe(indexPath)` (:620) and `atomicWriteJson`
(:651/:654). In the `leftoverPending` branch there is a genuine await in
between — the marker write at :650 — so the window is a full file write wide,
not a few instructions.

Whatever lands must PRESERVE that merge as defence in depth, not replace it.

### 3. The three options

**Option 1 — route-level gate** (bridge refuses/queues ingest while extract is
active). **REJECTED.**

The flaw is not a tuning problem: trigger.js's `queued`/`active` Sets only know
stages THE BRIDGE SPAWNED. There is a second, independent spawner —
scripts/sync-all-contexts.js:201 spawns extract-course-files.js in its own
child process (spawn at :148) and never touches trigger.js. A gate that reports
safe while sync-all-contexts spawns extract unprotected would close this audit
item without closing the race. Manual `node scripts/extract-course-files.js
<dir>` is unprotected for the same reason.

Secondary failure modes even if that were fixed: extract runs for minutes, so
refusing ingest either drops the upload (extension retry budget) or holds an
HTTP request open for minutes — the "indistinguishable from a hang" state
MODEL-ORCHESTRATION.md already names for /api/ask. And a 503 the UI cannot
explain is a dead state under our own rule unless we also build a "waiting for
extraction" surface.

**Option 2 — cross-process lock, RMW-scoped. RECOMMENDED, ACCEPTED.**

Covers every writer regardless of who spawned it, because the rendezvous is the
filesystem, not one process's memory.

The decisive point: lock the READ-MODIFY-WRITE, never the pass. Expected hold
is one read plus one or two small writes — milliseconds for extract, one binary
write for the bridge. That single choice is what makes the stale-lock problem
tractable: a TTL can sit three orders of magnitude above the expected hold and
still be bounded. A lock held for a whole extract pass would need a
minutes-long TTL that cannot distinguish "slow" from "dead" — that is the
version that goes wrong.

**Option 3 — single-writer / sidecar** (extract writes results, bridge owns
files_index.json). **REJECTED ON COST**, though it is the cleanest idea.

The ownership split is real and already visible: storage.js:299-314 has the
bridge owning `canvasId`/`displayName`/`filename`/`contentType`/`size`/
`canvasUpdatedAt`/`localPath`/`lastSyncedAt`, and extract owning
`extractionStatus`/`extractionError`/`materialsPath`/`textSha256`/
`duplicateOf`/`skipped` — and storage.js:322-326 already hand-preserves
`materialsPath`, which is that split being enforced by hand today.

But the reader count is disqualifying for a race fix. The extraction-owned
fields are read by bridge/storage.js, bridge/textbooks.js,
bridge/public/material-links.js, bridge/public/app.js,
scripts/mine-assignments.js, scripts/build-pack.js, scripts/build-context.js,
scripts/index-progress.js, scripts/correlation-graph.js,
scripts/file-versions.js and scripts/sync-all-contexts.js — eleven modules
across three packages including browser code, with no single read chokepoint
(the bridge funnels through `readFilesIndex`, storage.js:210, but the scripts
each `readJsonSafe` the path directly). The variant that keeps readers
untouched — extract writes a sidecar, someone merges it back — relocates the
question to "which process merges, and what if two do", i.e. back to this same
race.

### 4. Accepted design — key and scope

Reuse the pattern this repo has ALREADY debugged in production rather than
inventing one. scripts/_util.js:229-302 is a working cross-process lock: atomic
`mkdir` (fails if held), pid file inside, stale reclaim by atomic rename-aside
to a unique tombstone rather than rm-by-path — with a comment recording why (a
slow waiter could otherwise delete a live winner's lock) — and an
EPERM-vs-ESRCH liveness check whose comment records the incident where
collapsing them loaded two ~20 GB models at once. It uses
`process.kill(pid, 0)`, a Node builtin: NO `ps` dependency, so it survives a
sandbox that denies process listing.

**Home.** A new package-root sibling to write-lock.js — `canvas-sync/file-lock.js`.
Node builtins only, importable from bridge/ and scripts/, same contract as
canvas-tasks.js and write-lock.js. The tombstone-reclaim logic is inherited BY
COPY, never by importing _util.js.

**Key.** One lock per guarded file, named by REALPATH of the class dir, not the
passed path:

    files_index@<realpath(classDir)>

Realpath so a symlinked class dir cannot yield two lock names for one inode —
the same reasoning as safe-delete rule 6 (storage.js:445).

**Lock location.** `<classDir>/.files_index.lock/`, a directory, beside the file
it guards. This is load-bearing for FIXTURE ISOLATION: under the fixture rule
the class dir ROOT is copied per class while `files/`, `materials/` and
`AI_CONTEXT/` are symlinked into real data. A lock in the class dir root is
therefore per-fixture and cannot leak. **A lock under `materials/` WOULD write
into real data during tests and must not be used.** A central
`<dataRoot>/locks/` keyed by a hash of the realpath is equally safe and
centralises cleanup; beside-the-file was chosen because it is self-evident to a
human reading the class dir.

**Hold scope.**

| Writer | Holds from | To | Expected hold |
|---|---|---|---|
| bridge | storage.js:270 (`readFilesIndex`) | :330 (`writeFilesIndex`), including the binary write | one file write |
| extract | :620 (finalize `readJsonSafe`) | :654 (`atomicWriteJson`) | milliseconds |

Extract holds across its finalize merge ONLY — never across the extraction
pass. Keep the existing merge inside the lock: belt and braces, and it stays
correct for any writer predating the lock.

**Composition with write-lock.js** — take the IN-PROCESS lock FIRST, then the
file lock:

    withWriteLock(classDir, () => withFileLock(classDir, fn))

Order matters. If two bridge requests both reach the file lock, the loser polls
the filesystem inside the same event loop for its whole deadline, burning it on
contention the in-process helper resolves for free. In-process serialises
siblings; the file lock only ever arbitrates between PROCESSES.

**Tuning** — deliberately different from the model lock, which is tuned for a
45-minute hold:

| Parameter | Value | Why |
|---|---|---|
| poll interval | 25–50 ms | model lock's 5000 ms is right for a 45-minute hold, absurd for a millisecond one |
| age threshold | ~15 s | ~1000× the expected hold, so a slow disk cannot trigger a false reclaim |
| bridge deadline | ~2 s, then a retryable 503 | the extension already retries; a 503 is honest and bounded, a held-open request is not |
| extract deadline | 30 s+, then proceed via its existing merge | batch job, no user waiting, and the merge is already the safe fallback |

### 5. Failure modes of this design

Stated because a design without them is a sales pitch.

- **Discipline, not enforcement.** The lock spans a read AND a write, so the
  helper cannot enforce its own use — a caller can still read and write
  unguarded. Mitigation: export `withFilesIndexLock(classDir, fn)` and make the
  guarded path the obvious one; consider renaming the raw `writeFilesIndex` so
  an unguarded call reads as unusual.
- **Steal races.** Two waiters could both judge a lock stale and both reclaim.
  The rename-aside tombstone (_util.js:247) already makes reclaim atomic —
  inherit it verbatim, do not re-derive it. Additionally write a random token
  into the pid file and re-read after acquiring to confirm ownership.
- **TTL vs a genuinely slow hold.** A very large binary write on a slow disk
  could exceed the age threshold. 15 s against a sub-second expected hold is
  wide, but if very large files are ever ingested, refresh the lock directory's
  mtime during the binary write.
- **Clock/host assumption.** All writers are local processes on one machine, so
  mtime comparison is sound. Written down because it stops being true the day
  anything runs over a network share.
- **It does not make the file format safer.** It serialises writers; it does not
  stop a buggy writer from writing nonsense. Extract's merge stays as the
  semantic guard.

### 6. Cost

| Approach | Blast radius |
|---|---|
| **Accepted (lock)** | 1 new helper + 2 call sites (storage.js, extract-course-files.js) + tests. Zero reader changes, no file-format change, no change to the marker/staleness protocol. |
| Sidecar | 11 modules across 3 packages including browser code, plus a redesign of the write-order protocol at extract-course-files.js:638-657. |
| Gate | ~1 call site, and it does not close the race. |

### 7. Verification plan (pre-approved)

- A real cross-process test — two SPAWNED CHILDREN, not two promises — racing an
  ingest against a finalize: fails without the lock, passes with it.
- A killed-holder reclaim test.
- A test that the lock is never held across the extraction pass, guarding
  against the tuning error that makes this design dangerous.
- Mutation checks that each of the above bites.
- A fixture-isolation assertion: a test run creates no lock inside a symlinked
  `materials/`.

### Follow-up ticket

- **files_index.json single-writer / sidecar refactor**: move the six
  extraction-owned fields out of files_index.json so extract and the bridge stop
  sharing a destination — architecturally right end state; **NOT a race fix**;
  11 readers across 3 packages. Must be scoped and scheduled as its own design
  item, never smuggled into a race fix.
