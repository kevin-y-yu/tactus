// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Chunk 16 oracle — spec-v2 §R1 (V2-D2..V2-D5), user ruling UR-1 (§V11).
// T-V2-MOVE-1..5 (pure planDoneMove), T-V2-DONE-1..10 (API, v1 serve() fixture: UTC, all-day hours, breaks off,
// clock C0 = 2026-10-19T10:00Z, D = 2026-10-19), T-V2-PRUNE-1 (raw SQL, like T-DATA-3).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const { planDoneMove } = require('../lib/doneMove.js');

const C0 = Date.parse('2026-10-19T10:00:00Z');
const D0 = Date.parse('2026-10-19T00:00:00Z');
const D = '2026-10-19', D1 = '2026-10-20';
const MINUTE = 60000, DAY = 86400000;
const ALL = [['00:00', '24:00']];
const WH24 = { '0': ALL, '1': ALL, '2': ALL, '3': ALL, '4': ALL, '5': ALL, '6': ALL };
const FIXTURE = { timezone: 'UTC', workHours: WH24, breakIntervalMin: 0 };
const iso = (v) => new Date(v).toISOString();
const at = (hm, date = D) => iso(`${date}T${hm}Z`);          // 'HH:MM' or 'HH:MM:SS' on date (UTC) -> ISO string
const ms = (hm, date = D) => Date.parse(`${date}T${hm}Z`);
const blk = (id, start, end, extra = {}) => ({ id, start, end, completed: false, ...extra });
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tactus-test-'));

// ---------- T-V2-MOVE (pure) ----------

test('T-V2-MOVE-1: open block more than 30 min from done is moved to end at now', () => {
  assert.deepStrictEqual(planDoneMove([blk(1, at('14:00'), at('16:00'))], ms('14:20')),
    { openIds: [1], moves: [{ id: 1, start: at('12:20'), end: at('14:20') }] });
});

test('T-V2-MOVE-2: planned completion within 30 min (and exactly 30 min) keeps times', () => {
  assert.deepStrictEqual(planDoneMove([blk(1, at('14:00'), at('14:40'))], ms('14:20')), { openIds: [1], moves: [] });
  assert.deepStrictEqual(planDoneMove([blk(1, at('14:00'), at('14:50'))], ms('14:20')), { openIds: [1], moves: [] });
});

test('T-V2-MOVE-3: completed and missed blocks untouched; open blocks packed, last ends at floored now', () => {
  const blocks = [
    blk(1, at('09:00'), at('10:00'), { completed: true }),
    blk(2, at('10:00'), at('11:00')),
    blk(3, at('11:30'), at('12:30')),
    blk(4, at('13:00'), at('13:45'), { pinned: true }),
  ];
  assert.deepStrictEqual(planDoneMove(blocks, ms('11:10:30')), {
    openIds: [3, 4],
    moves: [{ id: 3, start: at('09:25'), end: at('10:25') }, { id: 4, start: at('10:25'), end: at('11:10') }],
  });
});

test('T-V2-MOVE-4: future blocks are sorted chronologically and the gap is removed', () => {
  const blocks = [blk(5, at('10:00', D1), at('11:00', D1)), blk(6, at('09:00', D1), at('09:30', D1))];
  assert.deepStrictEqual(planDoneMove(blocks, ms('10:00')), {
    openIds: [6, 5],
    moves: [{ id: 6, start: at('08:30'), end: at('09:00') }, { id: 5, start: at('09:00'), end: at('10:00') }],
  });
});

test('T-V2-MOVE-5: only completed and missed blocks -> nothing open, nothing moved', () => {
  const blocks = [blk(1, at('08:00'), at('09:00'), { completed: true }), blk(2, at('09:00'), at('10:00'))];
  assert.deepStrictEqual(planDoneMove(blocks, ms('10:00')), { openIds: [], moves: [] });
});

// ---------- API fixture (copied verbatim from test/api.test.js serve()) ----------

