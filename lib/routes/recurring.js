// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Recurring-rule routes (spec §8.2 recurring rows, §9.10). Every mutation reschedules before responding.
'use strict';
const express = require('express');
const { HttpError, requireObject, validateRecurringFields, badRequest, isDateString } = require('../validate.js');
const { checkScheduleId } = require('./schedules.js');

const WRITABLE = ['title', 'notes', 'projectId', 'frequency', 'daysOfWeek', 'dayOfMonth', 'durationMin', 'windowStart',
  'windowEnd', 'priority', 'startDate', 'endDate', 'active', 'scheduleId', 'minBlockMin', 'droppable'];
const RECURRING_DEFAULTS = { notes: '', projectId: null, daysOfWeek: [], dayOfMonth: null, windowStart: null, windowEnd: null,
  priority: 'medium', endDate: null, active: true, scheduleId: null, minBlockMin: null, droppable: false };
const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
const notFound = () => new HttpError(404, 'recurring task not found');
const pick = (body, keys) => Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

async function checkProject(repo, r) {
  if (r.projectId !== null && !(await repo.getProject(r.projectId))) throw badRequest('projectId', 'project not found');
  await checkScheduleId(repo, r.scheduleId);
}

function recurringRoutes({ repo, scheduleService, now }) {
  const r = express.Router();
  const iso = () => new Date(now()).toISOString();
  const existingOr404 = async (raw) => {
    const id = parseId(raw);
    const row = id === null ? null : await repo.getRecurring(id);
    if (!row) throw notFound();
    return row;
  };

  r.get('/recurring', async (req, res) => res.json(await repo.listRecurring()));

  r.post('/recurring', async (req, res) => {
    const norm = validateRecurringFields({ ...RECURRING_DEFAULTS, ...pick(requireObject(req.body), WRITABLE) });
    await checkProject(repo, norm);
    const t = iso();
    const created = await repo.createRecurring({ ...norm, createdAt: t, updatedAt: t });
    await scheduleService.reschedule('recurring-create');
    res.status(201).json(created);
  });

  r.patch('/recurring/:id', async (req, res) => {
    const existing = await existingOr404(req.params.id);
    const norm = validateRecurringFields({ ...existing, ...pick(requireObject(req.body), WRITABLE) });
    await checkProject(repo, norm);
    const updated = await repo.updateRecurring(existing.id, { ...norm, updatedAt: iso() });
    await scheduleService.reschedule('recurring-update');
    res.json(updated);
  });

  r.delete('/recurring/:id', async (req, res) => {
    const existing = await existingOr404(req.params.id);
    await repo.deleteRecurring(existing.id);
    await scheduleService.reschedule('recurring-delete');
    res.status(204).end();
  });

  // D15: any valid calendar date is accepted (E3), so a missed block keeps its tick after the pattern changes.
  r.post('/recurring/:id/occurrences/:date/done', async (req, res) => {
    const existing = await existingOr404(req.params.id);
    if (!isDateString(req.params.date)) throw badRequest('date', 'must be a YYYY-MM-DD date');
    await repo.setOccurrenceDone(existing.id, req.params.date, true);
    await repo.finishOccurrenceBlocks(existing.id, req.params.date, iso());
    await scheduleService.reschedule('occurrence-done');
    res.status(204).end();
  });

  r.delete('/recurring/:id/occurrences/:date/done', async (req, res) => {
    const existing = await existingOr404(req.params.id);
    if (!isDateString(req.params.date)) throw badRequest('date', 'must be a YYYY-MM-DD date');
    await repo.setOccurrenceDone(existing.id, req.params.date, false);
    await scheduleService.reschedule('occurrence-undone');
    res.status(204).end();
  });

  return r;
}

module.exports = { recurringRoutes };
