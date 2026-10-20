// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// PURE drag/resize snapping (spec §5.7, §10.3). No I/O, no clock reads, no randomness, no DOM:
// instants are epoch ms (A2) and `now` is a parameter.
import { MIN, ceilGrid, addDays, zonedToUtc, utcToZoned } from '../shared/time.js';

const STEP = 15 * MIN;

export function dragResult({ mode, origStart, origEnd, deltaYpx, dayDelta = 0, pxPerHour, tz, now }) {
  if (mode !== 'move' && mode !== 'resize') throw new TypeError('dragResult: mode must be move or resize');
  const steps = Math.round(deltaYpx / (pxPerHour / 4));
  const z = utcToZoned(origStart, tz);
  let start, end;
  if (mode === 'move') {
    const date = addDays(z.date, dayDelta);
    const dayStart = zonedToUtc(date, 0, tz);
    const dayEnd = zonedToUtc(addDays(date, 1), 0, tz);
    const len = origEnd - origStart;
    start = zonedToUtc(date, z.minutes, tz) + steps * STEP;
    start = Math.max(dayStart, Math.min(start, dayEnd - len));
    start = ceilGrid(start);
    end = ceilGrid(start + len);
  } else {
    const dayEnd = zonedToUtc(addDays(z.date, 1), 0, tz);
    start = origStart;
    end = Math.min(Math.max(origEnd + steps * STEP, start + STEP), dayEnd);
    end = ceilGrid(end);
  }
  if (start < ceilGrid(now)) return { error: 'past' };
  return { start, end };
}

// Drag-to-create on an empty column of local day `date`: y0px/y1px are pointer offsets from the column top. Snaps the
// covered span outward to 15 minutes (min 15), clamped to the day. -> {start, end} ms | {error: 'past'}
export function createResult({ date, y0px, y1px, pxPerHour, tz, now }) {
  const stepPx = pxPerHour / 4;
  const lo = Math.min(y0px, y1px), hi = Math.max(y0px, y1px);
  const m0 = Math.max(0, Math.min(Math.floor(lo / stepPx) * 15, 1425));
  const m1 = Math.max(m0 + 15, Math.min(Math.ceil(hi / stepPx) * 15, 1440));
  const start = zonedToUtc(date, m0, tz);
  const end = m1 === 1440 ? zonedToUtc(addDays(date, 1), 0, tz) : zonedToUtc(date, m1, tz);
  if (start < ceilGrid(now)) return { error: 'past' };
  return { start, end };
}
