// server-write-safety.test.js — the four global files the bridge rewrites, and
// what happens when two requests rewrite one of them at once.
//
// Every one of these is read-modify-write over a file with no per-record
// structure: config.json, dashboard-state.json, class_colors.json and
// settings.json each hold everything of their kind in one object. So two
// concurrent requests each computed their change from a snapshot taken before
// the other landed, and one of the two changes was written away — with both
// requests answering 200.
//
// Driven over HTTP rather than by calling the helpers, because HTTP is where
// the concurrency actually comes from: two dashboard tabs, or the app and the
// extension, or one un-awaited click handler firing twice.
//
// WHAT THIS PINS: in-process serialization of those four routes.
// WHAT IT DOES NOT: cross-process safety — write-lock.js does not offer it, and
// files_index.json is the live case that needs more (audit site 1).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from './helpers/server-factory.js';

const SECRET = 'test-secret-write-safety';
let server, baseUrl, tmpHome;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-wsafety-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  process.env.BRIDGE_PORT = '0';
  await fs.writeFile(path.join(tmpHome, 'config.json'),
    JSON.stringify({ bridgeSecret: SECRET }), { mode: 0o600 });
  await fs.mkdir(path.join(tmpHome, 'classes'), { recursive: true });
  server = await createServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  const graveyard = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-wsafety-void-'));
  process.env.CANVAS_SYNC_HOME = graveyard;
  delete process.env.BRIDGE_PORT;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function call(method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method,
        headers: {
          'X-Bridge-Secret': SECRET,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        } },
      res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const readHomeJson = async (name) =>
  JSON.parse(await fs.readFile(path.join(tmpHome, name), 'utf8'));

const tempsIn = async (dir) => (await fs.readdir(dir)).filter(n => n.includes('.tmp.'));

async function preservedRefusal(name, mutate, contents = `{"recover ${name}":`, expectedReason = null) {
  const file = path.join(tmpHome, name);
  const entriesBefore = new Set(await fs.readdir(tmpHome));
  await fs.writeFile(file, contents);
  const refused = await mutate();
  assert.equal(refused.status, 500);
  const preserved = (await fs.readdir(tmpHome))
    .find(entry => entry.startsWith(`${name}.unreadable-`) && !entriesBefore.has(entry));
  assert.ok(preserved, `${name} must be moved aside`);
  if (expectedReason) assert.match(refused.body.error, new RegExp(`could not be read \\(${expectedReason}\\)`));
  assert.match(refused.body.error, new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await fs.readFile(path.join(tmpHome, preserved), 'utf8'), contents);
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
  return { file, preserved, contents };
}

// --- Site 1: files_index.json through the real ingest route -----------------

test('/ingest/course-file reports the preserved wrong-shape index instead of generic write failed', async () => {
  const courseId = 77101;
  const classDir = path.join(tmpHome, 'classes', `${courseId}-route-shape`);
  const indexPath = path.join(classDir, 'files_index.json');
  const wrongShape = JSON.stringify({ entries: [{ canvasId: 'must-not-be-lost' }] });
  await fs.mkdir(classDir, { recursive: true });
  await fs.writeFile(indexPath, wrongShape);
  const entriesBefore = new Set(await fs.readdir(classDir));

  const refused = await call('POST', '/ingest/course-file', {
    courseId,
    fileId: 7710101,
    displayName: 'route-shape.pdf',
    contentType: 'application/pdf',
    size: 3,
    canvasUpdatedAt: '2026-08-29T00:00:00Z',
    dataBase64: Buffer.from('pdf').toString('base64'),
  });

  assert.equal(refused.status, 500);
  assert.notEqual(refused.body.error, 'write failed');
  const preserved = (await fs.readdir(classDir))
    .find(name => name.startsWith('files_index.json.unreadable-') && !entriesBefore.has(name));
  assert.ok(preserved, 'the route must preserve the wrong-shape index');
  assert.match(refused.body.error, /could not be read \(shape\)/);
  assert.match(refused.body.error, new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await fs.readFile(path.join(classDir, preserved), 'utf8'), wrongShape);
  await assert.rejects(fs.access(indexPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(classDir, 'files', 'route-shape.pdf')), { code: 'ENOENT' });
});

// --- Site 4: config.json ----------------------------------------------------

test('two classes marked untracked at once are both recorded', async () => {
  const results = await Promise.all([
    call('POST', '/config/untracked/add', { folderName: '92294-busi-305-001' }),
    call('POST', '/config/untracked/add', { folderName: '92295-busi-374-002' }),
  ]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);

  const { untracked } = await readHomeJson('config.json');
  assert.deepEqual([...untracked].sort(),
    ['92294-busi-305-001', '92295-busi-374-002'],
    'both must be in config.untracked — a lost one resurrects a deleted class');
});

