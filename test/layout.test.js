// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 0 oracle for T-LAY — spec §13.9 (lines 923–928), §5.7 (lines 251–260). Do not edit expectations.
// Open §5 call shapes decided by the Chunk 0 plan: D1, D2, D4, D6
const test = require('node:test');
const assert = require('node:assert');

const H = (hm) => Date.parse('2026-10-19T' + hm + ':00Z');

test('T-LAY: layoutLanes lanes and weekDates', async () => {
  const { layoutLanes, weekDates } = await import('../public/js/layout.js');
  const lanes = (out) => Object.fromEntries(out.map((o) => [o.id, [o.lane, o.lanes]]));

  // A 09:00-10:00, B 09:30-10:30, C 10:30-11:00
  assert.deepStrictEqual(
    lanes(layoutLanes([
      { id: 1, start: H('09:00'), end: H('10:00') },
      { id: 2, start: H('09:30'), end: H('10:30') },
      { id: 3, start: H('10:30'), end: H('11:00') },
    ])),
    { 1: [0, 2], 2: [1, 2], 3: [0, 1] },
  );

  // Disjoint intervals each get lane 0 of 1
  assert.deepStrictEqual(
    lanes(layoutLanes([
      { id: 1, start: H('09:00'), end: H('10:00') },
      { id: 2, start: H('11:00'), end: H('12:00') },
      { id: 3, start: H('13:00'), end: H('14:00') },
    ])),
    { 1: [0, 1], 2: [0, 1], 3: [0, 1] },
  );

  // Mutually overlapping intervals all report 3 lanes
  assert.deepStrictEqual(
    Object.fromEntries(layoutLanes([
      { id: 1, start: H('09:00'), end: H('12:00') },
      { id: 2, start: H('09:30'), end: H('11:00') },
      { id: 3, start: H('10:00'), end: H('10:30') },
    ]).map((o) => [o.id, o.lanes])),
    { 1: 3, 2: 3, 3: 3 },
  );

  assert.strictEqual(weekDates('2026-10-21', 1)[0], '2026-10-19');
  assert.strictEqual(weekDates('2026-10-21', 0)[0], '2026-10-18');
});
