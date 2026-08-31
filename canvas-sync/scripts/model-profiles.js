// model-profiles.js — what each AI backend can actually be trusted to do.
//
// Before this file, every capability fact in the pipeline lived in prose: the
// only context-window knowledge was a comment in mine-assignments.js ("Opus 5
// has a 1M-token window"), the only quality-tier knowledge was shell text in
// setup-local-model.sh ("noticeably weaker at long syllabus extraction"), and
// aiInvoke's whole option surface was {timeoutMs, model, codexModel,
// maxTokens} — a caller could not say "this job needs a strong model" and
// could not learn afterwards which backend answered. So auto mode failed over
// claude -> codex -> local blindly, and the 520K-char mining corpus went to a
// 4-bit local model exactly as readily as to Opus.
//
// The failure that motivates it is not a crash. A local model handed the whole
// mining corpus returns "a plausible list with every reading absent", and once
// returned {} for an entire syllabus (the BUSI 380 wipe). Silently-wrong
// output is the thing to refuse, which is why the numbers below are a
// MACHINE-READABLE table and not another comment.
//
// Node builtins only, no imports at all — _util.js loads it, and the bridge
// status routes will too.

// --- Tiers ------------------------------------------------------------------
// Ordered weakest to strongest. A job asking for `standard` is satisfied by
// `strong`; never the reverse.
export const TIERS = ['light', 'standard', 'strong'];
const TIER_RANK = { light: 1, standard: 2, strong: 3 };

/** Numeric rank of a tier name, or 0 for anything unrecognised. */
export function tierRank(tier) {
  return TIER_RANK[tier] || 0;
}

/** Is `tier` at least as strong as `required`? */
export function tierAtLeast(tier, required) {
  return tierRank(tier) >= tierRank(required);
}

// --- The table --------------------------------------------------------------
//
// inputBudgetChars  the hard ceiling — beyond it the backend cannot take the
//                   prompt at all.
// workingBudgetChars the size at which extraction quality is still
//                   trustworthy. For the CLIs the two are the same; for local
//                   they are not, and the gap is the whole point. Evidence:
//                   class-chat's 20K-char budget works on local by design,
//                   while the same model on the full mining corpus drops
//                   items silently. `needs.inputChars` is checked against the
//                   WORKING budget, because shipping a prompt a backend can
//                   physically accept but cannot do justice to is the exact
//                   silent-wrong-answer failure this table exists to stop.
// concurrency       null means unbounded. Local is 1 — enforced machine-wide
//                   by the mkdir lock in _util.js, because the model is ~20 GB
//                   of RAM and two at once hard-freeze the Mac.
// tools             can the backend run tools/MCP? Only the claude CLI can;
//                   this codifies in data what was a comment above aiInvoke
//                   ("jobs that need Claude tools must call claudeInvoke").
//
// The two local rows' numbers are initial estimates, deliberately conservative
// and meant to be tuned. The CLI rows are their published context windows
// expressed in chars, cut well below the true ceiling so a budget check never
// depends on our chars-per-token guess being right.
const TABLE = {
  'claude-cli': {
    key: 'claude-cli',
    backend: 'claude',
    tier: 'strong',
    inputBudgetChars: 600_000,
    workingBudgetChars: 600_000,
    maxOutputTokens: 32_768,
    costClass: 'metered-large',
    concurrency: null,
    tools: true,
  },
  'codex-cli': {
    key: 'codex-cli',
    backend: 'codex',
    tier: 'strong',
    inputBudgetChars: 250_000,
    workingBudgetChars: 250_000,
    maxOutputTokens: 32_768,
    costClass: 'metered-scarce',
    concurrency: null,
    // Non-interactive codex runs in a read-only sandbox: it can reason, it
    // cannot act. Tool jobs must not route here.
    tools: false,
  },
  'local-standard': {
    key: 'local-standard',
    backend: 'local',
    tier: 'standard',
    inputBudgetChars: 120_000,
    workingBudgetChars: 30_000,
    maxOutputTokens: 16_384,
    costClass: 'free',
    concurrency: 1,
    tools: false,
  },
  'local-light': {
    key: 'local-light',
    backend: 'local',
    tier: 'light',
    inputBudgetChars: 40_000,
    workingBudgetChars: 14_000,
    maxOutputTokens: 8_192,
    costClass: 'free',
    concurrency: 1,
    tools: false,
  },
};

export const PROFILE_KEYS = Object.keys(TABLE);

// setup-local-model.sh installs one of exactly two models and records the
// choice as CSYNC_LOCAL_MODEL (it writes the model id, not a tier name — so
// the id is what we have to resolve from). Keep these two in step with
// STANDARD_MODEL / LIGHT_MODEL in that script.
export const LOCAL_MODEL_PROFILES = {
  'mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit': 'local-standard',
  'mlx-community/Qwen3-4B-Instruct-2507-4bit': 'local-light',
};

/**
 * The profile for a backend, or null if there is no such backend.
 *
 * `modelId` is consulted only for `local`, where the installed model decides
 * the tier; the CLIs' capabilities are a property of the subscription, not of
 * the model alias a caller happens to pin.
 *
 * An UNRECOGNISED local model id resolves to the light profile and is marked
 * `assumed: true`. That direction is deliberate: guessing low costs a job that
 * is refused or chunked and says so, while guessing high costs a syllabus
 * quietly extracted wrong, which is the failure this module exists to prevent.
 * Callers that surface capability to the user should render `assumed` as
 * "unrecognised model — treated as light tier" rather than stating it as fact.
 */
