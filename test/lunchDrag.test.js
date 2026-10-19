// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Lunch move-only drag: eligibility rule (canDragLunch). Snapping for lunch is the shared dragResult (see test/dragModel.test.js).
const test = require('node:test');
const assert = require('node:assert');

test('canDragLunch: only a future lunch pseudo-event is draggable', async () => {
  const { canDragLunch } = await import('../public/js/views/drag.js');
  const lunch = { uid: 'lunch', calendarId: null, start: '2026-10-19T12:00:00Z' };
  assert.strictEqual(canDragLunch(lunch, Date.parse('2026-10-19T08:00:00Z')), true);
  assert.strictEqual(canDragLunch(lunch, Date.parse('2026-10-19T12:30:00Z')), false);
  assert.strictEqual(canDragLunch({ uid: 'abc', calendarId: 3, start: '2026-10-19T12:00:00Z' }, Date.parse('2026-10-19T08:00:00Z')), false);
});
