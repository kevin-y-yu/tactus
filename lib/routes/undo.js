// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Undo: before each successful-looking mutating request a snapshot of the user data is taken; POST /undo restores the latest.
// In memory only (lost on restart), capped at MAX_UNDO. Refreshes and manual schedule runs change no user data, so they are skipped.
'use strict';
const express = require('express');
const { HttpError } = require('../validate.js');

const MAX_UNDO = 30;
const SKIP = /^\/(undo|schedule\/run|calendars\/refresh|calendars\/\d+\/refresh)$/;

function undoRoutes({ repo, scheduleService }) {
  const r = express.Router();
  const stack = [];

  r.post('/undo', async (req, res) => {
    const snap = stack.pop();
    if (!snap) throw new HttpError(409, 'nothing to undo');
    await repo.restoreSnapshot(snap);
    await scheduleService.reschedule('undo');
    res.status(204).end();
  });

  r.use(async (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || SKIP.test(req.path)) return next();
    const snap = await repo.snapshot();
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      stack.push(snap);
      if (stack.length > MAX_UNDO) stack.shift();
    });
    next();
  });

  return r;
}

module.exports = { undoRoutes };
