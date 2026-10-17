// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 17 oracle for T-V2-SAPI-1..6 — spec-v2 §R6 V2-D14, V2-D17, V2-D23, "Data / API",
// "Acceptance" (Chunk 17); §V11 UR-2. Fixture = v1 serve() (copied verbatim from test/api.test.js); fresh app per case
// (interface decision A6). Assertions marked "planner-added" follow directly from the spec text
//. Do not edit expectations.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const C0 = Date.parse('2026-10-19T10:00:00Z');
const ALL = [['00:00', '24:00']];
const WH24 = { '0': ALL, '1': ALL, '2': ALL, '3': ALL, '4': ALL, '5': ALL, '6': ALL };
const FIXTURE = { timezone: 'UTC', workHours: WH24, breakIntervalMin: 0 };
const field = (body) => body.error.split(':')[0];
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tactus-test-'));

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
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => C0 });
  return serve(t, created, tmp);
}

// ---------- helpers ----------

const week = (ranges) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), ranges]));
const only = (day, ranges) => ({ ...week([]), [day]: ranges });
const EVE = week([['18:00', '21:00']]);                 // 18:00-21:00 every day
const H1 = only('1', [['09:00', '17:00']]);             // Mon only
const H2 = only('2', [['10:00', '12:00']]);             // Tue only
const X = week([['08:00', '10:00']]);
const BAD = { ...EVE, '1': [['21:00', '18:00']] };      // start after end
const REC = { title: 'Daily review', frequency: 'daily', daysOfWeek: [], dayOfMonth: null, durationMin: 30, windowStart: null,
  windowEnd: null, priority: 'medium', startDate: '2026-10-19', endDate: null, projectId: null, active: true };
const bad400 = (r, key) => { assert.strictEqual(r.status, 400); assert.strictEqual(field(r.body), key); };
const schedules = async (api) => (await api('GET', '/api/schedules')).body;
const scheduleById = async (api, id) => (await schedules(api)).find((s) => s.id === id);
async function postEvenings(api) {
  const r = await api('POST', '/api/schedules', { name: 'Evenings', hours: EVE });
  assert.strictEqual(r.status, 201);
  return r.body.id;
}
// One task, one project, one recurring rule, all with scheduleId = sid. Returns their ids.
async function createUsers(api, sid) {
  const task = await api('POST', '/api/tasks', { title: 'T', scheduleId: sid });
  const project = await api('POST', '/api/projects', { name: 'P', scheduleId: sid });
  const rec = await api('POST', '/api/recurring', { ...REC, scheduleId: sid });
  for (const r of [task, project, rec]) assert.strictEqual(r.status, 201);
  return { taskId: task.body.id, projectId: project.body.id, recId: rec.body.id, task: task.body, project: project.body, rec: rec.body };
}
async function userScheduleIds(api, u) {
  const task = (await api('GET', `/api/tasks/${u.taskId}`)).body.task;
  const project = (await api('GET', '/api/projects')).body.find((p) => p.id === u.projectId);
  const rec = (await api('GET', '/api/recurring')).body.find((x) => x.id === u.recId);
  return [task.scheduleId, project.scheduleId, rec.scheduleId];
}

// ---------- T-V2-SAPI ----------

test('T-V2-SAPI-1: fresh app has one default schedule "Work" with the fixture hours', async (t) => {
  const api = await mkApp(t);
  const r = await api('GET', '/api/schedules');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 1);
  const s = r.body[0];
  assert.deepStrictEqual({ id: s.id, name: s.name, isDefault: s.isDefault }, { id: 1, name: 'Work', isDefault: true });
  assert.deepStrictEqual(s.hours, WH24);
  // planner-added: §8.1 Schedule shape exactly; default colour; settings expose the default id and the alias.
  assert.deepStrictEqual(Object.keys(s).sort(), ['color', 'createdAt', 'hours', 'id', 'isDefault', 'name']);
  assert.strictEqual(s.color, '#1a73e8');
  assert.strictEqual(typeof s.createdAt, 'string');
  const settings = (await api('GET', '/api/settings')).body;
  assert.strictEqual(settings.defaultScheduleId, 1);
  assert.deepStrictEqual(settings.workHours, WH24);
});

