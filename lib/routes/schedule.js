// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Schedule routes (spec §8.1, §9.10): status, manual run, calendar window (blocks + events).
'use strict';
const express = require('express');
const { EMPTY_STATUS } = require('../scheduleService.js');
const { validateRange } = require('../validate.js');
const { toApiBlock } = require('./blocks.js');

function toApiEvent(e) {
  return { id: e.id, calendarId: e.calendarId, uid: e.uid, title: e.title, location: e.location, start: e.start, end: e.end,
    allDay: e.allDay, startDate: e.startDate, endDate: e.endDate, transparent: e.transparent, blocking: e.calendarBlocking,
    color: e.calendarColor };
}

function scheduleRoutes({ repo, scheduleService, now }) {
  const r = express.Router();

  r.get('/status', async (req, res) => res.json((await repo.getMeta('lastSchedule')) ?? EMPTY_STATUS()));

  r.post('/schedule/run', async (req, res) => res.json(await scheduleService.reschedule('manual')));

  r.get('/calendar', async (req, res) => {
    const { from, to } = validateRange(req.query.from, req.query.to);
    const nowMs = now();
    const blocks = (await repo.listBlocksInRange(from, to)).map((b) => toApiBlock(b, nowMs));
    const events = (await repo.listEventsInRange(from, to)).map(toApiEvent);
    // Lunches are shown as pseudo-events (no calendar) so the calendar views draw them with no extra code.
    const lunches = ((await repo.getMeta('lunchBlocks')) ?? [])
      .filter((l) => Date.parse(l.end) > Date.parse(from) && Date.parse(l.start) < Date.parse(to))
      .map((l) => ({ id: `lunch:${l.start}`, calendarId: null, uid: 'lunch', title: 'Lunch', location: '', start: l.start, end: l.end,
        allDay: false, startDate: null, endDate: null, transparent: false, blocking: true, color: '#f9ab00' }));
    res.json({ blocks, events: [...events, ...lunches] });
  });

  return r;
}

module.exports = { scheduleRoutes };
