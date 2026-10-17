// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// v2 Chunk 22 — T-V2-SUI. Spec spec-v2 §R6 UI.
const test = require('node:test');
const assert = require('node:assert');

const model = () => import('../public/js/scheduleModel.js');

const H = {
  0: [], 1: [['09:00', '12:00'], ['13:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '12:00'], ['13:00', '17:00']],
  4: [['09:00', '17:00']], 5: [['08:00', '16:00']], 6: [],
};
const WORK = { id: 1, name: 'Work', isDefault: true, color: '#1a73e8', hours: H };
const EVE = { id: 2, name: 'Evenings', isDefault: false, color: '#ff0000', hours: H };
const GYM = { id: 3, name: 'Gym', isDefault: false, color: '#00ff00', hours: H };
const SHUFFLED = [EVE, GYM, WORK];

test('T-V2-SUI-1: scheduleOptions orders default first and labels the inherit option', async () => {
  const m = await model();
  assert.deepStrictEqual(m.scheduleOptions(SHUFFLED, null), [
    { value: '', label: 'Default (Work)' },
    { value: '1', label: 'Work' },
    { value: '2', label: 'Evenings' },
    { value: '3', label: 'Gym' },
  ]);
  assert.strictEqual(m.scheduleOptions(SHUFFLED, { id: 5, scheduleId: 2 })[0].label, 'Project default (Evenings)');
  assert.strictEqual(m.scheduleOptions(SHUFFLED, { scheduleId: null })[0].label, 'Default (Work)');
  assert.strictEqual(m.scheduleOptions(SHUFFLED, { scheduleId: 99 })[0].label, 'Default (Work)');
  const swapped = [{ ...EVE, isDefault: true }, { ...WORK, isDefault: false }, GYM];
  const opts = m.scheduleOptions(swapped, null);
  assert.deepStrictEqual(opts.map((o) => o.value), ['', '2', '1', '3']);
  assert.strictEqual(opts[0].label, 'Default (Evenings)');
  assert.deepStrictEqual(m.scheduleOptions([], null), [{ value: '', label: 'Default' }]);
  assert.strictEqual(m.scheduleIdFromValue(''), null);
  assert.strictEqual(m.scheduleIdFromValue(null), null);
  assert.strictEqual(m.scheduleIdFromValue(undefined), null);
  assert.strictEqual(m.scheduleIdFromValue('2'), 2);
  assert.strictEqual(m.scheduleValue(null), '');
  assert.strictEqual(m.scheduleValue(3), '3');
});

test('T-V2-SUI-2: scheduleUsage counts todo tasks, projects and recurring; deleteScheduleMessage wording', async () => {
  const m = await model();
  const tasks = [
    { scheduleId: 2, status: 'todo' }, { scheduleId: 2, status: 'done' },
    { scheduleId: 1, status: 'todo' }, { scheduleId: null, status: 'todo' },
  ];
  const projects = [{ scheduleId: 2 }, { scheduleId: null }];
  const recurring = [{ scheduleId: 2 }, { scheduleId: 2 }, { scheduleId: 3 }];
  assert.deepStrictEqual(m.scheduleUsage(2, { tasks, projects, recurring }), { tasks: 1, projects: 1, recurring: 2 });
  assert.deepStrictEqual(m.scheduleUsage(4, {}), { tasks: 0, projects: 0, recurring: 0 });
  assert.strictEqual(
    m.deleteScheduleMessage('Evenings', { tasks: 1, projects: 0, recurring: 2 }, 'Work'),
    'Delete schedule "Evenings"? 1 todo task, 0 projects and 2 recurring items use it; they will move to the default schedule "Work".',
  );
  assert.strictEqual(
    m.deleteScheduleMessage('Evenings', { tasks: 0, projects: 0, recurring: 0 }, 'Work'),
    'Delete schedule "Evenings"? Nothing uses it.',
  );
});

test('T-V2-SUI-3: timeOptions, startTimeOptions and endTimeOptions', async () => {
  const m = await model();
  const t = m.timeOptions();
  assert.strictEqual(t.length, 97);
  assert.strictEqual(t[0], '00:00');
  assert.strictEqual(t[1], '00:15');
  assert.strictEqual(t[4], '01:00');
  assert.strictEqual(t[95], '23:45');
  assert.strictEqual(t[96], '24:00');
  assert.strictEqual(new Set(t).size, 97);
  for (const v of t) assert.match(v, /^([01]\d|2[0-3]):(00|15|30|45)$|^24:00$/);
  const s = m.startTimeOptions();
  assert.strictEqual(s.length, 96);
  assert.ok(!s.includes('24:00'));
  const e = m.endTimeOptions();
  assert.strictEqual(e.length, 96);
  assert.ok(!e.includes('00:00'));
  assert.strictEqual(e[e.length - 1], '24:00');
});

test('T-V2-SUI-4: copyToWeekdays and cloneHours', async () => {
  const m = await model();
  const src = structuredClone(H);
  const out = m.copyToWeekdays(H, 3);
  for (const d of ['1', '2', '4', '5']) assert.deepStrictEqual(out[d], H[3]);
  assert.deepStrictEqual(out[3], H[3]);
  assert.deepStrictEqual(out['0'], H['0']);
  assert.deepStrictEqual(out['6'], H['6']);
  assert.deepStrictEqual(H, src);
  assert.notStrictEqual(out['1'], H['3']);
  assert.notStrictEqual(out['1'][0], H['3'][0]);

  const H2 = { ...structuredClone(H), 0: [['10:00', '11:00']] };
  const fromSun = m.copyToWeekdays(H2, 0);
  for (const d of ['1', '2', '3', '4', '5']) assert.deepStrictEqual(fromSun[d], [['10:00', '11:00']]);
  assert.deepStrictEqual(fromSun['0'], [['10:00', '11:00']]);

  const cleared = m.copyToWeekdays(H, 6);
  for (const d of ['1', '2', '3', '4', '5']) assert.deepStrictEqual(cleared[d], []);

  const c = m.cloneHours({ 1: [['09:00', '10:00']] });
  assert.deepStrictEqual(Object.keys(c).sort(), ['0', '1', '2', '3', '4', '5', '6']);
});

test('T-V2-SUI-5: nextScheduleName picks the first free name case-insensitively', async () => {
  const m = await model();
  assert.strictEqual(m.nextScheduleName([]), 'New schedule');
  assert.strictEqual(m.nextScheduleName([{ name: 'Work' }]), 'New schedule');
  assert.strictEqual(m.nextScheduleName([{ name: 'new schedule' }]), 'New schedule 2');
  assert.strictEqual(m.nextScheduleName([{ name: 'New schedule' }, { name: 'New schedule 2' }]), 'New schedule 3');
  assert.strictEqual(m.nextScheduleName([{ name: 'New schedule' }, { name: 'New schedule 3' }]), 'New schedule 2');
});

test('T-V2-SUI-6: scheduleCardActions for default and non-default cards', async () => {
  const m = await model();
  assert.deepStrictEqual(m.scheduleCardActions(WORK), {
    canEditName: true, canEditColor: true, canEditHours: true, canDelete: false, canMakeDefault: false,
  });
  assert.deepStrictEqual(m.scheduleCardActions(EVE), {
    canEditName: true, canEditColor: true, canEditHours: true, canDelete: true, canMakeDefault: true,
  });
});

test('T-V2-SUI-7: nextRange, normalizeHours and hoursError', async () => {
  const m = await model();
  assert.deepStrictEqual(m.nextRange([]), ['09:00', '17:00']);
  assert.deepStrictEqual(m.nextRange([['09:00', '12:00']]), ['12:00', '13:00']);
  assert.deepStrictEqual(m.nextRange([['22:30', '23:30']]), ['23:30', '24:00']);
  assert.deepStrictEqual(m.nextRange([['20:00', '24:00']]), ['23:00', '24:00']);

  assert.deepStrictEqual(m.normalizeHours({ 1: [['13:00', '17:00'], ['09:00', '12:00']] })['1'], [['09:00', '12:00'], ['13:00', '17:00']]);

  const okWeek = { 0: [], 1: [['09:00', '12:00']], 2: [], 3: [], 4: [], 5: [], 6: [] };
  assert.strictEqual(m.hoursError(okWeek, 1), null);
  assert.strictEqual(m.hoursError({ ...okWeek, 1: [['10:00', '09:00']] }, 1), 'Mon: each range must start before it ends.');
  assert.strictEqual(m.hoursError({ ...okWeek, 1: [['09:00', '12:00'], ['11:00', '13:00']] }, 1), 'Mon: ranges overlap.');
  assert.strictEqual(m.hoursError({ ...okWeek, 1: [['09:00', '12:00'], ['12:00', '13:00']] }, 1), null);
  assert.strictEqual(m.hoursError({ ...okWeek, 1: [['23:00', '24:00']] }, 1), null);

  const bad = { ...okWeek, 0: [['10:00', '09:00']], 1: [['10:00', '09:00']] };
  assert.match(m.hoursError(bad, 1), /^Mon:/);
  assert.match(m.hoursError(bad, 0), /^Sun:/);
});
