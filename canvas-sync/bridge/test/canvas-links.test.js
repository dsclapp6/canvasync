// canvas-links.test.js — the URL a student can actually open.
//
// The bug this guards against is invisible from the data: a quiz-backed
// assignment's html_url is a perfectly well-formed Canvas URL that returns
// "Access Denied" to the only person who matters. So the fixtures below are
// copied verbatim out of a real synced course (BUSI 380 002, Rice) rather than
// invented — 39 of its 41 assignments are quiz-backed, which is exactly the
// shape that made every calendar row a dead end.
//
// QUIZ_ASSIGNMENT and QUIZ_OBJECT are the two halves of the same piece of work
// as Canvas reports them. The load-bearing assertion in this file is that
// canvasItemUrl(QUIZ_ASSIGNMENT) reproduces QUIZ_OBJECT.html_url exactly: the
// quiz's own self-reported URL is the ground truth for where a student goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCourseUrl, canvasItemUrl, canvasSubmitUrl, needsUrlRewrite,
} from '../../canvas-links.js';

// Real, from classes/93903-busi-380-002/assignments.json (description and the
// dozens of grading/moderation flags trimmed; every field the module reads is
// as Canvas sent it).
const QUIZ_ASSIGNMENT = {
  id: '532620',
  name: 'S2a-Concept Check: Assess Multi-Channel Management Opportunities & Challenges (6:39)',
  html_url: 'https://canvas.rice.edu/courses/93903/assignments/532620',
  quiz_id: '137979',
  is_quiz_assignment: true,
  submission_types: ['online_quiz'],
  due_at: '2026-09-01T19:30:00Z',
  points_possible: 100,
  course_id: '93903',
  published: true,
  locked_for_user: false,
  workflow_state: 'published',
};

// Real, from the same course's quizzes.json — the object QUIZ_ASSIGNMENT is a
// shadow of. assignment_id points back, which is how we know they are a pair.
const QUIZ_OBJECT = {
  id: '137979',
  title: 'S2a-Concept Check: Assess Multi-Channel Management Opportunities & Challenges (6:39)',
  html_url: 'https://canvas.rice.edu/courses/93903/quizzes/137979',
  quiz_type: 'assignment',
  assignment_id: '532620',
};

// Real, from the same file — one of only two assignments in the course that is
// a genuine upload rather than a quiz.
const UPLOAD_ASSIGNMENT = {
  id: '532645',
  name: 'Midterm Case Assignment-Group Assignment',
  html_url: 'https://canvas.rice.edu/courses/93903/assignments/532645',
  is_quiz_assignment: false,
  submission_types: ['online_upload'],
  due_at: '2026-10-08T18:00:00Z',
  points_possible: 100,
  course_id: '93903',
  published: true,
  locked_for_user: true,
  workflow_state: 'published',
};

// Canvas shape for an assignment that is really a graded discussion. No class
// on disk has one today, so this is synthesised from the API's documented
// shape rather than copied — kept in the same course so the base URL is real.
const DISCUSSION_ASSIGNMENT = {
  id: '532700',
  name: 'Week 4 discussion: channel conflict',
  html_url: 'https://canvas.rice.edu/courses/93903/assignments/532700',
  submission_types: ['discussion_topic'],
  discussion_topic: { id: '412233', title: 'Week 4 discussion: channel conflict' },
};

// Real, from classes/92354-busi-396-.../assignments.json. An LTI launch: the
// work happens inside the tool embedded on the assignment page, so Canvas has
// no /submissions/new route for it. Six of these exist across BUSI 396 and
// ENTR 222 and none were covered before.
const EXTERNAL_TOOL_ASSIGNMENT = {
  id: '531987',
  name: 'Think, Then Do Module Quiz',
  html_url: 'https://canvas.rice.edu/courses/92354/assignments/531987',
  submission_types: ['external_tool'],
  is_quiz_assignment: false,
  course_id: '92354',
  points_possible: 5,
};

// Real, from classes/94038-entr-222-001/assignments.json. Attendance the
// instructor takes; the student submits nothing at all.
const ROLL_CALL_ASSIGNMENT = {
  id: '527391',
  name: 'Roll Call Attendance',
  html_url: 'https://canvas.rice.edu/courses/94038/assignments/527391',
  submission_types: ['external_tool'],
  is_quiz_assignment: false,
  course_id: '94038',
  due_at: null,
  points_possible: 0,
};

