// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 18 oracle for T-V2-SCH-1..5 and T-V2-REC-1 — spec-v2 §R6 V2-D16/V2-D18, "Acceptance" Chunk 18.
// UTC, NOW = 2026-10-19T08:00Z Monday, breaks off (breakIntervalMin 0, interface decision A5).
// T-V2-SCH-5 and T-V2-SCH-G values computed by the Chunk 18 planner. Do not edit expectations.
const test = require('node:test');
const assert = require('node:assert');

const P = Date.parse;
const NOW = P('2026-10-19T08:00:00Z');
const DAYS = { Mon: '2026-10-19', Tue: '2026-10-20', Wed: '2026-10-21', Thu: '2026-10-22', Fri: '2026-10-23' };
function T(tok) {                       // 'HH:MM' = Monday; 'Tue HH:MM'
  const m = /^(?:(Mon|Tue|Wed|Thu|Fri) )?(\d\d):(\d\d)$/.exec(tok.trim());
  if (!m) throw new Error('bad time token: ' + tok);
  return P(`${DAYS[m[1] || 'Mon']}T${m[2]}:${m[3]}:00Z`);
}
function B(text) {                      // '[1,09:00,10:00],[2,Wed 09:00,Wed 10:00]' -> [[id, startMs, endMs], ...]
  const out = [...text.matchAll(/\[(\d+),([^,\]]+),([^\]]+)\]/g)].map((m) => [Number(m[1]), T(m[2]), T(m[3])]);
  if (out.length !== (text.match(/\[/g) || []).length) throw new Error('unparsed block in: ' + text);
  return out;
}
const WD = [1, 2, 3, 4, 5];
function hrs(days, ranges) {            // hours object: listed weekdays get `ranges`, the others []
  const h = {};
  for (let k = 0; k <= 6; k++) h[String(k)] = days.includes(k) ? structuredClone(ranges) : [];
  return h;
}
const WH = hrs(WD, [['09:00', '17:00']]);
const H_9_12 = hrs(WD, [['09:00', '12:00']]);
const H_18_21 = hrs(WD, [['18:00', '21:00']]);
const H_EMPTY = hrs([], []);
const settings = (over = {}) => ({ timezone: 'UTC', workHours: structuredClone(WH), defaultMinBlockMin: 60, breakMin: 15,
  breakIntervalMin: 0, meetingBufferMin: 15, horizonDays: 7, allDayEventsBlock: false, hardDeadlineMarginMin: 120, ...over });
const DEF = { projectId: 1, stageSortOrder: null, priority: 'medium', deadline: null, deadlineType: null, startAfter: null,
  minBlockMin: null, maxBlockMin: null, dontSplit: false, fixedEnd: null, sortOrder: 0, createdAt: 0 };
const t = (id, remainingMin, extra = {}) => ({ ...DEF, id, remainingMin, ...extra });
const soft = (x) => ({ deadline: T(x), deadlineType: 'soft' });
function run(tasks, over = {}) {
  const { schedule } = require('../lib/scheduler.js');
  return schedule(structuredClone(tasks), [], settings(over), NOW);
}
const blocksOf = (o) => o.blocks.map((b) => [b.taskId, b.start, b.end]);
const riskOf = (o) => o.atRisk.map((a) => ({ taskId: a.taskId, kind: a.kind, unscheduledMin: a.unscheduledMin }));
function expectOut(o, blocks, atRisk = []) {
  assert.deepStrictEqual(blocksOf(o), blocks);
  assert.deepStrictEqual(riskOf(o), atRisk);
  assert.deepStrictEqual(o.tight, []);
  assert.strictEqual(o.meta.path, 'main');
}

test('T-V2-SCH-1: each task is placed only inside its own schedule', () => {
  assert.deepStrictEqual(B('[1,09:00,10:00],[2,Wed 09:00,Wed 10:00]'), [[1, P('2026-10-19T09:00:00Z'), P('2026-10-19T10:00:00Z')], [2, P('2026-10-21T09:00:00Z'), P('2026-10-21T10:00:00Z')]]);
  const o = run([t(1, 120, { scheduleId: 1 }), t(2, 120, { scheduleId: 2 })],
    { schedules: [{ id: 1, hours: H_9_12 }, { id: 2, hours: H_18_21 }], defaultScheduleId: 1 });
  expectOut(o, B('[1,09:00,11:00],[2,18:00,20:00]'));
});

test('T-V2-SCH-2: null or unknown scheduleId uses defaultScheduleId; then workHours; no schedules = v1', () => {
  const tasks = [t(1, 60, { scheduleId: null }), t(2, 60, { scheduleId: 99 })];
  const schedules = [{ id: 1, hours: H_9_12 }, { id: 2, hours: H_18_21 }];
  expectOut(run(tasks, { schedules, defaultScheduleId: 2 }), B('[1,18:00,19:00],[2,19:00,20:00]'));
  expectOut(run(tasks, { schedules, defaultScheduleId: 99 }), B('[1,09:00,10:00],[2,10:00,11:00]'));   // falls back to workHours
  expectOut(run([t(1, 60, { scheduleId: 2 })]), B('[1,09:00,10:00]'));                                  // settings.schedules absent
});

