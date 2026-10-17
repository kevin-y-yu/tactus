// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 0 oracle for T-PROP — spec §13.5 (lines 844–857), §9.7 (lines 523–537), §13.4 (lines 820, 837–838). Do not edit expectations.
// Open §5 call shapes decided by the Chunk 0 plan: D5, D6, D13
const test = require('node:test');
const assert = require('node:assert');

const P = Date.parse;
const NOW = Date.parse('2026-10-19T08:00:00Z');
const MON9 = Date.parse('2026-10-19T09:00:00Z'), Q = 900000, DAYMS = 86400000;
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

// Generator transcribed from spec §13.5 (lines 844–857). Do not change.
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

test('T-PROP: guarantee and no overlaps over seeds 1..2000, path counts main 1962 repair 20 fallback 18', () => {
  // D13 generator self-check, before any module load.
  const strip = (g) => ({ settings: g.settings, busy: g.busy, tasks: g.tasks.map(({ sortOrder, createdAt, ...r }) => r) });
  assert.deepStrictEqual(strip(generate(6551)), {
    settings: { timezone: 'UTC', workHours: structuredClone(WH), allDayEventsBlock: false, defaultMinBlockMin: 60, breakMin: 15,
      breakIntervalMin: 90, meetingBufferMin: 0, horizonDays: 7, hardDeadlineMarginMin: 0 },
    busy: [],
    tasks: [
      { id: 1, projectId: 1, stageSortOrder: null, priority: 'high', remainingMin: 195, deadline: P('2026-10-22T00:15:00Z'),
        deadlineType: 'hard', startAfter: null, minBlockMin: null, maxBlockMin: null, dontSplit: true, fixedEnd: null },
      { id: 2, projectId: 1, stageSortOrder: null, priority: 'high', remainingMin: 285, deadline: null,
        deadlineType: null, startAfter: null, minBlockMin: null, maxBlockMin: null, dontSplit: false, fixedEnd: null },
      { id: 3, projectId: 1, stageSortOrder: null, priority: 'medium', remainingMin: 345, deadline: P('2026-10-20T17:00:00Z'),
        deadlineType: 'hard', startAfter: null, minBlockMin: null, maxBlockMin: null, dontSplit: false, fixedEnd: null },
    ],
  });
  assert.deepStrictEqual(strip(generate(1415)), {
    settings: { timezone: 'UTC', workHours: structuredClone(WH), allDayEventsBlock: false, defaultMinBlockMin: 60, breakMin: 15,
      breakIntervalMin: 90, meetingBufferMin: 0, horizonDays: 7, hardDeadlineMarginMin: 120 },
    busy: [],
    tasks: [
      { id: 1, projectId: 1, stageSortOrder: null, priority: 'urgent', remainingMin: 240, deadline: null, deadlineType: null,
        startAfter: null, minBlockMin: null, maxBlockMin: null, dontSplit: false, fixedEnd: null },
      { id: 2, projectId: 1, stageSortOrder: null, priority: 'low', remainingMin: 360, deadline: P('2026-10-21T14:15:00Z'),
        deadlineType: 'hard', startAfter: null, minBlockMin: null, maxBlockMin: 120, dontSplit: false, fixedEnd: null },
      { id: 3, projectId: 1, stageSortOrder: null, priority: 'medium', remainingMin: 330, deadline: P('2026-10-22T19:15:00Z'),
        deadlineType: 'hard', startAfter: null, minBlockMin: null, maxBlockMin: null, dontSplit: true, fixedEnd: null },
      { id: 4, projectId: 1, stageSortOrder: null, priority: 'low', remainingMin: 60, deadline: null, deadlineType: null,
        startAfter: null, minBlockMin: null, maxBlockMin: null, dontSplit: false, fixedEnd: null },
      { id: 5, projectId: 1, stageSortOrder: null, priority: 'low', remainingMin: 195, deadline: P('2026-10-23T06:00:00Z'),
        deadlineType: 'hard', startAfter: null, minBlockMin: null, maxBlockMin: null, dontSplit: false, fixedEnd: null },
    ],
  });

  const { schedule, referenceSchedule } = require('../lib/scheduler.js');
  const failures = [], overlaps = [], paths = {};
  for (let seed = 1; seed <= 2000; seed++) {
    const g1 = generate(seed), g2 = generate(seed);
    const ref = referenceSchedule(g1.tasks, g1.busy, g1.settings, NOW);
    const out = schedule(g2.tasks, g2.busy, g2.settings, NOW);
    // (a) no task that the reference meets may be hard-at-risk in the real schedule
    for (const id of ref.metTaskIds) {
      if (out.atRisk.some((a) => a.taskId === id && a.kind === 'hard')) failures.push({ seed, taskId: id });
    }
    // (b) no block overlaps another block, and no block overlaps a busy interval
    const sorted = [...out.blocks].sort((x, y) => x.start - y.start);
    let maxEnd = -Infinity;
    for (const b of sorted) {
      if (b.start < maxEnd) overlaps.push({ seed, type: 'block' });
      maxEnd = Math.max(maxEnd, b.end);
    }
    const g3 = generate(seed);
    for (const b of out.blocks) {
      for (const x of g3.busy) {
        if (b.start < x.end && x.start < b.end) overlaps.push({ seed, type: 'busy' });
      }
    }
    paths[out.meta.path] = (paths[out.meta.path] || 0) + 1;
  }
  assert.deepStrictEqual(failures, []);
  assert.deepStrictEqual(overlaps, []);
  assert.deepStrictEqual(paths, { main: 1962, repair: 20, fallback: 18 });
  // (c) both the repair and the fallback path are exercised
  assert.strictEqual(paths.repair >= 1 && paths.fallback >= 1, true);

  // Named regression (reviewer counterexample, spec §13.4 case 25; this was T-PROP-REG in the plan).
  // D13 parser self-check, before the schedule call.
  assert.deepStrictEqual(B('[1,09:00,10:00],[2,Tue 09:45,2026-10-22T00:15Z]'), [[1, Date.parse('2026-10-19T09:00:00Z'), Date.parse('2026-10-19T10:00:00Z')], [2, Date.parse('2026-10-20T09:45:00Z'), Date.parse('2026-10-22T00:15:00Z')]]);
  const o = schedule([t(1, 600, { priority: 'high' }), t(2, 240, { priority: 'low', ...hard('Tue 15:00') })], [], settings(), NOW);
  assert.deepStrictEqual(o.blocks.map((b) => [b.taskId, b.start, b.end]),
    B('[1,09:00,10:30],[1,10:45,12:15],[1,12:30,14:00],[1,14:15,15:45],[2,16:00,17:00],[2,Tue 09:00,Tue 10:30],[2,Tue 10:45,Tue 12:15],[1,Tue 12:30,Tue 14:00],[1,Tue 14:15,Tue 15:45],[1,Tue 16:00,Tue 17:00]'));
  assert.deepStrictEqual(o.atRisk, []);
  assert.deepStrictEqual(o.tight, []);
  assert.strictEqual(o.meta.path, 'main');
});
