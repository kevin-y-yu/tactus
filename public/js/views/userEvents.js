// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Tactus-only events: '+ Event' form, title prompt after drag-create, edit/delete popover.
import { h, toast, openPopover, closePopover, fmtDate, fmtTimeRange } from '../ui.js';
import { mutate, tz } from '../state.js';
import * as api from '../api.js';
import { dateInput } from '../datePicker.js';
import { timeInput } from '../timeInput.js';
import { userEventBody, userEventFormValues, defaultNewEventValues, userEventDbId } from '../userEventModel.js';
import { utcToZoned } from '../../shared/time.js';

// Title/Date/Start/End form. onSubmit(body) runs the API call; errors (validation or HTTP) are toasts.
function eventForm(values, submitLabel, onSubmit) {
  const titleIn = h('input', { type: 'text', required: true, maxlength: 200, value: values.title, 'aria-label': 'Title' });
  const dateIn = dateInput({ value: values.date, required: true });
  const startIn = timeInput({ value: values.start, step: '900', required: true, 'aria-label': 'Start' });
  const endIn = timeInput({ value: values.end, step: '900', required: true, 'aria-label': 'End' });
  const form = h('form', { class: 'move-form user-event-form', onsubmit: async (e) => {
    e.preventDefault();
    let body;
    try { body = userEventBody({ title: titleIn.value, date: dateIn.value, start: startIn.value, end: endIn.value }, tz()); }
    catch (err) { toast(err.message, 'error'); return; }
    try { await mutate(() => onSubmit(body)); closePopover(); } catch (err) { toast(err.message, 'error'); }
  } },
    h('label', {}, 'Title ', titleIn), h('label', {}, 'Date ', dateIn),
    h('label', {}, 'Start ', startIn), h('label', {}, 'End ', endIn),
    h('button', { class: 'btn btn-primary', type: 'submit' }, submitLabel));
  return { form, titleIn };
}

export function openNewUserEvent(anchorEl) {
  const { form, titleIn } = eventForm(defaultNewEventValues(Date.now(), tz()), 'Add event', (body) => api.createUserEvent(body));
  openPopover(anchorEl, h('div', { class: 'popover-body' }, h('h3', {}, 'New event'), form));
  titleIn.focus();
}

export function openUserEventPopover(anchorEl, ev) {
  const id = userEventDbId(ev);
  const { form, titleIn } = eventForm(userEventFormValues(ev, tz()), 'Save', (body) => api.updateUserEvent(id, body));
  const del = h('button', { class: 'btn', type: 'button', onclick: async () => {
    try { await mutate(() => api.deleteUserEvent(id)); closePopover(); } catch (err) { toast(err.message, 'error'); }
  } }, 'Delete event');
  openPopover(anchorEl, h('div', { class: 'popover-body' }, h('h3', {}, 'Event'), form, h('div', { class: 'popover-actions' }, del)));
  titleIn.focus();
}

// After drag-create: ask only for the title. Enter saves; Esc or an outside click cancels; onClose always runs.
export function promptUserEventTitle(anchorEl, start, end, onClose) {
  const tzName = tz();
  const titleIn = h('input', { type: 'text', required: true, maxlength: 200, placeholder: 'Event title', 'aria-label': 'Event title' });
  const form = h('form', { class: 'move-form user-event-form', onsubmit: async (e) => {
    e.preventDefault();
    const title = titleIn.value.trim();
    if (!title) { toast('Enter a title', 'error'); return; }
    try {
      await mutate(() => api.createUserEvent({ title, start: new Date(start).toISOString(), end: new Date(end).toISOString() }));
      closePopover();
    } catch (err) { toast(err.message, 'error'); }
  } }, titleIn, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add event'));
  openPopover(anchorEl, h('div', { class: 'popover-body' },
    h('h3', {}, 'New event'),
    h('p', {}, `${fmtDate(utcToZoned(start, tzName).date)} ${fmtTimeRange(start, end, tzName)}`), form), onClose);
  titleIn.focus();
}
