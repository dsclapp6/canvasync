// courses.js — Manage Courses picker. Fetches active courses from Canvas via
// the background worker, groups by term, stores selected IDs in chrome.storage.

const $status        = document.getElementById('status-line');
const $termsContainer= document.getElementById('terms-container');
const $selectCurrent = document.getElementById('select-current');
const $selectAll     = document.getElementById('select-all');
const $clearAll      = document.getElementById('clear-all');
const $saveBtn       = document.getElementById('save-btn');
const $selectionCount= document.getElementById('selection-count');
const $errorBanner   = document.getElementById('error-banner');

let allCourses = [];
let selected = new Set();   // Set<number>
let dirty = false;

function fmtRange(startIso, endIso) {
  const fmt = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const s = fmt(startIso);
  const e = fmt(endIso);
  if (s && e) return `${s} → ${e}`;
  if (s) return `from ${s}`;
  if (e) return `until ${e}`;
  return '';
}

// Collapse Rice's many parallel term names ("Spring Semester 2026 Full Term",
// "Spring Semester 2026 First Year Writing", "Spring Semester 2026 Dialogues on
// Cmty" …) into one bucket per season+year. That way all of spring 2026 lives
// under a single "Spring 2026" header instead of 4–5 mini-sections.
function normalizedTermLabel(rawName) {
  if (!rawName || typeof rawName !== 'string') return 'No term';
  const m = rawName.match(/^(Spring|Fall|Summer|Winter)\s+(?:Semester\s+)?(\d{4})/i);
  if (m) {
    const season = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return `${season} ${m[2]}`;
  }
  return rawName;
}

function termKey(course) {
  return normalizedTermLabel(course.term?.name);
}

function groupByTerm(courses) {
  const groups = new Map();
  for (const c of courses) {
    const key = termKey(c);
    if (!groups.has(key)) {
      groups.set(key, {
        term: { id: key, name: key, start: null, end: null },
        courses: [],
      });
    }
    const g = groups.get(key);
    g.courses.push(c);
    // Widen the date range so the header reflects the full span of every
    // sub-term Rice lumps together.
    const s = c.term?.start_at ? new Date(c.term.start_at).getTime() : null;
    const e = c.term?.end_at   ? new Date(c.term.end_at).getTime()   : null;
    if (s != null && (g.term.start == null || s < new Date(g.term.start).getTime())) {
      g.term.start = c.term.start_at;
    }
    if (e != null && (g.term.end == null || e > new Date(g.term.end).getTime())) {
      g.term.end = c.term.end_at;
    }
  }
  // Sort terms by start_at desc (current-ish first). Null dates go last.
  return [...groups.values()].sort((a, b) => {
    const sa = a.term.start ? new Date(a.term.start).getTime() : 0;
    const sb = b.term.start ? new Date(b.term.start).getTime() : 0;
    return sb - sa;
  });
}

function detectCurrentTermKey(groups) {
  const now = Date.now();
  // Prefer the term whose [start, end] range contains today.
  for (const g of groups) {
    const s = g.term.start ? new Date(g.term.start).getTime() : null;
    const e = g.term.end   ? new Date(g.term.end).getTime()   : null;
    if (s != null && e != null && s <= now && now <= e) return g.term.id;
    if (s != null && e == null && s <= now) return g.term.id;
  }
  // Fallback: most recent term with a start date.
  const withStart = groups.filter(g => g.term.start);
  if (withStart.length) return withStart[0].term.id;
  return groups[0]?.term.id ?? null;
}

function renderGroups(groups) {
  $termsContainer.innerHTML = '';
  for (const g of groups) {
    const wrap = document.createElement('section');
    wrap.className = 'term-group';
    wrap.dataset.termId = g.term.id ?? 'no-term';

    const header = document.createElement('div');
    header.className = 'term-header';

    const h2 = document.createElement('h2');
    h2.textContent = g.term.name;
    header.appendChild(h2);

    const meta = document.createElement('span');
    meta.className = 'term-meta';
    meta.textContent = fmtRange(g.term.start, g.term.end);
    header.appendChild(meta);

    const toggle = document.createElement('button');
    toggle.className = 'term-toggle';
    toggle.textContent = 'Select all in term';
    toggle.addEventListener('click', () => toggleTerm(g));
    header.appendChild(toggle);

    wrap.appendChild(header);

    for (const course of g.courses) {
      wrap.appendChild(renderCourseRow(course));
    }
    $termsContainer.appendChild(wrap);
  }
  updateSelectionCount();
}

