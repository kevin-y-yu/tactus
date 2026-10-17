// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// v2 Chunk 20 — T-V2-SET-1…4. Spec spec-v2 §R3 (V2-D11) Acceptance.
const test = require('node:test');
const assert = require('node:assert');
const { SETTINGS_KEYS } = require('../lib/validate.js');

const model = () => import('../public/js/settingsModel.js');
const EMPTY_WEEK = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

test('T-V2-SET-1: parseRoute sets params.section for settings; sectionFromRoute falls back to schedules', async () => {
  const { parseRoute } = await import('../public/js/ui.js');
  const { sectionFromRoute } = await model();
  assert.strictEqual(parseRoute('#/settings/calendars').params.section, 'calendars');
  assert.strictEqual(parseRoute('#/settings').params.section, null);
  assert.strictEqual(parseRoute('#/settings/').params.section, null);
  assert.strictEqual(parseRoute('#/settings/rules?x=1').params.section, 'rules');
  assert.strictEqual(parseRoute('#/settings/nope').params.section, 'nope');
  assert.strictEqual(sectionFromRoute(null), 'schedules');
  assert.strictEqual(sectionFromRoute('nope'), 'schedules');
  assert.strictEqual(sectionFromRoute('general'), 'general');
  // other routes unchanged
  assert.deepStrictEqual(parseRoute('#/week/2026-10-19').params, { date: '2026-10-19' });
  assert.deepStrictEqual(parseRoute('#/day').params, { date: null });
  assert.deepStrictEqual(parseRoute('#/task/7').params, { id: '7' });
  assert.strictEqual(parseRoute('#/task'), null);
  assert.deepStrictEqual(parseRoute('#/agenda').params, {});
  assert.strictEqual(parseRoute('#/nope'), null);
});

test('T-V2-SET-2: SETTINGS_SECTIONS order and labels', async () => {
  const { SETTINGS_SECTIONS } = await model();
  assert.deepStrictEqual(SETTINGS_SECTIONS.map((s) => s.id), ['schedules', 'calendars', 'rules', 'general']);
  assert.deepStrictEqual(SETTINGS_SECTIONS.map((s) => s.label),
    ['Work hours & schedules', 'Calendars', 'Scheduling rules', 'General']);
});

test('T-V2-SET-3: workHoursBody keeps v1 behaviour', async () => {
  const { workHoursBody } = await model();
  // body always has keys "0".."6" (missing day = [])
  assert.deepStrictEqual(workHoursBody({}), { error: null, body: EMPTY_WEEK });
  // trims
  assert.deepStrictEqual(workHoursBody({ 1: [[' 09:00 ', '17:00 ']] }).body, { ...EMPTY_WEEK, 1: [['09:00', '17:00']] });
  // drops pairs with both blank (blank, whitespace, null, undefined)
  assert.deepStrictEqual(workHoursBody({ 2: [['', '  '], [null, undefined], ['09:00', '10:00']] }),
    { error: null, body: { ...EMPTY_WEEK, 2: [['09:00', '10:00']] } });
  // one blank -> error naming the weekday, body null
  assert.deepStrictEqual(workHoursBody({ 1: [['09:00', '']] }),
    { error: 'Mon: fill both times or remove the row.', body: null });
  assert.deepStrictEqual(workHoursBody({ 0: [['', '10:00']] }),
    { error: 'Sun: fill both times or remove the row.', body: null });
  // days are checked in order 0..6: the first bad day wins
  assert.strictEqual(workHoursBody({ 3: [['09:00', '']], 1: [['', '10:00']] }).error, 'Mon: fill both times or remove the row.');
  // sorts each day by start (string order)
  assert.deepStrictEqual(workHoursBody({ 4: [['13:00', '17:00'], ['08:00', '12:00'], ['09:30', '10:00']] }).body[4],
    [['08:00', '12:00'], ['09:30', '10:00'], ['13:00', '17:00']]);
  assert.deepStrictEqual(workHoursBody({ 5: [['23:00', '24:00'], ['09:00', '10:00']] }).body[5],
    [['09:00', '10:00'], ['23:00', '24:00']]);
});

test('T-V2-SET-3: changedSettings keeps v1 behaviour (shallow strict diff)', async () => {
  const { changedSettings } = await model();
  assert.deepStrictEqual(changedSettings({ breakMin: 15, timezone: 'UTC' }, { breakMin: 15, timezone: 'Europe/London' }),
    { timezone: 'Europe/London' });
  assert.deepStrictEqual(changedSettings({ breakMin: 15 }, { breakMin: 15 }), {});
  assert.deepStrictEqual(changedSettings(null, { breakMin: 15, weekStartsOn: 1 }), { breakMin: 15, weekStartsOn: 1 });
  assert.deepStrictEqual(changedSettings({ weekStartsOn: 1 }, { weekStartsOn: '1' }), { weekStartsOn: '1' });
  assert.deepStrictEqual(changedSettings({ allDayEventsBlock: true }, { allDayEventsBlock: false }), { allDayEventsBlock: false });
});

test('T-V2-SET-4: section keys + workHours = server SETTINGS_KEYS (minus defaultScheduleId)', async () => {
  const { SETTINGS_SECTIONS, NUMBER_FIELDS, sectionKeys } = await model();
  const covered = SETTINGS_SECTIONS.flatMap((s) => s.keys);
  assert.strictEqual(new Set(covered).size, covered.length, 'no key in two sections');
  assert.deepStrictEqual([...covered, 'workHours'].sort(), SETTINGS_KEYS.filter((k) => k !== 'defaultScheduleId').sort());
  for (const f of NUMBER_FIELDS) assert.ok(covered.includes(f.key), `${f.key} belongs to a section`);
  assert.deepStrictEqual(sectionKeys('general'), ['timezone', 'weekStartsOn', 'clock24']);
  assert.deepStrictEqual(sectionKeys('nope'), []);
});
