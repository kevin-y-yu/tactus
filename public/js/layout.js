// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// PURE layout helpers (spec §5.7). No I/O, no clock, no randomness, no DOM.
import { addDays, weekdayOf } from '../shared/time.js';

// items: [{id, start, end}] with start/end epoch ms (A2). Returns [{id, lane, lanes}] in input order.
// Overlap = a.start < b.end && b.start < a.end (touching intervals do not overlap).
export function layoutLanes(items) {
  const order = items
    .map((it, i) => ({ it, i, start: it.start, end: Math.max(it.end, it.start), lane: 0 }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.i - b.i);
  const result = new Array(items.length);
  let cluster = [];
  let laneEnds = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const c of cluster) result[c.i] = { id: c.it.id, lane: c.lane, lanes: laneEnds.length };
    cluster = []; laneEnds = []; clusterEnd = -Infinity;
  };
  for (const c of order) {
    if (cluster.length && c.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((e) => e <= c.start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(c.end); } else laneEnds[lane] = c.end;
    c.lane = lane;
    cluster.push(c);
    clusterEnd = Math.max(clusterEnd, c.end);
  }
  flush();
  return result;
}

// 7 consecutive 'YYYY-MM-DD' dates of the week containing `date`; weekStartsOn 0 (Sun) or 1 (Mon).
export function weekDates(date, weekStartsOn) {
  const first = addDays(date, -((weekdayOf(date) - weekStartsOn + 7) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}
