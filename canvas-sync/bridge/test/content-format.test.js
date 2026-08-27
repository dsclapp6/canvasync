import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderReadableText } from '../public/content-format.js';

test('Markdown content renders document structure and safe links', () => {
  const html = renderMarkdown(`# Instructions

1. Read **chapter 3**.
2. Submit the \`memo\`.

> Bring questions.

[Course page](https://canvas.example.edu/course)`);
  assert.match(html, /<h1>Instructions<\/h1>/);
  assert.match(html, /<ol>[\s\S]*<strong>chapter 3<\/strong>[\s\S]*<code>memo<\/code>[\s\S]*<\/ol>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

test('hostile content remains text and cannot mint a javascript link', () => {
  const html = renderMarkdown('[bad](javascript:alert(1)) <img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;img/);
});

test('a PDF extract is reflowed into headings, paragraphs, and lists', () => {
  const html = renderReadableText(`Course Guide

This sentence was wrapped at the
edge of the PDF page.

Requirements
1. Read the case.
2. Bring notes.`, '.pdf');
  assert.match(html, /<h1>Course Guide<\/h1>/);
  assert.match(html, /<p>This sentence was wrapped at the edge of the PDF page\.<\/p>/);
  assert.match(html, /<h2>Requirements<\/h2>/);
  assert.match(html, /<ol>[\s\S]*Read the case[\s\S]*Bring notes[\s\S]*<\/ol>/);
});

test('a slide extract becomes an outline with clickable source links', () => {
  const html = renderReadableText(`Channel Strategy
Learning Outcomes
Understand intermediaries
Explain disintermediation
This concept sets up the next session.
https://example.edu/source`, '.pptx');
  assert.match(html, /<h1>Channel Strategy<\/h1>/);
  assert.match(html, /<h2>Learning Outcomes<\/h2>/);
  assert.match(html, /class="source-points"/);
  assert.match(html, /href="https:\/\/example\.edu\/source"/);
});

test('JSON content is indented inside a code block', () => {
  const html = renderReadableText('{"due":true,"count":2}', '.json');
  assert.match(html, /<pre><code>/);
  assert.match(html, /\n  &quot;due&quot;: true/);
});

test('a DOCX extract with no blank lines does not become one enormous heading', () => {
  const html = renderReadableText(`Course Syllabus
Course Overview
Communication matters. This course builds practical skills.
Learning Outcomes
Write clearly and present confidently.`, '.docx');
  assert.match(html, /^<h1>Course Syllabus<\/h1>/);
  assert.match(html, /<h2>Course Overview<\/h2>/);
  assert.match(html, /<p>Communication matters/);
  assert.doesNotMatch(html, /<h1>[^<]*Communication matters/);
});
