// scope.test.js — the sync scope, the scoped sidebar, and stale-class cleanup.
//
// The invariant under test throughout: an UNKNOWN scope means "everything is
// current". Canvas keeps every past semester enrolled, so narrowing is the
// whole point of this feature — but narrowing on the strength of a file we
// could not read would hide a user's real classes and, worse, offer to delete
// them. Every assertion about hiding or deleting is paired with one that says
// it does not happen when the scope is unknown.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../test/helpers/server-factory.js';
import { readSyncScope, readEnrolledCourses, isInScope } from '../../scope.js';

const SECRET = 'test-secret-scope';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
let server, baseUrl, tmpHome;

// Two current classes and two from a dead term.
const CURRENT = ['92294-busi-305-001', '92336-busi-374-001'];
const STALE   = ['79431-busi-369-001', '93922-power-of-persuasion'];

async function seedClass(folder) {
  const dir = path.join(tmpHome, 'classes', folder);
  await fs.mkdir(path.join(dir, 'files'), { recursive: true });
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({
    name: `Name ${folder}`,
    course_code: folder.replace(/^\d+-/, '').toUpperCase(),
    term: { id: '1', name: 'Fall Semester 2026 Full Term' },
  }));
  await fs.writeFile(path.join(dir, 'files', 'a.txt'), 'x'.repeat(100));
}

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-scope-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';
  await fs.writeFile(path.join(tmpHome, 'config.json'),
    JSON.stringify({ bridgeSecret: SECRET, extensionId: EXT_ID }), { mode: 0o600 });
  for (const f of [...CURRENT, ...STALE]) await seedClass(f);
  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Cleaning up a stale class fires a WORKLIST REBUILD — a real child process
  // (scripts/sync-calendar.js) that inherits CANVAS_SYNC_HOME and writes
  // <tmpHome>/calendar/{worklist.json,*.ics}. Nothing here used to wait for it,
  // so the rm below raced a live writer and died with
  // `ENOTEMPTY: rmdir '<tmp>/cvsync-scope-*/calendar'` — intermittently, as a
  // FILE-level failure with no test named, which reads like a flaky suite
  // rather than a leaked child — node reports a failed after() hook on a
  // synthetic file entry carrying the HOOK's duration, which is why it looks
  // "too fast to have run a test".
  //
  // Measured while fixing it: 151 orphan cvsync-scope-* directories on this
  // machine, of which 44 held exactly a calendar/ the child wrote after
  // teardown had removed the rest. Those 44 were this bug and are swept. The
  // other 107 hold a logs/delete.log dated 2026-08-24 or an untouched seeded
  // home — an OLDER, separate leak, left in place rather than tidied away,
  // because they are the only evidence it exists. An earlier version of this
  // comment said 118, all calendar/: that was three newest directories
  // generalised to a population, and it was wrong.
  //
  // Waiting is the fix. Retrying the rmdir would only hide the writer, and the
  // orphan directories would keep accumulating.
  await waitForRebuildIdle();
  await new Promise(resolve => server.close(resolve));
  // CANVAS_SYNC_HOME is REPOINTED, never deleted. A rebuild child that starts
  // after this hook runs reads the variable at spawn time; with it deleted,
  // dataRoot() falls back to ~/canvas-sync-data and the child rebuilds the
  // USER'S REAL CALENDAR from a test's fixtures. That is not hypothetical —
  // user-state.test.js's own teardown records it happening four times in one
  // afternoon, rewriting worklist.json, worklist.md and ROUTINE.md out from
  // under them, and defends with exactly this graveyard. The wait above should
  // make it unreachable here; this is what makes being wrong about that cost a
  // junk directory instead of the user's data.
  const graveyard = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-scope-void-'));
  process.env.CANVAS_SYNC_HOME = graveyard;
  delete process.env.BRIDGE_PORT;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

/**
 * Block until the bridge says no worklist rebuild is in flight.
 *
 * Asked through the server's own published answer (`GET /api/calendar` returns
 * `rebuild`), not by sniffing the filesystem: the server is the only thing that
 * knows a child was spawned, and it already re-spawns once more if a request
 * arrived mid-run, which a mtime-settles heuristic would walk straight past.
 *
 * Bounded, and it gives up rather than hanging the suite — a teardown that
 * blocks forever is worse than the orphan directory it was trying to prevent.
 */
