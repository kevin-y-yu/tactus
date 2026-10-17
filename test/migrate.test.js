// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 17 oracle for T-V2-MIG-1..3 — spec-v2 §V1 (V2-D1, migration 1) "Acceptance".
// v1 database files are built from the exported base DDL with raw node:sqlite (like T-DATA). Assertions marked
// "planner-added" follow from V2-D1 (every step guarded).
// Do not edit expectations.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, DDL } = require('../lib/db.js');

const TS = '2026-10-01T00:00:00.000Z';
const MON_ONLY = { '0': [], '1': [['10:00', '14:00']], '2': [], '3': [], '4': [], '5': [], '6': [] };
const WH = [['09:00', '12:30'], ['13:30', '17:30']];
const V1_DEFAULT = { '0': [], '1': WH, '2': WH, '3': WH, '4': WH, '5': WH, '6': [] };
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tactus-test-'));

function env(t) {
  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'tactus.db');
  const repos = [];
  t.after(async () => {
    for (const r of repos) await r.close();   // close() is idempotent
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { dbPath, open: async () => { const r = await openDb(dbPath); repos.push(r); return r; } };
}

// A v1 database: base DDL, Inbox, settings row workHours = Mon 10:00-14:00 only, one task.
function buildV1(dbPath) {
  const raw = new DatabaseSync(dbPath);
  raw.exec(DDL);
  raw.prepare("INSERT INTO projects (id, name, color, sort_order, archived, created_at) VALUES (1, 'Inbox', '#4f7cff', 0, 0, ?)").run(TS);
  raw.prepare("INSERT INTO settings (key, value) VALUES ('workHours', ?)").run(JSON.stringify(MON_ONLY));
  raw.prepare("INSERT INTO tasks (project_id, title, duration_min, created_at, updated_at) VALUES (1, 'Old task', 60, ?, ?)").run(TS, TS);
  raw.close();
}

function inspect(dbPath) {
  const raw = new DatabaseSync(dbPath);
  try {
    return {
      version: Number(raw.prepare('PRAGMA user_version').get().user_version),
      cols: Object.fromEntries(['tasks', 'projects', 'recurring']
        .map((t) => [t, raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)])),
      workHoursRow: raw.prepare("SELECT value FROM settings WHERE key = 'workHours'").get() ?? null,
      scheduleCount: Number(raw.prepare('SELECT COUNT(*) AS n FROM schedules').get().n),
    };
  } finally {
    raw.close();
  }
}

const core = (s) => ({ id: s.id, name: s.name, color: s.color, hours: s.hours });

test('T-V2-MIG-1: a v1 database migrates: workHours becomes schedule 1 "Work", schedule_id columns, version 4', async (t) => {
  const e = env(t);
  buildV1(e.dbPath);
  const repo = await e.open();
  const list = await repo.listSchedules();
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(core(list[0]), { id: 1, name: 'Work', color: '#1a73e8', hours: MON_ONLY });
  assert.strictEqual(typeof list[0].createdAt, 'string');
  const s = await repo.getSettings();
  assert.deepStrictEqual(s.workHours, MON_ONLY);
  assert.strictEqual(s.defaultScheduleId, 1);
  const i = inspect(e.dbPath);
  assert.strictEqual(i.version, 4);
  for (const tbl of ['tasks', 'projects', 'recurring']) assert.ok(i.cols[tbl].includes('schedule_id'), `${tbl}.schedule_id`);
  assert.strictEqual(i.workHoursRow, null);
  const tasks = await repo.listTasks();
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].title, 'Old task');
  assert.strictEqual(tasks[0].scheduleId, null);
  // migration 3: the Inbox project is gone and its task is standalone; getSchedule(1) matches the list row.
  assert.deepStrictEqual(await repo.listProjects(), []);
  assert.strictEqual(tasks[0].projectId, null);
  assert.deepStrictEqual(core(await repo.getSchedule(1)), core(list[0]));
});

test('T-V2-MIG-2: openDb twice on the same file is idempotent (one schedule, version 4)', async (t) => {
  const e = env(t);
  buildV1(e.dbPath);
  const first = await e.open();
  await first.close();
  const second = await e.open();
  const list = await second.listSchedules();
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(core(list[0]), { id: 1, name: 'Work', color: '#1a73e8', hours: MON_ONLY });
  let i = inspect(e.dbPath);
  assert.strictEqual(i.version, 4);
  assert.strictEqual(i.scheduleCount, 1);
  await second.close();
  // planner-added (V2-D1 "every step inside up is guarded"): a database whose version was reset to 0 after migration 1
  // re-runs it without error and without changing the schedule.
  const raw = new DatabaseSync(e.dbPath);
  raw.exec('PRAGMA user_version = 0');
  raw.close();
  const third = await e.open();
  const again = await third.listSchedules();
  assert.strictEqual(again.length, 1);
  assert.deepStrictEqual(core(again[0]), { id: 1, name: 'Work', color: '#1a73e8', hours: MON_ONLY });
  i = inspect(e.dbPath);
  assert.strictEqual(i.version, 4);
  assert.strictEqual(i.scheduleCount, 1);
});

test('T-V2-MIG-3: a fresh database gets one schedule "Work" with the v1 default hours', async (t) => {
  const e = env(t);
  const repo = await e.open();
  const list = await repo.listSchedules();
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(core(list[0]), { id: 1, name: 'Work', color: '#1a73e8', hours: V1_DEFAULT });
  const s = await repo.getSettings();
  assert.deepStrictEqual(s.workHours, V1_DEFAULT);
  assert.strictEqual(s.defaultScheduleId, 1);
  const i = inspect(e.dbPath);
  assert.strictEqual(i.version, 4);
  assert.strictEqual(i.workHoursRow, null);
});
