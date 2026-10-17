// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Recurring view (#/recurring, #/recurring?edit=<id|new>). Chunk 14.
// Pure helpers (DOM-free, verified in Node): WEEKDAY_SHORT, FREQUENCIES, PRIORITIES,
// weekdayOrder, recurringSummary, windowText, recurringBody.
// render(container, route, ctx) -> cleanup. Pattern matches views/calendar.js.
import { timeInput } from '../timeInput.js';
import { dateInput } from '../datePicker.js';
import { durationInput } from '../durationInput.js';
import { h, clear, toast, fmtDuration, todayIn } from '../ui.js';
import { state, subscribe, mutate, tz } from '../state.js';
import * as api from '../api.js';
import { scheduleOptions, scheduleValue, scheduleIdFromValue } from '../scheduleModel.js';

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const FREQUENCIES = [['daily', 'Daily'], ['weekdays', 'Weekdays (Mon–Fri)'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

export function weekdayOrder(weekStartsOn) {
  return weekStartsOn === 0 ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
}

export function recurringSummary(rec, weekStartsOn) {
  switch (rec.frequency) {
    case 'daily': return 'Daily';
    case 'weekdays': return 'Weekdays';
    case 'weekly': {
      const set = new Set(rec.daysOfWeek || []);
      const days = weekdayOrder(weekStartsOn).filter((d) => set.has(d)).map((d) => WEEKDAY_SHORT[d]);
      return days.length ? `Weekly ${days.join(', ')}` : 'Weekly total, any day';
    }
    case 'monthly': return `Monthly on day ${rec.dayOfMonth}`;
    default: return String(rec.frequency);
  }
}

export function windowText(rec) {
  return rec.windowStart && rec.windowEnd ? `${rec.windowStart}–${rec.windowEnd}` : 'No preferred window';
}

// v: raw form values {title, projectId:'' | '<id>', frequency, daysOfWeek:number[], dayOfMonth:string, durationMin:string,
//    noWindow:boolean, windowStart, windowEnd, priority, startDate, endDate:'' | 'YYYY-MM-DD', active:boolean,
//    scheduleId:'' | '<id>' (v2 chunk 22; '' = inherit -> null)}
// -> {error: string|null, body}. Key order of body is fixed as below.
export function recurringBody(v) {
  const weekly = v.frequency === 'weekly', monthly = v.frequency === 'monthly';
  const body = {
    title: String(v.title).trim(),
    projectId: v.projectId === '' ? null : Number(v.projectId),
    frequency: v.frequency,
    daysOfWeek: weekly ? [...v.daysOfWeek].map(Number).sort((a, b) => a - b) : [],
    dayOfMonth: monthly ? Number(v.dayOfMonth) : null,
    durationMin: Number(v.durationMin),
    windowStart: v.noWindow ? null : v.windowStart,
    windowEnd: v.noWindow ? null : v.windowEnd,
    priority: v.priority,
    startDate: v.startDate,
    endDate: v.endDate === '' ? null : v.endDate,
    active: !!v.active,
    scheduleId: scheduleIdFromValue(v.scheduleId),
    minBlockMin: v.minBlockMin === '' || v.minBlockMin == null ? null : Number(v.minBlockMin),
    droppable: v.priority === 'low' && !!v.droppable,
  };
  let error = null;
  if (!v.noWindow && (!v.windowStart || !v.windowEnd)) error = 'Set both window times or tick "No preferred window".';
  return { error, body };
}

export function render(container, route, ctx) {
  const editorHost = h('div');
  const listHost = h('div');
  const root = h('div', { class: 'recurring-view' },
    h('div', { class: 'rec-toolbar' },
      h('h2', {}, 'Recurring'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate('#/recurring?edit=new') }, '+ Recurring')),
    editorHost,
    listHost);
  container.appendChild(root);

  const editId = route.query.get('edit');
  if (editId !== null) buildEditor(editorHost, editId, ctx);

  const drawList = () => {
    clear(listHost);
    const weekStartsOn = state.settings?.weekStartsOn ?? 1;
    if (!state.recurring || state.recurring.length === 0) {
      listHost.appendChild(h('p', {}, 'No recurring tasks yet.'));
      return;
    }
    const rows = state.recurring.map((rec) => {
      const check = h('input', { type: 'checkbox', checked: !!rec.active });
      check.checked = !!rec.active;
      check.addEventListener('change', async () => {
        const want = check.checked;
        try {
          await mutate(() => api.updateRecurring(rec.id, { active: want }));
        } catch (e) {
          check.checked = !want;
          toast(e.message, 'error');
        }
      });
      return h('tr', {},
        h('td', {}, rec.title),
        h('td', {}, recurringSummary(rec, weekStartsOn)),
        h('td', {}, fmtDuration(rec.durationMin)),
        h('td', {}, windowText(rec)),
        h('td', {}, h('span', { class: 'rec-chip' }, rec.priority)),
        h('td', {}, h('label', { class: 'inline' }, check, 'Active')),
        h('td', {}, h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate(`#/recurring?edit=${rec.id}`) }, 'Edit')),
        h('td', {}, h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            if (!confirm(`Delete "${rec.title}"?`)) return;
            try {
              await mutate(() => api.deleteRecurring(rec.id));
              if (route.query.get('edit') === String(rec.id)) ctx.navigate('#/recurring');
            } catch (e) {
              toast(e.message, 'error');
            }
          },
        }, 'Delete')));
    });
    listHost.appendChild(h('table', { class: 'rec-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Title'), h('th', {}, 'Schedule'), h('th', {}, 'Duration'), h('th', {}, 'Window'),
        h('th', {}, 'Priority'), h('th', {}, 'Active'), h('th', {}), h('th', {}))),
      h('tbody', {}, rows)));
  };
  drawList();
  const unsub = subscribe(drawList);
  return () => { unsub(); };
}