async function serve(t, created, tmp, setupHeaders = {}) {
  const server = created.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    created.scheduleService.stop(); created.calendarSync.stop(); await created.repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const put = await api('PUT', '/api/settings', FIXTURE, setupHeaders);
  assert.strictEqual(put.status, 200);
  return api;
}
async function mkApp(t) {
  const { createApp } = require('../lib/app.js');
  const { loadConfig } = require('../lib/config.js');
  const tmp = mkTmp();
  const clk = { now: C0 };
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clk.now });
  const api = await serve(t, created, tmp);
  return { api, clk };
}
const calUrl = (from, to) => `/api/calendar?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}`;
const sortBlocks = (bl) => [...bl].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id - b.id);
const postTask = async (api, body) => { const r = await api('POST', '/api/tasks', body); assert.strictEqual(r.status, 201); return r.body.id; };
const REC60 = { title: 'Daily hour', frequency: 'daily', daysOfWeek: [], dayOfMonth: null, durationMin: 60, windowStart: null,
  windowEnd: null, priority: 'medium', startDate: D, endDate: null, projectId: null, active: true };
const postRec = async (api) => { const r = await api('POST', '/api/recurring', REC60); assert.strictEqual(r.status, 201); return r.body.id; };
// [id, start, end, completed] of every block of a task (GET /tasks/:id), sorted by start then id
const taskBlocks = async (api, id) => sortBlocks((await api('GET', `/api/tasks/${id}`)).body.blocks)
  .map((b) => [b.id, iso(b.start), iso(b.end), b.completed]);
// [id, start, end, completed, done] of a task's blocks returned by GET /calendar for day D
const calTaskBlocks = async (api, id) => sortBlocks((await api('GET', calUrl(D0, D0 + DAY))).body.blocks.filter((b) => b.taskId === id))
  .map((b) => [b.id, iso(b.start), iso(b.end), b.completed, b.done]);
// [id, start, end, completed, done] of one occurrence's blocks returned by GET /calendar for D-1 .. D+3
const occBlocks = async (api, rid, date) => sortBlocks((await api('GET', calUrl(D0 - DAY, D0 + 3 * DAY))).body.blocks
  .filter((b) => b.kind === 'recurring' && b.recurringId === rid && b.occurrenceDate === date))
  .map((b) => [b.id, iso(b.start), iso(b.end), b.completed, b.done]);
const markDone = async (api, id) => assert.strictEqual((await api('PATCH', `/api/tasks/${id}`, { status: 'done' })).status, 200);

// DONE-1 setup, reused by DONE-4 and DONE-5: task 120 min -> one block 10:00-12:00; clock 10:20; PATCH done.
async function doneOne(t) {
  const { api, clk } = await mkApp(t);
  const id = await postTask(api, { title: 'Two hours', durationMin: 120 });
  const before = await taskBlocks(api, id);
  assert.deepStrictEqual(before.map((b) => b.slice(1)), [[at('10:00'), at('12:00'), false]]);
  clk.now = C0 + 20 * MINUTE;
  await markDone(api, id);
  return { api, clk, id, bid: before[0][0] };
}

// ---------- T-V2-DONE (API) ----------

test('T-V2-DONE-1: done 100 min before planned end moves the block to end at now, same id, completed, done on calendar', async (t) => {
  const { api, id, bid } = await doneOne(t);
  assert.deepStrictEqual(await taskBlocks(api, id), [[bid, at('08:20'), at('10:20'), true]]);
  assert.deepStrictEqual(await calTaskBlocks(api, id), [[bid, at('08:20'), at('10:20'), true, true]]);
});

test('T-V2-DONE-2: done within 30 min of planned end keeps the block, completed', async (t) => {
  const { api, clk } = await mkApp(t);
  const id = await postTask(api, { title: 'One hour', durationMin: 60 });
  const before = await taskBlocks(api, id);
  assert.deepStrictEqual(before.map((b) => b.slice(1)), [[at('10:00'), at('11:00'), false]]);
  clk.now = C0 + 35 * MINUTE;
  await markDone(api, id);
  assert.deepStrictEqual(await taskBlocks(api, id), [[before[0][0], at('10:00'), at('11:00'), true]]);
});

