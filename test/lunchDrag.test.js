// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Lunch move-only drag: eligibility rule (canDragLunch). Snapping for lunch is the shared dragResult (see test/dragModel.test.js).
const test = require('node:test');
const assert = require('node:assert');

const P = Date.parse;

test('canDragLunch: today\'s lunch is draggable even after it started or ended; earlier days are not', async () => {
  const { canDragLunch } = await import('../public/js/views/drag.js');
  const lunch = { uid: 'lunch', calendarId: null, start: '2026-10-19T12:00:00Z' };
  assert.strictEqual(canDragLunch(lunch, P('2026-10-19T08:00:00Z'), 'UTC'), true);
  assert.strictEqual(canDragLunch(lunch, P('2026-10-19T12:30:00Z'), 'UTC'), true);
  assert.strictEqual(canDragLunch(lunch, P('2026-10-19T15:00:00Z'), 'UTC'), true);
  assert.strictEqual(canDragLunch({ ...lunch, start: '2026-10-18T12:00:00Z' }, P('2026-10-19T08:00:00Z'), 'UTC'), false);
  assert.strictEqual(canDragLunch({ uid: 'abc', calendarId: 3, start: '2026-10-19T12:00:00Z' }, P('2026-10-19T08:00:00Z'), 'UTC'), false);
});

test('canDragLunch: today is the local date', async () => {
  const { canDragLunch } = await import('../public/js/views/drag.js');
  const now = P('2026-10-19T12:00:00Z');   // Mon 08:00 in New York
  assert.strictEqual(canDragLunch({ uid: 'lunch', calendarId: null, start: '2026-10-19T03:00:00Z' }, now, 'America/New_York'), false);   // Sun 23:00 local
  assert.strictEqual(canDragLunch({ uid: 'lunch', calendarId: null, start: '2026-10-19T16:00:00Z' }, now, 'America/New_York'), true);    // Mon 12:00 local
});

test('missed lunch: the destination must still be in the future', async () => {
  const { dragResult } = await import('../public/js/dragModel.js');
  const g = { mode: 'move', origStart: P('2026-10-19T12:00:00Z'), origEnd: P('2026-10-19T13:00:00Z'), dayDelta: 0, pxPerHour: 48, tz: 'UTC', now: P('2026-10-19T14:10:00Z') };
  assert.deepStrictEqual(dragResult({ ...g, deltaYpx: 144 }), { start: P('2026-10-19T15:00:00Z'), end: P('2026-10-19T16:00:00Z') });
  assert.deepStrictEqual(dragResult({ ...g, deltaYpx: 48 }), { error: 'past' });
});
