// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Tactus-only user events, client side: drag-create snapping, form conversions, drag eligibility (pure modules).
const test = require('node:test');
const assert = require('node:assert');

const P = Date.parse;

test('createResult: snaps the dragged span outward to 15 minutes', async () => {
  const { createResult } = await import('../public/js/dragModel.js');
  const base = { date: '2026-10-19', pxPerHour: 48, tz: 'UTC', now: P('2026-10-19T08:00:00Z') };
  assert.deepStrictEqual(createResult({ ...base, y0px: 480, y1px: 510 }), { start: P('2026-10-19T10:00:00Z'), end: P('2026-10-19T10:45:00Z') });
  assert.deepStrictEqual(createResult({ ...base, y0px: 510, y1px: 480 }), { start: P('2026-10-19T10:00:00Z'), end: P('2026-10-19T10:45:00Z') });
  assert.deepStrictEqual(createResult({ ...base, y0px: 484, y1px: 484 }), { start: P('2026-10-19T10:00:00Z'), end: P('2026-10-19T10:15:00Z') });
  assert.deepStrictEqual(createResult({ ...base, y0px: 1100, y1px: 5000 }), { start: P('2026-10-19T22:45:00Z'), end: P('2026-10-20T00:00:00Z') });
  assert.deepStrictEqual(createResult({ ...base, now: P('2026-10-18T00:00:00Z'), y0px: -50, y1px: 30 }),
    { start: P('2026-10-19T00:00:00Z'), end: P('2026-10-19T00:45:00Z') });
});

test('createResult: refuses the past', async () => {
  const { createResult } = await import('../public/js/dragModel.js');
  const base = { date: '2026-10-19', pxPerHour: 48, tz: 'UTC', y0px: 480, y1px: 510 };
  assert.deepStrictEqual(createResult({ ...base, now: P('2026-10-19T10:05:00Z') }), { error: 'past' });
  assert.deepStrictEqual(createResult({ ...base, now: P('2026-10-19T10:00:00Z') }), { start: P('2026-10-19T10:00:00Z'), end: P('2026-10-19T10:45:00Z') });
});

test('createResult: local timezone', async () => {
  const { createResult } = await import('../public/js/dragModel.js');
  const r = createResult({ date: '2026-10-19', pxPerHour: 48, tz: 'Europe/London', y0px: 480, y1px: 528, now: P('2026-10-18T00:00:00Z') });
  assert.deepStrictEqual(r, { start: P('2026-10-19T09:00:00Z'), end: P('2026-10-19T10:00:00Z') });
});

test('userEventBody: form values to an API body', async () => {
  const { userEventBody } = await import('../public/js/userEventModel.js');
  assert.deepStrictEqual(userEventBody({ title: ' Standup ', date: '2026-10-19', start: '09:00', end: '09:30' }, 'UTC'),
    { title: 'Standup', start: '2026-10-19T09:00:00.000Z', end: '2026-10-19T09:30:00.000Z' });
  assert.strictEqual(userEventBody({ title: 'N', date: '2026-10-19', start: '23:00', end: '00:00' }, 'UTC').end, '2026-10-20T00:00:00.000Z');
  assert.strictEqual(userEventBody({ title: 'L', date: '2026-10-19', start: '09:00', end: '10:00' }, 'Europe/London').start, '2026-10-19T08:00:00.000Z');
  assert.throws(() => userEventBody({ title: 'X', date: '2026-10-19', start: '10:00', end: '09:00' }, 'UTC'), /End must be after start/);
  assert.throws(() => userEventBody({ title: '  ', date: '2026-10-19', start: '10:00', end: '11:00' }, 'UTC'), /title/);
  assert.throws(() => userEventBody({ title: 'X', date: '', start: '10:00', end: '11:00' }, 'UTC'), /date/);
});

test('userEventFormValues and defaultNewEventValues', async () => {
  const { userEventFormValues, defaultNewEventValues } = await import('../public/js/userEventModel.js');
  assert.deepStrictEqual(userEventFormValues({ title: 'A', start: '2026-10-19T23:00:00.000Z', end: '2026-10-20T00:00:00.000Z' }, 'UTC'),
    { title: 'A', date: '2026-10-19', start: '23:00', end: '00:00' });
  assert.deepStrictEqual(defaultNewEventValues(P('2026-10-19T10:20:00Z'), 'UTC'), { title: '', date: '2026-10-19', start: '11:00', end: '12:00' });
  assert.deepStrictEqual(defaultNewEventValues(P('2026-10-19T22:30:00Z'), 'UTC'), { title: '', date: '2026-10-19', start: '23:00', end: '00:00' });
  assert.deepStrictEqual(defaultNewEventValues(P('2026-10-19T23:10:00Z'), 'UTC'), { title: '', date: '2026-10-20', start: '00:00', end: '01:00' });
});

test('user event drag eligibility', async () => {
  const { canDragUserEvent, canResizeUserEvent } = await import('../public/js/views/drag.js');
  const { userEventDbId, isUserEvent } = await import('../public/js/userEventModel.js');
  const ev = { uid: 'user', calendarId: null, start: '2026-10-19T12:00:00Z' };
  assert.strictEqual(canDragUserEvent(ev, P('2026-10-19T10:00:00Z')), true);
  assert.strictEqual(canDragUserEvent(ev, P('2026-10-19T12:30:00Z')), false);
  assert.strictEqual(canDragUserEvent({ ...ev, uid: 'lunch' }, P('2026-10-19T10:00:00Z')), false);
  assert.strictEqual(canDragUserEvent({ ...ev, calendarId: 3 }, P('2026-10-19T10:00:00Z')), false);
  assert.strictEqual(canResizeUserEvent({ start: '2026-10-19T10:00:00Z', end: '2026-10-19T11:00:00Z' }, '2026-10-19', 'UTC'), true);
  assert.strictEqual(canResizeUserEvent({ start: '2026-10-19T23:00:00Z', end: '2026-10-20T00:00:00Z' }, '2026-10-19', 'UTC'), true);
  assert.strictEqual(canResizeUserEvent({ start: '2026-10-19T23:00:00Z', end: '2026-10-20T01:00:00Z' }, '2026-10-19', 'UTC'), false);
  assert.strictEqual(userEventDbId({ id: 'user:7' }), 7);
  assert.strictEqual(isUserEvent({ uid: 'user', calendarId: null }), true);
});
