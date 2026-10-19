// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// API router (spec §4.1, §8): JSON body parsing, sub-routers, 404 and error mapping (D18).
'use strict';
const express = require('express');
const { HttpError } = require('../validate.js');
const { settingsRoutes } = require('./settings.js');
const { projectsRoutes } = require('./projects.js');
const { tasksRoutes } = require('./tasks.js');
const { blocksRoutes } = require('./blocks.js');
const { scheduleRoutes } = require('./schedule.js');
const { schedulesRoutes } = require('./schedules.js');
const { agendaRoutes } = require('./agenda.js');
const { recurringRoutes } = require('./recurring.js');
const { calendarsRoutes } = require('./calendars.js');
const { createAuth } = require('../auth.js');
const { authRoutes } = require('./auth.js');
const { undoRoutes } = require('./undo.js');

function createApiRouter(ctx) {
  const r = express.Router();
  const jsonBody = express.json();   // one parser: login uses it, everything else gets it only after the gate
  r.get('/health', (req, res) => res.json({ ok: true }));
  const auth = createAuth(ctx.config.authToken);
  r.use(authRoutes({ ...ctx, auth, jsonBody }));   // /api/auth/* stays public
  r.use(auth.gate);                           // S-2: everything below needs Bearer or session cookie when AUTH_TOKEN is set
  r.use(jsonBody);
  r.use(undoRoutes(ctx));
  r.use(settingsRoutes(ctx));
  r.use(projectsRoutes(ctx));
  r.use(tasksRoutes(ctx));
  r.use(blocksRoutes(ctx));
  r.use(scheduleRoutes(ctx));
  r.use(schedulesRoutes(ctx));
  r.use(agendaRoutes(ctx));
  r.use(recurringRoutes(ctx));
  r.use(calendarsRoutes(ctx));
  r.use((req, res) => res.status(404).json({ error: 'not found' }));
  r.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'body: invalid JSON' });
    if (typeof err.status === 'number' && err.status >= 400 && err.status <= 499) {
      return res.status(err.status).json({ error: 'body: invalid request' });
    }
    ctx.log.error(err);
    return res.status(500).json({ error: 'internal error' });
  });
  return r;
}

module.exports = { createApiRouter };
