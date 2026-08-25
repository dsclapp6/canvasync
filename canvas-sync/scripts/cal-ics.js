// The worklist as a calendar anyone can subscribe to.
//
// This replaces the Claude routine. The routine's whole job was mechanical —
// read worklist.md, list existing events, match each op by its `[csync:...]`
// marker, create/update/skip — and it needed an Anthropic subscription, a
// calendar MCP server and a scheduled prompt to do it. None of that can be
// handed to someone else.
//
// iCalendar does the same job with no account at all, because the identity
// scheme was already right for it: every op carries a stable marker that
// survives corrections (see sessionKey() in sync-calendar.js), and a marker
// maps exactly onto a VEVENT UID. Regenerating the whole file every sync is
// therefore safe — a moved lecture MOVES, it does not appear twice — which is
// the property the routine needed three paragraphs of instructions to preserve.
//
// RFC 5545, and specifically the parts everyone gets wrong:
//   - lines are folded at 75 OCTETS, not characters, and the continuation
//     begins with a single space
//   - TEXT values escape backslash, semicolon, comma and newline, in that order
//   - an all-day event is DTSTART;VALUE=DATE and its DTEND is EXCLUSIVE
//   - UNTIL in an RRULE must be the same value type as DTSTART
//
// Times are FLOATING (no Z, no TZID). "Class at 11:30" means 11:30 where the
// student is; anchoring it to a zone would move every lecture by an hour the
// first time the university's DST rules and the file's disagreed.
//
// Node builtins only — actually none at all. Pure, so the tests run it directly.

export const PRODID = '-//canvas-sync//CANVASync//EN';

/** RFC 5545 TEXT escaping. Backslash first, or it escapes its own escapes. */
export function escText(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold one content line to 75 octets.
 *
 * Octets, not characters: a description holding an en dash is 3 bytes for one
 * character, and folding on character count produces lines that are legal to
 * look at and rejected by strict parsers. Multi-byte sequences are never split
 * across a fold.
 */
export function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of String(line)) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = ch;
      bytes = n + 1;   // the leading space on a continuation line counts
      limit = 75;
    } else {
      cur += ch;
      bytes += n;
    }
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join('\r\n');
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** '2026-08-24' -> '20260824'. Returns null for anything else. */
export function icsDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso ?? '') ? iso.replace(/-/g, '') : null;
}

/** '2026-08-24' + '11:30' -> '20260824T113000' (floating local time). */
export function icsDateTime(iso, hhmm) {
  const d = icsDate(iso);
  if (!d || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm ?? '')) return null;
  return `${d}T${hhmm.replace(':', '')}00`;
}

