// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 0 oracle for T-AGM-1..11 — spec §13.9 (lines 929–953), §10.4 (lines 666–700), §8.1 AgendaRow/Agenda (lines 363–369), §5.7–5.8. Do not edit expectations.
// Open §5 call shapes decided by the Chunk 0 plan: D1, D2, D4, D6
const test = require('node:test');
const assert = require('node:assert');

const row = (blockId, kind, title, start, end, f = {}) => ({
  blockId, kind, taskId: kind === 'task' ? 100 + blockId : null,
  recurringId: kind === 'recurring' ? 7 : null, occurrenceDate: null, title, start, end, durationMin: 60, projectId: 1,
  projectName: 'Inbox', projectColor: '#4f7cff', stageId: null, stageName: null, priority: 'medium', deadline: null,
  deadlineType: null, deadlineInherited: false, riskState: 'ok', overdue: false, pinned: false, completed: false, done: false,
  missed: false, partIndex: 1, partCount: 1, ...f,
});
const Z = (d, hm) => `${d}T${hm}:00.000Z`;
const G = row(1, 'task', 'G', Z('2026-10-16', '09:00'), Z('2026-10-16', '10:00'), { missed: true });
const A = row(2, 'task', 'A', Z('2026-10-19', '09:00'), Z('2026-10-19', '10:00'), { missed: true });
const Bk = row(3, 'task', 'B', Z('2026-10-19', '09:00'), Z('2026-10-19', '10:00'), { completed: true });
const C = row(4, 'task', 'C', Z('2026-10-19', '10:00'), Z('2026-10-19', '11:00'));
const D = row(5, 'task', 'D', Z('2026-10-20', '09:00'), Z('2026-10-20', '10:00'));
const E = row(6, 'task', 'E', Z('2026-10-22', '09:00'), Z('2026-10-22', '10:00'));
const F = row(7, 'task', 'F', Z('2026-10-18', '09:00'), Z('2026-10-18', '10:00'), { completed: true });
const H = row(8, 'task', 'H', Z('2026-10-19', '08:00'), Z('2026-10-19', '08:30'), { done: true, riskState: 'none' });
const R = row(9, 'recurring', 'R', Z('2026-10-19', '09:30'), Z('2026-10-19', '10:00'), { occurrenceDate: '2026-10-19', missed: true });
const Q = row(10, 'recurring', 'Q', Z('2026-10-16', '09:30'), Z('2026-10-16', '10:00'), { occurrenceDate: '2026-10-16', missed: true });
const W = row(11, 'recurring', 'W', Z('2026-10-21', '09:00'), Z('2026-10-21', '09:30'), { occurrenceDate: '2026-10-19', missed: true });
const U = {
  kind: 'task', taskId: 200, recurringId: null, occurrenceDate: null, title: 'U', projectId: 1, projectName: 'Inbox',
  projectColor: '#4f7cff', stageName: null, priority: 'medium', deadline: null, deadlineType: null, deadlineInherited: false,
  riskState: 'unscheduled', unscheduledMin: 60,
};
const ALL = [G, A, Bk, C, D, E, F, H, R, Q];
const MON = '2026-10-19T10:30:00.000Z';
const agendaAt = (nowIso, rows, unscheduled = []) => {
  const today = nowIso.slice(0, 10);
  return {
    now: nowIso, today, horizonEnd: new Date(Date.parse(today + 'T00:00:00Z') + 7 * 86400000).toISOString(),
    rows, unscheduled,
  };
};
const shape = (groups) => groups.map((g) => [g.label, g.rows.map((r) => r.title)]);
const grp = (groupAgenda, nowIso, rows, uns = [], showDone = false) =>
  shape(groupAgenda(agendaAt(nowIso, rows, uns), { now: Date.parse(nowIso), tz: 'UTC', showDone }));

// Filter fixture (spec L943–946)
const P1 = row(21, 'task', 'Write report', Z('2026-10-20', '09:00'), Z('2026-10-20', '10:00'),
  { projectId: 2, priority: 'high', deadline: '2026-10-23T17:00:00.000Z', deadlineType: 'hard' });
const P2 = row(22, 'task', 'Review PR', Z('2026-10-20', '09:00'), Z('2026-10-20', '10:00'),
  { projectId: 1, priority: 'high', deadline: '2026-10-23T17:00:00.000Z', deadlineType: 'soft' });
const P3 = row(23, 'task', 'Report expenses', Z('2026-10-20', '09:00'), Z('2026-10-20', '10:00'),
  { projectId: 2, priority: 'medium', deadline: '2026-10-23T17:00:00.000Z', deadlineType: 'hard' });
