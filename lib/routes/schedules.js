// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Schedule routes (spec v2 §R6 V2-D14, V2-D17, V2-D23, "Data / API"; §V11 UR-2). Every mutation reschedules before responding.
// The default schedule is edited like any other (no special case in PATCH); only its deletion is refused (409).
'use strict';
const express = require('express');
const { HttpError, requireObject, validateScheduleFields, badRequest } = require('../validate.js');

const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
const notFound = () => new HttpError(404, 'schedule not found');
const pick = (body, keys) => Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

// §8.1 Schedule shape; isDefault from settings.defaultScheduleId. Never spread raw rows.
function toApiSchedule(s, defaultId) {
  return { id: s.id, name: s.name, color: s.color, hours: s.hours, isDefault: s.id === defaultId, createdAt: s.createdAt };
}

// Task/Project/Recurring scheduleId: null or an existing schedule id.
async function checkScheduleId(repo, v) {
  if (v === null) return;
  if (!Number.isInteger(v) || !(await repo.getSchedule(v))) throw badRequest('scheduleId', 'schedule not found');
}

// V2-D23: unique case-insensitively; selfId (PATCH) is excluded so a schedule may keep its own name in any case.
async function checkNameFree(repo, name, selfId) {
  const lower = name.toLowerCase();
  if ((await repo.listSchedules()).some((s) => s.id !== selfId && s.name.toLowerCase() === lower)) {
    throw badRequest('name', 'already used');
  }
}

function schedulesRoutes({ repo, scheduleService, now }) {
  const r = express.Router();
  const iso = () => new Date(now()).toISOString();
  const defaultId = async () => (await repo.getSettings()).defaultScheduleId;

  r.get('/schedules', async (req, res) => {
    const d = await defaultId();
    res.json((await repo.listSchedules()).map((s) => toApiSchedule(s, d)));
  });

  r.post('/schedules', async (req, res) => {
    const s = validateScheduleFields(pick(requireObject(req.body), ['name', 'hours', 'color']), { create: true });
    await checkNameFree(repo, s.name, null);
    const created = await repo.createSchedule({ ...s, createdAt: iso() });
    await scheduleService.reschedule('schedule-create');
    res.status(201).json(toApiSchedule(created, await defaultId()));
  });

  r.patch('/schedules/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null || !(await repo.getSchedule(id))) throw notFound();
    const s = validateScheduleFields(pick(requireObject(req.body), ['name', 'hours', 'color']));
    if (s.name !== undefined) await checkNameFree(repo, s.name, id);
    const updated = await repo.updateSchedule(id, s);
    await scheduleService.reschedule('schedule-update');
    res.json(toApiSchedule(updated, await defaultId()));
  });

  r.delete('/schedules/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null || !(await repo.getSchedule(id))) throw notFound();
    if (id === (await defaultId())) throw new HttpError(409, 'cannot delete the default schedule');
    await repo.deleteSchedule(id);
    await scheduleService.reschedule('schedule-delete');
    res.status(204).end();
  });

  return r;
}

module.exports = { schedulesRoutes, toApiSchedule, checkScheduleId };
