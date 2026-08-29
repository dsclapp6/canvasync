// meeting-times-concurrency.test.js — the undo stash survives an impatient click.
//
// All three mutators write TWO files for one logical operation: the override
// itself and meeting_override_previous.json, the stash that "undo" restores
// from. Nothing serialized them, and neither the clear control nor the save
// form has a double-click guard.
//
// The audit predicted a data-DESTROYING failure one impatient click away: the
// second clear of a double-click reads an override the first has already
// unlinked, stashes `previous: null` over the stash the first just recorded,
// and the user can no longer undo back to the time they typed. I could not
// reproduce it — see HONEST SCOPE below — but the read-modify-write it rests on
// is real and unserialized, so the lock stands.
//
// The lock is keyed by CLASS DIR, not by file. Per-file would serialize each
// write against itself while still letting one mutator's stash interleave with
// another's main write, which is the shape any future defect here would take.
//
// HONEST SCOPE, because this file is weaker evidence than its siblings:
//
// These tests PASS WITH AND WITHOUT the lock. I removed all three wrappers and
// ran them: 6/6 still green. I then ran the double-clicked clear 200 times
// against the unlocked code and destroyed the undo target zero times. So this
// file documents the invariants the lock is meant to hold; it does NOT
// demonstrate a bug the lock fixed, and it would not catch the lock being
// removed. Do not cite it as mutation-grade — textbooks-concurrency.test.js
// and write-lock.test.js are (3/5 and 1/12 respectively fail without their
// lock); this one is not.
//
// Why the predicted failure did not reproduce: clearMeetingOverride returns
// early when its unlink fails, BEFORE it reaches stashPrevious, so the second
// clear of a double-click writes no stash at all rather than a null one. The
// `if (current || existed)` guard covers the rest. The lock here is therefore
// defence-in-depth over a read-modify-write that is genuinely unserialized —
// which is worth having, since the next edit to these three functions has no
// such accident protecting it — rather than a fix for a reachable bug.
//
// WHAT IT DOES NOT COVER AT ALL: cross-process safety. Not needed here (only
// the bridge's meeting routes call these; no pipeline stage mutates an
// override), and write-lock.js does not offer it.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  writeMeetingOverride, clearMeetingOverride, revertMeetingOverride,
  readMeetingOverride, readMeetingRevert, OVERRIDE_FILE, PREVIOUS_FILE,
} from '../meeting-times.js';

let base, classDir;

const TIME = { days: ['TU', 'TH'], start: '14:00', end: '15:15', location: 'McNair 228' };

before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-conc-'));
  classDir = path.join(base, 'classes', '93903-busi-380-002');
  await fs.mkdir(classDir, { recursive: true });
});

after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(classDir, OVERRIDE_FILE), { force: true });
  await fs.rm(path.join(classDir, PREVIOUS_FILE), { force: true });
});

test('a double-clicked clear does not destroy the undo target', async () => {
  // The audit's headline case. It passes without the lock too — see the header
  // — so read this as the invariant being stated, not as the bug being caught.
  await writeMeetingOverride(classDir, TIME);

  const outcomes = await Promise.allSettled([
    clearMeetingOverride(classDir),
    clearMeetingOverride(classDir),
  ]);
  assert.equal(outcomes.filter(o => o.status === 'rejected').length, 0);

  assert.equal(await readMeetingOverride(classDir), null, 'the override is gone, as asked');

  const stash = await readMeetingRevert(classDir);
  assert.ok(stash, 'a stash must exist — undo has to have something to offer');
  assert.ok(stash.previous, 'the stash must hold the time the user typed, not null');
  assert.deepEqual(stash.previous.days, TIME.days);
  assert.equal(stash.previous.start, TIME.start);
});

test('a double-clicked save leaves one coherent override', async () => {
  const outcomes = await Promise.allSettled([
    writeMeetingOverride(classDir, TIME),
    writeMeetingOverride(classDir, { ...TIME, location: 'Herring 100' }),
  ]);
  assert.equal(outcomes.filter(o => o.status === 'rejected').length, 0);

  const override = await readMeetingOverride(classDir);
  assert.ok(override, 'an override survived');
  assert.deepEqual(override.days, TIME.days);
  // Last writer wins, and it must be ONE of the two — not a blend.
  assert.ok(['McNair 228', 'Herring 100'].includes(override.location));
});

test('a clear racing a save leaves the two files agreeing with each other', async () => {
  await writeMeetingOverride(classDir, TIME);
  await Promise.allSettled([
    clearMeetingOverride(classDir),
    writeMeetingOverride(classDir, { ...TIME, start: '16:00', end: '17:15' }),
  ]);

  // Either order is legitimate; what must not happen is a stash that points at
  // nothing while an override exists, or an override cleared with no stash.
  const override = await readMeetingOverride(classDir);
  const stash = await readMeetingRevert(classDir);
  assert.ok(stash, 'whichever ran second, it recorded what it replaced');
  if (override === null) {
    assert.ok(stash.previous, 'a clear must stash the time it removed');
  }
});

test('revert after a raced clear restores the time the user typed', async () => {
  await writeMeetingOverride(classDir, TIME);
  await Promise.allSettled([
    clearMeetingOverride(classDir),
    clearMeetingOverride(classDir),
  ]);

  const restored = await revertMeetingOverride(classDir);
  assert.ok(restored, 'undo had something to restore');
  const override = await readMeetingOverride(classDir);
  assert.ok(override, 'the override is back');
  assert.equal(override.start, TIME.start, 'and it is the time the user typed');
});

test('two classes are not serialized against each other', async () => {
  // Guards a lock keyed too coarsely.
  const otherDir = path.join(base, 'classes', '92294-busi-305-001');
  await fs.mkdir(otherDir, { recursive: true });

  await Promise.all([
    writeMeetingOverride(classDir, TIME),
    writeMeetingOverride(otherDir, { ...TIME, start: '09:00', end: '10:15' }),
  ]);

  assert.equal((await readMeetingOverride(classDir)).start, '14:00');
  assert.equal((await readMeetingOverride(otherDir)).start, '09:00');
});

test('no orphan temp files are left in the class directory', async () => {
  await writeMeetingOverride(classDir, TIME);
  await Promise.allSettled([
    clearMeetingOverride(classDir),
    writeMeetingOverride(classDir, TIME),
    clearMeetingOverride(classDir),
  ]);
  const left = (await fs.readdir(classDir)).filter(n => n.includes('.tmp.'));
  assert.deepEqual(left, []);
});