const P4 = row(24, 'recurring', 'Gym', Z('2026-10-20', '09:00'), Z('2026-10-20', '10:00'),
  { projectId: null, priority: 'high', deadlineType: null });
const PF = [P1, P2, P3, P4];

test('T-AGM-1: groupAgenda overdue today tomorrow dated and unscheduled groups without done rows', async () => {
  const { groupAgenda } = await import('../public/js/agendaModel.js');
  assert.deepStrictEqual(grp(groupAgenda, MON, ALL, [U], false), [
    ['Overdue', ['G', 'A', 'R']], ['Today', ['C']], ['Tomorrow', ['D']], ['Thu 22 Oct', ['E']], ['Unscheduled', ['U']],
  ]);
});

test('T-AGM-2: groupAgenda showDone true keeps done rows in Today', async () => {
  const { groupAgenda } = await import('../public/js/agendaModel.js');
  assert.deepStrictEqual(grp(groupAgenda, MON, ALL, [U], true), [
    ['Overdue', ['G', 'A', 'R']], ['Today', ['H', 'B', 'C']], ['Tomorrow', ['D']], ['Thu 22 Oct', ['E']], ['Unscheduled', ['U']],
  ]);
});

test('T-AGM-3: groupAgenda next day moves a missed task block to Overdue and drops a passed recurring row', async () => {
  const { groupAgenda } = await import('../public/js/agendaModel.js');
  const now = '2026-10-20T08:00:00.000Z';
  assert.deepStrictEqual(grp(groupAgenda, now, [R], [], false), [['Today', []]]);
  assert.deepStrictEqual(grp(groupAgenda, now, [A], [], false), [['Overdue', ['A']], ['Today', []]]);
});

test('T-AGM-4: groupAgenda done recurring row shows only when showDone is true', async () => {
  const { groupAgenda } = await import('../public/js/agendaModel.js');
  const doneR = { ...R, done: true, missed: false, riskState: 'none' };
  assert.deepStrictEqual(grp(groupAgenda, MON, [doneR], [], true), [['Today', ['R']]]);
  assert.deepStrictEqual(grp(groupAgenda, MON, [doneR], [], false), [['Today', []]]);
});

test('T-AGM-5: groupAgenda empty input gives a Today group with no rows', async () => {
  const { groupAgenda } = await import('../public/js/agendaModel.js');
  assert.deepStrictEqual(grp(groupAgenda, MON, [], [], false), [['Today', []]]);
});

test('T-AGM-6: filterAgenda with empty options returns all rows', async () => {
  const { filterAgenda } = await import('../public/js/agendaModel.js');
  assert.deepStrictEqual(filterAgenda(PF, {}).map((r) => r.title),
    ['Write report', 'Review PR', 'Report expenses', 'Gym']);
});

test('T-AGM-7: filterAgenda query REP matches titles case-insensitively', async () => {
  const { filterAgenda } = await import('../public/js/agendaModel.js');
  assert.deepStrictEqual(filterAgenda(PF, { query: 'REP' }).map((r) => r.title),
    ['Write report', 'Report expenses']);
});

test('T-AGM-8: filterAgenda combines priority and deadlineType', async () => {
  const { filterAgenda } = await import('../public/js/agendaModel.js');
  assert.deepStrictEqual(filterAgenda(PF, { priority: 'high', deadlineType: 'hard' }).map((r) => r.title),
    ['Write report']);
});

test('T-AGM-9: filterAgenda deadlineType none keeps rows with no deadline', async () => {
  const { filterAgenda } = await import('../public/js/agendaModel.js');
  assert.deepStrictEqual(filterAgenda(PF, { deadlineType: 'none' }).map((r) => r.title), ['Gym']);
});

test('T-AGM-10: filterAgenda combines projectId and query', async () => {
  const { filterAgenda } = await import('../public/js/agendaModel.js');
  assert.deepStrictEqual(filterAgenda(PF, { projectId: 2, query: 'expenses' }).map((r) => r.title),
    ['Report expenses']);
});

test('T-AGM-11: groupAgenda recurring occurrence missed on an earlier day is Overdue until the day rolls over', async () => {
  const { groupAgenda } = await import('../public/js/agendaModel.js');
  assert.deepStrictEqual(grp(groupAgenda, '2026-10-21T10:30:00.000Z', [W], [], false),
    [['Overdue', ['W']], ['Today', []]]);
  assert.deepStrictEqual(grp(groupAgenda, '2026-10-22T08:00:00.000Z', [W], [], false),
    [['Today', []]]);
});
