// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// PURE agenda builder (spec §5.8, §8.1 Agenda, §10.4 field derivations). Instants in: epoch ms (A2); out: ISO strings.
const { MIN, addDays, utcToZoned, zonedToUtc } = require('../public/shared/time.js');
const { PRIORITY_WEIGHT } = require('./scheduler.js');

const DEFAULT_PROJECT_COLOR = '#4f7cff';
const RECURRING_DEFAULT_COLOR = '#8e7cc3';
const iso = (ms) => new Date(ms).toISOString();
const byStartId = (a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id - b.id;
const occKey = (recurringId, date) => `${recurringId}|${date}`;

function effectiveDeadline(task, stage) {
  if (task.deadline != null) return { deadline: task.deadline, deadlineType: task.deadlineType, deadlineInherited: false };
  if (stage && stage.deadline != null) return { deadline: stage.deadline, deadlineType: stage.deadlineType, deadlineInherited: true };
  return { deadline: null, deadlineType: null, deadlineInherited: false };
}

function compareUnscheduled(a, b) {
  const da = a.deadline == null ? null : Date.parse(a.deadline), db = b.deadline == null ? null : Date.parse(b.deadline);
  if (da !== db) { if (da == null) return 1; if (db == null) return -1; return da - db; }
  const pw = (PRIORITY_WEIGHT[b.priority] ?? 0) - (PRIORITY_WEIGHT[a.priority] ?? 0);
  if (pw) return pw;
  const ka = a.kind === 'task' ? 0 : 1, kb = b.kind === 'task' ? 0 : 1;
  if (ka !== kb) return ka - kb;
  const ia = a.kind === 'task' ? a.taskId : a.recurringId, ib = b.kind === 'task' ? b.taskId : b.recurringId;
  if (ia !== ib) return ia - ib;
  return (a.occurrenceDate ?? '').localeCompare(b.occurrenceDate ?? '');
}

function buildAgenda({ blocks, tasks, projects, recurring, status, now, tz, horizonEnd }) {
  const today = utcToZoned(now, tz).date;
  const windowStart = zonedToUtc(addDays(today, -14), 0, tz);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const recById = new Map(recurring.map((r) => [r.id, r]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const stageById = new Map(projects.flatMap((p) => (p.stages ?? []).map((s) => [s.id, s])));
  const statusByTask = new Map((status?.tasks ?? []).map((s) => [s.taskId, s]));
  const atRisk = status?.atRisk ?? [];
  const recAtRisk = new Set(atRisk.filter((a) => a.recurringId != null).map((a) => occKey(a.recurringId, a.occurrenceDate)));
  const projectFields = (projectId, fallbackColor) => {
    const p = projectId == null ? null : projectById.get(projectId);
    return { projectId: projectId ?? null, projectName: p ? p.name : null, projectColor: p ? p.color : fallbackColor };
  };
  const sortedBlocks = [...blocks].sort(byStartId);

  // §10.4: part position/count among ALL of the task's blocks, (start, id) order.
  const partsByTask = new Map();
  for (const b of sortedBlocks) {
    if (b.kind !== 'task') continue;
    if (!partsByTask.has(b.taskId)) partsByTask.set(b.taskId, []);
    partsByTask.get(b.taskId).push(b.id);
  }

  const rows = [];
  for (const b of sortedBlocks) {
    const s = Date.parse(b.start);
    if (s < windowStart || s >= horizonEnd) continue;
    const base = { blockId: b.id, kind: b.kind, taskId: b.taskId, recurringId: b.recurringId, occurrenceDate: b.occurrenceDate,
      start: b.start, end: b.end, durationMin: (Date.parse(b.end) - s) / MIN };
    const flags = { pinned: b.pinned, completed: b.completed, done: b.done, missed: b.missed };
    if (b.kind === 'task') {
      const t = taskById.get(b.taskId);
      if (!t) continue;
      const stage = t.stageId == null ? null : stageById.get(t.stageId) ?? null;
      const dl = effectiveDeadline(t, stage);
      const ownerDone = t.status === 'done';
      const parts = partsByTask.get(t.id);
      rows.push({ ...base, title: t.title, ...projectFields(t.projectId, DEFAULT_PROJECT_COLOR),
        stageId: t.stageId ?? null, stageName: stage ? stage.name : null, priority: t.priority, ...dl,
        riskState: ownerDone ? 'none' : (statusByTask.get(t.id)?.state ?? 'none'),
        overdue: !ownerDone && dl.deadline != null && Date.parse(dl.deadline) <= now,
        ...flags, partIndex: parts.indexOf(b.id) + 1, partCount: parts.length });
    } else {
      const rec = recById.get(b.recurringId);
      if (!rec) continue;
      rows.push({ ...base, title: rec.title, ...projectFields(rec.projectId, RECURRING_DEFAULT_COLOR),
        stageId: null, stageName: null, priority: rec.priority, deadline: null, deadlineType: null, deadlineInherited: false,
        riskState: b.done ? 'none' : (recAtRisk.has(occKey(b.recurringId, b.occurrenceDate)) ? 'unscheduled' : 'ok'),
        overdue: false, ...flags, partIndex: 1, partCount: 1 });
    }
  }

  const unscheduled = [];
  for (const t of [...tasks].sort((a, b) => a.id - b.id)) {
    if (t.status !== 'todo') continue;
    const st = statusByTask.get(t.id);
    const remainingMin = Math.max(0, t.durationMin - (st ? st.creditedMin : 0));
    if (remainingMin <= 0) continue;
    if (blocks.some((b) => b.kind === 'task' && b.taskId === t.id && !b.completed && Date.parse(b.end) > now)) continue;
    const stage = t.stageId == null ? null : stageById.get(t.stageId) ?? null;
    unscheduled.push({ kind: 'task', taskId: t.id, recurringId: null, occurrenceDate: null, title: t.title,
      ...projectFields(t.projectId, DEFAULT_PROJECT_COLOR), stageName: stage ? stage.name : null, priority: t.priority,
      ...effectiveDeadline(t, stage), riskState: st ? st.state : 'none', unscheduledMin: remainingMin });
  }
  for (const a of atRisk) {
    if (a.recurringId == null || a.kind !== 'unscheduled') continue;
    const rec = recById.get(a.recurringId);
    if (!rec) continue;
    unscheduled.push({ kind: 'recurring', taskId: null, recurringId: rec.id, occurrenceDate: a.occurrenceDate, title: rec.title,
      ...projectFields(rec.projectId, RECURRING_DEFAULT_COLOR), stageName: null, priority: rec.priority,
      deadline: a.deadline, deadlineType: null, deadlineInherited: false, riskState: 'unscheduled', unscheduledMin: rec.durationMin });
  }
  unscheduled.sort(compareUnscheduled);

  return { now: iso(now), today, horizonEnd: iso(horizonEnd), rows, unscheduled };
}

module.exports = { buildAgenda };
