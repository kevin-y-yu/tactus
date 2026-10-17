// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Week/day calendar view (spec §10.2). Pure helpers (dayItems, allDayEventsFor, blockClasses)
// are DOM-free; DOM work happens only inside render()/draw() and popover builders.
// Scale (v2 §R2, chunk 21): pph fits the visible range (calendarScale.js); --pph on .cal drives every position.
import { dateTimeInput } from '../timeInput.js';
import { utcToZoned, zonedToUtc, addDays, weekdayOf, formatHHMM, isoToLocalInput, localInputToIso, MIN } from '../../shared/time.js';
import { layoutLanes, weekDates } from '../layout.js';
import { h, clear, toast, openPopover, closePopover, fmtDate, fmtTime, fmtTimeRange, todayIn } from '../ui.js';
import { state, subscribe, setCalendarRange, mutate, tz } from '../state.js';
import * as api from '../api.js';
import { createDragController } from './drag.js';
import { visibleRange, fitPxPerHour, initialScrollPx, bandRanges, hoursListFor, cssHours, alphaColor } from '../calendarScale.js';

const MIN_ITEM_PX = 12;
const ZOOM_KEY = 'tactus.calZoom';
const HOURS_KEY = 'tactus.calHours';

function readPref(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }

const offsetMin = (ms, dayStart, dayEnd, tzName) =>
  ms <= dayStart ? 0 : ms >= dayEnd ? 1440 : utcToZoned(ms, tzName).minutes;

// Timed events + blocks of local day `date`, clipped to it, with lane layout.
// -> [{key, kind:'block'|'event', item, start, end (clipped ms), startMin, endMin (local minutes 0…1440), lane, lanes}]
// "Project: Task" for blocks of tasks that belong to a project
function blockLabel(b) {
  const p = b.projectId != null && (state.projects || []).find((x) => x.id === b.projectId);
  return p ? `${p.name}: ${b.title}` : b.title;
}

export function dayItems(date, tzName, blocks, events) {
  const dayStart = zonedToUtc(date, 0, tzName);
  const dayEnd = zonedToUtc(addDays(date, 1), 0, tzName);
  const raw = [];
  const add = (kind, item) => {
    const s = Date.parse(item.start), e = Date.parse(item.end);
    if (s < dayEnd && e > dayStart) {
      raw.push({ key: (kind === 'block' ? 'b' : 'e') + item.id, kind, item, start: Math.max(s, dayStart), end: Math.min(e, dayEnd) });
    }
  };
  for (const b of blocks) add('block', b);
  for (const ev of events) if (!ev.allDay) add('event', ev);
  const lanes = new Map(layoutLanes(raw.map((r) => ({ id: r.key, start: r.start, end: r.end }))).map((o) => [o.id, o]));
  return raw.map((r) => {
    const l = lanes.get(r.key);
    return { ...r, startMin: offsetMin(r.start, dayStart, dayEnd, tzName), endMin: offsetMin(r.end, dayStart, dayEnd, tzName), lane: l.lane, lanes: l.lanes };
  });
}

// All-day events covering `date` (endDate exclusive; missing endDate = startDate + 1 day).
export function allDayEventsFor(date, events) {
  return events.filter((ev) => ev.allDay && ev.startDate <= date && date < (ev.endDate || addDays(ev.startDate, 1)));
}

export function blockClasses(block, status, now) {
  const c = ['block'];
  if (block.pinned) c.push('pinned');
  if (Date.parse(block.end) <= now) c.push('past');
  if (block.missed) c.push('missed');
  if (block.completed) c.push('completed');
  if (block.done) c.push('done');
  let kind = null;
  if (status && block.kind === 'task') {
    const ts = (status.tasks || []).find((t) => t.taskId === block.taskId);
    kind = ts ? ts.state : null;
  } else if (status) {
    const ar = (status.atRisk || []).find((a) => a.recurringId === block.recurringId && a.occurrenceDate === block.occurrenceDate);
    kind = ar ? ar.kind : null;
  }
  if (kind === 'hard') c.push('risk-hard');
  else if (kind === 'soft') c.push('risk-soft');
  else if (kind === 'tight') c.push('tight');
  return c;
}

const localDateOf = (iso, tzName) => utcToZoned(Date.parse(iso), tzName).date;

