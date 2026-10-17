// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 0 oracle for T-AGB-1..6 — spec §13.9 (lines 929–953), §8.1 Agenda (lines 363–369), §5.8. Do not edit expectations.
// Open §5 call shapes decided by the Chunk 0 plan: D1, D2, D4, D6
const test = require('node:test');
const assert = require('node:assert');

const NOW = Date.parse('2026-10-19T10:00:00Z');
const HORIZON_END = Date.parse('2026-10-26T00:00:00Z');
const TS = '2026-10-01T00:00:00.000Z';
const Z = (d, hm) => `${d}T${hm}:00.000Z`;
const iso = (v) => new Date(v).toISOString();

const project = (stages = []) => ({ id: 1, name: 'Inbox', color: '#4f7cff', sortOrder: 0, archived: false, createdAt: TS, stages });
const task = (id, over = {}) => ({
  id, projectId: 1, stageId: null, title: 'Task ' + id, notes: '', durationMin: 60, priority: 'medium',
  deadline: null, deadlineType: 'hard', startAfter: null, minBlockMin: null, maxBlockMin: null, dontSplit: false, status: 'todo',
  completedAt: null, sortOrder: 0, createdAt: TS, updatedAt: TS, ...over,
});
const tblock = (id, tk, start, end, { completed = false, pinned = false } = {}) => {
  const done = tk.status === 'done';
  return {
    id, kind: 'task', taskId: tk.id, recurringId: null, occurrenceDate: null, start, end, pinned, completed,
    missed: Date.parse(end) <= NOW && !completed && !done, title: tk.title, color: '#4f7cff', projectId: 1, done,
  };
};
const rblock = (id, recurringId, occurrenceDate, start, end) => ({
  id, kind: 'recurring', taskId: null, recurringId, occurrenceDate, start, end, pinned: false, completed: false,
  missed: Date.parse(end) <= NOW, title: 'Rec', color: '#8e7cc3', projectId: null, done: false,
});
const recurring = (id) => ({
  id, title: 'Rec', notes: '', projectId: null, frequency: 'daily', daysOfWeek: [], dayOfMonth: null,
  durationMin: 30, windowStart: null, windowEnd: null, priority: 'medium', startDate: '2026-10-19', endDate: null, active: true,
  createdAt: TS, updatedAt: TS,
});
const ts = (taskId, over = {}) => ({
  taskId, state: 'ok', overdue: false, deadline: null, deadlineType: null, plannedEnd: null,
  scheduledMin: 60, unscheduledMin: 0, creditedMin: 0, slackMin: null, ...over,
});
const status = (tasks, atRisk = []) => ({
  ranAt: TS, horizonEnd: new Date(HORIZON_END).toISOString(), meta: { path: 'main', repairPasses: 0 }, tasks, atRisk, tight: [],
});
const build = (o) => {
  const { buildAgenda } = require('../lib/agenda.js');
  return buildAgenda({
    blocks: [], tasks: [], projects: [project()], recurring: [], status: status([]),
    now: NOW, tz: 'UTC', horizonEnd: HORIZON_END, ...o,
  });
};
const sorted = (rows) => [...rows].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.blockId - b.blockId);

test('T-AGB-1: partIndex and partCount follow start order', () => {
  const t1 = task(1, { durationMin: 180 });
  const out = build({
    tasks: [t1],
    blocks: [
      tblock(13, t1, Z('2026-10-20', '09:00'), Z('2026-10-20', '10:00')),
      tblock(11, t1, Z('2026-10-19', '11:00'), Z('2026-10-19', '12:00')),
      tblock(12, t1, Z('2026-10-19', '12:15'), Z('2026-10-19', '13:15')),
    ],
    status: status([ts(1, { scheduledMin: 180 })]),
  });
  assert.deepStrictEqual(sorted(out.rows.filter((r) => r.taskId === 1)).map((r) => [r.blockId, r.partIndex, r.partCount]),
    [[11, 1, 3], [12, 2, 3], [13, 3, 3]]);
});

test('T-AGB-2: block starting 15 days before today is excluded', () => {
  const t1 = task(1, { durationMin: 120 });
  const out = build({
    tasks: [t1],
    blocks: [
      tblock(21, t1, Z('2026-10-04', '09:00'), Z('2026-10-04', '10:00')),
      tblock(22, t1, Z('2026-10-19', '11:00'), Z('2026-10-19', '12:00')),
    ],
  });
  assert.deepStrictEqual(out.rows.filter((r) => r.taskId === 1).map((r) => r.blockId), [22]);
});

test('T-AGB-3: todo task with no future block and remaining work is unscheduled', () => {
  const t2 = task(2);
  const out = build({
    tasks: [t2],
    status: status([ts(2, { state: 'unscheduled', scheduledMin: 0, unscheduledMin: 60 })]),
  });
  assert.deepStrictEqual(out.unscheduled.filter((u) => u.taskId === 2).map((u) => u.unscheduledMin), [60]);
});

test('T-AGB-4: effective deadline and deadlineInherited', () => {
  const stage = { id: 5, projectId: 1, name: 'Stage A', sortOrder: 0, deadline: '2026-10-23T17:00:00.000Z', deadlineType: 'soft', createdAt: TS };
  const t3 = task(3, { stageId: 5 });
  const t4 = task(4, { stageId: 5, deadline: '2026-10-22T12:00:00.000Z', deadlineType: 'hard' });
  const out = build({
    projects: [project([stage])],
    tasks: [t3, t4],
    blocks: [
      tblock(31, t3, Z('2026-10-19', '11:00'), Z('2026-10-19', '12:00')),
      tblock(41, t4, Z('2026-10-19', '12:15'), Z('2026-10-19', '13:15')),
    ],
    status: status([ts(3), ts(4)]),
  });
  const byId = Object.fromEntries(out.rows.map((r) => [r.blockId, r]));
  assert.deepStrictEqual([iso(byId[31].deadline), byId[31].deadlineType, byId[31].deadlineInherited],
    ['2026-10-23T17:00:00.000Z', 'soft', true]);
  assert.strictEqual(byId[41].deadlineInherited, false);
});

test('T-AGB-5: riskState none for done owner, tight from TaskStatus, ok for recurring not at risk', () => {
  const t6 = task(6, { status: 'done', completedAt: TS });
  const t7 = task(7);
  const out = build({
    tasks: [t6, t7],
    blocks: [
      tblock(61, t6, Z('2026-10-19', '08:00'), Z('2026-10-19', '09:00')),
      tblock(71, t7, Z('2026-10-19', '11:00'), Z('2026-10-19', '12:00')),
      rblock(91, 9, '2026-10-19', Z('2026-10-19', '12:00'), Z('2026-10-19', '12:30')),
    ],
    recurring: [recurring(9)],
    status: status([ts(7, { state: 'tight' })], []),
  });
  const byId = Object.fromEntries(out.rows.map((r) => [r.blockId, r]));
  assert.deepStrictEqual([byId[61].riskState, byId[71].riskState, byId[91].riskState], ['none', 'tight', 'ok']);
});

test('T-AGB-6: remaining = estimate minus credited goes to unscheduled', () => {
  const t8 = task(8, { durationMin: 120 });
  const out = build({
    tasks: [t8],
    blocks: [tblock(81, t8, Z('2026-10-19', '08:00'), Z('2026-10-19', '09:00'), { completed: true })],
    status: status([ts(8, { state: 'unscheduled', creditedMin: 60, scheduledMin: 0, unscheduledMin: 60 })]),
  });
  assert.deepStrictEqual(out.unscheduled.filter((u) => u.taskId === 8).map((u) => u.unscheduledMin), [60]);
});
