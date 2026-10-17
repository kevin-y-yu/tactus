// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Settings section "Calendars" (#/settings/calendars): intro, calendar table or empty state, guided "Link a calendar" panel (v2 chunk 24, R7), calendar options.
import { h, clear, toast } from '../../ui.js';
import { state, subscribe, mutate, tz } from '../../state.js';
import * as api from '../../api.js';
import { fmtInstant } from '../riskPanel.js';
import { NUMBER_FIELDS } from '../../settingsModel.js';
import { PROVIDERS, calendarUrlHint, addResultMessage } from '../../calendarUrlHint.js';
import { gridRow, numberInput, settingsCard, whenSettings } from './form.js';

export function render(host, ctx) {
  const intro = h('p', { class: 'cal-intro' }, 'Tactus reads your calendars so it never schedules over your meetings. It never changes them.');
  const listHost = h('div');
  const panel = linkPanel();
  const optionsHost = h('div');
  host.append(intro, listHost, panel.el, optionsHost);
  const draw = () => {
    clear(listHost);
    const cals = state.calendars || [];
    if (cals.length === 0) {
      listHost.appendChild(h('section', { class: 'card cal-empty' },
        h('p', {}, 'No calendars linked yet.'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
          panel.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          panel.focusFirstTab();
        } }, 'Link a calendar')));
      return;
    }
    listHost.appendChild(h('section', { class: 'card' }, h('h3', {}, 'Your calendars'),
      h('div', { class: 'table-scroll' },
        h('table', { class: 'cal-table' },
          h('thead', {}, h('tr', {},
            h('th', {}, 'Color'), h('th', {}, 'Name'), h('th', {}, 'URL'), h('th', {}, 'Enabled'),
            h('th', {}, 'Blocking'), h('th', {}, 'Last fetched'), h('th', {}, 'Error'), h('th', {}, 'Events'), h('th', {}, 'Actions'))),
          h('tbody', {}, cals.map(calendarRow))))));
  };
  draw();
  const unsubTable = subscribe(draw);
  const unsubOptions = whenSettings(optionsHost, (rebuild) => {
    const s = state.settings;
    const allDay = h('input', { type: 'checkbox', name: 'allDayEventsBlock' });
    allDay.checked = !!s.allDayEventsBlock;
    const f = NUMBER_FIELDS.find((x) => x.key === 'icsRefreshMinutes');
    const refreshIn = numberInput(f, s.icsRefreshMinutes);
    optionsHost.appendChild(settingsCard({
      title: 'Calendar options',
      rows: [gridRow('All-day events block time', allDay), gridRow(f.label, refreshIn, { hint: f.hint || null })],
      collect: () => ({ allDayEventsBlock: allDay.checked, icsRefreshMinutes: Number(refreshIn.value) }),
      onSaved: rebuild,
    }));
  });
  return () => { unsubTable(); unsubOptions(); };
}

function calendarRow(cal) {
  const toggle = (field, label) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!cal[field];
    cb.addEventListener('change', async () => {
      const want = cb.checked;
      try {
        await mutate(() => api.updateCalendar(cal.id, { [field]: want }));
      } catch (e) {
        cb.checked = !want;
        toast(e.message, 'error');
      }
    });
    return h('label', { class: 'inline' }, cb, label);
  };
  const action = (label, fn) => h('button', { class: 'btn', type: 'button', onclick: async () => {
    try { await fn(); } catch (e) { toast(e.message, 'error'); }
  } }, label);
  return h('tr', {},
    h('td', {}, h('span', { class: 'cal-swatch', style: { background: cal.color } })),
    h('td', {}, cal.name),
    h('td', {}, cal.urlRedacted),
    h('td', {}, toggle('enabled', '')),
    h('td', {}, toggle('blocking', '')),
    h('td', {}, fmtInstant(cal.lastFetchedAt, tz()) ?? 'never'),
    h('td', {}, h('span', { class: 'cal-error' }, cal.lastError || '')),
    h('td', {}, String(cal.eventCount ?? 0)),
    h('td', { class: 'cal-actions' },
      action('Refresh', () => mutate(() => api.refreshCalendar(cal.id))),
      action('Replace URL', async () => {
        const url = prompt('New calendar URL');
        if (!url || !url.trim()) return;
        await mutate(() => api.updateCalendar(cal.id, { url: url.trim() }));
      }),
      action('Delete', async () => {
        if (!confirm(`Delete calendar "${cal.name}"?`)) return;
        await mutate(() => api.deleteCalendar(cal.id));
      })));
}

