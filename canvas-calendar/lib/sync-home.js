import { join } from 'node:path';
import { homedir } from 'node:os';

export function syncHome() {
  return process.env.CANVAS_SYNC_HOME || join(homedir(), 'canvas-sync-data');
}

export function classesDir() {
  return join(syncHome(), 'classes');
}

export function calendarDir() {
  return join(syncHome(), 'calendar');
}
