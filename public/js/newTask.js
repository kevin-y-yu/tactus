// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// "+ Task" context (DOM-free; module state only). v2 chunk 23 — spec v2 §R4 (V2-D12).
let current = null;

// ctx: {projectId, stageId?} | null
export function setNewTaskContext(ctx) { current = ctx ? { ...ctx } : null; }
export function getNewTaskContext() { return current ? { ...current } : null; }

// {projectId?, stageId?} | null -> '#/task/new[?projectId=..[&stageId=..]]'; stageId without projectId is ignored.
export function newTaskHash(ctx) {
  if (!ctx || ctx.projectId == null) return '#/task/new';
  let hash = '#/task/new?projectId=' + encodeURIComponent(String(ctx.projectId));
  if (ctx.stageId != null) hash += '&stageId=' + encodeURIComponent(String(ctx.stageId));
  return hash;
}
