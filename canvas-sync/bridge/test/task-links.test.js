import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directTaskUrl, taskTitleHtml } from '../public/task-links.js';

test('a Canvas-backed to-do title links directly to its corrected assignment URL', () => {
  const item = {
    id: 'canvas-532620',
    title: 'Concept Check',
    origin: 'canvas',
    html_url: 'https://canvas.rice.edu/courses/93903/quizzes/244811',
  };

  const html = taskTitleHtml(item);
  assert.match(html, /^<a class="task-title linky-title"/);
  assert.match(html, /href="https:\/\/canvas\.rice\.edu\/courses\/93903\/quizzes\/244811"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /data-open-assignment/);
});

test('syllabus-only work keeps its local detail page because Canvas has no assignment page', () => {
  const html = taskTitleHtml({
    id: 'weekly-reading',
    title: 'Weekly reading',
    origin: 'syllabus',
    html_url: 'https://canvas.rice.edu/stale-link',
  });

  assert.match(html, /^<button type="button"/);
  assert.match(html, /data-open-assignment="weekly-reading"/);
  assert.doesNotMatch(html, /href=/);
});

test('the direct destination accepts only web URLs and escapes rendered values', () => {
  assert.equal(directTaskUrl({ origin: 'canvas', html_url: 'javascript:alert(1)' }), null);
  assert.equal(directTaskUrl({ origin: 'syllabus', html_url: 'https://canvas.example/a' }), null);

  const html = taskTitleHtml({
    id: 'unsafe&quot;',
    title: '<Unsafe & title>',
    origin: 'canvas',
    html_url: 'javascript:alert(1)',
  });
  assert.doesNotMatch(html, /href=/);
  assert.match(html, /&lt;Unsafe &amp; title&gt;/);
  assert.match(html, /data-open-assignment="unsafe&amp;quot;"/);
});
