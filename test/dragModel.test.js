// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 0 oracle for T-DRAG — spec §13.9 (lines 923–928), §5.7 (lines 251–260), §10.3 snap rules (lines 649–652). Do not edit expectations.
// Open §5 call shapes decided by the Chunk 0 plan: D1, D2, D4, D6
const test = require('node:test');
const assert = require('node:assert');

const P = Date.parse;
const r = (o) => ({ start: P(o[0]), end: P(o[1]) });
const base = {
  origStart: P('2026-10-19T10:00:00Z'), origEnd: P('2026-10-19T11:00:00Z'), dayDelta: 0, pxPerHour: 48,
  tz: 'UTC', now: P('2026-10-19T08:00:00Z'),
};

test('T-DRAG: dragResult move, resize, clamp and past rules', async () => {
  const { dragResult } = await import('../public/js/dragModel.js');
  const run = (args) => dragResult({ ...base, ...args });

  // 29px at 48px/hour rounds to +30 min
  assert.deepStrictEqual(run({ mode: 'move', deltaYpx: 29 }),
    r(['2026-10-19T10:30:00Z', '2026-10-19T11:30:00Z']));
  // -30px = -0.625 h = -37.5 min; snaps to a 15-min grid as -30 min (Math.round(-2.5) = -2)
  assert.deepStrictEqual(run({ mode: 'move', deltaYpx: -30 }),
    r(['2026-10-19T09:30:00Z', '2026-10-19T10:30:00Z']));
  assert.deepStrictEqual(run({ mode: 'move', deltaYpx: 0, dayDelta: 1 }),
    r(['2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z']));
  assert.deepStrictEqual(run({ mode: 'move', deltaYpx: 700 }),
    r(['2026-10-19T23:00:00Z', '2026-10-20T00:00:00Z']));
  assert.deepStrictEqual(run({ mode: 'move', deltaYpx: -144 }), { error: 'past' });

  assert.deepStrictEqual(run({ mode: 'resize', deltaYpx: -50 }),
    r(['2026-10-19T10:00:00Z', '2026-10-19T10:15:00Z']));
  assert.deepStrictEqual(run({ mode: 'resize', deltaYpx: 24 }),
    r(['2026-10-19T10:00:00Z', '2026-10-19T11:30:00Z']));
  assert.deepStrictEqual(run({ mode: 'resize', deltaYpx: 800 }),
    r(['2026-10-19T10:00:00Z', '2026-10-20T00:00:00Z']));
});