test('T-V2-DONE-3: two blocks are packed back-to-back ending at now, same ids', async (t) => {
  const { api, clk } = await mkApp(t);
  const id = await postTask(api, { title: 'Split', durationMin: 120, maxBlockMin: 60 });
  const before = await taskBlocks(api, id);
  assert.deepStrictEqual(before.map((b) => b.slice(1)), [[at('10:00'), at('11:00'), false], [at('11:15'), at('12:15'), false]]);
  clk.now = C0 + 20 * MINUTE;
  await markDone(api, id);
  assert.deepStrictEqual(await taskBlocks(api, id), [
    [before[0][0], at('08:20'), at('09:20'), true],
    [before[1][0], at('09:20'), at('10:20'), true],
  ]);
});

test('T-V2-DONE-4: reopen keeps moved block and credit; un-completing it makes it missed and re-plans from now', async (t) => {
  const { api, id, bid } = await doneOne(t);
  assert.strictEqual((await api('PATCH', `/api/tasks/${id}`, { status: 'todo' })).status, 200);
  let task = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(task.task.status, 'todo');
  assert.strictEqual(task.creditedMin, 120);
  assert.deepStrictEqual(await taskBlocks(api, id), [[bid, at('08:20'), at('10:20'), true]]);
  assert.strictEqual((await api('PATCH', `/api/blocks/${bid}`, { completed: false })).status, 200);
  task = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(task.creditedMin, 0);
  assert.deepStrictEqual(sortBlocks(task.blocks).map((b) => [b.id === bid, iso(b.start), iso(b.end), b.completed, b.missed]), [
    [true, at('08:20'), at('10:20'), false, true],
    [false, at('10:30'), at('12:30'), false, false],
  ]);
});

test('T-V2-DONE-5: blocks of a done task survive pruning after 40 days', async (t) => {
  const { api, clk, id, bid } = await doneOne(t);
  clk.now = C0 + 20 * MINUTE + 40 * DAY;
  assert.strictEqual((await api('POST', '/api/schedule/run')).status, 200);
  assert.deepStrictEqual(await taskBlocks(api, id), [[bid, at('08:20'), at('10:20'), true]]);
});

test('T-V2-DONE-6: occurrence done moves its block to end at now, not completed, done; survives a run', async (t) => {
  const { api, clk } = await mkApp(t);
  const rid = await postRec(api);
  const before = await occBlocks(api, rid, D);
  assert.deepStrictEqual(before.map((b) => b.slice(1)), [[at('10:00'), at('11:00'), false, false]]);
  clk.now = C0 + 20 * MINUTE;
  assert.strictEqual((await api('POST', `/api/recurring/${rid}/occurrences/${D}/done`)).status, 204);
  const expected = [[before[0][0], at('09:20'), at('10:20'), false, true]];
  assert.deepStrictEqual(await occBlocks(api, rid, D), expected);
  assert.strictEqual((await api('POST', '/api/schedule/run')).status, 200);
  assert.deepStrictEqual(await occBlocks(api, rid, D), expected);
});

test('T-V2-DONE-7: a task planned for tomorrow marked done lands today ending at now', async (t) => {
  const { api } = await mkApp(t);
  const id = await postTask(api, { title: 'Tomorrow', durationMin: 60, startAfter: '2026-10-20T10:00:00.000Z' });
  const before = await taskBlocks(api, id);
  assert.deepStrictEqual(before.map((b) => b.slice(1)), [[at('10:00', D1), at('11:00', D1), false]]);
  await markDone(api, id);
  assert.deepStrictEqual(await taskBlocks(api, id), [[before[0][0], at('09:00'), at('10:00'), true]]);
  assert.deepStrictEqual(await calTaskBlocks(api, id), [[before[0][0], at('09:00'), at('10:00'), true, true]]);
});

test('T-V2-DONE-8: a missed block stays put and uncompleted; the moved block may overlap it', async (t) => {
  const { api, clk } = await mkApp(t);
  const id = await postTask(api, { title: 'Split', durationMin: 120, maxBlockMin: 60 });
  const before = await taskBlocks(api, id);
  assert.deepStrictEqual(before.map((b) => b.slice(1)), [[at('10:00'), at('11:00'), false], [at('11:15'), at('12:15'), false]]);
  clk.now = C0 + 65 * MINUTE;
  await markDone(api, id);
  assert.deepStrictEqual(await taskBlocks(api, id), [
    [before[0][0], at('10:00'), at('11:00'), false],
    [before[1][0], at('10:05'), at('11:05'), true],
  ]);
});

