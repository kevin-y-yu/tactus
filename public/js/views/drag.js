// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Drag and resize of calendar blocks (spec §10.3), and move-only drag of lunch (same day, to a future time; today's lunch even if missed), hand-built on Pointer Events; snapping is the pure dragResult.
// Idea from Planly (MIT): wireBlock drag/resize pointer-gesture structure; reimplemented.
import { dragResult, createResult } from '../dragModel.js';
import { utcToZoned } from '../../shared/time.js';
import { isUserEvent, userEventDbId } from '../userEventModel.js';
import { h, toast, closePopover, fmtTimeRange } from '../ui.js';
import { state, mutate, tz } from '../state.js';
import * as api from '../api.js';

const THRESHOLD_PX = 4;
const EDGE_PX = 40;
const SCROLL_STEP_PX = 10;

// Pure helpers (no DOM). Module load touches no DOM.

export function canDrag(block, now) {
  return (block.kind === 'task' || block.kind === 'recurring') && Date.parse(block.start) >= now && !block.done && !block.completed;
}

export function canDragLunch(ev, now, tzName) {
  return ev.uid === 'lunch' && ev.calendarId === null && utcToZoned(Date.parse(ev.start), tzName).date >= utcToZoned(now, tzName).date;
}

export function canResize(block, colDate, tzName) {
  return block.kind === 'task'
    && utcToZoned(Date.parse(block.start), tzName).date === colDate
    && utcToZoned(Date.parse(block.end) - 1, tzName).date === colDate;
}

export function canDragUserEvent(ev, now) { return isUserEvent(ev) && Date.parse(ev.start) >= now; }
export function canResizeUserEvent(ev, colDate, tzName) {
  return utcToZoned(Date.parse(ev.start), tzName).date === colDate && utcToZoned(Date.parse(ev.end) - 1, tzName).date === colDate;
}

export function overlapTitles(blockId, start, end, blocks, events) {
  const out = [];
  for (const ev of events) {
    if (ev.blocking !== true || ev.allDay) continue;
    if (Date.parse(ev.start) < end && Date.parse(ev.end) > start) out.push(ev.title);
  }
  for (const b of blocks) {
    if (b.completed || b.done) continue;
    if (!b.pinned || String(b.id) === String(blockId)) continue;
    if (Date.parse(b.start) < end && Date.parse(b.end) > start) out.push(b.title);
  }
  return out;
}

