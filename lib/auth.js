// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Auth gate (spec §11 S-2): shared AUTH_TOKEN via Bearer header or HMAC session cookie. Timing-safe compares only.
'use strict';
const crypto = require('node:crypto');
const SESSION_COOKIE = 'tactus_session';
const SESSION_MAX_AGE_S = 2592000;            // 30 days
const SESSION_CONTEXT = 'tactus-session-v1';

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();
// D4: compare digests so differing lengths never short-circuit.
function safeEqual(a, b) { return crypto.timingSafeEqual(sha256(a), sha256(b)); }
function sessionValue(token) { return crypto.createHmac('sha256', token).update(SESSION_CONTEXT).digest('hex'); }

function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function cookieString(value, maxAgeS, secure) {
  return `${SESSION_COOKIE}=${value}; Max-Age=${maxAgeS}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function createAuth(authToken) {
  const required = typeof authToken === 'string' && authToken.length > 0;
  const expected = required ? sessionValue(authToken) : null;
  function isAuthenticated(req) {
    if (!required) return true;
    const h = req.get('authorization');
    const m = typeof h === 'string' ? /^Bearer +(.+)$/i.exec(h) : null;
    if (m && safeEqual(m[1], authToken)) return true;
    const c = readCookie(req.get('cookie'), SESSION_COOKIE);
    return c !== null && safeEqual(c, expected);
  }
  function gate(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'authentication required' });
  }
  const checkPassword = (pw) => required && typeof pw === 'string' && safeEqual(pw, authToken);
  const sessionCookie = (secure) => cookieString(expected, SESSION_MAX_AGE_S, secure);
  const clearedCookie = (secure) => cookieString('', 0, secure);
  return { required, isAuthenticated, gate, checkPassword, sessionCookie, clearedCookie };
}

module.exports = { createAuth, sessionValue, safeEqual, readCookie, SESSION_COOKIE, SESSION_MAX_AGE_S };
