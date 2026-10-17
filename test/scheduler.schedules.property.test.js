// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 18 oracle for T-V2-PROP (a)-(d) — spec-v2 §R6 V2-D18, "Acceptance" Chunk 18.
// Seeded LCG only (no Math.random). generate() is the v1 §13.5 generator copied verbatim from test/scheduler.property.test.js.
const test = require('node:test');
const assert = require('node:assert');

const P = Date.parse;
const NOW = P('2026-10-19T08:00:00Z');
const MON0 = P('2026-10-19T00:00:00Z');
const MON9 = P('2026-10-19T09:00:00Z'), Q = 900000, DAYMS = 86400000, MINMS = 60000;
const WH = { '0': [], '1': [['09:00', '17:00']], '2': [['09:00', '17:00']], '3': [['09:00', '17:00']],
             '4': [['09:00', '17:00']], '5': [['09:00', '17:00']], '6': [] };

function generate(seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const nt = 2 + Math.floor(rnd() * 7);
  const tasks = [], busy = [];
  for (let i = 1; i <= nt; i++) {
    const t = { id: i, projectId: 1, stageSortOrder: null, priority: 'medium', remainingMin: 0, deadline: null, deadlineType: null,
      startAfter: null, minBlockMin: null, maxBlockMin: null, dontSplit: false, fixedEnd: null, sortOrder: 0, createdAt: i };
    t.remainingMin = 15 * (1 + Math.floor(rnd() * 24));
    t.priority = pick(['low', 'medium', 'high', 'urgent']);
    t.sortOrder = Math.floor(rnd() * 3);
    t.minBlockMin = rnd() < 0.3 ? pick([15, 30, 45, 90, 120]) : null;
    let mx = rnd() < 0.15 ? pick([60, 90, 120]) : null;
    if (mx != null && t.minBlockMin != null && mx < t.minBlockMin) mx = null;
    t.maxBlockMin = mx;
    t.dontSplit = rnd() < 0.1;
    const u = rnd();
    t.deadlineType = u < 0.45 ? 'hard' : u < 0.7 ? 'soft' : null;
    if (t.deadlineType) { t.deadline = MON9 + Q * Math.floor(rnd() * 480); if (rnd() < 0.05) t.deadline -= 2 * DAYMS; }
    if (rnd() < 0.15) t.startAfter = MON9 + Q * Math.floor(rnd() * 192);
    if (rnd() < 0.25) { t.projectId = 1 + Math.floor(rnd() * 2); t.stageSortOrder = Math.floor(rnd() * 3); }
    if (rnd() < 0.1) { const st = MON9 + Q * Math.floor(rnd() * 288); const len = Q * (2 + Math.floor(rnd() * 6));
      busy.push({ start: st, end: st + len, kind: 'work' }); t.fixedEnd = st + len; }
    tasks.push(t);
  }
  const nb = Math.floor(rnd() * 5);
  for (let k = 0; k < nb; k++) { const st = MON9 + Q * Math.floor(rnd() * 384); const len = Q * (1 + Math.floor(rnd() * 8));
    busy.push({ start: st, end: st + len, kind: 'event' }); }
  const settings = { timezone: 'UTC', workHours: structuredClone(WH), allDayEventsBlock: false,
    defaultMinBlockMin: pick([30, 60, 60, 90]), breakMin: pick([0, 15, 15, 10]), breakIntervalMin: pick([0, 90, 90, 60, 120]),
    meetingBufferMin: pick([0, 15]), horizonDays: 7, hardDeadlineMarginMin: pick([0, 120, 120, 240, 60]) };
  return { tasks, busy, settings };
}

// v2 extension from a separate LCG stream (generate(seed) itself is untouched): 1-3 schedules, per-task scheduleId.
const IDS = [3, 7, 12];
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
function genHours(rnd) {
  const h = {};
  for (let k = 0; k <= 6; k++) {
    const ranges = [];
    if (rnd() < (k >= 1 && k <= 5 ? 0.8 : 0.2)) {
      const s1 = 15 * Math.floor(rnd() * 80);                                   // 00:00..19:45
      const e1 = Math.min(1440, s1 + 15 * (4 + Math.floor(rnd() * 29)));        // 1 h..8 h, may end 24:00
      ranges.push([fmt(s1), fmt(e1)]);
      if (rnd() < 0.3) {
        const s2 = e1 + 15 * (1 + Math.floor(rnd() * 8));
        if (s2 + 60 <= 1440) ranges.push([fmt(s2), fmt(Math.min(1440, s2 + 15 * (4 + Math.floor(rnd() * 13))))]);
      }
    }
    h[String(k)] = ranges;
  }
  return h;
}
function generateV2(seed) {
  const g = generate(seed);
  let s = (Math.imul(seed, 2654435761) ^ 0x5bd1e995) >>> 0;
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const ids = IDS.slice(0, 1 + Math.floor(rnd() * 3));
  g.settings.schedules = ids.map((id) => ({ id, hours: genHours(rnd) }));
  g.settings.defaultScheduleId = pick(ids);
  for (const x of g.tasks) x.scheduleId = pick([null, ...ids, 99]);          // 99 = unknown -> default
  return g;
}
// Independent oracle for V2-D18 hoursOf (own ?? default; the generator always has a valid default).
function scheduleOf(settings, sid) {
  return settings.schedules.find((x) => x.id === sid) ?? settings.schedules.find((x) => x.id === settings.defaultScheduleId);
}
function windowsOf(settings, sid) {                // raw UTC windows over the 7-day horizon starting Monday 2026-10-19
  const sch = scheduleOf(settings, sid);
  const out = [];
  for (let i = 0; i < settings.horizonDays; i++) {
    const day = MON0 + i * DAYMS;
    for (const [a, b] of sch.hours[String(new Date(day).getUTCDay())]) out.push([day + hm(a) * MINMS, day + hm(b) * MINMS]);
  }
  return out;
}

