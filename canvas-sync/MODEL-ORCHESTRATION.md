<!-- Written by the PM session (canvasync-76), 2026-08-29. Produced by a
5-agent audit workflow (3 mappers, 24 call sites; 1 synthesizer; 1 adversarial
verifier who read every cited file). Verifier verdict: all load-bearing claims
confirmed against the code; corrections below are cosmetic and are the
authoritative reading where they conflict with the body. -->

# Model-Strength-Aware Orchestration — verified design proposal

STATUS: all 10 implementation items PROPOSED, none started.
Sequencing: items 1-4 as one release, then 5 and 7-10, item 6 last behind a flag.
Owner routing is the PM session's job; implementing agents update STATUS lines here.

## Verifier corrections (read first)

1. `mine-assignments.js` corpus has **twelve** uncapped-row-count section
   builders, not thirteen (header + blank + 12 in `corpusParts` L485-498).
2. `needsModel` is vocabulary of `scripts/index-progress.js` STAGES (L101
   parse, L131 mine, L147 build — three stages, count correct), NOT of
   `bridge/trigger.js`. Gating in trigger requires new wiring or importing the
   stage→needsModel map; trigger does not already carry the flag.
3. `parse-syllabus.js` L411 is `JSON.parse(extractJsonFromResponse(...))` —
   fence/brace extraction does run. The real gap stands: no
   `salvageFromResponse` attempt on repair output.
4. `_trySpawn` folds stderr into the rejection detail; the missing piece for
   `local_generate.py` overflow is a *structured* exit code, not error text.
   Note `exit(2)` is already taken (empty stdin) — pick a non-colliding code.
5. Anchor drift (substance unchanged): `normaliseHistory` L973;
   `getAmbiguities` spans L337-364, invoke L357, `deterministic_ambiguities`
   defined L279; `modelBlock` L110-144; empty-parse guard ~L440-476.
6. The hard-budgeted mining corpus portion is 500K chars (400K materials +
   100K syllabus); remaining sections are per-item-clipped but row-uncapped,
   so the true ceiling is unbounded. Strengthens the routing argument.

---

# Model-Strength-Aware Orchestration for CANVASync — Design Proposal

Grounded entirely in the audited call-site map. Anchors are `file:where` from the audit; all paths relative to `/Users/tempadmin/CANVASync/`.

---

## 1. Capability Profiles

### The gap being fixed
Today there is **zero machine-readable capability metadata**: the only context-window knowledge is a comment (`mine-assignments.js L25` — "Opus 5 has a 1M-token window"), the only quality-tier knowledge is shell prose (`setup-local-model.sh L14-15` — light tier "noticeably weaker at long syllabus extraction; adequate for chat"), and `local_generate.py` never checks prompt size against its window. `aiInvoke`'s full option surface is `{timeoutMs, model, codexModel, maxTokens}` (`_util.js L437-462`) — a caller cannot express "needs a strong model," and cannot even learn which backend answered.

### Proposed profile table

| Profile key | Resolves from | Tier | Input budget (chars) | Working budget (chars)* | Max output tokens | Cost class | Concurrency | Tools |
|---|---|---|---|---|---|---|---|---|
| `claude-cli` | authenticated claude CLI (Max-20x) | `strong` | 600,000 | 600,000 | 32,768 | `metered-large` | unbounded (no lock) | yes (`allowedTools`) |
| `codex-cli` | authenticated codex CLI (Plus) | `strong` | 250,000 | 250,000 | 32,768 | `metered-scarce` | unbounded | no (read-only sandbox) |
| `local-standard` | `CSYNC_LOCAL_MODEL` = Qwen3.6-35B-A3B-OptiQ-4bit | `standard` | 120,000 (hard) | 30,000 (quality) | 16,384 | `free` | 1 (machine-wide mkdir lock, `_util.js L252-302`) | no |
| `local-light` | `CSYNC_LOCAL_MODEL` = Qwen3-4B-Instruct-2507-4bit | `light` | 40,000 (hard) | 14,000 (quality) | 8,192 | `free` | 1 (same lock) | no |

