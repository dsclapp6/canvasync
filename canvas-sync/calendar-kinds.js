// The kinds of thing that can land on the calendar.
//
// This used to be a *plan*: six switches, global and per class, persisted to
// <data root>/calendar/plan.json, deciding what the worklist would emit. That
// was the wrong shape twice over. Turning a kind off did not hide it — it
// stopped BUILDING it, so the answer to "where did my readings go" was a
// rebuild away, and every kind the user had ever switched off was invisible to
// the search, the counts and the notes as well. And with every switch off the
// worklist emitted nothing at all, which looks exactly like a broken sync.
//
// So the worklist now emits everything it can find, always, and the dashboard's
// chips filter what is DRAWN. Nothing is ever lost by unticking something, and
// the filter cannot reach a state where the page is empty because
// cal-plan.js makes "none selected" mean "all of them".
//
// What is left here is the vocabulary: which kinds exist, what to call them,
// and which target calendar each one is written to.
//
// Node builtins only — the bridge, the scripts and the desktop app all load it.

export const KINDS = ['meeting', 'office_hours', 'homework', 'reading', 'exam', 'checkpoint'];

export const KIND_LABELS = {
  meeting:      'Meetings',
  office_hours: 'Office hours',
  homework:     'Homework',
  reading:      'Readings',
  exam:         'Exams',
  checkpoint:   'Checkpoints',
};

// Which of the three target calendars a kind is written to. Office hours are a
// standing weekly commitment in a room, so they belong with class meetings and
// not among the deadlines.
export const KIND_CALENDAR = {
  meeting:      'meeting',
  office_hours: 'meeting',
  homework:     'due',
  reading:      'due',
  exam:         'due',
  checkpoint:   'checkpoint',
};

/** Singular and plural, for a sentence shown to a student. */
export const KIND_NOUN = {
  meeting:      ['class meeting', 'class meetings'],
  office_hours: ['office-hours block', 'office-hours blocks'],
  homework:     ['assignment', 'assignments'],
  reading:      ['reading', 'readings'],
  exam:         ['exam', 'exams'],
  checkpoint:   ['prep block', 'prep blocks'],
};

export function isKind(v) {
  return typeof v === 'string' && KINDS.includes(v);
}
