// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Task routes (spec §8.1, §9.10, §4.1). Every mutation reschedules before responding.
'use strict';
const express = require('express');
const { HttpError, requireObject, validateTaskFields, badRequest } = require('../validate.js');
const { isFixedBlock } = require('../scheduleService.js');
const { checkScheduleId } = require('./schedules.js');

const WRITABLE = ['title', 'notes', 'projectId', 'stageId', 'durationMin', 'priority', 'deadline', 'deadlineType', 'startAfter',
  'minBlockMin', 'maxBlockMin', 'dontSplit', 'sortOrder', 'scheduleId'];
const TASK_DEFAULTS = { notes: '', projectId: null, stageId: null, durationMin: 60, priority: 'medium', deadline: null,
  deadlineType: 'hard', startAfter: null, minBlockMin: null, maxBlockMin: null, dontSplit: false, sortOrder: 0, scheduleId: null };
const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
const notFound = () => new HttpError(404, 'task not found');
const pick = (body, keys) => Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

// D15 / v2 §R1: shared by PATCH status 'done' (moveBlocks true: V2-D2 move) and the block auto-complete path
// (moveBlocks false: v1 deletion of uncompleted future blocks, spec v2 §V10 call 16).
async function markTaskDone(repo, taskId, nowMs, { moveBlocks = true } = {}) {
  const nowIso = new Date(nowMs).toISOString();
  await repo.updateTask(taskId, { status: 'done', completedAt: nowIso, updatedAt: nowIso });
  if (moveBlocks) await repo.finishTaskBlocks(taskId, nowIso);
  else await repo.deleteFutureBlocksForTask(taskId, nowIso);
}

async function markTaskTodo(repo, taskId, nowMs) {
  await repo.updateTask(taskId, { status: 'todo', completedAt: null, updatedAt: new Date(nowMs).toISOString() });
}

// Existence checks after validateTaskFields (task-level references).
async function checkReferences(repo, t) {
  if (t.projectId !== null && !(await repo.getProject(t.projectId))) throw badRequest('projectId', 'project not found');
  if (t.projectId === null && t.stageId != null) throw badRequest('stageId', 'a task with no project has no stage');
  if (t.stageId != null) {
    const stage = await repo.getStage(t.stageId);
    if (!stage || stage.projectId !== t.projectId) {
      throw badRequest('stageId', `must be null or a stage of project ${t.projectId}`);
    }
  }
  await checkScheduleId(repo, t.scheduleId);
}

