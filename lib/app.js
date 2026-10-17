// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// App factory (spec §4.1, §5.5): wires repo, schedule service, calendar sync and the /api router. Starts no timers (server.js does).
'use strict';
const path = require('node:path');
const express = require('express');
const { openDb } = require('./db.js');
const { createScheduleService } = require('./scheduleService.js');
const { createCalendarSync } = require('./calendarSync.js');
const { createApiRouter } = require('./routes/index.js');

async function createApp(config, { now = Date.now, fetchImpl = globalThis.fetch } = {}) {
  const log = console;
  const repo = await openDb(config.dbPath);
  const scheduleService = createScheduleService({ repo, now, log });
  const calendarSync = createCalendarSync({ repo, scheduleService, fetchImpl, log, now });
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use('/api', createApiRouter({ repo, scheduleService, calendarSync, now, log, config }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  return { app, repo, scheduleService, calendarSync };
}

module.exports = { createApp };
