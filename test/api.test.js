// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 0 oracle for T-DATA-1..4, T-API-1..20, T-API-X1..X7 — spec §13.8 (lines 878–920),
// with §6 (267–315), §5.4 (203–228), §5.5 (230–235), §7 (319–339), §8 (343–415), §11 S-2/S-3/S-6 (733–737).
// Do not edit expectations.
// Open §5 call shapes decided by the Chunk 0 plan: D7, D8, D9, D15, D16, D17
//
// Clock rule (DL-25): `clock` starts at C0 and changes only where a case says "set clock". Every API test builds its own
// fresh app (D8) with a clock variable initialised to C0, passed to the app factory as its now function.
// Instants in API responses are compared after normalising with iso() (D7), except T-API-19 which compares raw strings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { once } = require('node:events');
const C0 = Date.parse('2026-10-19T10:00:00Z');
const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
const ALL = [['00:00', '24:00']];
const WH24 = { '0': ALL, '1': ALL, '2': ALL, '3': ALL, '4': ALL, '5': ALL, '6': ALL };
const FIXTURE = { timezone: 'UTC', workHours: WH24, breakIntervalMin: 0 };
const iso = (v) => new Date(v).toISOString();
const field = (body) => body.error.split(':')[0];
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tactus-test-'));
const appModules = () => ({ createApp: require('../lib/app.js').createApp, loadConfig: require('../lib/config.js').loadConfig });
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
  const put = await api('PUT', '/api/settings', FIXTURE, setupHeaders);   // spec L882: first request
  assert.strictEqual(put.status, 200);
  return api;
}
const calUrl = (from, to) => `/api/calendar?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}`;
const sortRows = (rows) => [...rows].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.blockId - b.blockId);
const sortBlocks = (bl) => [...bl].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id - b.id);
const taskRows = async (api, id) => sortRows((await api('GET', '/api/agenda')).body.rows.filter((r) => r.taskId === id));
const REC = { title: 'Daily review', frequency: 'daily', daysOfWeek: [], dayOfMonth: null, durationMin: 30, windowStart: null,
  windowEnd: null, priority: 'medium', startDate: '2026-10-19', endDate: null, projectId: null, active: true };
const W7 = calUrl(C0, C0 + 7 * DAY);
const bad400 = (r, key) => { assert.strictEqual(r.status, 400); assert.strictEqual(field(r.body), key); };
const postTask = async (api, body) => { const r = await api('POST', '/api/tasks', body); assert.strictEqual(r.status, 201); return r.body.id; };

