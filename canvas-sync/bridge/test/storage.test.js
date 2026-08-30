// storage.test.js — unit + integration tests for storage.js
// OPEN: uses env CANVAS_SYNC_HOME to redirect all file I/O away from real home dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  slugifyCourseCode, classDirFor, readFilesIndex, writeCourse, writeCourseFile, writeFile,
  updateLastSync,
} from '../storage.js';

// --- slugifyCourseCode ---
test('slugifyCourseCode: basic lowercasing', () => {
  assert.equal(slugifyCourseCode('CS101'), 'cs101');
});

test('slugifyCourseCode: spaces become dashes', () => {
  assert.equal(slugifyCourseCode('Intro to CS'), 'intro-to-cs');
});

test('slugifyCourseCode: special chars replaced', () => {
  assert.equal(slugifyCourseCode('MATH 201: Calc I'), 'math-201-calc-i');
});

test('slugifyCourseCode: repeated separators collapsed', () => {
  assert.equal(slugifyCourseCode('BIO--201__Lab'), 'bio-201-lab');
});

test('slugifyCourseCode: leading and trailing dashes trimmed', () => {
  assert.equal(slugifyCourseCode('-CS101-'), 'cs101');
});

test('slugifyCourseCode: null returns null', () => {
  assert.equal(slugifyCourseCode(null), null);
});

test('slugifyCourseCode: empty string returns empty (falsy)', () => {
  const result = slugifyCourseCode('');
  assert.ok(!result);
});

test('slugifyCourseCode: already clean code unchanged', () => {
  assert.equal(slugifyCourseCode('cs101'), 'cs101');
});