// Links: blockedBy = task ids (same project, no cycles, not against stage order); eventBlocks = [{calendarId, uid, start}].
// Returns the normalised links, or null when the body sets neither. `taskId` is null for a task being created.
async function checkLinks(repo, taskId, norm, body) {
  if (body.blockedBy === undefined && body.blocking === undefined && body.eventBlocks === undefined && body.blocksEvents === undefined) return null;
  const links = { blockerIds: null, events: null, deadlineEvents: null };
  const checkEvents = async (evs, field) => {
    if (!Array.isArray(evs)) throw badRequest(field, 'must be a list of {calendarId, uid, start}');
    const out = [];
    for (const e of evs) {
      if (!e || !Number.isInteger(e.calendarId) || typeof e.uid !== 'string' || typeof e.start !== 'string') {
        throw badRequest(field, 'each entry needs calendarId, uid and start');
      }
      const found = await repo.getEventInstance(e.calendarId, e.uid, e.start);
      if (!found) throw badRequest(field, 'event not found in its calendar');
      out.push({ calendarId: e.calendarId, uid: e.uid, start: e.start, title: found.title });
    }
    return out;
  };
  if (body.blockedBy !== undefined) {
    const ids = body.blockedBy;
    if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(x) && x > 0) || new Set(ids).size !== ids.length) {
      throw badRequest('blockedBy', 'must be a list of unique task ids');
    }
    if (ids.length && norm.projectId === null) throw badRequest('blockedBy', 'tasks with no project cannot be blocked by tasks');
    const stage = norm.stageId != null ? await repo.getStage(norm.stageId) : null;
    for (const bid of ids) {
      const b = bid === taskId ? null : await repo.getTask(bid);
      if (!b) throw badRequest('blockedBy', `task ${bid} not found (or is the task itself)`);
      if (b.projectId !== norm.projectId) throw badRequest('blockedBy', `task ${bid} is not in the same project`);
      const bStage = b.stageId != null ? await repo.getStage(b.stageId) : null;
      if (stage && bStage && bStage.id !== stage.id) throw badRequest('blockedBy', `task ${bid} is not in the same stage`);
    }
    if (taskId !== null && ids.length) {                                  // would any blocker already depend on this task?
      const blockedBy = new Map();
      for (const d of await repo.listTaskDependencies()) {
        if (d.taskId === taskId) continue;                                // this task's own links are being replaced
        if (!blockedBy.has(d.taskId)) blockedBy.set(d.taskId, []);
        blockedBy.get(d.taskId).push(d.blockerId);
      }
      const seen = new Set();
      const stack = [...ids];
      while (stack.length) {
        const n = stack.pop();
        if (n === taskId) throw badRequest('blockedBy', 'would create a circular dependency');
        if (seen.has(n)) continue;
        seen.add(n);
        stack.push(...(blockedBy.get(n) || []));
      }
    }
    links.blockerIds = ids;
  }
  if (body.blocking !== undefined) {
    const ids = body.blocking;
    if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(x) && x > 0) || new Set(ids).size !== ids.length) {
      throw badRequest('blocking', 'must be a list of unique task ids');
    }
    if (ids.length && norm.projectId === null) throw badRequest('blocking', 'tasks with no project cannot block tasks');
    const stage = norm.stageId != null ? await repo.getStage(norm.stageId) : null;
    for (const bid of ids) {
      const b = bid === taskId ? null : await repo.getTask(bid);
      if (!b) throw badRequest('blocking', `task ${bid} not found (or is the task itself)`);
      if (b.projectId !== norm.projectId) throw badRequest('blocking', `task ${bid} is not in the same project`);
      const bStage = b.stageId != null ? await repo.getStage(b.stageId) : null;
      if (stage && bStage && bStage.id !== stage.id) throw badRequest('blocking', `task ${bid} is not in the same stage`);
    }
    // cycle: this task must not (transitively) depend on a task it is about to block
    const own = links.blockerIds ?? (taskId === null ? [] : (await repo.listTaskDependencies()).filter((d) => d.taskId === taskId).map((d) => d.blockerId));
    const blockedBy = new Map([[taskId, own]]);
    for (const d of await repo.listTaskDependencies()) {
      if (d.taskId === taskId) continue;
      if (!blockedBy.has(d.taskId)) blockedBy.set(d.taskId, []);
      blockedBy.get(d.taskId).push(d.blockerId);
    }
    const targets = new Set(ids);
    const seen = new Set();
    const stack = [...own];
    while (stack.length) {
      const n = stack.pop();
      if (targets.has(n)) throw badRequest('blocking', 'would create a circular dependency');
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(blockedBy.get(n) || []));
    }
    links.blockingIds = ids;
  }
  if (body.eventBlocks !== undefined) links.events = await checkEvents(body.eventBlocks, 'eventBlocks');
  if (body.blocksEvents !== undefined) links.deadlineEvents = await checkEvents(body.blocksEvents, 'blocksEvents');
  return links;
}

// Applies checked links on top of the task's current ones (a part left undefined is kept).
async function saveLinks(repo, taskId, links) {
  if (!links) return;
  const cur = {
    blockerIds: (await repo.listTaskDependencies()).filter((d) => d.taskId === taskId).map((d) => d.blockerId),
    events: (await repo.listTaskEventLinks(taskId)).map((e) => ({ calendarId: e.calendarId, uid: e.uid, start: e.start, title: e.title })),
    deadlineEvents: (await repo.listTaskEventLinks(taskId, 'before')).map((e) => ({ calendarId: e.calendarId, uid: e.uid, start: e.start, title: e.title })),
  };
  await repo.setTaskLinks(taskId, { blockerIds: links.blockerIds ?? cur.blockerIds, events: links.events ?? cur.events,
    deadlineEvents: links.deadlineEvents ?? cur.deadlineEvents });
  if (links.blockingIds) await repo.setBlocking(taskId, links.blockingIds);
}

// Adds blockedBy / blocking (task ids) and eventBlocks to each task.
async function withLinks(repo, tasks) {
  const deps = await repo.listTaskDependencies();
  const events = await repo.listTaskEventLinks();
  const before = await repo.listTaskEventLinks(null, 'before');
  const view = (e) => ({ calendarId: e.calendarId, uid: e.uid, start: e.start, end: e.end, title: e.title, stale: e.stale });
  return tasks.map((t) => ({
    ...t,
    blockedBy: deps.filter((d) => d.taskId === t.id).map((d) => d.blockerId),
    blocking: deps.filter((d) => d.blockerId === t.id).map((d) => d.taskId),
    eventBlocks: events.filter((e) => e.taskId === t.id).map(view),
    blocksEvents: before.filter((e) => e.taskId === t.id).map(view),
  }));
}

