// class-colors.js — the colour each class is drawn in.
//
// Two rules, both from the user: the defaults are generic (no attempt to guess
// that BUSI 380 is "marketing blue"), and any of them can be overridden. So the
// default is a fixed palette walked in a stable order, and an override is a
// plain hex string stored per class slug.
//
// Assignment is by position in the sorted slug list, not by hashing the slug.
// Hashing looks cleverer and collides: on the real five classes it gave BUSI
// 305 and BUSI 374 the same green. Position cannot collide until the palette
// runs out, and then it wraps predictably.
//
// Node builtins only — imported by bridge/ and served to the dashboard.

/**
 * Ten hues chosen to stay legible on a light cream ground: mid-saturation,
 * dark enough for text on cream, distinct from each other at chip size.
 * Ordered so the first few classes get maximally separated hues.
 */
export const DEFAULT_PALETTE = [
  '#3E6B8A', // slate blue
  '#7A5C3E', // umber
  '#4E7A5B', // moss
  '#8A4F5C', // dusty rose
  '#5C5A8A', // muted indigo
  '#8A7136', // ochre
  '#3F7373', // teal
  '#7A4A78', // plum
  '#6B7A3E', // olive
  '#8A5A3E', // clay
];

export const COLORS_FILE = 'class_colors.json';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value) {
  return typeof value === 'string' && HEX_RE.test(value.trim());
}

export function normaliseHex(value) {
  return isHexColor(value) ? value.trim().toLowerCase() : null;
}

/**
 * The colour for every slug: the stored override where there is one, the
 * palette entry for its position otherwise.
 *
 * `slugs` is sorted here rather than by the caller so the same class keeps the
 * same colour no matter what order the sidebar, the calendar and the class page
 * happen to ask in.
 */
export function resolveColors(slugs, overrides = {}) {
  const sorted = [...new Set((slugs || []).filter(Boolean).map(String))].sort();
  const out = {};
  sorted.forEach((slug, i) => {
    const override = normaliseHex(overrides?.[slug]);
    out[slug] = override ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
  });
  return out;
}

/**
 * Merge a patch into the stored overrides. A null, empty or invalid value
 * deletes that entry, which is how "revert to the generic colour" is spelled —
 * there is no separate reset call to forget to wire up.
 *
 * Returns { overrides, rejected } so a bad hex is reported rather than silently
 * dropped.
 */
export function applyColorPatch(stored, patch) {
  const overrides = { ...(stored && typeof stored === 'object' ? stored : {}) };
  const rejected = [];
  for (const [slug, value] of Object.entries(patch ?? {})) {
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) { rejected.push({ slug, reason: 'invalid slug' }); continue; }
    if (value === null || value === '' || value === undefined) { delete overrides[slug]; continue; }
    const hex = normaliseHex(value);
    if (!hex) { rejected.push({ slug, reason: 'expected #rrggbb' }); continue; }
    overrides[slug] = hex;
  }
  return { overrides, rejected };
}
