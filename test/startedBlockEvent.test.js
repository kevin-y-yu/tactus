// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Repro: an in-progress task block that a newly added blocking event overlaps must be released whole and re-planned.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const C0 = Date.parse('2026-10-19T10:00:00Z');
const MINUTE = 60000;
const ALL = [['00:00', '24:00']];
const FIXTURE = { timezone: 'UTC', workHours: { '0': ALL, '1': ALL, '2': ALL, '3': ALL, '4': ALL, '5': ALL, '6': ALL }, breakIntervalMin: 0 };
const at = (hm) => `2026-10-19T${hm}:00.000Z`;
const iso = (v) => new Date(v).toISOString();

async function setup(t) {
  const { createApp } = require('../lib/app.js'), { loadConfig } = require('../lib/config.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tactus-started-'));
  const clk = { now: C0 };
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clk.now });
  const server = created.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    created.scheduleService.stop(); created.calendarSync.stop(); await created.repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  assert.strictEqual((await api('PUT', '/api/settings', { ...FIXTURE, meetingBufferMin: 0 })).status, 200);
  return { api, clk };
}
const taskBlocks = async (api, id) => (await api('GET', `/api/tasks/${id}`)).body.blocks
  .map((b) => [iso(b.start), iso(b.end), b.pinned, b.completed]).sort();

async function startedBlock(t) {
  const env = await setup(t);
  const r = await env.api('POST', '/api/tasks', { title: 'Report', durationMin: 105, startAfter: at('13:15') });
  assert.strictEqual(r.status, 201);
  const id = r.body.id;
  assert.deepStrictEqual((await taskBlocks(env.api, id)).map((b) => b.slice(0, 2)), [[at('13:15'), at('15:00')]]);
  env.clk.now = Date.parse(at('13:42'));
  return { ...env, id };
}

test('started task block overlapped by a new user event is released whole and re-planned in full', async (t) => {
  const { api, id } = await startedBlock(t);
  const ev = await api('POST', '/api/user-events', { title: 'Meeting', start: at('14:00'), end: at('16:00') });
  assert.strictEqual(ev.status, 201);
  const blocks = await taskBlocks(api, id);
  const total = blocks.reduce((s, b) => s + (Date.parse(b[1]) - Date.parse(b[0])) / MINUTE, 0);
  assert.strictEqual(total, 105, `full 105 min re-planned, got ${JSON.stringify(blocks)}`);
  for (const b of blocks) {
    assert.ok(Date.parse(b[0]) >= Date.parse(at('13:42')), `no block starts before now: ${b}`);
    assert.ok(Date.parse(b[1]) <= Date.parse(at('14:00')) || Date.parse(b[0]) >= Date.parse(at('16:00')), `no overlap with event: ${b}`);
  }
  const st = (await api('GET', '/api/status')).body;
  assert.strictEqual(st && st.tasks.find((x) => x.taskId === id).creditedMin, 0);
});

test('started task block not overlapped by a new event stays fixed', async (t) => {
  const { api, id } = await startedBlock(t);
  await api('POST', '/api/user-events', { title: 'Later', start: at('15:00'), end: at('16:00') });
  assert.deepStrictEqual((await taskBlocks(api, id)).map((b) => b.slice(0, 2)), [[at('13:15'), at('15:00')]]);
});

test('pinned started block is exempt', async (t) => {
  const { api, id } = await startedBlock(t);
  const bid = (await api('GET', `/api/tasks/${id}`)).body.blocks[0].id;
  assert.strictEqual((await api('PATCH', `/api/blocks/${bid}`, { pinned: true })).status, 200);
  await api('POST', '/api/user-events', { title: 'Meeting', start: at('14:00'), end: at('16:00') });
  assert.deepStrictEqual((await taskBlocks(api, id)).map((b) => b.slice(0, 2)), [[at('13:15'), at('15:00')]]);
});

test('completed (partial-done) block is exempt', async (t) => {
  const { api, id } = await startedBlock(t);
  const bid = (await api('GET', `/api/tasks/${id}`)).body.blocks[0].id;
  assert.strictEqual((await api('POST', `/api/blocks/${bid}/partial-done`, { minutes: 27 })).status, 200);
  await api('POST', '/api/user-events', { title: 'Meeting', start: at('14:00'), end: at('16:00') });
  const blocks = await taskBlocks(api, id);
  assert.ok(blocks.some((b) => b[3] === true), JSON.stringify(blocks));
});