function buildEditor(host, editId, ctx) {
  const isNew = editId === 'new';
  const rec = isNew ? null : (state.recurring || []).find((r) => String(r.id) === editId);
  if (!isNew && !rec) {
    host.appendChild(h('div', { class: 'rec-editor' },
      h('p', {}, 'Recurring task not found.'),
      h('a', { href: '#/recurring' }, 'Back')));
    return;
  }
  const tzName = tz();
  const weekStartsOn = state.settings?.weekStartsOn ?? 1;
  const init = {
    title: rec?.title ?? '',
    projectId: rec?.projectId != null ? String(rec.projectId) : '',
    frequency: rec?.frequency ?? 'daily',
    days: new Set(rec?.daysOfWeek || []),
    dayOfMonth: String(rec?.dayOfMonth ?? 1),
    durationMin: String(rec?.durationMin ?? 30),
    noWindow: !(rec && rec.windowStart && rec.windowEnd),
    windowStart: rec?.windowStart || '09:00',
    windowEnd: rec?.windowEnd || '10:00',
    priority: rec?.priority ?? 'medium',
    startDate: rec?.startDate ?? todayIn(tzName, Date.now()),
    endDate: rec?.endDate ?? '',
    active: rec ? !!rec.active : true,
    scheduleId: scheduleValue(rec?.scheduleId ?? null),
    minBlockMin: rec?.minBlockMin != null ? String(rec.minBlockMin) : '',
    droppable: !!rec?.droppable,
  };

  // Project options: non-archived projects, plus the current one even if archived.
  const projectOpts = [h('option', { value: '' }, 'No project')];
  for (const p of state.projects || []) {
    if (p.archived && String(p.id) !== init.projectId) continue;
    const opt = h('option', { value: String(p.id) }, p.archived ? `${p.name} (archived)` : p.name);
    if (String(p.id) === init.projectId) opt.selected = true;
    projectOpts.push(opt);
  }

  const scheduleSel = h('select', { name: 'scheduleId' });
  const fillSchedules = (projectValue, selected) => {
    clear(scheduleSel);
    const proj = (state.projects || []).find((p) => String(p.id) === projectValue) || null;
    for (const o of scheduleOptions(state.schedules, proj)) scheduleSel.appendChild(h('option', { value: o.value }, o.label));
    scheduleSel.value = selected;
  };
  fillSchedules(init.projectId, init.scheduleId);

  const errLine = h('p', { class: 'form-error' });
  const titleIn =h('input', { type: 'text', name: 'title', required: true, maxlength: 200, value: init.title });
  const projectSel = h('select', { name: 'projectId' }, projectOpts);
  projectSel.addEventListener('change', () => fillSchedules(projectSel.value, scheduleSel.value));
  const freqSel = h('select', { name: 'frequency' }, FREQUENCIES.map(([v, label]) => {
    const o = h('option', { value: v }, label);
    if (v === init.frequency) o.selected = true;
    return o;
  }));
  const dayBoxes = [];
  for (const d of weekdayOrder(weekStartsOn)) {
    const cb = h('input', { type: 'checkbox', value: String(d) });
    cb.checked = init.days.has(d);
    dayBoxes.push(cb);
  }
  const weekdaysFs = h('fieldset', { class: 'rec-weekdays', hidden: init.frequency !== 'weekly' },
    h('legend', {}, 'Weekdays (none ticked: the duration is a weekly total, placed on any day)'),
    weekdayOrder(weekStartsOn).map((d, i) => h('label', { class: 'inline' }, dayBoxes[i], WEEKDAY_SHORT[d])));
  const domLabel = h('label', { hidden: init.frequency !== 'monthly' }, 'Day of month',
    h('input', { type: 'number', name: 'dayOfMonth', min: 1, max: 31, step: 1, required: true, value: init.dayOfMonth }));
  const durIn = durationInput({ name: 'durationMin', max: 2400, value: init.durationMin });
  const minBlockIn = h('input', { type: 'number', name: 'minBlockMin', min: 15, max: 240, step: 15, value: init.minBlockMin,
    placeholder: `default (${state.settings?.defaultMinBlockMin ?? 30})` });
  const noWinCb = h('input', { type: 'checkbox', name: 'noWindow' });
  noWinCb.checked = init.noWindow;
  const winStart = timeInput({ name: 'windowStart', step: 900, value: init.windowStart, disabled: init.noWindow });
  const winEnd = timeInput({ name: 'windowEnd', step: 900, value: init.windowEnd, disabled: init.noWindow });
  const winSpan = h('span', { class: 'rec-window', hidden: init.noWindow }, winStart, winEnd);
  const prioSel = h('select', { name: 'priority' }, PRIORITIES.map((p) => {
    const o = h('option', { value: p }, p);
    if (p === init.priority) o.selected = true;
    return o;
  }));
  const startIn = dateInput({ name: 'startDate', required: true, value: init.startDate });
  const endIn = dateInput({ name: 'endDate', value: init.endDate });
  const dropCb = h('input', { type: 'checkbox', name: 'droppable' });
  dropCb.checked = init.droppable;
  const dropLabel = h('label', { class: 'inline', hidden: init.priority !== 'low' }, dropCb, 'May be dropped to meet a deadline');
  prioSel.addEventListener('change', () => { dropLabel.hidden = prioSel.value !== 'low'; });
  const activeCb = h('input', { type: 'checkbox', name: 'active' });
  activeCb.checked = init.active;

  freqSel.addEventListener('change', () => {
    weekdaysFs.hidden = freqSel.value !== 'weekly';
    domLabel.hidden = freqSel.value !== 'monthly';
  });
  noWinCb.addEventListener('change', () => {
    winSpan.hidden = noWinCb.checked;
    winStart.disabled = noWinCb.checked;
    winEnd.disabled = noWinCb.checked;
  });

  const cancelBtn = h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate('#/recurring') }, 'Cancel');
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');

  const form = h('form', { class: 'rec-editor' },
    h('h3', {}, isNew ? 'New recurring task' : 'Edit recurring task'),
    h('label', {}, 'Title', titleIn),
    h('label', {}, 'Project', projectSel),
    h('label', {}, 'Schedule', scheduleSel),
    h('label', {}, 'Frequency', freqSel),
    weekdaysFs,
    domLabel,
    h('label', {}, 'Duration (total per week if no weekdays)', durIn),
    h('label', {}, 'Minimum block (min, optional; shorter blocks are never made)', minBlockIn),
    h('label', { class: 'inline' }, noWinCb, 'No preferred window'),
    winSpan,
    h('label', {}, 'Priority', prioSel),
    h('label', {}, 'Start date', startIn),
    h('label', {}, 'End date (optional)', endIn),
    dropLabel,
    h('label', { class: 'inline' }, activeCb, 'Active'),
    errLine,
    h('div', { class: 'rec-actions' }, saveBtn, cancelBtn));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errLine.textContent = '';
    const days = dayBoxes.filter((cb) => cb.checked).map((cb) => Number(cb.value));
    const { error, body } = recurringBody({
      title: titleIn.value,
      projectId: projectSel.value,
      frequency: freqSel.value,
      daysOfWeek: days,
      dayOfMonth: domLabel.hidden ? '' : form.elements.dayOfMonth.value,
      durationMin: durIn.value,
      noWindow: noWinCb.checked,
      windowStart: winStart.value,
      windowEnd: winEnd.value,
      priority: prioSel.value,
      startDate: startIn.value,
      endDate: endIn.value,
      active: activeCb.checked,
      scheduleId: scheduleSel.value,
      minBlockMin: minBlockIn.value,
      droppable: dropCb.checked,
    });
    if (error) { errLine.textContent = error; return; }
    saveBtn.disabled = true;
    try {
      if (isNew) await mutate(() => api.createRecurring(body));
      else await mutate(() => api.updateRecurring(rec.id, body));
      toast('Saved');
      ctx.navigate('#/recurring');
    } catch (ex) {
      errLine.textContent = ex.message;
      saveBtn.disabled = false;
    }
  });

  host.appendChild(form);
}
