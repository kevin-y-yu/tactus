// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Settings section "Work hours & schedules" (#/settings/schedules): one card per schedule (v2 §R6 UI, UR-2). v2 chunk 20, 22.
import { h, clear, toast } from '../../ui.js';
import { state, mutate } from '../../state.js';
import * as api from '../../api.js';
import { WEEKDAY_SHORT, weekdayOrder } from '../recurring.js';
import { whenSettings } from './form.js';
import {
  sortSchedules, defaultSchedule, scheduleUsage, startTimeOptions, endTimeOptions, cloneHours, copyToWeekdays,
  nextScheduleName, nextRange, normalizeHours, hoursError, scheduleCardActions, deleteScheduleMessage,
} from '../../scheduleModel.js';

export function render(host, ctx) {
  const body = h('div');
  host.appendChild(body);
  return whenSettings(body, (rebuild) => {
    const newBtn = h('button', { class: 'btn', type: 'button' }, '+ New schedule');
    newBtn.addEventListener('click', async () => {
      newBtn.disabled = true;
      try {
        const def = defaultSchedule(state.schedules);
        await mutate(() => api.createSchedule({ name: nextScheduleName(state.schedules), hours: cloneHours(def ? def.hours : {}) }));
        toast('Schedule created');
        rebuild();
      } catch (ex) {
        toast(ex.message, 'error');
      } finally {
        newBtn.disabled = false;
      }
    });
    body.appendChild(h('div', { class: 'sched-toolbar' }, newBtn));
    const list = sortSchedules(state.schedules);
    if (list.length === 0) body.appendChild(h('p', {}, 'No schedules.'));
    for (const s of list) body.appendChild(scheduleCard(s, rebuild));
  });
}

function scheduleCard(s, onChanged) {
  const actions = scheduleCardActions(s);
  const draft = cloneHours(s.hours);
  const weekStartsOn = state.settings.weekStartsOn;
  const errLine = h('p', { class: 'form-error', role: 'alert' });

  // Head: name, colour, and either "Make default" or the "Default" badge.
  const nameIn = h('input', { type: 'text', name: 'name', required: true, maxlength: 50, value: s.name,
    'aria-label': 'Schedule name', disabled: !actions.canEditName });
  const colorIn = h('input', { type: 'color', name: 'color', value: s.color,
    'aria-label': 'Schedule colour', disabled: !actions.canEditColor });
  let badgeOrBtn;
  if (actions.canMakeDefault) {
    const makeDefaultBtn = h('button', { class: 'btn', type: 'button' }, 'Make default');
    makeDefaultBtn.addEventListener('click', async () => {
      makeDefaultBtn.disabled = true;
      try {
        await mutate(() => api.setDefaultSchedule(s.id));
        toast('Default schedule changed');
        onChanged();
      } catch (ex) {
        errLine.textContent = ex.message;
      } finally {
        makeDefaultBtn.disabled = false;
      }
    });
    badgeOrBtn = makeDefaultBtn;
  } else {
    badgeOrBtn = h('span', { class: 'sched-badge' }, 'Default');
  }
  const head = h('div', { class: 'sched-head' }, nameIn, colorIn, badgeOrBtn);

  // Weekly rows, redrawn from the draft on every structural change.
  const rowsHost = h('div', { class: 'sched-week' });
  const select = (options, value, label, onPick) => {
    const sel = h('select', { 'aria-label': label, disabled: !actions.canEditHours },
      options.map((t) => h('option', { value: t }, t)));
    sel.value = value;
    sel.addEventListener('change', () => onPick(sel.value));
    return sel;
  };
  const drawRows = () => {
    clear(rowsHost);
    for (const d of weekdayOrder(weekStartsOn)) {
      const key = String(d);
      const day = WEEKDAY_SHORT[d];
      const pairs = draft[key].map((range, i) => {
        const startSel = select(startTimeOptions(), range[0], `${day} range ${i + 1} start`, (v) => { range[0] = v; });
        const endSel = select(endTimeOptions(), range[1], `${day} range ${i + 1} end`, (v) => { range[1] = v; });
        const removeBtn = h('button', { class: 'btn', type: 'button', disabled: !actions.canEditHours,
          onclick: () => { draft[key].splice(i, 1); drawRows(); } }, 'Remove');
        return h('span', { class: 'wh-pair' }, startSel, '–', endSel, removeBtn);
      });
      const addBtn = h('button', { class: 'btn', type: 'button', disabled: !actions.canEditHours,
        onclick: () => { draft[key].push(nextRange(draft[key])); drawRows(); } }, '+ Add range');
      const copyBtn = h('button', { class: 'btn', type: 'button', title: 'Copy this day to Mon–Fri', disabled: !actions.canEditHours,
        onclick: () => { Object.assign(draft, copyToWeekdays(draft, d)); drawRows(); } }, 'Copy to weekdays');
      rowsHost.appendChild(h('div', { class: 'wh-row', dataset: { day: key } },
        h('span', { class: 'wh-day' }, day), ...pairs, addBtn, copyBtn));
    }
  };
  drawRows();

  // Actions: Save always; Delete only for non-default schedules.
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');
  let deleteBtn = null;
  if (actions.canDelete) {
    deleteBtn = h('button', { class: 'btn', type: 'button' }, 'Delete');
    deleteBtn.addEventListener('click', async () => {
      errLine.textContent = '';
      const def = defaultSchedule(state.schedules);
      const msg = deleteScheduleMessage(s.name, scheduleUsage(s.id, state), def ? def.name : 'default');
      if (!window.confirm(msg)) return;
      deleteBtn.disabled = true;
      try {
        await mutate(() => api.deleteSchedule(s.id));
        toast('Schedule deleted');
        onChanged();
      } catch (ex) {
        errLine.textContent = ex.message;
      } finally {
        deleteBtn.disabled = false;
      }
    });
  }
  const form = h('form', { class: 'settings-form sched-form' }, rowsHost, errLine,
    h('div', { class: 'form-actions' }, saveBtn, deleteBtn));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errLine.textContent = '';
    const hours = normalizeHours(draft);
    const err = hoursError(hours, weekStartsOn);
    if (err) { errLine.textContent = err; return; }
    saveBtn.disabled = true;
    try {
      await mutate(() => api.updateSchedule(s.id, { name: nameIn.value.trim(), color: colorIn.value, hours }));
      toast('Schedule saved');
      onChanged();
    } catch (ex) {
      errLine.textContent = ex.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  const card = h('section', { class: 'card sched-card', dataset: { scheduleId: String(s.id) }, style: { borderLeftColor: s.color } },
    head, form);
  colorIn.addEventListener('input', () => { card.style.borderLeftColor = colorIn.value; });
  return card;
}
