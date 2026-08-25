// Deterministic Google Calendar writes. Nothing here calls Claude.
// The caller (sync.js) feeds it validated event objects produced by the planner.
import { google } from 'googleapis';
import { getAuthedClient } from './oauth.js';
import { loadConfig, saveConfig } from './state.js';

const DEFAULT_CAL_SUMMARY = 'Canvas Sync';

export async function calendar() {
  const auth = await getAuthedClient();
  return google.calendar({ version: 'v3', auth });
}

// Ensure a dedicated Canvas Sync calendar exists; create on first run.
// Keeps the user's primary calendar clean.
export async function ensureCalendar(timeZone = 'America/Chicago') {
  const cfg = await loadConfig();
  if (cfg.calendarId) return cfg.calendarId;

  const cal = await calendar();
  const list = await cal.calendarList.list();
  const existing = (list.data.items || []).find(c => c.summary === DEFAULT_CAL_SUMMARY);
  if (existing) {
    await saveConfig({ ...cfg, calendarId: existing.id, timeZone });
    return existing.id;
  }
  const created = await cal.calendars.insert({
    requestBody: { summary: DEFAULT_CAL_SUMMARY, timeZone },
  });
  await saveConfig({ ...cfg, calendarId: created.data.id, timeZone });
  return created.data.id;
}

function toGoogleEvent(ev, timeZone) {
  // ev schema (see planner output):
  //   canvasAssignmentId, kind, checkpointIndex?, courseCode, title, startISO,
  //   endISO, description, reminders (array of minutes), location
  const extendedProperties = {
    private: {
      canvasAssignmentId: String(ev.canvasAssignmentId),
      kind: ev.kind,
      courseCode: ev.courseCode ?? '',
      contentHash: ev.contentHash ?? '',
    },
  };
  if (ev.checkpointIndex != null) {
    extendedProperties.private.checkpointIndex = String(ev.checkpointIndex);
  }

  const overrides = (ev.reminders || []).slice(0, 5).map(minutes => ({
    method: 'popup',
    minutes,
  }));

  return {
    summary: ev.title,
    description: ev.description || '',
    location: ev.location || undefined,
    start: { dateTime: ev.startISO, timeZone: ev.timeZone || timeZone },
    end:   { dateTime: ev.endISO,   timeZone: ev.timeZone || timeZone },
    reminders: overrides.length
      ? { useDefault: false, overrides }
      : { useDefault: true },
    extendedProperties,
    source: ev.htmlUrl ? { title: 'Canvas assignment', url: ev.htmlUrl } : undefined,
  };
}

export async function insertEvent(calendarId, ev, timeZone) {
  const cal = await calendar();
  const resp = await cal.events.insert({
    calendarId,
    requestBody: toGoogleEvent(ev, timeZone),
  });
  return resp.data;
}

export async function patchEvent(calendarId, googleEventId, ev, timeZone) {
  const cal = await calendar();
  const resp = await cal.events.patch({
    calendarId,
    eventId: googleEventId,
    requestBody: toGoogleEvent(ev, timeZone),
  });
  return resp.data;
}

export async function deleteEvent(calendarId, googleEventId) {
  const cal = await calendar();
  try {
    await cal.events.delete({ calendarId, eventId: googleEventId });
  } catch (err) {
    if (err?.response?.status === 410 || err?.response?.status === 404) return; // already gone
    throw err;
  }
}
