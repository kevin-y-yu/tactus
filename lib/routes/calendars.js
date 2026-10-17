// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Calendar routes (spec §8.2 calendars rows, §9.12, §11 S-3): responses expose urlRedacted only; a full URL is never
// logged or returned.
'use strict';
const express = require('express');
const { HttpError, requireObject, validateCalendarFields } = require('../validate.js');
const { redactUrl } = require('../ics.js');
const { scrubUrl } = require('../calendarSync.js');

const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
const notFound = () => new HttpError(404, 'calendar not found');
const pick = (body, keys) => Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

// D16: built key by key, never a spread of the repo row, so the full URL cannot leak.
function toApiCalendar(c) {
  return { id: c.id, name: c.name, provider: c.provider, urlRedacted: redactUrl(c.url), color: c.color, enabled: c.enabled,
    blocking: c.blocking, lastFetchedAt: c.lastFetchedAt, lastError: c.lastError, eventCount: c.eventCount, createdAt: c.createdAt };
}

function calendarsRoutes({ repo, scheduleService, calendarSync, now, log }) {
  const r = express.Router();
  const iso = () => new Date(now()).toISOString();
  async function refreshOne(cal, opts = {}) {              // D18
    try { await calendarSync.refreshCalendar(cal.id, opts); } catch (err) {
      const msg = err && typeof err.message === 'string' ? err.message : String(err);
      log.error(`calendar ${cal.id} refresh failed: ${scrubUrl(msg, cal.url)}`);
    }
  }
  const getOr404 = async (raw) => {
    const id = parseId(raw);
    const c = id === null ? null : await repo.getCalendar(id);
    if (!c) throw notFound();
    return c;
  };

  r.get('/calendars', async (req, res) => res.json((await repo.listCalendars()).map(toApiCalendar)));

  r.post('/calendars', async (req, res) => {
    const p = validateCalendarFields(pick(requireObject(req.body), ['name', 'url', 'color']), { create: true });
    const created = await repo.createCalendar({ ...p, provider: 'ics', createdAt: iso() });
    await refreshOne(created);
    res.status(201).json(toApiCalendar(await repo.getCalendar(created.id)));
  });

  // Registered before '/calendars/:id/refresh' for readability; the paths do not overlap.
  r.post('/calendars/refresh', async (req, res) => {
    await calendarSync.refreshAll();
    res.json((await repo.listCalendars()).map(toApiCalendar));
  });

  r.post('/calendars/:id/refresh', async (req, res) => {
    const cal = await getOr404(req.params.id);
    await refreshOne(cal);
    res.json(toApiCalendar(await repo.getCalendar(cal.id)));
  });

  r.patch('/calendars/:id', async (req, res) => {
    const existing = await getOr404(req.params.id);
    const p = validateCalendarFields(pick(requireObject(req.body), ['name', 'url', 'color', 'enabled', 'blocking']));
    await repo.updateCalendar(existing.id, p);
    const urlChanged = p.url !== undefined && p.url !== existing.url;
    const gateChanged = (p.enabled !== undefined && p.enabled !== existing.enabled)
      || (p.blocking !== undefined && p.blocking !== existing.blocking);
    // supersede: a refresh already in flight fetched the old url; its result must not be stored or returned
    if (urlChanged) await refreshOne(await repo.getCalendar(existing.id), { supersede: true });
    if (gateChanged) await scheduleService.reschedule('calendar-update');
    res.json(toApiCalendar(await repo.getCalendar(existing.id)));
  });

  r.delete('/calendars/:id', async (req, res) => {
    const cal = await getOr404(req.params.id);
    await repo.deleteCalendar(cal.id);
    await scheduleService.reschedule('calendar-delete');
    res.status(204).end();
  });

  return r;
}

module.exports = { calendarsRoutes, toApiCalendar };
