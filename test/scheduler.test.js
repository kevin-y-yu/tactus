// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 0 oracle for T-SCH-1..38, 25b, 26b, 27b — spec §13.4 (lines 785–842), §5.3 (lines 179–201). T-SCH-33..38 and re-seeded 30/31 per DL-33. Do not edit expectations.
// Open §5 call shapes decided by the Chunk 0 plan: D1, D2, D3, D4, D5, D6, D11, D12, D13
// Blocks compared as [taskId,start,end] with start/end epoch ms (D6). atRisk compared on {taskId,kind} plus the fields a case names.
// tight [] and meta.path 'main' unless stated (spec L790–791). 'breaks off' = breakIntervalMin 0 (D11).
// Cases 1–24 run twice: with fixture margin 120 and with margin 0 (D12), asserting identical blocks and atRisk.
const test = require('node:test');
const assert = require('node:assert');

const NOW = Date.parse('2026-10-19T08:00:00Z');
const DAYS = { Mon: '2026-10-19', Tue: '2026-10-20', Wed: '2026-10-21', Thu: '2026-10-22', Fri: '2026-10-23' };
function T(tok) {                       // 'HH:MM' = Monday; 'Tue HH:MM'; or an ISO literal like '2026-10-22T00:15Z'
  tok = tok.trim();
  if (/^\d{4}-/.test(tok)) return Date.parse(tok);
  const m = /^(?:(Mon|Tue|Wed|Thu|Fri) )?(\d\d):(\d\d)$/.exec(tok);
  if (!m) throw new Error('bad time token: ' + tok);
  return Date.parse(`${DAYS[m[1] || 'Mon']}T${m[2]}:${m[3]}:00Z`);
}
function B(text) {                      // parses the spec's literal block lists: '[1,09:00,10:00],[1,Tue 09:00,Tue 10:00]'
  const out = [...text.matchAll(/\[(\d+),([^,\]]+),([^\]]+)\]/g)].map((m) => [Number(m[1]), T(m[2]), T(m[3])]);
  if (out.length !== (text.match(/\[/g) || []).length) throw new Error('unparsed block in: ' + text);
  return out;
}
const WH = { '0': [], '1': [['09:00', '17:00']], '2': [['09:00', '17:00']], '3': [['09:00', '17:00']],
             '4': [['09:00', '17:00']], '5': [['09:00', '17:00']], '6': [] };
const settings = (over = {}) => ({ timezone: 'UTC', workHours: structuredClone(WH), defaultMinBlockMin: 60, breakMin: 15,
  breakIntervalMin: 90, meetingBufferMin: 15, horizonDays: 7, allDayEventsBlock: false, hardDeadlineMarginMin: 120, ...over });
const DEF = { projectId: 1, stageSortOrder: null, priority: 'medium', deadline: null, deadlineType: null, startAfter: null,
  minBlockMin: null, maxBlockMin: null, dontSplit: false, fixedEnd: null, sortOrder: 0, createdAt: 0 };
const t = (id, remainingMin, extra = {}) => ({ ...DEF, id, remainingMin, ...extra });
const hard = (x) => ({ deadline: T(x), deadlineType: 'hard' });
const soft = (x) => ({ deadline: T(x), deadlineType: 'soft' });
const ev = (a, b) => ({ start: T(a), end: T(b), kind: 'event' });
function run(tasks, busy = [], over = {}, now = NOW) {
  const { schedule } = require('../lib/scheduler.js');
  return schedule(structuredClone(tasks), structuredClone(busy), settings(over), now);
}
const blocksOf = (o) => o.blocks.map((b) => [b.taskId, b.start, b.end]);
const riskOf = (o, extra = []) => o.atRisk.map((a) => Object.fromEntries(['taskId', 'kind', ...extra].map((k) => [k, a[k]])));
const tightOf = (o) => o.tight.map((x) => ({ taskId: x.taskId, slackMin: x.slackMin }));
function expectOut(o, { blocks, atRisk = [], extra = [], tight = [], path = 'main' }) {
  assert.deepStrictEqual(blocksOf(o), blocks);
  assert.deepStrictEqual(riskOf(o, extra), atRisk);
  assert.deepStrictEqual(tightOf(o), tight);
  assert.strictEqual(o.meta.path, path);
}
function expectBoth(tasks, busy, over, now, exp) {           // cases 1–24 (D12)
  expectOut(run(tasks, busy, over, now), exp);
  const o0 = run(tasks, busy, { ...over, hardDeadlineMarginMin: 0 }, now);
  assert.deepStrictEqual(blocksOf(o0), exp.blocks);
  assert.deepStrictEqual(riskOf(o0, exp.extra || []), exp.atRisk || []);
  return o0;
}

