// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Date entry with a large pop-up calendar (the browser's own date pop-up is small and cannot be resized). Returns a
// plain text <input> so `.value` ('YYYY-MM-DD' or ''), `name`, `required` and change listeners work as on a native one.
import { h } from './ui.js';
import { state } from './state.js';
import { todayIn } from './ui.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;          // m is 0-based
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let open = null;                                                    // { el, close } of the one open calendar

function closeOpen() { if (open) open.close(); }

export function dateInput(attrs = {}) {
  const el = h('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'YYYY-MM-DD', maxlength: 10, size: 11,
    pattern: '\\d{4}-\\d{2}-\\d{2}', title: 'Date as YYYY-MM-DD, or click to pick', ...attrs,
  });
  el.classList.add('date-input');
  let pop = null;

  function show() {
    if (pop) return;
    closeOpen();
    const today = todayIn(state.settings.timezone, Date.now());
    const start = Number((state.settings && state.settings.weekStartsOn) ?? 1);
    const base = ISO.test(el.value) ? el.value : today;
    let year = Number(base.slice(0, 4));
    let month = Number(base.slice(5, 7)) - 1;

    pop = h('div', { class: 'datepop', role: 'dialog', 'aria-label': 'Choose a date' });
    const render = () => {
      const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
      const lead = (first - start + 7) % 7;
      const len = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const cells = [];
      for (let i = 0; i < lead; i++) cells.push(h('span', { class: 'dp-pad' }));
      for (let d = 1; d <= len; d++) {
        const v = iso(year, month, d);
        const cls = ['dp-day', v === el.value ? 'dp-sel' : '', v === today ? 'dp-today' : ''].filter(Boolean).join(' ');
        cells.push(h('button', { type: 'button', class: cls, onclick: () => pick(v) }, String(d)));
      }
      pop.replaceChildren(
        h('div', { class: 'dp-head' },
          h('button', { type: 'button', class: 'dp-nav', 'aria-label': 'Previous month', onclick: () => { if (month-- === 0) { month = 11; year--; } render(); } }, '‹'),
          h('strong', {}, `${MONTHS[month]} ${year}`),
          h('button', { type: 'button', class: 'dp-nav', 'aria-label': 'Next month', onclick: () => { if (month++ === 11) { month = 0; year++; } render(); } }, '›')),
        h('div', { class: 'dp-grid' },
          ...Array.from({ length: 7 }, (_, i) => h('span', { class: 'dp-dow' }, DAYS[(start + i) % 7])), ...cells),
        h('div', { class: 'dp-foot' },
          h('button', { type: 'button', class: 'btn', onclick: () => pick(today) }, 'Today'),
          el.required ? '' : h('button', { type: 'button', class: 'btn', onclick: () => pick('') }, 'Clear')));
    };
    function pick(v) {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      close();
    }
    const onDoc = (e) => { if (!pop.contains(e.target) && e.target !== el) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() {
      if (!pop) return;
      pop.remove(); pop = null; open = null;
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    }
    render();
    document.body.append(pop);
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth, ph = pop.offsetHeight;
    const below = r.bottom + 4 + ph <= window.innerHeight || r.top - 4 - ph < 0;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    pop.style.top = `${Math.max(8, below ? r.bottom + 4 : r.top - 4 - ph)}px`;
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    open = { el, close };
  }
  el.addEventListener('focus', show);
  el.addEventListener('click', show);
  el.addEventListener('input', () => { if (pop && ISO.test(el.value)) { close(); show(); } });
  return el;
}
