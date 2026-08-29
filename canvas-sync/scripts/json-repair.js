// A local model that runs out of tokens mid-sentence leaves JSON that is
// correct right up to the cut. Throwing it away costs the whole syllabus over
// one unfinished trailing field, so close what is open and keep the rest.
//
// Walks the text tracking string state and the bracket stack, remembering the
// last position where a value had just finished (a comma, or a closing bracket)
// along with the closers needed there. Truncating to that point and appending
// them yields valid JSON containing every complete field.
//
// Returns null when nothing complete was found — an empty salvage is worse than
// an honest failure.
export function salvageTruncatedJson(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let cut = -1;
  let closers = '';

  const mark = (i) => { cut = i; closers = stack.slice().reverse().join(''); };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { stack.push('}'); continue; }
    if (ch === '[') { stack.push(']'); continue; }
    if (ch === '}' || ch === ']') { stack.pop(); mark(i + 1); continue; }
    // Truncate *before* the comma: what precedes it is a finished value.
    if (ch === ',') mark(i);
  }

  if (cut <= 0 || !closers) return null;
  const candidate = text.slice(0, cut) + closers;
  try {
    const obj = JSON.parse(candidate);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

// extractJsonFromResponse closes on the *last* `}`, which on a truncated
// response is some inner object — useless for salvage. Take everything from the
// first `{` to the end of the text and let the walker find the cut.
export function salvageFromResponse(raw) {
  const text = String(raw || '');
  const fence = text.indexOf('```');
  const body = fence === -1 ? text : text.slice(text.indexOf('\n', fence) + 1);
  const start = body.indexOf('{');
  if (start === -1) return null;
  return salvageTruncatedJson(body.slice(start));
}

export function outputSchemaFromPrompt(promptTemplate) {
  const match = String(promptTemplate).match(/## Output schema[\s\S]*?```(?:json)?\s*([\s\S]*?)```/);
  if (!match) throw new Error('Output schema missing from prompt template');
  return match[1].trim();
}
