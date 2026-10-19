// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// PURE lunch placement: one lunch of settings.lunchMin minutes per day, inside [lunchStart, lunchEnd] and the default
// schedule's hours, in the earliest free slot (events and fixed work cut it). No I/O, no clock reads.
const { MIN, ceilGrid, parseHHMM, addDays, zonedToUtc, utcToZoned } = require('../public/shared/time.js');
const { workWindows, resolveSchedule, subtract, alignInward, applyBuffers } = require('./scheduler.js');

// prev: lunches [{start, end}] (epoch ms) from earlier runs. Those that have started stay as they are (a lunch in
// progress must not slide away), and their day gets no new lunch. Returns every lunch to keep, sorted by start.
// overrides: { 'YYYY-MM-DD': 'HH:MM' } user-moved lunch starts; a future override places that day's lunch exactly there (ignores busy time, hours and window).
function placeLunches(settings, busy, now, prev = [], overrides = {}) {
  const kept = prev.filter((l) => l.start < now).map((l) => ({ start: l.start, end: l.end }));
  if (!settings.lunchMin) return kept;
  const tz = settings.timezone, dur = settings.lunchMin * MIN, t0 = ceilGrid(now);
  const today = utcToZoned(now, tz).date;
  const { hours } = resolveSchedule(settings, null);
  const work = workWindows(settings, now, hours);
  const occupied = applyBuffers(busy, settings);
  const lunchDays = new Set(kept.map((l) => utcToZoned(l.start, tz).date));
  const out = [...kept];
  for (let i = 0; i < settings.horizonDays; i++) {
    const d = addDays(today, i);
    if (lunchDays.has(d)) continue;
    const ov = overrides[d];
    if (ov != null) {
      const s = zonedToUtc(d, parseHHMM(ov), tz);
      if (Number.isFinite(s) && s >= t0 && utcToZoned(s + dur - 1, tz).date === d) { out.push({ start: s, end: s + dur }); continue; }
    }
    const winStart = zonedToUtc(d, parseHHMM(settings.lunchStart), tz), winEnd = zonedToUtc(d, parseHHMM(settings.lunchEnd), tz);
    const clipped = work.map((w) => ({ start: Math.max(w.start, winStart, t0), end: Math.min(w.end, winEnd) })).filter((w) => w.end > w.start);
    const seg = alignInward(subtract(clipped, occupied)).find((s) => s.end - s.start >= dur);
    if (seg) out.push({ start: seg.start, end: seg.start + dur });
  }
  return out.sort((a, b) => a.start - b.start);
}

module.exports = { placeLunches };
