// Run once: node generate-sample-pdf.js
// Generates a minimal valid 1-page text PDF at sample-syllabus.pdf
// Uses no external dependencies — pure PDF byte construction.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildPdf(text) {
  const lines = text.split('\n').slice(0, 40);
  const escapedLines = lines.map(l =>
    l.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  );

  let streamContent = 'BT\n/F1 11 Tf\n72 750 Td\n12 TL\n';
  for (const line of escapedLines) {
    streamContent += `(${line}) Tj T*\n`;
  }
  streamContent += 'ET\n';

  const streamBytes = Buffer.from(streamContent, 'latin1');
  const streamLen = streamBytes.length;

  const objects = [];

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj');
  objects.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj');
  objects.push(`4 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamContent}endstream\nendobj`);
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj');

  let body = '%PDF-1.4\n';
  const offsets = [];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(body.length);
    body += objects[i] + '\n';
  }

  const xrefOffset = body.length;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += String(off).padStart(10, '0') + ' 00000 n \n';
  }

  const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, 'latin1');
}

const syllabusText = `ECON 370: Intermediate Microeconomics
Spring 2026 - University of Economics

Instructor: Dr. Sandra Ortega
Email: sortega@university.edu
Office Hours: Mon/Wed 2:00-4:00pm, Econ Hall 312
Class Meeting: MWF 10:00-10:50am, Econ Hall 201

COURSE DESCRIPTION
This course develops intermediate-level microeconomic theory covering consumer
choice, producer theory, market equilibrium, and welfare analysis.

GRADING
Problem Sets (5 total): 20% - Lowest score dropped
Midterm Exam: 30% - In-class, closed book
Final Exam: 40% - Cumulative
Participation: 10% - Attendance and discussion

Grading Scale: A 93-100, A- 90-92, B+ 87-89, B 83-86, B- 80-82
C+ 77-79, C 73-76, C- 70-72, D 60-69, F below 60

Late Policy: 10% deduction per day. No late exams without prior arrangement.

SCHEDULE
Week 1 - Jan 20: Introduction and Course Overview
Week 2 - Jan 27: Preferences and Utility | DUE: Syllabus Quiz
Week 4 - Feb 14: Demand Curves | DUE: Problem Set 1
Week 8 - Mar 14: Spring Break - No Class
Week 11 - Apr 5: Production Functions | DUE: Problem Set 2
Week 14 - May 1: Market Equilibrium | DUE: Problem Set 3
Week 16 - May 15: MIDTERM EXAM - Econ Hall 201
Week 20 - Jun 5: FINAL EXAM (tentative - see registrar)

POLICIES
Attendance: Expected at all meetings. 3+ unexcused absences affect participation grade.
Academic Integrity: Submitted work must be your own. Exams are strictly individual.
Accommodations: Contact Office of Disability Services within first two weeks.
Devices: Silenced during class; laptops for note-taking only.`;

const pdfBuf = buildPdf(syllabusText);
const outPath = join(__dirname, 'sample-syllabus.pdf');
writeFileSync(outPath, pdfBuf);
console.log(`Written ${pdfBuf.length} bytes to ${outPath}`);