// Real, same course — a multi-type list where every type is submittable. The
// existing suite only covered a mixed list containing an unsubmittable type,
// so the ordinary multi-type case was untested.
const MULTI_TYPE_ASSIGNMENT = {
  id: '527375',
  name: 'Diverge: Interview Plan',
  html_url: 'https://canvas.rice.edu/courses/94038/assignments/527375',
  submission_types: ['online_url', 'online_upload'],
  is_quiz_assignment: false,
  course_id: '94038',
  points_possible: 7.5,
};

// Real, from classes/92336-busi-374-001-002 and 94038-entr-222-001. The suite
// synthesised these two by overwriting UPLOAD_ASSIGNMENT.submission_types;
// these are the rows as Canvas actually sent them.
const NOT_GRADED_ASSIGNMENT = {
  id: '530642',
  name: 'Team Roster Submission',
  html_url: 'https://canvas.rice.edu/courses/92336/assignments/530642',
  submission_types: ['not_graded'],
  course_id: '92336',
  points_possible: null,
};

const NONE_ASSIGNMENT = {
  id: '527363',
  name: 'Attendance and Participation',
  html_url: 'https://canvas.rice.edu/courses/94038/assignments/527363',
  submission_types: ['none'],
  course_id: '94038',
  due_at: null,
  points_possible: 10,
};

// --- parseCourseUrl --------------------------------------------------------

test('parseCourseUrl splits a Canvas course URL into base and course id', () => {
  assert.deepEqual(parseCourseUrl(QUIZ_ASSIGNMENT.html_url), {
    base: 'https://canvas.rice.edu', courseId: '93903',
  });
});

test('parseCourseUrl accepts http and a port (the mock Canvas in extension/test)', () => {
  assert.deepEqual(parseCourseUrl('http://localhost:4747/courses/12345/assignments/1'), {
    base: 'http://localhost:4747', courseId: '12345',
  });
});

test('parseCourseUrl returns null for anything not course-shaped', () => {
  assert.equal(parseCourseUrl(null), null);
  assert.equal(parseCourseUrl(undefined), null);
  assert.equal(parseCourseUrl(''), null);
  assert.equal(parseCourseUrl('not a url at all'), null);
  assert.equal(parseCourseUrl('https://example.com/reading.pdf'), null);
  // A non-numeric course segment is not a course id.
  assert.equal(parseCourseUrl('https://canvas.rice.edu/courses/abc/assignments/1'), null);
  // /courses must be the first path segment; a lookalike deeper in is not one.
  assert.equal(parseCourseUrl('https://canvas.rice.edu/users/1/courses/93903'), null);
});

// --- canvasItemUrl: the rewrite --------------------------------------------

test('a quiz-backed assignment rewrites to the quiz page', () => {
  assert.equal(
    canvasItemUrl(QUIZ_ASSIGNMENT),
    'https://canvas.rice.edu/courses/93903/quizzes/137979',
  );
});

test("the rewritten URL is exactly the quiz object's own html_url", () => {
  // Canvas itself is the oracle here: the quiz row in quizzes.json is the page
  // a student is allowed to open. If these ever diverge the rewrite is wrong,
  // no matter how plausible the string looks.
  assert.equal(canvasItemUrl(QUIZ_ASSIGNMENT), QUIZ_OBJECT.html_url);
});

test('a plain upload assignment keeps its html_url untouched', () => {
  assert.equal(canvasItemUrl(UPLOAD_ASSIGNMENT), UPLOAD_ASSIGNMENT.html_url);
});

test('a discussion-backed assignment rewrites to the discussion topic', () => {
  assert.equal(
    canvasItemUrl(DISCUSSION_ASSIGNMENT),
    'https://canvas.rice.edu/courses/93903/discussion_topics/412233',
  );
});

test('quiz_id wins over a discussion_topic when Canvas reports both', () => {
  const both = { ...QUIZ_ASSIGNMENT, discussion_topic: { id: '412233' } };
  assert.equal(canvasItemUrl(both), QUIZ_OBJECT.html_url);
});

test('quiz_id is trusted even when submission_types disagrees', () => {
  // Canvas reports online_quiz on assignments with no quiz object and, more
  // rarely, the reverse. The id is the thing that can actually be resolved.
  const noQuizType = { ...QUIZ_ASSIGNMENT, submission_types: ['online_upload'] };
  assert.equal(canvasItemUrl(noQuizType), QUIZ_OBJECT.html_url);
});

