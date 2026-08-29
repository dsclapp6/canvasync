import { escapeContent } from './content-format.js';

// Only live Canvas-backed work has an assignment page. A syllabus-only item
// can still carry a stale URL left by an older mining pass, so provenance is
// part of the decision rather than trusting the presence of html_url alone.
export function directTaskUrl(item) {
  if (item?.origin !== 'canvas' || typeof item?.html_url !== 'string') return null;
  const raw = item.html_url.trim();
  if (!raw) return null;
  try {
    const protocol = new URL(raw).protocol;
    return protocol === 'http:' || protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/** The clickable title used by the class to-do list. */
export function taskTitleHtml(item) {
  const title = escapeContent(item?.title || 'Untitled');
  const url = directTaskUrl(item);
  if (url) {
    return `<a class="task-title linky-title" href="${escapeContent(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`;
  }

  // Work recovered only from a syllabus has no Canvas destination. Preserve
  // its local detail page so its description, materials, and notes stay
  // accessible rather than manufacturing a dead Canvas link.
  const assignmentId = item?.canvas_assignment_id ?? item?.id;
  if (assignmentId == null || String(assignmentId) === '') {
    return `<span class="task-title">${title}</span>`;
  }
  return `<button type="button" class="task-title linky-title" data-open-assignment="${escapeContent(assignmentId)}">${title}</button>`;
}