// ---------- T-DATA (owner Chunk 2; D9) ----------
// Raw node:sqlite is used to seed and inspect rows on the same DB file (D9). Only openDb/listProjects/getSettings/
// pruneBlocks/replaceScheduledBlocks/close are called on the repo (§5.4 fixed signatures).
const TS = '2026-10-01T00:00:00.000Z';
async function dataEnv(t) {
  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'tactus.db');
  let repo = null, raw = null;
  t.after(async () => {
    if (raw) raw.close();
    if (repo) await repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { tmp, dbPath, setRepo: (r) => { repo = r; }, setRaw: (r) => { raw = r; } };
}

test('T-DATA-1: fresh openDb has no projects and has default settings (AC-DATA)', async (t) => {
  const { openDb } = require('../lib/db.js');
  const env = await dataEnv(t);
  const repo = await openDb(env.dbPath);
  env.setRepo(repo);
  assert.deepStrictEqual(await repo.listProjects(), []);
  const s = await repo.getSettings();
  assert.deepStrictEqual([s.horizonDays, s.defaultMinBlockMin, s.hardDeadlineMarginMin], [28, 30, 120]);
  assert.strictEqual(typeof s.timezone, 'string');
});

test('T-DATA-2: block with both task_id and recurring_id violates the CHECK', async (t) => {
  const { openDb } = require('../lib/db.js');
  const { DatabaseSync } = require('node:sqlite');
  const env = await dataEnv(t);
  const repo = await openDb(env.dbPath);
  env.setRepo(repo);
  const raw = new DatabaseSync(env.dbPath, { enableForeignKeyConstraints: false });
  env.setRaw(raw);
  assert.throws(() => raw.prepare(`INSERT INTO blocks (task_id, recurring_id, occurrence_date, start, "end") VALUES (1, 1, '2026-10-19', '2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z')`).run(), /CHECK constraint failed/);
});

test('T-DATA-3: pruneBlocks deletes old uncompleted and done-task blocks, keeps credited blocks of todo tasks (DL-24)', async (t) => {
  const { openDb } = require('../lib/db.js');
  const { DatabaseSync } = require('node:sqlite');
  const env = await dataEnv(t);
  const repo = await openDb(env.dbPath);
  env.setRepo(repo);
  const raw = new DatabaseSync(env.dbPath);
  env.setRaw(raw);
  raw.prepare(`INSERT INTO tasks (id, project_id, title, duration_min, status, created_at, updated_at) VALUES (10,NULL,'todo task',60,'todo',?,?)`).run(TS, TS);
  raw.prepare(`INSERT INTO tasks (id, project_id, title, duration_min, status, created_at, updated_at) VALUES (11,NULL,'done task',60,'done',?,?)`).run(TS, TS);
  raw.prepare(`INSERT INTO recurring (id, title, frequency, duration_min, start_date, created_at, updated_at) VALUES (20,'Daily','daily',30,'2026-09-01',?,?)`).run(TS, TS);
  const ins = raw.prepare(`INSERT INTO blocks (id, task_id, recurring_id, occurrence_date, start, "end", pinned, completed) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run(101, 10, null, null, '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', 0, 0);   // old uncompleted -> deleted
  ins.run(102, 10, null, null, '2026-09-01T12:00:00.000Z', '2026-09-01T13:00:00.000Z', 0, 1);   // completed, todo task -> kept
  ins.run(103, 11, null, null, '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', 0, 1);   // done task -> deleted
  ins.run(104, 10, null, null, '2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z', 0, 0);   // ends after cutoff -> kept
  ins.run(105, null, 20, '2026-09-01', '2026-09-01T09:00:00.000Z', '2026-09-01T09:30:00.000Z', 0, 0); // old recurring -> deleted (§9.10 step 2)
  await repo.pruneBlocks('2026-10-01T00:00:00.000Z');
  assert.deepStrictEqual(raw.prepare('SELECT id FROM blocks ORDER BY id').all().map((r) => r.id), [102, 103, 104]);
});

test('T-DATA-4: replaceScheduledBlocks deletes only unpinned uncompleted future rows and inserts the given blocks', async (t) => {
  const { openDb } = require('../lib/db.js');
  const { DatabaseSync } = require('node:sqlite');
  const env = await dataEnv(t);
  const repo = await openDb(env.dbPath);
  env.setRepo(repo);
  const raw = new DatabaseSync(env.dbPath);
  env.setRaw(raw);
  raw.prepare(`INSERT INTO tasks (id, project_id, title, duration_min, status, created_at, updated_at) VALUES (10,NULL,'todo task',60,'todo',?,?)`).run(TS, TS);
  raw.prepare(`INSERT INTO recurring (id, title, frequency, duration_min, start_date, created_at, updated_at) VALUES (20,'Daily','daily',30,'2026-09-01',?,?)`).run(TS, TS);
  const ins = raw.prepare(`INSERT INTO blocks (id, task_id, recurring_id, occurrence_date, start, "end", pinned, completed) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run(201, 10, null, null, '2026-10-19T08:00:00.000Z', '2026-10-19T09:00:00.000Z', 0, 0);   // past -> kept
  ins.run(202, 10, null, null, '2026-10-19T12:00:00.000Z', '2026-10-19T13:00:00.000Z', 0, 0);   // future unpinned -> deleted
  ins.run(203, 10, null, null, '2026-10-19T13:00:00.000Z', '2026-10-19T14:00:00.000Z', 1, 0);   // pinned -> kept
  ins.run(204, 10, null, null, '2026-10-19T14:00:00.000Z', '2026-10-19T15:00:00.000Z', 0, 1);   // completed -> kept
  await repo.replaceScheduledBlocks('2026-10-19T10:00:00.000Z', [
    { taskId: 10, start: '2026-10-19T16:00:00.000Z', end: '2026-10-19T17:00:00.000Z' },
    { recurringId: 20, occurrenceDate: '2026-10-19', start: '2026-10-19T18:00:00.000Z', end: '2026-10-19T18:30:00.000Z' },
  ]);
  const rows = raw.prepare(`SELECT task_id, recurring_id, occurrence_date, start, "end", pinned, completed FROM blocks`).all()
    .map((r) => [r.task_id, r.recurring_id, r.occurrence_date, iso(r.start), iso(r.end), r.pinned, r.completed])
    .sort((a, b) => Date.parse(a[3]) - Date.parse(b[3]));
  assert.deepStrictEqual(rows, [
    [10, null, null, '2026-10-19T08:00:00.000Z', '2026-10-19T09:00:00.000Z', 0, 0],
    [10, null, null, '2026-10-19T13:00:00.000Z', '2026-10-19T14:00:00.000Z', 1, 0],
    [10, null, null, '2026-10-19T14:00:00.000Z', '2026-10-19T15:00:00.000Z', 0, 1],
    [10, null, null, '2026-10-19T16:00:00.000Z', '2026-10-19T17:00:00.000Z', 0, 0],
    [null, 20, '2026-10-19', '2026-10-19T18:00:00.000Z', '2026-10-19T18:30:00.000Z', 0, 0],
  ]);
});

// ---------- T-API (spec L884–920; D8: fresh app per test) ----------

test('T-API-1: fresh app has no projects and has default settings', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  assert.deepStrictEqual((await api('GET', '/api/projects')).body, []);
  const s = (await api('GET', '/api/settings')).body;
  assert.deepStrictEqual([s.defaultMinBlockMin, s.hardDeadlineMarginMin], [30, 120]);
});

test('T-API-2: POST task applies defaults and status is ok', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const r = await api('POST', '/api/tasks', { title: 'Defaults', durationMin: 60 });
  assert.strictEqual(r.status, 201);
  const b = r.body;
  assert.deepStrictEqual({ durationMin: b.durationMin, priority: b.priority, projectId: b.projectId, deadlineType: b.deadlineType, dontSplit: b.dontSplit },
    { durationMin: 60, priority: 'medium', projectId: null, deadlineType: 'hard', dontSplit: false });
  assert.strictEqual((await api('GET', `/api/tasks/${b.id}`)).body.status.state, 'ok');
});

