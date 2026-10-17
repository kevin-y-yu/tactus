// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Projects-view drag of task rows and stage groups (v2 spec §R8, V2-D21). Pointer Events only; gesture structure mirrors views/drag.js.
import { hitZone, stageDropIndex, reorderIds } from '../projectDnd.js';
import { closePopover } from '../ui.js';

const THRESHOLD_PX = 4;
const EDGE_PX = 40;
const SCROLL_STEP_PX = 10;

export function createProjectsDrag({ container, redraw, onTaskDrop, onStageDrop }) {
  const scrollEl = container.closest('.main') || container;
  let gesture = null, pendingRedraw = false;

  function deferRedraw() { if (gesture) { pendingRedraw = true; return true; } return false; }
  function destroy() { if (gesture) endGesture(); container.removeEventListener('pointerdown', onPointerDown); }

  function onPointerDown(e) {
    if (gesture || !e.isPrimary) return;
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    const grip = e.target && e.target.closest ? e.target.closest('.dnd-grip') : null;
    if (!grip || !container.contains(grip)) return;
    const kind = grip.classList.contains('stage-grip') ? 'stage' : 'task';
    const src = grip.closest(kind === 'task' ? '.proj-task' : '.proj-group');
    const card = grip.closest('.proj-card');
    if (!src || !card) return;
    e.preventDefault();
    gesture = {
      kind, grip, src, card, pointerId: e.pointerId,
      taskId: Number(grip.dataset.taskId), stageId: Number(grip.dataset.stageId), projectId: Number(grip.dataset.projectId),
      x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY,
      started: false, ghost: null, offX: 0, offY: 0, root: null, raf: 0,
      zones: [], stageIds: [], others: [], cardZone: null, hot: null,
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
  }

  function onMove(e) {
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    g.lastX = e.clientX; g.lastY = e.clientY;
    if (!g.started && Math.hypot(g.lastX - g.x0, g.lastY - g.y0) > THRESHOLD_PX) startGesture();
    if (gesture && gesture.started) {
      e.preventDefault();
      update();
    }
  }

  function startGesture() {
    const g = gesture;
    closePopover();
    try { g.grip.setPointerCapture(g.pointerId); } catch (_) { /* best-effort */ }
    g.started = true;
    const base = g.kind === 'task' ? g.src : (g.src.querySelector('.proj-stage-row') || g.src);
    const r = base.getBoundingClientRect();
    g.offX = g.x0 - r.left; g.offY = g.y0 - r.top;
    g.ghost = base.cloneNode(true);
    g.ghost.classList.add('dnd-ghost');
    g.ghost.setAttribute('aria-hidden', 'true');
    g.ghost.style.width = `${r.width}px`;
    document.body.appendChild(g.ghost);
    g.src.classList.add('dnd-source');
    g.root = container.querySelector('.proj');
    if (g.root) g.root.classList.add('proj-dragging');
    measure();
    g.raf = requestAnimationFrame(tick);
    update();
  }

  const rectZone = (el, key, projectId, stageId) => {
    const r = el.getBoundingClientRect();
    return { key, left: r.left, top: r.top, right: r.right, bottom: r.bottom, projectId, stageId, el };
  };

  // Zones are re-measured at start and after every auto-scroll step.
  function measure() {
    const g = gesture;
    if (g.kind === 'task') {
      g.zones = [];
      for (const card of container.querySelectorAll('.proj-card:not(.proj-archived)')) {
        const head = card.querySelector('.proj-head');
        if (head) { const pid = Number(head.dataset.projectId); g.zones.push(rectZone(head, `${pid}:head`, pid, null)); }
        for (const grp of card.querySelectorAll('.proj-group')) {
          const pid = Number(grp.dataset.projectId);
          const sid = grp.dataset.stageId === '' ? null : Number(grp.dataset.stageId);
          g.zones.push(rectZone(grp, `${pid}:${sid === null ? 'none' : sid}`, pid, sid));
        }
      }
    } else {
      const groups = [...g.card.querySelectorAll('.proj-group')].filter((el) => el.dataset.stageId !== '');
      g.stageIds = groups.map((el) => Number(el.dataset.stageId));
      g.others = groups.filter((el) => el !== g.src).map((el) => {
        const r = el.getBoundingClientRect();
        return { el, mid: (r.top + r.bottom) / 2 };
      });
      g.cardZone = rectZone(g.card, 'card', g.projectId, null);
    }
  }

  function clearMarks() {
    for (const el of container.querySelectorAll('.drop-target, .stage-drop-before, .stage-drop-after')) {
      el.classList.remove('drop-target', 'stage-drop-before', 'stage-drop-after');
    }
  }

  function update() {
    const g = gesture;
    g.ghost.style.left = `${g.lastX - g.offX}px`;
    g.ghost.style.top = `${g.lastY - g.offY}px`;
    clearMarks();
    if (g.kind === 'task') {
      g.hot = hitZone(g.zones, g.lastX, g.lastY);
      if (g.hot) g.hot.el.classList.add('drop-target');
      return;
    }
    g.hot = hitZone([g.cardZone], g.lastX, g.lastY) ? stageDropIndex(g.others.map((o) => o.mid), g.lastY) : null;
    if (g.hot === null || g.others.length === 0) return;
    if (g.hot < g.others.length) g.others[g.hot].el.classList.add('stage-drop-before');
    else g.others[g.others.length - 1].el.classList.add('stage-drop-after');
  }

  function tick() {
    const g = gesture;
    if (!g || !g.started) return;
    const box = scrollEl.getBoundingClientRect();
    const before = scrollEl.scrollTop;
    if (g.lastY < box.top + EDGE_PX) scrollEl.scrollTop -= SCROLL_STEP_PX;
    else if (g.lastY > box.bottom - EDGE_PX) scrollEl.scrollTop += SCROLL_STEP_PX;
    if (scrollEl.scrollTop !== before) { measure(); update(); }
    g.raf = requestAnimationFrame(tick);
  }

  function onUp(e) {
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    if (!g.started) { endGesture(); return; }
    g.lastX = e.clientX; g.lastY = e.clientY;
    update();
    const { kind, hot, taskId, stageId, projectId, stageIds } = g;
    endGesture();
    if (kind === 'task') {
      if (hot) onTaskDrop(taskId, { projectId: hot.projectId, stageId: hot.stageId });
      return;
    }
    if (hot === null) return;
    const ids = reorderIds(stageIds, stageIds.indexOf(stageId), hot);
    if (ids.some((id, i) => id !== stageIds[i])) onStageDrop(projectId, ids);
  }

  function onCancel() { if (gesture) endGesture(); }            // pointercancel: no callback
  function onKey(e) {                                             // Esc: no callback
    if (!gesture || e.key !== 'Escape') return;
    if (gesture.started) { e.preventDefault(); e.stopPropagation(); }
    endGesture();
  }

  function endGesture() {
    const g = gesture;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    document.removeEventListener('keydown', onKey);
    cancelAnimationFrame(g.raf);
    if (g.started) {
      if (g.ghost) g.ghost.remove();
      g.src.classList.remove('dnd-source');
      if (g.root) g.root.classList.remove('proj-dragging');
      clearMarks();
      try { g.grip.releasePointerCapture(g.pointerId); } catch (_) { /* best-effort */ }
    }
    gesture = null;
    if (pendingRedraw) { pendingRedraw = false; redraw(); }
  }

  container.addEventListener('pointerdown', onPointerDown);
  return { deferRedraw, destroy };
}