/** The day after `iso`, because an all-day DTEND is exclusive. */
export function nextDay(iso) {
  if (!icsDate(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Add minutes to a wall-clock time, clamping at the end of the day. */
function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/**
 * One op as a VEVENT, or null when the op cannot be placed honestly.
 *
 * The refusals matter as much as the output. An op with no date is not an
 * event; an op whose marker is missing has no stable identity and would
 * duplicate itself on every regeneration. Neither is worth guessing at.
 */
export function opToVevent(op, { dtstamp }) {
  if (!op || !op.marker) return null;
  const date = op.date;
  if (!icsDate(date)) return null;

  const lines = ['BEGIN:VEVENT'];
  // The marker IS the identity. It already survives every correction the
  // pipeline can make to an item, which is exactly what a UID has to do.
  lines.push(`UID:${escText(op.marker)}`);
  lines.push(`DTSTAMP:${dtstamp}`);

  const timed = op.all_day === false && op.time;
  if (timed) {
    const start = icsDateTime(date, op.time);
    // A due time is a moment, not a span. The routine made these 15 minutes
    // long ending AT the deadline, so the block on the calendar is the time you
    // have left, not an hour after it has passed.
    const endTime = op.end_time || addMinutes(op.time, 15);
    let end = icsDateTime(date, endTime);
    if (!start) return null;
    if (!end || end <= start) end = icsDateTime(date, addMinutes(op.time, 15)) || start;
    lines.push(`DTSTART:${start}`);
    lines.push(`DTEND:${end}`);
  } else {
    // All-day. Emitted for every op the pipeline could date but not time —
    // "the day is known and the hour is not" is a fact the student needs, and
    // an invented 09:00 would hide it.
    lines.push(`DTSTART;VALUE=DATE:${icsDate(date)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDate(nextDay(date))}`);
  }

  const r = op.recurrence;
  if (r && r.freq === 'WEEKLY' && Array.isArray(r.byday) && r.byday.length) {
    const parts = [`FREQ=WEEKLY`, `BYDAY=${r.byday.join(',')}`];
    // UNTIL must match DTSTART's value type. With a DATE start it is a bare
    // date; with a DATE-TIME start it needs a time, and the end of the last day
    // is the only reading that does not drop the final week.
    if (icsDate(r.until)) {
      parts.push(`UNTIL=${timed ? `${icsDate(r.until)}T235959` : icsDate(r.until)}`);
    }
    lines.push(`RRULE:${parts.join(';')}`);
  }

  lines.push(`SUMMARY:${escText(op.title || 'Untitled')}`);
  if (op.location) lines.push(`LOCATION:${escText(op.location)}`);
  if (op.description) lines.push(`DESCRIPTION:${escText(op.description)}`);
  // Categories let a calendar app colour by kind without parsing the marker.
  if (op.kind) lines.push(`CATEGORIES:${escText(op.kind)}`);
  if (op.url) lines.push(`URL:${escText(op.url)}`);
  // A deadline is a point in the student's day, not a claim about where they
  // are. Marking it TRANSPARENT keeps it out of free/busy.
  lines.push(`TRANSP:${op.kind === 'meeting' || op.kind === 'office_hours' ? 'OPAQUE' : 'TRANSPARENT'}`);
  lines.push('END:VEVENT');
  return lines;
}

/**
 * A whole calendar.
 *
 * `name` shows in the subscriber's sidebar. X-WR-CALNAME is not in the RFC but
 * every calendar client made in the last twenty years reads it, and without it
 * a subscription is called by its URL.
 */
export function buildIcs(ops, { name = 'CANVASync', dtstamp, refreshMinutes = 60 } = {}) {
  const stamp = dtstamp || '19700101T000000Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escText(name)}`,
    `X-WR-TIMEZONE:`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refreshMinutes}M`,
    `X-PUBLISHED-TTL:PT${refreshMinutes}M`,
  ].filter(l => l !== 'X-WR-TIMEZONE:');

  const skipped = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    const ev = opToVevent(op, { dtstamp: stamp });
    if (!ev) { skipped.push(op?.marker ?? op?.title ?? 'unknown'); continue; }
    lines.push(...ev);
  }
  lines.push('END:VCALENDAR');
  return { text: `${lines.map(fold).join('\r\n')}\r\n`, count: lines.filter(l => l === 'BEGIN:VEVENT').length, skipped };
}

/** The UTC timestamp every VEVENT in one file shares. */
export function icsStamp(date = new Date()) {
  const d = date;
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// Which file each op goes in. One calendar per target so a subscriber can give
// deadlines and lectures different colours — the thing three separate Google
// calendars bought the old routine, without three OAuth grants.
export const ICS_FILES = [
  { file: 'deadlines.ics', name: 'CANVASync — Deadlines', calendars: ['due'] },
  { file: 'checkpoints.ics', name: 'CANVASync — Prep', calendars: ['checkpoint'] },
  { file: 'classes.ics', name: 'CANVASync — Classes', calendars: ['meeting'] },
  { file: 'canvasync.ics', name: 'CANVASync', calendars: null },   // null = everything
];

export function icsFilesFor(worklist, { dtstamp } = {}) {
  const ops = Array.isArray(worklist?.ops) ? worklist.ops : [];
  const stamp = dtstamp || icsStamp();
  return ICS_FILES.map(({ file, name, calendars }) => {
    const subset = calendars ? ops.filter(o => calendars.includes(o.calendar)) : ops;
    const { text, count, skipped } = buildIcs(subset, { name, dtstamp: stamp });
    return { file, name, text, count, skipped };
  });
}