test('T-SCH-1: single 60 min task gets one block', () => {
  // D13 parser self-check, before any module load
  assert.deepStrictEqual(B('[1,09:00,10:00],[2,Tue 09:45,2026-10-22T00:15Z]'), [[1, Date.parse('2026-10-19T09:00:00Z'), Date.parse('2026-10-19T10:00:00Z')], [2, Date.parse('2026-10-20T09:45:00Z'), Date.parse('2026-10-22T00:15:00Z')]]);
  expectBoth([t(1, 60)], [], {}, NOW, { blocks: B('[1,09:00,10:00]'), atRisk: [] });
});

test('T-SCH-2: 180 min task splits around the break', () => {
  expectBoth([t(1, 180)], [], {}, NOW, { blocks: B('[1,09:00,10:30],[1,10:45,12:15]'), atRisk: [] });
});

test('T-SCH-3: high dontSplit task is placed before medium task', () => {
  expectBoth([t(1, 120, { priority: 'high', dontSplit: true }), t(2, 30)], [], {}, NOW,
    { blocks: B('[1,09:00,11:00],[2,11:15,11:45]'), atRisk: [] });
});

test('T-SCH-4: stage sort order decides between same-project tasks', () => {
  expectBoth([t(1, 60, { priority: 'low', stageSortOrder: 0 }), t(2, 60, { priority: 'high', stageSortOrder: 1 })], [], {}, NOW,
    { blocks: B('[1,09:00,10:00],[2,10:15,11:15]'), atRisk: [] });
});

test('T-SCH-5: startAfter delays the block', () => {
  expectBoth([t(1, 60, { startAfter: T('14:00') })], [], {}, NOW, { blocks: B('[1,14:00,15:00]'), atRisk: [] });
});

test('T-SCH-6: fixedEnd pins task to end at 14:00 around a work busy interval', () => {
  const busy = [{ start: T('13:00'), end: T('14:00'), kind: 'work' }];
  expectBoth([t(1, 30, { fixedEnd: T('14:00') }), t(2, 60, { priority: 'high' })], busy, {}, NOW,
    { blocks: B('[2,09:00,10:00],[1,10:00,10:30]'), atRisk: [] });
});

test('T-SCH-7: min and max block sizes split the task', () => {
  expectBoth([t(1, 120, { minBlockMin: 30, maxBlockMin: 45 })], [], {}, NOW,
    { blocks: B('[1,09:00,09:45],[1,10:00,10:45],[1,11:00,11:30]'), atRisk: [] });
});

test('T-SCH-8: breaks off gives one continuous block', () => {
  expectBoth([t(1, 180)], [], { breakIntervalMin: 0 }, NOW, { blocks: B('[1,09:00,12:00]'), atRisk: [] });
});

test('T-SCH-9: all-day busy Monday pushes block to Tuesday', () => {
  const busy = [{ start: T('00:00'), end: T('Tue 00:00'), kind: 'allday' }];
  expectBoth([t(1, 60)], busy, {}, NOW, { blocks: B('[1,Tue 09:00,Tue 10:00]'), atRisk: [] });
});

test('T-SCH-10: timezone Europe/London shifts work hours to UTC', () => {
  expectBoth([t(1, 60)], [], { timezone: 'Europe/London' }, Date.parse('2026-10-23T07:00:00Z'),
    { blocks: [[1, Date.parse('2026-10-23T08:00:00Z'), Date.parse('2026-10-23T09:00:00Z')]], atRisk: [] });
});

