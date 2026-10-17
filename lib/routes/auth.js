// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Auth routes (spec §8.2 auth rows, §11 S-2). Mounted before the gate, so they stay public.
'use strict';
const express = require('express');
const { HttpError, requireObject } = require('../validate.js');

function authRoutes({ auth }) {
  const r = express.Router();
  r.get('/auth/status', (req, res) => res.json({ authRequired: auth.required, authenticated: auth.isAuthenticated(req) }));
  r.post('/auth/login', (req, res) => {
    const body = requireObject(req.body);
    if (!auth.required) return res.status(204).end();
    if (!auth.checkPassword(body.password)) throw new HttpError(401, 'invalid password');
    res.setHeader('Set-Cookie', auth.sessionCookie(req.secure));
    res.status(204).end();
  });
  r.post('/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', auth.clearedCookie(req.secure));
    res.status(204).end();
  });
  return r;
}

module.exports = { authRoutes };
