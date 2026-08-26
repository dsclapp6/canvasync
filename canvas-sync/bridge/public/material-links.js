// Resolve the model's human-readable related-material labels to sources the
// dashboard can actually open. The miner is deliberately allowed to write a
// friendly label ("Assess Growth Opportunities.pptx", "Session 6 … slides")
// rather than a disk path, so the UI must not guess a path from that label.
//
// This module is shared by the bridge and the browser. Keeping the resolver
// pure makes the fuzzy-but-bounded name rules testable without a DOM or a live
// data directory.

'use strict';

const FILE_EXT_RE = /\.(?:pdf|pptx?|docx?|xlsx?|txt|md)$/i;

/** A comparison key that preserves meaningful numbers (Session 1 != 10). */
export function materialKey(raw) {
  let value = String(raw ?? '');
  try { value = decodeURIComponent(value); } catch { /* malformed %-escape */ }
  return value
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/\+/g, ' ')
    .replace(/^\s*(?:page|file)\s*:\s*/i, '')
    .replace(FILE_EXT_RE, '')
    // Numbered decks often lose their ordering prefix in model output.
    .replace(/^\s*\d+\.{1,2}\s*/, '')
    // Canvas page titles carry the session date; references usually do not.
    .replace(/\s+-\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*$/, '')
    .replace(/\s+(?:slides?|slide\s+deck)\s*$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function basename(rel) {
  return String(rel ?? '').split(/[\\/]/).pop() || '';
}

function aliases(source) {
  return source?.type === 'page'
    ? [source.title]
    : [source?.displayName, source?.filename, source?.name, basename(source?.localPath)];
}

/**
 * Build a small, body-free source catalog safe to include in API responses.
 * Superseded and duplicate file rows are not view targets: opening one would
 * show an older copy while the Files tab correctly shows the current one.
 */
export function materialSources(files = [], pages = []) {
  const fileSources = (Array.isArray(files) ? files : [])
    .filter(f => f && !f.duplicateOf && f.supersededBy == null && f.localPath)
    .map(f => ({
      type: 'file',
      displayName: f.displayName ?? f.filename ?? f.name ?? basename(f.localPath),
      filename: f.filename ?? null,
      name: f.name ?? null,
      localPath: f.localPath,
      materialsPath: f.materialsPath ?? null,
      size: f.size ?? null,
      pageCount: f.pageCount ?? null,
      slideCount: f.slideCount ?? null,
      canvasUpdatedAt: f.canvasUpdatedAt ?? null,
      extractionStatus: f.extractionStatus ?? null,
      extractionError: f.extractionError ?? null,
    }));

  const pageSources = (Array.isArray(pages) ? pages : [])
    .filter(p => p?.title && (p.page_id != null || p.url))
    .map(p => ({
      type: 'page',
      pageId: String(p.page_id ?? p.url),
      title: String(p.title),
      canvasUrl: p.html_url ?? null,
    }));

  return [...fileSources, ...pageSources];
}

function scoreAlias(referenceTokens, referenceKey, alias) {
  const aliasKey = materialKey(alias);
  if (!aliasKey) return 0;
  if (aliasKey === referenceKey) return 100;

  const aliasTokens = aliasKey.split(' ').filter(Boolean);
  const aliasSet = new Set(aliasTokens);
  const overlap = referenceTokens.filter(t => aliasSet.has(t)).length;
  const containsReference = referenceTokens.length >= 2 && overlap === referenceTokens.length;
  const containsAlias = aliasTokens.length >= 2 && overlap === aliasTokens.length;
  let score = (2 * overlap / (referenceTokens.length + aliasTokens.length)) * 70;
  if (containsReference || containsAlias) {
    score = Math.max(score,
      80 + 20 * Math.min(referenceTokens.length, aliasTokens.length)
        / Math.max(referenceTokens.length, aliasTokens.length));
  }
  return score;
}

/** Resolve one friendly label, refusing weak or ambiguous matches. */
export function resolveMaterial(reference, sources = []) {
  const referenceKey = materialKey(reference);
  if (!referenceKey) return null;
  const referenceTokens = referenceKey.split(' ').filter(Boolean);

  const ranked = (Array.isArray(sources) ? sources : []).map(source => ({
    source,
    score: Math.max(0, ...aliases(source).filter(Boolean)
      .map(alias => scoreAlias(referenceTokens, referenceKey, alias))),
  })).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score
      || (a.source.type === b.source.type ? 0 : a.source.type === 'file' ? -1 : 1));

  // A close tie means the label does not identify one source. Refusing the
  // link is safer than confidently opening the wrong session or file.
  if (ranked[0]?.score >= 65
      && (!ranked[1] || ranked[0].score - ranked[1].score >= 3)) {
    return ranked[0].source;
  }

  // "Course Syllabus" is a common friendly label. It is safe only when one
  // active source is recognisably a syllabus; two versions stay ambiguous.
  if (referenceTokens.includes('syllabus')) {
    const syllabus = (Array.isArray(sources) ? sources : []).filter(source =>
      aliases(source).filter(Boolean).some(alias => materialKey(alias).split(' ').includes('syllabus')));
    if (syllabus.length === 1) return syllabus[0];
  }
  return null;
}

/** Attach an openable source without discarding the miner's original label. */
export function linkRelatedMaterials(item, sources = []) {
  if (!item || typeof item !== 'object') return item;
  const related = Array.isArray(item.related_materials) ? item.related_materials : [];
  return {
    ...item,
    related_materials: related.map(material => ({
      ...material,
      source: resolveMaterial(material?.file, sources),
    })),
  };
}
