// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Shared UI helpers. Pure formatters and parseRoute are DOM-free; DOM helpers touch `document` only when called.
import { utcToZoned, formatHHMM, weekdayOf } from '../shared/time.js';

export const ROUTE_NAMES = ['week', 'day', 'agenda', 'projects', 'task', 'recurring', 'settings'];

// '#/day/2026-10-19?block=5' -> {name:'day', params:{date:'2026-10-19'}, query:URLSearchParams}; invalid -> null
// '#/settings/calendars' -> params.section 'calendars'; '#/settings' -> null
export function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const path = qi === -1 ? raw : raw.slice(0, qi);
  const query = new URLSearchParams(qi === -1 ? '' : raw.slice(qi + 1));
  const [name = '', arg = ''] = path.split('/');
  if (!ROUTE_NAMES.includes(name)) return null;
  const params = {};
  if (name === 'week' || name === 'day') params.date = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : null;
  if (name === 'task') { if (!arg) return null; params.id = arg; }
  if (name === 'settings') params.section = arg || null;   // '#/settings/<section>' (v2 R3); validated by settingsModel.sectionFromRoute
  return { name, params, query };
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'Thu 22 Oct'
export function fmtDate(dateStr) {
  const [, mm, dd] = dateStr.split('-');
  return `${WD[weekdayOf(dateStr)]} ${Number(dd)} ${MON[Number(mm) - 1]}`;
}

export function fmtTime(ms, tz) {
  return formatHHMM(utcToZoned(ms, tz).minutes);
}

export function fmtTimeRange(startMs, endMs, tz) {
  return `${fmtTime(startMs, tz)}–${fmtTime(endMs, tz)}`;
}

// 45 -> '45m', 120 -> '2h', 90 -> '1h 30m'
export function fmtDuration(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// local YYYY-MM-DD in tz at instant `now`
export function todayIn(tz, now) {
  return utcToZoned(now, tz).date;
}

// ---- DOM helpers (touch document only when called) ----

// h('div', {class:'x', onclick: fn}, 'text', childNode, [more])
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (key === 'class') el.className = v;
    else if (key === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (key === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(v));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(add); return; }
    if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// toast(message, kind, action?): action {label, onClick} adds a button; 6 s with an action, 4 s otherwise (v2 R8).
export function toast(message, kind = 'info', action) {
  let container = document.getElementById('toasts');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toasts';
    container.className = 'toasts';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  if (action) {
    t.classList.add('toast-with-action');
    const msg = document.createElement('span'); msg.textContent = message;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'toast-action'; btn.textContent = action.label;
    btn.addEventListener('click', () => { t.remove(); action.onClick(); }, { once: true });
    t.append(msg, btn);
  } else {
    t.textContent = message;
  }
  container.appendChild(t);
  setTimeout(() => t.remove(), action ? 6000 : 4000);
}

let popover = null;
let popoverAnchor = null;
let onKeydown = null;
let onMousedown = null;
let popoverOnClose = null;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

export function closePopover() {
  if (onKeydown) document.removeEventListener('keydown', onKeydown);
  if (onMousedown) document.removeEventListener('mousedown', onMousedown, true);
  onKeydown = null;
  onMousedown = null;
  if (popover) popover.remove();
  popover = null;
  popoverAnchor = null;
  const cb = popoverOnClose; popoverOnClose = null; if (cb) cb();
}

export function openPopover(anchorEl, contentEl, onClose = null) {
  closePopover();
  const el = document.createElement('div');
  el.className = 'popover';
  el.setAttribute('role', 'dialog');
  el.style.position = 'fixed';
  el.appendChild(contentEl);
  document.body.appendChild(el);
  const rect = anchorEl.getBoundingClientRect();
  el.style.left = `${clamp(rect.right + 8, 8, window.innerWidth - 308)}px`;
  el.style.top = `${clamp(rect.top, 8, window.innerHeight - el.offsetHeight - 8)}px`;
  popover = el;
  popoverAnchor = anchorEl;
  popoverOnClose = onClose;
  onKeydown = (e) => { if (e.key === 'Escape') closePopover(); };
  onMousedown = (e) => {
    if (e.target.closest && e.target.closest('.datepop')) return;
    if (!el.contains(e.target) && !(popoverAnchor && popoverAnchor.contains(e.target))) closePopover();
  };
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('mousedown', onMousedown, true);
  return el;
}