test('T-V2-SAPI-2: POST /schedules creates a schedule; name, hours and color are validated', async (t) => {
  const api = await mkApp(t);
  const r = await api('POST', '/api/schedules', { name: 'Evenings', hours: EVE });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.isDefault, false);
  assert.strictEqual(r.body.color, '#1a73e8');
  assert.strictEqual(r.body.name, 'Evenings');
  assert.deepStrictEqual(r.body.hours, EVE);
  bad400(await api('POST', '/api/schedules', { name: 'work', hours: EVE }), 'name');
  bad400(await api('POST', '/api/schedules', { name: '', hours: EVE }), 'name');
  bad400(await api('POST', '/api/schedules', { name: 'Late', hours: BAD }), 'hours');
  bad400(await api('POST', '/api/schedules', { name: 'Late', hours: EVE, color: 'red' }), 'color');
  // planner-added (V2-D23 and the §8.2 messages): exact uniqueness message; 51 chars rejected; hours required;
  // name trimmed; explicit colour kept; list by id.
  assert.strictEqual((await api('POST', '/api/schedules', { name: 'WORK', hours: EVE })).body.error, 'name: already used');
  bad400(await api('POST', '/api/schedules', { name: 'x'.repeat(51), hours: EVE }), 'name');
  bad400(await api('POST', '/api/schedules', { name: 'Late' }), 'hours');
  const late = await api('POST', '/api/schedules', { name: '  Late  ', hours: EVE, color: '#00aa00' });
  assert.strictEqual(late.status, 201);
  assert.deepStrictEqual([late.body.name, late.body.color], ['Late', '#00aa00']);
  assert.deepStrictEqual((await schedules(api)).map((s) => s.id), [1, r.body.id, late.body.id]);
});

test('T-V2-SAPI-3: scheduleId on task, project and recurring round-trips; unknown id 400; PATCH null clears', async (t) => {
  const api = await mkApp(t);
  const E = await postEvenings(api);
  const u = await createUsers(api, E);
  assert.deepStrictEqual([u.task.scheduleId, u.project.scheduleId, u.rec.scheduleId], [E, E, E]);
  assert.deepStrictEqual(await userScheduleIds(api, u), [E, E, E]);
  bad400(await api('POST', '/api/tasks', { title: 'X', scheduleId: 999 }), 'scheduleId');
  bad400(await api('POST', '/api/projects', { name: 'X', scheduleId: 999 }), 'scheduleId');
  bad400(await api('POST', '/api/recurring', { ...REC, scheduleId: 999 }), 'scheduleId');
  // planner-added: PATCH with an unknown id is rejected the same way.
  bad400(await api('PATCH', `/api/tasks/${u.taskId}`, { scheduleId: 999 }), 'scheduleId');
  bad400(await api('PATCH', `/api/projects/${u.projectId}`, { scheduleId: 999 }), 'scheduleId');
  bad400(await api('PATCH', `/api/recurring/${u.recId}`, { scheduleId: 999 }), 'scheduleId');
  const pt = await api('PATCH', `/api/tasks/${u.taskId}`, { scheduleId: null });
  const pp = await api('PATCH', `/api/projects/${u.projectId}`, { scheduleId: null });
  const pr = await api('PATCH', `/api/recurring/${u.recId}`, { scheduleId: null });
  for (const r of [pt, pp, pr]) assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([pt.body.scheduleId, pp.body.scheduleId, pr.body.scheduleId], [null, null, null]);
  assert.deepStrictEqual(await userScheduleIds(api, u), [null, null, null]);
  // planner-added (§8.1 null = inherit): created without scheduleId -> null.
  const plain = await api('POST', '/api/tasks', { title: 'Plain' });
  assert.strictEqual(plain.status, 201);
  assert.strictEqual(plain.body.scheduleId, null);
});

test('T-V2-SAPI-4: the default schedule cannot be deleted; deleting another clears its references', async (t) => {
  const api = await mkApp(t);
  const del1 = await api('DELETE', '/api/schedules/1');
  assert.strictEqual(del1.status, 409);
  assert.strictEqual(del1.body.error, 'cannot delete the default schedule');
  const E = await postEvenings(api);
  const u = await createUsers(api, E);
  assert.strictEqual((await api('DELETE', `/api/schedules/${E}`)).status, 204);
  assert.deepStrictEqual(await userScheduleIds(api, u), [null, null, null]);
  // planner-added (§8.2 404 rows): list is back to schedule 1; unknown ids are 404.
  assert.deepStrictEqual((await schedules(api)).map((s) => s.id), [1]);
  assert.strictEqual((await api('DELETE', `/api/schedules/${E}`)).status, 404);
  assert.strictEqual((await api('PATCH', '/api/schedules/999', { name: 'Nope' })).status, 404);
  assert.strictEqual((await api('DELETE', '/api/schedules/abc')).status, 404);
});