\* *Working budget* = the size at which extraction quality is still trustworthy, distinct from the hard context limit. The audit's evidence for the split: class-chat's 20K-char budget works on local by design (`class-chat.js L46`), while the same model given the full mining corpus produces "a plausible list with every reading absent" (`mine-assignments.js L469-471` comment) and once returned `{}` for a whole syllabus (the BUSI 380 wipe, `parse-syllabus.js L446-475` guard).

Numbers for the two local tiers are initial estimates to be tuned; the point is they exist in code, not comments.

### Where it lives
- **New file `canvas-sync/scripts/model-profiles.js`** — a static map keyed by backend name and local model id, exported as `profileFor(backend, modelId)`. Kept next to `_util.js` because every reader (`aiInvoke`, `local_generate.py` via a `--max-input-tokens` flag, bridge status routes) resolves through `_util.js` already.
- `setup-local-model.sh L157-182` writes `CSYNC_LOCAL_MODEL` today; the tier table at its `L10-15` becomes redundant prose pointing at the JS map — the script's tier choice must map to a profile key that code can read.
- Surfaced at runtime through the two existing observability points: `GET /api/ai-cli` (`server.js L1860-1873`, which the audit flags as exposing *which* backend but "no context-size or tier field") and `modelBlock()` (`bridge/routes/index-progress.js L108-142`, where `localModelId` is currently "the closest thing to capability metadata anywhere").

### API change to `aiInvoke` (`_util.js L437-462`)
Two additions, both backward-compatible:
1. **`needs: { tier?: 'strong'|'standard'|'light', inputChars?: number, tools?: boolean }`** — auto mode skips any backend whose profile can't satisfy it instead of blindly failing over claude → codex → local (`_util.js L454-461`). `needs.tools` codifies in code what is today only the comment at `_util.js L432-436` (tool jobs must use `claudeInvoke`); local is text-only and gets skipped.
2. **Return `{ text, backend, model, tier }` instead of bare text** (or an `info` out-param for compatibility). The audit notes a caller "cannot even detect post hoc which backend answered" — this is prerequisite for the repair-call fix (§3), for `/api/ask` honesty (`server.js` gap: "used_model:true either way"), and for stamping `extraction_confidence` by tier.

When `needs` can't be satisfied by any available backend, `aiInvoke` throws a typed `ModelTierUnavailable` error — callers decide whether to degrade (deterministic path) or defer (see §4, item 6).

---

## 2. Routing Rules per Call Site

