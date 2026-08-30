// store-safety.js — never overwrite a store you could not read.
//
// The rule this exists to enforce, and it is one rule: a mutator that reads
// its store, gets nothing back, and writes anyway has ERASED whatever was
// there. The read failed; the write succeeded; the user is told it worked.
// That is the shape every finding in WRITE-SAFETY-AUDIT.md eventually reduces
// to, and the reason a "missing" store and an "unreadable" one must never be
// collapsed into the same empty default.
//
// So the readers that feed this classify instead of guessing:
//
//   ENOENT            -> a legitimately empty first write. Proceed.
//   parse / shape     -> the file holds SOMETHING we cannot interpret.
//   EACCES and others -> the file may hold everything, and we cannot see it.
//
// Only the first is safe to overwrite. For the rest the honest move is to
// preserve the bytes aside and refuse, so the user can recover them — a
// mutation that fails loudly is always cheaper than one that silently wins.
//
// CONTROL FLOW, because it is unusual and every call site depends on it: this
// function's ONLY effective path is a THROW. It returns undefined when the
// store is fine, and throws UnreadableStoreError when it is not. There is no
// path on which it returns having preserved something. Call it as a guard
// immediately after the read and let it abort the mutation:
//
//   const state = await readUserState(classDir);
//   await preserveUnreadable(state, statePath(classDir));   // throws, or falls through
//   state.items[taskId] = ...
//
// Callers hold the lock across that read-modify-write; see write-lock.js and
// file-lock.js. This module does not lock and does not write — it only ever
// moves a bad file out of the way and refuses.

import fs from 'node:fs/promises';
import path from 'node:path';

export class UnreadableStoreError extends Error {}

/**
 * Refuse the mutation if `state` came from a store that could not be read,
 * preserving the original bytes alongside it first.
 *
 * `state` is the READER'S state object — the thing that carries `unreadable`
 * and `reason` — never the parsed value. Passing the wrong one used to be
 * silent: `state.unreadable` came back undefined, the guard fell through, and
 * the caller overwrote the store with exactly the protection this module
 * exists to provide switched off. A safety helper must not fail open on the
 * one mistake its callers are most likely to make, so that is a TypeError now
 * — a programming error, distinct from UnreadableStoreError, which reports a
 * condition of the user's data.
 */
export async function preserveUnreadable(state, file) {
  if (typeof state?.unreadable !== 'boolean') {
    throw new TypeError(
      'preserveUnreadable: pass the reader\'s state object, not the parsed value'
      + ` — expected a boolean \`unreadable\` field, got ${
        state === null || state === undefined ? String(state) : typeof state.unreadable}`);
  }
  if (!state.unreadable) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const kept = `${file}.unreadable-${stamp}`;
  try {
    await fs.rename(file, kept);
  } catch (err) {
    throw new UnreadableStoreError(
      `${path.basename(file)} could not be read (${state.reason}) and could not be preserved as ${kept} `
      + `(${err?.code ?? 'unknown'}) — refusing to overwrite it. The original remains at ${file}.`,
    );
  }
  throw new UnreadableStoreError(
    `${path.basename(file)} could not be read (${state.reason}) and was preserved as ${kept} `
    + '— refusing to overwrite it. Recover the store from that file, then try again.',
  );
}
