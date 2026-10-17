// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// PURE scheduler (spec §9.1–9.6, §9.8). No I/O, no clock reads, no randomness: callers pass `now` (epoch ms).
// Instants are epoch-ms numbers (interface decision A2). §9.7 reference/repair/fallback and the §9.3 lookahead (DL-33) added by Chunk 4.
// V2-D18 (Chunk 18): per-schedule free time, urgency and guard when settings.schedules is given; identical to v1 otherwise.
const { MIN, GRID, ceilGrid, floorGrid, parseHHMM, addDays, weekdayOf, zonedToUtc, utcToZoned } = require('../public/shared/time.js');

// §9.0 constants
const GRID_MIN = 15;
const PRIORITY_WEIGHT = Object.freeze({ low: 100, medium: 200, high: 300, urgent: 400 });
const URGENCY_RAMP_MAX = 90;
const URGENCY_WINDOW_DAYS = 14;
const LATE_WINDOW_WORKDAYS = 2;
const LATE_FLOOR = 110;
const LATE_SPAN = 80;
const MAX_REPAIR_PASSES = 3;
const DAY_MS = 86400000;

function horizonEndOf(settings, now) {                       // §9.1.2
  const tz = settings.timezone;
  return zonedToUtc(addDays(utcToZoned(now, tz).date, settings.horizonDays), 0, tz);
}

// §9.1.3: for i in 0..days-1, each [s,e] of hours[weekdayOf(d)] -> UTC instants, unclipped.
// `hours` (V2-D18) defaults to settings.workHours, so v1 callers are unchanged.
function rawWorkWindows(settings, now, days, hours = settings.workHours) {
  const tz = settings.timezone;
  const today = utcToZoned(now, tz).date;
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(today, i);
    for (const [s, e] of hours[String(weekdayOf(d))] || []) {
      out.push({ start: zonedToUtc(d, parseHHMM(s), tz), end: zonedToUtc(d, parseHHMM(e), tz) });
    }
  }
  return out;
}

// §9.1.3: rawWorkWindows(.., horizonDays) clipped to [t0, horizonEnd], empty ones dropped.
function workWindows(settings, now, hours = settings.workHours) {
  const t0 = ceilGrid(now);
  const hEnd = horizonEndOf(settings, now);
  const out = [];
  for (const w of rawWorkWindows(settings, now, settings.horizonDays, hours)) {
    const start = Math.max(w.start, t0);
    const end = Math.min(w.end, hEnd);
    if (end > start) out.push({ start, end });
  }
  return out;
}

// §9.1.4: kind 'event' widened by meetingBufferMin on both sides; other kinds unchanged. Returns new objects.
function applyBuffers(busy, settings) {
  const buf = settings.meetingBufferMin * MIN;
  return busy.map((b) => (b.kind === 'event'
    ? { start: b.start - buf, end: b.end + buf, kind: b.kind }
    : { start: b.start, end: b.end, kind: b.kind }));
}

const byStartEnd = (a, b) => a.start - b.start || a.end - b.end;

// Each interval minus the union of cuts; sorted by start, non-empty pieces only. Inputs not mutated.
function subtract(intervals, cuts) {
  const cs = [...cuts].sort(byStartEnd);
  const out = [];
  for (const w of [...intervals].sort(byStartEnd)) {
    let cur = w.start;
    for (const c of cs) {
      if (c.start >= w.end) break;
      if (c.end <= cur) continue;
      if (c.start > cur) out.push({ start: cur, end: c.start });
      cur = Math.max(cur, c.end);
      if (cur >= w.end) break;
    }
    if (cur < w.end) out.push({ start: cur, end: w.end });
  }
  return out;
}

// §9.1.5: start=ceilGrid, end=floorGrid, drop if shorter than GRID.
function alignInward(intervals) {
  const out = [];
  for (const s of intervals) {
    const start = ceilGrid(s.start);
    const end = floorGrid(s.end);
    if (end - start >= GRID) out.push({ start, end });
  }
  return out;
}