function renderCourseRow(course) {
  const row = document.createElement('label');
  row.className = 'course-row';
  row.dataset.courseId = course.id;
  if (selected.has(Number(course.id))) row.classList.add('selected');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = selected.has(Number(course.id));
  cb.addEventListener('change', () => {
    const id = Number(course.id);
    if (cb.checked) selected.add(id); else selected.delete(id);
    row.classList.toggle('selected', cb.checked);
    markDirty();
    updateSelectionCount();
  });

  const code = document.createElement('span');
  code.className = 'course-code';
  code.textContent = course.course_code ?? `#${course.id}`;

  const name = document.createElement('span');
  name.className = 'course-name';
  name.textContent = course.name ?? '';

  const id = document.createElement('span');
  id.className = 'course-id';
  id.textContent = `id ${course.id}`;

  row.appendChild(cb);
  row.appendChild(code);
  row.appendChild(name);
  row.appendChild(id);
  return row;
}

function toggleTerm(group) {
  const ids = group.courses.map(c => Number(c.id));
  const allOn = ids.every(id => selected.has(id));
  for (const id of ids) {
    if (allOn) selected.delete(id);
    else       selected.add(id);
  }
  syncCheckboxesFromSet();
  markDirty();
  updateSelectionCount();
}

function syncCheckboxesFromSet() {
  for (const row of $termsContainer.querySelectorAll('.course-row')) {
    const id = Number(row.dataset.courseId);
    const on = selected.has(id);
    row.classList.toggle('selected', on);
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = on;
  }
}

function updateSelectionCount() {
  $selectionCount.textContent = `${selected.size} selected`;
  $saveBtn.disabled = !dirty;
}

function markDirty() {
  dirty = true;
  $saveBtn.disabled = false;
}

function showError(msg) {
  $errorBanner.textContent = msg;
  $errorBanner.classList.remove('hidden');
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

async function load() {
  const resp = await sendMessage({ type: 'LIST_COURSES' });
  if (!resp || !resp.ok) {
    $status.textContent = 'Failed to load courses.';
    showError(resp?.error ?? 'Background worker did not respond. Is Canvas logged in?');
    return;
  }

  allCourses = resp.courses;
  const stored = Array.isArray(resp.selectedCourseIds) ? resp.selectedCourseIds : null;
  selected = new Set((stored ?? []).map(Number));

  if (allCourses.length === 0) {
    $status.textContent = 'No active courses found.';
    return;
  }

  const groups = groupByTerm(allCourses);
  renderGroups(groups);

  // Enable toolbar.
  for (const btn of [$selectCurrent, $selectAll, $clearAll]) btn.disabled = false;

  // If nothing saved yet, pre-seed with current term as a suggestion.
  let headline;
  if (stored === null) {
    const currentKey = detectCurrentTermKey(groups);
    const current = groups.find(g => g.term.id === currentKey);
    if (current) {
      for (const c of current.courses) selected.add(Number(c.id));
      syncCheckboxesFromSet();
      updateSelectionCount();
      markDirty();
      headline = `${allCourses.length} courses found. Pre-selected the current term (also the sync default until you save) — review and save.`;
    } else {
      headline = `${allCourses.length} courses found. No selection saved — syncing current term by default.`;
    }
  } else if (stored.length === 0) {
    headline = `${allCourses.length} courses found. Selection is empty — syncing nothing until you pick classes.`;
  } else {
    headline = `${allCourses.length} courses found. ${selected.size} currently selected — only these sync.`;
  }
  $status.textContent = headline;

  wireToolbar(groups);
}

function wireToolbar(groups) {
  $selectAll.addEventListener('click', () => {
    for (const c of allCourses) selected.add(Number(c.id));
    syncCheckboxesFromSet();
    markDirty();
    updateSelectionCount();
  });

  $clearAll.addEventListener('click', () => {
    selected.clear();
    syncCheckboxesFromSet();
    markDirty();
    updateSelectionCount();
  });

  $selectCurrent.addEventListener('click', () => {
    const currentKey = detectCurrentTermKey(groups);
    const current = groups.find(g => g.term.id === currentKey);
    if (!current) return;
    selected.clear();
    for (const c of current.courses) selected.add(Number(c.id));
    syncCheckboxesFromSet();
    markDirty();
    updateSelectionCount();
  });

  $saveBtn.addEventListener('click', async () => {
    $saveBtn.disabled = true;
    $saveBtn.textContent = 'Saving…';
    // Always save the literal selection — an empty selection means "sync
    // nothing", never "sync everything".
    const ids = [...selected];
    const resp = await sendMessage({ type: 'SAVE_SELECTED_COURSES', courseIds: ids });
    $saveBtn.textContent = 'Save selection';
    if (resp?.ok) {
      dirty = false;
      $selectionCount.textContent = `${selected.size} selected — saved`;
      $saveBtn.disabled = true;
    } else {
      showError(resp?.error ?? 'Save failed.');
      $saveBtn.disabled = false;
    }
  });
}

load();
