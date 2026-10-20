// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Schedule routes (spec §8.1, §9.10): status, manual run, calendar window (blocks + events), lunch move (drag).
'use strict';
const express = require('express');
const { EMPTY_STATUS } = require('../scheduleService.js');
const { validateRange, HttpError, badRequest, requireObject, isIsoInstant, isDateString } = require('../validate.js');
const { GRID, MIN, ceilGrid, addDays, utcToZoned, formatHHMM } = require('../../public/shared/time.js');
const { toApiBlock } = require('./blocks.js');
const { toApiUserEvent } = require('./userEvents.js');

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
    // Tactus-only user events are merged in the same way (same shape, id 'user:<n>').
    const userEvents = (await repo.listUserEventsInRange(from, to)).map(toApiUserEvent);
    // Lunches are shown as pseudo-events (no calendar) so the calendar views draw them with no extra code.
    const lunches = ((await repo.getMeta('lunchBlocks')) ?? [])
      .filter((l) => Date.parse(l.end) > Date.parse(from) && Date.parse(l.start) < Date.parse(to))
      .map((l) => ({ id: `lunch:${l.start}`, calendarId: null, uid: 'lunch', title: 'Lunch', location: '', start: l.start, end: l.end,
        allDay: false, startDate: null, endDate: null, transparent: false, blocking: true, color: '#f9ab00' }));
    res.json({ blocks, events: [...events, ...userEvents, ...lunches] });
  });

  // Lunch move (drag): store a per-day start override; placeLunches applies it on every reschedule. Today's lunch can be
  // moved to a later time even if it has started or was missed; the new start must still be in the future.
  r.put('/lunch/:date', async (req, res) => {
    const date = req.params.date;
    if (!isDateString(date)) throw badRequest('date', 'must be YYYY-MM-DD');
    const body = requireObject(req.body);
    if (!isIsoInstant(body.start)) throw badRequest('start', 'must be an ISO instant');
    const nowMs = now(), start = Date.parse(body.start);
    if (start % GRID !== 0) throw badRequest('start', 'must be on the 15-minute grid');
    if (start < ceilGrid(nowMs)) throw badRequest('start', 'must not be in the past');
    const settings = await repo.getSettings();
    if (!settings.lunchMin) throw new HttpError(409, 'lunch is off');
    const tz = settings.timezone, today = utcToZoned(nowMs, tz).date;
    if (date < today || date > addDays(today, settings.horizonDays - 1)) throw badRequest('date', 'must be within the scheduling horizon');
    const end = start + settings.lunchMin * MIN;
    if (utcToZoned(start, tz).date !== date || utcToZoned(end - 1, tz).date !== date) {
      throw badRequest('start', 'lunch must start and end on that day');
    }
    const current = (await repo.getMeta('lunchBlocks')) ?? [];
    if (!current.some((l) => utcToZoned(Date.parse(l.start), tz).date === date)) throw new HttpError(409, 'no lunch that day');
    const prev = (await repo.getMeta('lunchOverrides')) ?? {};
    const next = Object.fromEntries(Object.entries(prev).filter(([d]) => d >= today));
    next[date] = formatHHMM(utcToZoned(start, tz).minutes);
    await repo.setMeta('lunchOverrides', next);
    await scheduleService.reschedule('lunch-move');
    res.json({ date, start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  });

  return r;
}

module.exports = { scheduleRoutes };
