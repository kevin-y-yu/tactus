// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 0 oracle for T-REC-1..11 — spec §13.3 (lines 771–783), §9.9 (lines 547–558), §5.3 (lines 192–198). Do not edit expectations.
// Open §5 call shapes decided by the Chunk 0 plan: D5, D6
// rec input = §8.1 Recurring object; periodStart/periodEnd/start/end compared as epoch ms (D6); ranges inclusive dates.
const test = require('node:test');
const assert = require('node:assert');

const P = Date.parse;
const rec = (over = {}) => ({ id: 7, title: 'Rec', notes: '', projectId: null, frequency: 'daily', daysOfWeek: [], dayOfMonth: null,
  durationMin: 30, windowStart: null, windowEnd: null, priority: 'medium', startDate: '2026-10-01', endDate: null, active: true,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over });   // §8.1 Recurring shape
const lib = () => require('../lib/recurrence.js');
const byDate = (occs) => Object.fromEntries(occs.map((o) => [o.occurrenceDate, o]));
// placement fixture (spec §13.4 settings, now Mon 08:00)
const NOW = P('2026-10-19T08:00:00Z');
const WH = { '0': [], '1': [['09:00', '17:00']], '2': [['09:00', '17:00']], '3': [['09:00', '17:00']],
             '4': [['09:00', '17:00']], '5': [['09:00', '17:00']], '6': [] };
const settings = (over = {}) => ({ timezone: 'UTC', workHours: structuredClone(WH), defaultMinBlockMin: 60, breakMin: 15,
  breakIntervalMin: 90, meetingBufferMin: 15, horizonDays: 7, allDayEventsBlock: false, hardDeadlineMarginMin: 120, ...over });
const occ = (over = {}) => ({ recurringId: 7, occurrenceDate: '2026-10-19', periodStart: P('2026-10-19T00:00:00Z'),
  periodEnd: P('2026-10-20T00:00:00Z'), durationMin: 30, priority: 'medium', windowStart: null, windowEnd: null, ...over });

// asserts occurrenceDates and generateOccurrences agree on the date list, returns the byDate map of the latter
function datesOf(r, from, to, tz, expectDates) {
  assert.deepStrictEqual(lib().occurrenceDates(r, from, to), expectDates);
  const occs = lib().generateOccurrences(r, from, to, tz);
  assert.deepStrictEqual(occs.map((o) => o.occurrenceDate), expectDates);
  return byDate(occs);
}

test('T-REC-1: daily rule over 10-19..21 gives three dates and the 10-21 period', () => {
  const d = datesOf(rec(), '2026-10-19', '2026-10-21', 'UTC', ['2026-10-19', '2026-10-20', '2026-10-21']);
  assert.deepStrictEqual([d['2026-10-21'].periodStart, d['2026-10-21'].periodEnd], [P('2026-10-21T00:00:00Z'), P('2026-10-22T00:00:00Z')]);
});

test('T-REC-2: weekdays rule over 10-23..27 skips the weekend and ends period at Monday', () => {
  const d = datesOf(rec({ frequency: 'weekdays' }), '2026-10-23', '2026-10-27', 'UTC', ['2026-10-23', '2026-10-26', '2026-10-27']);
  assert.deepStrictEqual(d['2026-10-23'].periodEnd, P('2026-10-26T00:00:00Z'));
});

test('T-REC-3: weekly Mon and Thu over 10-19..25 gives two dates with period ends', () => {
  const d = datesOf(rec({ frequency: 'weekly', daysOfWeek: [1, 4] }), '2026-10-19', '2026-10-25', 'UTC', ['2026-10-19', '2026-10-22']);
  assert.deepStrictEqual([d['2026-10-19'].periodEnd, d['2026-10-22'].periodEnd], [P('2026-10-22T00:00:00Z'), P('2026-10-26T00:00:00Z')]);
});

test('T-REC-4: monthly day 31 clamps to month end over 11-01..2027-01-31', () => {
  const d = datesOf(rec({ frequency: 'monthly', dayOfMonth: 31 }), '2026-11-01', '2027-01-31', 'UTC', ['2026-11-30', '2026-12-31', '2027-01-31']);
  assert.deepStrictEqual(d['2026-11-30'].periodEnd, P('2026-12-31T00:00:00Z'));
});

test('T-REC-5: startDate and endDate bound the daily rule over 10-19..25', () => {
  const d = datesOf(rec({ startDate: '2026-10-20', endDate: '2026-10-21' }), '2026-10-19', '2026-10-25', 'UTC', ['2026-10-20', '2026-10-21']);
  assert.deepStrictEqual(d['2026-10-21'].periodEnd, P('2026-10-22T00:00:00Z'));
});

