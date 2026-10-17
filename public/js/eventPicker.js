// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Pop-up week calendar for choosing calendar events (task "starts after" / "must finish before" links).
// openEventPicker({ chosen: [{calendarId, uid, start}], onToggle(event, nowChosen), title }) -> close()
import { h, clear, fmtDate, todayIn } from './ui.js';
import { state, tz } from './state.js';
import * as api from './api.js';
import { zonedToUtc, utcToZoned, addDays, formatHHMM } from '../shared/time.js';
import { weekDates, layoutLanes } from './layout.js';

const PX_HOUR = 22;                       // condensed: a 06:00-22:00 day is 352px tall
const FROM_MIN = 6 * 60, TO_MIN = 22 * 60;
const keyOf = (e) => `${e.calendarId}|${e.uid}|${e.start}`;

export function openEventPicker({ chosen, onToggle, title = 'Pick calendar events' }) {
  const zone = tz();
  const picked = new Set(chosen.map(keyOf));
  const weekStartsOn = Number((state.settings && state.settings.weekStartsOn) ?? 1);
  let anchor = todayIn(zone, Date.now());
  let token = 0;

  const grid = h('div', { class: 'ep-grid' });
  const label = h('strong', { class: 'ep-title' });
  const backdrop = h('div', { class: 'ep-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } });
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const go = (d) => { anchor = d; render(); };

  async function render() {
    const mine = ++token;
    const days = weekDates(anchor, weekStartsOn);
    label.textContent = `${fmtDate(days[0])} – ${fmtDate(days[6])}`;
    clear(grid);
    grid.append(h('p', { class: 'te-hint' }, 'Loading…'));
    let events = [];
    try {
      const r = await api.getCalendarRange(new Date(zonedToUtc(days[0], 0, zone)).toISOString(), new Date(zonedToUtc(addDays(days[6], 1), 0, zone)).toISOString());
      events = ((r && r.events) || []).filter((e) => !e.allDay && e.calendarId != null);
    } catch { /* shown as empty */ }
    if (mine !== token) return;
    const today = todayIn(zone, Date.now());
    const hours = [];
    for (let m = FROM_MIN; m < TO_MIN; m += 60) hours.push(h('div', { class: 'ep-hour', style: { height: `${PX_HOUR}px` } }, formatHHMM(m)));
    const cols = days.map((d) => {
      const items = events.map((e) => ({ e, start: Date.parse(e.start), end: Date.parse(e.end) }))
        .filter((x) => utcToZoned(x.start, zone).date === d).map((x, i) => ({ ...x, id: i }));
      const lanes = new Map(layoutLanes(items).map((l) => [l.id, l]));
      const col = h('div', { class: 'ep-col', style: { height: `${(TO_MIN - FROM_MIN) / 60 * PX_HOUR}px` } });
      for (const it of items) {
        const sMin = utcToZoned(it.start, zone).minutes;
        const eMin = Math.min(sMin + Math.max(15, Math.round((it.end - it.start) / 60000)), TO_MIN);
        if (eMin <= FROM_MIN || sMin >= TO_MIN) continue;
        const top = (Math.max(sMin, FROM_MIN) - FROM_MIN) / 60 * PX_HOUR;
        const hgt = Math.max(14, (eMin - Math.max(sMin, FROM_MIN)) / 60 * PX_HOUR - 1);
        const l = lanes.get(it.id);
        const btn = h('button', {
          type: 'button', class: `ep-event${picked.has(keyOf(it.e)) ? ' ep-on' : ''}`,
          title: `${it.e.title} ${formatHHMM(sMin)}`,
          style: { top: `${top}px`, height: `${hgt}px`, left: `${l.lane / l.lanes * 100}%`, width: `${100 / l.lanes}%`, background: picked.has(keyOf(it.e)) ? '' : (it.e.color || '') },
          onclick: () => {
            const k = keyOf(it.e);
            if (picked.has(k)) picked.delete(k); else picked.add(k);
            onToggle({ calendarId: it.e.calendarId, uid: it.e.uid, start: it.e.start, title: it.e.title }, picked.has(k));
            btn.classList.toggle('ep-on', picked.has(k));
            btn.style.background = picked.has(k) ? '' : (it.e.color || '');
          },
        }, `${formatHHMM(sMin)} ${it.e.title}`);
        col.append(btn);
      }
      return h('div', { class: `ep-day${d === today ? ' ep-today' : ''}` }, h('div', { class: 'ep-dayhead' }, fmtDate(d)), col);
    });
    clear(grid);
    grid.append(h('div', { class: 'ep-hours' }, h('div', { class: 'ep-dayhead' }, ''), ...hours), ...cols);
  }

  document.addEventListener('keydown', onKey, true);
  backdrop.append(h('div', { class: 'ep-modal', role: 'dialog', 'aria-label': title },
    h('div', { class: 'ep-bar' },
      h('strong', {}, title),
      h('span', { class: 'ep-nav' },
        h('button', { type: 'button', class: 'btn', onclick: () => go(addDays(anchor, -7)) }, '‹'),
        h('button', { type: 'button', class: 'btn', onclick: () => go(todayIn(zone, Date.now())) }, 'Today'),
        h('button', { type: 'button', class: 'btn', onclick: () => go(addDays(anchor, 7)) }, '›'),
        label),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: close }, 'Done')),
    h('p', { class: 'te-hint' }, 'Click an event to choose it; click again to remove it. Highlighted events are chosen.'),
    grid));
  document.body.append(backdrop);
  render();
  return close;
}
