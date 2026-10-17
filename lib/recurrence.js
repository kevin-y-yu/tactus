// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// PURE recurrence (spec §9.9, §5.3). No I/O, no clock reads, no randomness: callers pass `now` (epoch ms).
// Instants are epoch-ms numbers (interface decision A2). Dates are 'YYYY-MM-DD' strings in the app timezone.
// V2-D18: placeOccurrences pass 2 uses the occurrence's schedule hours (resolveSchedule); pass 1 is unchanged.
const { MIN, GRID, ceilGrid, parseHHMM, addDays, weekdayOf, daysInMonth, zonedToUtc, utcToZoned } = require('../public/shared/time.js');
const { applyBuffers, subtract, alignInward, workWindows, resolveSchedule, runInfo, PRIORITY_WEIGHT } = require('./scheduler.js');

function matches(rec, d) {
  switch (rec.frequency) {
    case 'daily': return true;
    case 'weekdays': { const w = weekdayOf(d); return w >= 1 && w <= 5; }
    case 'weekly': return rec.daysOfWeek.includes(weekdayOf(d));
    case 'monthly': { const [y, m, day] = d.split('-').map(Number); return day === Math.min(rec.dayOfMonth, daysInMonth(y, m)); }
    default: return false;
  }
}

// A weekly rule with no weekdays ticked is a per-week budget: one occurrence per week (keyed by the week's first
// day), placed on any day of that week.
const isAnyDayWeekly = (rec) => rec.frequency === 'weekly' && !(rec.daysOfWeek && rec.daysOfWeek.length);
const weekStartOf = (d, weekStartsOn) => addDays(d, -((weekdayOf(d) - weekStartsOn + 7) % 7));

function occurrenceDates(rec, fromDate, toDate, weekStartsOn = 1) {
  if (isAnyDayWeekly(rec)) {
    const lo = fromDate > rec.startDate ? fromDate : rec.startDate;
    const end = rec.endDate ?? toDate;
    const hi = toDate < end ? toDate : end;
    const out = [];
    for (let w = weekStartOf(lo, weekStartsOn); w <= hi; w = addDays(w, 7)) out.push(w);
    return out;
  }
  const lo = fromDate > rec.startDate ? fromDate : rec.startDate;
  const end = rec.endDate ?? toDate;
  const hi = toDate < end ? toDate : end;
  const out = [];
  for (let d = lo; d <= hi; d = addDays(d, 1)) if (matches(rec, d)) out.push(d);
  return out;
}

function nextOccurrenceDate(rec, d) {
  for (let i = 1; i <= 62; i++) { const c = addDays(d, i); if (matches(rec, c)) return c; }
  return null;
}

const toMin = (s) => (s == null ? null : parseHHMM(s));

function generateOccurrences(rec, fromDate, toDate, tz, weekStartsOn = 1) {
  if (isAnyDayWeekly(rec)) {
    return occurrenceDates(rec, fromDate, toDate, weekStartsOn).map((w) => {
      const first = w > rec.startDate ? w : rec.startDate;
      let endExcl = addDays(w, 7);
      if (rec.endDate != null && addDays(rec.endDate, 1) < endExcl) endExcl = addDays(rec.endDate, 1);
      return { recurringId: rec.id, occurrenceDate: w, periodStart: zonedToUtc(first, 0, tz), periodEnd: zonedToUtc(endExcl, 0, tz),
        durationMin: rec.durationMin, priority: rec.priority, windowStart: toMin(rec.windowStart), windowEnd: toMin(rec.windowEnd), anyDayWeekly: true };
    });
  }
  return occurrenceDates(rec, fromDate, toDate).map((d) => {
    let endExcl = nextOccurrenceDate(rec, d);
    if (rec.endDate != null) { const cap = addDays(rec.endDate, 1); if (endExcl === null || endExcl > cap) endExcl = cap; }
    if (endExcl === null) endExcl = addDays(d, 1);
    return { recurringId: rec.id, occurrenceDate: d, periodStart: zonedToUtc(d, 0, tz), periodEnd: zonedToUtc(endExcl, 0, tz),
      durationMin: rec.durationMin, priority: rec.priority, windowStart: toMin(rec.windowStart), windowEnd: toMin(rec.windowEnd), anyDayWeekly: false };
  });
}

const cmpStr = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

