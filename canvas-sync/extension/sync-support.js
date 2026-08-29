// sync-support.js — the parts of the sync loop that are worth testing on their
// own. No chrome.* access, no network: every dependency arrives as an argument,
// so background.js keeps the wiring and this file keeps the reasoning.
//
// Five jobs, all of them fixes for silent failure:
//   1. serialising read-modify-write appends, so concurrent writers stop
//      clobbering each other's log lines;
//   2. carrying per-file outcome counts out of the download loop, so a sync
//      that skipped half a course can say so after the fact;
//   3. telling an expired download URL apart from a real permission denial,
//      which Canvas reports with the same status code;
//   4. measuring what was actually downloaded rather than what Canvas said it
//      would be, and deciding when a repeated failure is worth a second alert;
//   5. deciding which failures are worth a second attempt at all.

// --- Serialised append ------------------------------------------------------

/**
 * An appender that adds to a capped list in a key-value store.
 *
 * chrome.storage has no transaction. `read, push, write` from two callers
 * interleaves as read-read-write-write, and the second write carries a list
 * that never saw the first entry — so the first is gone. That is not a
 * theoretical race here: COURSE_CONCURRENCY is 3 and the per-file loop warns
 * on every failure, which is exactly when the log matters most and exactly
 * when it was least trustworthy.
 *
 * Every append queues on one chain, so each read happens after the previous
 * write has landed. The chain is deliberately kept unrejected: a storage
 * hiccup must lose one entry, not wedge every append that follows it.
 */
export function makeSerialAppender({ get, set }) {
  let chain = Promise.resolve();
  return function append(key, entry, cap) {
    const run = chain.then(async () => {
      const data = await get([key]);
      const list = Array.isArray(data?.[key]) ? data[key].slice() : [];
      list.push(entry);
      const trimmed = cap > 0 ? list.slice(-cap) : list;
      await set({ [key]: trimmed });
      return trimmed;
    });
    chain = run.then(() => {}, () => {});
    return run;
  };
}

// --- Per-file outcome counts ------------------------------------------------

// `refreshed` is not a failure: it counts files that 403'd on a stale URL and
// came back on a fresh one. It is here to make the expiry rate measurable,
// because until now those files were simply absent and called "forbidden".
export const FILE_COUNT_KEYS = [
  'done', 'total', 'skippedForbidden', 'skippedSize',
  'skippedUnchanged', 'errored', 'refreshed',
];

export function emptyFileCounts() {
  return Object.fromEntries(FILE_COUNT_KEYS.map(k => [k, 0]));
}

export function addFileCounts(a, b) {
  const out = emptyFileCounts();
  for (const k of FILE_COUNT_KEYS) {
    out[k] = (Number(a?.[k]) || 0) + (Number(b?.[k]) || 0);
  }
  return out;
}

/**
 * Sum the files_download counts across every course in a progress state.
 * Courses that never reached the download step contribute nothing rather than
 * NaN, because a sync cancelled early is the common way to get a partial map.
 */
export function rollUpFileCounts(courses) {
  let total = emptyFileCounts();
  for (const course of Object.values(courses ?? {})) {
    const counts = course?.items?.files_download?.counts;
    if (counts) total = addFileCounts(total, counts);
  }
  return total;
}

/**
 * One line for the popup, or null when there is nothing worth saying.
 *
 * Only the exceptions are named. "142 files" on a clean run is a number the
 * user already trusts; the reason this exists is the run where 40 of them did
 * not arrive, which previously looked identical.
 */
export function formatFileCounts(counts) {
  if (!counts) return null;
  const n = k => Number(counts[k]) || 0;
  const notable = [];
  if (n('skippedForbidden')) notable.push(`${n('skippedForbidden')} not permitted`);
  if (n('skippedSize'))      notable.push(`${n('skippedSize')} too large`);
  if (n('errored'))          notable.push(`${n('errored')} failed`);
  if (n('refreshed'))        notable.push(`${n('refreshed')} recovered after link expiry`);
  if (!notable.length) return null;
  return `${n('done')} files synced — ${notable.join(', ')}`;
}

// --- Expired download URLs --------------------------------------------------

