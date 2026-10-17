// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Time entry that follows the "24-hour clock" setting. Off: the browser's native time / date-time inputs (which show
// 1:00 PM in some locales). On: plain text boxes that take 13:00, with the same `.value` strings ('HH:MM',
// 'YYYY-MM-DDTHH:MM', '' when empty) so callers read and write them like native inputs.
import { h } from './ui.js';
import { state } from './state.js';
import { dateInput } from './datePicker.js';

const is24 = () => Boolean(state.settings && state.settings.clock24);

// attrs: the attributes you would give <input type="time"> (value, name, required, disabled, aria-label, step ignored).
export function timeInput(attrs = {}) {
  if (!is24()) return h('input', { type: 'time', ...attrs });
  const { step, ...rest } = attrs;
  const el = h('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'HH:MM', maxlength: 5, size: 5,
    pattern: '([01][0-9]|2[0-3]):[0-5][0-9]', title: '24-hour time, for example 13:00', ...rest,
  });
  el.addEventListener('blur', () => {                       // 930, 9:30 and 09:30 all become 09:30
    const m = /^(\d{1,2}):?(\d{2})$/.exec(el.value.trim());
    if (m) el.value = `${m[1].padStart(2, '0')}:${m[2]}`;
  });
  return el;
}

// attrs: value 'YYYY-MM-DDTHH:MM' | '' plus the usual attributes. Returns an element with a `.value` accessor.
export function dateTimeInput(attrs = {}) {
  const { value = '', step, ...rest } = attrs;
  const [d = '', t = ''] = String(value).split('T');
  const dateEl = dateInput({ value: d, 'aria-label': 'Date', ...rest });
  const timeEl = timeInput({ value: t, 'aria-label': 'Time' });
  const wrap = h('span', { class: 'dt24' }, dateEl, timeEl);
  Object.defineProperty(wrap, 'value', {
    get: () => (dateEl.value && timeEl.value ? `${dateEl.value}T${timeEl.value}` : ''),
    set: (v) => { const [a = '', b = ''] = String(v || '').split('T'); dateEl.value = a; timeEl.value = b; },
  });
  return wrap;
}