test('T-V2-SCH-3: schedules share one timeline; a higher-priority task in a shorter schedule goes first', () => {
  const o = run([t(1, 180, { scheduleId: 2, priority: 'high' }), t(2, 180, { scheduleId: 1 })],
    { schedules: [{ id: 1, hours: WH }, { id: 2, hours: H_9_12 }], defaultScheduleId: 1 });
  expectOut(o, B('[1,09:00,12:00],[2,12:00,15:00]'));
});

test('T-V2-SCH-4: a schedule with no hours leaves its task unscheduled', () => {
  const schedules = [{ id: 1, hours: WH }, { id: 2, hours: H_EMPTY }];
  expectOut(run([t(1, 90, { scheduleId: 2 }), t(2, 60, { scheduleId: 1 })], { schedules, defaultScheduleId: 1 }),
    B('[2,09:00,10:00]'), [{ taskId: 1, kind: 'unscheduled', unscheduledMin: 90 }]);
  expectOut(run([t(1, 90, { scheduleId: 2 })], { schedules, defaultScheduleId: 1 }),
    [], [{ taskId: 1, kind: 'unscheduled', unscheduledMin: 90 }]);
});

test('T-V2-SCH-5: soft-deadline urgency uses the task\'s own schedule windows and late window', () => {
  const tasks = [t(1, 60, { scheduleId: 1, priority: 'high' }), t(2, 60, { scheduleId: 2, ...soft('Fri 10:00') })];
  // (a) schedule 2 = Mon, Fri 09:00-10:00: LW_2 = 120 min, w = 120 min at Mon 09:00 -> late window, score 310 > 300.
  expectOut(run(tasks, { schedules: [{ id: 1, hours: WH }, { id: 2, hours: hrs([1, 5], [['09:00', '10:00']]) }], defaultScheduleId: 1 }),
    B('[2,09:00,10:00],[1,10:00,11:00]'));
  // (b) schedule 2 = Mon, Wed, Fri 09:00-10:00: LW_2 = 120 min, w = 180 min -> ramp only (~64.0), score ~264 < 300.
  expectOut(run(tasks, { schedules: [{ id: 1, hours: WH }, { id: 2, hours: hrs([1, 3, 5], [['09:00', '10:00']]) }], defaultScheduleId: 1 }),
    B('[1,09:00,10:00],[2,Wed 09:00,Wed 10:00]'));
});

test('T-V2-SCH-G (planner-added): the per-schedule hard-deadline guard picks EDF when only the task\'s own schedule is short', () => {
  // Union capacity from 10:00 to cutoff 11:00 is 60 min (enough); schedule 2's capacity there is 0. Only the per-key guard
  // makes the main sweep put task 1 first; without it the main run misses task 1 and the result comes from repair (path 'repair').
  const schedules = [{ id: 1, hours: WH }, { id: 2, hours: hrs([1], [['09:00', '10:00']]) }];
  const o = run([t(1, 60, { scheduleId: 2, deadline: T('13:00'), deadlineType: 'hard' }), t(2, 60, { scheduleId: 1, priority: 'high' })],
    { schedules, defaultScheduleId: 1 });
  expectOut(o, B('[1,09:00,10:00],[2,10:00,11:00]'));
});

const occ = (over = {}) => ({ recurringId: 7, occurrenceDate: '2026-10-19', periodStart: P('2026-10-19T00:00:00Z'),
  periodEnd: P('2026-10-20T00:00:00Z'), durationMin: 30, priority: 'medium', windowStart: null, windowEnd: null, scheduleId: null, ...over });
function place(o, over) {
  const { placeOccurrences } = require('../lib/recurrence.js');
  const out = placeOccurrences([o], [], settings(over), NOW);
  assert.deepStrictEqual(out.atRisk, []);
  return out.blocks.map((b) => [b.recurringId, b.occurrenceDate, b.start, b.end]);
}

test('T-V2-REC-1: placeOccurrences pass 2 uses the occurrence schedule; a preferred window ignores it', () => {
  const S = { schedules: [{ id: 1, hours: WH }, { id: 2, hours: H_18_21 }], defaultScheduleId: 1 };
  assert.deepStrictEqual(place(occ({ scheduleId: 2 }), S),
    [[7, '2026-10-19', P('2026-10-19T18:00:00Z'), P('2026-10-19T18:30:00Z')]]);
  assert.deepStrictEqual(place(occ({ scheduleId: 2, occurrenceDate: '2026-10-20', periodStart: P('2026-10-20T00:00:00Z'),
    periodEnd: P('2026-10-21T00:00:00Z'), windowStart: 420, windowEnd: 480 }), S),
    [[7, '2026-10-20', P('2026-10-20T07:00:00Z'), P('2026-10-20T07:30:00Z')]]);
  assert.deepStrictEqual(place(occ({ scheduleId: null }), S),                       // default schedule 1
    [[7, '2026-10-19', P('2026-10-19T09:00:00Z'), P('2026-10-19T09:30:00Z')]]);
  assert.deepStrictEqual(place(occ({ scheduleId: 2 }), {}),                         // settings.schedules absent = v1
    [[7, '2026-10-19', P('2026-10-19T09:00:00Z'), P('2026-10-19T09:30:00Z')]]);
});
