// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Chunk 0 oracle for T-ICS-1..3 — spec §13.6 (lines 859–868). Do not edit expectations.
// Open §5 call shapes decided by the Chunk 0 plan: D6, D13
// Must pass under TZ=UTC and TZ=America/Los_Angeles (spec L868); all instants are Date.parse('…Z') so host TZ is irrelevant.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'basic.ics'), 'utf8');
const P = Date.parse;
const OPTS = { rangeStart: P('2026-10-01T00:00:00Z'), rangeEnd: P('2026-11-01T00:00:00Z'), defaultTz: 'Europe/London' };

test('T-ICS-1: basic fixture parses to the 11 expected records', () => {
  // D13 fixture self-checks, before the module is loaded
  assert.strictEqual(FIXTURE.split(/\r?\n/).includes('half'), true);
  assert.strictEqual((FIXTURE.match(/^BEGIN:VEVENT$/gm) || []).length, 10);

  const { parseIcs } = require('../lib/ics.js');
  const { events } = parseIcs(FIXTURE, OPTS);
  assert.strictEqual(events.length, 11);
  assert.deepStrictEqual(
    events.filter((e) => e.uid === 'a1').map((e) => e.start),
    [P('2026-10-12T13:00:00Z'), P('2026-10-16T15:00:00Z'), P('2026-10-19T13:00:00Z'),
      P('2026-10-21T13:00:00Z'), P('2026-10-23T13:00:00Z')],
  );
  assert.deepStrictEqual(
    events.filter((e) => e.uid === 'a1' && e.start === P('2026-10-16T15:00:00Z')).map((e) => e.title),
    ['Standup moved'],
  );
  assert.deepStrictEqual(
    events.filter((e) => e.uid === 'b2').map((e) => ({ allDay: e.allDay, startDate: e.startDate, endDate: e.endDate, start: e.start })),
    [{ allDay: true, startDate: '2026-10-20', endDate: '2026-10-21', start: P('2026-10-19T23:00:00Z') }],
  );
  assert.deepStrictEqual(
    events.filter((e) => e.uid === 'c3').map((e) => [e.start, e.end]),
    [[P('2026-10-15T08:00:00Z'), P('2026-10-15T09:00:00Z')]],
  );
  assert.deepStrictEqual(
    events.filter((e) => e.uid === 'c4').map((e) => [e.start, e.end]),
    [[P('2026-10-15T09:00:00Z'), P('2026-10-15T09:45:00Z')]],
  );
  assert.deepStrictEqual(
    events.filter((e) => e.uid === 'c5').map((e) => e.start),
    [P('2026-10-15T08:00:00Z')],
  );
  assert.deepStrictEqual(
    events.filter((e) => e.uid === 'c6').map((e) => e.transparent),
    [true],
  );
  assert.deepStrictEqual(events.filter((e) => e.uid === 'c7' || e.uid === 'c8'), []);
  assert.deepStrictEqual(
    events.filter((e) => e.uid === 'd9').map((e) => e.title),
    ['Brokenhalf'],
  );
});

test('T-ICS-2: cancelled exception removes the a1 occurrence of 10-19', () => {
  // EXTRA adds a CANCELLED RECURRENCE-ID override for the 10-19 occurrence of a1.
  // Derived from §9.11 steps 2/4/5: the cancelled override removes that occurrence, so 4 a1 records remain.
  const EXTRA = [
    'BEGIN:VEVENT',
    'UID:a1',
    'DTSTAMP:20261001T000000Z',
    'RECURRENCE-ID;TZID=America/New_York:20261019T090000',
    'DTSTART;TZID=America/New_York:20261019T090000',
    'DTEND;TZID=America/New_York:20261019T093000',
    'STATUS:CANCELLED',
    'SUMMARY:Standup',
    'END:VEVENT',
  ].join('\n') + '\n';
  const text = FIXTURE.replace('END:VCALENDAR', EXTRA + 'END:VCALENDAR');

  const { parseIcs } = require('../lib/ics.js');
  const { events } = parseIcs(text, OPTS);
  assert.deepStrictEqual(
    events.filter((e) => e.uid === 'a1' && e.start === P('2026-10-19T13:00:00Z')),
    [],
  );
  // non-vacuity guard
  assert.strictEqual(events.filter((e) => e.uid === 'a1').length, 4);
});

test('T-ICS-3: redactUrl keeps protocol and host only', () => {
  const { redactUrl } = require('../lib/ics.js');
  assert.strictEqual(
    redactUrl('webcal://p01-caldav.icloud.com/published/2/SECRET'),
    'webcal://p01-caldav.icloud.com/...',
  );
});