test('T-SCH-11: soft deadline does not change order of a free task', () => {
  expectBoth([t(1, 60), t(2, 60, soft('Tue 17:00'))], [], {}, NOW,
    { blocks: B('[2,09:00,10:00],[1,10:15,11:15]'), atRisk: [] });
});

test('T-SCH-12: event blocks work time and buffer', () => {
  expectBoth([t(1, 180)], [ev('10:00', '11:00')], {}, NOW, { blocks: B('[1,11:15,12:45],[1,13:00,14:30]'), atRisk: [] });
});

test('T-SCH-13: event blocking with minBlockMin 30', () => {
  expectBoth([t(1, 180, { minBlockMin: 30 })], [ev('10:00', '11:00')], {}, NOW,
    { blocks: B('[1,09:00,09:45],[1,11:15,12:45],[1,13:00,13:45]'), atRisk: [] });
});

test('T-SCH-14: short task gets short block', () => {
  expectBoth([t(1, 30)], [], {}, NOW, { blocks: B('[1,09:00,09:30]'), atRisk: [] });
});

test('T-SCH-15: breaks off with event leaves Monday then Tuesday', () => {
  expectBoth([t(1, 150)], [ev('11:15', '17:00')], { breakIntervalMin: 0 }, NOW,
    { blocks: B('[1,09:00,10:30],[1,Tue 09:00,Tue 10:00]'), atRisk: [] });
});

test('T-SCH-16: breaks off gives one run without break', () => {
  expectBoth([t(1, 150)], [], { breakIntervalMin: 0 }, NOW, { blocks: B('[1,09:00,11:30]'), atRisk: [] });
});

test('T-SCH-17: high priority task takes precedence after event', () => {
  expectBoth([t(1, 180, { priority: 'high' }), t(2, 30, { priority: 'low' })], [ev('10:00', '11:00')], {}, NOW,
    { blocks: B('[2,09:00,09:30],[1,11:15,12:45],[1,13:00,14:30]'), atRisk: [] });
});

test('T-SCH-18: hard deadline task is placed before soft deadline task', () => {
  expectBoth([t(1, 120, { priority: 'high', ...hard('Fri 17:00') }), t(2, 60, { priority: 'low', ...soft('12:00') })], [], {}, NOW,
    { blocks: B('[1,09:00,10:00],[1,10:15,11:15],[2,11:30,12:30]'), atRisk: [{ taskId: 2, kind: 'soft' }] });
});

test('T-SCH-19: tight hard deadline reports slack 60 at fixture margin', () => {
  const o0 = expectBoth([t(1, 480, { priority: 'high' }), t(2, 60, { priority: 'low', ...hard('11:00') })], [], {}, NOW,
    { blocks: B('[2,09:00,10:00],[1,10:15,11:45],[1,12:00,13:30],[1,13:45,15:15],[1,15:30,17:00],[1,Tue 09:00,Tue 10:00],[1,Tue 10:15,Tue 11:15]'),
      atRisk: [], tight: [{ taskId: 2, slackMin: 60 }] });
  assert.deepStrictEqual(tightOf(o0), []);
});

test('T-SCH-20: two hard deadlines both at risk', () => {
  expectBoth([t(1, 240, { priority: 'low', ...hard('11:00') }), t(2, 60, hard('12:00')), t(3, 60, { priority: 'high' })], [], {}, NOW,
    { blocks: B('[1,09:00,10:30],[1,10:45,12:15],[1,12:30,13:30],[2,13:45,14:45],[3,15:00,16:00]'),
      atRisk: [{ taskId: 1, kind: 'hard' }, { taskId: 2, kind: 'hard' }] });
});

test('T-SCH-21: unschedulable dontSplit hard task reports unscheduledMin', () => {
  expectBoth([t(1, 600, { dontSplit: true, ...hard('Wed 17:00') })], [], {}, NOW,
    { blocks: [], atRisk: [{ taskId: 1, kind: 'hard', unscheduledMin: 600 }], extra: ['unscheduledMin'] });
});

test('T-SCH-22: hard deadline in the past is overdue', () => {
  expectBoth([t(1, 60, hard('2026-10-18T17:00Z'))], [], {}, NOW,
    { blocks: B('[1,09:00,10:00]'), atRisk: [{ taskId: 1, kind: 'hard', overdue: true }], extra: ['overdue'] });
});

