// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Shared DOM builders for the settings sections (v2 chunk 20). DOM is touched only inside functions (AC-ARCH rule 3).
import { h, clear, toast } from '../../ui.js';
import { state, subscribe, mutate } from '../../state.js';
import * as api from '../../api.js';
import { changedSettings } from '../../settingsModel.js';

// One .form-grid row -> [label, control]. input gets id `set-<input.name>`; extra nodes sit inline after it; hint goes under it.
export function gridRow(labelText, input, { hint = null, extra = [] } = {}) {
  const id = `set-${input.name}`;
  input.id = id;
  const main = extra.length ? h('div', { class: 'form-inline' }, input, extra) : input;
  return [h('label', { for: id }, labelText),
    h('div', { class: 'form-control' }, main, hint ? h('div', { class: 'hint' }, hint) : null)];
}

// Number input for a NUMBER_FIELDS entry.
export function numberInput(f, value) {
  return h('input', { type: 'number', name: f.key, min: f.min, max: f.max, step: f.step, required: true, value: String(value) });
}

// A .card holding a form whose Save PUTs only the keys of collect() that differ from state.settings.
// rows: nodes for the .form-grid; note: optional text under the grid; onSaved(): called after a successful save.
export function settingsCard({ title, rows, note = null, collect, onSaved }) {
  const errLine = h('p', { class: 'form-error' });
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');
  const form = h('form', { class: 'settings-form' },
    h('div', { class: 'form-grid' }, rows),
    note ? h('p', { class: 'settings-note' }, note) : null,
    errLine,
    h('div', { class: 'form-actions' }, saveBtn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errLine.textContent = '';
    const partial = changedSettings(state.settings, collect());
    if (Object.keys(partial).length === 0) { toast('No changes'); return; }
    saveBtn.disabled = true;
    try {
      await mutate(() => api.putSettings(partial));
      toast('Settings saved');
      onSaved();
    } catch (ex) {
      errLine.textContent = ex.message;
    } finally {
      saveBtn.disabled = false;
    }
  });
  return h('section', { class: 'card' }, h('h3', {}, title), form);
}

// Calls build(rebuild) into host once state.settings is loaded; if not loaded yet, retries on the next store notify.
// rebuild clears host and builds again (used as onSaved). Returns the unsubscribe cleanup.
export function whenSettings(host, build) {
  let pending = false;
  const rebuild = () => {
    clear(host);
    if (!state.settings) { pending = true; return; }
    pending = false;
    build(rebuild);
  };
  rebuild();
  return subscribe(() => { if (pending) rebuild(); });
}
