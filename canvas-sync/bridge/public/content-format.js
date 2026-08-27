// Safe, dependency-free content formatting for the assignment and file readers.
// Canvas HTML is sanitised in app.js because that needs DOMParser; text files
// come through here so extracts read like documents instead of terminal logs.

export function escapeContent(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tokenStore() {
  const values = [];
  return {
    put(html) {
      const index = values.push(html) - 1;
      return `\u0000CONTENT${index}\u0000`;
    },
    restore(text) {
      return text.replace(/\u0000CONTENT(\d+)\u0000/g, (_, index) => values[Number(index)] ?? '');
    },
  };
}

function safeInline(source, { autoLinks = true } = {}) {
  const tokens = tokenStore();
  let text = String(source ?? '');

  // Pull code and explicitly written links out before emphasis is applied.
  // Only web and mail links are accepted; javascript: remains inert text.
  text = text.replace(/`([^`\n]+)`/g, (_, code) =>
    tokens.put(`<code>${escapeContent(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/gi,
    (_, label, href) => tokens.put(
      `<a href="${escapeContent(href)}" target="_blank" rel="noopener noreferrer">${escapeContent(label)}</a>`));

  text = escapeContent(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>');

  if (autoLinks) {
    // Extracted slides frequently contain a bare source URL. Make it useful,
    // but leave sentence punctuation outside the link.
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/gi, (_, lead, rawHref) => {
      const punctuation = /[.,;:!?]+$/.exec(rawHref)?.[0] || '';
      const href = punctuation ? rawHref.slice(0, -punctuation.length) : rawHref;
      return `${lead}<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${punctuation}`;
    });
  }
  return tokens.restore(text);
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let listTag = null;
  let inTable = false;
  let inCode = false;
  let codeLines = [];
  let paragraph = [];

  const closeList = () => {
    if (listTag) out.push(`</${listTag}>`);
    listTag = null;
  };
  const closeTable = () => {
    if (inTable) out.push('</tbody></table>');
    inTable = false;
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${safeInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeBlocks = () => { flushParagraph(); closeList(); closeTable(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (/^\s*```/.test(line)) {
      closeBlocks();
      if (inCode) {
        out.push(`<pre><code>${escapeContent(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    if (!line.trim()) { closeBlocks(); continue; }

    const heading = /^\s*(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      closeBlocks();
      const level = heading[1].length;
      out.push(`<h${level}>${safeInline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      closeBlocks(); out.push('<hr>'); continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeBlocks(); out.push(`<blockquote><p>${safeInline(quote[1])}</p></blockquote>`); continue;
    }

    const tableLine = line.trim();
    if (tableLine.startsWith('|') && tableLine.endsWith('|')) {
      flushParagraph(); closeList();
      if (/^\|[\s|:-]+\|$/.test(tableLine)) continue;
      if (!inTable) { out.push('<table><tbody>'); inTable = true; }
      const header = /^\|[\s|:-]+\|$/.test((lines[i + 1] || '').trim());
      const tag = header ? 'th' : 'td';
      const cells = tableLine.split('|').slice(1, -1);
      out.push(`<tr>${cells.map(cell => `<${tag}>${safeInline(cell.trim())}</${tag}>`).join('')}</tr>`);
      continue;
    }
    closeTable();

    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph(); closeTable();
      const wanted = ordered ? 'ol' : 'ul';
      if (listTag !== wanted) { closeList(); out.push(`<${wanted}>`); listTag = wanted; }
      out.push(`<li>${safeInline((ordered || unordered)[1])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }

  if (inCode) out.push(`<pre><code>${escapeContent(codeLines.join('\n'))}</code></pre>`);
  closeBlocks();
  return out.join('\n');
}

function headingLike(line, next = '') {
  const value = line.trim();
  if (!value || value.length > 78 || /[.!?;]$/.test(value) || /^https?:\/\//i.test(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length > 10) return false;
  if (/^(overview|instructions?|requirements?|objectives?|learning outcomes?|course schedule|grading|assessment|submission|deliverables?|resources?|references?|in sum|example)\b/i.test(value)) return true;
  if (/:$/.test(value)) return words.length <= 7;
  const meaningful = words.filter(word => !/^(a|an|and|as|at|by|for|from|in|of|on|or|the|to|via|with)$/i.test(word));
  const titled = meaningful.filter(word => /^[A-Z0-9]/.test(word)).length;
  return meaningful.length > 0 && titled / meaningful.length >= 0.75
    && (!next || next.length > value.length || /[.!?]$/.test(next));
}

function joinWrapped(lines) {
  return lines.reduce((text, raw) => {
    const line = raw.trim();
    if (!text) return line;
    // PDF extractors split words at the page's right edge. Rejoin a lowercase
    // continuation, but retain genuine hyphenated terms such as take-home.
    if (/[a-z]-$/.test(text) && /^[a-z]/.test(line)) return text.slice(0, -1) + line;
    return `${text} ${line}`;
  }, '');
}

function renderSlideExtract(lines) {
  const out = [];
  const useful = lines.map(line => line.trim()).filter(Boolean);
  if (!useful.length) return '';
  out.push(`<h1>${safeInline(useful.shift())}</h1>`);

  let fragments = [];
  const flushFragments = () => {
    if (!fragments.length) return;
    out.push(`<ul class="source-points">${fragments.map(item => `<li>${safeInline(item)}</li>`).join('')}</ul>`);
    fragments = [];
  };
  for (let i = 0; i < useful.length; i++) {
    const line = useful[i];
    const next = useful[i + 1] || '';
    if (headingLike(line, next)) {
      flushFragments(); out.push(`<h2>${safeInline(line.replace(/:\s*$/, ''))}</h2>`);
    } else if (/^https?:\/\/\S+$/i.test(line)) {
      flushFragments(); out.push(`<p class="source-reference">Source: ${safeInline(line)}</p>`);
    } else if (/[.!?]$/.test(line) || line.length > 90) {
      flushFragments(); out.push(`<p>${safeInline(line)}</p>`);
    } else {
      fragments.push(line);
    }
  }
  flushFragments();
  return out.join('\n');
}

function renderProseExtract(lines) {
  const out = [];
  const blocks = [];
  let block = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (block.length) blocks.push(block);
      block = [];
    } else block.push(line);
  }
  if (block.length) blocks.push(block);

  let first = true;
  for (const current of blocks) {
    // The first extracted line is normally the document title. Emit it now
    // instead of waiting for a blank line; DOCX extraction often preserves
    // paragraph breaks as single newlines and would otherwise turn an entire
    // syllabus into one enormous heading.
    if (first && current.length) {
      out.push(`<h1>${safeInline(current.shift())}</h1>`);
      first = false;
    }
    let paragraph = [];
    let listTag = null;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const text = joinWrapped(paragraph);
      out.push(`<p>${safeInline(text)}</p>`);
      paragraph = [];
    };
    const closeList = () => {
      if (listTag) out.push(`</${listTag}>`);
      listTag = null;
    };

    for (let i = 0; i < current.length; i++) {
      const line = current[i];
      const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(line);
      if (item) {
        flushParagraph();
        const wanted = item[2] ? 'ol' : 'ul';
        if (listTag !== wanted) { closeList(); out.push(`<${wanted}>`); listTag = wanted; }
        out.push(`<li>${safeInline(item[3])}</li>`);
      } else if (!first && headingLike(line, current[i + 1] || '')) {
        flushParagraph(); closeList(); out.push(`<h2>${safeInline(line.replace(/:\s*$/, ''))}</h2>`);
      } else {
        closeList(); paragraph.push(line);
      }
    }
    flushParagraph(); closeList();
  }
  return out.join('\n');
}

function renderCsv(text) {
  const rows = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').filter(Boolean).slice(0, 250)
    .map(line => line.split(',').map(cell => cell.trim()));
  if (!rows.length) return '';
  return `<table><tbody>${rows.map((row, rowIndex) => `<tr>${row.map(cell =>
    `<${rowIndex === 0 ? 'th' : 'td'}>${safeInline(cell)}</${rowIndex === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function renderReadableText(source, extension = '.txt') {
  const text = String(source ?? '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim();
  const ext = String(extension || '.txt').toLowerCase();
  if (!text) return '';
  if (ext === '.md' || ext === '.markdown') return renderMarkdown(text);
  if (ext === '.json') {
    let formatted = text;
    try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show the source honestly */ }
    return `<pre><code>${escapeContent(formatted)}</code></pre>`;
  }
  if (ext === '.log') return `<pre><code>${escapeContent(text)}</code></pre>`;
  if (ext === '.csv') return renderCsv(text);

  const lines = text.split('\n');
  if (ext === '.pptx') return renderSlideExtract(lines);
  return renderProseExtract(lines);
}
