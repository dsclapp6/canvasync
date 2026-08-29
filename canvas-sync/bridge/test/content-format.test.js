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

test('PDF labels, grading rows, and schedule weeks stay content instead of invented headings', () => {
  const html = renderReadableText(`ECON 370: Intermediate Microeconomics
Spring 2026 - University of Economics

Instructor: Dr. Sandra Ortega
Email: sortega@university.edu
Class Meeting: MWF 10:00-10:50am, Econ Hall 201

GRADING
Problem Sets (5 total): 20% - Lowest score dropped
Final Exam: 40% - Cumulative

SCHEDULE
Week 1 - Jan 20: Introduction and Course Overview
Week 2 - Jan 27: Preferences and Utility`, '.pdf');
  assert.match(html, /<strong>Instructor:<\/strong>/);
  assert.match(html, /class="source-line"><strong>Final Exam:<\/strong>/);
  assert.match(html, /class="source-line"><strong>Week 1/);
  assert.doesNotMatch(html, /<h2>Class Meeting:/);
  assert.doesNotMatch(html, /<h2>Final Exam:/);
  assert.doesNotMatch(html, /<h2>Week 1/);
});

test('a wrapped BUSI 380 textbook citation remains one lettered list item', () => {
  const html = renderReadableText(`Marketing (BUSI 380) Fall 2026

Course Materials
Professor Porter has assigned readings from the following textbooks in
an electronic-book (e-book) version:
• Textbook
A. (ISBN 979-8-989-6021-1-7) Capon, Noel Managing Marketing in the 21
st
 Century:
Develop and Manage, Fifth Edition, 2024.
B. MBM Handbook: Customer Value (Second Edition)
Steps to get full access to the handbook and student companion:
4. Select from the top menu what you wish to access. HANDBOOK or
STUDENT COMPANION

Attendance and Absence Policies
Regular class attendance is vital for learning.`, '.pdf');
  assert.match(html, /<h2>Course Materials<\/h2>/);
  assert.match(html, /<ol class="source-alpha" type="A">/);
  assert.match(html, /<li>\(ISBN 979-8-989-6021-1-7\)[\s\S]*21st Century: Develop and Manage, Fifth Edition, 2024\.<\/li>/);
  assert.match(html, /<li>MBM Handbook: Customer Value \(Second Edition\) Steps to get full access to the handbook and student companion:<\/li>/);
  assert.match(html, /<li>Select from the top menu what you wish to access\. HANDBOOK or STUDENT COMPANION<\/li>/);
  assert.match(html, /<h2>Attendance and Absence Policies<\/h2>/);
  assert.doesNotMatch(html, /<h2>an electronic-book/);
  assert.doesNotMatch(html, /<h2>Century/);
  assert.doesNotMatch(html, /<h2>STUDENT COMPANION/);
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

test('snake_case survives; only free-standing underscores mean emphasis', () => {
  // The over-greedy rule treated every underscore as an emphasis delimiter, so
  // identifiers lost the underscores that make them readable. The live case was
  // a BUSI 396 pack line, "submit via: online_text_entry, online_url,
  // media_recording", which rendered as "onlinetextentry, onlineurl,
  // mediarecording" — three values silently welded into nonsense.
  const html = renderMarkdown('submit via: online_text_entry, online_url, media_recording');
  assert.doesNotMatch(html, /<em>/);
  assert.match(html, /online_text_entry/);
  assert.match(html, /media_recording/);

  // Identifiers of every shape stay literal, including a trailing digit.
  for (const token of ['file_name_test', 'my_var_2', 'MAX_TITLE', '_leading', 'trailing_']) {
    const out = renderMarkdown(token);
    assert.doesNotMatch(out, /<em>/, `${token} should not italicise: ${out}`);
    assert.match(out, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${token} should survive intact: ${out}`);
  }

  // Emphasis still works where the underscores are free-standing — this rule
  // is load-bearing for the AI_CONTEXT packs, which italicise their own notes.
  assert.match(renderMarkdown('_From the syllabus._'), /<em>From the syllabus\.<\/em>/);
  assert.match(renderMarkdown('a _real_ emphasis here'), /a <em>real<\/em> emphasis here/);
  assert.match(renderMarkdown('(_parenthesised_)'), /\(<em>parenthesised<\/em>\)/);
});

