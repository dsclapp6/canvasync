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
  await new Promise(resolve => server.close(resolve));
  delete process.env.CANVAS_SYNC_HOME;
  delete process.env.BRIDGE_PORT;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

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
