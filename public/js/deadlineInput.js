// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Pure deadline date+time helpers (AC-ARCH rule 2: no I/O, no clock reads, no DOM). v2 chunk 23 — spec v2 §R5 (V2-D13).
import { localInputToIso, isoToLocalInput } from '../shared/time.js';

export const END_OF_DAY = '23:59';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const ms = Date.parse(s + 'T00:00:00Z');
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

// (date 'YYYY-MM-DD', time 'HH:MM' | '', tz) -> ISO string | null. Empty time -> END_OF_DAY.
export function deadlineToIso(dateStr, timeStr, tz) {
  if (!validDate(dateStr)) return null;
  const t = typeof timeStr === 'string' && timeStr !== '' ? timeStr : END_OF_DAY;
  if (!TIME_RE.test(t)) return null;
  return localInputToIso(`${dateStr}T${t}`, tz);
}

// ISO | null -> {date, time} in tz; missing/invalid -> {date: '', time: ''}.
export function deadlineFromIso(iso, tz) {
  const s = isoToLocalInput(iso, tz);
  return s ? { date: s.slice(0, 10), time: s.slice(11, 16) } : { date: '', time: '' };
}

// Value the time input should take after the date input changes.
export function timeAfterDateChange(dateStr, timeStr) {
  return dateStr && !timeStr ? END_OF_DAY : (timeStr || '');
}
