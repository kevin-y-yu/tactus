// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { placeLunches } = require('../lib/lunch.js');

const P = Date.parse;
const settings = (o = {}) => ({
  timezone: 'UTC', workHours: { '0': [], '1': [['09:00', '17:00']], '2': [['09:00', '17:00']], '3': [['09:00', '17:00']], '4': [['09:00', '17:00']], '5': [['09:00', '17:00']], '6': [] },
  defaultMinBlockMin: 60, breakMin: 15, breakIntervalMin: 90, meetingBufferMin: 0, horizonDays: 3, allDayEventsBlock: false,
  hardDeadlineMarginMin: 120, lunchMin: 60, lunchStart: '12:00', lunchEnd: '14:00', ...o,
});
const now = P('2026-10-19T08:00:00Z');
const pairs = (ls) => ls.map((l) => [l.start, l.end]);

test('lunch: no overrides places one lunch per day in the window', () => {
  assert.deepStrictEqual(pairs(placeLunches(settings(), [], now)), [
    [P('2026-10-19T12:00:00Z'), P('2026-10-19T13:00:00Z')],
    [P('2026-10-20T12:00:00Z'), P('2026-10-20T13:00:00Z')],
    [P('2026-10-21T12:00:00Z'), P('2026-10-21T13:00:00Z')],
  ]);
});

test('lunch: a future override places that day exactly, outside window and hours', () => {
  assert.deepStrictEqual(pairs(placeLunches(settings(), [], now, [], { '2026-10-20': '16:30' })), [
    [P('2026-10-19T12:00:00Z'), P('2026-10-19T13:00:00Z')],
    [P('2026-10-20T16:30:00Z'), P('2026-10-20T17:30:00Z')],
    [P('2026-10-21T12:00:00Z'), P('2026-10-21T13:00:00Z')],
  ]);
});

test('lunch: an override ignores busy time', () => {
  const busy = [{ start: P('2026-10-20T16:00:00Z'), end: P('2026-10-20T17:00:00Z'), kind: 'event' }];
  assert.deepStrictEqual(pairs(placeLunches(settings(), busy, now, [], { '2026-10-20': '16:30' })), [
    [P('2026-10-19T12:00:00Z'), P('2026-10-19T13:00:00Z')],
    [P('2026-10-20T16:30:00Z'), P('2026-10-20T17:30:00Z')],
    [P('2026-10-21T12:00:00Z'), P('2026-10-21T13:00:00Z')],
  ]);
});

test('lunch: an override in the past is ignored', () => {
  assert.deepStrictEqual(pairs(placeLunches(settings(), [], now, [], { '2026-10-19': '07:00' }))[0],
    [P('2026-10-19T12:00:00Z'), P('2026-10-19T13:00:00Z')]);
});

test('lunch: a future override moves a started lunch', () => {
  const prev = [{ start: P('2026-10-19T07:30:00Z'), end: P('2026-10-19T08:30:00Z') }];
  const out = placeLunches(settings(), [], now, prev, { '2026-10-19': '15:00' });
  assert.deepStrictEqual(pairs(out), [
    [P('2026-10-19T15:00:00Z'), P('2026-10-19T16:00:00Z')],
    [P('2026-10-20T12:00:00Z'), P('2026-10-20T13:00:00Z')],
    [P('2026-10-21T12:00:00Z'), P('2026-10-21T13:00:00Z')],
  ]);
});

test('lunch: a started lunch with no override stays', () => {
  const prev = [{ start: P('2026-10-19T07:30:00Z'), end: P('2026-10-19T08:30:00Z') }];
  assert.deepStrictEqual(pairs(placeLunches(settings(), [], now, prev)), [
    [P('2026-10-19T07:30:00Z'), P('2026-10-19T08:30:00Z')],
    [P('2026-10-20T12:00:00Z'), P('2026-10-20T13:00:00Z')],
    [P('2026-10-21T12:00:00Z'), P('2026-10-21T13:00:00Z')],
  ]);
});

test('lunch: a past override does not move a started lunch', () => {
  const prev = [{ start: P('2026-10-19T07:30:00Z'), end: P('2026-10-19T08:30:00Z') }];
  const out = placeLunches(settings(), [], now, prev, { '2026-10-19': '07:45' });
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(pairs(out)[0], [P('2026-10-19T07:30:00Z'), P('2026-10-19T08:30:00Z')]);
});

test('lunch: a past day\'s lunch is never moved by an override', () => {
  const prev = [{ start: P('2026-10-18T12:00:00Z'), end: P('2026-10-18T13:00:00Z') }];
  assert.deepStrictEqual(pairs(placeLunches(settings(), [], now, prev, { '2026-10-18': '13:30' })), [
    [P('2026-10-18T12:00:00Z'), P('2026-10-18T13:00:00Z')],
    [P('2026-10-19T12:00:00Z'), P('2026-10-19T13:00:00Z')],
    [P('2026-10-20T12:00:00Z'), P('2026-10-20T13:00:00Z')],
    [P('2026-10-21T12:00:00Z'), P('2026-10-21T13:00:00Z')],
  ]);
});

test('lunch: an override that ends on the next day is ignored; one ending before midnight is kept', () => {
  const late = placeLunches(settings({ lunchMin: 90 }), [], now, [], { '2026-10-19': '23:00' });
  assert.deepStrictEqual(pairs(late)[0], [P('2026-10-19T12:00:00Z'), P('2026-10-19T13:30:00Z')]);
  const ok = placeLunches(settings(), [], now, [], { '2026-10-19': '23:00' });
  assert.deepStrictEqual(pairs(ok)[0], [P('2026-10-19T23:00:00Z'), P('2026-10-20T00:00:00Z')]);
});

test('lunch: lunchMin 0 ignores overrides', () => {
  assert.deepStrictEqual(placeLunches(settings({ lunchMin: 0 }), [], now, [], { '2026-10-20': '16:30' }), []);
});
