// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// v2 Chunk 21 — T-V2-CAL-7. Spec spec-v2 §R2 Acceptance (V2-D6 overlap rule).
const test = require('node:test');
const assert = require('node:assert');

test('T-V2-CAL-7: overlapTitles ignores completed/done pinned blocks', async () => {
  const { overlapTitles } = await import('../public/js/views/drag.js');
  const S = Date.parse('2026-10-19T10:00:00Z'), E = Date.parse('2026-10-19T11:00:00Z');
  const at = { start: '2026-10-19T10:30:00Z', end: '2026-10-19T11:30:00Z' };
  const blocks = [
    { id: 1, pinned: true, completed: true, title: 'Completed', ...at },
    { id: 2, pinned: true, done: true, title: 'Done', ...at },
    { id: 3, pinned: true, completed: false, done: false, title: 'Pinned', ...at },
    { id: 4, pinned: false, title: 'Unpinned', ...at },
    { id: 5, pinned: true, title: 'Self', ...at },
  ];
  const events = [
    { id: 'a', blocking: true, allDay: false, title: 'Meeting', ...at },
    { id: 'b', blocking: false, allDay: false, title: 'FYI', ...at },
  ];
  assert.deepStrictEqual(overlapTitles(5, S, E, blocks, events), ['Meeting', 'Pinned']);
  assert.deepStrictEqual(overlapTitles(3, S, E, blocks, []), ['Self']);
});
