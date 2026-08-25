Given the parsed syllabus data and Canvas assignment list below, produce a concise bulleted list of open questions and ambiguities an AI assistant should be aware of when helping a student with this course.

Focus on:
- Discrepancies between syllabus-listed assignments/exams and what appears in Canvas (missing, renamed, date mismatches)
- Low-confidence parser output (flag if extraction_confidence is medium or low, or if extraction_notes are non-trivial)
- Missing data that a student would need (no grading breakdown, no late policy, no instructor contact)
- Contradictions within the syllabus or between syllabus and Canvas data
- Duplicate due dates or scheduling conflicts

Format: plain markdown bullet list. No preamble, no heading, no code fences. Start directly with the first bullet.

## Parsed syllabus

<SYLLABUS_PARSED>

## Canvas assignments summary

<ASSIGNMENTS_SUMMARY>