export function render(container, route, ctx) {
  const view = {
    container, route, ctx, alive: true, flashed: false, scrollEl: null, rootEl: null,
    pph: 48, mode: readPref(ZOOM_KEY) === '24h' ? '24h' : 'work', hoursFilter: readPref(HOURS_KEY) || 'all',
    range: { startMin: 480, endMin: 1080 }, untilLoaded: true, scrollOnce: false, ro: null,
  };
  view.drag = createDragController({ pxPerHour: () => view.pph, redraw: () => draw(view) });
  view.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => onResize(view)) : null;
  const tzName = tz();
  const anchor = route.params.date || todayIn(tzName, Date.now());
  view.anchor = anchor;
  view.dates = route.name === 'week' ? weekDates(anchor, (state.settings && state.settings.weekStartsOn) ?? 1) : [anchor];
  const unsub = subscribe(() => draw(view));
  const timer = setInterval(() => draw(view), 60000);
  draw(view);
  const from = new Date(zonedToUtc(view.dates[0], 0, tzName)).toISOString();
  const to = new Date(zonedToUtc(addDays(view.dates[view.dates.length - 1], 1), 0, tzName)).toISOString();
  setCalendarRange(from, to).then(() => { view.untilLoaded = false; }, (e) => {
    view.untilLoaded = false;
    toast(`Could not load calendar: ${e.message}`, 'error');
  });
  return () => { view.alive = false; unsub(); clearInterval(timer); closePopover(); view.drag.destroy(); if (view.ro) view.ro.disconnect(); };
}

// Fits pph to the scroll area; writes --pph only when it changes. Returns true when pph changed.
function measureScale(view) {
  const scroll = view.scrollEl;
  if (!scroll || !view.rootEl) return false;
  const sticky = scroll.querySelector('.cal-sticky');
  const availablePx = scroll.clientHeight - (sticky ? sticky.offsetHeight : 0);
  if (!(availablePx > 0)) return false;
  const pph = fitPxPerHour({ mode: view.mode, startMin: view.range.startMin, endMin: view.range.endMin, availablePx });
  if (pph === view.pph) return false;
  view.pph = pph;
  view.rootEl.style.setProperty('--pph', `${pph}px`);
  return true;
}

// ResizeObserver: rescale only (no redraw), keep the top time anchored (V2-D9).
function onResize(view) {
  if (!view.alive || !view.scrollEl) return;
  const top = view.scrollEl.scrollTop, old = view.pph;
  if (measureScale(view)) view.scrollEl.scrollTop = top * view.pph / old;
}

