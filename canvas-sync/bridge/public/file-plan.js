// Pure presentation plan for the Files tab. Origin `group` values identify an
// exact Canvas item so provenance can retain two assignments or quizzes that
// link the same file. They are intentionally finer-grained than the sections
// the UI draws: users need one Quizzes section, not one repeated heading per
// quiz. Modules are the exception because each module is course organisation
// worth preserving as its own section.

'use strict';

export function fileName(file) {
  return file?.displayName || file?.filename || 'Untitled';
}

/**
 * Pick the layout-preserving PDF the browser can show inline.
 *
 * PDFs use their original download. Office files use the PDF derivative that
 * extract-course-files.js creates with LibreOffice, when one is available.
 * Text remains a separate optional mode; it must not be mistaken for the
 * source document's actual layout.
 */
export function filePreviewPlan(file) {
  const name = fileName(file);
  const ext = (/\.[a-z0-9]+$/i.exec(String(file?.localPath || name))?.[0] || '').toLowerCase();
  if (ext === '.pdf' && file?.localPath) {
    return { path: file.localPath, label: 'Original', source: 'original' };
  }
  if (!file?.pdfPath) return null;
  const label = ['.ppt', '.pptx'].includes(ext) ? 'Slides'
    : ['.xls', '.xlsx'].includes(ext) ? 'Sheets'
    : 'Pages';
  return { path: file.pdfPath, label, source: 'converted' };
}

export function primaryOrigin(file) {
  return (file?.origins && file.origins[0])
    || { kind: 'files-tab', label: 'Files tab', group: 'files-tab' };
}

export function originHeading(origin) {
  return origin?.kind === 'module' ? `Module · ${origin.label}` : origin?.label || 'Files tab';
}

export function originDetail(file) {
  const origin = primaryOrigin(file);
  const extra = (file?.origins || []).length - 1;
  const bits = [];
  if (origin.itemLabel && origin.itemLabel !== origin.label) bits.push(origin.itemLabel);
  if (extra > 0) bits.push(`+${extra} more place${extra > 1 ? 's' : ''}`);
  return bits.join(' · ');
}

export function sourceSectionKey(origin) {
  if (origin?.kind === 'module') return origin.group || `module:${origin.label || ''}`;
  return origin?.kind || origin?.group || 'files-tab';
}

export function groupFilesBySource(files = []) {
  const groups = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    const origin = primaryOrigin(file);
    const key = sourceSectionKey(origin);
    if (!groups.has(key)) {
      groups.set(key, { heading: originHeading(origin), sort: origin.sort ?? 999, files: [] });
    }
    groups.get(key).files.push(file);
  }

  const out = [...groups.values()];
  out.sort((a, b) => a.sort - b.sort || a.heading.localeCompare(b.heading));
  for (const group of out) {
    group.files.sort((a, b) =>
      (primaryOrigin(a).itemSort ?? 1e9) - (primaryOrigin(b).itemSort ?? 1e9)
      || fileName(a).localeCompare(fileName(b)));
  }
  return out;
}
