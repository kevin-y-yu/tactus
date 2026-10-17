// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Boot (spec §4.1): loadConfig, createApp, initial reschedule, listen, start timers.
const { loadConfig } = require('./lib/config.js');
const { createApp } = require('./lib/app.js');
async function main() {
  const config = loadConfig();
  if (!config.isLoopback && !config.authToken) {
    console.warn(`WARNING: HOST=${config.host} is not a loopback address and AUTH_TOKEN is not set: anyone who can reach this port can read and change all data. Set AUTH_TOKEN (see .env.example).`);
  }
  const { app, scheduleService, calendarSync } = await createApp(config);
  try { await scheduleService.reschedule('startup'); } catch (err) { console.error('startup reschedule failed:', err); }
  app.listen(config.port, config.host, (err) => {
    if (err) { console.error(err); process.exit(1); }
    console.log(`Tactus listening on http://${config.host}:${config.port}`);
    scheduleService.start(); calendarSync.start();
  });
}
main().catch((err) => { console.error(err); process.exit(1); });