test('T-API-3: one 60 min block at 10:00', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  await postTask(api, { title: 'A', durationMin: 60 });
  const blocks = (await api('GET', W7)).body.blocks;
  assert.deepStrictEqual(blocks.map((b) => [iso(b.start), iso(b.end)]), [['2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z']]);
});

test('T-API-4: task validation rejects bad durationMin, maxBlockMin and priority', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  bad400(await api('POST', '/api/tasks', { title: 'x', durationMin: 20 }), 'durationMin');
  bad400(await api('POST', '/api/tasks', { title: 'x', durationMin: 60, minBlockMin: 60, maxBlockMin: 30 }), 'maxBlockMin');
  bad400(await api('POST', '/api/tasks', { title: 'x', durationMin: 60, priority: 'critical' }), 'priority');
});

test('T-API-5: marking a task done removes its future blocks', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const id = await postTask(api, { title: 'A', durationMin: 60 });
  assert.strictEqual((await api('GET', W7)).body.blocks.length, 1);
  assert.strictEqual((await api('PATCH', `/api/tasks/${id}`, { status: 'done' })).status, 200);
  assert.deepStrictEqual((await api('GET', W7)).body.blocks.filter((b) => Date.parse(b.start) >= C0), []);
});

test('T-API-6: pinning creates exactly that block; off-grid and past pins are rejected', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const id = await postTask(api, { title: 'Pin me', durationMin: 60 });
  const pin = await api('POST', '/api/blocks', { taskId: id, start: '2026-10-20T10:00:00.000Z', end: '2026-10-20T11:00:00.000Z' });
  assert.strictEqual(pin.status, 201);
  const pinnedId = pin.body.id;
  assert.strictEqual(pin.body.pinned, true);
  assert.deepStrictEqual((await api('GET', `/api/tasks/${id}`)).body.blocks.map((b) => b.id), [pinnedId]);
  assert.strictEqual((await api('POST', '/api/blocks', { taskId: id, start: '2026-10-20T10:05:00.000Z', end: '2026-10-20T11:05:00.000Z' })).status, 400);
  assert.strictEqual((await api('POST', '/api/blocks', { taskId: id, start: '2026-10-19T09:00:00.000Z', end: '2026-10-19T10:00:00.000Z' })).status, 400);
});

