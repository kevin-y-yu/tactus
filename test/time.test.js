// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../public/shared/time.js');

const LON = 'Europe/London';
const NY = 'America/New_York';
const at = (iso) => Date.parse(iso);

// §13.1 expectations, in spec order.

test('T-TIME-1: zonedToUtc spring-forward gap shifts forward (London 01:30 on 2026-03-29)', () => {
  assert.strictEqual(t.zonedToUtc('2026-03-29', 90, LON), at('2026-03-29T01:30:00Z'));
});

test('T-TIME-2: zonedToUtc ambiguous time resolves to the later instant (London 01:30 on 2026-10-25)', () => {
  assert.strictEqual(t.zonedToUtc('2026-10-25', 90, LON), at('2026-10-25T01:30:00Z'));
});

test('T-TIME-3: zonedToUtc summer time (London 09:00 on 2026-07-01)', () => {
  assert.strictEqual(t.zonedToUtc('2026-07-01', 540, LON), at('2026-07-01T08:00:00Z'));
});

test('T-TIME-4: zonedToUtc winter time (London 09:00 on 2026-01-01)', () => {
  assert.strictEqual(t.zonedToUtc('2026-01-01', 540, LON), at('2026-01-01T09:00:00Z'));
});

test('T-TIME-5: zonedToUtc minute 1440 is next local midnight on the fall-back day', () => {
  assert.strictEqual(t.zonedToUtc('2026-10-25', 1440, LON), at('2026-10-26T00:00:00Z'));
});

test('T-TIME-6: zonedToUtc minute 0 on the fall-back day', () => {
  assert.strictEqual(t.zonedToUtc('2026-10-25', 0, LON), at('2026-10-24T23:00:00Z'));
});

test('T-TIME-7: zonedToUtc New York 09:00 on 2026-10-12', () => {
  assert.strictEqual(t.zonedToUtc('2026-10-12', 540, NY), at('2026-10-12T13:00:00Z'));
});

test('T-TIME-8: utcToZoned 2026-10-24T23:30Z in London', () => {
  const z = t.utcToZoned(at('2026-10-24T23:30:00Z'), LON);
  assert.strictEqual(z.date, '2026-10-25');
  assert.strictEqual(z.minutes, 30);
  assert.strictEqual(z.weekday, 0);
  assert.deepStrictEqual(z, {
    date: '2026-10-25', minutes: 30, weekday: 0,
    year: 2026, month: 10, day: 25, hour: 0, minute: 30,
  });
});

test('T-TIME-9: addDays crosses a year boundary', () => {
  assert.strictEqual(t.addDays('2026-12-31', 1), '2027-01-01');
});

test('T-TIME-10: weekdayOf Monday 2026-10-19 is 1', () => {
  assert.strictEqual(t.weekdayOf('2026-10-19'), 1);
});

test('T-TIME-11: daysInMonth leap February 2028 is 29', () => {
  assert.strictEqual(t.daysInMonth(2028, 2), 29);
});

test('T-TIME-12: localInputToIso London and back via isoToLocalInput', () => {
  assert.strictEqual(t.localInputToIso('2026-10-20T17:00', LON), '2026-10-20T16:00:00.000Z');
  assert.strictEqual(t.isoToLocalInput('2026-10-20T16:00:00.000Z', LON), '2026-10-20T17:00');
});

test('T-TIME-13: localInputToIso of empty string is null', () => {
  assert.strictEqual(t.localInputToIso('', 'UTC'), null);
});

test('T-TIME-14: parseHHMM', () => {
  assert.strictEqual(t.parseHHMM('24:00'), 1440);
  assert.strictEqual(t.parseHHMM('09:30'), 570);
});

test('T-TIME-15: formatHHMM', () => {
  assert.strictEqual(t.formatHHMM(570), '09:30');
});

test('T-TIME-16: ceilGrid(1) is 900000', () => {
  assert.strictEqual(t.ceilGrid(1), 900000);
});

test('T-TIME-17: floorGrid(900001) is 900000', () => {
  assert.strictEqual(t.floorGrid(900001), 900000);
});

// Extra checks derived from the §5.1 interface.

test('T-TIME-18: exports exactly the §5.1 names with MIN and GRID values', () => {
  const names = [
    'MIN', 'GRID', 'ceilGrid', 'floorGrid', 'parseHHMM', 'formatHHMM', 'addDays', 'weekdayOf',
    'daysInMonth', 'isValidTimeZone', 'tzOffsetMs', 'zonedToUtc', 'utcToZoned', 'startOfLocalDay',
    'localInputToIso', 'isoToLocalInput',
  ];
  assert.deepStrictEqual(Object.keys(t).sort(), [...names].sort());
  assert.strictEqual(t.MIN, 60000);
  assert.strictEqual(t.GRID, 900000);
  for (const n of names.slice(2)) assert.strictEqual(typeof t[n], 'function', n);
});

test('T-TIME-19: tzOffsetMs summer London and autumn New York', () => {
  assert.strictEqual(t.tzOffsetMs(at('2026-07-01T12:00:00Z'), LON), 3600000);
  assert.strictEqual(t.tzOffsetMs(at('2026-10-12T13:00:00Z'), NY), -14400000);
});

test('T-TIME-20: startOfLocalDay on the London fall-back day', () => {
  assert.strictEqual(t.startOfLocalDay(at('2026-10-25T12:00:00Z'), LON), at('2026-10-24T23:00:00Z'));
});

test('T-TIME-21: isValidTimeZone', () => {
  assert.strictEqual(t.isValidTimeZone('Europe/London'), true);
  assert.strictEqual(t.isValidTimeZone('UTC'), true);
  assert.strictEqual(t.isValidTimeZone('Not/AZone'), false);
  assert.strictEqual(t.isValidTimeZone(''), false);
});

test('T-TIME-22: parseHHMM rejects malformed values with NaN', () => {
  assert.ok(Number.isNaN(t.parseHHMM('24:30')));
  assert.ok(Number.isNaN(t.parseHHMM('9:30')));
  assert.ok(Number.isNaN(t.parseHHMM('12:60')));
  assert.ok(Number.isNaN(t.parseHHMM(null)));
});