test('online_quiz with no quiz_id stays on the assignment URL', () => {
  // There is nothing to rewrite to; guessing a quiz id would be worse than the
  // link the user already had.
  const noId = { ...QUIZ_ASSIGNMENT, quiz_id: undefined };
  assert.equal(canvasItemUrl(noId), QUIZ_ASSIGNMENT.html_url);
});

test('camelCase quizId is accepted alongside quiz_id', () => {
  const camel = { html_url: QUIZ_ASSIGNMENT.html_url, quizId: '137979' };
  assert.equal(canvasItemUrl(camel), QUIZ_OBJECT.html_url);
});

// --- canvasItemUrl: never throws -------------------------------------------

test('canvasItemUrl survives missing, null and malformed input', () => {
  assert.equal(canvasItemUrl(null), null);
  assert.equal(canvasItemUrl(undefined), null);
  // No html_url at all: nothing sane to return but null, and callers fall back.
  assert.equal(canvasItemUrl({}), null);
  assert.equal(canvasItemUrl({ html_url: null }), null);
  assert.equal(canvasItemUrl({ html_url: '' }), null);
  // Malformed strings come back unchanged rather than mangled.
  assert.equal(canvasItemUrl({ html_url: 'not a url' }), 'not a url');
  assert.equal(canvasItemUrl({ html_url: 42 }), 42);
});

test('a quiz_id with no usable html_url yields null, not a half-built URL', () => {
  // Without a base and course id there is no URL to build. Returning a relative
  // fragment would put "/courses/undefined/..." in front of the user.
  assert.equal(canvasItemUrl({ quiz_id: '137979' }), null);
  assert.equal(canvasItemUrl({ quiz_id: '137979', html_url: 'garbage' }), 'garbage');
});

test('a URL with no /courses/<id> segment passes straight through', () => {
  const external = {
    id: '1',
    name: 'Read the case on HBR',
    html_url: 'https://hbsp.harvard.edu/product/R1234-PDF-ENG',
    quiz_id: '999',
  };
  // Even with a quiz_id there is no course path to build on, so nothing is
  // invented. Note this passes because of the PATH shape, not the host: see
  // the next test for what a foreign host with a course-shaped path does.
  assert.equal(canvasItemUrl(external), external.html_url);
});

test('a foreign host with a course-shaped path IS rewritten (no host check)', () => {
  // Documents real behaviour, not an endorsement of it. parseCourseUrl matches
  // any http(s) origin, so the "we cannot know a foreign host's routing"
  // guarantee only holds for URLs whose path is not /courses/<digits>/...
  // Deliberate: the extension's mock Canvas is http://localhost:<port>, so a
  // hostname allowlist cannot be the discriminator. Recorded as D4 in
  // LINK-AUDIT.md so the contract and the code agree about what is promised.
  assert.equal(
    canvasItemUrl({ html_url: 'https://not-canvas.example/courses/1/assignments/2', quiz_id: '9' }),
    'https://not-canvas.example/courses/1/quizzes/9',
  );
});

// --- canvasSubmitUrl -------------------------------------------------------

test('a normal assignment submits at /submissions/new', () => {
  assert.equal(
    canvasSubmitUrl(UPLOAD_ASSIGNMENT),
    'https://canvas.rice.edu/courses/93903/assignments/532645/submissions/new',
  );
});

test('a quiz submits by being taken', () => {
  assert.equal(
    canvasSubmitUrl(QUIZ_ASSIGNMENT),
    'https://canvas.rice.edu/courses/93903/quizzes/137979/take',
  );
});

test('nothing to submit to returns null so the button can be hidden', () => {
  for (const type of ['on_paper', 'none', 'not_graded']) {
    const item = { ...UPLOAD_ASSIGNMENT, submission_types: [type] };
    assert.equal(canvasSubmitUrl(item), null, `${type} should have no submit URL`);
  }
});

test('an unsubmittable type poisons the whole list, even mixed with a real one', () => {
  // Canvas emits multi-type lists; if any of them says there is no submission
  // route, offering one is a lie. Seen on ENTR 222 and BUSI 374 rows.
  const mixed = { ...UPLOAD_ASSIGNMENT, submission_types: ['online_upload', 'not_graded'] };
  assert.equal(canvasSubmitUrl(mixed), null);
});