test('an add racing a remove leaves config coherent, and the secret intact', async () => {
  await call('POST', '/config/untracked/add', { folderName: '92296-entr-222-001' });
  const results = await Promise.all([
    call('POST', '/config/untracked/remove', { folderName: '92296-entr-222-001' }),
    call('POST', '/config/untracked/add', { folderName: '92297-busi-380-002' }),
  ]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);

  const config = await readHomeJson('config.json');
  assert.ok(config.untracked.includes('92297-busi-380-002'), 'the add survived');
  assert.equal(config.bridgeSecret, SECRET,
    'config.json holds the pairing secret — no write may drop it');
});

// --- Site 5: dashboard-state.json, the marquee race -------------------------

test('a selection saved while the extension acks the previous one is not lost', async () => {
  // The failure the audit named. The ack clears the intent it applied and must
  // not clear a newer one — it checks by id, but the check was made against a
  // snapshot the app could overwrite before the ack wrote back. Unserialized,
  // the ack saved a state that never contained the new selection, and the
  // user's class change silently vanished.
  const first = await call('POST', '/api/scope', { courseIds: ['111'] });
  assert.equal(first.status, 200);
  const oldId = first.body.intent.id;

  const [ack, save] = await Promise.all([
    call('POST', '/config/intent/ack', { id: oldId }),
    call('POST', '/api/scope', { courseIds: ['222', '333'] }),
  ]);
  assert.equal(ack.status, 200);
  assert.equal(save.status, 200);

  const state = await readHomeJson('dashboard-state.json');
  if (state.intent === null || state.intent === undefined) {
    // Legitimate only if the ack ran second AND matched the newest id.
    assert.fail('the newer selection was cleared — this is the lost update');
  }
  assert.deepEqual(state.intent.courseIds, ['222', '333'],
    'the intent on disk must be the selection the user last asked for');
});

test('an ack for a stale id never clears a newer intent', async () => {
  const first = await call('POST', '/api/scope', { courseIds: ['444'] });
  const staleId = first.body.intent.id;
  await call('POST', '/api/scope', { courseIds: ['555'] });

  const ack = await call('POST', '/config/intent/ack', { id: staleId });
  assert.equal(ack.body.cleared, false, 'a stale ack clears nothing');
  const state = await readHomeJson('dashboard-state.json');
  assert.deepEqual(state.intent.courseIds, ['555']);
});

test('a corrupt dashboard state is preserved and a missing state can be created', async () => {
  const kept = await preservedRefusal('dashboard-state.json',
    () => call('POST', '/api/scope', { courseIds: ['601'] }));
  assert.equal((await call('POST', '/api/scope', { courseIds: ['601'] })).status, 200);
  assert.deepEqual((await readHomeJson('dashboard-state.json')).intent.courseIds, ['601']);
  assert.equal(await fs.readFile(path.join(tmpHome, kept.preserved), 'utf8'), kept.contents);
});

test('a wrong-shape dashboard state is preserved and refuses the mutation', async () => {
  const wrongShape = JSON.stringify([{ intent: { courseIds: ['do-not-erase'] } }]);
  const kept = await preservedRefusal('dashboard-state.json',
    () => call('POST', '/api/scope', { courseIds: ['602'] }), wrongShape, 'shape');
  assert.equal(await fs.readFile(path.join(tmpHome, kept.preserved), 'utf8'), wrongShape);
});

// --- Site 6: class_colors.json ---------------------------------------------

test('two colours picked at once are both saved', async () => {
  const results = await Promise.all([
    call('POST', '/api/class-colors', { colors: { 'busi-305': '#1d4e6f' } }),
    call('POST', '/api/class-colors', { colors: { 'busi-374': '#96382c' } }),
  ]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);

  const stored = await readHomeJson('class_colors.json');
  assert.equal(stored['busi-305'], '#1d4e6f');
  assert.equal(stored['busi-374'], '#96382c');
});

test('a burst of colour changes leaves no orphan temp file', async () => {
  // The old failure path unlinked a pid-derived temp name, so a losing writer
  // could delete the winner's in-flight file. Random-per-call makes it
  // impossible; this pins the observable half.
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    call('POST', '/api/class-colors', { colors: { [`slug-${i}`]: '#112233' } })));
  assert.deepEqual(await tempsIn(tmpHome), []);
});

test('corrupt class colours are preserved and a missing store can be created', async () => {
  const kept = await preservedRefusal('class_colors.json',
    () => call('POST', '/api/class-colors', { colors: { recoverable: '#112233' } }));
  assert.equal((await call('POST', '/api/class-colors', {
    colors: { recoverable: '#112233' },
  })).status, 200);
  assert.equal((await readHomeJson('class_colors.json')).recoverable, '#112233');
  assert.equal(await fs.readFile(path.join(tmpHome, kept.preserved), 'utf8'), kept.contents);
});

test('wrong-shape class colours are preserved and refuse the mutation', async () => {
  const wrongShape = JSON.stringify(['#112233']);
  const kept = await preservedRefusal('class_colors.json',
    () => call('POST', '/api/class-colors', { colors: { recoverable: '#445566' } }), wrongShape, 'shape');
  assert.equal(await fs.readFile(path.join(tmpHome, kept.preserved), 'utf8'), wrongShape);
});

