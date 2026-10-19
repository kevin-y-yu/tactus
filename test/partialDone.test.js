// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Partial done: POST /api/blocks/:id/partial-done (shrink to the worked minutes and complete), T-PART-1..6, API fixture
// (v1 serve() fixture: UTC, all-day hours, breaks off, clock C0 = 2026-10-19T10:00Z, D = 2026-10-19).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');

const C0 = Date.parse('2026-10-19T10:00:00Z');
const D0 = Date.parse('2026-10-19T00:00:00Z');
const D = '2026-10-19';
const MINUTE = 60000, DAY = 86400000;
const ALL = [['00:00', '24:00']];
const WH24 = { '0': ALL, '1': ALL, '2': ALL, '3': ALL, '4': ALL, '5': ALL, '6': ALL };
const FIXTURE = { timezone: 'UTC', workHours: WH24, breakIntervalMin: 0 };
const iso = (v) => new Date(v).toISOString();
const at = (hm, date = D) => iso(`${date}T${hm}Z`);          // 'HH:MM' or 'HH:MM:SS' on date (UTC) -> ISO string
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tactus-test-'));
const partial = (api, bid, minutes) => api('POST', `/api/blocks/${bid}/partial-done`, { minutes });

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

// Shared setup for T-PART-1, -2, -6: task 90 min, one block 10:00-11:30 (clock C0).
async function ninetyTask(t) {
  const { api, clk } = await mkApp(t);
  const id = await postTask(api, { title: 'Ninety', durationMin: 90 });
  const before = await taskBlocks(api, id);
  assert.deepStrictEqual(before.map((b) => b.slice(1)), [[at('10:00'), at('11:30'), false]]);
  return { api, clk, id, bid: before[0][0] };
}

// ---------- T-PART (API) ----------

test('T-PART-1: running block, 45 of 90 worked -> block shrinks to 10:00-10:45, completed, remainder re-planned', async (t) => {
  const { api, clk, id, bid } = await ninetyTask(t);
  clk.now = C0 + 50 * MINUTE;
  const r = await partial(api, bid, 45);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.id, bid);
  assert.strictEqual(iso(r.body.start), at('10:00'));
  assert.strictEqual(iso(r.body.end), at('10:45'));
  assert.strictEqual(r.body.completed, true);
  assert.strictEqual(r.body.done, false);
  assert.strictEqual(r.body.missed, false);
  const task = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(task.task.status, 'todo');
  assert.strictEqual(task.status.creditedMin, 45);
  assert.strictEqual(task.creditedMin, 45);
  const blocks = sortBlocks(task.blocks);
  assert.deepStrictEqual([blocks[0].id, iso(blocks[0].start), iso(blocks[0].end), blocks[0].completed],
    [bid, at('10:00'), at('10:45'), true]);
  const rest = blocks.slice(1);
  assert.strictEqual(rest.length, 1);
  assert.strictEqual(rest[0].completed, false);
  assert.strictEqual((Date.parse(rest[0].end) - Date.parse(rest[0].start)) / MINUTE, 45);
  assert.ok(Date.parse(rest[0].start) >= C0 + 50 * MINUTE);
});

test('T-PART-2: past block, leftover is not left as a missed block', async (t) => {
  const { api, clk, id, bid } = await ninetyTask(t);
  clk.now = C0 + 120 * MINUTE;                       // 12:00, block 10:00-11:30 is past
  const r = await partial(api, bid, 45);
  assert.strictEqual(r.status, 200);
  const task = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(task.creditedMin, 45);
  const blocks = sortBlocks(task.blocks);
  assert.ok(blocks.every((b) => b.missed !== true), 'no missed block');
  const done = blocks.filter((b) => b.completed);
  assert.deepStrictEqual(done.map((b) => [b.id, iso(b.start), iso(b.end)]), [[bid, at('10:00'), at('10:45')]]);
  const open = blocks.filter((b) => !b.completed);
  assert.strictEqual(open.length, 1);
  assert.strictEqual((Date.parse(open[0].end) - Date.parse(open[0].start)) / MINUTE, 45);
  assert.ok(Date.parse(open[0].start) >= C0 + 120 * MINUTE);
});