test('a quiz marked not_graded still has no submit URL', () => {
  // The exclusion is checked before the quiz branch, deliberately: an ungraded
  // survey is not work the user has to hand in.
  const survey = { ...QUIZ_ASSIGNMENT, submission_types: ['not_graded'] };
  assert.equal(canvasSubmitUrl(survey), null);
});

test('canvasSubmitUrl survives missing, null and malformed input', () => {
  assert.equal(canvasSubmitUrl(null), null);
  assert.equal(canvasSubmitUrl(undefined), null);
  assert.equal(canvasSubmitUrl({}), null);
  assert.equal(canvasSubmitUrl({ html_url: null }), null);
  assert.equal(canvasSubmitUrl({ html_url: 'not a url', id: '5' }), null);
  // submission_types is not always an array on hand-rolled/mined rows; a
  // non-array must not throw on .includes.
  assert.equal(
    canvasSubmitUrl({ ...UPLOAD_ASSIGNMENT, submission_types: null }),
    'https://canvas.rice.edu/courses/93903/assignments/532645/submissions/new',
  );
});

test('an assignment with no id has no submission route', () => {
  const { id, ...noId } = UPLOAD_ASSIGNMENT;
  assert.equal(canvasSubmitUrl(noId), null);
});

test('a non-Canvas host gets no invented submit URL', () => {
  assert.equal(canvasSubmitUrl({
    id: '1', html_url: 'https://hbsp.harvard.edu/product/R1234-PDF-ENG',
    submission_types: ['online_upload'],
  }), null);
});

// --- shapes the real corpus contains that the first pass missed -------------

test('the real not_graded and none rows get no submit URL', () => {
  // Previously only covered by overwriting UPLOAD_ASSIGNMENT.submission_types.
  // These are the rows as Canvas sent them, from two different courses.
  assert.equal(canvasSubmitUrl(NOT_GRADED_ASSIGNMENT), null);
  assert.equal(canvasSubmitUrl(NONE_ASSIGNMENT), null);
  // ...and neither is a rewrite candidate.
  assert.equal(canvasItemUrl(NOT_GRADED_ASSIGNMENT), NOT_GRADED_ASSIGNMENT.html_url);
  assert.equal(canvasItemUrl(NONE_ASSIGNMENT), NONE_ASSIGNMENT.html_url);
});

test('a multi-type list where everything is submittable still submits', () => {
  assert.equal(
    canvasSubmitUrl(MULTI_TYPE_ASSIGNMENT),
    'https://canvas.rice.edu/courses/94038/assignments/527375/submissions/new',
  );
});

test('an item URL keeps its course, not the course of a previous call', () => {
  // parseCourseUrl is called per item; a module-level regex with /g state or a
  // cached base would cross-contaminate courses. Two courses, interleaved.
  assert.equal(canvasItemUrl(QUIZ_ASSIGNMENT), 'https://canvas.rice.edu/courses/93903/quizzes/137979');
  assert.equal(canvasItemUrl(MULTI_TYPE_ASSIGNMENT), MULTI_TYPE_ASSIGNMENT.html_url);
  assert.equal(canvasItemUrl(QUIZ_ASSIGNMENT), 'https://canvas.rice.edu/courses/93903/quizzes/137979');
});

test('a module_item_id query string does not defeat the rewrite', () => {
  // Canvas hands back html_url with ?module_item_id=... when the assignment is
  // reached through a module. The rewrite targets the quiz object, so the
  // query is dropped rather than carried onto a different route.
  const viaModule = {
    ...QUIZ_ASSIGNMENT,
    html_url: `${QUIZ_ASSIGNMENT.html_url}?module_item_id=1284119`,
  };
  assert.equal(canvasItemUrl(viaModule), QUIZ_OBJECT.html_url);
  assert.equal(needsUrlRewrite(viaModule), true);
});

// --- defects found by the link audit, now fixed ----------------------------
//
// Each of these was a real way to send the user somewhere that was not the
// thing they clicked. They were recorded as failing todos first and the fixes
// landed in canvas-links.js afterwards; the write-up is in LINK-AUDIT.md under
// "Review findings".

test('D2: an external_tool assignment offers no submissions/new route', () => {
  // LTI work is handed in inside the tool on the assignment page; Canvas has no
  // /submissions/new for it. Roll Call Attendance is the sharpest case -- the
  // student submits nothing at all, yet today gets a Submit button.
  assert.equal(canvasSubmitUrl(EXTERNAL_TOOL_ASSIGNMENT), null);
  assert.equal(canvasSubmitUrl(ROLL_CALL_ASSIGNMENT), null);
});