// --- writeCourse ---
test('writeCourse: creates expected files in temp home', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-test-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  try {
    const payload = {
      course: {
        id: 42,
        name: 'Test Course',
        course_code: 'TC 101',
        syllabus_body: '<p>Hello</p>',
      },
      assignments: [{ id: 1, name: 'HW1' }],
      modules: [],
      announcements: [],
      pages: [],
      quizzes: [],
      files_index: [],
      instructors: [{ id: 99, display_name: 'Prof Smith', email: 'smith@uni.edu' }],
    };

    const { classDir, slug } = await writeCourse(payload);
    assert.equal(slug, 'tc-101');

    // Check all expected files exist. files_index.json is INTENTIONALLY not
    // in this list — v1.1 made it the exclusive output of writeCourseFile so
    // writeCourse wouldn't clobber real per-file extraction state.
    for (const f of [
      'metadata.json', 'assignments.json', 'modules.json',
      'announcements.json', 'pages.json', 'quizzes.json',
      'syllabus.html',
    ]) {
      await assert.doesNotReject(fs.access(path.join(classDir, f)), `${f} should exist`);
    }

    // Check metadata content.
    const meta = JSON.parse(await fs.readFile(path.join(classDir, 'metadata.json'), 'utf8'));
    assert.equal(meta.name, 'Test Course');
    assert.equal(meta.instructors[0].display_name, 'Prof Smith');

    // Check raw snapshot exists.
    const dateStr = new Date().toISOString().slice(0, 10);
    const rawPath = path.join(tmpHome, 'raw', dateStr, '42', 'payload.json');
    await assert.doesNotReject(fs.access(rawPath), 'raw snapshot should exist');

    // Verify class dir permissions are 700.
    const st = await fs.stat(classDir);
    const mode = st.mode & 0o777;
    assert.equal(mode, 0o700, `classDir mode should be 700, got ${mode.toString(8)}`);
  } finally {
    delete process.env.CANVAS_SYNC_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('writeCourse: fallback slug when course_code missing', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-test-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  try {
    const payload = { course: { id: 7 }, assignments: [], modules: [], announcements: [], pages: [], quizzes: [], files_index: [] };
    const { slug } = await writeCourse(payload);
    assert.equal(slug, 'course-7');
  } finally {
    delete process.env.CANVAS_SYNC_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

// --- ingest ordering contract (regression for the v1.1 first-sync data-loss fix) ---
// The extension MUST POST /ingest/course (writeCourse) before any
// /ingest/course-file (writeCourseFile). writeCourseFile only LOCATES the class
// dir by courseId prefix — it never creates one — so a file arriving first is
// silently dropped. A prior extension build sent files first on the very first
// sync of a class, losing every downloaded file until the next sync. These two
// tests pin both halves of the invariant so a reorder regression fails loudly.
test('writeCourseFile throws when no class dir exists yet (files-before-course is rejected, not silently dropped)', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-test-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  try {
    await assert.rejects(
      writeCourseFile({
        courseId: 42,
        fileId: 1001,
        displayName: 'lecture1.pdf',
        contentType: 'application/pdf',
        size: 3,
        canvasUpdatedAt: '2026-01-01T00:00:00Z',
        dataBase64: Buffer.from('abc').toString('base64'),
      }),
      /no class dir found for courseId 42/,
      'writeCourseFile must throw (not no-op) when the class dir is absent',
    );
    // And nothing should have been written under classes/.
    const classesDir = path.join(tmpHome, 'classes');
    let entries = [];
    try { entries = await fs.readdir(classesDir); } catch { /* dir may not exist */ }
    assert.deepEqual(entries, [], 'no class dir should be created by a stray file ingest');
  } finally {
    delete process.env.CANVAS_SYNC_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('writeCourse then writeCourseFile: correct order persists the file and its index', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-test-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  try {
    // 1. Course first — creates the class dir (the ordering the extension guarantees).
    const { classDir } = await writeCourse({
      course: { id: 42, name: 'Test Course', course_code: 'TC 101' },
      assignments: [], modules: [], announcements: [], pages: [], quizzes: [], files_index: [],
    });

    // 2. Now the file ingest lands and succeeds.
    const bytes = Buffer.from('%PDF-1.4 hello');
    const res = await writeCourseFile({
      courseId: 42,
      fileId: 1001,
      displayName: 'lecture1.pdf',
      contentType: 'application/pdf',
      size: bytes.length,
      canvasUpdatedAt: '2026-01-01T00:00:00Z',
      dataBase64: bytes.toString('base64'),
    });
    assert.equal(res.changed, true, 'first write of a file should report changed');

    // File bytes landed under files/.
    const filePath = path.join(classDir, 'files', 'lecture1.pdf');
    await assert.doesNotReject(fs.access(filePath), 'the downloaded file should be on disk');
    assert.deepEqual(await fs.readFile(filePath), bytes, 'file bytes should match what was ingested');

    // files_index.json is written by writeCourseFile (NOT writeCourse) and records the entry.
    const idx = JSON.parse(await fs.readFile(path.join(classDir, 'files_index.json'), 'utf8'));
    assert.ok(Array.isArray(idx), 'files_index.json should be an array');
    const entry = idx.find(e => e && e.canvasId === 1001);
    assert.ok(entry, 'the ingested file should have an index entry');
    assert.equal(entry.localPath, path.join('files', 'lecture1.pdf'));
  } finally {
    delete process.env.CANVAS_SYNC_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('writeCourseFile preserves a corrupt files index, refuses the ingest, then accepts the missing store', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-test-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  try {
    const { classDir } = await writeCourse({ course: { id: 43, course_code: 'TC 103' } });
    const indexPath = path.join(classDir, 'files_index.json');
    const corrupt = '{"real entries survive":';
    await fs.writeFile(indexPath, corrupt);
    const payload = {
      courseId: 43,
      fileId: 1002,
      displayName: 'lecture2.pdf',
      contentType: 'application/pdf',
      size: 3,
      canvasUpdatedAt: '2026-01-02T00:00:00Z',
      dataBase64: Buffer.from('def').toString('base64'),
    };

    let refusal;
    try { await writeCourseFile(payload); } catch (err) { refusal = err; }
    assert.ok(refusal, 'a corrupt index must refuse the ingest');
    const preserved = (await fs.readdir(classDir))
      .find(name => name.startsWith('files_index.json.unreadable-'));
    assert.ok(preserved, 'the corrupt index must be moved aside');
    assert.match(refusal.message, new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await fs.readFile(path.join(classDir, preserved), 'utf8'), corrupt);
    await assert.rejects(fs.access(indexPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(classDir, 'files', 'lecture2.pdf')), { code: 'ENOENT' });

    const retry = await writeCourseFile(payload);
    assert.equal(retry.changed, true, 'ENOENT remains a legitimate empty index');
    assert.equal(JSON.parse(await fs.readFile(indexPath, 'utf8'))[0].canvasId, 1002);
    assert.equal(await fs.readFile(path.join(classDir, preserved), 'utf8'), corrupt);
  } finally {
    delete process.env.CANVAS_SYNC_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('writeCourseFile refuses an EACCES index without treating it as empty', async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-test-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  let indexPath;
  let preservedPath;
  let originalMode;
  try {
    // Keep this errno test load-bearing against the all-shape mutant too: the
    // route-level test owns preserve/refuse coverage, while this direct probe
    // makes the same site's classification an explicit precondition here.
    const shapeProbe = path.join(tmpHome, 'shape-probe');
    await fs.mkdir(shapeProbe);
    await fs.writeFile(path.join(shapeProbe, 'files_index.json'), JSON.stringify({ entries: [] }));
    const shapeState = await readFilesIndex(shapeProbe);
    assert.equal(shapeState.unreadable, true);
    assert.equal(shapeState.reason, 'shape');

    const { classDir } = await writeCourse({ course: { id: 44, course_code: 'TC 104' } });
    indexPath = path.join(classDir, 'files_index.json');
    const original = JSON.stringify([{ canvasId: 4400, localPath: 'files/existing.pdf' }]);
    await fs.writeFile(indexPath, original);
    originalMode = (await fs.stat(indexPath)).mode & 0o777;
    await fs.chmod(indexPath, 0o000);

    const readError = await fs.readFile(indexPath, 'utf8').then(() => null, err => err);
    if (!readError) {
      t.skip('chmod 000 did not block reads in this environment (running as root or permissions ignored)');
      return;
    }
    assert.equal(readError.code, 'EACCES', `expected chmod to produce EACCES, got ${readError.code}`);

    const payload = {
      courseId: 44,
      fileId: 4401,
      displayName: 'must-not-land.pdf',
      contentType: 'application/pdf',
      size: 3,
      canvasUpdatedAt: '2026-08-29T00:00:00Z',
      dataBase64: Buffer.from('new').toString('base64'),
    };
    let refusal;
    try { await writeCourseFile(payload); } catch (err) { refusal = err; }
    assert.ok(refusal, 'an EACCES index must refuse the ingest');
    assert.match(refusal.message, /could not be read \(EACCES\)/);

    const preserved = (await fs.readdir(classDir))
      .find(name => name.startsWith('files_index.json.unreadable-'));
    assert.ok(preserved, 'the EACCES index must be moved aside');
    preservedPath = path.join(classDir, preserved);
    assert.match(refusal.message, new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await fs.chmod(preservedPath, originalMode);
    assert.equal(await fs.readFile(preservedPath, 'utf8'), original);
    await assert.rejects(fs.access(indexPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(classDir, 'files', 'must-not-land.pdf')), { code: 'ENOENT' });
  } finally {
    if (originalMode !== undefined) {
      if (indexPath) await fs.chmod(indexPath, originalMode).catch(() => {});
      if (preservedPath) await fs.chmod(preservedPath, originalMode).catch(() => {});
    }
    delete process.env.CANVAS_SYNC_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('only the explicitly ranked syllabus candidate can replace the canonical syllabus', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-test-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  try {
    const { classDir } = await writeCourse({
      course: { id: 42, name: 'Test Course', course_code: 'TC 101' },
    });
    const best = Buffer.from('%PDF best and newest syllabus');
    const lowerRanked = Buffer.from('%PDF old syllabus candidate');

    await writeFile({
      courseId: 42,
      filename: 'Course Syllabus Updated.pdf',
      contentType: 'application/pdf',
      isSyllabus: true,
      dataBase64: best.toString('base64'),
    });
    await writeFile({
      courseId: 42,
      filename: 'Course Syllabus Old.pdf',
      contentType: 'application/pdf',
      isSyllabus: false,
      dataBase64: lowerRanked.toString('base64'),
    });

    assert.deepEqual(await fs.readFile(path.join(classDir, 'syllabus.pdf')), best);
    assert.deepEqual(await fs.readFile(path.join(classDir, 'Course Syllabus Old.pdf')), lowerRanked,
      'the lower-ranked source is still preserved under its own name');
  } finally {
    delete process.env.CANVAS_SYNC_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('legacy file ingest without isSyllabus still recognises a syllabus filename', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-test-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  try {
    const { classDir } = await writeCourse({ course: { id: 7, course_code: 'TC 102' } });
    const bytes = Buffer.from('%PDF legacy syllabus');
    await writeFile({
      courseId: 7,
      filename: 'Fall Syllabus.pdf',
      contentType: 'application/pdf',
      dataBase64: bytes.toString('base64'),
    });
    assert.deepEqual(await fs.readFile(path.join(classDir, 'syllabus.pdf')), bytes);
  } finally {
    delete process.env.CANVAS_SYNC_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('updateLastSync: writes correct structure', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cvsync-test-'));
  process.env.CANVAS_SYNC_HOME = tmpHome;
  try {
    await updateLastSync([1, 2, 3]);
    const data = JSON.parse(await fs.readFile(path.join(tmpHome, 'last_sync.json'), 'utf8'));
    assert.deepEqual(data.coursesSeen, [1, 2, 3]);
    assert.ok(data.timestamp);
  } finally {
    delete process.env.CANVAS_SYNC_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