test('T-API-7: Inbox cannot be deleted', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  assert.strictEqual((await api('DELETE', '/api/projects/1')).status, 409);
});

test('T-API-8: settings validation', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  bad400(await api('PUT', '/api/settings', { horizonDays: 3 }), 'horizonDays');
  bad400(await api('PUT', '/api/settings', { defaultMinBlockMin: 20 }), 'defaultMinBlockMin');
  bad400(await api('PUT', '/api/settings', { hardDeadlineMarginMin: 10 }), 'hardDeadlineMarginMin');
  assert.strictEqual((await api('PUT', '/api/settings', { defaultMinBlockMin: 30 })).status, 200);
});

test('T-API-9: overdue soft deadline is at risk soft and overdue', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const id = await postTask(api, { title: 'Late', durationMin: 60, deadline: '2026-10-19T09:00:00.000Z', deadlineType: 'soft' });
  const status = (await api('GET', '/api/status')).body;
  assert.deepStrictEqual(status.atRisk.filter((a) => a.taskId === id).map((a) => ({ kind: a.kind, overdue: a.overdue })), [{ kind: 'soft', overdue: true }]);
});

test('T-API-10: auth token gates the API', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp, AUTH_TOKEN: 's3cret' }), { now: () => clock });
  const api = await serve(t, created, tmp, { authorization: 'Bearer s3cret' });
  assert.strictEqual((await api('GET', '/api/projects')).status, 401);
  assert.strictEqual((await api('GET', '/api/projects', undefined, { authorization: 'Bearer s3cret' })).status, 200);
  const wrong = await api('POST', '/api/auth/login', { password: 'wrong' });
  assert.strictEqual(wrong.status, 401);
  assert.deepStrictEqual(wrong.body, { error: 'invalid password' });
  const login = await api('POST', '/api/auth/login', { password: 's3cret' });
  assert.strictEqual(login.status, 204);
  const pair = login.headers.getSetCookie().find((c) => c.startsWith('tactus_session=')).split(';')[0];
  assert.strictEqual((await api('GET', '/api/projects', undefined, { cookie: pair })).status, 200);
  assert.strictEqual((await api('GET', '/api/health')).status, 200);
});

test('T-API-11: calendar URL is write-only and redacted', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const r = await api('POST', '/api/calendars', { name: 'Leaky', url: 'https://127.0.0.1:9/secret-token.ics' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.urlRedacted, 'https://127.0.0.1:9/...');
  assert.strictEqual('url' in r.body, false);
  assert.strictEqual(typeof r.body.lastError, 'string');
  assert.strictEqual(r.body.lastError.includes('secret-token'), false);
  const list = (await api('GET', '/api/calendars')).body;
  assert.deepStrictEqual(list.filter((c) => 'url' in c), []);
  assert.strictEqual(JSON.stringify(list).includes('secret-token'), false);
});

test('T-API-12: agenda basic row', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const id = await postTask(api, { title: 'A', durationMin: 60 });
  const rows = await taskRows(api, id);
  assert.deepStrictEqual(rows.map((r) => [r.partIndex, r.partCount, r.completed]), [[1, 1, false]]);
  assert.deepStrictEqual((await api('GET', '/api/agenda')).body.unscheduled, []);
});