/**
 * Fetch a file's bytes, treating a 403 as ambiguous rather than final.
 *
 * Canvas hands out signed download URLs with the file list, and returns 403
 * both when a student genuinely cannot read a file and when the signature has
 * since expired. A long sync makes the second case routine — and because the
 * caller counted every 403 as "forbidden" and never retried, those files went
 * missing while the run still reported success.
 *
 * So: ask Canvas for the file once more. A second 403 on a URL that is seconds
 * old is a real denial. Anything that fails while asking re-throws the original
 * 403, because a metadata lookup that also fails tells us nothing new.
 *
 * Returns { binary, refreshed } — refreshed true only when the fresh URL is
 * what produced the bytes.
 */
export async function fetchFileWithFreshUrl(
  { file, courseId, fetchBinary, getFileMeta, isPermissionError },
) {
  try {
    return { binary: await fetchBinary(file.url), refreshed: false };
  } catch (err) {
    if (!isPermissionError(err)) throw err;

    let fresh;
    try {
      fresh = await getFileMeta(courseId, file.id);
    } catch {
      throw err;
    }

    const url = fresh?.url;
    // No URL, or the same one we just failed on: refreshing bought nothing, so
    // the original 403 stands and the file is genuinely out of reach.
    if (!url || url === file.url) throw err;

    return { binary: await fetchBinary(url), refreshed: true };
  }
}

// --- What actually arrived --------------------------------------------------

/**
 * How many bytes a base64 payload decodes to.
 *
 * The pre-fetch size gate reads Canvas's declared `size`, and Canvas does not
 * always declare one — module-item lookups and embedded-link discoveries are
 * exactly where the metadata is thinnest. `typeof f.size === 'number' ? f.size
 * : 0` then yields 0, `0 > cap` is false, and a file of any size walks straight
 * through the gate, downloads in full inside the service worker, and is
 * rejected by the bridge's body limit. Measuring the bytes we are holding
 * closes that path without touching the cap it checks against.
 *
 * Four base64 characters carry three bytes; each '=' removes one.
 */
export function decodedByteLength(base64) {
  const s = String(base64 ?? '');
  if (!s) return 0;
  let padding = 0;
  if (s.endsWith('==')) padding = 2;
  else if (s.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor(s.length / 4) * 3 - padding);
}

// --- When a repeat failure deserves a second alert --------------------------

/**
 * Whether a sync failure should raise an OS notification.
 *
 * The generic error path built a unique notification id from Date.now(), so
 * every failure stacked another toast — a bridge left switched off produced one
 * per weekly alarm and one per Canvas visit, forever. The pairing path twenty
 * lines above already had this right: a fixed id, plus a flag so a state that
 * has not changed does not re-alert.
 *
 * Same rule here, keyed on the message: the first failure speaks, identical
 * repeats stay quiet, a genuinely different failure speaks again, and a
 * successful sync clears the memory so the next outage is heard.
 */
export function shouldNotifyError(lastNotifiedMessage, message) {
  const now = String(message ?? '');
  if (!now) return false;
  return now !== String(lastNotifiedMessage ?? '');
}

// --- Which failures are worth retrying --------------------------------------

/**
 * Build the predicate _withRetry uses to decide whether to try again.
 *
 * Lives here, away from the loop that acts on it, because this one boolean is
 * the line a future edit is most likely to widen carelessly — "just retry
 * HttpError too" reads harmless and buys three attempts at a 404 per file, per
 * sync. Out here it can be pinned by a test that enumerates every error type on
 * both sides of the boundary; inside a 20-line loop in a service worker it
 * cannot be reached at all.
 *
 * Types are injected rather than imported so this module keeps its one useful
 * property — no dependencies — and so importing it into the popup does not drag
 * canvas-client.js along for a sentence about file counts.
 *
 * NOTE FOR WHOEVER WIDENS THIS: retrying is only safe while every endpoint
 * _withRetry wraps is idempotent. Three of its call sites are bridge POSTs. See
 * the comment at _withRetry in background.js.
 */
export function makeIsTransient(types) {
  const transient = Object.values(types ?? {}).filter(t => typeof t === 'function');
  return function isTransient(err) {
    if (!err) return false;
    return transient.some(T => err instanceof T);
  };
}