| Call site | Required tier | Why (payload vs. complexity) |
|---|---|---|
| `parse-syllabus.js` `parseWithClaude L218-225` | **`strong` preferred; `standard` allowed when payload ≤ working budget, with chunking (§3)** | Whole-syllabus → structured JSON is high-complexity, and payload is unbounded (49K-char BUSI 380 observed). Local already demonstrated the two failure modes: mid-schedule truncation (`salvageTruncatedJson L171-204` exists for this) and the `{}` empty parse. `light` tier: never — the setup script itself says it's weak at exactly this. |
| `parse-syllabus.js` `repairJson L227-231` | **Same-or-stronger than the failing attempt** | Repair without the source syllabus is pure reconstruction — the audit calls it the "highest hallucination surface in the parse stage." Routing the repair to a *weaker* backend (possible today when auto-failover state shifts between calls) is strictly worse than failing. |
| `mine-assignments.js` `main L511` | **`strong` only** (monolithic form); `standard`/`light` get the alternate path in §3 | The audit's "worst mismatch": corpus explicitly sized for a 1M window (~150K tokens, up to ~520K chars, budgets at `L25-36`) with thirteen uncapped-row-count sections. `needs: { inputChars: builtPromptLength }` lets auto mode refuse rather than ship it to local. |
| `mine-assignments.js` repair `L516-519` | Same-or-stronger as first attempt | Same reconstruction logic; worse odds — longest JSON in the pipeline and the schema is only *referenced*, never re-sent. |
| `build-context.js` `getAmbiguities L357` | **`strong` or skip straight to deterministic** | Unique property from the audit: a crashed model produces *better* output than a weak one that answers, because any non-empty text is accepted verbatim into AI_CONTEXT with zero validation, while failure falls back to `deterministic_ambiguities()` (`L338-363`) — "the correct list." So on `standard`/`light`, don't call the model at all; the deterministic path is already the product. Also stops a "cosmetic ambiguity note" from queueing 45 min on the model lock. |
| `class-chat.js` `answerQuestion L1429-1500` | **`light` and up — no change** | This is the reference small-model design: 20K-char source budget, 8 sources, precomputed FACTS, single pass, refuses to invoke on empty retrieval (`L1469-1482`), `cleanAnswer` strips fabricated citations. Declare `needs: { tier: 'light' }` explicitly so routing intent is in code. |
| `server.js` `POST /api/ask → runAsk L1420-1506` | Delegates to class-chat's tier; **fix the fallback bypass** | The audited gap: under `auto`, a mid-request CLI failure falls through to `localInvoke` *inside* the admitted request (`_util.js L454-461`), bypassing the local-lock 503 pre-check (`L1485-1492`) and holding the single `askInFlight` slot up to 45 min — "precisely the indistinguishable-from-a-hang state the 503 was built to prevent." Fix: resolve the backend once at admission; pass `failover: false` (new option) so a CLI failure returns an error the route can turn into a retryable 503, and re-run the lock pre-check if the resolved backend is local. Also return the actual answering backend (from the new `aiInvoke` return) so the UI stops showing a provider "that can differ from the one that actually answered." |
| `trigger.js` stage spawner (`~L207`) | Gate the three `needsModel` stages by resolved tier **before** spawning | Children inherit the same env and resolve the same chain; today a light-tier machine runs the full Opus-sized pipeline. Pre-flight: resolve profile once per run, pass `CSYNC_RESOLVED_TIER` to children, and mark strong-only stages *deferred* instead of spawning them (§4, item 6). |
| `local_generate.py` `main L20-49` | n/a (runner) | Add the missing input check: estimate/tokenize the stdin prompt against the profile's hard input budget and exit with a **distinct exit code** on overflow, so the Node caller (which today "sees only exit code and stdout") can distinguish "prompt too big" from "model failed" and never burns an hours-long lock-held generation on a doomed prompt. |
| Status surfaces (`/api/ai-cli`, `index-progress.js` `modelBlock`) | n/a | Add `tier`, `inputBudgetChars`, and a computed `fits: {mining, parse, chat}` flag so the dashboard can warn "pipeline corpus too big for local" — the exact field the audit says doesn't exist. |

---

## 3. Chunking Strategy for the Large-Payload Sites

Matched to the small model's *observed* limits: truncates long JSON output around 8-16K tokens, loses items from big corpora silently, fabricates when repairing without source, but handles ~20K-char retrieval prompts well (class-chat's proof).

### `parse-syllabus.js` — sectioned two-pass on `standard` tier
When routing lands on `local-standard` and the syllabus exceeds the working budget:
- **Pass A (one call):** course metadata, grading weights, policies from the first ~14K chars (this content is front-loaded in real syllabi). Small output — well inside the 8192 default.
- **Pass B (map):** schedule extraction over ~12K-char windows with 1K overlap, each asking only for schedule items as a JSON array. Small per-chunk output kills the truncation-mid-schedule failure that `salvageTruncatedJson` patches today.
- **Reduce (deterministic, no model):** merge arrays, dedupe on (date, title-normalized), then `validateResult` as now. Stamp `extraction_confidence: medium` and a `chunked_extraction` note — consistent with the existing truncation-note convention.
- Keep the empty-parse guard (`L446-475`) exactly as is; it applies per merged result.
- On `strong` tier: unchanged single-shot.

