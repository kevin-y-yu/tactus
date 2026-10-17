// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// applyBuffers: one-sided meeting buffer after 'event' intervals (§9.1.4).
const test = require('node:test');
const assert = require('node:assert');

const { applyBuffers } = require('../lib/scheduler.js');
const P = Date.parse;
const MIN = 60000;
const s = (buf) => ({ meetingBufferMin: buf });
const ev = (startIso, mins, kind = 'event') => {
  const start = P(startIso);
  return { start, end: start + mins * MIN, kind };
};

test('buffer: 15-minute event with 15-minute buffer is unchanged', () => {
  const b = [ev('2026-10-23T09:00:00Z', 15)];
  assert.deepStrictEqual(applyBuffers(b, s(15)), [{ start: b[0].start, end: b[0].end, kind: 'event' }]);
});

test('buffer: exactly 30-minute event with 15-minute buffer is unchanged (duration <= 2 * buffer)', () => {
  const b = [ev('2026-10-23T09:00:00Z', 30)];
  assert.deepStrictEqual(applyBuffers(b, s(15)), [{ start: b[0].start, end: b[0].end, kind: 'event' }]);
});

test('buffer: 45-minute event gets a buffer after it only, start unchanged', () => {
  const b = [ev('2026-10-23T09:00:00Z', 45)];
  assert.deepStrictEqual(applyBuffers(b, s(15)),
    [{ start: P('2026-10-23T09:00:00Z'), end: P('2026-10-23T09:45:00Z') + 15 * MIN, kind: 'event' }]);
});

test('buffer: allday interval is unchanged', () => {
  const b = [ev('2026-10-23T00:00:00Z', 1440, 'allday')];
  assert.deepStrictEqual(applyBuffers(b, s(15)), [{ start: b[0].start, end: b[0].end, kind: 'allday' }]);
});

test('buffer: work interval is unchanged', () => {
  const b = [ev('2026-10-23T09:00:00Z', 45, 'work')];
  assert.deepStrictEqual(applyBuffers(b, s(15)), [{ start: b[0].start, end: b[0].end, kind: 'work' }]);
});

test('buffer: meetingBufferMin 0 leaves a long event unchanged', () => {
  const b = [ev('2026-10-23T09:00:00Z', 60)];
  assert.deepStrictEqual(applyBuffers(b, s(0)), [{ start: b[0].start, end: b[0].end, kind: 'event' }]);
});

test('buffer: returns new objects and does not mutate inputs', () => {
  const b = [ev('2026-10-23T09:00:00Z', 60)];
  const before = { ...b[0] };
  const out = applyBuffers(b, s(15));
  assert.notStrictEqual(out[0], b[0]);
  assert.deepStrictEqual(b[0], before);
});
