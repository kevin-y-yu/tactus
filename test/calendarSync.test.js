// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 0 oracle for T-SYNC-1..6 — spec §13.7 (lines 870–876). Do not edit expectations.
// Open §5 call shapes decided by the Chunk 0 plan: D6, D14
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const P = Date.parse;
const NOW = P('2026-10-15T12:00:00Z');
const ICS = fs.readFileSync(path.join(__dirname, 'fixtures', 'basic.ics'), 'utf8');
const SETTINGS = { timezone: 'Europe/London', horizonDays: 28, icsRefreshMinutes: 15 };

function makeEnv({ url = 'https://example.test/cal.ics', respond, providers } = {}) {
  const cal = { id: 1, name: 'Test', provider: 'ics', url, color: '#9aa0a6', enabled: true, blocking: true,
    lastFetchedAt: null, lastError: null, eventCount: 0, createdAt: '2026-10-01T00:00:00.000Z' };
  const state = { cal, events: new Map(), meta: new Map(), replaceCalls: 0, reschedules: [], fetchCalls: [], logs: [] };
  const repo = {
    async getSettings() { return { ...SETTINGS }; },
    async listCalendars() { return [cal]; },
    async getCalendar(id) { return Number(id) === cal.id ? cal : null; },
    async updateCalendar(id, p) { Object.assign(cal, p); return cal; },
    async setCalendarFetchResult(id, r) { Object.assign(cal, r); },
    async replaceCalendarEvents(id, events) { state.events.set(Number(id), events); state.replaceCalls += 1; },
    async getMeta(k) { return state.meta.has(k) ? state.meta.get(k) : null; },
    async setMeta(k, v) { state.meta.set(k, v); },
    async listEventsInRange() { return []; },
  };
  const scheduleService = { async reschedule(reason) { state.reschedules.push(reason); return {}; } };
  const fetchImpl = async (u) => { state.fetchCalls.push(String(u)); return respond(u); };
  const capture = (...a) => { state.logs.push(util.format(...a)); };
  const log = { log: capture, info: capture, warn: capture, error: capture, debug: capture };
  const { createCalendarSync } = require('../lib/calendarSync.js');
  const sync = createCalendarSync({ repo, scheduleService, fetchImpl, log, now: () => NOW, ...(providers ? { providers } : {}) });
  return { sync, state };
}
const ok = () => new Response(ICS, { status: 200, headers: { 'content-type': 'text/calendar' } });

test('T-SYNC-1: first refresh stores 11 events and reschedules once', async () => {
  const { sync, state } = makeEnv({ respond: ok });
  const r = await sync.refreshCalendar(1);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(state.events.get(1).length, 11);
  assert.strictEqual(state.reschedules.length, 1);
});

test('T-SYNC-2: identical refresh is not changed and does not reschedule', async () => {
  const { sync, state } = makeEnv({ respond: ok });
  await sync.refreshCalendar(1);
  const r = await sync.refreshCalendar(1);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(state.reschedules.length, 1);
});

test('T-SYNC-3: HTTP 404 stores lastError and keeps events', async () => {
  let respond = ok;
  const { sync, state } = makeEnv({ respond: (u) => respond(u) });
  await sync.refreshCalendar(1);
  assert.strictEqual(state.events.get(1).length, 11);
  respond = () => new Response('not found', { status: 404 });
  await sync.refreshCalendar(1);
  assert.strictEqual(state.cal.lastError, 'HTTP 404');
  assert.strictEqual(state.replaceCalls, 1);
  assert.strictEqual(state.events.get(1).length, 11);
});

test('T-SYNC-4: thrown fetch error with secret URL is scrubbed from lastError and logs', async () => {
  const { sync, state } = makeEnv({
    url: 'https://x.test/SECRET',
    respond: () => { throw new Error('failed https://x.test/SECRET'); },
  });
  await sync.refreshCalendar(1);
  assert.strictEqual(typeof state.cal.lastError, 'string');
  assert.strictEqual(state.cal.lastError.includes('SECRET'), false);
  assert.deepStrictEqual(state.logs.filter((l) => l.includes('SECRET')), []);
});

test('T-SYNC-5: webcal URL is fetched as https', async () => {
  const { sync, state } = makeEnv({ url: 'webcal://example.test/cal.ics', respond: ok });
  await sync.refreshCalendar(1);
  assert.strictEqual(state.fetchCalls[0], 'https://example.test/cal.ics');
});

test('T-SYNC-6: provider receives range and defaultTz from injected now and settings', async () => {
  const spy = [];
  const providers = {
    ics: { async fetchEvents(calendar, opts) { spy.push(opts); return { events: [], warnings: [] }; } },
  };
  const { sync } = makeEnv({ respond: ok, providers });
  await sync.refreshCalendar(1);
  assert.strictEqual(spy.length, 1);
  assert.deepStrictEqual(
    { rangeStart: spy[0].rangeStart, rangeEnd: spy[0].rangeEnd, defaultTz: spy[0].defaultTz },
    { rangeStart: P('2026-09-09T23:00:00Z'), rangeEnd: P('2026-11-19T00:00:00Z'), defaultTz: 'Europe/London' },
  );
});

test('refreshStale fetches only calendars older than maxAge and does not reschedule', async () => {
  const { sync, state } = makeEnv({ respond: ok });
  await sync.refreshStale();
  assert.strictEqual(state.fetchCalls.length, 1);
  assert.deepStrictEqual(state.reschedules, []);
  state.cal.lastFetchedAt = new Date(NOW - 30000).toISOString();
  await sync.refreshStale();
  assert.strictEqual(state.fetchCalls.length, 1);
  state.cal.lastFetchedAt = new Date(NOW - 120000).toISOString();
  await sync.refreshStale();
  assert.strictEqual(state.fetchCalls.length, 2);
});
