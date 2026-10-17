// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// v2 Chunk 21 — T-V2-CAL-1…6, 8. Spec spec-v2 §R2 Acceptance.
const test = require('node:test');
const assert = require('node:assert');

const H = { '1': [['09:00', '12:30'], ['13:30', '17:30']] };

test('T-V2-CAL-1: visibleRange covers schedule hours plus a 30 min buffer', async () => {
  const m = await import('../public/js/calendarScale.js');
  assert.deepStrictEqual(m.visibleRange({ weekdays: [1], hoursList: [H], itemMinutes: [] }), { startMin: 510, endMin: 1080 });
});

test('T-V2-CAL-2: visibleRange extends to drawn items', async () => {
  const m = await import('../public/js/calendarScale.js');
  assert.deepStrictEqual(
    m.visibleRange({ weekdays: [1], hoursList: [H], itemMinutes: [{ startMin: 1140, endMin: 1200 }] }),
    { startMin: 510, endMin: 1230 });
});

test('T-V2-CAL-3: visibleRange with no bands on the weekday falls back to 08:00–18:00 plus buffer', async () => {
  const m = await import('../public/js/calendarScale.js');
  assert.deepStrictEqual(m.visibleRange({ weekdays: [0], hoursList: [H], itemMinutes: [] }), { startMin: 450, endMin: 1110 });
});

test('T-V2-CAL-4: visibleRange enforces a minimum 4 h window', async () => {
  const m = await import('../public/js/calendarScale.js');
  assert.deepStrictEqual(
    m.visibleRange({ weekdays: [1], hoursList: [{ '1': [['10:00', '11:00']] }], itemMinutes: [] }),
    { startMin: 570, endMin: 810 });
});

test('T-V2-CAL-5: fitPxPerHour fits and clamps to limits', async () => {
  const m = await import('../public/js/calendarScale.js');
  assert.strictEqual(m.fitPxPerHour({ mode: 'work', startMin: 540, endMin: 1080, availablePx: 900 }), 100);
  assert.strictEqual(m.fitPxPerHour({ mode: 'work', startMin: 540, endMin: 1080, availablePx: 200 }), 32);
  assert.strictEqual(m.fitPxPerHour({ mode: '24h', startMin: 540, endMin: 1080, availablePx: 600 }), 25);
});

test('T-V2-CAL-6: initialScrollPx anchors work mode and starts 24h at top', async () => {
  const m = await import('../public/js/calendarScale.js');
  assert.strictEqual(m.initialScrollPx({ mode: 'work', startMin: 540, pxPerHour: 100 }), 900);
  assert.strictEqual(m.initialScrollPx({ mode: '24h', startMin: 540, pxPerHour: 100 }), 0);
});

test('T-V2-CAL-8: grid height exceeds viewport and scroll stays in range', async () => {
  const m = await import('../public/js/calendarScale.js');
  assert.strictEqual(m.gridHeightPx(100), 2400);
  const pph = m.fitPxPerHour({ mode: 'work', startMin: 540, endMin: 1080, availablePx: 900 });
  assert.strictEqual(pph, 100);
  assert.ok(m.gridHeightPx(pph) > 900);
  const top = m.initialScrollPx({ mode: 'work', startMin: 540, pxPerHour: pph });
  assert.strictEqual(top, 900);
  assert.ok(top <= m.gridHeightPx(pph) - 900);
  assert.strictEqual(m.fitPxPerHour({ mode: 'work', startMin: 600, endMin: 840, availablePx: 900 }), 160);
  assert.strictEqual(m.gridHeightPx(160), 3840);
  const p24 = m.fitPxPerHour({ mode: '24h', startMin: 0, endMin: 1440, availablePx: 300 });
  assert.strictEqual(p24, 20);
  assert.strictEqual(m.gridHeightPx(p24), 480);
  assert.ok(m.gridHeightPx(p24) > 300);
});

test('chunk 21 helpers: bandRanges, hoursListFor, cssHours, alphaColor', async () => {
  const m = await import('../public/js/calendarScale.js');
  assert.deepStrictEqual(
    m.bandRanges([{ '1': [['09:00', '12:00']] }, { '1': [['11:00', '14:00'], ['18:00', '24:00']] }], 1),
    [[540, 840], [1080, 1440]]);
  assert.deepStrictEqual(m.bandRanges([H], 0), []);
  const A = { id: 1, hours: { '1': [['09:00', '10:00']] } }, B = { id: 2, hours: {} };
  assert.deepStrictEqual(m.hoursListFor([A, B], 'all', null), [A.hours, B.hours]);
  assert.deepStrictEqual(m.hoursListFor([A, B], '2', null), [B.hours]);
  assert.deepStrictEqual(m.hoursListFor([A, B], '99', null), [A.hours, B.hours]);
  assert.deepStrictEqual(m.hoursListFor([], 'all', H), [H]);
  assert.deepStrictEqual(m.hoursListFor([], 'all', null), []);
  assert.strictEqual(m.cssHours(90), 'calc(var(--pph) * 1.5)');
  assert.strictEqual(m.cssHours(0), 'calc(var(--pph) * 0)');
  assert.strictEqual(m.alphaColor('#1a73e8', 0.12), 'rgba(26, 115, 232, 0.12)');
  assert.strictEqual(m.alphaColor('red', 0.12), null);
});
