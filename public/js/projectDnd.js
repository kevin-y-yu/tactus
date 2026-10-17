// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// PURE helpers for Projects drag and Move… (v2 spec §R8). No DOM, no I/O.
const SEP = ' › ';
export function hitZone(zones, x, y) {
  for (const z of zones || []) if (x >= z.left && x < z.right && y >= z.top && y < z.bottom) return z;
  return null;
}
export function moveTaskBody(task, target) {
  const fromStage = task.stageId ?? null, toStage = target.stageId ?? null;
  if (task.projectId !== target.projectId) return { projectId: target.projectId, stageId: toStage };
  if (fromStage === toStage) return null;
  return { stageId: toStage };
}
export function stageDropIndex(midYs, y) { let n = 0; for (const m of midYs) if (y > m) n++; return n; }
export function reorderIds(ids, from, to) {
  const out = [...ids];
  const ok = (i) => Number.isInteger(i) && i >= 0 && i < ids.length;
  if (!ok(from) || !ok(to) || from === to) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
export function moveTargets(projects) {
  const out = [];
  for (const p of projects || []) {
    if (p.archived) continue;
    const stages = [...(p.stages || [])].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    for (const s of stages) out.push({ projectId: p.id, stageId: s.id, label: p.name + SEP + s.name });
    out.push({ projectId: p.id, stageId: null, label: p.name + SEP + 'No stage' });
  }
  return out;
}