### `mine-assignments.js` — deterministic-core + per-file map on non-strong tiers
Map-reduce with a strong-model reduce is incoherent here — if a strong model is available, the existing single-shot already fits it. So the non-strong path must not depend on a strong reducer:
- **Deterministic core first (already exists):** Canvas assignments/quizzes are ground truth (**Canvas-is-truth** memory) and need no model; the readings index is already built *before* the AI call (`L469-472`) as insurance. Promote these from "insurance" to "the local-tier output": emit `assignments_mined.json` from Canvas rows + readings index rows directly, each stamped `origin: deterministic`.
- **Map (optional, per file):** one small call per course material (≤ working budget: the existing `PER_MATERIAL_CHARS 8000` clip is already local-sized) asking only "tasks/readings mentioned in THIS file," schema included in every prompt. Skippable under a stage flag — it's additive enrichment, not the floor.
- **Reduce (deterministic):** merge through the existing `validateMined` (`L288`) — its canvas-id verification against `assignments.json` and materials-name resolution are precisely the anti-hallucination reducer needed; invented ids already demote to `implicit`.
- Never send the 520K-char corpus to any local model. If the user wants full-corpus inference, that is a `strong`-tier deferred stage (§4, item 6).

### Both repair calls (`parse-syllabus.js L410`, `mine-assignments.js L516-519`) — fix, not chunk
Three defects, all cited in the audit, all cheap:
1. `maxTokens` must be ≥ the original attempt's (16384), not the 8192 default — today "structurally guaranteed to re-truncate" on local.
2. Re-send the schema (and for parse, ideally a syllabus excerpt) — repairing from broken output alone is "pure invitation to fabricate."
3. Port `salvageTruncatedJson` into mine-assignments (currently absent — "a local-model truncation costs the entire mining run") and run salvage on the repair output too (`parse-syllabus.js L411` is a bare `JSON.parse` today).
Plus the routing rule from §2: repair pinned to same-or-stronger backend via the new return metadata.

### `build-context.js getAmbiguities` — no chunking; gate and validate
On non-strong tiers, return `deterministic_ambiguities()` without invoking (the audit shows this is the better output anyway). On strong tier, add minimal validation before the text ships into AI_CONTEXT: strip code fences/preambles, cap length, require bullet shape — today "ANY non-empty text is accepted verbatim."

### `class-chat.js` / `/api/ask` — already retrieval-first; close two bounds
- Clamp per-turn history *content* (e.g., 2,000 chars/turn) in `normaliseHistory` (`class-chat.js L975`) — the audit's only unbounded input on the local-safe path (route caps turn count at `server.js L1498`, never turn length).
- Optionally scale `DEFAULT_BUDGET_CHARS` down from the profile (`light` → ~14K); the plumbing (`--budget`) already exists.

---

## 4. Prioritized Implementation List

