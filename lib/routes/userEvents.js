// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// User event routes: tactus-only events (no calendar). Every mutation reschedules before responding.
'use strict';
const express = require('express');
const { HttpError, requireObject, validateUserEventFields } = require('../validate.js');

const USER_EVENT_COLOR = '#0b8043';
const WRITABLE = ['title', 'location', 'start', 'end'];
const pick = (body, keys) => Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
const notFound = () => new HttpError(404, 'event not found');

// Same shape as a calendar event (toApiEvent in schedule.js); id is 'user:<n>' so it never collides with calendar ids.
function toApiUserEvent(e) {
  return { id: `user:${e.id}`, calendarId: null, uid: 'user', title: e.title, location: e.location, start: e.start, end: e.end,
    allDay: false, startDate: null, endDate: null, transparent: false, blocking: true, color: USER_EVENT_COLOR };
}

function userEventsRoutes({ repo, scheduleService, now }) {
  const r = express.Router();
  r.post('/user-events', async (req, res) => {
    const body = requireObject(req.body);
    const norm = validateUserEventFields({ location: '', ...pick(body, WRITABLE) });
    const created = await repo.createUserEvent({ ...norm, createdAt: new Date(now()).toISOString() });
    await scheduleService.reschedule('user-event-create');
    res.status(201).json(toApiUserEvent(created));
  });
  r.patch('/user-events/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const cur = id && await repo.getUserEvent(id);
    if (!cur) throw notFound();
    const body = requireObject(req.body);
    const norm = validateUserEventFields({ title: cur.title, location: cur.location, start: cur.start, end: cur.end, ...pick(body, WRITABLE) });
    const updated = await repo.updateUserEvent(id, norm);
    await scheduleService.reschedule('user-event-update');
    res.json(toApiUserEvent(updated));
  });
  r.delete('/user-events/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id || !(await repo.deleteUserEvent(id))) throw notFound();
    await scheduleService.reschedule('user-event-delete');
    res.status(204).end();
  });
  return r;
}

module.exports = { userEventsRoutes, toApiUserEvent, USER_EVENT_COLOR };