test('T-V2-SAPI-5: defaultScheduleId moves the default; workHours alias follows it', async (t) => {
  const api = await mkApp(t);
  const E = await postEvenings(api);
  const put = await api('PUT', '/api/settings', { defaultScheduleId: E });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.defaultScheduleId, E);
  assert.deepStrictEqual((await schedules(api)).map((s) => [s.id, s.isDefault]), [[1, false], [E, true]]);
  assert.deepStrictEqual((await api('GET', '/api/settings')).body.workHours, EVE);
  assert.deepStrictEqual((await scheduleById(api, E)).hours, EVE);          // Evenings hours NOT overwritten
  assert.deepStrictEqual((await scheduleById(api, 1)).hours, WH24);         // planner-added: old default untouched
  assert.strictEqual((await api('PUT', '/api/settings', { workHours: X })).status, 200);
  assert.deepStrictEqual((await scheduleById(api, E)).hours, X);
  assert.deepStrictEqual((await scheduleById(api, 1)).hours, WH24);         // planner-added
  bad400(await api('PUT', '/api/settings', { defaultScheduleId: 999 }), 'defaultScheduleId');
  // planner-added: the failed PUT changed nothing; a non-integer id is rejected; the new default cannot be deleted.
  assert.strictEqual((await api('GET', '/api/settings')).body.defaultScheduleId, E);
  bad400(await api('PUT', '/api/settings', { defaultScheduleId: '1' }), 'defaultScheduleId');
  assert.strictEqual((await api('DELETE', `/api/schedules/${E}`)).status, 409);
  // planner-added (V2-D14: "the new default is set first and receives the hours"): one PUT changing both.
  const both = await api('PUT', '/api/settings', { defaultScheduleId: 1, workHours: H1 });
  assert.strictEqual(both.status, 200);
  assert.deepStrictEqual(both.body.workHours, H1);
  assert.deepStrictEqual((await scheduleById(api, 1)).hours, H1);
  assert.deepStrictEqual((await scheduleById(api, E)).hours, X);
  assert.deepStrictEqual((await schedules(api)).map((s) => [s.id, s.isDefault]), [[1, true], [E, false]]);
});

test('T-V2-SAPI-6: the default schedule is fully editable (UR-2); only DELETE is refused', async (t) => {
  const api = await mkApp(t);
  const p = await api('PATCH', '/api/schedules/1', { name: 'Office', color: '#ff0000', hours: H1 });
  assert.strictEqual(p.status, 200);
  assert.deepStrictEqual({ name: p.body.name, color: p.body.color, hours: p.body.hours, isDefault: p.body.isDefault },
    { name: 'Office', color: '#ff0000', hours: H1, isDefault: true });
  assert.deepStrictEqual((await api('GET', '/api/settings')).body.workHours, H1);
  assert.strictEqual((await api('PUT', '/api/settings', { workHours: H2 })).status, 200);
  const s1 = await scheduleById(api, 1);
  assert.deepStrictEqual({ hours: s1.hours, name: s1.name, color: s1.color, isDefault: s1.isDefault },
    { hours: H2, name: 'Office', color: '#ff0000', isDefault: true });
  assert.strictEqual((await api('POST', '/api/schedules', { name: 'Work', hours: H1 })).status, 201);   // old name is free
  bad400(await api('PATCH', '/api/schedules/1', { name: 'work' }), 'name');
  bad400(await api('PATCH', '/api/schedules/1', { hours: BAD }), 'hours');
  assert.strictEqual((await api('DELETE', '/api/schedules/1')).status, 409);
  // planner-added (chunk risk note): a schedule may keep its own name in another case.
  const own = await api('PATCH', '/api/schedules/1', { name: 'OFFICE' });
  assert.strictEqual(own.status, 200);
  assert.strictEqual(own.body.name, 'OFFICE');
});