test('T-SCH-23: unschedulable dontSplit task without deadline is unscheduled', () => {
  expectBoth([t(1, 600, { dontSplit: true })], [], {}, NOW, { blocks: [], atRisk: [{ taskId: 1, kind: 'unscheduled' }] });
});

test('T-SCH-24: determinism under reversed input and repeated runs', () => {
  const sched = (tasks, busy) => run(tasks, busy);
  const rev = (a) => [...a].reverse();
  const tasks = [t(1, 180, { priority: 'high' }), t(2, 30, { priority: 'low' }), t(3, 120, { priority: 'high', ...hard('Fri 17:00') }),
    t(4, 60, { priority: 'low', ...soft('12:00') }), t(5, 60, { priority: 'low', stageSortOrder: 0 }), t(6, 60, { priority: 'high', stageSortOrder: 1 })];
  const busy = [ev('10:00', '11:00')];
  expectBoth(tasks, busy, {}, NOW,
    { blocks: B('[2,09:00,09:30],[3,11:15,12:15],[3,12:30,13:30],[1,13:45,15:15],[1,15:30,17:00],[4,Tue 09:00,Tue 10:00],[5,Tue 10:15,Tue 11:15],[6,Tue 11:30,Tue 12:30]'),
      atRisk: [{ taskId: 4, kind: 'soft' }] });
  assert.deepStrictEqual(sched(rev(tasks), rev(busy)), sched(tasks, busy));
  const a = JSON.stringify(sched(tasks, busy));
  const b = JSON.stringify(sched(tasks, busy));
  const c = JSON.stringify(sched(tasks, busy));
  assert.strictEqual(b, a);
  assert.strictEqual(c, a);
});

test('T-SCH-25: reviewer counterexample with default margin', () => {
  expectOut(run([t(1, 600, { priority: 'high' }), t(2, 240, { priority: 'low', ...hard('Tue 15:00') })]), {
    blocks: B('[1,09:00,10:30],[1,10:45,12:15],[1,12:30,14:00],[1,14:15,15:45],[2,16:00,17:00],[2,Tue 09:00,Tue 10:30],[2,Tue 10:45,Tue 12:15],[1,Tue 12:30,Tue 14:00],[1,Tue 14:15,Tue 15:45],[1,Tue 16:00,Tue 17:00]'),
    atRisk: [], tight: [] });
});

test('T-SCH-25b: reviewer counterexample with margin 0', () => {
  expectOut(run([t(1, 600, { priority: 'high' }), t(2, 240, { priority: 'low', ...hard('Tue 15:00') })], [], { hardDeadlineMarginMin: 0 }), {
    blocks: B('[1,09:00,10:30],[1,10:45,12:15],[1,12:30,14:00],[1,14:15,15:45],[1,16:00,17:00],[2,Tue 09:00,Tue 10:30],[2,Tue 10:45,Tue 12:15],[2,Tue 12:30,Tue 13:30],[1,Tue 13:45,Tue 15:15],[1,Tue 15:30,Tue 17:00]'),
    atRisk: [], tight: [], path: 'main' });
});

test('T-SCH-26: late overtake at window entry', () => {
  expectOut(run([t(1, 480, { priority: 'high' }), t(2, 480, { priority: 'high' }), t(3, 480, { priority: 'high' }), t(4, 60, soft('Wed 17:00'))]), {
    blocks: B('[1,09:00,10:30],[1,10:45,12:15],[1,12:30,14:00],[1,14:15,15:45],[1,16:00,17:00],[4,Tue 09:00,Tue 10:00],[1,Tue 10:15,Tue 11:15],[2,Tue 11:30,Tue 13:00],[2,Tue 13:15,Tue 14:45],[2,Tue 15:00,Tue 16:30],[2,Wed 09:00,Wed 10:30],[2,Wed 10:45,Wed 11:45],[2,Wed 12:00,Wed 13:00],[3,Wed 13:15,Wed 14:45],[3,Wed 15:00,Wed 16:30],[3,Thu 09:00,Thu 10:30],[3,Thu 10:45,Thu 12:15],[3,Thu 12:30,Thu 13:30],[3,Thu 13:45,Thu 14:45]'),
    atRisk: [], tight: [] });
});