| # | Files | Change | Size | Risk | Invariants respected |
|---|---|---|---|---|---|
| 1 | `scripts/model-profiles.js` (new), `scripts/_util.js` | Profile map; `aiInvoke` returns `{text, backend, model, tier}`; accept `needs{tier,inputChars,tools}` + `failover` option; auto mode skips non-fitting backends; typed `ModelTierUnavailable`. | **M** | Low — additive; existing callers ignore new fields. Test alongside `scripts/test/ai-providers.test.js` (keep key-stripping + fail-closed auth assertions intact). | Subscription-OAuth-only env stripping unchanged (`subscriptionCliEnv L68-74`). |
| 2 | `scripts/parse-syllabus.js L410`, `scripts/mine-assignments.js L516-519` | Repair fixes: `maxTokens: 16384`, schema re-sent, salvage ported to mining + run on repair output, repair pinned same-or-stronger. | **S** | Low — strictly reduces failure modes; `.ERROR` sidecar + previous-file preservation behavior unchanged. | Empty-parse guard (BUSI 380) untouched; previous good outputs still never overwritten on failure. |
| 3 | `bridge/server.js L1420-1506` | `/api/ask`: resolve backend at admission, `failover:false`, re-check local lock on the resolved backend, surface actual answering backend/tier in the response and `/ask/status`. | **S** | Medium — changes failure behavior: a mid-request CLI failure now 503s instead of silently answering from local. That is the designed behavior per the route's own 503 rationale. | Single-flight slot semantics (`L1425-1438`) unchanged. **No-dead-states**: 503 body must carry provider + retry hint the UI already renders for "model busy." |
| 4 | `scripts/local_generate.py`, `scripts/_util.js localInvoke` | Input-size check against profile hard budget; distinct exit code; `localInvoke` maps it to a typed error before the 45-min lock wait is entered. | **S** | Low. | Lock discipline unchanged; failing fast *protects* the lock. |
| 5 | `scripts/parse-syllabus.js` | Chunked two-pass local path (§3), gated on resolved tier + payload size; single-shot on strong unchanged. | **M** | Medium — merge logic is new; mitigate with fixture tests (`scripts/test/parse-syllabus.test.js`, `syllabus-guard.test.js` already cover the guard). | Empty-parse guard applies to merged result; confidence stamping convention kept. **Canvas-is-truth**: syllabus may add, never override — unchanged, this is upstream of that merge. |
| 6 | `scripts/mine-assignments.js`, `bridge/trigger.js ~L207`, `scripts/index-progress.js` STAGES, dashboard | Non-strong mining path: deterministic core + optional per-file map + `validateMined` reduce; trigger gates strong-only monolithic mining and marks it **deferred, with reason** ("needs strong model — sign in to Claude/Codex"), surfaced by index-progress and the dashboard with the existing `/api/ai-cli/login` action as the remedy. | **L** | Medium-high — the biggest behavior change; ship behind a `CSYNC_STAGE_*`-style flag first (kill-switch pattern already exists in `sync-all-contexts.js`). | **Canvas-is-truth**: deterministic core is literally Canvas rows. **No-dead-states**: a deferred stage must render as a state with an explanation and a login action, never an empty panel. **Strict allowlist**: stage gating is per-backend, never per-class — must not touch class selection semantics. Staleness: a deferred stage must not read as "stale" and bait the 20GB-load button (`index-progress.js L356` warning). |
| 7 | `scripts/build-context.js L337-364` | Tier-gate `getAmbiguities` (non-strong → deterministic list, no invocation); validate strong-tier output before writing to AI_CONTEXT. | **S** | Low — deterministic fallback is pre-existing and audited as correct. | Frees the model lock from cosmetic work; AI_CONTEXT stops ingesting unvalidated text. |
| 8 | `scripts/class-chat.js L975, L46`, `bridge/server.js L1498` | Per-turn history char clamp; profile-scaled source budget on light tier. | **S** | Low. | Preserves the "retrieval + one local pass, no fan-out" architecture memory verbatim. |
| 9 | `bridge/server.js /api/ai-cli L1860-1873`, `bridge/routes/index-progress.js modelBlock L108-142`, `bridge/public/app.js L5156-5229` | Expose `tier` / input budget / per-stage `fits` flags; Settings card warns when the selected backend can't run mining/parse monolithically. | **S** | Low — read-only surfaces. | **No-dead-states / no dead text**: warning appears only when actionable, wired to the login/setup flows. |
| 10 | `scripts/setup-local-model.sh L10-15, L157-182` | Tier choice writes a profile key consumable by `model-profiles.js`; prose capability comment retired in favor of the map. | **S** | Low. | Settings read per-call, no restart — pattern preserved. |

**Sequencing:** 1→2→3→4 are one release (plumbing + the three cheapest audited defects); 5 and 7→8→9→10 next; 6 last, flagged. Per the versioned-push memory: each item lands as its own tagged push with package version bumps.

**Explicitly out of scope / unchanged:** `build-pack.js` and `extract-course-files.js` (audited zero-AI), `resolveClass` (deterministic, no model), the machine-wide model lock design (it is the correct concurrency=1 enforcement for both local profiles), and API-key handling (subscription OAuth only, keys stripped — no routing change may reintroduce them).
