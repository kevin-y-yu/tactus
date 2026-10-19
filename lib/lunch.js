// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// PURE lunch placement: one lunch of settings.lunchMin minutes per day, inside [lunchStart, lunchEnd] and the default
// schedule's hours, in the earliest free slot (events and fixed work cut it). No I/O, no clock reads.
const { MIN, ceilGrid, parseHHMM, addDays, zonedToUtc, utcToZoned } = require('../public/shared/time.js');
const { workWindows, resolveSchedule, subtract, alignInward, applyBuffers } = require('./scheduler.js');

// prev: lunches [{start, end}] (epoch ms) from earlier runs. Those that have started stay as they are (a lunch in
// progress must not slide away), and their day gets no new lunch, unless that day has a valid future override. In that
// case the lunch moves there, which lets a missed lunch today be moved to a later time. Returns every lunch to keep,
// sorted by start. Lunches on past days are never changed.
// overrides: { 'YYYY-MM-DD': 'HH:MM' } user-moved lunch starts; a future override places that day's lunch exactly there (ignores busy time, hours and window).
// A past or invalid override is ignored.
function placeLunches(settings, busy, now, prev = [], overrides = {}) {
  const kept = prev.filter((l) => l.start < now).map((l) => ({ start: l.start, end: l.end }));
  if (!settings.lunchMin) return kept;
  const tz = settings.timezone, dur = settings.lunchMin * MIN, t0 = ceilGrid(now);
  const today = utcToZoned(now, tz).date;
  // Valid future overrides for horizon days. One beats that day's started lunch (the user moved a missed lunch).
  const moved = new Map();
  for (let i = 0; i < settings.horizonDays; i++) {
    const d = addDays(today, i), ov = overrides[d];
    if (ov == null) continue;
    const s = zonedToUtc(d, parseHHMM(ov), tz);
    if (Number.isFinite(s) && s >= t0 && utcToZoned(s + dur - 1, tz).date === d) moved.set(d, { start: s, end: s + dur });
  }
  const dayOf = (l) => utcToZoned(l.start, tz).date;
  const { hours } = resolveSchedule(settings, null);
  const work = workWindows(settings, now, hours);
  const occupied = applyBuffers(busy, settings);
  const lunchDays = new Set(kept.map(dayOf));
  const out = kept.filter((l) => !moved.has(dayOf(l)));
  for (let i = 0; i < settings.horizonDays; i++) {
    const d = addDays(today, i);
    if (moved.has(d)) { out.push(moved.get(d)); continue; }
    if (lunchDays.has(d)) continue;
    const winStart = zonedToUtc(d, parseHHMM(settings.lunchStart), tz), winEnd = zonedToUtc(d, parseHHMM(settings.lunchEnd), tz);
    const clipped = work.map((w) => ({ start: Math.max(w.start, winStart, t0), end: Math.min(w.end, winEnd) })).filter((w) => w.end > w.start);
    const seg = alignInward(subtract(clipped, occupied)).find((s) => s.end - s.start >= dur);
    if (seg) out.push({ start: seg.start, end: seg.start + dur });
  }
  return out.sort((a, b) => a.start - b.start);
}

module.exports = { placeLunches };
