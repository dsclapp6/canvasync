// mock-canvas-server.js — Minimal Node HTTP server (no deps) serving canned Canvas API
// fixtures for manual smoke testing of the extension. Runs on port 4747.
//
// OPEN: This server requires a dev build of the extension with host_permissions
// rewritten to include "http://localhost:4747/*" and CANVAS_BASE changed to
// "http://localhost:4747" in canvas-client.js. Do not use in production builds.
//
// Usage:
//   node extension/test/mock-canvas-server.js
//   Then load the dev extension, navigate to a page that triggers a sync, and
//   watch the terminal for request logs.

'use strict';

const http = require('http');
const PORT = 4747;

// ---------------------------------------------------------------------------
// Canned fixtures
// ---------------------------------------------------------------------------

const COURSES = [
  {
    id: '101',
    name: 'Introduction to Computer Science',
    course_code: 'COMP 101',
    enrollment_state: 'active',
    syllabus_body: '<p>Welcome to COMP 101.</p>',
    public_description: 'Foundational CS concepts.',
    term: { id: '1', name: 'Spring 2026', start_at: '2026-01-12T00:00:00Z', end_at: '2026-05-10T00:00:00Z' },
  },
  {
    id: '202',
    name: 'Data Structures and Algorithms',
    course_code: 'COMP 202',
    enrollment_state: 'active',
    syllabus_body: '<p>Advanced data structures.</p>',
    public_description: 'Trees, graphs, and complexity.',
    term: { id: '1', name: 'Spring 2026', start_at: '2026-01-12T00:00:00Z', end_at: '2026-05-10T00:00:00Z' },
  },
];

const ASSIGNMENTS = {
  '101': [
    { id: 'a1', name: 'HW 1: Hello World', due_at: '2026-02-01T23:59:00Z', points_possible: 10 },
    { id: 'a2', name: 'HW 2: Loops',       due_at: '2026-02-15T23:59:00Z', points_possible: 20 },
  ],
  '202': [
    { id: 'a3', name: 'HW 1: Arrays',      due_at: '2026-02-05T23:59:00Z', points_possible: 15 },
    { id: 'a4', name: 'HW 2: Linked List', due_at: '2026-02-20T23:59:00Z', points_possible: 25 },
  ],
};

// Syllabus "PDF" — just a text file with PDF-like content for smoke testing.
// OPEN: Real tests should use an actual minimal PDF binary.
const SYLLABUS_CONTENT = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'
);

const FILES = {
  '101': [
    {
      id: 'f1',
      display_name: 'COMP101-Syllabus.pdf',
      url: `http://localhost:${PORT}/files/f1/download`,
      'content-type': 'application/pdf',
      size: SYLLABUS_CONTENT.length,
    },
  ],
  '202': [],
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendBinary(res, contentType, buf) {
  res.writeHead(200, {
    'Content-Type':   contentType,
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  console.log(`[mock] ${req.method} ${path}`);

  // Courses list
  if (path === '/api/v1/courses') {
    return sendJson(res, 200, COURSES);
  }

  // Assignments
  const assignMatch = path.match(/^\/api\/v1\/courses\/(\d+)\/assignments$/);
  if (assignMatch) {
    const cid = assignMatch[1];
    return sendJson(res, 200, ASSIGNMENTS[cid] ?? []);
  }

  // Modules (empty for simplicity)
  if (/^\/api\/v1\/courses\/\d+\/modules$/.test(path)) {
    return sendJson(res, 200, []);
  }

  // Announcements (empty)
  if (path === '/api/v1/announcements') {
    return sendJson(res, 200, []);
  }

  // Pages (empty)
  if (/^\/api\/v1\/courses\/\d+\/pages$/.test(path)) {
    return sendJson(res, 200, []);
  }

  // Quizzes (empty)
  if (/^\/api\/v1\/courses\/\d+\/quizzes$/.test(path)) {
    return sendJson(res, 200, []);
  }

  // Files index
  const filesMatch = path.match(/^\/api\/v1\/courses\/(\d+)\/files$/);
  if (filesMatch) {
    const cid = filesMatch[1];
    return sendJson(res, 200, FILES[cid] ?? []);
  }

  // Syllabus binary download
  const dlMatch = path.match(/^\/files\/(f\d+)\/download$/);
  if (dlMatch) {
    return sendBinary(res, 'application/pdf', SYLLABUS_CONTENT);
  }

  // Fallback
  sendJson(res, 404, { error: 'Not found', path });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = http.createServer(handle);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-canvas-server] Listening on http://127.0.0.1:${PORT}`);
  console.log('Serving 2 courses with 2 assignments each and 1 syllabus file.');
  console.log('Press Ctrl+C to stop.');
});