test('T-PART-3: full length auto-completes; a block planned past now moves to end at now', async (t) => {
  const { api } = await mkApp(t);
  const id = await postTask(api, { title: 'Hour', durationMin: 60 });
  const bid = (await taskBlocks(api, id))[0][0];
  const r = await partial(api, bid, 60);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(iso(r.body.start), at('09:00'));
  assert.strictEqual(iso(r.body.end), at('10:00'));
  assert.strictEqual(r.body.completed, true);
  assert.strictEqual(r.body.done, true);
  assert.strictEqual((await api('GET', `/api/tasks/${id}`)).body.task.status, 'done');
});

test('T-PART-4: pinned block, partial reaching the estimate auto-completes and keeps the pin, moved to end at now', async (t) => {
  const { api } = await mkApp(t);
  const id = await postTask(api, { title: 'Hour', durationMin: 60 });
  const pin = await api('POST', '/api/blocks', { taskId: id, start: at('13:00'), end: at('14:30') });
  assert.strictEqual(pin.status, 201);
  const pid = pin.body.id;
  const r = await partial(api, pid, 60);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(iso(r.body.start), at('09:00'));
  assert.strictEqual(iso(r.body.end), at('10:00'));
  assert.strictEqual(r.body.completed, true);
  assert.strictEqual(r.body.pinned, true);
  assert.strictEqual(r.body.done, true);
  const task = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(task.task.status, 'done');
  assert.deepStrictEqual(await taskBlocks(api, id), [[pid, at('09:00'), at('10:00'), true]]);
});

test('T-PART-5: validation, already completed, task done, recurring', async (t) => {
  const { api } = await mkApp(t);
  const id = await postTask(api, { title: 'Ninety', durationMin: 90 });
  const bid = (await taskBlocks(api, id))[0][0];
  for (const body of [{ minutes: 0 }, { minutes: 91 }, { minutes: 45.5 }, { minutes: '45' }, {}]) {
    const r = await api('POST', `/api/blocks/${bid}/partial-done`, body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
  }
  assert.strictEqual((await partial(api, 999999, 10)).status, 404);
  const ok = await partial(api, bid, 30);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await partial(api, bid, 10)).status, 409);          // already completed
  assert.strictEqual((await api('PATCH', `/api/tasks/${id}`, { status: 'done' })).status, 200);
  assert.strictEqual((await partial(api, bid, 10)).status, 409);          // task is done (checked before completed)

  const rid = await postRec(api);
  const cal = (await api('GET', calUrl(D0, D0 + DAY))).body.blocks;
  const rb = cal.find((b) => b.kind === 'recurring' && b.recurringId === rid);
  assert.ok(rb, 'recurring block on day D');
  assert.strictEqual((await partial(api, rb.id, 15)).status, 400);
});

test('T-PART-6: untick restores no length, re-plans the remainder', async (t) => {
  const { api, clk, id, bid } = await ninetyTask(t);
  clk.now = C0 + 50 * MINUTE;
  assert.strictEqual((await partial(api, bid, 45)).status, 200);
  const u = await api('PATCH', `/api/blocks/${bid}`, { completed: false });
  assert.strictEqual(u.status, 200);
  const task = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(task.creditedMin, 0);
  const blocks = sortBlocks(task.blocks);
  const mine = blocks.find((b) => b.id === bid);
  assert.strictEqual(iso(mine.start), at('10:00'));
  assert.strictEqual(iso(mine.end), at('10:45'));
  assert.strictEqual(mine.completed, false);
  assert.strictEqual(mine.missed, true);
  const futureMin = blocks.filter((b) => !b.completed && Date.parse(b.start) >= C0 + 50 * MINUTE)
    .reduce((s, b) => s + (Date.parse(b.end) - Date.parse(b.start)) / MINUTE, 0);
  assert.strictEqual(futureMin, 90);
});
