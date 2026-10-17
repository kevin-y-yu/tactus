// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { planDoneMove } = require('./doneMove.js');

const WH = [['09:00', '12:30'], ['13:30', '17:30']];
const DEFAULT_SETTINGS = {
  workHours: { '0': [], '1': WH, '2': WH, '3': WH, '4': WH, '5': WH, '6': [] },
  defaultMinBlockMin: 30, breakMin: 15, breakIntervalMin: 90, meetingBufferMin: 15, horizonDays: 28,
  hardDeadlineMarginMin: 120, allDayEventsBlock: false, icsRefreshMinutes: 15, weekStartsOn: 1,
  lunchMin: 0, lunchStart: '12:00', lunchEnd: '14:00', clock24: false,   // lunchMin 0 = no lunch
  defaultScheduleId: 1,   // v2 §R6 V2-D14; workHours above is only migration 1's fallback (getSettings reads the schedule)
};
const RECURRING_DEFAULT_COLOR = '#8e7cc3';
const SCHEDULE_DEFAULT_COLOR = '#1a73e8';

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);       -- JSON value
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4f7cff', sort_order INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stages (id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, sort_order INTEGER NOT NULL,
  deadline TEXT, deadline_type TEXT NOT NULL DEFAULT 'hard' CHECK (deadline_type IN ('hard','soft')), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  stage_id INTEGER REFERENCES stages(id) ON DELETE SET NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL, priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent','high','medium','low')),
  deadline TEXT, deadline_type TEXT NOT NULL DEFAULT 'hard' CHECK (deadline_type IN ('hard','soft')),
  start_after TEXT, min_block_min INTEGER, max_block_min INTEGER, dont_split INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done')), completed_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recurring (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekdays','weekly','monthly')),
  days_of_week TEXT NOT NULL DEFAULT '[]', day_of_month INTEGER, duration_min INTEGER NOT NULL, window_start TEXT, window_end TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent','high','medium','low')),
  start_date TEXT NOT NULL, end_date TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recurring_done (recurring_id INTEGER NOT NULL REFERENCES recurring(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL, completed_at TEXT NOT NULL, PRIMARY KEY (recurring_id, occurrence_date));
CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  recurring_id INTEGER REFERENCES recurring(id) ON DELETE CASCADE, occurrence_date TEXT,
  start TEXT NOT NULL, "end" TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
  CHECK ((task_id IS NULL) <> (recurring_id IS NULL)), CHECK (completed = 0 OR task_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_blocks_start ON blocks(start);
CREATE TABLE IF NOT EXISTS calendars (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'ics', url TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#9aa0a6', enabled INTEGER NOT NULL DEFAULT 1, blocking INTEGER NOT NULL DEFAULT 1,
  last_fetched_at TEXT, last_error TEXT, event_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE, uid TEXT NOT NULL, title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '', start TEXT NOT NULL, "end" TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0,
  start_date TEXT, end_date TEXT, transparent INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_events_range ON events(start, "end");
-- task_id is blocked by blocker_id (same project; enforced by the API). Cascades when either task is deleted.
CREATE TABLE IF NOT EXISTS task_dependencies (task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocker_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, PRIMARY KEY (task_id, blocker_id));
-- task is blocked by a calendar event instance (calendar, uid, start); title is cached for when the event disappears.
CREATE TABLE IF NOT EXISTS task_event_blocks (task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE, uid TEXT NOT NULL, event_start TEXT NOT NULL,
  title TEXT NOT NULL, PRIMARY KEY (task_id, calendar_id, uid, event_start));
-- the task must finish before this calendar event starts (the event's start acts as a hard deadline)
CREATE TABLE IF NOT EXISTS task_event_deadlines (task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE, uid TEXT NOT NULL, event_start TEXT NOT NULL,
  title TEXT NOT NULL, PRIMARY KEY (task_id, calendar_id, uid, event_start));
`;

// v2 §V1 migration 1 step 1 (schedules, R6). hours = JSON {"0".."6": [[start, end], ...]}.
const SCHEDULES_DDL = `
CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#1a73e8', hours TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_name ON schedules(name COLLATE NOCASE);
`;

const PROJECT = { id: ['id', 'int'], name: ['name', 'text'], color: ['color', 'text'], sortOrder: ['sort_order', 'int'], archived: ['archived', 'bool'], createdAt: ['created_at', 'iso'], scheduleId: ['schedule_id', 'int'] };
const STAGE = { id: ['id', 'int'], projectId: ['project_id', 'int'], name: ['name', 'text'], sortOrder: ['sort_order', 'int'], deadline: ['deadline', 'iso'], deadlineType: ['deadline_type', 'text'], createdAt: ['created_at', 'iso'] };
const TASK = { id: ['id', 'int'], projectId: ['project_id', 'int'], stageId: ['stage_id', 'int'], title: ['title', 'text'], notes: ['notes', 'text'], durationMin: ['duration_min', 'int'], priority: ['priority', 'text'], deadline: ['deadline', 'iso'], deadlineType: ['deadline_type', 'text'], startAfter: ['start_after', 'iso'], minBlockMin: ['min_block_min', 'int'], maxBlockMin: ['max_block_min', 'int'], dontSplit: ['dont_split', 'bool'], status: ['status', 'text'], completedAt: ['completed_at', 'iso'], sortOrder: ['sort_order', 'int'], createdAt: ['created_at', 'iso'], updatedAt: ['updated_at', 'iso'], scheduleId: ['schedule_id', 'int'] };
const RECURRING = { id: ['id', 'int'], title: ['title', 'text'], notes: ['notes', 'text'], projectId: ['project_id', 'int'], frequency: ['frequency', 'text'], daysOfWeek: ['days_of_week', 'json'], dayOfMonth: ['day_of_month', 'int'], durationMin: ['duration_min', 'int'], windowStart: ['window_start', 'text'], windowEnd: ['window_end', 'text'], priority: ['priority', 'text'], startDate: ['start_date', 'text'], endDate: ['end_date', 'text'], active: ['active', 'bool'], createdAt: ['created_at', 'iso'], updatedAt: ['updated_at', 'iso'], scheduleId: ['schedule_id', 'int'] , minBlockMin: ['min_block_min', 'int'], droppable: ['droppable', 'bool'] };
const CALENDAR = { id: ['id', 'int'], name: ['name', 'text'], provider: ['provider', 'text'], url: ['url', 'text'], color: ['color', 'text'], enabled: ['enabled', 'bool'], blocking: ['blocking', 'bool'], lastFetchedAt: ['last_fetched_at', 'iso'], lastError: ['last_error', 'text'], eventCount: ['event_count', 'int'], createdAt: ['created_at', 'iso'] };
const EVENT = { id: ['id', 'int'], calendarId: ['calendar_id', 'int'], uid: ['uid', 'text'], title: ['title', 'text'], location: ['location', 'text'], start: ['start', 'iso'], end: ['end', 'iso'], allDay: ['all_day', 'bool'], startDate: ['start_date', 'text'], endDate: ['end_date', 'text'], transparent: ['transparent', 'bool'] };
const BLOCK = { id: ['id', 'int'], taskId: ['task_id', 'int'], recurringId: ['recurring_id', 'int'], occurrenceDate: ['occurrence_date', 'text'], start: ['start', 'iso'], end: ['end', 'iso'], pinned: ['pinned', 'bool'], completed: ['completed', 'bool'] };
const SCHEDULE = { id: ['id', 'int'], name: ['name', 'text'], color: ['color', 'text'], hours: ['hours', 'json'], createdAt: ['created_at', 'iso'] };

const isoOf = (v) => new Date(v).toISOString(); // D1; throws RangeError on invalid input
const nowIso = () => isoOf(Date.now());
const stripUndef = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));

function enc(codec, v) { // D3
  if (v === undefined || v === null) return null;
  switch (codec) {
    case 'bool': return v ? 1 : 0;
    case 'json': return JSON.stringify(v);
    case 'iso': return isoOf(v);
    case 'int': return Number(v);
    default: return v;
  }
}
function dec(codec, v) {
  if (codec === 'bool') return v === 1;
  if (v === null || v === undefined) return null;
  if (codec === 'json') return JSON.parse(v);
  if (codec === 'int') return Number(v);
  return v;
}
function fromRow(spec, row) {
  if (!row) return null;
  const o = {};
  for (const [k, [col, c]] of Object.entries(spec)) o[k] = dec(c, row[col]);
  return o;
}
const bindVal = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

const BLOCK_SELECT = `SELECT b.id, b.task_id, b.recurring_id, b.occurrence_date, b.start, b."end", b.pinned, b.completed,
  CASE WHEN b.task_id IS NOT NULL THEN 'task' ELSE 'recurring' END AS kind,
  COALESCE(t.title, r.title) AS title,
  COALESCE(t.project_id, r.project_id) AS project_id,
  COALESCE(tp.color, rp.color, '${RECURRING_DEFAULT_COLOR}') AS color,
  CASE WHEN b.task_id IS NOT NULL THEN (t.status = 'done')
       ELSE EXISTS (SELECT 1 FROM recurring_done d WHERE d.recurring_id = b.recurring_id AND d.occurrence_date = b.occurrence_date) END AS done
FROM blocks b
LEFT JOIN tasks t ON t.id = b.task_id
LEFT JOIN projects tp ON tp.id = t.project_id
LEFT JOIN recurring r ON r.id = b.recurring_id
LEFT JOIN projects rp ON rp.id = r.project_id`;

const nullableInt = (v) => (v === null || v === undefined ? null : Number(v));
function blockFromRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    kind: r.kind,
    taskId: nullableInt(r.task_id),
    recurringId: nullableInt(r.recurring_id),
    occurrenceDate: r.occurrence_date ?? null,
    start: r.start,
    end: r.end,
    pinned: r.pinned === 1,
    completed: r.completed === 1,
    title: r.title ?? null,
    color: r.color,
    projectId: nullableInt(r.project_id),
    done: r.done === 1,
  };
}

async function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(DDL);

  let closed = false;
  const cache = new Map();
  const prep = (sql) => {
    let st = cache.get(sql);
    if (!st) { st = db.prepare(sql); cache.set(sql, st); }
    return st;
  };
  const all = (sql, ...a) => prep(sql).all(...a.map(bindVal));
  const one = (sql, ...a) => prep(sql).get(...a.map(bindVal)) ?? null;
  const run = (sql, ...a) => prep(sql).run(...a.map(bindVal));

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* ignore rollback errors */ }
      throw e;
    }
  }

  function insertRow(table, spec, obj) {
    const keys = Object.keys(spec).filter((k) => k !== 'id' && obj[k] !== undefined);
    const cols = keys.map((k) => `"${spec[k][0]}"`).join(', ');
    const marks = keys.map(() => '?').join(', ');
    const vals = keys.map((k) => enc(spec[k][1], obj[k]));
    const res = run(`INSERT INTO ${table} (${cols}) VALUES (${marks})`, ...vals);
    return Number(res.lastInsertRowid);
  }

  function updateRow(table, spec, id, patch, allowed) {
    const keys = allowed.filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return 0;
    const sets = keys.map((k) => `"${spec[k][0]}" = ?`).join(', ');
    const vals = keys.map((k) => enc(spec[k][1], patch[k]));
    return run(`UPDATE ${table} SET ${sets} WHERE id = ?`, ...vals, id).changes;
  }

  function deleteRow(table, id) {
    return run(`DELETE FROM ${table} WHERE id = ?`, id).changes > 0;
  }

  // Tasks and recurring rules: writes only the spec keys, always stamps updated_at.
  function patchTimed(table, spec, id, p) {
    const allowed = Object.keys(spec).filter((k) => !['id', 'createdAt', 'updatedAt'].includes(k));
    if (!allowed.some((k) => p[k] !== undefined)) return;
    updateRow(table, spec, id, { ...p, updatedAt: p.updatedAt ?? nowIso() }, [...allowed, 'updatedAt']);
  }

  // ----- seeds (D8) -----
  tx(() => {
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
      'timezone', JSON.stringify(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
  });

  // ----- migrations (v2 §V1 V2-D1): after seeds; one transaction per migration incl. user_version; every step guarded -----
  const currentDefaultId = () => {
    const row = one("SELECT value FROM settings WHERE key = 'defaultScheduleId'");
    return row ? JSON.parse(row.value) : DEFAULT_SETTINGS.defaultScheduleId;
  };
  function migration1() {   // schedules (R6)
    db.exec(SCHEDULES_DDL);
    for (const t of ['tasks', 'projects', 'recurring']) {
      if (!all(`PRAGMA table_info(${t})`).some((c) => c.name === 'schedule_id')) {
        db.exec(`ALTER TABLE ${t} ADD COLUMN schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL`);
      }
    }
    if (Number(one('SELECT COUNT(*) AS n FROM schedules').n) === 0) {
      const wh = one("SELECT value FROM settings WHERE key = 'workHours'");
      run('INSERT INTO schedules (id, name, color, hours, created_at) VALUES (1, ?, ?, ?, ?)',
        'Work', SCHEDULE_DEFAULT_COLOR, wh ? wh.value : JSON.stringify(DEFAULT_SETTINGS.workHours), nowIso());
    }
    run("DELETE FROM settings WHERE key = 'workHours'");   // the schedule is now the source of truth
  }
  function migration2() {   // per-recurring-task minimum block length (null = the global default)
    if (!all('PRAGMA table_info(recurring)').some((c) => c.name === 'min_block_min')) {
      db.exec('ALTER TABLE recurring ADD COLUMN min_block_min INTEGER');
    }
  }
  function migration4() {   // low-priority recurring tasks may be dropped to meet a deadline
    if (!all('PRAGMA table_info(recurring)').some((c) => c.name === 'droppable')) {
      db.exec('ALTER TABLE recurring ADD COLUMN droppable INTEGER NOT NULL DEFAULT 0');
    }
  }
  function migration3() {   // standalone tasks: tasks.project_id becomes nullable; the Inbox project is removed
    const cols = all('PRAGMA table_info(tasks)');
    const projectCol = cols.find((c) => c.name === 'project_id');
    if (projectCol && Number(projectCol.notnull) === 1) {      // table rebuild (SQLite cannot drop NOT NULL); foreign keys are off
      const names = cols.map((c) => `"${c.name}"`).join(', ');
      const ddl = one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").sql
        .replace('CREATE TABLE tasks', 'CREATE TABLE tasks_new').replace('CREATE TABLE "tasks"', 'CREATE TABLE tasks_new')
        .replace(/project_id INTEGER NOT NULL/, 'project_id INTEGER');
      db.exec(ddl);
      db.exec(`INSERT INTO tasks_new (${names}) SELECT ${names} FROM tasks`);
      db.exec('DROP TABLE tasks');
      db.exec('ALTER TABLE tasks_new RENAME TO tasks');
    }
    const inbox = one("SELECT id FROM projects WHERE id = 1 AND name = 'Inbox'");
    if (inbox) {
      run('UPDATE tasks SET project_id = NULL, stage_id = NULL WHERE project_id = 1');
      run('UPDATE recurring SET project_id = NULL WHERE project_id = 1');
      run('DELETE FROM stages WHERE project_id = 1');
      run('DELETE FROM projects WHERE id = 1');
    }
  }
  const MIGRATIONS = [{ version: 1, up: migration1 }, { version: 2, up: migration2 }, { version: 3, up: migration3, fkOff: true }, { version: 4, up: migration4 }];   // append-only, ascending
  const dbVersion = Number(one('PRAGMA user_version').user_version);
  for (const m of MIGRATIONS) {
    if (m.version <= dbVersion) continue;
    if (m.fkOff) db.exec('PRAGMA foreign_keys = OFF');   // a no-op inside a transaction, so it is set around it
    try { tx(() => { m.up(); db.exec(`PRAGMA user_version = ${m.version}`); }); }
    finally { if (m.fkOff) db.exec('PRAGMA foreign_keys = ON'); }
  }

  // ----- helpers for Steps 2-4 -----
  const stageOf = (r) => fromRow(STAGE, r);
  const projectsWithStages = (rows) => {
    const stages = all('SELECT * FROM stages ORDER BY sort_order, id').map(stageOf);
    return rows.map((r) => {
      const p = fromRow(PROJECT, r);
      p.stages = stages.filter((s) => s.projectId === p.id);
      return p;
    });
  };
  const getBlockRow = (id) => blockFromRow(one(`${BLOCK_SELECT} WHERE b.id = ?`, id));
  const getTaskRow = (id) => fromRow(TASK, one('SELECT * FROM tasks WHERE id = ?', id));
  const getRecurringRow = (id) => fromRow(RECURRING, one('SELECT * FROM recurring WHERE id = ?', id));
  const getCalendarRow = (id) => fromRow(CALENDAR, one('SELECT * FROM calendars WHERE id = ?', id));
  const getScheduleRow = (id) => fromRow(SCHEDULE, one('SELECT * FROM schedules WHERE id = ?', id));
  const getStageRow = (id) => stageOf(one('SELECT * FROM stages WHERE id = ?', id));
  const getProjectRow = (id) => {
    const r = one('SELECT * FROM projects WHERE id = ?', id);
    if (!r) return null;
    const p = fromRow(PROJECT, r);
    p.stages = all('SELECT * FROM stages WHERE project_id = ? ORDER BY sort_order, id', id).map(stageOf);
    return p;
  };

  const TASK_DEFAULTS = { projectId: null, stageId: null, notes: '', durationMin: 60, priority: 'medium', deadline: null, deadlineType: 'hard', startAfter: null, minBlockMin: null, maxBlockMin: null, dontSplit: false, status: 'todo', completedAt: null, sortOrder: 0, scheduleId: null };
  const RECURRING_DEFAULTS = { notes: '', projectId: null, daysOfWeek: [], dayOfMonth: null, windowStart: null, windowEnd: null, priority: 'medium', endDate: null, active: true, scheduleId: null, minBlockMin: null, droppable: false };
  const CALENDAR_DEFAULTS = { provider: 'ics', color: '#9aa0a6', enabled: true, blocking: true, lastFetchedAt: null, lastError: null, eventCount: 0 };
  const EVENT_DEFAULTS = { location: '', allDay: false, startDate: null, endDate: null, transparent: false };

  const repo = {
    // ----- Step 1: lifecycle, settings, meta -----
    close: async () => {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
    // v2 §R6 V2-D14: workHours is the default schedule's hours (alias), never a settings row.
    getSettings: async () => {
      const rows = all('SELECT key, value FROM settings');
      const s = { ...structuredClone(DEFAULT_SETTINGS), ...Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) };
      const def = one('SELECT hours FROM schedules WHERE id = ?', s.defaultScheduleId);
      if (!def) throw new Error(`default schedule ${s.defaultScheduleId} not found`);
      s.workHours = JSON.parse(def.hours);
      return s;
    },
    // Other keys first (so a new defaultScheduleId is set first), then workHours goes to the (new) default schedule.
    saveSettings: async (s) => {
      tx(() => {
        for (const [k, v] of Object.entries(s)) {
          if (v === undefined || k === 'workHours') continue;
          run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
        }
        if (s.workHours !== undefined) {
          const id = currentDefaultId();
          if (run('UPDATE schedules SET hours = ? WHERE id = ?', JSON.stringify(s.workHours), id).changes !== 1) {
            throw new Error(`default schedule ${id} not found`);
          }
        }
      });
      return repo.getSettings();
    },
    getMeta: async (k) => {
      const row = one('SELECT value FROM meta WHERE key = ?', k);
      return row ? JSON.parse(row.value) : null;
    },
    setMeta: async (k, v) => {
      run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v ?? null));
    },

    // ----- Step 2: projects, stages, tasks, recurring, occurrence-done -----
    listProjects: async () => projectsWithStages(all('SELECT * FROM projects ORDER BY sort_order, id')),
    getProject: async (id) => getProjectRow(id),
    createProject: async (d) => {
      const sortOrder = one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM projects').n;
      const id = insertRow('projects', PROJECT, {
        color: '#4f7cff', archived: false, ...stripUndef(d), sortOrder, createdAt: d.createdAt ?? nowIso(),
      });
      return getProjectRow(id);
    },
    updateProject: async (id, p) => {
      updateRow('projects', PROJECT, id, p, ['name', 'color', 'sortOrder', 'archived', 'scheduleId']);
      return getProjectRow(id);
    },
    deleteProject: async (id) => {
      return deleteRow('projects', id);
    },
    getStage: async (id) => getStageRow(id),
    createStage: async (projectId, d) => {
      const sortOrder = one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM stages WHERE project_id = ?', projectId).n;
      const id = insertRow('stages', STAGE, {
        deadline: null, deadlineType: 'hard', ...stripUndef(d), projectId: Number(projectId), sortOrder, createdAt: d.createdAt ?? nowIso(),
      });
      return getStageRow(id);
    },
    updateStage: async (id, p) => {
      updateRow('stages', STAGE, id, p, ['name', 'deadline', 'deadlineType', 'sortOrder']);
      return getStageRow(id);
    },
    setStageTasksDeadline: async (stageId, deadline, deadlineType) => {
      run("UPDATE tasks SET deadline = ?, deadline_type = ?, updated_at = ? WHERE stage_id = ? AND status = 'todo'", deadline, deadlineType, nowIso(), stageId);
    },
    deleteStage: async (id) => deleteRow('stages', id),
    reorderStages: async (projectId, ids) => {
      tx(() => {
        ids.forEach((sid, i) => run('UPDATE stages SET sort_order = ? WHERE id = ? AND project_id = ?', i, sid, projectId));
      });
      return all('SELECT * FROM stages WHERE project_id = ? ORDER BY sort_order, id', projectId).map(stageOf);
    },
    listTasks: async (f = {}) => {
      const pid = f.projectId ?? null;
      const st = f.status ?? null;
      return all(`SELECT t.* FROM tasks t LEFT JOIN stages s ON s.id = t.stage_id
        WHERE (? IS NULL OR t.project_id = ?) AND (? IS NULL OR t.status = ?)
        ORDER BY t.project_id, s.sort_order IS NULL, s.sort_order, t.sort_order, t.id`, pid, pid, st, st).map((r) => fromRow(TASK, r));
    },
    getTask: async (id) => getTaskRow(id),
    createTask: async (d) => {
      const createdAt = d.createdAt ?? nowIso();
      const id = insertRow('tasks', TASK, { ...TASK_DEFAULTS, ...stripUndef(d), createdAt, updatedAt: d.updatedAt ?? createdAt });
      return getTaskRow(id);
    },
    updateTask: async (id, p) => {
      patchTimed('tasks', TASK, id, p);
      return getTaskRow(id);
    },
    deleteTask: async (id) => deleteRow('tasks', id),
    // ----- task links: blocked-by tasks (same project) and blocked-by calendar events -----
    listTaskDependencies: async () => all('SELECT task_id, blocker_id FROM task_dependencies ORDER BY task_id, blocker_id')
      .map((r) => ({ taskId: Number(r.task_id), blockerId: Number(r.blocker_id) })),
    // event links (kind 'after' = task starts after the event ends, 'before' = task must finish before the event starts)
    // with the event's live times, or stale when the event is no longer in its calendar
    listTaskEventLinks: async (taskId = null, kind = 'after') => all(`SELECT l.task_id, l.calendar_id, l.uid, l.event_start, l.title,
        e.start AS e_start, e."end" AS e_end, e.all_day, e.end_date, e.title AS e_title
        FROM ${kind === 'before' ? 'task_event_deadlines' : 'task_event_blocks'} l
        LEFT JOIN events e ON e.calendar_id = l.calendar_id AND e.uid = l.uid AND e.start = l.event_start
        WHERE (? IS NULL OR l.task_id = ?) ORDER BY l.task_id, l.event_start`, taskId, taskId).map((r) => ({
      taskId: Number(r.task_id), calendarId: Number(r.calendar_id), uid: r.uid, start: r.event_start,
      title: r.e_title ?? r.title, end: r.e_end ?? null, allDay: r.e_end != null ? r.all_day === 1 : false, endDate: r.end_date ?? null,
      stale: r.e_start == null })),
    getEventInstance: async (calendarId, uid, start) => one('SELECT id, title FROM events WHERE calendar_id = ? AND uid = ? AND start = ?', calendarId, uid, start),
    setTaskLinks: async (taskId, { blockerIds, events, deadlineEvents }) => tx(() => {
      run('DELETE FROM task_dependencies WHERE task_id = ?', taskId);
      run('DELETE FROM task_event_blocks WHERE task_id = ?', taskId);
      run('DELETE FROM task_event_deadlines WHERE task_id = ?', taskId);
      for (const e of deadlineEvents) {
        run('INSERT INTO task_event_deadlines (task_id, calendar_id, uid, event_start, title) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
          taskId, e.calendarId, e.uid, e.start, e.title);
      }
      for (const b of blockerIds) run('INSERT INTO task_dependencies (task_id, blocker_id) VALUES (?, ?)', taskId, b);
      for (const e of events) {
        run('INSERT INTO task_event_blocks (task_id, calendar_id, uid, event_start, title) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
          taskId, e.calendarId, e.uid, e.start, e.title);
      }
    }),
    // makes exactly `ids` the tasks blocked by taskId (each blocked task keeps its other blockers)
    setBlocking: async (taskId, ids) => tx(() => {
      run(`DELETE FROM task_dependencies WHERE blocker_id = ?${ids.length ? ` AND task_id NOT IN (${ids.map(() => '?').join(',')})` : ''}`, taskId, ...ids);
      for (const id of ids) run('INSERT OR IGNORE INTO task_dependencies (task_id, blocker_id) VALUES (?, ?)', id, taskId);
    }),
    // drop dependency links between tasks that no longer share a project (after a move)
    pruneTaskDependencies: async (taskId) => run(`DELETE FROM task_dependencies WHERE (task_id = ? OR blocker_id = ?) AND NOT EXISTS (
        SELECT 1 FROM tasks a JOIN tasks b ON a.project_id IS NOT NULL AND a.project_id = b.project_id
        WHERE a.id = task_dependencies.task_id AND b.id = task_dependencies.blocker_id)`, taskId, taskId).changes,
    listTasksForScheduling: async () => all(`SELECT t.*, s.sort_order AS stage_sort_order, s.deadline AS stage_deadline, s.deadline_type AS stage_deadline_type,
        p.schedule_id AS project_schedule_id
        FROM tasks t LEFT JOIN stages s ON s.id = t.stage_id LEFT JOIN projects p ON p.id = t.project_id WHERE t.status = 'todo'
        ORDER BY t.project_id, s.sort_order IS NULL, s.sort_order, t.sort_order, t.id`).map((r) => ({
      ...fromRow(TASK, r),
      projectScheduleId: nullableInt(r.project_schedule_id),
      stageSortOrder: r.stage_sort_order === null ? null : Number(r.stage_sort_order),
      stageDeadline: r.stage_deadline ?? null,
      stageDeadlineType: r.stage_deadline_type ?? null,
    })),
    listRecurring: async () => all('SELECT * FROM recurring ORDER BY id').map((r) => fromRow(RECURRING, r)),
    getRecurring: async (id) => getRecurringRow(id),
    createRecurring: async (d) => {
      const createdAt = d.createdAt ?? nowIso();
      const id = insertRow('recurring', RECURRING, { ...RECURRING_DEFAULTS, ...stripUndef(d), createdAt, updatedAt: d.updatedAt ?? createdAt });
      return getRecurringRow(id);
    },
    updateRecurring: async (id, p) => {
      patchTimed('recurring', RECURRING, id, p);
      return getRecurringRow(id);
    },
    deleteRecurring: async (id) => deleteRow('recurring', id),
    listOccurrenceDone: async (fromDate) => all(
      'SELECT recurring_id, occurrence_date, completed_at FROM recurring_done WHERE occurrence_date >= ? ORDER BY recurring_id, occurrence_date',
      fromDate ?? '0000-01-01',
    ).map((r) => ({ recurringId: Number(r.recurring_id), occurrenceDate: r.occurrence_date, completedAt: r.completed_at })),
    setOccurrenceDone: async (recurringId, date, done) => {
      if (done) {
        run('INSERT INTO recurring_done (recurring_id, occurrence_date, completed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
          recurringId, date, nowIso());
      } else {
        run('DELETE FROM recurring_done WHERE recurring_id = ? AND occurrence_date = ?', recurringId, date);
      }
    },

    // ----- Step 3: blocks -----
    listBlocksInRange: async (fromIso, toIso) => all(`${BLOCK_SELECT} WHERE b.start < ? AND b."end" > ? ORDER BY b.start, b.id`,
      isoOf(toIso), isoOf(fromIso)).map(blockFromRow),
    listBlocksForTask: async (taskId) => all(`${BLOCK_SELECT} WHERE b.task_id = ? ORDER BY b.start, b.id`, taskId).map(blockFromRow),
    listFixedBlocks: async (nowIsoArg) => {
      const now = isoOf(nowIsoArg);
      return all(`${BLOCK_SELECT} WHERE (b.completed = 1 OR (b."end" > ? AND (b.pinned = 1 OR b.start < ?)))
        AND ((b.task_id IS NOT NULL AND t.status = 'todo')
          OR (b.recurring_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recurring_done d2 WHERE d2.recurring_id = b.recurring_id AND d2.occurrence_date = b.occurrence_date)))
        ORDER BY b.start, b.id`, now, now).map(blockFromRow);
    },
    getBlock: async (id) => getBlockRow(id),
    createPinnedBlock: async (d) => {
      const id = insertRow('blocks', BLOCK, {
        taskId: d.taskId ?? null, recurringId: d.recurringId ?? null, occurrenceDate: d.occurrenceDate ?? null,
        start: d.start, end: d.end, pinned: true, completed: false,
      });
      return getBlockRow(id);
    },
    updateBlock: async (id, p) => {
      updateRow('blocks', BLOCK, id, p, ['start', 'end', 'pinned', 'completed']);
      return getBlockRow(id);
    },
    deleteBlock: async (id) => deleteRow('blocks', id),
    replaceScheduledBlocks: async (nowIsoArg, blocks) => {
      const now = isoOf(nowIsoArg);
      tx(() => {
        run('DELETE FROM blocks WHERE pinned = 0 AND completed = 0 AND start >= ?', now);
        for (const b of blocks) {
          run('INSERT INTO blocks (task_id, recurring_id, occurrence_date, start, "end", pinned, completed) VALUES (?, ?, ?, ?, ?, 0, 0)',
            b.taskId ?? null, b.recurringId ?? null, b.occurrenceDate ?? null, isoOf(b.start), isoOf(b.end));
        }
      });
    },
    // v2 §R1 V2-D2: one transaction; blocks updated in place (same ids). Returns the number of open blocks completed.
    finishTaskBlocks: async (taskId, nowIsoArg) => {
      const nowMs = Date.parse(isoOf(nowIsoArg));
      return tx(() => {
        const rows = all('SELECT id, start, "end", completed FROM blocks WHERE task_id = ? ORDER BY start, id', taskId)
          .map((r) => ({ id: Number(r.id), start: r.start, end: r.end, completed: r.completed === 1 }));
        const { openIds, moves } = planDoneMove(rows, nowMs);
        for (const m of moves) run('UPDATE blocks SET start = ?, "end" = ? WHERE id = ?', m.start, m.end, m.id);
        for (const id of openIds) run('UPDATE blocks SET completed = 1 WHERE id = ?', id);
        return openIds.length;
      });
    },
    // v2 §R1 V2-D3: same move rule for one occurrence; never sets completed (recurring blocks cannot be completed).
    finishOccurrenceBlocks: async (recurringId, date, nowIsoArg) => {
      const nowMs = Date.parse(isoOf(nowIsoArg));
      return tx(() => {
        const rows = all('SELECT id, start, "end", completed FROM blocks WHERE recurring_id = ? AND occurrence_date = ? ORDER BY start, id',
          recurringId, date).map((r) => ({ id: Number(r.id), start: r.start, end: r.end, completed: r.completed === 1 }));
        const { openIds, moves } = planDoneMove(rows, nowMs);
        for (const m of moves) run('UPDATE blocks SET start = ?, "end" = ? WHERE id = ?', m.start, m.end, m.id);
        return openIds.length;
      });
    },
    deleteFutureBlocksForTask: async (taskId, nowIsoArg) =>
      run('DELETE FROM blocks WHERE task_id = ? AND start >= ? AND completed = 0', taskId, isoOf(nowIsoArg)).changes,
    deleteFutureBlocksForOccurrence: async (recurringId, date, nowIsoArg) =>
      run('DELETE FROM blocks WHERE recurring_id = ? AND occurrence_date = ? AND start >= ? AND completed = 0', recurringId, date, isoOf(nowIsoArg)).changes,
    resetTaskProgress: async (taskId) => run('UPDATE blocks SET completed = 0 WHERE task_id = ?', taskId).changes,
    // v2 §R1 V2-D4: only missed work of todo tasks and blocks of skipped (not done) occurrences are pruned.
    pruneBlocks: async (beforeIso) => run(
      `DELETE FROM blocks WHERE "end" < ? AND (
        (task_id IS NOT NULL AND completed = 0 AND task_id IN (SELECT id FROM tasks WHERE status = 'todo'))
        OR (recurring_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recurring_done d
          WHERE d.recurring_id = blocks.recurring_id AND d.occurrence_date = blocks.occurrence_date)))`,
      isoOf(beforeIso),
    ).changes,

    // ----- Step 4: calendars and events -----
    listCalendars: async () => all('SELECT * FROM calendars ORDER BY id').map((r) => fromRow(CALENDAR, r)),
    getCalendar: async (id) => getCalendarRow(id),
    createCalendar: async (d) => {
      const id = insertRow('calendars', CALENDAR, { ...CALENDAR_DEFAULTS, ...stripUndef(d), createdAt: d.createdAt ?? nowIso() });
      return getCalendarRow(id);
    },
    updateCalendar: async (id, p) => {
      updateRow('calendars', CALENDAR, id, p, ['name', 'provider', 'url', 'color', 'enabled', 'blocking']);
      return getCalendarRow(id);
    },
    deleteCalendar: async (id) => deleteRow('calendars', id),
    setCalendarFetchResult: async (id, r) => {
      updateRow('calendars', CALENDAR, id, {
        lastFetchedAt: r.lastFetchedAt ?? null, lastError: r.lastError ?? null, eventCount: r.eventCount,
      }, ['lastFetchedAt', 'lastError', 'eventCount']);
      return getCalendarRow(id);
    },
    replaceCalendarEvents: async (calendarId, events) => {
      tx(() => {
        run('DELETE FROM events WHERE calendar_id = ?', calendarId);
        for (const e of events) {
          insertRow('events', EVENT, { ...EVENT_DEFAULTS, ...stripUndef(e), calendarId });
        }
      });
    },
    listEventsInRange: async (fromIso, toIso) => all(`SELECT e.*, c.blocking AS calendar_blocking, c.color AS calendar_color
        FROM events e JOIN calendars c ON c.id = e.calendar_id
        WHERE c.enabled = 1 AND e.start < ? AND e."end" > ? ORDER BY e.start, e.id`, isoOf(toIso), isoOf(fromIso)).map((r) => ({
      ...fromRow(EVENT, r),
      calendarBlocking: r.calendar_blocking === 1,
      calendarColor: r.calendar_color,
    })),

    // ----- v2 §R6: schedules (FK ON DELETE SET NULL clears task/project/recurring references) -----
    listSchedules: async () => all('SELECT * FROM schedules ORDER BY id').map((r) => fromRow(SCHEDULE, r)),
    getSchedule: async (id) => getScheduleRow(id),
    createSchedule: async (d) => {
      const id = insertRow('schedules', SCHEDULE, { color: SCHEDULE_DEFAULT_COLOR, ...stripUndef(d), createdAt: d.createdAt ?? nowIso() });
      return getScheduleRow(id);
    },
    updateSchedule: async (id, p) => {
      updateRow('schedules', SCHEDULE, id, p, ['name', 'color', 'hours']);
      return getScheduleRow(id);
    },
    deleteSchedule: async (id) => {
      if (Number(id) === currentDefaultId()) throw new Error('the default schedule cannot be deleted');
      return deleteRow('schedules', id);
    },
  };

  return repo;
}

module.exports = { openDb, DDL };