test('D1: a non-scalar quiz_id is not pasted into a URL', () => {
  // Today these stringify straight into the path. The empty-array case is the
  // dangerous one: it yields .../quizzes/ -- the course quiz INDEX, a real page
  // that loads fine and is not the item the user clicked. That is inventing
  // data, which this codebase forbids; falling back to html_url is honest.
  const base = { html_url: QUIZ_ASSIGNMENT.html_url };
  for (const bad of [{}, [], [1, 2], true, '  ', '13/../../x']) {
    assert.equal(canvasItemUrl({ ...base, quiz_id: bad }), QUIZ_ASSIGNMENT.html_url,
      `quiz_id ${JSON.stringify(bad)} should fall back to html_url`);
  }
});

test('D1: a non-scalar assignment id yields no submit URL', () => {
  // `id: []` currently produces .../assignments//submissions/new -- note the
  // empty path segment. There is no assignment to submit to; null is correct.
  for (const bad of [{}, [], true]) {
    assert.equal(canvasSubmitUrl({ html_url: UPLOAD_ASSIGNMENT.html_url, id: bad }), null,
      `id ${JSON.stringify(bad)} should have no submit URL`);
  }
});

test('D3: a bare-string submission_types is still honoured', () => {
  // Array.isArray() is false for a string, so the exclusion list is skipped
  // entirely and an ungraded row gets a submit URL. Mined/hand-rolled rows are
  // exactly the ones likely to carry a scalar here.
  assert.equal(canvasSubmitUrl({ ...UPLOAD_ASSIGNMENT, submission_types: 'not_graded' }), null);
});

test('D5: a course segment with trailing junk is not a course id', () => {
  // (\d+) stops at the first non-digit and never checks what follows, so
  // /courses/93903abc/ silently resolves to course 93903.
  assert.equal(parseCourseUrl('https://canvas.rice.edu/courses/93903abc/assignments/1'), null);
});

// --- needsUrlRewrite -------------------------------------------------------

test('needsUrlRewrite is true exactly when the URL changed', () => {
  assert.equal(needsUrlRewrite(QUIZ_ASSIGNMENT), true);
  assert.equal(needsUrlRewrite(DISCUSSION_ASSIGNMENT), true);
  assert.equal(needsUrlRewrite(UPLOAD_ASSIGNMENT), false);
  // Every non-quiz shape the real corpus actually contains is a no-op. These
  // are separate literals rather than a loop over canvasItemUrl(): comparing
  // needsUrlRewrite against its own definition restates the implementation and
  // cannot fail, so it would pass even if canvasItemUrl returned nonsense.
  assert.equal(needsUrlRewrite(EXTERNAL_TOOL_ASSIGNMENT), false);
  assert.equal(needsUrlRewrite(MULTI_TYPE_ASSIGNMENT), false);
  assert.equal(needsUrlRewrite(NOT_GRADED_ASSIGNMENT), false);
  assert.equal(needsUrlRewrite(NONE_ASSIGNMENT), false);
});

test('needsUrlRewrite is false, not throwing, when there is no URL to compare', () => {
  assert.equal(needsUrlRewrite(null), false);
  assert.equal(needsUrlRewrite(undefined), false);
  assert.equal(needsUrlRewrite({}), false);
  assert.equal(needsUrlRewrite({ html_url: null, quiz_id: '137979' }), false);
  assert.equal(needsUrlRewrite({ html_url: 'not a url' }), false);
});

// --- the shape of the real course ------------------------------------------

test('the BUSI 380 pair is representative: 1 of these 2 rows was a dead end', () => {
  // A miniature of the real ratio (39/41). Kept as a test rather than a comment
  // so that a regression in either direction — rewriting uploads, or failing to
  // rewrite quizzes — fails here loudly.
  const course = [QUIZ_ASSIGNMENT, UPLOAD_ASSIGNMENT];
  assert.equal(course.filter(needsUrlRewrite).length, 1);
  assert.deepEqual(course.map(canvasItemUrl), [
    'https://canvas.rice.edu/courses/93903/quizzes/137979',
    'https://canvas.rice.edu/courses/93903/assignments/532645',
  ]);
});
