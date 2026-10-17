// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Settings routes (spec §7, §9.10; v2 §R6 V2-D14): PUT validates the merged whole, saves, reschedules (D13).
// workHours is the alias for the default schedule's hours and is written only when the body sends it.
'use strict';
const express = require('express');
const { SETTINGS_KEYS, validateSettings, requireObject, badRequest } = require('../validate.js');

function settingsRoutes({ repo, scheduleService, calendarSync, log }) {
  const r = express.Router();

  r.get('/settings', async (req, res) => res.json(await repo.getSettings()));

  r.put('/settings', async (req, res) => {
    const body = requireObject(req.body);
    const before = await repo.getSettings();
    const merged = {};
    for (const k of SETTINGS_KEYS) merged[k] = body[k] !== undefined ? body[k] : before[k];
    validateSettings(merged);
    if (!(await repo.getSchedule(merged.defaultScheduleId))) throw badRequest('defaultScheduleId', 'must be an existing schedule');
    // V2-D14: without body workHours no schedule hours are written (else a new default would get the old default's hours).
    if (body.workHours === undefined) delete merged.workHours;
    await repo.saveSettings(merged);
    await scheduleService.reschedule('settings');
    if (merged.timezone !== before.timezone || merged.horizonDays !== before.horizonDays) {
      calendarSync.refreshAll().catch((err) => log.error(`refreshAll failed: ${err && err.message}`));
    }
    res.json(await repo.getSettings());
  });

  return r;
}

module.exports = { settingsRoutes };
