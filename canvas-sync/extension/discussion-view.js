// discussion-view.js — reading a discussion's reply tree.
//
// Split out of background.js for one reason: what it returns has TWO consumers
// with opposite needs, and collapsing them lost data. The reply text stored on
// the topic wants HTML stripped out; the embedded-file scan wants the HTML
// kept, because a file a professor posts in a reply exists only as an href
// inside an anchor tag. The old code stripped in the walk itself, so by the
// time anything looked for /files/<id> the link had already been replaced by a
// space — a reading posted as a reply was invisible twice over: never scanned
// as HTML, and unrecoverable from the text that survived.
//
// (Also: background.js cannot be imported under node — it registers
// chrome.runtime, chrome.alarms and chrome.action listeners at module scope —
// so logic left inside it can only ever be tested by reading the source.)

/**
 * Every reply message in a /discussion_topics/:id/view payload, RAW, in the
 * order the thread reads: each entry before its own replies, depth first.
 *
 * That order is load-bearing — the stored replies_text is this list stripped
 * and truncated, so a change here silently reshapes what the pipeline reads.
 */
export function collectReplyMessages(view) {
  const out = [];
  const walk = (entries) => {
    // Array.isArray, not the old `entries || []`: Canvas can answer with
    // an object for an empty view, and for..of over an object throws — which
    // in the old inline walk would have aborted the whole topic.
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.message) out.push(String(entry.message));
      walk(entry?.replies);
    }
  };
  walk(view?.view);
  return out;
}

/** The same strip the stored reply text has always used. */
export function stripHtml(html) {
  return String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * How many topics per course are opened for their replies.
 *
 * A ceiling, not a cap on coverage: 20 used to be the working number, which
 * meant a seminar with weekly threads had most of its discussion — and, since
 * the reply scan above, most of its reply-posted READINGS — never fetched at
 * all. The user's instruction is that files are not to be cut off, and the
 * measured cost of lifting it is one request per extra topic at the client's
 * 70-per-minute limiter (~0.86 s each when saturated): nothing on a normal
 * term, ~21 s on a 45-thread seminar.
 *
 * 100 rather than unbounded, and rather than 200: it is far above any real
 * course, so it never binds in practice, while still bounding a pathological
 * one to ~86 s of extra sync rather than minutes. And unlike the number it
 * replaces, exceeding it is LOUD — see rankTopicsForView's `skipped`, which
 * the caller logs with a sample. A ceiling with a paper trail is a circuit
 * breaker; a silent one is the defect this replaces.
 */
export const VIEW_TOPIC_CEILING = 100;

/**
 * Order the topics whose replies are worth reading, and split off whatever a
 * ceiling drops so the caller can say so out loud.
 *
 * Graded first, then newest, because if a ceiling ever does bite, the tail it
 * drops should be the threads least likely to carry a reading.
 *
 * The `?? 0` on posted_at is preserved from the original deliberately:
 * Date.parse(0) is 2000-01-01, so a topic Canvas gives no posted_at sorts to
 * the back of its group rather than to the front. Removing it would silently
 * reorder what a ceiling drops.
 */
export function rankTopicsForView(discussions, ceiling = VIEW_TOPIC_CEILING) {
  const ranked = (Array.isArray(discussions) ? [...discussions] : []).sort((a, b) => {
    const ga = a?.assignment ? 1 : 0, gb = b?.assignment ? 1 : 0;
    if (ga !== gb) return gb - ga;
    return Date.parse(b?.posted_at ?? 0) - Date.parse(a?.posted_at ?? 0) || 0;
  });
  return { targets: ranked.slice(0, ceiling), skipped: ranked.slice(ceiling), total: ranked.length };
}
