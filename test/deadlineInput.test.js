// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// v2 Chunk 23 — T-V2-DL-1…5. Spec spec-v2 §R5 (V2-D13) Acceptance.
const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../public/js/deadlineInput.js');

test('T-V2-DL-1: empty time defaults to 23:59 local (Europe/London, BST)', async () => {
  const { deadlineToIso } = await mod();
  assert.strictEqual(deadlineToIso('2026-10-20', '', 'Europe/London'), '2026-10-20T22:59:00.000Z');
});

test('T-V2-DL-2: empty time defaults to 23:59 in UTC', async () => {
  const { deadlineToIso, END_OF_DAY } = await mod();
  assert.strictEqual(END_OF_DAY, '23:59');
  assert.strictEqual(deadlineToIso('2026-10-20', '', 'UTC'), '2026-10-20T23:59:00.000Z');
});

test('T-V2-DL-3: explicit time is used', async () => {
  const { deadlineToIso } = await mod();
  assert.strictEqual(deadlineToIso('2026-10-20', '09:30', 'Europe/London'), '2026-10-20T08:30:00.000Z');
});

test('T-V2-DL-4: empty or invalid date gives null', async () => {
  const { deadlineToIso } = await mod();
  assert.strictEqual(deadlineToIso('', '10:00', 'UTC'), null);
  assert.strictEqual(deadlineToIso('2026-02-30', '', 'UTC'), null);
  assert.strictEqual(deadlineToIso(undefined, '', 'UTC'), null);
  assert.strictEqual(deadlineToIso('2026-10-20', '25:00', 'UTC'), null);
});

test('T-V2-DL-5: deadlineFromIso splits into date and time', async () => {
  const { deadlineFromIso } = await mod();
  assert.deepStrictEqual(deadlineFromIso('2026-10-20T22:59:00.000Z', 'Europe/London'), { date: '2026-10-20', time: '23:59' });
  assert.deepStrictEqual(deadlineFromIso(null, 'Europe/London'), { date: '', time: '' });
});

test('timeAfterDateChange fills 23:59 only when the time is empty', async () => {
  const { timeAfterDateChange } = await mod();
  assert.strictEqual(timeAfterDateChange('2026-10-20', ''), '23:59');
  assert.strictEqual(timeAfterDateChange('2026-10-20', '09:30'), '09:30');
  assert.strictEqual(timeAfterDateChange('', ''), '');
  assert.strictEqual(timeAfterDateChange('', '09:30'), '09:30');
});
