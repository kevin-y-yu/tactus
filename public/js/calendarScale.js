// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Calendar scale helpers (pure: no DOM, no clock, no I/O). v2 §R2 V2-D8 / §R6 V2-D19, chunk 21.
import { parseHHMM } from '../shared/time.js';

export const PPH_LIMITS = { work: [32, 160], '24h': [20, 160] };

// hours objects (v1 workHours shape) -> merged, sorted [[startMin, endMin]] for one weekday (0 = Sunday).
export function bandRanges(hoursList, weekday) {
  const rs = [];
  for (const hours of hoursList || []) {
    for (const [s, e] of (hours && hours[String(weekday)]) || []) {
      const a = parseHHMM(s), b = parseHHMM(e);
      if (a < b) rs.push([a, b]);          // NaN fails the test -> skipped
    }
  }
  rs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of rs) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

export const RANGE_BUFFER_MIN = 30;

export function visibleRange({ weekdays, hoursList, itemMinutes }) {
  let lo = Infinity, hi = -Infinity;
  for (const wd of weekdays) for (const [s, e] of bandRanges(hoursList, wd)) { lo = Math.min(lo, s); hi = Math.max(hi, e); }
  for (const it of itemMinutes || []) { lo = Math.min(lo, it.startMin); hi = Math.max(hi, it.endMin); }
  if (lo === Infinity) { lo = 480; hi = 1080; }
  let startMin = Math.max(0, lo - RANGE_BUFFER_MIN);   // 30 min of context either side, not an exact fit
  let endMin = Math.min(1440, hi + RANGE_BUFFER_MIN);
  if (endMin - startMin < 240) { endMin = Math.min(1440, startMin + 240); startMin = Math.max(0, endMin - 240); }
  return { startMin, endMin };
}

export function fitPxPerHour({ mode, startMin, endMin, availablePx }) {
  const [min, max] = mode === '24h' ? PPH_LIMITS['24h'] : PPH_LIMITS.work;
  const hours = mode === '24h' ? 24 : (endMin - startMin) / 60;
  return Math.min(max, Math.max(min, Math.floor(availablePx / hours)));
}

export function initialScrollPx({ mode, startMin, pxPerHour }) {
  return mode === '24h' ? 0 : (startMin / 60) * pxPerHour;
}

export function gridHeightPx(pxPerHour) { return 24 * pxPerHour; }

// 'all' or unknown id -> every schedule's hours; known id -> that one; no schedules -> [fallbackHours] or [].
export function hoursListFor(schedules, filter, fallbackHours) {
  if (!schedules || !schedules.length) return fallbackHours ? [fallbackHours] : [];
  const one = filter === 'all' ? null : schedules.find((s) => String(s.id) === String(filter));
  return one ? [one.hours] : schedules.map((s) => s.hours);
}

// minutes -> CSS length in units of --pph.
export function cssHours(min) { return `calc(var(--pph) * ${Number((min / 60).toFixed(4))})`; }

// '#rrggbb' -> 'rgba(r, g, b, alpha)'; anything else -> null.
export function alphaColor(hex, alpha) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return null;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