test('T-SCH-26b: medium soft deadline tomorrow beats high stream', () => {
  expectOut(run([t(1, 480, { priority: 'high' }), t(2, 480, { priority: 'high' }), t(3, 60, soft('Tue 17:00'))]), {
    blocks: B('[3,09:00,10:00],[1,10:15,11:45],[1,12:00,13:30],[1,13:45,15:15],[1,15:30,17:00],[1,Tue 09:00,Tue 10:00],[1,Tue 10:15,Tue 11:15],[2,Tue 11:30,Tue 13:00],[2,Tue 13:15,Tue 14:45],[2,Tue 15:00,Tue 16:30],[2,Wed 09:00,Wed 10:30],[2,Wed 10:45,Wed 11:45],[2,Wed 12:00,Wed 13:00]'),
    atRisk: [] });
});

test('T-SCH-27: low soft never beats high', () => {
  expectOut(run([t(1, 480, { priority: 'high' }), t(2, 480, { priority: 'high' }), t(3, 60, { priority: 'low', ...soft('Tue 12:00') })]), {
    blocks: B('[1,09:00,10:30],[1,10:45,12:15],[1,12:30,14:00],[1,14:15,15:45],[1,16:00,17:00],[1,Tue 09:00,Tue 10:00],[2,Tue 10:15,Tue 11:45],[2,Tue 12:00,Tue 13:30],[2,Tue 13:45,Tue 15:15],[2,Tue 15:30,Tue 17:00],[2,Wed 09:00,Wed 10:00],[2,Wed 10:15,Wed 11:15],[3,Wed 11:30,Wed 12:30]'),
    atRisk: [{ taskId: 3, kind: 'soft' }] });
});

test('T-SCH-27b: low soft never beats urgent', () => {
  expectOut(run([t(1, 480, { priority: 'urgent' }), t(2, 60, { priority: 'low', ...soft('12:00') })]), {
    blocks: B('[1,09:00,10:30],[1,10:45,12:15],[1,12:30,14:00],[1,14:15,15:45],[1,16:00,17:00],[1,Tue 09:00,Tue 10:00],[2,Tue 10:15,Tue 11:15]'),
    atRisk: [{ taskId: 2, kind: 'soft' }] });
});

test('T-SCH-28: one-level cap on urgent stream', () => {
  expectOut(run([t(1, 960, { priority: 'urgent' }), t(2, 60, soft('Tue 12:00'))]), {
    blocks: B('[1,09:00,10:30],[1,10:45,12:15],[1,12:30,14:00],[1,14:15,15:45],[1,16:00,17:00],[1,Tue 09:00,Tue 10:30],[1,Tue 10:45,Tue 12:15],[1,Tue 12:30,Tue 14:00],[1,Tue 14:15,Tue 15:45],[1,Tue 16:00,Tue 17:00],[1,Wed 09:00,Wed 10:00],[1,Wed 10:15,Wed 11:15],[2,Wed 11:30,Wed 12:30]'),
    atRisk: [{ taskId: 2, kind: 'soft' }] });
});

test('T-SCH-29: tight hard deadline has slack 0', () => {
  expectOut(run([t(1, 60, hard('11:00'))], [ev('08:00', '09:45')]), {
    blocks: B('[1,10:00,11:00]'), atRisk: [], tight: [{ taskId: 1, slackMin: 0 }] });
});

