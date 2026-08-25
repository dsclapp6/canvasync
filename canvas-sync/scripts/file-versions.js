// Which copy of a file is the current one.
//
// Canvas does not version files. A professor who re-uploads a corrected
// syllabus gets a NEW file object with a NEW id, and the old one stays in the
// course. Both come down the wire, both are stored, and — until this file
// existed — both were extracted and both were concatenated into
// materials/_combined.txt under the SAME heading:
//
//   === [PDF] syllabus_Busi 305-Fall 2026.pdf ===     (uploaded 2026-07-30)
//   === [PDF] syllabus_Busi 305-Fall 2026.pdf ===     (uploaded 2026-08-24)
//
// So every downstream reader — the miner, the class pack, the search index —
// saw one syllabus twice, disagreeing with itself about dates and weights, with
// nothing in the text saying which half was current. The dedupe pass upstream
// could not help: it keys on textSha256, and the whole point of a corrected
// syllabus is that its text is different.
//
// The rule: within one class, entries sharing a display name are the same
// document, and the most recently updated one is the current version. The rest
// are superseded — kept on disk, dropped out of everything that feeds the AI.
//
// REFUSAL, in the same spirit as the calendar's "no time beats a wrong time":
// when two copies cannot be ordered — neither carries an update stamp, neither
// carries a sync stamp — nothing is superseded. Hiding the copy that turns out
// to be current is a worse failure than showing both.
//
// Pure: no fs, no network, no Node builtins. The bridge, the scripts and the
// tests all load it, and it is trivially testable because it only ever looks
// at an array of index entries.

/**
 * The identity of a document across re-uploads.
 *
 * Canvas's own display name, normalised for case and whitespace. NOT the local
 * path: writeCourseFile appends `-<canvasId>` to the second copy's filename to
 * avoid clobbering the first, so the local paths of two versions differ by
 * construction and are useless as identity. The extension is kept — a professor
 * posting Notes.pdf beside Notes.pptx has posted two documents, not two
 * versions of one.
 */
export function versionKey(entry) {
  const name = entry?.displayName || entry?.filename || '';
  const s = String(name).replace(/\s+/g, ' ').trim().toLowerCase();
  return s || null;
}

function stamp(entry) {
  const t = Date.parse(entry?.canvasUpdatedAt ?? '');
  return Number.isFinite(t) ? t : null;
}

function synced(entry) {
  const t = Date.parse(entry?.lastSyncedAt ?? '');
  return Number.isFinite(t) ? t : null;
}

/**
 * Order two copies of one document, newest first. Returns 0 when they cannot
 * be told apart at all — the caller treats that as ambiguity, not as a tie to
 * break arbitrarily.
 */
function compareVersions(a, b) {
  const [sa, sb] = [stamp(a), stamp(b)];
  if (sa !== null && sb !== null && sa !== sb) return sb - sa;
  // Canvas said nothing useful; when we first saw each copy is the next best
  // evidence, and it is evidence we generated rather than guessed.
  const [ya, yb] = [synced(a), synced(b)];
  if (ya !== null && yb !== null && ya !== yb) return yb - ya;
  // Canvas ids are assigned in ascending order, so a higher id is a later
  // upload. Weakest signal of the three, and only used when both are numeric.
  const [ia, ib] = [Number(a?.canvasId), Number(b?.canvasId)];
  if (Number.isFinite(ia) && Number.isFinite(ib) && ia !== ib) return ib - ia;
  return 0;
}

/**
 * Resolve a class's files_index into current and superseded copies.
 *
 * Returns, without mutating the input:
 *   current      canvasIds that are the live version of their document
 *   superseded   [{ canvasId, supersededBy, key, reason }]
 *   ambiguous    [{ key, canvasIds }] — same name, no way to order them
 *
 * A group of one is current by definition, so the common case costs nothing.
 */