// --- Site 7: settings.json --------------------------------------------------

test('two settings saved at once both survive the merge', async () => {
  const results = await Promise.all([
    call('POST', '/api/settings', { env: { CSYNC_MAX_JOBS: '4' } }),
    call('POST', '/api/settings', { env: { CSYNC_SOFFICE: '/usr/bin/soffice' } }),
  ]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);

  const { env } = await readHomeJson('settings.json');
  assert.equal(env.CSYNC_MAX_JOBS, '4');
  assert.equal(env.CSYNC_SOFFICE, '/usr/bin/soffice',
    'the merge exists to keep out-of-band keys — losing one defeats its purpose');
});

test('settings.json keeps its 0600 mode through a locked write', async () => {
  await call('POST', '/api/settings', { env: { CSYNC_MAX_JOBS: '2' } });
  const { mode } = await fs.stat(path.join(tmpHome, 'settings.json'));
  assert.equal(mode & 0o777, 0o600);
});

test('a deletion racing a save does not resurrect the deleted key', async () => {
  await call('POST', '/api/settings', { env: { CSYNC_DOOMED: 'x', CSYNC_KEEP: 'y' } });
  await Promise.all([
    call('POST', '/api/settings', { env: { CSYNC_DOOMED: '' } }),
    call('POST', '/api/settings', { env: { CSYNC_OTHER: 'z' } }),
  ]);
  const { env } = await readHomeJson('settings.json');
  assert.equal(env.CSYNC_DOOMED, undefined, 'the delete stuck');
  assert.equal(env.CSYNC_KEEP, 'y', 'the untouched key survived');
  assert.equal(env.CSYNC_OTHER, 'z', 'the concurrent add stuck');
});

test('corrupt settings are preserved and a missing store can be created', async () => {
  const kept = await preservedRefusal('settings.json',
    () => call('POST', '/api/settings', { env: { CSYNC_RECOVERABLE: '1' } }));
  assert.equal((await call('POST', '/api/settings', {
    env: { CSYNC_RECOVERABLE: '1' },
  })).status, 200);
  assert.equal((await readHomeJson('settings.json')).env.CSYNC_RECOVERABLE, '1');
  assert.equal(await fs.readFile(path.join(tmpHome, kept.preserved), 'utf8'), kept.contents);
});

test('wrong-shape settings are preserved and refuse the mutation', async () => {
  const wrongShape = JSON.stringify({ env: ['CSYNC_DO_NOT_ERASE'] });
  const kept = await preservedRefusal('settings.json',
    () => call('POST', '/api/settings', { env: { CSYNC_RECOVERABLE: '2' } }), wrongShape, 'shape');
  assert.equal(await fs.readFile(path.join(tmpHome, kept.preserved), 'utf8'), wrongShape);
});

// --- Cross-file ------------------------------------------------------------

test('different global files do not serialize against each other', async () => {
  // Guards a lock keyed too coarsely: one global queue would pass every test
  // above while putting every write in the bridge behind every other.
  const results = await Promise.all([
    call('POST', '/api/settings', { env: { CSYNC_PARALLEL: '1' } }),
    call('POST', '/api/class-colors', { colors: { 'entr-222': '#7a4e12' } }),
    call('POST', '/config/untracked/add', { folderName: '92298-busi-395-001' }),
  ]);
  assert.deepEqual(results.map(r => r.status), [200, 200, 200]);
  assert.equal((await readHomeJson('settings.json')).env.CSYNC_PARALLEL, '1');
  assert.equal((await readHomeJson('class_colors.json'))['entr-222'], '#7a4e12');
  assert.ok((await readHomeJson('config.json')).untracked.includes('92298-busi-395-001'));
});

test('the written dashboard state carries no reader sentinels', async () => {
  // WHY THIS ASSERTS EXACT KEYS rather than just the payload: the reader now
  // returns `unreadable` and `reason` alongside the data, so a writer that
  // spreads the whole state persists those sentinels into the store. Reverting
  // this writer to `{...state}` passed the entire bridge suite — 93/93 — which
  // is how the hardening would quietly be undone. It matters because
  // `unreadable` is already a live idiom in this repo (scripts/meeting-times.js
  // uses it on its own file-state objects), so a future reader writing
  // `if (parsed.unreadable)` would be reading a stale flag off disk.
  assert.equal((await call('POST', '/api/scope', { courseIds: ['777'] })).status, 200);
  const written = await readHomeJson('dashboard-state.json');
  assert.equal(Object.hasOwn(written, 'unreadable'), false, 'the unreadable sentinel reached disk');
  assert.equal(Object.hasOwn(written, 'reason'), false, 'the reason sentinel reached disk');
  assert.deepEqual(written.intent.courseIds, ['777'], 'and the real payload still lands');
});