function tasksRoutes({ repo, scheduleService, calendarSync, now }) {
  const r = express.Router();
  const iso = () => new Date(now()).toISOString();

  r.get('/tasks', async (req, res) => {
    const f = {};
    if (req.query.projectId !== undefined) {
      const projectId = Number(req.query.projectId);
      if (!Number.isInteger(projectId)) throw badRequest('projectId', 'must be an integer');
      f.projectId = projectId;
    }
    if (req.query.status !== undefined) {
      if (req.query.status !== 'todo' && req.query.status !== 'done') throw badRequest('status', 'must be todo or done');
      f.status = req.query.status;
    }
    res.json(await withLinks(repo, await repo.listTasks(f)));
  });

  r.get('/tasks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const task = id === null ? null : await repo.getTask(id);
    if (!task) throw notFound();
    const nowMs = now();
    const blocks = await repo.listBlocksForTask(id);
    const last = await repo.getMeta('lastSchedule');
    const status = last?.tasks.find((s) => s.taskId === id) ?? null;
    const creditedMin = blocks.filter((b) => isFixedBlock(b, nowMs))
      .reduce((sum, b) => sum + (Date.parse(b.end) - Date.parse(b.start)) / 60000, 0);
    // Lazy require: keeps blocks.js and tasks.js free of a top-level cycle. Chunk 9 should keep this.
    const { toApiBlock } = require('./blocks.js');
    res.json({ task: (await withLinks(repo, [task]))[0], status, blocks: blocks.map((b) => toApiBlock(b, nowMs)), creditedMin });
  });

  r.post('/tasks', async (req, res) => {
    const body = requireObject(req.body);
    const merged = { ...TASK_DEFAULTS, ...pick(body, WRITABLE) };
    const norm = validateTaskFields(merged);
    await checkReferences(repo, norm);
    const links = await checkLinks(repo, null, norm, body);
    const nowIso = iso();
    const created = await repo.createTask({ ...norm, createdAt: nowIso, updatedAt: nowIso });
    await saveLinks(repo, created.id, links);
    if (calendarSync && calendarSync.refreshStale) await calendarSync.refreshStale();   // pick up new meetings before placing
    await scheduleService.reschedule('task-create');
    res.status(201).json((await withLinks(repo, [created]))[0]);
  });

  r.patch('/tasks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const existing = id === null ? null : await repo.getTask(id);
    if (!existing) throw notFound();
    const body = requireObject(req.body);
    const picked = pick(body, [...WRITABLE, 'status']);
    if (picked.status !== undefined && picked.status !== 'todo' && picked.status !== 'done') {
      throw badRequest('status', 'must be todo or done');
    }
    const merged = { ...existing, ...picked };
    if (picked.projectId !== undefined && picked.projectId !== existing.projectId && picked.stageId === undefined) {
      merged.stageId = null;
    }
    const norm = validateTaskFields(merged);
    await checkReferences(repo, norm);
    const projectChanged = norm.projectId !== existing.projectId;
    // A project move drops links to tasks left behind, unless the same request sets new ones.
    const links = await checkLinks(repo, id, norm, projectChanged && body.blockedBy === undefined ? { ...body, blockedBy: [], blocking: body.blocking === undefined ? undefined : [] } : body);
    const nowMs = now();
    await repo.updateTask(id, { ...norm, updatedAt: new Date(nowMs).toISOString() });
    await saveLinks(repo, id, links);
    if (projectChanged) await repo.pruneTaskDependencies(id);
    if (picked.status === 'done' && existing.status !== 'done') await markTaskDone(repo, id, nowMs);
    else if (picked.status === 'todo') await markTaskTodo(repo, id, nowMs);
    await scheduleService.reschedule('task-update');
    res.json((await withLinks(repo, [await repo.getTask(id)]))[0]);
  });

  r.delete('/tasks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null || !(await repo.getTask(id))) throw notFound();
    await repo.deleteTask(id);
    await scheduleService.reschedule('task-delete');
    res.status(204).end();
  });

  r.post('/tasks/:id/reset-progress', async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null || !(await repo.getTask(id))) throw notFound();
    await repo.resetTaskProgress(id);
    await scheduleService.reschedule('task-reset-progress');
    res.status(204).end();
  });

  return r;
}

module.exports = { tasksRoutes, markTaskDone, markTaskTodo };