// Built once; always visible. Returns { el, focusFirstTab }.
function linkPanel() {
  let provider = 'google';
  let busy = false;
  let retryId = null;
  let retryName = '';

  const errLine = h('p', { class: 'form-error' });
  const urlIn = h('input', { type: 'text', name: 'url', placeholder: 'https://… or webcal://…', autocomplete: 'off', spellcheck: 'false' });
  const hintEl = h('div', { class: 'cal-hint', 'aria-live': 'polite' });
  const urlRow = gridRow('Calendar link', urlIn);
  urlRow[1].appendChild(hintEl);
  const nameIn = h('input', { type: 'text', name: 'name', maxlength: 100 });
  const colorIn = h('input', { type: 'color', name: 'color', value: '#9aa0a6' });
  const blockIn = h('input', { type: 'checkbox', name: 'blocking' });
  blockIn.checked = true;
  const addBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add calendar');
  const retryLine = h('p', { class: 'hint cal-retry-line' });
  const resultEl = h('div', { class: 'cal-result', 'aria-live': 'polite' });

  const tabs = h('div', { class: 'cal-tabs', role: 'tablist' },
    PROVIDERS.map((p) => h('button', { type: 'button', class: 'cal-tab', role: 'tab', dataset: { provider: p.key }, onclick: () => selectProvider(p.key) }, p.label)));
  const stepsList = h('ol', { class: 'cal-steps' });
  const form = h('form', { class: 'cal-add-form' },
    h('div', { class: 'form-grid' },
      urlRow,
      gridRow('Name', nameIn, { hint: 'Leave blank to use the provider name.' }),
      gridRow('Colour', colorIn),
      gridRow('Block my time', blockIn, { hint: 'When on, Tactus will not schedule tasks over these events.' })),
    errLine,
    h('div', { class: 'form-actions' }, addBtn));

  const card = h('section', { class: 'card cal-link' },
    h('h3', {}, 'Link a calendar'),
    h('h4', { class: 'cal-step-title' }, '1. Pick your calendar provider'),
    tabs,
    h('h4', { class: 'cal-step-title' }, '2. Get the link'),
    stepsList,
    h('h4', { class: 'cal-step-title' }, '3. Paste the link'),
    retryLine,
    form,
    resultEl);

  const hint = () => calendarUrlHint(urlIn.value, provider);
  function refreshHint() {
    const r = hint();
    hintEl.className = `cal-hint cal-hint-${r.level}`;
    hintEl.textContent = r.message;
    addBtn.disabled = busy || r.level === 'none' || r.level === 'error';
  }
  function selectProvider(key) {
    provider = key;
    for (const t of tabs.children) {
      const on = t.dataset.provider === key;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    clear(stepsList);
    PROVIDERS.find((p) => p.key === key).steps.forEach((s) => stepsList.appendChild(h('li', {}, s)));
    refreshHint();
  }
  function setRetry(cal) {            // cal null -> leave retry mode
    retryId = cal ? cal.id : null;
    retryName = cal ? cal.name : '';
    nameIn.disabled = colorIn.disabled = blockIn.disabled = !!cal;
    retryLine.textContent = cal ? `Paste a new link for "${cal.name}".` : '';
    addBtn.textContent = cal ? 'Update link' : 'Add calendar';
  }
  function showResult(cal) {
    urlIn.value = '';                 // D13: never keep/render the pasted URL once the server has it
    const r = addResultMessage(cal);
    clear(resultEl);
    resultEl.className = `cal-result cal-result-${r.level}`;
    resultEl.append(h('p', { class: 'cal-result-text' }, r.text),
      h('p', { class: 'hint' }, `${cal.name} · ${cal.urlRedacted}`));
    if (r.level === 'error') {
      setRetry(cal);
      resultEl.appendChild(h('div', { class: 'form-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => { urlIn.focus(); } }, 'Try another link'),
        h('button', { class: 'btn', type: 'button', onclick: removePending }, 'Remove')));
    } else {
      setRetry(null);
      nameIn.value = ''; blockIn.checked = true;
    }
    refreshHint();
  }
  function clearResult() { clear(resultEl); resultEl.className = 'cal-result'; }
  async function removePending() {
    if (retryId === null) return;
    try {
      await mutate(() => api.deleteCalendar(retryId));
      setRetry(null); clearResult(); refreshHint();
      toast('Calendar removed');
    } catch (e) { toast(e.message, 'error'); }
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = hint();
    if (busy || r.level === 'none' || r.level === 'error') return;
    errLine.textContent = '';
    busy = true;
    const label = addBtn.textContent;
    addBtn.textContent = 'Checking the link…';
    addBtn.disabled = true;
    const url = urlIn.value.trim();
    try {
      let cal;
      if (retryId !== null) {
        cal = await mutate(() => api.updateCalendar(retryId, { url }));
      } else {
        const meta = PROVIDERS.find((p) => p.key === provider);
        cal = await mutate(() => api.createCalendar({ name: nameIn.value.trim() || meta.label, url, color: colorIn.value }));
        if (!blockIn.checked) {
          try { cal = await mutate(() => api.updateCalendar(cal.id, { blocking: false })); }
          catch (ex2) { toast(`Linked, but couldn't turn off Block my time: ${ex2.message}`, 'error'); }
        }
      }
      busy = false;
      showResult(cal);                 // sets the button label for the new mode
    } catch (ex) {
      busy = false;
      addBtn.textContent = label;
      if (retryId !== null && ex.status === 404) { setRetry(null); clearResult(); }
      errLine.textContent = ex.message;
      refreshHint();
    }
  });
  urlIn.addEventListener('input', refreshHint);
  selectProvider('google');
  return { el: card, focusFirstTab: () => tabs.firstElementChild.focus() };
}
