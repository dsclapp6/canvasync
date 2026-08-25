// content-script.js — runs at document_idle on every canvas.rice.edu page.
//
// Sends a single `CANVAS_OPENED` message that lets the background worker
// debounce and decide whether to fire a sync. To minimise passive cost we
// pre-flight the same checks the background does and bail BEFORE waking the
// service worker — every avoided message is a service-worker spin-up saved.
//
// Three early-exit gates:
//   1. autoSyncEnabled === false      — user paused syncs (e.g. summer break).
//   2. needsSetup === true            — not paired; a sync would only fail.
//   3. now < nextCanvasOpenedSyncAt   — background would skip anyway.
//
// Gate 3 reads a timestamp the background precomputes and republishes on every
// sync, settings change, and handshake (see _publishCanvasOpenedGate). This file
// used to re-derive it from a hardcoded 6h constant, which silently overrode the
// user's Canvas-visit cooldown setting and knew nothing about the failure
// backoff. Every gate here fails open: a missing or unreadable key sends the
// message and lets the background decide.

(async () => {
  try {
    const { autoSyncEnabled, needsSetup, nextCanvasOpenedSyncAt } =
      await chrome.storage.local.get(
        ['autoSyncEnabled', 'needsSetup', 'nextCanvasOpenedSyncAt']);

    // Paused — never wake the SW from a content script.
    if (autoSyncEnabled === false) return;

    // Unpaired. The background stands down on canvas-opened in this state, so
    // waking it just to be told that costs a spin-up per Canvas page load.
    if (needsSetup === true) return;

    // Debounce + failure backoff, precomputed by the background.
    if (typeof nextCanvasOpenedSyncAt === 'number' &&
        Date.now() < nextCanvasOpenedSyncAt) return;

    chrome.runtime.sendMessage({ type: 'CANVAS_OPENED', href: location.href });
  } catch {
    // chrome.storage can fail in odd contexts (e.g. extension just upgraded
    // and storage isn't ready yet). Fall back to the unconditional send so
    // the user still gets the wake-on-canvas-open path.
    try {
      chrome.runtime.sendMessage({ type: 'CANVAS_OPENED', href: location.href });
    } catch { /* SW gone too — nothing to do */ }
  }
})();
