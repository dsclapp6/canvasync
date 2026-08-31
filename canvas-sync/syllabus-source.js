// Shared syllabus-source eligibility policy.
//
// Keep this module dependency-free so both the bridge scheduler and scripts/
// reporting code can consume the exact same predicate without coupling their
// module graphs.

export const MIN_SYLLABUS_DOCUMENT_BYTES = 1024;

export function isUsableSyllabusSource(sourceName, size) {
  return sourceName === 'syllabus.html' || size > MIN_SYLLABUS_DOCUMENT_BYTES;
}