function placeOccurrences(occurrences, busy, settings, now) {
  const tz = settings.timezone;
  const t0 = ceilGrid(now);
  const horizonEnd = zonedToUtc(addDays(utcToZoned(now, tz).date, settings.horizonDays), 0, tz);   // §9.1.2
  const workByKey = new Map();                                 // V2-D18: pass-2 windows per resolved schedule key
  const workFor = (o) => {
    const { key, hours } = resolveSchedule(settings, o.scheduleId);
    if (!workByKey.has(key)) workByKey.set(key, workWindows(settings, now, hours));
    return workByKey.get(key);
  };
  const occupied = applyBuffers(busy, settings);
  const occs = occurrences.map((o) => ({ ...o })).sort((a, b) =>
    PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] || a.periodStart - b.periodStart
    || a.recurringId - b.recurringId || cmpStr(a.occurrenceDate, b.occurrenceDate));
  // Break rule (same as tasks): after breakIntervalMin of continuous work a break of breakMin must follow. `work` is the
  // list of work intervals already fixed or placed; it decides how much of the current run is used up.
  const bctx = { breaksOn: settings.breakMin > 0 && settings.breakIntervalMin > 0, B: settings.breakMin * MIN, I: settings.breakIntervalMin * MIN };
  const work = busy.filter((b) => b.kind === 'work').map((b) => ({ start: b.start, end: b.end }));
  // Fill `segs` (sorted, grid-aligned) earliest first with pieces of at least minBlock (the last piece may be shorter
  // only when it is the whole remainder), cutting pieces so no run of work exceeds the break interval. Appends pieces to
  // `w`. Returns the pieces; their total may fall short of dur when time runs out.
  const fillSplit = (segs, dur, minBlock, w) => {
    const pieces = [];
    let left = dur;
    for (const s of segs) {
      let t = s.start;
      while (t < s.end && left > 0) {
        const { run, lastWorkEnd } = runInfo(bctx, w, t);
        if (bctx.breaksOn && run >= bctx.I) { t = ceilGrid(lastWorkEnd + bctx.B); continue; }
        const cap = !bctx.breaksOn ? Infinity : (run === 0 ? bctx.I : bctx.I - run);
        const len = Math.min(left, s.end - t, cap);
        if (len < Math.min(minBlock, left)) {
          t = (bctx.breaksOn && run > 0) ? Math.max(t + GRID, ceilGrid(lastWorkEnd + bctx.B)) : t + GRID;
          continue;
        }
        pieces.push({ start: t, end: t + len });
        w.push({ start: t, end: t + len });
        left -= len;
        t += len;
      }
    }
    return { pieces, left };
  };
  const blocks = [];
  const atRisk = [];
  for (const o of occs) {
    const dur = o.durationMin * MIN;
    const minBlock = Math.min(dur, (o.minBlockMin ?? o.durationMin) * MIN);   // no minBlockMin: one contiguous block
    const rangeStart = Math.max(t0, o.periodStart);
    const rangeEnd = Math.min(o.periodEnd, horizonEnd);
    let pieces = [];
    let left = dur;
    if (rangeEnd > rangeStart) {
      if (o.windowStart != null && o.windowEnd != null) {                       // pass 1: whole task inside the window
        const cands = [];
        const windowDays = [];                                                  // any-day weekly: whole week; else own day only
        if (o.anyDayWeekly) {
          for (let d = utcToZoned(o.periodStart, tz).date; zonedToUtc(d, 0, tz) < o.periodEnd; d = addDays(d, 1)) windowDays.push(d);
        } else windowDays.push(o.occurrenceDate);
        for (const d of windowDays) {
          const cand = { start: Math.max(zonedToUtc(d, o.windowStart, tz), rangeStart), end: Math.min(zonedToUtc(d, o.windowEnd, tz), rangeEnd) };
          if (cand.end > cand.start) cands.push(cand);
        }
        const trial = fillSplit(alignInward(subtract(cands, occupied)), dur, minBlock, work.slice());
        if (trial.left === 0) { pieces = trial.pieces; left = 0; work.push(...pieces); }
      }
      if (left > 0) {                                                           // pass 2: schedule hours, split allowed
        const clipped = [];
        for (const w of workFor(o)) { const s = Math.max(w.start, rangeStart), e = Math.min(w.end, rangeEnd); if (e > s) clipped.push({ start: s, end: e }); }
        const free = alignInward(subtract(clipped, occupied));
        const byDay = new Map();                                                // free time per local date
        for (const f of free) { const d = utcToZoned(f.start, tz).date; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(f); }
        if (o.periodEnd - o.periodStart > 36 * 3600000 && byDay.size > 1) {     // multi-day budget: spread it over the days
          const cap = Math.max(minBlock, Math.ceil(dur / MIN / byDay.size / 15) * 15 * MIN);
          for (const day of [...byDay.keys()].sort()) {
            if (left <= 0) break;
            const r = fillSplit(byDay.get(day), Math.min(cap, left), minBlock, work);
            pieces.push(...r.pieces); left -= Math.min(cap, left) - r.left;
          }
          if (left > 0) {                                                       // days had less room than the share: fill the rest
            const r = fillSplit(alignInward(subtract(free, pieces)), left, minBlock, work);
            pieces.push(...r.pieces); left = r.left;
          }
        } else ({ pieces, left } = fillSplit(free, dur, minBlock, work));
      }
    }
    for (const p of pieces) {
      blocks.push({ recurringId: o.recurringId, occurrenceDate: o.occurrenceDate, start: p.start, end: p.end });
      occupied.push({ start: p.start, end: p.end });
    }
    if (left > 0) {
      atRisk.push({ recurringId: o.recurringId, occurrenceDate: o.occurrenceDate, kind: 'unscheduled', deadline: o.periodEnd,
        deadlineType: null, plannedEnd: null, unscheduledMin: left / MIN, overdue: false });
    }
  }
  blocks.sort((a, b) => a.start - b.start || a.recurringId - b.recurringId || cmpStr(a.occurrenceDate, b.occurrenceDate));
  atRisk.sort((a, b) => a.recurringId - b.recurringId || cmpStr(a.occurrenceDate, b.occurrenceDate));
  return { blocks, atRisk };
}

module.exports = { occurrenceDates, nextOccurrenceDate, generateOccurrences, placeOccurrences };
