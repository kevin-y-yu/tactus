// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Tactus-only user events: CRUD, calendar merge, scheduler busy time, undo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const C0 = Date.parse('2026-10-19T10:00:00Z');   // Monday 10:00 UTC
const ALL = [['00:00', '24:00']];
const FIXTURE = { timezone: 'UTC', workHours: { '0': ALL, '1': ALL, '2': ALL, '3': ALL, '4': ALL, '5': ALL, '6': ALL }, breakIntervalMin: 0 };

async function setup(t) {
  const { createApp } = require('../lib/app.js'), { loadConfig } = require('../lib/config.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tactus-userev-'));
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => C0 });
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
  assert.strictEqual((await api('PUT', '/api/settings', FIXTURE)).status, 200);
  return { api, repo: created.repo };
}
const at = (hm) => `2026-10-19T${hm}:00.000Z`;
const cal = async (api) => (await api('GET', '/api/calendar?from=2026-10-19T00:00:00.000Z&to=2026-10-21T00:00:00.000Z')).body;
const userEvents = (c) => c.events.filter((e) => e.uid === 'user');

test('user events: create, show on the calendar, update, delete', async (t) => {
  const { api } = await setup(t);
  const created = await api('POST', '/api/user-events', { title: ' Dentist ', start: at('14:00'), end: at('15:00') });
  assert.strictEqual(created.status, 201);
  const expected = { id: 'user:1', calendarId: null, uid: 'user', title: 'Dentist', location: '', start: at('14:00'), end: at('15:00'),
    allDay: false, startDate: null, endDate: null, transparent: false, blocking: true, color: '#0b8043' };
  assert.deepStrictEqual(created.body, expected);
  assert.deepStrictEqual(userEvents(await cal(api)), [expected]);

  const moved = await api('PATCH', '/api/user-events/1', { start: at('16:00'), end: at('17:00') });
  assert.strictEqual(moved.status, 200);
  assert.strictEqual(moved.body.title, 'Dentist');
  assert.strictEqual(moved.body.start, at('16:00'));

  const renamed = await api('PATCH', '/api/user-events/1', { title: 'Dentist (moved)' });
  assert.strictEqual(renamed.status, 200);
  assert.strictEqual(renamed.body.start, at('16:00'));

  assert.strictEqual((await api('PATCH', '/api/user-events/1', { title: '' })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/user-events/99', { title: 'x' })).status, 404);
  assert.strictEqual((await api('PATCH', '/api/user-events/abc', { title: 'x' })).status, 404);

  assert.strictEqual((await api('DELETE', '/api/user-events/1')).status, 204);
  assert.deepStrictEqual(userEvents(await cal(api)), []);
  assert.strictEqual((await api('DELETE', '/api/user-events/1')).status, 404);
});

test('user events: validation', async (t) => {
  const { api } = await setup(t);
  const base = { title: 'X', start: at('14:00'), end: at('15:00') };
  const invalid = [
    ['title', { title: undefined }],
    ['title', { title: '   ' }],
    ['title', { title: 'x'.repeat(201) }],
    ['location', { location: 5 }],
    ['start', { start: 'tomorrow' }],
    ['start', { start: at('14:10') }],
    ['end', { end: at('14:00') }],
    ['end', { end: at('13:00') }],
    ['end', { end: '2026-10-20T15:00:00.000Z' }],   // 25 h after the 14:00 start
  ];
  for (const [field, override] of invalid) {
    const r = await api('POST', '/api/user-events', { ...base, ...override });
    assert.strictEqual(r.status, 400, `expected 400 for ${field} ${JSON.stringify(override)}`);
    assert.ok(r.body.error.startsWith(`${field}:`), `error names ${field}: ${r.body.error}`);
  }
  const past = await api('POST', '/api/user-events', { title: 'Earlier', start: at('08:00'), end: at('09:00') });
  assert.strictEqual(past.status, 201);
});

test('user events block scheduler time with the meeting buffer', async (t) => {
  const { api } = await setup(t);
  assert.strictEqual((await api('POST', '/api/user-events', { title: 'Busy', start: at('10:00'), end: at('12:00') })).status, 201);
  const task = (await api('POST', '/api/tasks', { title: 'Work', durationMin: 60 })).body;
  const blocks = (await api('GET', `/api/tasks/${task.id}`)).body.blocks;
  assert.ok(blocks.length > 0);
  for (const b of blocks) assert.ok(Date.parse(b.start) >= Date.parse(at('12:15')), `block ${b.start} after event + buffer`);

  const ev = (await cal(api)).events.find((e) => e.uid === 'user');
  assert.strictEqual((await api('PATCH', `/api/user-events/${ev.id.slice(5)}`, { start: at('10:00'), end: at('20:00') })).status, 200);
  const after = (await api('GET', `/api/tasks/${task.id}`)).body.blocks;
  assert.ok(after.length > 0);
  for (const b of after) assert.ok(Date.parse(b.start) >= Date.parse(at('20:15')), `block ${b.start} after moved event + buffer`);
});

test('user events: undo reverts create and delete', async (t) => {
  const { api } = await setup(t);
  assert.strictEqual((await api('POST', '/api/user-events', { title: 'A', start: at('11:00'), end: at('12:00') })).status, 201);
  assert.strictEqual((await api('POST', '/api/undo')).status, 204);
  assert.deepStrictEqual(userEvents(await cal(api)), []);

  const b = (await api('POST', '/api/user-events', { title: 'B', start: at('11:00'), end: at('12:00') })).body;
  assert.strictEqual((await api('DELETE', `/api/user-events/${b.id.slice(5)}`)).status, 204);
  assert.strictEqual((await api('POST', '/api/undo')).status, 204);
  assert.deepStrictEqual(userEvents(await cal(api)).map((e) => e.id), [b.id]);
});