test('T-API-13: parts, completion credit, auto-complete and reopen', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const id = await postTask(api, { title: 'Parts', durationMin: 180, maxBlockMin: 60 });
  let rows = await taskRows(api, id);
  assert.deepStrictEqual(rows.map((r) => [iso(r.start), iso(r.end), r.partCount]), [
    ['2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z', 3],
    ['2026-10-19T11:15:00.000Z', '2026-10-19T12:15:00.000Z', 3],
    ['2026-10-19T12:30:00.000Z', '2026-10-19T13:30:00.000Z', 3],
  ]);
  const b1 = rows[0].blockId;
  const old = [rows[1].blockId, rows[2].blockId];
  assert.strictEqual((await api('PATCH', `/api/blocks/${b1}`, { completed: true })).status, 200);
  let task = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(task.task.status, 'todo');
  assert.strictEqual(task.creditedMin, 60);
  assert.deepStrictEqual(
    (({ creditedMin, scheduledMin, unscheduledMin, slackMin }) => ({ creditedMin, scheduledMin, unscheduledMin, slackMin }))(task.status),
    { creditedMin: 60, scheduledMin: 120, unscheduledMin: 0, slackMin: null });
  rows = await taskRows(api, id);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows.filter((r) => r.completed).map((r) => r.blockId), [b1]);
  assert.deepStrictEqual(rows.filter((r) => !r.completed && old.includes(r.blockId)).map((r) => r.blockId), []);
  const counts = [];
  for (let i = 0; i < 2; i++) {
    rows = await taskRows(api, id);
    const open = rows.filter((r) => !r.completed);
    counts.push(open.length);
    assert.strictEqual((await api('PATCH', `/api/blocks/${open[0].blockId}`, { completed: true })).status, 200);
  }
  assert.deepStrictEqual(counts, [2, 1]);
  task = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(task.task.status, 'done');
  assert.strictEqual((await api('PATCH', `/api/blocks/${b1}`, { completed: false })).status, 200);
  task = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(task.task.status, 'todo');
  assert.strictEqual(task.task.completedAt, null);
  assert.strictEqual(task.creditedMin, 120);
  const open = task.blocks.filter((b) => !b.completed);
  assert.deepStrictEqual(open.map((b) => (Date.parse(b.end) - Date.parse(b.start)) / MINUTE), [60]);
  assert.strictEqual(open.every((b) => b.id !== b1), true);
});

test('T-API-14: missed block is re-planned, deletable, future unpinned block is not', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const id = await postTask(api, { title: 'A', durationMin: 60 });
  let rows = await taskRows(api, id);
  assert.deepStrictEqual(rows.map((r) => [iso(r.start), iso(r.end)]), [['2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z']]);
  const oldId = rows[0].blockId;
  clock = C0 + 2 * DAY;
  assert.strictEqual((await api('POST', '/api/schedule/run')).status, 200);
  rows = await taskRows(api, id);
  assert.deepStrictEqual(rows.map((r) => [r.blockId === oldId, iso(r.start), iso(r.end), r.missed, r.partCount]), [
    [true, '2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z', true, 2],
    [false, '2026-10-21T10:00:00.000Z', '2026-10-21T11:00:00.000Z', false, 2],
  ]);
  assert.strictEqual((await api('DELETE', `/api/blocks/${oldId}`)).status, 204);
  rows = await taskRows(api, id);
  assert.deepStrictEqual(rows.filter((r) => r.blockId === oldId), []);
  rows = await taskRows(api, id);
  const future = rows.filter((r) => !r.completed && Date.parse(r.start) >= clock);
  assert.strictEqual(future.length, 1);
  assert.strictEqual((await api('DELETE', `/api/blocks/${future[0].blockId}`)).status, 409);
});

test('T-API-15: tight hard deadline within margin', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const id = await postTask(api, { title: 'Tight', durationMin: 60, deadline: '2026-10-19T11:30:00.000Z', deadlineType: 'hard' });
  const task = (await api('GET', `/api/tasks/${id}`)).body;
  assert.deepStrictEqual(task.blocks.map((b) => [iso(b.start), iso(b.end)]), [['2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z']]);
  assert.deepStrictEqual([task.status.state, task.status.slackMin], ['tight', 30]);
  assert.strictEqual((await api('GET', '/api/status')).body.tight[0].taskId, id);
});

