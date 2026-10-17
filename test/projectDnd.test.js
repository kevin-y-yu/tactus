// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// v2 Chunk 25 — T-V2-DND-1…5. Spec spec-v2 §R8 Acceptance (Chunk 25).
const test = require('node:test');
const assert = require('node:assert');

const mod = () => import('../public/js/projectDnd.js');

test('T-V2-DND-1: hitZone containment, null outside, left/top edges inclusive only', async () => {
  const { hitZone } = await mod();
  const A = { key: 'a', left: 0, top: 0, right: 100, bottom: 50, projectId: 1, stageId: null };
  const B = { key: 'b', left: 0, top: 50, right: 100, bottom: 100, projectId: 2, stageId: 7 };
  const zones = [A, B];
  assert.strictEqual(hitZone(zones, 10, 10), A);
  assert.strictEqual(hitZone(zones, 0, 0), A);
  assert.strictEqual(hitZone(zones, 10, 50), B);
  assert.strictEqual(hitZone(zones, 99, 99), B);
  assert.strictEqual(hitZone(zones, 100, 10), null);
  assert.strictEqual(hitZone(zones, 10, 100), null);
  assert.strictEqual(hitZone(zones, -1, 10), null);
  assert.strictEqual(hitZone(zones, 150, 10), null);
  assert.strictEqual(hitZone([], 5, 5), null);
});

test('T-V2-DND-2: moveTaskBody null / {projectId, stageId} / {stageId}', async () => {
  const { moveTaskBody } = await mod();
  const task = { id: 5, projectId: 1, stageId: 3, title: 'x' };
  assert.strictEqual(moveTaskBody(task, { projectId: 1, stageId: 3 }), null);
  assert.deepStrictEqual(moveTaskBody(task, { projectId: 2, stageId: 9 }), { projectId: 2, stageId: 9 });
  assert.deepStrictEqual(moveTaskBody(task, { projectId: 2, stageId: null }), { projectId: 2, stageId: null });
  assert.deepStrictEqual(moveTaskBody(task, { projectId: 1, stageId: 4 }), { stageId: 4 });
  assert.deepStrictEqual(moveTaskBody(task, { projectId: 1, stageId: null }), { stageId: null });
  assert.deepStrictEqual(
    moveTaskBody(task, { key: 'k', left: 0, top: 0, right: 1, bottom: 1, projectId: 1, stageId: 4 }),
    { stageId: 4 },
  );
  assert.strictEqual(moveTaskBody({ id: 6, projectId: 1, stageId: null }, { projectId: 1, stageId: null }), null);
  assert.strictEqual(moveTaskBody({ id: 7, projectId: 1 }, { projectId: 1, stageId: null }), null);
});

test('T-V2-DND-3: stageDropIndex insertion index', async () => {
  const { stageDropIndex } = await mod();
  const mids = [100, 200, 300];
  assert.strictEqual(stageDropIndex(mids, 50), 0);
  assert.strictEqual(stageDropIndex(mids, 150), 1);
  assert.strictEqual(stageDropIndex(mids, 350), 3);
  assert.strictEqual(stageDropIndex(mids, 100), 0);
  assert.strictEqual(stageDropIndex([], 5), 0);
});

test('T-V2-DND-4: reorderIds moves an id; same index returns an unchanged copy', async () => {
  const { reorderIds } = await mod();
  assert.deepStrictEqual(reorderIds([1, 2, 3], 0, 2), [2, 3, 1]);
  assert.deepStrictEqual(reorderIds([1, 2, 3], 2, 0), [3, 1, 2]);
  const a = [1, 2, 3];
  const r = reorderIds(a, 1, 1);
  assert.deepStrictEqual(r, [1, 2, 3]);
  assert.notStrictEqual(r, a);
  assert.deepStrictEqual(reorderIds(a, 0, 5), [1, 2, 3]);
  assert.deepStrictEqual(a, [1, 2, 3]);
});

test('T-V2-DND-5: moveTargets order and labels, archived excluded', async () => {
  const { moveTargets } = await mod();
  const input = [
    { id: 1, name: 'Inbox', archived: false, stages: [] },
    { id: 2, name: 'Thesis', archived: false, stages: [
      { id: 11, name: 'Write', sortOrder: 2 },
      { id: 10, name: 'Read', sortOrder: 1 },
      { id: 12, name: 'Edit', sortOrder: 2 },
    ] },
    { id: 3, name: 'Old', archived: true, stages: [{ id: 13, name: 'X', sortOrder: 0 }] },
    { id: 4, name: 'Misc' },
  ];
  assert.deepStrictEqual(moveTargets(input), [
    { projectId: 1, stageId: null, label: 'Inbox › No stage' },
    { projectId: 2, stageId: 10, label: 'Thesis › Read' },
    { projectId: 2, stageId: 11, label: 'Thesis › Write' },
    { projectId: 2, stageId: 12, label: 'Thesis › Edit' },
    { projectId: 2, stageId: null, label: 'Thesis › No stage' },
    { projectId: 4, stageId: null, label: 'Misc › No stage' },
  ]);
});