test('T-V2-DONE-9: a future block ending exactly 30 min after now keeps its times', async (t) => {
  const { api } = await mkApp(t);
  const id = await postTask(api, { title: 'Quarter', durationMin: 15, startAfter: '2026-10-19T10:15:00.000Z' });
  const before = await taskBlocks(api, id);
  assert.deepStrictEqual(before.map((b) => b.slice(1)), [[at('10:15'), at('10:30'), false]]);
  await markDone(api, id);
  assert.deepStrictEqual(await taskBlocks(api, id), [[before[0][0], at('10:15'), at('10:30'), true]]);
});

test('T-V2-DONE-10: a future occurrence marked done lands today ending at now', async (t) => {
  const { api } = await mkApp(t);
  const rid = await postRec(api);
  const before = await occBlocks(api, rid, D1);
  // Observed pass-2 placement of the D+1 occurrence (first free work time of D+1, as in T-API-18).
  assert.deepStrictEqual(before.map((b) => b.slice(1)), [[at('00:00', D1), at('01:00', D1), false, false]]);
  assert.strictEqual((await api('POST', `/api/recurring/${rid}/occurrences/${D1}/done`)).status, 204);
  assert.deepStrictEqual(await occBlocks(api, rid, D1), [[before[0][0], at('09:00'), at('10:00'), false, true]]);
});

// ---------- T-V2-PRUNE (raw SQL, like T-DATA-3) ----------

test('T-V2-PRUNE-1: pruning deletes only missed todo-task blocks and skipped occurrence blocks', async (t) => {
  const { openDb } = require('../lib/db.js');
  const { DatabaseSync } = require('node:sqlite');
  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'tactus.db');
  const repo = await openDb(dbPath);
  const raw = new DatabaseSync(dbPath);
  t.after(async () => { raw.close(); await repo.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const TS = '2026-10-01T00:00:00.000Z';
  raw.prepare(`INSERT INTO tasks (id, project_id, title, duration_min, status, created_at, updated_at) VALUES (10,NULL,'todo task',60,'todo',?,?)`).run(TS, TS);
  raw.prepare(`INSERT INTO tasks (id, project_id, title, duration_min, status, created_at, updated_at) VALUES (11,NULL,'done task',60,'done',?,?)`).run(TS, TS);
  raw.prepare(`INSERT INTO recurring (id, title, frequency, duration_min, start_date, created_at, updated_at) VALUES (20,'Daily','daily',30,'2026-09-01',?,?)`).run(TS, TS);
  raw.prepare(`INSERT INTO recurring_done (recurring_id, occurrence_date, completed_at) VALUES (20,'2026-09-01',?)`).run(TS);
  const ins = raw.prepare(`INSERT INTO blocks (id, task_id, recurring_id, occurrence_date, start, "end", pinned, completed) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run(201, 11, null, null, '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', 0, 0);       // done task, uncompleted -> kept
  ins.run(202, 11, null, null, '2026-09-01T12:00:00.000Z', '2026-09-01T13:00:00.000Z', 0, 1);       // done task, completed -> kept
  ins.run(203, 10, null, null, '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', 0, 0);       // todo task, uncompleted -> deleted
  ins.run(204, 10, null, null, '2026-09-01T12:00:00.000Z', '2026-09-01T13:00:00.000Z', 0, 1);       // todo task, completed -> kept
  ins.run(205, null, 20, '2026-09-01', '2026-09-01T09:00:00.000Z', '2026-09-01T09:30:00.000Z', 0, 0); // done occurrence -> kept
  ins.run(206, null, 20, '2026-09-02', '2026-09-02T09:00:00.000Z', '2026-09-02T09:30:00.000Z', 0, 0); // not done -> deleted
  await repo.pruneBlocks('2026-10-01T00:00:00.000Z');
  assert.deepStrictEqual(raw.prepare('SELECT id FROM blocks ORDER BY id').all().map((r) => r.id), [201, 202, 204, 205]);
});