// §9.4 LW in MINUTES: 2 · (total weekly work minutes) / (number of weekdays with work hours); 0 if none.
function lateWindowMin(settings) { return lateWindowMinOf(settings.workHours); }
function lateWindowMinOf(hours) {                            // V2-D18: same rule over any hours object
  let total = 0;
  let days = 0;
  for (let k = 0; k <= 6; k++) {
    const wins = hours[String(k)] || [];
    if (wins.length === 0) continue;
    days += 1;
    for (const [s, e] of wins) total += parseHHMM(e) - parseHHMM(s);
  }
  return days === 0 ? 0 : (LATE_WINDOW_WORKDAYS * total) / days;
}

const cmpNum = (a, b) => (a === b ? 0 : a < b ? -1 : 1);       // works with ±Infinity (no NaN from Infinity−Infinity)
const cmpStr = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

// V2-D18 hoursOf/key: own schedule ?? default schedule ?? settings.workHours. key 'default' = settings.workHours.
function resolveSchedule(settings, id) {
  const list = settings.schedules;
  if (!Array.isArray(list)) return { key: 'default', hours: settings.workHours };
  const own = id != null ? list.find((s) => s.id === id) : undefined;
  if (own) return { key: own.id, hours: own.hours };
  const def = list.find((s) => s.id === settings.defaultScheduleId);
  if (def) return { key: def.id, hours: def.hours };
  return { key: 'default', hours: settings.workHours };
}
const keyRank = (k) => (k === 'default' ? Infinity : k);
const cmpKey = (a, b) => cmpNum(keyRank(a), keyRank(b));            // numeric ids ascending, 'default' last