test('T-API-16: recurring occurrence ticked done via agenda path', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const r = await api('POST', '/api/recurring', REC);
  assert.strictEqual(r.status, 201);
  const rid = r.body.id;
  const pick = (rows) => rows.filter((x) => x.recurringId === rid && x.occurrenceDate === '2026-10-19');
  const rows = (await api('GET', '/api/agenda')).body.rows;
  assert.deepStrictEqual(pick(rows).map((x) => [x.kind, iso(x.start), iso(x.end)]), [['recurring', '2026-10-19T10:00:00.000Z', '2026-10-19T10:30:00.000Z']]);
  clock = C0 + 15 * MINUTE;
  assert.strictEqual((await api('POST', `/api/recurring/${rid}/occurrences/2026-10-19/done`)).status, 204);
  assert.deepStrictEqual(pick((await api('GET', '/api/agenda')).body.rows).map((x) => x.done), [true]);
});

test('T-API-17: completed block credit survives pruning', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const id = await postTask(api, { title: 'Keep', durationMin: 120, maxBlockMin: 60 });
  const sorted = async () => sortBlocks((await api('GET', `/api/tasks/${id}`)).body.blocks);
  let blocks = await sorted();
  assert.deepStrictEqual(blocks.map((b) => [iso(b.start), iso(b.end)]), [
    ['2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z'],
    ['2026-10-19T11:15:00.000Z', '2026-10-19T12:15:00.000Z'],
  ]);
  assert.strictEqual((await api('PATCH', `/api/blocks/${blocks[0].id}`, { completed: true })).status, 200);
  blocks = await sorted();
  assert.deepStrictEqual(blocks.filter((b) => !b.completed).map((b) => [iso(b.start), iso(b.end)]), [
    ['2026-10-19T11:00:00.000Z', '2026-10-19T12:00:00.000Z'],
  ]);
  clock = Date.parse('2026-11-19T11:00:00Z');
  assert.strictEqual((await api('POST', '/api/schedule/run')).status, 200);
  const task = (await api('GET', `/api/tasks/${id}`)).body;
  assert.strictEqual(task.creditedMin, 60);
  assert.deepStrictEqual(sortBlocks(task.blocks).map((b) => [iso(b.start), iso(b.end), b.completed]), [
    ['2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z', true],
    ['2026-11-19T11:00:00.000Z', '2026-11-19T12:00:00.000Z', false],
  ]);
});

test('T-API-18: passed unticked recurring occurrence is skipped, not re-planned', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const rr = await api('POST', '/api/recurring', REC); assert.strictEqual(rr.status, 201); const rid = rr.body.id;
  const R2 = calUrl(Date.parse('2026-10-19T00:00:00Z'), Date.parse('2026-10-21T00:00:00Z'));
  const recBlocks = async () => sortBlocks((await api('GET', R2)).body.blocks.filter((b) => b.kind === 'recurring'));
  assert.deepStrictEqual((await recBlocks()).map((b) => [b.occurrenceDate, iso(b.start), iso(b.end)]), [
    ['2026-10-19', '2026-10-19T10:00:00.000Z', '2026-10-19T10:30:00.000Z'],
    ['2026-10-20', '2026-10-20T00:00:00.000Z', '2026-10-20T00:30:00.000Z'],
  ]);
  clock = C0 + 60 * MINUTE;
  const run = await api('POST', '/api/schedule/run');
  assert.strictEqual(run.status, 200);
  assert.deepStrictEqual((await recBlocks()).map((b) => [b.occurrenceDate, iso(b.start), iso(b.end), b.missed]), [
    ['2026-10-19', '2026-10-19T10:00:00.000Z', '2026-10-19T10:30:00.000Z', true],
    ['2026-10-20', '2026-10-20T00:00:00.000Z', '2026-10-20T00:30:00.000Z', false],
  ]);
  assert.deepStrictEqual(run.body.atRisk.filter((a) => a.recurringId === rid && a.occurrenceDate === '2026-10-19'), []);
});

