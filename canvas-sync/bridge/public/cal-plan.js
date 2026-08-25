// cal-plan.js — which kinds of event the calendar shows.
//
// Pure functions, no DOM, no Node builtins, so the same file runs in the page
// and under `node --test`. The logic is small and the failure it prevents is
// not: on 2026-08-24 the calendar's five independent switches were all turned
// off in one gesture and the worklist went from 251 events to 105, with nothing
// on the calendar to say that anything had been switched at all.
//
// The user's rule, in their words: "remove the all option & that should be
// default. If one (or more) are selected, then it becomes only those ones on
// the calendar."
//
// So this is a SELECTION, not five switches:
//
//   nothing selected      →  every kind shows          (the default)
//   {meeting}             →  only meetings show
//   {meeting, exam}       →  only those two
//   click the only member →  back to nothing selected, i.e. everything
//
// There is no "all off" state to fall into, and therefore no All button to
// offer — "everything" is what you get by deselecting, and cal-plan.test.js
// walks all 2^n × n click sequences to prove no path reaches an empty view.
//
// These once decided what the worklist BUILT. Now they decide only what is
// DRAWN, which is why the selection lives in localStorage rather than on disk:
// nothing is lost by unticking, and nothing has to be rebuilt to tick it back.

/**
 * The selection after clicking `kind`.
 *
 *   from nothing (= everything)  →  just that kind
 *   the only selected kind       →  nothing (= everything again)
 *   an already-selected kind     →  drop it
 *   an unselected kind           →  add it, in `kinds` order
 *
 * `kinds` is the full vocabulary and fixes the order, so a selection never
 * depends on the sequence it was built in. An unknown kind changes nothing.
 */
export function nextSelection(sel, kinds, kind) {
  const list = Array.isArray(kinds) ? kinds : [];
  const cur = Array.isArray(sel) ? sel : [];
  if (!list.includes(kind)) return [...cur];
  if (!cur.length) return [kind];
  if (cur.length === 1 && cur[0] === kind) return [];
  if (cur.includes(kind)) return cur.filter(k => k !== kind);
  return list.filter(k => cur.includes(k) || k === kind);
}

/**
 * Is this kind showing?
 *
 * The empty selection means every kind, which is the whole reason there is no
 * unreachable-empty state to fall into.
 */
export function isSelected(sel, kind) {
  const cur = Array.isArray(sel) ? sel : [];
  return !cur.length || cur.includes(kind);
}