async function waitForRebuildIdle({ timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // /api/calendar/classes, NOT /api/calendar: only the former publishes
    // `rebuild`. Polling the latter read `undefined`, treated it as "idle", and
    // returned instantly — a wait that never waited, which is why the orphan
    // directories kept appearing after it was added.
    const res = await request('GET', '/api/calendar/classes', asDash()).catch(() => null);
    // Cannot ask (server already down, route changed): do not spin on it.
    if (!res || res.status !== 200) return false;
    // `pending` covers the debounce window that `running` truthfully misses:
    // a rebuild that is owed but not yet spawned is still one we must not tear
    // the home out from under.
    if (!res.body?.rebuild?.running && !res.body?.rebuild?.pending) return true;
    if (Date.now() > deadline) {
      console.error('[scope.test] gave up waiting for the worklist rebuild;'
        + ` ${tmpHome} may be left behind`);
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

beforeEach(async () => {
  await fs.rm(path.join(tmpHome, 'sync-scope.json'), { force: true });
  await fs.rm(path.join(tmpHome, 'last_sync.json'), { force: true });
  await fs.rm(path.join(tmpHome, 'dashboard-state.json'), { force: true });
});

function request(method, pathname, { origin, secret, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (origin) headers['Origin'] = origin;
    if (secret) headers['X-Bridge-Secret'] = secret;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const asExt  = (extra = {}) => ({ origin: `chrome-extension://${EXT_ID}`, secret: SECRET, ...extra });
const asDash = (extra = {}) => ({ secret: SECRET, ...extra });

// --- scope.js resolution ---------------------------------------------------

test('scope: unknown scope includes every class', async () => {
  const scope = readSyncScope(tmpHome);
  assert.equal(scope.courseIds, null);
  assert.equal(scope.source, 'none');
  for (const f of [...CURRENT, ...STALE]) assert.equal(isInScope(scope, f), true);
});

test('scope: last_sync.json is used when no scope has been published', async () => {
  await fs.writeFile(path.join(tmpHome, 'last_sync.json'),
    JSON.stringify({ timestamp: '2026-08-24T02:54:27.044Z', coursesSeen: ['92294', '92336'] }));
  const scope = readSyncScope(tmpHome);
  assert.equal(scope.source, 'last-sync');
  assert.deepEqual(scope.courseIds, ['92294', '92336']);
  assert.equal(isInScope(scope, CURRENT[0]), true);
  assert.equal(isInScope(scope, STALE[0]), false);
});

test('scope: a published scope wins over last_sync.json', async () => {
  await fs.writeFile(path.join(tmpHome, 'last_sync.json'),
    JSON.stringify({ coursesSeen: ['92294'] }));
  const res = await request('POST', '/config/scope',
    asExt({ body: { courseIds: ['92336'], enrolled: [{ courseId: '92336', code: 'BUSI 374', name: 'X', term: 'Fall Semester 2026 Full Term' }] } }));
  assert.equal(res.status, 200);
  const scope = readSyncScope(tmpHome);
  assert.equal(scope.source, 'selection');
  assert.deepEqual(scope.courseIds, ['92336']);
  assert.equal(readEnrolledCourses(tmpHome).length, 1);
});

test('scope: course ids survive as strings and junk entries are dropped', async () => {
  // Canvas sends string ids (json+canvas-string-ids). A number, a padded
  // string and an outright non-id must normalise to exactly one clean id.
  await request('POST', '/config/scope',
    asExt({ body: { courseIds: [92294, ' 92294 ', 'not-an-id', '', null] } }));
  assert.deepEqual(readSyncScope(tmpHome).courseIds, ['92294']);
});

test('scope: a scope publish does not touch config.json', async () => {
  const before = await fs.readFile(path.join(tmpHome, 'config.json'), 'utf8');
  await request('POST', '/config/scope', asExt({ body: { courseIds: ['92294'] } }));
  assert.equal(await fs.readFile(path.join(tmpHome, 'config.json'), 'utf8'), before);
});

test('scope: a corrupt published scope is preserved and ENOENT still starts empty', async () => {
  const scopePath = path.join(tmpHome, 'sync-scope.json');
  const corrupt = '{"selected courses":';
  await fs.writeFile(scopePath, corrupt);
  const refused = await request('POST', '/config/scope', asExt({
    body: { courseIds: ['92294'] },
  }));
  assert.equal(refused.status, 500);
  const preserved = (await fs.readdir(tmpHome))
    .find(name => name.startsWith('sync-scope.json.unreadable-'));
  assert.ok(preserved, 'the unreadable scope must be moved aside');
  assert.match(refused.body.error, new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await fs.readFile(path.join(tmpHome, preserved), 'utf8'), corrupt);
  await assert.rejects(fs.access(scopePath), { code: 'ENOENT' });

  const retry = await request('POST', '/config/scope', asExt({
    body: { courseIds: ['92294'] },
  }));
  assert.equal(retry.status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(scopePath, 'utf8')).courseIds, ['92294']);
  assert.equal(await fs.readFile(path.join(tmpHome, preserved), 'utf8'), corrupt);
});

test('scope: a valid-JSON scope with wrong field shapes is preserved and refused', async () => {
  const scopePath = path.join(tmpHome, 'sync-scope.json');
  const wrongShape = JSON.stringify({
    version: 1,
    courseIds: '92294',
    enrolled: { courseId: '92294', name: 'must not be erased' },
  });
  const entriesBefore = new Set(await fs.readdir(tmpHome));
  await fs.writeFile(scopePath, wrongShape);

  const refused = await request('POST', '/config/scope', asExt({
    body: { courseIds: ['92336'] },
  }));
  assert.equal(refused.status, 500);
  const preserved = (await fs.readdir(tmpHome))
    .find(name => name.startsWith('sync-scope.json.unreadable-') && !entriesBefore.has(name));
  assert.ok(preserved, 'the wrong-shape scope must be moved aside');
  assert.match(refused.body.error, /could not be read \(shape\)/);
  assert.match(refused.body.error, new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await fs.readFile(path.join(tmpHome, preserved), 'utf8'), wrongShape);
  await assert.rejects(fs.access(scopePath), { code: 'ENOENT' });
});

// --- /api/classes ----------------------------------------------------------

test('classes: every class is flagged in-scope when the scope is unknown', async () => {
  const res = await request('GET', '/api/classes', asDash());
  assert.equal(res.status, 200);
  assert.equal(res.body.classes.length, 4);
  assert.ok(res.body.classes.every(c => c.inScope === true));
  assert.equal(res.body.scope.source, 'none');
});

test('classes: inScope reflects the published scope, and term is a string', async () => {
  await request('POST', '/config/scope', asExt({ body: { courseIds: ['92294', '92336'] } }));
  const res = await request('GET', '/api/classes', asDash());
  const inScope = res.body.classes.filter(c => c.inScope).map(c => c.folder).sort();
  assert.deepEqual(inScope, [...CURRENT].sort());
  // Regression: metadata.json stores Canvas's term object verbatim, and the
  // sidebar rendered it as "[object Object]".
  assert.equal(typeof res.body.classes[0].term, 'string');
});

// --- /api/classes/stale ----------------------------------------------------

test('stale: an unknown scope reports nothing stale', async () => {
  const res = await request('GET', '/api/classes/stale', asDash());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.stale, []);
});

test('stale: out-of-scope classes are listed with their real size', async () => {
  await request('POST', '/config/scope', asExt({ body: { courseIds: ['92294', '92336'] } }));
  const res = await request('GET', '/api/classes/stale', asDash());
  assert.deepEqual(res.body.stale.map(c => c.folder).sort(), [...STALE].sort());
  assert.ok(res.body.stale.every(c => c.sizeBytes >= 100 && c.fileCount >= 1));
  assert.equal(res.body.totalBytes, res.body.stale.reduce((n, c) => n + c.sizeBytes, 0));
});

// --- /api/classes/cleanup --------------------------------------------------

test('cleanup: refuses to delete a class that is still in scope', async () => {
  await request('POST', '/config/scope', asExt({ body: { courseIds: ['92294', '92336'] } }));
  const res = await request('POST', '/api/classes/cleanup',
    asDash({ body: { folders: [CURRENT[0]] } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.results[0].error, /still in your sync selection/);
  await fs.access(path.join(tmpHome, 'classes', CURRENT[0])); // untouched
});

test('cleanup: refuses everything when the scope is unknown', async () => {
  const res = await request('POST', '/api/classes/cleanup',
    asDash({ body: { folders: [STALE[0]] } }));
  assert.equal(res.status, 409);
  await fs.access(path.join(tmpHome, 'classes', STALE[0])); // untouched
});

test('cleanup: deletes an out-of-scope class and leaves the rest alone', async () => {
  const victim = '99999-temporary-victim';
  await seedClass(victim);
  await request('POST', '/config/scope', asExt({ body: { courseIds: ['92294', '92336'] } }));

  const res = await request('POST', '/api/classes/cleanup',
    asDash({ body: { folders: [victim] } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.freedBytes >= 100);
  await assert.rejects(() => fs.access(path.join(tmpHome, 'classes', victim)));
  for (const f of [...CURRENT, ...STALE]) await fs.access(path.join(tmpHome, 'classes', f));
});

test('cleanup: does NOT add the class to untracked', async () => {
  // untracked is a permanent "never sync this again" list. A class that is
  // merely out of scope must come back if the user re-selects it, so cleanup
  // deliberately does not use that mechanism.
  const victim = '99998-another-victim';
  await seedClass(victim);
  await request('POST', '/config/scope', asExt({ body: { courseIds: ['92294'] } }));
  await request('POST', '/api/classes/cleanup', asDash({ body: { folders: [victim] } }));
  const config = JSON.parse(await fs.readFile(path.join(tmpHome, 'config.json'), 'utf8'));
  assert.ok(!(config.untracked ?? []).includes(victim));
});

test('cleanup: rejects a folder name that is not a class folder', async () => {
  await request('POST', '/config/scope', asExt({ body: { courseIds: ['92294'] } }));
  const res = await request('POST', '/api/classes/cleanup',
    asDash({ body: { folders: ['../../etc'] } }));
  assert.equal(res.body.results[0].ok, false);
  assert.match(res.body.results[0].error, /invalid folderName/);
});

// --- selection intent ------------------------------------------------------

test('intent: the app records a change and the extension reads it back', async () => {
  const post = await request('POST', '/api/scope', asDash({ body: { courseIds: ['92294', '92336'] } }));
  assert.equal(post.status, 200);
  const get = await request('GET', '/config/intent', asExt());
  assert.deepEqual(get.body.intent.courseIds, ['92294', '92336']);
});

test('intent: ack clears it, but only the exact intent that was applied', async () => {
  // Regression: this used to key on Date.now(). Two saves in the same
  // millisecond shared a timestamp, so acking the first cleared the second —
  // silently discarding the change the user actually made last.
  await request('POST', '/api/scope', asDash({ body: { courseIds: ['92294'] } }));
  const first = (await request('GET', '/config/intent', asExt())).body.intent;

  // The user changes their mind while the sync is still running.
  await request('POST', '/api/scope', asDash({ body: { courseIds: ['92336'] } }));
  const stale = await request('POST', '/config/intent/ack',
    asExt({ body: { id: first.id } }));
  assert.equal(stale.body.cleared, false);

  const survivor = (await request('GET', '/config/intent', asExt())).body.intent;
  assert.deepEqual(survivor.courseIds, ['92336'], 'the newer intent must survive a stale ack');

  const ack = await request('POST', '/config/intent/ack',
    asExt({ body: { id: survivor.id } }));
  assert.equal(ack.body.cleared, true);
  assert.equal((await request('GET', '/config/intent', asExt())).body.intent, null);
});

test('intent: null means "clear the selection", not "select nothing"', async () => {
  await request('POST', '/api/scope', asDash({ body: { courseIds: null } }));
  const get = await request('GET', '/config/intent', asExt());
  assert.equal(get.body.intent.courseIds, null);
});

test('scope endpoints keep their auth: dashboard secret required, extension origin required', async () => {
  assert.equal((await request('GET', '/api/scope', {})).status, 401);
  assert.equal((await request('GET', '/api/classes/stale', {})).status, 401);
  assert.equal((await request('POST', '/api/classes/cleanup', { body: { folders: ['x'] } })).status, 401);
  // A browser request carries no chrome-extension Origin, so it must not be
  // able to publish a scope even holding the secret.
  assert.equal((await request('POST', '/config/scope', asDash({ body: { courseIds: [] } }))).status, 403);
});

// --- an empty selection is "sync nothing", never "discard everything" -------
// The picker's own `none` button saves []. Read as a plain allowlist, that
// made EVERY class out-of-scope: the cleanup panel listed all of them,
// pre-checked, under a `Delete N classes` button — two clicks from wiping the
// data folder. Both routes now treat an empty allowlist like an unknown one.

test('stale: an EMPTY selection reports nothing stale, and says why', async () => {
  await request('POST', '/config/scope', asExt({ body: { courseIds: [] } }));
  const res = await request('GET', '/api/classes/stale', asDash());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.stale, [], 'an empty selection abandons nothing');
  assert.equal(res.body.totalBytes, 0);
  assert.equal(res.body.reason, 'empty-selection', 'the panel needs the real reason to state it');
});

test('cleanup: refuses everything when the selection is empty', async () => {
  await request('POST', '/config/scope', asExt({ body: { courseIds: [] } }));
  const res = await request('POST', '/api/classes/cleanup',
    asDash({ body: { folders: [...CURRENT, ...STALE] } }));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /selection is empty/);
  for (const f of [...CURRENT, ...STALE]) {
    await fs.access(path.join(tmpHome, 'classes', f)); // every one untouched
  }
});

test('an empty selection still syncs nothing — scope semantics are unchanged', async () => {
  // The fix above must not smuggle "empty means everything" back in.
  await request('POST', '/config/scope', asExt({ body: { courseIds: [] } }));
  const res = await request('GET', '/api/classes', asDash());
  assert.equal(res.body.classes.every(c => c.inScope === false), true,
    'nothing is in scope, exactly as a strict empty allowlist requires');
});

// --- The rebuild that outlived its server -----------------------------------
//
// Three layers, pinned separately, because they defend different things and
// each can be wrong on its own. The bug they answer: cleaning a class schedules
// a worklist rebuild, the rebuild is a CHILD PROCESS that reads
// CANVAS_SYNC_HOME at spawn time, and nothing tied its lifetime to the server
// that asked for it. Seen as an intermittent `ENOTEMPTY: rmdir
// '<tmp>/cvsync-scope-*/calendar'` reported against this file's after() hook —
// which node attributes to a synthetic FILE-level entry with the hook's own
// duration, so it reads like a module that failed to load rather than a
// teardown that raced a live writer.
//
// These are deterministic. The failure they describe is a race, and a test that
// reproduces a race one run in twenty is a rumour, not a test.

async function probeServer() {
  // The shared server must be quiet BEFORE this helper repoints
  // CANVAS_SYNC_HOME. spawnWorklistRebuild reads the variable at spawn time, so
  // a child of the shared server that starts while the probe owns the variable
  // rebuilds into the PROBE's home — which looks exactly like the failure the
  // close-cancel test is hunting, and made it fail with the fix in place. The
  // bug under test and the test's own isolation are the same hazard.
  await waitForRebuildIdle();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-scope-probe-'));
  await fs.writeFile(path.join(home, 'config.json'),
    JSON.stringify({ bridgeSecret: SECRET, extensionId: EXT_ID }), { mode: 0o600 });
  // A class, because sync-calendar writes NOTHING for a home with none — and a
  // rebuild that produces no file cannot be detected by looking for one. The
  // close-cancel test stayed green against the un-cancelled timer until this
  // was here: the timer fired, the child ran, and it had nothing to write.
  const probeClass = path.join(home, 'classes', '92294-busi-305-001');
  await fs.mkdir(probeClass, { recursive: true });
  await fs.writeFile(path.join(probeClass, 'metadata.json'), JSON.stringify({
    name: 'BUSI 305', course_code: 'BUSI 305',
    term: { id: '1', name: 'Fall Semester 2026 Full Term' },
  }));
  const saved = process.env.CANVAS_SYNC_HOME;
  process.env.CANVAS_SYNC_HOME = home;
  const srv = await createServer();
  return {
    home,
    url: `http://127.0.0.1:${srv.address().port}`,
    // Schedules a rebuild through the DEBOUNCE path rather than spawning one:
    // this is the window `rebuild.running` cannot see.
    schedule: (url) => fetch(`${url}/api/calendar/items`, {
      method: 'POST',
      headers: { 'X-Bridge-Secret': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'probe item', date: '2026-09-05' }),
    }),
    // Closing and cleaning up are SEPARATE on purpose. The close-cancel test
    // has to keep both the home and the env var alive across the debounce
    // window, or a timer that fires writes somewhere the assertion is not
    // looking and the test passes without testing anything.
    async close() {
      await new Promise(resolve => srv.close(resolve));
    },
    async cleanup() {
      process.env.CANVAS_SYNC_HOME = saved;
      await fs.rm(home, { recursive: true, force: true });
    },
    async done() { await this.close(); await this.cleanup(); },
  };
}

test('a rebuild owed but not yet spawned is published, not hidden', async () => {
  // Layer 3. `calRebuild` only tracks children that exist, so during the
  // debounce the server answered "not running" — true, and useless to anything
  // waiting for quiescence, which then proceeded to delete the home.
  const probe = await probeServer();
  try {
    const scheduled = await probe.schedule(probe.url);
    assert.equal(scheduled.status, 200, await scheduled.text());
    const res = await fetch(`${probe.url}/api/calendar/classes`, { headers: { 'X-Bridge-Secret': SECRET } });
    const body = await res.json();
    assert.equal(body.rebuild.running, false, 'nothing has been spawned yet — that part was always true');
    assert.equal(body.rebuild.pending, true, 'but one is owed, and that is what a waiter needs to know');
  } finally { await probe.done(); }
});

test('the endpoint the teardown waits on actually answers the question', async () => {
  // The failure this pins is one I shipped: waitForRebuildIdle polled
  // /api/calendar, which publishes no `rebuild` at all, so it read undefined,
  // called it idle and returned instantly. A wait that never waits looks
  // exactly like a wait that works — the suite stays green and the orphan
  // directories keep appearing. Assert the CONTRACT, not just the value.
  const res = await request('GET', '/api/calendar/classes', asDash());
  assert.equal(res.status, 200);
  assert.equal(typeof res.body?.rebuild, 'object',
    'the polled route must publish a rebuild status, or the wait is a no-op');
  for (const field of ['running', 'pending']) {
    assert.equal(typeof res.body.rebuild[field], 'boolean',
      `rebuild.${field} must be a boolean the wait can branch on`);
  }
});

test('a rebuild scheduled on a server that then closes never fires', async () => {
  // Layer 1, and the defect that generalises: a debounce timer outliving its
  // server. Every test that stands up a bridge inherits it. Deterministic —
  // the timer is guaranteed pending at close, so the pre-fix code spawns the
  // child every single run.
  const probe = await probeServer();
  const worklist = path.join(probe.home, 'calendar', 'worklist.json');
  try {
    const scheduled = await probe.schedule(probe.url);
    assert.equal(scheduled.status, 200, await scheduled.text());
    // createCustomItem already made calendar/ — only sync-calendar writes this.
    await assert.rejects(fs.stat(worklist), 'nothing should have rebuilt yet');
    await probe.close();
    // The home and CANVAS_SYNC_HOME both stay put across this window: a timer
    // that survives its server must have somewhere to write that this
    // assertion can see, or the test is vacuous. It was, once — it asserted a
    // missing file inside a directory it had already deleted, and stayed green
    // with the cancel removed.
    await new Promise(resolve => setTimeout(resolve, 2200));  // past the 1500ms debounce
    await assert.rejects(fs.stat(worklist),
      'the timer fired after its server closed and rebuilt into a home nobody owns');
  } finally {
    await probe.cleanup();
  }
});

// Layer 2, asserted from a SECOND after() so it runs once the real teardown
// above has done its work. If that hook ever goes back to deleting the
// variable, a rebuild child spawned afterwards inherits no CANVAS_SYNC_HOME,
// dataRoot() falls back to ~/canvas-sync-data, and the child rewrites the
// user's real calendar. This is the only layer that still holds when the other
// two are wrong, so it gets its own assertion rather than a comment.
after(() => {
  assert.ok(process.env.CANVAS_SYNC_HOME,
    'teardown must REPOINT CANVAS_SYNC_HOME at a throwaway directory, never delete it');
  assert.notEqual(process.env.CANVAS_SYNC_HOME, path.join(os.homedir(), 'canvas-sync-data'),
    'and never at the real data root');
});
