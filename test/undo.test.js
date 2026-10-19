// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Reset progress reopens a done task; POST /api/undo restores the state before the last change. API fixture
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


test('reset progress reopens a task that was completed through its block', async (t) => {
  const { api } = await mkApp(t);
  const id = await postTask(api, { title: 'Ninety', durationMin: 90 });
  const [[bid]] = await taskBlocks(api, id);
  assert.strictEqual((await api('POST', `/api/blocks/${bid}/partial-done`, { minutes: 90 })).status, 200);
  assert.strictEqual((await api('GET', `/api/tasks/${id}`)).body.task.status, 'done');
  assert.strictEqual((await api('POST', `/api/tasks/${id}/reset-progress`)).status, 204);
  const after = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(after.task.status, 'todo');
  assert.strictEqual(after.task.completedAt, null);
  assert.strictEqual(after.creditedMin, 0);
  assert.ok(after.blocks.length > 0 && after.blocks.every((b) => !b.completed && !b.missed), 'work is re-planned, not left as a missed block');
});

test('undo restores the state before the last change, step by step, then 409', async (t) => {
  const { api } = await mkApp(t);
  const id = await postTask(api, { title: 'Ninety', durationMin: 90 });
  const [[bid]] = await taskBlocks(api, id);
  await api('POST', `/api/blocks/${bid}/partial-done`, { minutes: 90 });
  assert.strictEqual((await api('GET', `/api/tasks/${id}`)).body.task.status, 'done');
  assert.strictEqual((await api('POST', '/api/undo')).status, 204);
  const undone = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(undone.task.status, 'todo');
  assert.strictEqual(undone.creditedMin, 0);
  assert.strictEqual((await api('POST', '/api/undo')).status, 204);        // undoes the task creation
  assert.strictEqual((await api('GET', `/api/tasks/${id}`)).status, 404);
  assert.strictEqual((await api('POST', '/api/undo')).status, 204);        // undoes the settings PUT of the fixture
  assert.strictEqual((await api('POST', '/api/undo')).status, 409);
});

test('a failed request is not recorded for undo', async (t) => {
  const { api } = await mkApp(t);
  const id = await postTask(api, { title: 'T', durationMin: 30 });
  assert.strictEqual((await api('PATCH', `/api/tasks/${id}`, { priority: 'bogus' })).status, 400);
  assert.strictEqual((await api('POST', '/api/undo')).status, 204);
  assert.strictEqual((await api('GET', `/api/tasks/${id}`)).status, 404);   // the undo reverted the create, not the failed patch
});

test('a completed past task block can be deleted', async (t) => {
  const { api, clk } = await mkApp(t);
  const id = await postTask(api, { title: 'Hour', durationMin: 120 });
  const [[bid]] = await taskBlocks(api, id);
  assert.strictEqual((await api('POST', `/api/blocks/${bid}/partial-done`, { minutes: 30 })).status, 200);
  clk.now += 3 * 3600000;
  assert.strictEqual((await api('DELETE', `/api/blocks/${bid}`)).status, 204);
  assert.strictEqual((await api('GET', `/api/tasks/${id}`)).body.creditedMin, 0);
});
