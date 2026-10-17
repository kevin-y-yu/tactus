// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// PURE timezone/date helpers (spec §5.1). Shared by the browser (ESM) and the
// server (require of ESM, C-7). No I/O, no clock reads, no randomness: callers
// pass instants as epoch milliseconds.

export const MIN = 60000, GRID = 900000;

export function ceilGrid(ms) {
  return Math.ceil(ms / GRID) * GRID;
}

export function floorGrid(ms) {
  return Math.floor(ms / GRID) * GRID;
}

const pad2 = (n) => String(n).padStart(2, '0');

const HHMM_RE = /^(\d{2}):(\d{2})$/;

// '09:30' -> 570, '24:00' -> 1440; anything else -> NaN.
export function parseHHMM(s) {
  const m = typeof s === 'string' ? HHMM_RE.exec(s) : null;
  if (!m) return NaN;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return NaN;
  return h * 60 + mi;
}

// 570 -> '09:30', 1440 -> '24:00'.
export function formatHHMM(min) {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

function splitDate(dateStr) {
  return dateStr.split('-').map(Number);
}

export function addDays(dateStr, n) {
  const [y, m, d] = splitDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// 0 = Sunday .. 6 = Saturday.
export function weekdayOf(dateStr) {
  const [y, m, d] = splitDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysInMonth(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map();

function formatter(tz) {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

// Wall-clock parts of instant ms in tz, as numbers.
function parts(ms, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(ms)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  if (p.hour === 24) p.hour = 0;
  return p;
}

// Spec §5.1 conversion algorithm (exact; DST tests depend on it).
export function tzOffsetMs(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// Nonexistent local times shift forward by the gap; ambiguous ones resolve to
// the later (standard-time) instant. minutesOfDay 0..1440.
export function zonedToUtc(dateStr, minutesOfDay, tz) {
  const [y, m, d] = splitDate(dateStr);
  const guess = Date.UTC(y, m - 1, d, 0, minutesOfDay);
  const o1 = tzOffsetMs(guess, tz);
  let t = guess - o1;
  const o2 = tzOffsetMs(t, tz);
  if (o2 !== o1) t = guess - o2;
  return t;
}

export function utcToZoned(ms, tz) {
  const p = parts(ms, tz);
  const date = `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;
  return {
    date,
    minutes: p.hour * 60 + p.minute,
    weekday: weekdayOf(date),
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
  };
}

export function startOfLocalDay(ms, tz) {
  return zonedToUtc(utcToZoned(ms, tz).date, 0, tz);
}

const LOCAL_INPUT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/;

// <input type="datetime-local"> value in tz -> ISO UTC string; '' or invalid -> null.
export function localInputToIso(value, tz) {
  const m = typeof value === 'string' ? LOCAL_INPUT_RE.exec(value) : null;
  if (!m) return null;
  return new Date(zonedToUtc(m[1], Number(m[2]) * 60 + Number(m[3]), tz)).toISOString();
}

// ISO string -> 'YYYY-MM-DDTHH:MM' in tz; missing or invalid -> ''.
export function isoToLocalInput(iso, tz) {
  const ms = typeof iso === 'string' && iso !== '' ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) return '';
  const z = utcToZoned(ms, tz);
  return `${z.date}T${formatHHMM(z.minutes)}`;
}