test('T-API-19: TaskStatus fields', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const id = await postTask(api, { title: 'Due', durationMin: 60, deadline: '2026-10-20T10:00:00.000Z', deadlineType: 'hard' });
  const s = (await api('GET', `/api/tasks/${id}`)).body.status;
  const keys = ['state', 'deadline', 'deadlineType', 'plannedEnd', 'scheduledMin', 'unscheduledMin', 'creditedMin', 'slackMin'];
  assert.deepStrictEqual(Object.fromEntries(keys.map((k) => [k, s[k]])), {
    state: 'ok', deadline: '2026-10-20T10:00:00.000Z', deadlineType: 'hard', plannedEnd: '2026-10-19T11:00:00.000Z',
    scheduledMin: 60, unscheduledMin: 0, creditedMin: 0, slackMin: 1380,
  });
});

test('T-API-20: skipped recurring occurrence in agenda, undeletable, tick later marks done', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const rr = await api('POST', '/api/recurring', REC); assert.strictEqual(rr.status, 201); const rid = rr.body.id;
  const R2 = calUrl(Date.parse('2026-10-19T00:00:00Z'), Date.parse('2026-10-21T00:00:00Z'));
  clock = C0 + 60 * MINUTE;
  assert.strictEqual((await api('POST', '/api/schedule/run')).status, 200);
  const pick = async () => (await api('GET', '/api/agenda')).body.rows.filter((x) => x.recurringId === rid && x.occurrenceDate === '2026-10-19');
  const rows = await pick();
  assert.deepStrictEqual(rows.map((x) => [x.missed, x.riskState]), [[true, 'ok']]);
  const blockId = rows[0].blockId;
  assert.strictEqual((await api('DELETE', `/api/blocks/${blockId}`)).status, 409);
  assert.strictEqual((await api('POST', `/api/recurring/${rid}/occurrences/2026-10-19/done`)).status, 204);
  assert.deepStrictEqual((await pick()).map((x) => [x.done, x.missed, x.riskState]), [[true, false, 'none']]);
  const blocks = sortBlocks((await api('GET', R2)).body.blocks.filter((b) => b.kind === 'recurring' && b.occurrenceDate === '2026-10-19'));
  assert.deepStrictEqual(blocks.map((b) => [iso(b.start), iso(b.end)]), [['2026-10-19T10:00:00.000Z', '2026-10-19T10:30:00.000Z']]);
});

// ---------- T-API-X (extra API cases) ----------

test('T-API-X1: AC-SET every out-of-range setting is rejected with its key', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const cases = [
    [{ timezone: 'Mars/Olympus_Mons' }, 'timezone'],
    [{ workHours: { ...WH24, '1': [['17:00', '09:00']] } }, 'workHours'],
    [{ defaultMinBlockMin: 20 }, 'defaultMinBlockMin'],
    [{ defaultMinBlockMin: 255 }, 'defaultMinBlockMin'],
    [{ breakMin: 61 }, 'breakMin'],
    [{ breakIntervalMin: 15 }, 'breakIntervalMin'],
    [{ meetingBufferMin: 61 }, 'meetingBufferMin'],
    [{ horizonDays: 3 }, 'horizonDays'],
    [{ horizonDays: 91 }, 'horizonDays'],
    [{ hardDeadlineMarginMin: 10 }, 'hardDeadlineMarginMin'],
    [{ hardDeadlineMarginMin: 1500 }, 'hardDeadlineMarginMin'],
    [{ allDayEventsBlock: 'yes' }, 'allDayEventsBlock'],
    [{ icsRefreshMinutes: 4 }, 'icsRefreshMinutes'],
    [{ weekStartsOn: 2 }, 'weekStartsOn'],
  ];
  for (const [body, key] of cases) bad400(await api('PUT', '/api/settings', body), key);
  const ok = await api('PUT', '/api/settings', { hardDeadlineMarginMin: 0 });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.hardDeadlineMarginMin, 0);
});

test('T-API-X2: calendar range longer than 62 days is rejected', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  assert.strictEqual((await api('GET', calUrl(C0, C0 + 63 * DAY))).status, 400);
  assert.strictEqual((await api('GET', calUrl(C0, C0 + 62 * DAY))).status, 200);
});