function draw(view) {
  if (!view.alive) return;
  if (view.drag && view.drag.deferRedraw()) return;
  const { container, route, ctx, dates, anchor } = view;
  const tzName = tz();
  const prev = view.scrollEl;
  const prevTop = prev ? prev.scrollTop : 0, prevLeft = prev ? prev.scrollLeft : 0;
  const prevPph = view.pph;
  clear(container);
  const now = Date.now();
  const today = todayIn(tzName, now);
  const blocks = state.calendar.blocks, events = state.calendar.events, status = state.status;
  const isWeek = route.name === 'week';
  const step = isWeek ? 7 : 1;
  const title = isWeek ? `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}` : fmtDate(anchor);

  const schedules = state.schedules || [];
  const filter = schedules.some((s) => String(s.id) === view.hoursFilter) ? view.hoursFilter : 'all';
  const hoursList = hoursListFor(schedules, filter, state.settings && state.settings.workHours);
  const one = filter === 'all' ? null : schedules.find((s) => String(s.id) === filter);
  const bandBg = one ? alphaColor(one.color, 0.12) : null;
  const perDay = dates.map((d) => dayItems(d, tzName, blocks, events));
  view.range = visibleRange({ weekdays: dates.map((d) => weekdayOf(d)), hoursList, itemMinutes: perDay.flat().map((it) => ({ startMin: it.startMin, endMin: it.endMin })) });

  const zoomBtn = (mode, label) => h('button', {
    class: 'btn', type: 'button', 'aria-pressed': view.mode === mode ? 'true' : 'false',
    onclick: () => { if (view.mode === mode) return; view.mode = mode; writePref(ZOOM_KEY, mode); view.scrollOnce = true; draw(view); },
  }, label);
  const select = h('select', { 'aria-label': 'Hours shown', onchange: (e) => { view.hoursFilter = e.target.value; writePref(HOURS_KEY, e.target.value); draw(view); } },
    h('option', { value: 'all', selected: filter === 'all' }, 'All schedules'),
    schedules.map((s) => h('option', { value: String(s.id), selected: filter === String(s.id) }, s.name)));

  const toolbar = h('div', { class: 'cal-toolbar' },
    h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate(`#/${route.name}/${addDays(anchor, -step)}`) }, '‹'),
    h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate(`#/${route.name}`) }, 'Today'),
    h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate(`#/${route.name}/${addDays(anchor, step)}`) }, '›'),
    h('span', { class: 'cal-title' }, title),
    h('span', { class: 'cal-toolbar-spacer' }),
    h('span', { class: 'cal-zoom', role: 'group', 'aria-label': 'Zoom' }, zoomBtn('work', 'Work hours'), zoomBtn('24h', '24 h')),
    h('label', { class: 'cal-hours' }, 'Hours: ', select),
    h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate('#/settings/schedules') }, 'Edit hours'));

  const head = h('div', { class: 'cal-row cal-head' },
    h('div', { class: 'cal-gutter-head' }),
    dates.map((d) => h('a', { class: 'cal-day-head' + (d === today ? ' today' : ''), href: `#/day/${d}` }, fmtDate(d))));

  const allday = h('div', { class: 'cal-row cal-allday' },
    h('div', { class: 'cal-gutter-head' }, 'all-day'),
    dates.map((d) => h('div', { class: 'cal-allday-cell' },
      allDayEventsFor(d, events).map((ev) => h('div', {
        class: 'allday-event' + (ev.blocking ? '' : ' non-blocking'),
        style: { borderLeftColor: ev.color || '' },
        onclick: (e) => { e.stopPropagation(); openEventPopover(e.currentTarget, ev); },
      }, ev.title)))));

  const sticky = h('div', { class: 'cal-sticky' }, head, allday);

  const hourLabels = Array.from({ length: 24 }, (_, i) =>
    h('div', { class: 'cal-hour-label', style: { top: cssHours(i * 60) } }, formatHHMM(i * 60)));
  const gutter = h('div', { class: 'cal-gutter' }, hourLabels);

  const cols = dates.map((d, i) => {
    const workEls = bandRanges(hoursList, weekdayOf(d)).map(([s, e]) => h('div', {
      class: 'work-hours',
      style: { top: cssHours(s), height: cssHours(e - s), background: bandBg || '' },
    }));
    const items = perDay[i].map((it) => {
      const pos = {
        top: cssHours(it.startMin), height: `max(${MIN_ITEM_PX}px, ${cssHours(it.endMin - it.startMin)})`,
        left: `${(it.lane / it.lanes) * 100}%`, width: `calc(${100 / it.lanes}% - 2px)`,
      };
      const timeText = fmtTimeRange(Date.parse(it.item.start), Date.parse(it.item.end), tzName);
      if (it.kind === 'event') {
        const ev = it.item;
        return h('div', {
          class: 'event' + (ev.blocking ? '' : ' non-blocking'),
          dataset: { eventId: ev.id },
          style: { ...pos, borderLeftColor: ev.color || '' },
          onclick: (e) => { e.stopPropagation(); openEventPopover(e.currentTarget, ev); },
        }, h('div', { class: 'item-title' }, ev.title), h('div', { class: 'item-time' }, timeText));
      }
      const b = it.item;
      const el = h('div', {
        class: blockClasses(b, status, now).join(' '),
        dataset: { blockId: b.id, date: d },
        style: { ...pos, background: b.color || '' },
        onclick: (e) => { e.stopPropagation(); openBlockPopover(view, e.currentTarget, b); },
      },
        h('div', { class: 'item-title' },
          (b.done || b.completed) ? h('span', { class: 'done-check', 'aria-label': 'done' }, '✓') : doneBubble(b), h('span', { class: 'item-label' }, blockLabel(b))),
        h('div', { class: 'item-time' }, timeText),
        b.pinned ? h('span', { class: 'badge badge-pin' }, 'PIN') : null,
        b.missed ? h('span', { class: 'badge badge-missed' }, 'missed') : null);
      view.drag.decorate(el, b, d, now);
      return el;
    });
    const kids = [...workEls, ...items];
    if (d === today) {
      kids.push(h('div', { class: 'now-line', style: { top: cssHours(utcToZoned(now, tzName).minutes) } }));
    }
    return h('div', { class: 'cal-col' + (d === today ? ' today' : ''), dataset: { date: d } }, kids);
  });
  const grid = h('div', { class: 'cal-row cal-grid' }, gutter, cols);

  const scroll = h('div', { class: 'cal-scroll' }, sticky, grid);
  view.scrollEl = scroll;
  view.drag.attach(scroll);
  const root = h('div', { class: 'cal' }, toolbar, scroll);
  root.style.setProperty('--cols', String(dates.length));
  root.style.setProperty('--pph', `${view.pph}px`);
  view.rootEl = root;
  container.appendChild(root);

  const applyInitial = view.untilLoaded || view.scrollOnce;
  view.scrollOnce = false;
  measureScale(view);
  if (applyInitial) {
    scroll.scrollTop = initialScrollPx({ mode: view.mode, startMin: view.range.startMin, pxPerHour: view.pph });
  } else {
    scroll.scrollTop = prevTop * view.pph / prevPph;
    scroll.scrollLeft = prevLeft;
  }
  if (view.ro) { view.ro.disconnect(); view.ro.observe(scroll); }

  const bid = route.query.get('block');
  if (bid && !view.flashed) {
    const target = [...scroll.querySelectorAll('[data-block-id]')].find((el) => el.dataset.blockId === bid);
    if (target) {
      view.flashed = true;
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 2000);
    }
  }
}