// Controller: one per mounted calendar view. All drag state lives here.
// `redraw` re-renders the view; `pxPerHour` is the calendar scale: a number or a getter returning the current pph (v2 V2-D9).
export function createDragController({ pxPerHour, redraw, onCreate = null }) {
  const pph = typeof pxPerHour === 'function' ? pxPerHour : () => pxPerHour;
  let scrollEl = null, gesture = null, pendingRedraw = false, suppressClick = false;
  let selectedId = null, lastPointerType = null;

  // D8: touch deselect; registered for the controller's lifetime.
  const onDocPointerDown = (e) => {
    if (e.pointerType !== 'touch' || selectedId === null) return;
    const t = e.target;
    if (t && t.closest && (t.closest('.block.selected, .event.selected') || t.closest('.popover'))) return;
    deselect();
  };
  document.addEventListener('pointerdown', onDocPointerDown, true);

  function decorate(el, block, colDate, now) {
    if (!canDrag(block, now)) return;
    el.classList.add('can-drag');
    if (canResize(block, colDate, tz())) {
      el.classList.add('can-resize');
      el.appendChild(h('div', { class: 'resize-handle' }));
    }
    if (String(block.id) === selectedId) el.classList.add('selected');
  }

  function decorateLunch(el, ev, now) {
    if (!canDragLunch(ev, now, tz())) return;
    el.classList.add('can-drag');
    if (String(ev.id) === selectedId) el.classList.add('selected');
  }

  // Tactus-only events: same rules as blocks (future start to drag; resize only within the rendered day).
  function decorateUserEvent(el, ev, colDate, now) {
    if (!canDragUserEvent(ev, now)) return;
    el.classList.add('can-drag');
    if (canResizeUserEvent(ev, colDate, tz())) {
      el.classList.add('can-resize');
      el.appendChild(h('div', { class: 'resize-handle' }));
    }
    if (String(ev.id) === selectedId) el.classList.add('selected');
  }

  function attach(el) {
    scrollEl = el;
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('click', onClickCapture, true);
    if (selectedId !== null && !el.querySelector('.block.selected, .event.selected')) selectedId = null;
  }

  // D5: while a gesture is pending or started, a redraw is recorded and run once the gesture ends.
  function deferRedraw() {
    if (gesture) { pendingRedraw = true; return true; }
    return false;
  }

  function destroy() {
    if (gesture) endGesture();
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    selectedId = null;
  }

  // Shared gesture listeners (move, drop, cancel, Escape).
  function listen() {
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
  }

  function onPointerDown(e) {
    lastPointerType = e.pointerType;
    suppressClick = false;
    if (gesture || !e.isPrimary) return;
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    const el = e.target.closest('.block.can-drag, .event.can-drag');
    if (!el) {
      // Drag on empty column space creates a user event (mouse/pen only; touch keeps native scroll).
      if (!onCreate || e.pointerType === 'touch') return;
      if (e.target.closest('.block, .event, .drag-ghost')) return;
      const colEl = e.target.closest('.cal-col');
      if (!colEl) return;
      gesture = { el: colEl, block: null, lunch: null, userEv: null, mode: 'create', pointerId: e.pointerId,
        x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY, scroll0: scrollEl.scrollTop, colEl,
        y0col: e.clientY - colEl.getBoundingClientRect().top, origStart: null, origEnd: null,
        started: false, result: null, pointerCol: colEl, ghost: null, label: null, root: null, raf: 0 };
      listen();
      return;
    }
    // D8: touch on an unselected block is left to native scroll.
    if (e.pointerType === 'touch' && !el.classList.contains('selected')) return;
    let block = null, lunch = null, userEv = null, mode = 'move';
    if (el.classList.contains('event')) {
      const ev = state.calendar.events.find((x) => String(x.id) === el.dataset.eventId);
      if (!ev) return;
      if (isUserEvent(ev)) {
        if (!canDragUserEvent(ev, Date.now())) return;
        userEv = ev;
        mode = e.target.closest('.resize-handle') && el.classList.contains('can-resize') ? 'resize' : 'move';
      } else {
        if (!canDragLunch(ev, Date.now(), tz())) return;
        lunch = ev;
      }
    } else {
      block = state.calendar.blocks.find((b) => String(b.id) === el.dataset.blockId);
      if (!block || !canDrag(block, Date.now())) return;
      mode = e.target.closest('.resize-handle') && el.classList.contains('can-resize') ? 'resize' : 'move';
    }
    const span = block || lunch || userEv;
    gesture = {
      el, block, lunch, userEv, mode, pointerId: e.pointerId,
      x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY,
      scroll0: scrollEl.scrollTop, colEl: el.closest('.cal-col'),
      origStart: Date.parse(span.start), origEnd: Date.parse(span.end),
      started: false, result: null, pointerCol: null, ghost: null, label: null, root: null, raf: 0,
    };
    listen();
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
    try { g.el.setPointerCapture(g.pointerId); } catch (_) { /* capture is best-effort */ }
    g.started = true;
    if (g.mode !== 'create') g.el.classList.add('drag-source');
    g.root = scrollEl.closest('.cal');
    if (g.root) g.root.classList.add('dragging');
    g.label = h('div', { class: 'drag-ghost-time' }, g.mode === 'create' ? '' : fmtTimeRange(g.origStart, g.origEnd, tz()));
    g.ghost = h('div', { class: 'drag-ghost', style: g.mode === 'create' ? { top: '0px', height: '12px' }
      : { top: g.el.style.top, height: g.el.style.height } }, g.label);
    if (g.colEl) g.colEl.appendChild(g.ghost);
    g.raf = requestAnimationFrame(tick);
    update();
  }

  // D1/D9: recompute the result from the current pointer position and scroll offset.
  function compute() {
    const g = gesture;
    let dayDelta = 0;
    if (g.mode === 'create') {
      g.pointerCol = g.colEl;
      g.result = createResult({ date: g.colEl.dataset.date, y0px: g.y0col, y1px: g.lastY - g.colEl.getBoundingClientRect().top,
        pxPerHour: pph(), tz: tz(), now: Date.now() });
      return;
    }
    if (g.lunch) {
      g.pointerCol = g.colEl;
    } else if (g.mode === 'move') {
      const cols = [...scrollEl.querySelectorAll('.cal-col')];
      let idx = cols.length - 1;
      for (let i = 0; i < cols.length; i++) {
        if (cols[i].getBoundingClientRect().right > g.lastX) { idx = i; break; }
      }
      if (idx < 0) idx = 0;
      g.pointerCol = cols[idx] || null;
      dayDelta = idx - cols.indexOf(g.colEl);
    }
    const deltaYpx = (g.lastY - g.y0) + (scrollEl.scrollTop - g.scroll0);
    g.result = dragResult({
      mode: g.mode, origStart: g.origStart, origEnd: g.origEnd, deltaYpx, dayDelta,
      pxPerHour: pph(), tz: tz(), now: Date.now(),
    });
  }

  // D10: place the ghost in the column of the result start, or show the past error.
  function update() {
    compute();
    const g = gesture;
    const r = g.result;
    if (r.error) {
      g.ghost.classList.add('invalid');
      g.label.textContent = g.mode === 'create' ? "Can't create in the past" : "Can't move into the past";
      return;
    }
    g.ghost.classList.remove('invalid');
    const z = utcToZoned(r.start, tz());
    const col = scrollEl.querySelector(`.cal-col[data-date="${z.date}"]`) || g.pointerCol;
    if (col && g.ghost.parentNode !== col) col.appendChild(g.ghost);
    g.ghost.style.top = `${z.minutes / 60 * pph()}px`;
    g.ghost.style.height = `${Math.max((r.end - r.start) / 3600000 * pph(), 12)}px`;
    g.label.textContent = fmtTimeRange(r.start, r.end, tz());
  }

  // D11: auto-scroll while the pointer is near the top or bottom edge of the scroll element.
  function tick() {
    const g = gesture;
    if (!g || !g.started) return;
    const sticky = scrollEl.querySelector('.cal-sticky');
    const box = scrollEl.getBoundingClientRect();
    const topEdge = sticky ? sticky.getBoundingClientRect().bottom : box.top;
    const bottomEdge = box.bottom;
    const before = scrollEl.scrollTop;
    if (g.lastY < topEdge + EDGE_PX) scrollEl.scrollTop -= SCROLL_STEP_PX;
    else if (g.lastY > bottomEdge - EDGE_PX) scrollEl.scrollTop += SCROLL_STEP_PX;
    if (scrollEl.scrollTop !== before) update();
    g.raf = requestAnimationFrame(tick);
  }

  // D12: drop. Result recomputed from the event's coordinates.
  function onUp(e) {
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    if (!g.started) { endGesture(); return; }
    g.lastX = e.clientX; g.lastY = e.clientY;
    update();
    const result = g.result;
    const started = g.started;
    const mode = g.mode;
    const block = g.block, lunch = g.lunch, userEv = g.userEv, origStart = g.origStart, origEnd = g.origEnd;
    const srcEl = g.el;
    const srcCol = g.ghost ? g.ghost.parentNode : null;
    const geo = g.ghost ? { top: g.ghost.style.top, height: g.ghost.style.height } : null;
    endGesture();
    if (!started) return;
    if (mode === 'create') {
      if (result.error) { toast("Can't create an event in the past", 'error'); return; }
      // A deferred redraw in endGesture may have rebuilt the columns; re-find the result's column by date then.
      let col = srcCol;
      if (col && !col.isConnected) col = scrollEl.querySelector(`.cal-col[data-date="${utcToZoned(result.start, tz()).date}"]`);
      if (!col || !geo) return;
      const draft = h('div', { class: 'event user-event user-event-draft', style: { top: geo.top, height: geo.height, left: '0', width: 'calc(100% - 2px)' } },
        h('div', { class: 'item-time' }, fmtTimeRange(result.start, result.end, tz())));
      col.appendChild(draft);
      onCreate(result.start, result.end, draft);
      return;
    }
    if (result.error) { toast("Can't move into the past", 'error'); return; }
    if (result.start === origStart && result.end === origEnd) return;
    // Provisional move; skipped if a deferred redraw already rebuilt the DOM.
    if (srcEl.isConnected && srcCol && geo) {
      srcCol.appendChild(srcEl);
      srcEl.style.top = geo.top;
      srcEl.style.height = geo.height;
    }
    if (lunch) commitLunch(lunch, result.start, result.end);
    else if (userEv) commitUserEvent(userEv, result.start, result.end);
    else commit(block, result.start, result.end);
  }

  async function commit(block, start, end) {
    try {
      await mutate(() => api.updateBlock(block.id, { start: new Date(start).toISOString(), end: new Date(end).toISOString() }));
    } catch (err) {
      toast(err.message, 'error');
      redraw();
      return;
    }
    const titles = overlapTitles(block.id, start, end, state.calendar.blocks, state.calendar.events);
    if (titles.length) toast('Overlaps ' + titles.join(', '), 'warn');
  }

  // Tactus-only event move/resize: PATCH the stored event; the overlap check ignores the event itself.
  async function commitUserEvent(ev, start, end) {
    try {
      await mutate(() => api.updateUserEvent(userEventDbId(ev), { start: new Date(start).toISOString(), end: new Date(end).toISOString() }));
    } catch (err) {
      toast(err.message, 'error');
      redraw();
      return;
    }
    const titles = overlapTitles(ev.id, start, end, state.calendar.blocks, state.calendar.events.filter((x) => x.id !== ev.id));
    if (titles.length) toast('Overlaps ' + titles.join(', '), 'warn');
  }

  // Lunch move: the day comes from the lunch's start in the settings timezone; the server stores the start as that day's override.
  async function commitLunch(ev, start, end) {
    const date = utcToZoned(Date.parse(ev.start), tz()).date;
    try {
      await mutate(() => api.moveLunch(date, { start: new Date(start).toISOString() }));
    } catch (err) {
      toast(err.message, 'error');
      redraw();
      return;
    }
    const titles = overlapTitles(ev.id, start, end, state.calendar.blocks, state.calendar.events.filter((x) => x.uid !== 'lunch'));
    if (titles.length) toast('Overlaps ' + titles.join(', '), 'warn');
  }

  // D14: Esc and pointercancel cancel without a request.
  function onCancel() {
    if (gesture) endGesture();
  }

  function onKey(e) {
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
      suppressClick = true;
      if (g.ghost) g.ghost.remove();
      g.el.classList.remove('drag-source');
      if (g.root) g.root.classList.remove('dragging');
      try { g.el.releasePointerCapture(g.pointerId); } catch (_) { /* best-effort */ }
    }
    gesture = null;
    if (pendingRedraw) { pendingRedraw = false; redraw(); }
  }

  // D7 (suppress the click after a drag) and D8 (touch tap selects a draggable block).
  function onClickCapture(e) {
    if (suppressClick) {
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (lastPointerType !== 'touch') return;
    const el = e.target.closest ? e.target.closest('.block.can-drag, .event.can-drag') : null;
    if (!el) return;
    selectedId = el.dataset.blockId ?? el.dataset.eventId;
    for (const seg of scrollEl.querySelectorAll('.block[data-block-id], .event[data-event-id]')) {
      if ((seg.dataset.blockId ?? seg.dataset.eventId) === selectedId) seg.classList.add('selected');
    }
  }

  function deselect() {
    if (scrollEl) for (const seg of scrollEl.querySelectorAll('.block.selected, .event.selected')) seg.classList.remove('selected');
    selectedId = null;
  }

  return { decorate, decorateLunch, decorateUserEvent, attach, deferRedraw, destroy };
}