test('T-SCH-30: repair path with seed 15523 inputs', () => {
  const o = run([t(1, 315, { priority: 'urgent', ...hard('16:45') }), t(2, 360, { priority: 'high', ...hard('2026-10-21T07:15Z') }),
    t(3, 135, { priority: 'urgent', minBlockMin: 45, ...hard('2026-10-22T10:45Z') }),
    t(4, 120, { priority: 'urgent', maxBlockMin: 90, ...soft('2026-10-20T07:15Z') })],
    [], { defaultMinBlockMin: 30, breakIntervalMin: 120, meetingBufferMin: 0, hardDeadlineMarginMin: 0 });
  expectOut(o, {
    blocks: B('[1,09:00,11:00],[1,11:15,13:15],[1,13:30,14:45],[2,14:45,15:30],[2,15:45,17:00],[2,Tue 09:00,Tue 11:00],[2,Tue 11:15,Tue 13:15],[4,Tue 13:30,Tue 15:00],[4,Tue 15:15,Tue 15:45],[3,Tue 15:45,Tue 17:00],[3,Wed 09:00,Wed 10:00]'),
    atRisk: [{ taskId: 4, kind: 'soft' }], path: 'repair' });
  assert.deepStrictEqual({ path: o.meta.path, repairPasses: o.meta.repairPasses }, { path: 'repair', repairPasses: 2 });
});

test('T-SCH-31: fallback path with seed 1958 inputs', () => {
  const o = run([t(1, 180, { minBlockMin: 15 }), t(2, 330, { priority: 'urgent', maxBlockMin: 60, ...hard('2026-10-19T23:45Z') })],
    [], { defaultMinBlockMin: 30, hardDeadlineMarginMin: 0 });
  expectOut(o, {
    blocks: B('[2,09:00,10:00],[1,10:00,10:15],[2,10:15,11:15],[2,11:30,12:30],[1,12:30,12:45],[2,12:45,13:45],[2,14:00,15:00],[1,15:00,15:15],[2,15:15,15:45],[1,16:00,17:00],[1,Tue 09:00,Tue 10:15]'),
    atRisk: [], path: 'fallback' });
  assert.deepStrictEqual({ path: o.meta.path, repairPasses: o.meta.repairPasses }, { path: 'fallback', repairPasses: 3 });
});

test('T-SCH-32: pinned block end after deadline is hard at risk', () => {
  const busy = [{ start: T('Wed 13:00'), end: T('Wed 14:00'), kind: 'work' }];
  const o = run([t(1, 30, { ...hard('Wed 12:00'), fixedEnd: T('Wed 14:00') })], busy);
  expectOut(o, { blocks: B('[1,09:00,09:30]'), atRisk: [{ taskId: 1, kind: 'hard' }] });
  assert.strictEqual(o.atRisk[0].plannedEnd, T('Wed 14:00'));
});

test('T-SCH-33: lookahead splits 195 as 75, 60, 60 instead of stranding 105', () => {
  expectBoth([t(1, 195)], [], {}, NOW, { blocks: B('[1,09:00,10:15],[1,10:30,11:30],[1,11:45,12:45]'), atRisk: [] });
});

test('T-SCH-34: greedy first chunk kept when safe, lookahead on the second', () => {
  expectBoth([t(1, 285)], [], {}, NOW,
    { blocks: B('[1,09:00,10:30],[1,10:45,12:00],[1,12:15,13:15],[1,13:30,14:30]'), atRisk: [] });
});

test('T-SCH-35: lookahead shortens a chunk truncated by a 75 min window', () => {
  expectBoth([t(1, 180)], [ev('10:30', '11:00')], {}, NOW,
    { blocks: B('[1,09:00,10:00],[1,11:15,12:15],[1,12:30,13:30]'), atRisk: [] });
});

test('T-SCH-36: lookahead declines a run-capped slot', () => {
  const busy = [{ start: T('09:00'), end: T('09:30'), kind: 'work' }];
  expectBoth([t(1, 165)], busy, {}, NOW, { blocks: B('[1,09:45,11:15],[1,11:30,12:45]'), atRisk: [] });
});

test('T-SCH-37: lookahead with maxBlockMin and breaks off', () => {
  expectBoth([t(1, 195, { maxBlockMin: 90 })], [], { breakIntervalMin: 0 }, NOW,
    { blocks: B('[1,09:00,10:15],[1,10:30,11:30],[1,11:45,12:45]'), atRisk: [] });
});

test('T-SCH-38: remainder unplaceable from the start keeps greedy', () => {
  expectBoth([t(1, 195, { minBlockMin: 90 })], [], {}, NOW,
    { blocks: B('[1,09:00,10:30]'), atRisk: [{ taskId: 1, kind: 'unscheduled', unscheduledMin: 105 }], extra: ['unscheduledMin'] });
});
