// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Project and stage routes (spec §8.1, §9.10). Every mutation reschedules before responding.
'use strict';
const express = require('express');
const { HttpError, requireObject, validateProjectFields, validateStageFields, badRequest } = require('../validate.js');
const { checkScheduleId } = require('./schedules.js');

const INBOX_ID = 1;
// D19: a non-positive-integer id can never match a row, so it is reported as not found.
const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
const notFound = (what) => new HttpError(404, `${what} not found`);
const pick = (body, keys) => Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

function projectsRoutes({ repo, scheduleService, now }) {
  const r = express.Router();
  const iso = () => new Date(now()).toISOString();

  r.get('/projects', async (req, res) => res.json(await repo.listProjects()));

  r.post('/projects', async (req, res) => {
    const p = validateProjectFields(pick(requireObject(req.body), ['name', 'color', 'scheduleId']), { create: true });
    if (p.scheduleId !== undefined) await checkScheduleId(repo, p.scheduleId);
    const created = await repo.createProject({ ...p, createdAt: iso() });
    await scheduleService.reschedule('project-create');
    res.status(201).json(created);
  });

  r.patch('/projects/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null || !(await repo.getProject(id))) throw notFound('project');
    const p = validateProjectFields(pick(requireObject(req.body), ['name', 'color', 'sortOrder', 'archived', 'scheduleId']));
    if (p.scheduleId !== undefined) await checkScheduleId(repo, p.scheduleId);
    const updated = await repo.updateProject(id, p);
    await scheduleService.reschedule('project-update');
    res.json(updated);
  });

  r.delete('/projects/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (id === INBOX_ID) throw new HttpError(409, 'Inbox cannot be deleted');
    if (id === null || !(await repo.getProject(id))) throw notFound('project');
    await repo.deleteProject(id);
    await scheduleService.reschedule('project-delete');
    res.status(204).end();
  });

  r.post('/projects/:id/stages', async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null || !(await repo.getProject(id))) throw notFound('project');
    const s = validateStageFields(pick(requireObject(req.body), ['name', 'deadline', 'deadlineType']), { create: true });
    const created = await repo.createStage(id, { ...s, createdAt: iso() });
    await scheduleService.reschedule('stage-create');
    res.status(201).json(created);
  });

  // Registered before any /projects/:id/... route that could shadow it.
  r.post('/projects/:id/stages/reorder', async (req, res) => {
    const id = parseId(req.params.id);
    const project = id === null ? null : await repo.getProject(id);
    if (!project) throw notFound('project');
    const body = requireObject(req.body);
    const ids = body.stageIds;
    const own = new Set(project.stages.map((s) => s.id));
    const valid = Array.isArray(ids) && ids.every(Number.isInteger) && new Set(ids).size === ids.length
      && ids.length === own.size && ids.every((x) => own.has(x));
    if (!valid) throw badRequest('stageIds', "must list exactly the project's stage ids");
    const stages = await repo.reorderStages(id, ids);
    await scheduleService.reschedule('stage-reorder');
    res.json(stages);
  });

  // A changed stage deadline/type is pushed onto the stage's open tasks. When the deadline moves later and the
  // project has later stages with deadlines, laterStages says what to do with them: 'keep' (default),
  // 'extend' (shift each by the same amount) or 'resize' (squeeze them between the new deadline and the original final one).
  r.patch('/stages/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const stage = id === null ? null : await repo.getStage(id);
    if (!stage) throw notFound('stage');
    const body = requireObject(req.body);
    const s = validateStageFields(pick(body, ['name', 'deadline', 'deadlineType']));
    const mode = body.laterStages ?? 'keep';
    if (!['keep', 'extend', 'resize'].includes(mode)) throw badRequest('laterStages', 'must be keep, extend or resize');
    const changed = (st, v) => (v.deadline !== undefined && v.deadline !== st.deadline) || (v.deadlineType !== undefined && v.deadlineType !== st.deadlineType);
    const updates = [];   // [stageId, fields]
    if (changed(stage, s) && s.deadline !== undefined && s.deadline !== null && stage.deadline && mode !== 'keep') {
      const oldMs = Date.parse(stage.deadline), newMs = Date.parse(s.deadline);
      const project = await repo.getProject(stage.projectId);
      const later = project.stages.filter((x) => x.sortOrder > stage.sortOrder && x.deadline).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
      if (newMs > oldMs && later.length) {
        const finalMs = Math.max(...later.map((x) => Date.parse(x.deadline)));
        if (mode === 'extend') {
          for (const x of later) updates.push([x.id, { deadline: new Date(Date.parse(x.deadline) + (newMs - oldMs)).toISOString() }]);
        } else {
          if (newMs >= finalMs) throw badRequest('deadline', 'leaves no room before the final deadline; choose extend instead');
          for (const x of later) {
            const f = (Date.parse(x.deadline) - oldMs) / (finalMs - oldMs);
            updates.push([x.id, { deadline: new Date(Math.round(newMs + f * (finalMs - newMs))).toISOString() }]);
          }
        }
      }
    }
    updates.unshift([id, s]);
    let updated;
    for (const [sid, fields] of updates) {
      const before = sid === id ? stage : await repo.getStage(sid);
      const did = changed(before, fields);
      const row = await repo.updateStage(sid, fields);
      if (sid === id) updated = row;
      if (did) await repo.setStageTasksDeadline(sid, row.deadline, row.deadlineType);
    }
    await scheduleService.reschedule('stage-update');
    res.json(updated);
  });

  r.delete('/stages/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null || !(await repo.getStage(id))) throw notFound('stage');
    await repo.deleteStage(id);
    await scheduleService.reschedule('stage-delete');
    res.status(204).end();
  });

  return r;
}

module.exports = { projectsRoutes };