test('T-V2-PROP (d): every v1 T-PROP case as a single schedule deep-equals v1 output (seeds 1..2000)', () => {
  // generator self-check (values from the v1 D13 self-check for seed 6551)
  assert.deepStrictEqual(generate(6551).tasks.map((x) => [x.id, x.remainingMin, x.priority]), [[1, 195, 'high'], [2, 285, 'high'], [3, 345, 'medium']]);
  const { schedule, referenceSchedule } = require('../lib/scheduler.js');
  const diffs = [];
  for (let seed = 1; seed <= 2000; seed++) {
    const v1 = generate(seed), v1r = generate(seed);
    const one = (g) => {
      g.settings.schedules = [{ id: 1, hours: structuredClone(WH) }];
      g.settings.defaultScheduleId = 1;
      for (const x of g.tasks) x.scheduleId = [null, 1, 5][x.id % 3];       // null, explicit 1, unknown 5 -> all schedule 1
      return g;
    };
    const v2 = one(generate(seed)), v2r = one(generate(seed));
    try {
      assert.deepStrictEqual(schedule(v2.tasks, v2.busy, v2.settings, NOW), schedule(v1.tasks, v1.busy, v1.settings, NOW));
      assert.deepStrictEqual(referenceSchedule(v2r.tasks, v2r.busy, v2r.settings, NOW), referenceSchedule(v1r.tasks, v1r.busy, v1r.settings, NOW));
    } catch { diffs.push(seed); }
  }
  assert.deepStrictEqual(diffs, []);
});

test('T-V2-PROP (a)-(c): 1-3 schedules: blocks inside own schedule, no overlaps, refMet guarantee (seeds 1..1000)', () => {
  const { schedule, referenceSchedule } = require('../lib/scheduler.js');
  const outside = [], overlaps = [], failures = [];
  let multiKey = 0, placedNonDefault = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const g = generateV2(seed), gr = generateV2(seed), gc = generateV2(seed);
    const out = schedule(g.tasks, g.busy, g.settings, NOW);
    const ref = referenceSchedule(gr.tasks, gr.busy, gr.settings, NOW);
    const sidById = new Map(gc.tasks.map((x) => [x.id, x.scheduleId]));
    if (new Set(gc.tasks.map((x) => scheduleOf(gc.settings, x.scheduleId).id)).size >= 2) multiKey += 1;
    // (a) each block lies inside one work window of its task's schedule
    for (const b of out.blocks) {
      const sid = sidById.get(b.taskId);
      if (scheduleOf(gc.settings, sid).id !== gc.settings.defaultScheduleId) placedNonDefault += 1;
      if (!windowsOf(gc.settings, sid).some(([s, e]) => s <= b.start && b.end <= e)) outside.push({ seed, taskId: b.taskId });
    }
    // (b) no block overlaps another block or a busy interval
    const sorted = [...out.blocks].sort((x, y) => x.start - y.start);
    let maxEnd = -Infinity;
    for (const b of sorted) { if (b.start < maxEnd) overlaps.push({ seed, type: 'block' }); maxEnd = Math.max(maxEnd, b.end); }
    for (const b of out.blocks) for (const x of gc.busy) if (b.start < x.end && x.start < b.end) overlaps.push({ seed, type: 'busy' });
    // (c) §9.7: no task the reference meets is hard-at-risk
    for (const id of ref.metTaskIds) if (out.atRisk.some((a) => a.taskId === id && a.kind === 'hard')) failures.push({ seed, taskId: id });
  }
  assert.deepStrictEqual(outside, []);
  assert.deepStrictEqual(overlaps, []);
  assert.deepStrictEqual(failures, []);
  assert.ok(multiKey >= 100, `multi-schedule cases: ${multiKey}`);
  assert.ok(placedNonDefault >= 1, `blocks in non-default schedules: ${placedNonDefault}`);
});