// V2-D18 union: sort, join pieces that strictly overlap; touching pieces stay separate (identity on one key's free).
function mergeOverlapping(intervals) {
  const out = [];
  for (const s of [...intervals].sort(byStartEnd)) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

// V2-D18 seg_x: the segment of sorted `segs` with start <= t < end, or null.
function segAt(segs, t) {
  for (const s of segs) {
    if (s.start > t) break;
    if (t < s.end) return s;
  }
  return null;
}

// §9.1 steps 1–6 per schedule key (V2-D18) plus §9.4 raw windows and LW per key.
function prepare(tasks, busy, settings, now) {
  const t0 = ceilGrid(now);
  const horizonEnd = horizonEndOf(settings, now);
  const busySorted = busy.map((b) => ({ start: b.start, end: b.end, kind: b.kind }))
    .sort((a, b) => a.start - b.start || a.end - b.end || cmpStr(a.kind, b.kind));
  const cuts = applyBuffers(busySorted, settings);
  const sorted = tasks.map((x) => ({ ...x })).sort((a, b) => a.id - b.id);
  const keyOf = new Map();                                     // task id -> schedule key (V2-D18 key(x))
  const sched = new Map();                                     // key -> { free, rawWins, rawEnd, LW } for keys used by tasks
  for (const x of sorted) {
    const { key, hours } = resolveSchedule(settings, x.scheduleId);
    keyOf.set(x.id, key);
    if (sched.has(key)) continue;
    const rawWins = rawWorkWindows(settings, now, settings.horizonDays + 14, hours);
    sched.set(key, {
      free: alignInward(subtract(workWindows(settings, now, hours), cuts)),
      rawWins,
      rawEnd: rawWins.length ? rawWins[rawWins.length - 1].end : -Infinity,
      LW: lateWindowMinOf(hours) * MIN,
    });
  }
  const keys = [...sched.keys()].sort(cmpKey);
  const U = alignInward(mergeOverlapping(keys.flatMap((k) => sched.get(k).free)));
  return {
    settings, now, t0, horizonEnd, busy: busySorted, keyOf, sched, keys, U,
    I: settings.breakIntervalMin * MIN,
    B: settings.breakMin * MIN,
    M: settings.hardDeadlineMarginMin * MIN,
    breaksOn: settings.breakMin > 0 && settings.breakIntervalMin > 0,
    tasks: sorted,
    baseWork: busySorted.filter((b) => b.kind === 'work').map((b) => ({ start: b.start, end: b.end })),
  };
}

// §9.3 per-task state.
function initState(ctx, task) {
  const r = task.remainingMin * MIN;
  return {
    ...task,
    r,
    lastEnd: task.fixedEnd ?? null,
    lastPlacedEnd: null,
    earliest: Math.max(ctx.t0, task.startAfter != null ? ceilGrid(task.startAfter) : ctx.t0),
    effMin: task.dontSplit ? r : (task.minBlockMin ?? ctx.settings.defaultMinBlockMin) * MIN,
  };
}

// §9.2 runInfo. Walk work intervals ending at or before t, latest end first (ties: later start first, D7).
function runInfo(ctx, work, t) {
  if (!ctx.breaksOn) return { run: 0, lastWorkEnd: null };
  const prior = work.filter((w) => w.end <= t).sort((a, b) => b.end - a.end || b.start - a.start);
  let cursor = t;
  let run = 0;
  let lastWorkEnd = null;
  for (const w of prior) {
    if (cursor - w.end >= ctx.B) break;
    if (lastWorkEnd === null) lastWorkEnd = w.end;      // chain[0].end
    run += w.end - w.start;
    cursor = w.start;
  }
  return { run, lastWorkEnd };
}

// §9.3 gateOpen / ready.
function gateOpen(states, x, t) {
  const finished = (g) => g.r === 0 && (g.lastEnd ?? -Infinity) <= t;
  if (x.blockedBy && x.blockedBy.length && !states.every((g) => !x.blockedBy.includes(g.id) || finished(g))) return false;
  if (x.stageSortOrder == null) return true;
  return states.every((g) => !(g.projectId === x.projectId && g.stageSortOrder != null && g.stageSortOrder < x.stageSortOrder)
    || (g.r === 0 && (g.lastEnd ?? -Infinity) <= t));
}
function ready(states, x, t) {
  return x.r > 0 && x.earliest <= t && gateOpen(states, x, t) && !(x.maxBlockMin != null && x.lastPlacedEnd === t);
}

// §9.3 placeable(q): a remainder q >= effMin can be cut into chunks each in [effMin, C] (DL-33).
function placeable(ctx, x, q) {
  const E = x.effMin;
  const C = Math.min(x.maxBlockMin != null ? Math.max(x.maxBlockMin * MIN, E) : Infinity, ctx.breaksOn ? Math.max(ctx.I, E) : Infinity);
  return C === Infinity || Math.ceil(q / C) * E <= q;
}

// §9.3 chunkLen. 0 = cannot place here.
function chunkLen(ctx, x, avail, run) {
  const r = x.r;
  const m = Math.min(x.effMin, r);
  const cap = !ctx.breaksOn ? Infinity : (run === 0 ? Math.max(ctx.I, m) : ctx.I - run);
  const maxB = x.maxBlockMin != null ? Math.max(x.maxBlockMin * MIN, m) : Infinity;
  const upper = Math.min(r, maxB, avail, cap);
  if (upper < m) return 0;
  if (upper === r) return r;
  if (r - upper >= x.effMin) {
    if (placeable(ctx, x, r - upper) || !placeable(ctx, x, r)) return upper;   // greedy is safe, or r was never placeable
    for (let l = upper - GRID; l >= m; l -= GRID) if (placeable(ctx, x, r - l)) return l;
    return 0;
  }
  const c = r - x.effMin;
  return c >= m ? c : 0;
}

// §9.4 score / urgency.
function urgency(ctx, x, t) {
  if (x.deadline == null) return 0;
  const ramp = URGENCY_RAMP_MAX * Math.min(1, Math.max(0, 1 - (x.deadline - t) / (URGENCY_WINDOW_DAYS * DAY_MS)));
  const s = ctx.sched.get(ctx.keyOf.get(x.id));
  if (x.deadlineType === 'soft' && s.LW > 0 && x.deadline <= s.rawEnd) {
    let w = 0;
    for (const win of s.rawWins) w += Math.max(0, Math.min(win.end, x.deadline) - Math.max(win.start, t));
    if (w <= s.LW) return LATE_FLOOR + LATE_SPAN * (1 - w / s.LW);
  }
  return ramp;
}
function score(ctx, x, t) {
  return PRIORITY_WEIGHT[x.priority] + urgency(ctx, x, t);
}

// §9.4 betterThan on fits {x, len, score}: negative = a is better.
// score desc, stageSortOrder asc (null last), sortOrder asc, createdAt asc, id asc.
function cmpBetter(a, b) {
  return cmpNum(b.score, a.score)
    || cmpNum(a.x.stageSortOrder ?? Infinity, b.x.stageSortOrder ?? Infinity)
    || cmpNum(a.x.sortOrder, b.x.sortOrder)
    || cmpNum(a.x.createdAt, b.x.createdAt)
    || cmpNum(a.x.id, b.x.id);
}
// (deadline asc, then betterThan); a null deadline sorts last.
function cmpDeadlineThenBetter(a, b) {
  return cmpNum(a.x.deadline ?? Infinity, b.x.deadline ?? Infinity) || cmpBetter(a, b);
}
const minBy = (arr, cmp) => arr.reduce((p, c) => (cmp(c, p) < 0 ? c : p));

// §9.5 feasible(fromT, overrides). overrides: Map<taskId, rMs> (D10).
function feasible(ctx, states, fromT, overrides) {
  const pend = [];
  for (const x of states) {
    if (x.deadlineType !== 'hard' || x.deadline == null || x.deadline > ctx.horizonEnd || !(x.r > 0)) continue;   // hardPending()
    const r = overrides.has(x.id) ? overrides.get(x.id) : x.r;
    if (r > 0) pend.push({ deadline: x.deadline, r, m: Math.min(x.effMin, r), key: ctx.keyOf.get(x.id) });
  }
  if (pend.length === 0) return true;
  if (ctx.keys.length > 1) {                                   // V2-D18: once per schedule key, sorted order
    for (const k of ctx.keys) {
      const pk = pend.filter((p) => p.key === k);
      if (pk.length > 0 && !capacityOk(ctx, pk, ctx.sched.get(k).free, fromT)) return false;
    }
  }
  return capacityOk(ctx, pend, ctx.U, fromT);                  // and once for all pend against U
}

// §9.5 capacity check of pend [{deadline, r, m}] against free segments segs (v1 body; segs replaces the v1 free field).
function capacityOk(ctx, pend, segs, fromT) {
  const mMin = Math.min(...pend.map((p) => p.m));
  const usable = (L) => (L < mMin ? 0 : L - (ctx.breaksOn ? ctx.B * Math.floor(L / (ctx.I + ctx.B)) : 0));
  const deadlines = [...new Set(pend.map((p) => p.deadline))].sort((a, b) => a - b);
  let demand = 0;
  for (const d of deadlines) {
    for (const p of pend) if (p.deadline === d) demand += p.r;
    const cutoff = d - ctx.M;                                  // plain wall-clock subtraction
    let cap = 0;
    for (const s of segs) cap += usable(Math.max(0, Math.min(s.end, cutoff) - Math.max(s.start, fromT)));
    if (demand > cap) return false;
  }
  return true;
}

// §9.5 afterFrom: the break the chunk itself forces.
function afterFrom(ctx, t, len, run) {
  return (ctx.breaksOn && run + len >= ctx.I) ? ceilGrid(t + len + ctx.B) : t + len;
}

// §9.6 one sweep. Mutates states (r, lastEnd, lastPlacedEnd) and work (appends placed blocks). Returns placed blocks.
// effDl (Map id -> effective deadline) non-null = §9.7 reference sweep: pick by (effDl, then betterThan), no guard, E ignored.
function sweep(ctx, states, E, work, effDl = null) {
  const blocks = [];
  for (const seg of ctx.U) {
    let t = seg.start;
    while (t < seg.end) {
      const { run, lastWorkEnd } = runInfo(ctx, work, t);
      if (ctx.breaksOn && run >= ctx.I) { t = ceilGrid(lastWorkEnd + ctx.B); continue; }
      const fits = [];
      for (const x of states) {
        if (!ready(states, x, t)) continue;
        const own = segAt(ctx.sched.get(ctx.keyOf.get(x.id)).free, t);    // V2-D18 seg_x; none -> x does not fit at t
        if (own === null) continue;
        const len = chunkLen(ctx, x, own.end - t, run);
        if (len > 0) fits.push({ x, len, score: score(ctx, x, t) });
      }
      if (fits.length === 0) {
        t = (ctx.breaksOn && run > 0) ? Math.max(t + GRID, ceilGrid(lastWorkEnd + ctx.B)) : t + GRID;
        continue;
      }
      let pick;
      if (effDl) {                                                         // §9.7 step 2: reference pick, no guard, no E
        pick = minBy(fits, (a, b) => cmpNum(effDl.get(a.x.id), effDl.get(b.x.id)) || cmpBetter(a, b));
      } else {
        const best = minBy(fits, cmpBetter);
        const edfFits = fits.filter((f) => f.x.deadlineType === 'hard' && f.x.deadline != null && f.x.deadline <= ctx.horizonEnd);
        const edfPick = edfFits.length ? minBy(edfFits, cmpDeadlineThenBetter) : null;
        const esc = fits.filter((f) => E.has(f.x.id));
        if (esc.length) pick = minBy(esc, cmpDeadlineThenBetter);
        else if (!feasible(ctx, states, t, new Map())) pick = edfPick ?? best;                       // EDF mode
        else if (edfPick === null || best.x === edfPick.x) pick = best;
        else if (feasible(ctx, states, afterFrom(ctx, t, best.len, run), new Map([[best.x.id, best.x.r - best.len]]))) pick = best;
        else pick = edfPick;
      }
      const end = t + pick.len;
      pick.x.r -= pick.len;
      pick.x.lastEnd = Math.max(pick.x.lastEnd ?? -Infinity, end);
      pick.x.lastPlacedEnd = end;
      work.push({ start: t, end });
      blocks.push({ taskId: pick.x.id, start: t, end });
      t = end;
    }
  }
  return blocks;
}

// §9.8 missed (true deadline, no margin). Shared by results and the §9.7 loop.
function isMissed(ctx, x) {
  return x.deadline != null && (x.r > 0 ? x.deadline <= ctx.horizonEnd : x.lastEnd != null && x.lastEnd > x.deadline);
}

// §9.8 results. states are in id order, so atRisk and tight come out sorted by taskId.
function results(ctx, states) {
  const atRisk = [];
  const tight = [];
  for (const x of states) {
    const plannedEnd = x.lastEnd ?? null;
    const unscheduledMin = x.r / MIN;
    const overdue = x.deadline != null && x.deadline <= ctx.now;
    const kind = isMissed(ctx, x) ? x.deadlineType : (unscheduledMin > 0 ? 'unscheduled' : null);
    if (kind != null) {
      atRisk.push({ taskId: x.id, kind, deadline: x.deadline, deadlineType: x.deadlineType, plannedEnd, unscheduledMin, overdue });
    } else if (x.deadlineType === 'hard' && plannedEnd != null && plannedEnd > x.deadline - ctx.M) {
      tight.push({ taskId: x.id, deadline: x.deadline, plannedEnd, slackMin: (x.deadline - plannedEnd) / MIN });
    }
  }
  return { atRisk, tight };
}

// §9.7 step 1: H membership.
const inH = (ctx, x) => x.deadlineType === 'hard' && x.deadline != null && x.deadline <= ctx.horizonEnd;

// §9.7 step 1: H* as a Map id -> effDl (H tasks: own deadline; stage predecessors: min deadline of their H successors).
function hStarEffDl(ctx) {
  const H = ctx.tasks.filter((h) => inH(ctx, h));
  const effDl = new Map();
  for (const g of ctx.tasks) {
    if (inH(ctx, g)) { effDl.set(g.id, g.deadline); continue; }
    if (g.stageSortOrder == null) continue;
    const succ = H.filter((h) => h.projectId === g.projectId && h.stageSortOrder != null && g.stageSortOrder < h.stageSortOrder);
    if (succ.length) effDl.set(g.id, Math.min(...succ.map((h) => h.deadline)));
  }
  // explicit blocked-by links: a blocker inherits the earliest effective deadline of what it blocks (to a fixpoint)
  for (let changed = true; changed;) {
    changed = false;
    for (const x of ctx.tasks) {
      if (!x.blockedBy || !effDl.has(x.id)) continue;
      for (const bid of x.blockedBy) {
        if (effDl.get(bid) === undefined || effDl.get(bid) > effDl.get(x.id)) { effDl.set(bid, effDl.get(x.id)); changed = true; }
      }
    }
  }
  return effDl;
}

const freshWork = (ctx) => ctx.baseWork.map((w) => ({ start: w.start, end: w.end }));
const sortBlocks = (blocks) => blocks.sort((a, b) => a.start - b.start || a.taskId - b.taskId);

// §9.7 step 2: reference sweep over copies of H* only. refMet = ids in H with deadline > now not missed by the reference.
function runReference(ctx) {
  const effDl = hStarEffDl(ctx);
  const states = ctx.tasks.filter((x) => effDl.has(x.id)).map((x) => initState(ctx, x));
  const blocks = sweep(ctx, states, new Set(), freshWork(ctx), effDl);
  const refMet = new Set(states.filter((x) => inH(ctx, x) && x.deadline > ctx.now && !isMissed(ctx, x)).map((x) => x.id));
  return { states, blocks, refMet };
}

function finish(ctx, blocks, states, path, repairPasses) {
  const { atRisk, tight } = results(ctx, states);
  return { blocks: sortBlocks(blocks), atRisk, tight, horizonEnd: ctx.horizonEnd, meta: { path, repairPasses } };
}

// §5.3 referenceSchedule (exported for tests).
function referenceSchedule(tasks, busyIntervals, settings, now) {
  const ctx = prepare(tasks, busyIntervals, settings, now);
  const ref = runReference(ctx);
  return { blocks: sortBlocks(ref.blocks), metTaskIds: [...ref.refMet].sort((a, b) => a - b) };
}

// §5.3 schedule: §9.7 reference, main loop with escalated set E, fallback.
function schedule(tasks, busyIntervals, settings, now) {
  const ctx = prepare(tasks, busyIntervals, settings, now);
  const ref = runReference(ctx);
  const E = new Set();
  let pass = 0;
  for (;;) {                                                           // §9.7 step 3
    const states = ctx.tasks.map((x) => initState(ctx, x));
    const blocks = sweep(ctx, states, E, freshWork(ctx));
    const viol = states.filter((x) => ref.refMet.has(x.id) && isMissed(ctx, x)).map((x) => x.id);
    if (viol.length === 0) return finish(ctx, blocks, states, pass === 0 ? 'main' : 'repair', pass);
    if (pass === MAX_REPAIR_PASSES) break;
    pass += 1;
    for (const id of viol) E.add(id);
  }
  // §9.7 step 4 fallback: reference blocks verbatim; H* tasks zeroed and pinned to their reference lastEnd; reference blocks busy 'work'.
  const refById = new Map(ref.states.map((x) => [x.id, x]));
  const fbTasks = ctx.tasks.map((x) => (refById.has(x.id) ? { ...x, remainingMin: 0, fixedEnd: refById.get(x.id).lastEnd } : x));
  const fbBusy = [...ctx.busy, ...ref.blocks.map((b) => ({ start: b.start, end: b.end, kind: 'work' }))];
  const fctx = prepare(fbTasks, fbBusy, settings, now);
  const fstates = fctx.tasks.map((x) => initState(fctx, x));
  const fblocks = sweep(fctx, fstates, new Set(), freshWork(fctx));
  const merged = fstates.map((x) => refById.get(x.id) ?? x);            // H* atRisk/tight from the reference state
  return finish(ctx, [...ref.blocks, ...fblocks], merged, 'fallback', pass);
}

module.exports = {
  schedule, referenceSchedule, runInfo, subtract, alignInward, workWindows, rawWorkWindows, applyBuffers, lateWindowMin, resolveSchedule,
  GRID_MIN, PRIORITY_WEIGHT, URGENCY_RAMP_MAX, URGENCY_WINDOW_DAYS, LATE_WINDOW_WORKDAYS, LATE_FLOOR, LATE_SPAN, MAX_REPAIR_PASSES,
};