function openEventPopover(anchor, ev) {
  const tzName = tz();
  const cal = (state.calendars || []).find((c) => c.id === ev.calendarId);
  const timeText = ev.allDay
    ? `All day · ${fmtDate(ev.startDate)}`
    : `${fmtDate(localDateOf(ev.start, tzName))} ${fmtTimeRange(Date.parse(ev.start), Date.parse(ev.end), tzName)}`;
  const content = h('div', { class: 'popover-body' },
    h('h3', {}, ev.title),
    h('p', {}, timeText),
    ev.location ? h('p', {}, ev.location) : null,
    h('p', {}, cal ? cal.name : 'Calendar'));
  openPopover(anchor, content);
}

// A small circle on a block: one click marks the task (or the recurring occurrence) done.
function doneBubble(b) {
  const mark = b.kind === 'task'
    ? () => api.updateTask(b.taskId, { status: 'done' })
    : () => api.markOccurrenceDone(b.recurringId, b.occurrenceDate);
  const stop = (e) => e.stopPropagation();
  return h('button', {
    type: 'button', class: 'done-bubble', title: 'Mark done', 'aria-label': `Mark ${blockLabel(b)} done`,
    onpointerdown: stop, onmousedown: stop, ontouchstart: stop,
    onclick: async (e) => {
      e.stopPropagation();
      try { await mutate(mark); } catch (err) { toast(err.message, 'error'); }
    },
  });
}

function openBlockPopover(view, anchor, block) {
  const tzName = tz();
  const { ctx } = view;
  const isTask = block.kind === 'task';
  const open = !block.done;
  const free = !block.done && !block.completed;
  // Runs a mutation, then closes the popover; failures are shown as a toast.
  const act = (fn) => async () => {
    try { await mutate(fn); closePopover(); } catch (e) { toast(e.message, 'error'); }
  };
  const btn = (label, onclick) => h('button', { class: 'btn', type: 'button', onclick }, label);

  const acts = [];
  if (isTask && open) acts.push(btn('Mark task done', act(() => api.updateTask(block.taskId, { status: 'done' }))));

  // Slot 2: "Mark this part done" appears only when the task has >= 2 blocks (checked via getTask).
  let partSlot = null;
  if (isTask && free) {
    partSlot = h('span', {});
    acts.push(partSlot);
    api.getTask(block.taskId).then((t) => {
      if (!partSlot.isConnected) return;
      const blocksOfTask = (t && t.blocks) || [];
      if (blocksOfTask.length >= 2) {
        partSlot.replaceWith(btn('Mark this part done', act(() => api.updateBlock(block.id, { completed: true }))));
      }
    }).catch(() => {});
  }
  if (isTask && block.missed) acts.push(btn("Didn't do it", act(() => api.deleteBlock(block.id))));
  if (free) acts.push(btn(block.pinned ? 'Unpin' : 'Pin here', act(() => api.updateBlock(block.id, { pinned: !block.pinned }))));

  let form = null;
  if (free) {
    const startInput = dateTimeInput({ step: '900', value: isoToLocalInput(block.start, tzName) });
    const durInput = h('input', { type: 'number', min: '15', step: '15', value: String(Math.round((Date.parse(block.end) - Date.parse(block.start)) / MIN)) });
    form = h('form', { class: 'move-form', hidden: true, onsubmit: async (e) => {
      e.preventDefault();
      const start = localInputToIso(startInput.value, tzName);
      if (!start) { toast('Invalid start time', 'error'); return; }
      try {
        const end = new Date(Date.parse(start) + Number(durInput.value) * MIN).toISOString();
        await mutate(() => api.updateBlock(block.id, { start, end }));
        closePopover();
      } catch (err) { toast(err.message, 'error'); }
    } },
      h('label', {}, 'Start ', startInput),
      h('label', {}, 'Minutes ', durInput),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'));
    acts.push(btn('Move…', () => { form.hidden = !form.hidden; }));
    acts.push(form);
  }
  if (block.pinned && open) acts.push(btn('Remove pin', act(() => api.deleteBlock(block.id))));
  if (isTask) acts.push(btn('Open task', () => { closePopover(); ctx.navigate('#/task/' + block.taskId); }));
  else acts.push(btn('Open recurring', () => { closePopover(); ctx.navigate('#/recurring'); }));

  const timeText = `${fmtDate(localDateOf(block.start, tzName))} ${fmtTimeRange(Date.parse(block.start), Date.parse(block.end), tzName)}`;
  const content = h('div', { class: 'popover-body' },
    h('h3', {}, blockLabel(block)),
    h('p', {}, timeText),
    h('div', { class: 'popover-actions' }, acts));
  openPopover(anchor, content);
}
