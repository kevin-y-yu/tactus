// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// v2 Chunk 23 — T-V2-NEW-1. Spec spec-v2 §R4 (V2-D12) Acceptance.
const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../public/js/newTask.js');

test('T-V2-NEW-1: newTaskHash cases', async () => {
  const { newTaskHash } = await mod();
  assert.strictEqual(newTaskHash({}), '#/task/new');
  assert.strictEqual(newTaskHash(null), '#/task/new');
  assert.strictEqual(newTaskHash({ projectId: 2 }), '#/task/new?projectId=2');
  assert.strictEqual(newTaskHash({ projectId: 2, stageId: 5 }), '#/task/new?projectId=2&stageId=5');
  assert.strictEqual(newTaskHash({ stageId: 5 }), '#/task/new');
  assert.strictEqual(newTaskHash({ projectId: 2, stageId: null }), '#/task/new?projectId=2');
});

test('new-task context store round-trips and clears', async () => {
  const { setNewTaskContext, getNewTaskContext } = await mod();
  setNewTaskContext(null);
  assert.strictEqual(getNewTaskContext(), null);
  setNewTaskContext({ projectId: 2, stageId: 5 });
  assert.deepStrictEqual(getNewTaskContext(), { projectId: 2, stageId: 5 });
  const got = getNewTaskContext();
  got.projectId = 99;
  assert.deepStrictEqual(getNewTaskContext(), { projectId: 2, stageId: 5 });
  setNewTaskContext(null);
  assert.strictEqual(getNewTaskContext(), null);
});