export function resolveFileVersions(index) {
  const entries = (Array.isArray(index) ? index : []).filter(e => e && e.canvasId != null);
  const groups = new Map();
  for (const e of entries) {
    const key = versionKey(e);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const current = [];
  const superseded = [];
  const ambiguous = [];

  for (const [key, group] of groups) {
    if (group.length === 1) { current.push(group[0].canvasId); continue; }

    const sorted = [...group].sort(compareVersions);
    const [winner, ...rest] = sorted;
    // Every copy the winner cannot be proved newer than makes the whole group
    // undecidable: promoting one of an unordered pair hides a file that may be
    // the real current one.
    const unordered = rest.filter(e => compareVersions(winner, e) === 0);
    if (unordered.length) {
      ambiguous.push({ key, canvasIds: group.map(e => e.canvasId) });
      for (const e of group) current.push(e.canvasId);
      continue;
    }

    current.push(winner.canvasId);
    for (const loser of rest) {
      superseded.push({
        canvasId: loser.canvasId,
        supersededBy: winner.canvasId,
        key,
        reason: stamp(loser) !== null && stamp(winner) !== null ? 'canvas_updated_at'
          : synced(loser) !== null && synced(winner) !== null ? 'first_seen'
            : 'canvas_id_order',
      });
    }
  }
  return { current, superseded, ambiguous };
}

// ---------------------------------------------------------------------------
// What actually changed.
//
// Deterministic and local: line multisets, not an LCS and certainly not a model
// call. The question a student asks of a re-uploaded syllabus is "what moved",
// and counted added/removed lines with a handful of samples answers it in a
// sentence. It runs on a machine with no network and no subscription, which is
// the whole point of the app being shareable.
// ---------------------------------------------------------------------------

const NOISE = /^[\s ]*$/;

function lineBag(text) {
  const bag = new Map();
  let total = 0;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (NOISE.test(line)) continue;
    bag.set(line, (bag.get(line) ?? 0) + 1);
    total += 1;
  }
  return { bag, total };
}

/**
 * A short, printable account of the difference between two extracted texts.
 *
 * `sample` holds up to `samples` of each side, in the order they appear in the
 * new text (added) and the old text (removed), so the summary reads like the
 * document rather than like a hash table.
 */
export function diffSummary(oldText, newText, { samples = 3 } = {}) {
  const a = lineBag(oldText);
  const b = lineBag(newText);

  const removed = [];
  const added = [];
  let removedCount = 0;
  let addedCount = 0;

  const seenOld = new Map(a.bag);
  for (const [line, n] of b.bag) {
    const had = seenOld.get(line) ?? 0;
    if (n > had) addedCount += n - had;
  }
  const seenNew = new Map(b.bag);
  for (const [line, n] of a.bag) {
    const has = seenNew.get(line) ?? 0;
    if (n > has) removedCount += n - has;
  }

  // Samples in document order, so they read as prose.
  const budgetAdd = new Map(a.bag);
  for (const raw of String(newText ?? '').split('\n')) {
    if (added.length >= samples) break;
    const line = raw.replace(/\s+/g, ' ').trim();
    if (NOISE.test(line)) continue;
    const left = budgetAdd.get(line) ?? 0;
    if (left > 0) { budgetAdd.set(line, left - 1); continue; }
    added.push(line.slice(0, 160));
  }
  const budgetRm = new Map(b.bag);
  for (const raw of String(oldText ?? '').split('\n')) {
    if (removed.length >= samples) break;
    const line = raw.replace(/\s+/g, ' ').trim();
    if (NOISE.test(line)) continue;
    const left = budgetRm.get(line) ?? 0;
    if (left > 0) { budgetRm.set(line, left - 1); continue; }
    removed.push(line.slice(0, 160));
  }

  // A line that was EDITED shows up once on each side; counting both would
  // report a one-line correction in a three-line document as 67% changed.
  // max() treats an edit as one changed line and still counts a pure insertion.
  const denom = Math.max(a.total, b.total, 1);
  return {
    added: addedCount,
    removed: removedCount,
    changedPct: Math.round((Math.max(addedCount, removedCount) / denom) * 100),
    identical: addedCount === 0 && removedCount === 0,
    sample: { added, removed },
  };
}

/** One sentence a UI can print unchanged. */
export function describeDiff(d) {
  if (!d) return null;
  if (d.identical) return 'The text is identical to the version it replaced.';
  const parts = [];
  if (d.added) parts.push(`${d.added} line${d.added === 1 ? '' : 's'} added`);
  if (d.removed) parts.push(`${d.removed} line${d.removed === 1 ? '' : 's'} removed`);
  return `${parts.join(', ')} (${d.changedPct}% of the document).`;
}
