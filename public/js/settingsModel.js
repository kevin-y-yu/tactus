// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Pure settings helpers (AC-ARCH rule 2: no I/O, no clock reads, no DOM). v2 chunk 20 — moved from views/settings.js (chunk 14).
// Exports: NUMBER_FIELDS, SETTINGS_SECTIONS, DEFAULT_SECTION, sectionFromRoute, sectionKeys, timeZoneOptions, changedSettings, workHoursBody.

// Same as views/recurring.js WEEKDAY_SHORT; kept local so this module imports nothing.
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const NUMBER_FIELDS = [
  { key: 'defaultMinBlockMin', label: 'Minimum block length (min)', min: 15, max: 240, step: 15 },
  { key: 'breakMin', label: 'Break length (min)', min: 0, max: 60, step: 5 },
  { key: 'breakIntervalMin', label: 'Break after continuous work of (min)', min: 0, max: 480, step: 15, hint: '0 = no breaks; otherwise 30–480' },
  { key: 'meetingBufferMin', label: 'Buffer after meetings (min)', min: 0, max: 60, step: 5 },
  { key: 'horizonDays', label: 'Planning horizon (days)', min: 7, max: 90, step: 1 },
  { key: 'hardDeadlineMarginMin', label: 'Hard-deadline safety margin (min)', min: 0, max: 1440, step: 15 },
  { key: 'lunchMin', label: 'Lunch length (min)', min: 0, max: 120, step: 15, hint: '0 = no lunch' },
  { key: 'icsRefreshMinutes', label: 'Calendar refresh interval (min)', min: 5, max: 1440, step: 1 },
];

// Settings sections in nav order (V2-D11). keys = scalar settings keys this section's Save may PUT.
// workHours is not listed: the schedules section saves it through workHoursBody.
export const SETTINGS_SECTIONS = [
  { id: 'schedules', label: 'Work hours & schedules', keys: [] },
  { id: 'calendars', label: 'Calendars', keys: ['allDayEventsBlock', 'icsRefreshMinutes'] },
  { id: 'rules', label: 'Scheduling rules',
    keys: ['defaultMinBlockMin', 'breakMin', 'breakIntervalMin', 'meetingBufferMin', 'horizonDays', 'hardDeadlineMarginMin',
      'lunchMin', 'lunchStart', 'lunchEnd'] },
  { id: 'general', label: 'General', keys: ['timezone', 'weekStartsOn', 'clock24'] },
];
export const DEFAULT_SECTION = 'schedules';

// route.params.section (string or null) -> a valid section id; unknown or null -> 'schedules'.
export function sectionFromRoute(section) {
  return SETTINGS_SECTIONS.some((s) => s.id === section) ? section : DEFAULT_SECTION;
}

// Section id -> its keys array (a copy); unknown id -> [].
export function sectionKeys(id) {
  const s = SETTINGS_SECTIONS.find((x) => x.id === id);
  return s ? [...s.keys] : [];
}

export function timeZoneOptions() {
  try { return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []; } catch { return []; }
}

// Shallow diff of scalar values against current settings (workHours is never passed here).
export function changedSettings(current, values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) if (!current || current[k] !== v) out[k] = v;
  return out;
}

// rows: {"0".."6": [[start, end], ...]} raw strings (missing day = []). Trims; drops pairs with both blank;
// one blank -> error; sorts each day by start (string order; '24:00' sorts last). Body always has keys "0".."6".
export function workHoursBody(rows) {
  const body = {};
  for (let d = 0; d < 7; d++) {
    const pairs = [];
    for (const [s0, e0] of (rows[String(d)] || [])) {
      const s = String(s0 ?? '').trim(), e = String(e0 ?? '').trim();
      if (!s && !e) continue;
      if (!s || !e) return { error: `${DAY_SHORT[d]}: fill both times or remove the row.`, body: null };
      pairs.push([s, e]);
    }
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    body[String(d)] = pairs;
  }
  return { error: null, body };
}
