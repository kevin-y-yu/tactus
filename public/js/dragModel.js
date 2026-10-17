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