test('T-REC-6: Europe/London local day 10-25 maps to UTC instants 10-24T23:00Z to 10-26T00:00Z', () => {
  const occs = lib().generateOccurrences(rec(), '2026-10-25', '2026-10-25', 'Europe/London');
  const d = byDate(occs);
  assert.deepStrictEqual([d['2026-10-25'].periodStart, d['2026-10-25'].periodEnd], [P('2026-10-24T23:00:00Z'), P('2026-10-26T00:00:00Z')]);
});

test('T-REC-7: window 07:00 to 08:30 becomes minutes 420 and 510', () => {
  const o = lib().generateOccurrences(rec({ windowStart: '07:00', windowEnd: '08:30' }), '2026-10-19', '2026-10-19', 'UTC');
  assert.deepStrictEqual(o.map((x) => [x.windowStart, x.windowEnd]), [[420, 510]]);
});

test('T-REC-8: occurrence inside a free 07:00 to 08:30 window is placed at 08:00', () => {
  const out = lib().placeOccurrences([occ({ windowStart: 420, windowEnd: 510 })], [], settings(), NOW);
  assert.deepStrictEqual(out.blocks.map((b) => ({ recurringId: b.recurringId, occurrenceDate: b.occurrenceDate, start: b.start, end: b.end })),
    [{ recurringId: 7, occurrenceDate: '2026-10-19', start: P('2026-10-19T08:00:00Z'), end: P('2026-10-19T08:30:00Z') }]);
  assert.deepStrictEqual(out.atRisk, []);
});

test('T-REC-9: occurrence whose 07:00 to 08:00 window has passed falls back to work hours at 09:00', () => {
  const out = lib().placeOccurrences([occ({ windowStart: 420, windowEnd: 480 })], [], settings(), NOW);
  assert.deepStrictEqual(out.blocks.map((b) => ({ recurringId: b.recurringId, occurrenceDate: b.occurrenceDate, start: b.start, end: b.end })),
    [{ recurringId: 7, occurrenceDate: '2026-10-19', start: P('2026-10-19T09:00:00Z'), end: P('2026-10-19T09:30:00Z') }]);
  assert.deepStrictEqual(out.atRisk, []);
});

test('T-REC-10: busy event covering the window and work hours leaves the occurrence unscheduled', () => {
  const busy = [{ start: P('2026-10-19T09:00:00Z'), end: P('2026-10-19T17:00:00Z'), kind: 'event' }];
  const out = lib().placeOccurrences([occ({ windowStart: 420, windowEnd: 480 })], busy, settings(), NOW);
  assert.deepStrictEqual(out.blocks, []);
  assert.deepStrictEqual(out.atRisk.map((a) => ({ recurringId: a.recurringId, occurrenceDate: a.occurrenceDate, kind: a.kind })),
    [{ recurringId: 7, occurrenceDate: '2026-10-19', kind: 'unscheduled' }]);
});

test('T-REC-11: higher priority occurrence is placed first when both want the same window', () => {
  const out = lib().placeOccurrences([occ({ windowStart: 480, windowEnd: 510 }),
    occ({ recurringId: 8, priority: 'high', windowStart: 480, windowEnd: 510 })], [], settings(), NOW);
  assert.deepStrictEqual(out.blocks.map((b) => [b.recurringId, b.start, b.end]),
    [[8, P('2026-10-19T08:00:00Z'), P('2026-10-19T08:30:00Z')], [7, P('2026-10-19T09:00:00Z'), P('2026-10-19T09:30:00Z')]]);
  assert.deepStrictEqual(out.atRisk, []);
});

test('recurring split: a 4 h occurrence spreads over two ranges with a lunch gap', () => {
  const wh = { '1': [['10:30', '13:00'], ['14:00', '17:30']] };
  const out = lib().placeOccurrences([occ({ durationMin: 240, minBlockMin: 30 })], [], settings({ workHours: wh }), NOW);
  assert.deepStrictEqual(out.atRisk, []);
  assert.strictEqual(out.blocks.reduce((n, b) => n + (b.end - b.start), 0), 240 * 60000);
  assert.ok(out.blocks.length >= 2);
});

test('recurring split: without minBlockMin the occurrence stays contiguous and is unscheduled if nothing fits', () => {
  const wh = { '1': [['10:30', '13:00'], ['14:00', '17:30']] };
  const out = lib().placeOccurrences([occ({ durationMin: 240 })], [], settings({ workHours: wh }), NOW);
  assert.deepStrictEqual(out.blocks, []);
  assert.strictEqual(out.atRisk[0].unscheduledMin, 240);
});

