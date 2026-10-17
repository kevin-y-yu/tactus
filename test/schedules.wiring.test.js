// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 19 oracle for T-V2-WIRE-1..5 — spec-v2 §R6 V2-D15, V2-D18 Orchestration, Acceptance (Chunk 19).
// Fixture = v1 serve() copied verbatim from test/schedules.api.test.js; fresh app per case (A6).
// Planner-added cases are marked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const C0 = Date.parse('2026-10-19T10:00:00Z');
const ALL = [['00:00', '24:00']];
const WH24 = { '0': ALL, '1': ALL, '2': ALL, '3': ALL, '4': ALL, '5': ALL, '6': ALL };
const FIXTURE = { timezone: 'UTC', workHours: WH24, breakIntervalMin: 0 };
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tactus-test-'));

// ---------- API fixture (copied verbatim from test/schedules.api.test.js) ----------

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
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => C0 });
  return serve(t, created, tmp);
}

// ---------- helpers ----------

const week = (ranges) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), ranges]));
const iso = (v) => new Date(v).toISOString();
const EVE = week([['18:00', '21:00']]);
const REC = { title: 'Daily', frequency: 'daily', daysOfWeek: [], dayOfMonth: null, durationMin: 60, windowStart: null,
  windowEnd: null, priority: 'medium', startDate: '2026-10-19', endDate: null, projectId: null, active: true };
const created201 = (r) => { assert.strictEqual(r.status, 201); return r.body.id; };
const postEvenings = async (api) => created201(await api('POST', '/api/schedules', { name: 'Evenings', hours: EVE }));
const taskBlocks = async (api, id) => (await api('GET', `/api/tasks/${id}`)).body.blocks
  .map((b) => [iso(b.start), iso(b.end)]).sort((a, b) => a[0].localeCompare(b[0]));
const R2 = `/api/calendar?from=${encodeURIComponent('2026-10-19T00:00:00.000Z')}&to=${encodeURIComponent('2026-10-21T00:00:00.000Z')}`;
const recBlocks = async (api, rid) => (await api('GET', R2)).body.blocks
  .filter((b) => b.kind === 'recurring' && b.recurringId === rid)
  .map((b) => [b.occurrenceDate, iso(b.start), iso(b.end)]).sort((a, b) => a[0].localeCompare(b[0]));
const D19 = (from, to) => [`2026-10-19T${from}:00.000Z`, `2026-10-19T${to}:00.000Z`];

// ---------- T-V2-WIRE ----------

test('T-V2-WIRE-1: a task with its own scheduleId is placed in that schedule\'s hours', async (t) => {
  const api = await mkApp(t);
  const eve = await postEvenings(api);
  const id = created201(await api('POST', '/api/tasks', { title: 'A', durationMin: 60, scheduleId: eve }));
  assert.deepStrictEqual(await taskBlocks(api, id), [D19('18:00', '19:00')]);
});

test('T-V2-WIRE-2: a task without scheduleId inherits its project\'s schedule; its own scheduleId overrides', async (t) => {
  const api = await mkApp(t);
  const eve = await postEvenings(api);
  const pid = created201(await api('POST', '/api/projects', { name: 'P', scheduleId: eve }));
  const a = created201(await api('POST', '/api/tasks', { title: 'Inherit', durationMin: 60, projectId: pid }));
  const b = created201(await api('POST', '/api/tasks', { title: 'Own', durationMin: 60, projectId: pid, scheduleId: 1 }));
  assert.deepStrictEqual(await taskBlocks(api, a), [D19('18:00', '19:00')]);
  assert.deepStrictEqual(await taskBlocks(api, b), [D19('10:00', '11:00')]);
});

test('T-V2-WIRE-3: a recurring rule with scheduleId is placed in that schedule on each occurrence (2026-10-20 planner-added)', async (t) => {
  const api = await mkApp(t);
  const eve = await postEvenings(api);
  const rid = created201(await api('POST', '/api/recurring', { ...REC, scheduleId: eve }));
  assert.deepStrictEqual(await recBlocks(api, rid), [
    ['2026-10-19', ...D19('18:00', '19:00')],
    ['2026-10-20', '2026-10-20T18:00:00.000Z', '2026-10-20T19:00:00.000Z'],
  ]);
});

test('T-V2-WIRE-3b (planner-added, V2-D15 recurring project fallback): rule with null scheduleId uses its project\'s schedule', async (t) => {
  const api = await mkApp(t);
  const eve = await postEvenings(api);
  const pid = created201(await api('POST', '/api/projects', { name: 'P', scheduleId: eve }));
  const rid = created201(await api('POST', '/api/recurring', { ...REC, projectId: pid, scheduleId: null }));
  assert.deepStrictEqual(await recBlocks(api, rid), [
    ['2026-10-19', ...D19('18:00', '19:00')],
    ['2026-10-20', '2026-10-20T18:00:00.000Z', '2026-10-20T19:00:00.000Z'],
  ]);
});

test('T-V2-WIRE-4: deleting a schedule makes its tasks fall back to the default schedule', async (t) => {
  const api = await mkApp(t);
  const eve = await postEvenings(api);
  const id = created201(await api('POST', '/api/tasks', { title: 'A', durationMin: 60, scheduleId: eve }));
  assert.deepStrictEqual(await taskBlocks(api, id), [D19('18:00', '19:00')]);
  assert.strictEqual((await api('DELETE', `/api/schedules/${eve}`)).status, 204);
  assert.deepStrictEqual(await taskBlocks(api, id), [D19('10:00', '11:00')]);
});

test('T-V2-WIRE-5: editing a schedule\'s hours moves its tasks on the next run', async (t) => {
  const api = await mkApp(t);
  const eve = await postEvenings(api);
  const id = created201(await api('POST', '/api/tasks', { title: 'A', durationMin: 60, scheduleId: eve }));
  assert.deepStrictEqual(await taskBlocks(api, id), [D19('18:00', '19:00')]);
  const r = await api('PATCH', `/api/schedules/${eve}`, { hours: week([['19:00', '21:00']]) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await taskBlocks(api, id), [D19('19:00', '20:00')]);
});