test('T-API-X3: two concurrent mutations are both reflected in the final Status', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  const [a, b] = await Promise.all([
    api('POST', '/api/tasks', { title: 'Concurrent A', durationMin: 60 }),
    api('POST', '/api/tasks', { title: 'Concurrent B', durationMin: 60 }),
  ]);
  assert.strictEqual(a.status, 201);
  assert.strictEqual(b.status, 201);
  const ids = [a.body.id, b.body.id].sort((x, y) => x - y);
  assert.deepStrictEqual((await api('GET', '/api/status')).body.tasks.map((s) => s.taskId).sort((x, y) => x - y), ids);
  const blocks = sortBlocks((await api('GET', W7)).body.blocks);
  assert.deepStrictEqual(blocks.map((x) => [x.taskId, iso(x.start), iso(x.end)]), [
    [ids[0], '2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z'],
    [ids[1], '2026-10-19T11:00:00.000Z', '2026-10-19T12:00:00.000Z'],
  ]);
});

test('T-API-X4: session cookie attributes and HMAC value (S-2)', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp, AUTH_TOKEN: 's3cret' }), { now: () => clock });
  const api = await serve(t, created, tmp, { authorization: 'Bearer s3cret' });
  const login = await api('POST', '/api/auth/login', { password: 's3cret' });
  assert.strictEqual(login.status, 204);
  const cookies = login.headers.getSetCookie().filter((c) => c.startsWith('tactus_session='));
  assert.strictEqual(cookies.length, 1);
  const [pairPart, ...attrParts] = cookies[0].split(';').map((s) => s.trim());
  const value = pairPart.slice('tactus_session='.length);
  assert.strictEqual(value, crypto.createHmac('sha256', 's3cret').update('tactus-session-v1').digest('hex'));
  const attrs = {};
  for (const a of attrParts) {
    const i = a.indexOf('=');
    if (i < 0) attrs[a.toLowerCase()] = true;
    else attrs[a.slice(0, i).toLowerCase()] = a.slice(i + 1);
  }
  assert.strictEqual(attrs.httponly, true);
  assert.strictEqual(String(attrs.samesite).toLowerCase(), 'strict');
  assert.strictEqual(attrs.path, '/');
  assert.strictEqual(attrs['max-age'], '2592000');
  assert.strictEqual('secure' in attrs, false);
});

test('T-API-X5: TRUST_PROXY=1 sets express trust proxy (S-6)', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp, TRUST_PROXY: '1' }), { now: () => clock });
  t.after(async () => {
    created.scheduleService.stop(); created.calendarSync.stop(); await created.repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  assert.strictEqual(created.app.get('trust proxy'), 1);
});

test('T-API-X6: recurring validation', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  bad400(await api('POST', '/api/recurring', { ...REC, frequency: 'weekly', daysOfWeek: [7] }), 'daysOfWeek');
  bad400(await api('POST', '/api/recurring', { ...REC, minBlockMin: 20 }), 'minBlockMin');
  bad400(await api('POST', '/api/recurring', { ...REC, frequency: 'weekly', daysOfWeek: [], durationMin: 2415 }), 'durationMin');
  bad400(await api('POST', '/api/recurring', { ...REC, frequency: 'monthly', dayOfMonth: 32 }), 'dayOfMonth');
  bad400(await api('POST', '/api/recurring', { ...REC, durationMin: 490 }), 'durationMin');
});

test('T-API-X7: completing a recurring block is rejected', async (t) => {
  const { createApp, loadConfig } = appModules();
  const tmp = mkTmp();
  let clock = C0;
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => clock });
  const api = await serve(t, created, tmp);
  assert.strictEqual((await api('POST', '/api/recurring', REC)).status, 201);
  const blocks = (await api('GET', calUrl(C0, C0 + DAY))).body.blocks;
  const block = blocks.find((b) => b.occurrenceDate === '2026-10-19');
  assert.strictEqual((await api('PATCH', `/api/blocks/${block.id}`, { completed: true })).status, 400);
});