test('recurring split: pieces never fall below minBlockMin', () => {
  const wh = { '1': [['10:00', '11:00'], ['12:00', '13:00'], ['14:00', '14:15']] };
  const out = lib().placeOccurrences([occ({ durationMin: 150, minBlockMin: 60 })], [], settings({ workHours: wh }), NOW);
  assert.ok(out.blocks.every((b) => b.end - b.start >= 60 * 60000));
  assert.strictEqual(out.atRisk[0].unscheduledMin, 30);
});

test('weekly rule with no weekdays is one occurrence per week, keyed by the week start', () => {
  const r = rec({ frequency: 'weekly', daysOfWeek: [], durationMin: 240, startDate: '2026-10-17' });
  const mon = lib().generateOccurrences(r, '2026-10-17', '2026-11-01', 'UTC', 1);
  assert.deepStrictEqual(mon.map((o) => o.occurrenceDate), ['2026-10-12', '2026-10-19', '2026-10-26']);
  assert.strictEqual(mon[0].periodStart, P('2026-10-17T00:00:00Z'));
  assert.strictEqual(mon[1].periodEnd, P('2026-10-26T00:00:00Z'));
  const sun = lib().generateOccurrences(r, '2026-10-17', '2026-11-01', 'UTC', 0);
  assert.deepStrictEqual(sun.map((o) => o.occurrenceDate), ['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01']);
});

test('recurring respects the break rule: a 4 h occurrence is cut into runs of at most 90 min with 15 min breaks', () => {
  const out = lib().placeOccurrences([occ({ durationMin: 240, minBlockMin: 30 })], [], settings(), NOW);
  assert.deepStrictEqual(out.atRisk, []);
  assert.ok(out.blocks.every((b) => b.end - b.start <= 90 * 60000));
  for (let i = 1; i < out.blocks.length; i++) assert.ok(out.blocks[i].start - out.blocks[i - 1].end >= 15 * 60000, 'break between runs');
});

// Any-day weekly is the only rule whose window may use other days of its week; a plain occurrence stays on its own day.
const LON_WH = { '0': [], '1': [['09:00', '12:30'], ['13:30', '17:30']], '2': [['09:00', '12:30'], ['13:30', '17:30']],
                 '3': [['09:00', '12:30'], ['13:30', '17:30']], '4': [['09:00', '12:30'], ['13:30', '17:30']],
                 '5': [['09:00', '12:30'], ['13:30', '17:30']], '6': [] };
const LON_NOW = P('2026-10-17T10:00:00Z');
const lonOcc = (over = {}) => occ({ occurrenceDate: '2026-10-23', periodStart: P('2026-10-22T23:00:00Z'),
  periodEnd: P('2026-10-25T23:00:00Z'), durationMin: 30, windowStart: 540, windowEnd: 570, ...over });
const lonSettings = () => settings({ timezone: 'Europe/London', meetingBufferMin: 15, workHours: structuredClone(LON_WH) });

test('recurring window uses only the occurrence day: free 09:00-09:30 London window on Friday is used', () => {
  const busy = [{ start: P('2026-10-23T08:30:00Z'), end: P('2026-10-23T09:30:00Z'), kind: 'event' }];
  const out = lib().placeOccurrences([lonOcc()], busy, lonSettings(), LON_NOW);
  assert.deepStrictEqual(out.blocks.map((b) => ({ occurrenceDate: b.occurrenceDate, start: b.start, end: b.end })),
    [{ occurrenceDate: '2026-10-23', start: P('2026-10-23T08:00:00Z'), end: P('2026-10-23T08:30:00Z') }]);
  assert.deepStrictEqual(out.atRisk, []);
});

test('recurring window uses only the occurrence day: blocked window does not spill onto Saturday', () => {
  const busy = [{ start: P('2026-10-23T07:30:00Z'), end: P('2026-10-23T08:45:00Z'), kind: 'event' }];
  const out = lib().placeOccurrences([lonOcc()], busy, lonSettings(), LON_NOW);
  assert.deepStrictEqual(out.blocks.map((b) => ({ occurrenceDate: b.occurrenceDate, start: b.start, end: b.end })),
    [{ occurrenceDate: '2026-10-23', start: P('2026-10-23T09:00:00Z'), end: P('2026-10-23T09:30:00Z') }]);
  assert.ok(!out.blocks.some((b) => b.occurrenceDate === '2026-10-24' || b.start >= P('2026-10-24T00:00:00Z')));
  assert.deepStrictEqual(out.atRisk, []);
});
