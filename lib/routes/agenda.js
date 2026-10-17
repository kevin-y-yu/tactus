// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// GET /api/agenda (spec §8.2, §10.4): read-only; builds the §8.1 Agenda from repo state and the last schedule run.
const express = require('express');
const { addDays, utcToZoned, zonedToUtc } = require('../../public/shared/time.js');
const { buildAgenda } = require('../agenda.js');
const { EMPTY_STATUS } = require('../scheduleService.js');
const { toApiBlock } = require('./blocks.js');

// D3: every block, so partIndex/partCount count all of a task's parts.
const ALL_FROM = '1970-01-01T00:00:00.000Z', ALL_TO = '9999-12-31T00:00:00.000Z';

function agendaRoutes({ repo, now }) {
  const r = express.Router();
  r.get('/agenda', async (req, res) => {
    const settings = await repo.getSettings();
    const tz = settings.timezone;
    const nowMs = now();
    const today = utcToZoned(nowMs, tz).date;
    const horizonEnd = zonedToUtc(addDays(today, settings.horizonDays), 0, tz);
    const blocks = (await repo.listBlocksInRange(ALL_FROM, ALL_TO)).map((b) => toApiBlock(b, nowMs));
    const tasks = await repo.listTasks({});
    const projects = await repo.listProjects();
    const recurring = await repo.listRecurring();
    const status = (await repo.getMeta('lastSchedule')) ?? EMPTY_STATUS();
    res.json(buildAgenda({ blocks, tasks, projects, recurring, status, now: nowMs, tz, horizonEnd }));
  });
  return r;
}

module.exports = { agendaRoutes };
