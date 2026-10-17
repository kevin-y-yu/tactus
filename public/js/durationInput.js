// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Duration entry in hours (default) or minutes, with a toggle. `.value` is always whole minutes as a string (rounded to
// the nearest 15, at least 15), or '' when empty, so callers read it like the old minutes input.
import { h } from './ui.js';

const KEY = 'tactus.durationUnit';
const load = () => { try { return localStorage.getItem(KEY) === 'min' ? 'min' : 'h'; } catch { return 'h'; } };
const save = (u) => { try { localStorage.setItem(KEY, u); } catch { /* ignore */ } };
const fmtNum = (n) => String(Math.round(n * 100) / 100);

export function roundMinutes(min) {
  return Math.max(15, Math.round(min / 15) * 15);
}

// attrs: { value: minutes, max: minutes, required, name }
export function durationInput({ value = 60, max = 2880, required = true, name } = {}) {
  let unit = load();
  let minutes = value === '' || value == null ? null : Number(value);
  const input = h('input', { type: 'number', step: 'any', min: 0, inputmode: 'decimal', required, 'aria-label': 'Duration' });
  if (name) input.name = name;
  const sel = h('select', { 'aria-label': 'Duration unit' },
    h('option', { value: 'h' }, 'hours'), h('option', { value: 'min' }, 'minutes'));
  const show = () => {
    sel.value = unit;
    input.max = unit === 'h' ? String(max / 60) : String(max);
    input.min = unit === 'h' ? '0.25' : '15';
    input.value = minutes == null ? '' : unit === 'h' ? fmtNum(minutes / 60) : String(minutes);
  };
  const read = () => {
    const n = parseFloat(input.value);
    return Number.isFinite(n) ? roundMinutes(unit === 'h' ? n * 60 : n) : null;
  };
  input.addEventListener('change', () => { minutes = read(); show(); });      // round to the 15-minute grid
  sel.addEventListener('change', () => { minutes = read() ?? minutes; unit = sel.value; save(unit); show(); });
  const wrap = h('span', { class: 'dur-input' }, input, sel);
  Object.defineProperty(wrap, 'value', {
    get: () => { const m = read(); return m == null ? '' : String(m); },
    set: (v) => { minutes = v === '' || v == null ? null : Number(v); show(); },
  });
  show();
  return wrap;
}