export function profileFor(backend, modelId = null) {
  if (backend === 'claude') return { ...TABLE['claude-cli'], modelId: modelId || null };
  if (backend === 'codex') return { ...TABLE['codex-cli'], modelId: modelId || null };
  if (backend !== 'local') return null;
  const key = LOCAL_MODEL_PROFILES[modelId];
  if (key) return { ...TABLE[key], modelId, assumed: false };
  return { ...TABLE['local-light'], modelId: modelId || null, assumed: true };
}

/** A profile by table key (`claude-cli`, `local-light`, ...), or null. */
export function profileByKey(key) {
  return TABLE[key] ? { ...TABLE[key] } : null;
}

const NEEDS_KEYS = new Set(['tier', 'inputChars', 'tools']);

/**
 * Validate a `needs` object, loudly.
 *
 * A misspelled key or tier is not a runtime condition to route around — it is
 * a caller bug that would silently disable the whole check and send the job to
 * a backend that cannot do it. `{ teir: 'strong' }` must not read as "no
 * requirements".
 */
export function assertNeeds(needs) {
  if (needs == null) return;
  if (typeof needs !== 'object' || Array.isArray(needs)) {
    throw new TypeError('needs must be an object like { tier, inputChars, tools }');
  }
  for (const key of Object.keys(needs)) {
    if (!NEEDS_KEYS.has(key)) {
      throw new TypeError(`unknown needs key: ${key} (expected ${[...NEEDS_KEYS].join(', ')})`);
    }
  }
  if (needs.tier != null && !TIER_RANK[needs.tier]) {
    throw new TypeError(`unknown tier: ${needs.tier} (expected ${TIERS.join(', ')})`);
  }
  if (needs.inputChars != null && !(Number.isFinite(needs.inputChars) && needs.inputChars >= 0)) {
    throw new TypeError('needs.inputChars must be a non-negative number of characters');
  }
  if (needs.tools != null && typeof needs.tools !== 'boolean') {
    throw new TypeError('needs.tools must be a boolean');
  }
}

/**
 * Can `profile` do a job described by `needs`?
 *
 * Returns { ok, reason }. `reason` is written to be shown to a person — it
 * ends up in stderr, in a ModelTierUnavailable message, and eventually in the
 * dashboard's explanation of why a stage was deferred.
 */
export function satisfies(profile, needs) {
  if (needs == null) return { ok: true, reason: null };
  assertNeeds(needs);
  if (!profile) return { ok: false, reason: 'no capability profile for this backend' };

  if (needs.tier != null && !tierAtLeast(profile.tier, needs.tier)) {
    return {
      ok: false,
      reason: `${profile.key} is ${profile.tier} tier, job needs ${needs.tier} or stronger`,
    };
  }
  if (needs.inputChars != null && needs.inputChars > profile.workingBudgetChars) {
    return {
      ok: false,
      reason: `${Math.round(needs.inputChars / 1000)}K-char prompt exceeds ${profile.key}'s `
        + `${Math.round(profile.workingBudgetChars / 1000)}K-char working budget`,
    };
  }
  if (needs.tools === true && !profile.tools) {
    return { ok: false, reason: `${profile.key} is text-only and cannot run tools` };
  }
  return { ok: true, reason: null };
}

/**
 * Nothing available can do the job.
 *
 * Typed (and carrying `considered`) so a caller can tell this apart from "the
 * backend was right but the call failed" and decide between degrading to its
 * deterministic path and deferring the stage with a reason a user can act on.
 */
export class ModelTierUnavailable extends Error {
  constructor(message, { needs = null, considered = [] } = {}) {
    super(message);
    this.name = 'ModelTierUnavailable';
    // Stable discriminator, matching file-lock.js's ELOCKTIMEOUT convention:
    // callers should branch on the code, not on the message text.
    this.code = 'EMODELTIER';
    this.needs = needs;
    this.considered = considered;
  }
}

/** Build the ModelTierUnavailable for a set of rejected candidates. */
export function tierUnavailable(needs, considered) {
  const detail = considered.length
    ? considered.map(c => `${c.name}: ${c.reason}`).join('; ')
    : 'no backend is available at all';
  const want = [
    needs?.tier ? `tier ${needs.tier}` : null,
    needs?.inputChars != null ? `${Math.round(needs.inputChars / 1000)}K chars of input` : null,
    needs?.tools ? 'tool support' : null,
  ].filter(Boolean).join(', ') || 'the requested capabilities';
  return new ModelTierUnavailable(
    `no available AI backend provides ${want} (${detail})`,
    { needs, considered },
  );
}

/**
 * The `needs` a follow-up call must carry so it cannot land on a WEAKER
 * backend than the one that already answered.
 *
 * For the JSON-repair calls this is the whole ballgame. A repair prompt is
 * pure reconstruction — it carries the broken output and the schema, not the
 * source syllabus or corpus — which makes it the highest hallucination
 * surface in the pipeline. Under auto failover the backend can change between
 * the first attempt and the repair (a CLI's auth expires, a status probe
 * flaps), and a repair answered by a weaker model than the one that just
 * failed is strictly worse than no repair at all: it returns confident,
 * well-formed, invented content instead of an error the caller can act on.
 *
 * `info` is aiInvoke's out-param. It is EMPTY when the first attempt threw
 * rather than answering, and then there is nothing to pin to — this returns
 * null, leaving routing exactly as it is today rather than inventing a floor
 * that would refuse a repair currently attempted.
 *
 * Note what a tier pin does and does not promise: it constrains STRENGTH, not
 * identity. Claude and Codex are both `strong`, so a repair may legitimately
 * move between them; that is the doc's contract ("same-or-stronger"), not a
 * gap. And a `light` pin is satisfied by every backend, so pinning the weakest
 * tier is a no-op by construction — correctly, since nothing is weaker.
 */
export function sameOrStronger(info) {
  const tier = info?.tier;
  return tier && TIER_RANK[tier] ? { tier } : null;
}
