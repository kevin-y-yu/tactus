// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Agenda view (spec §10.4). Exported helpers are DOM-free; DOM, document and sessionStorage are touched only inside functions.
import { utcToZoned } from '../../shared/time.js';
import { groupAgenda, filterAgenda } from '../agendaModel.js';
import { h, clear, toast, openPopover, closePopover, fmtDate, fmtTime, fmtTimeRange, fmtDuration } from '../ui.js';
import { state, subscribe, mutate, tz } from '../state.js';
import * as api from '../api.js';
import { setNewTaskContext } from '../newTask.js';

const FILTER_KEY = 'tactus.agenda.filters';
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const DEADLINE_TYPES = [['any', 'Any deadline'], ['hard', 'Hard'], ['soft', 'Soft'], ['none', 'No deadline']];
const RISK_SUFFIX = { tight: 'tight', hard: 'at risk', soft: 'late' };
export const DEFAULT_FILTERS = Object.freeze({ projectId: '', priority: '', deadlineType: 'any', showDone: false, query: '' });

const localDate = (iso, tzName) => utcToZoned(Date.parse(iso), tzName).date;

// Stable identity of a row across refetches (scheduled rows by block id; unscheduled by owner).
export function rowKey(r) {
  return r.blockId != null ? `b${r.blockId}` : `u:${r.kind}:${r.taskId ?? ''}:${r.recurringId ?? ''}:${r.occurrenceDate ?? ''}`;
}

// D10 decision table.
export function checkAction(r) {
  if (r.completed) return 'untickPart';
  if (r.done) return r.kind === 'task' ? 'reopenTask' : 'undoOccurrence';
  if (r.kind === 'recurring') return 'doneOccurrence';
  if (r.blockId != null && r.partCount >= 2) return 'menu';
  return 'doneTask';
}

// D13. -> {cls, text} | null
export function deadlineBadge(r, tzName) {
  if (r.deadline == null) return null;
  const ms = Date.parse(r.deadline);
  let head = `Due ${fmtDate(utcToZoned(ms, tzName).date)} ${fmtTime(ms, tzName)}`;
  if (r.deadlineInherited) head += ' (from stage)';
  const parts = [head];
  if (RISK_SUFFIX[r.riskState]) parts.push(RISK_SUFFIX[r.riskState]);
  if (r.overdue) parts.push('overdue');
  const cls = r.deadlineType === 'hard' ? 'deadline-hard' : r.deadlineType === 'soft' ? 'deadline-soft' : 'deadline-none';
  return { cls, text: parts.join(' · ') };
}

// D12 time text.
export function timeText(r, groupKey, tzName) {
  if (r.blockId == null) return `unscheduled ${r.unscheduledMin} min`;
  const s = Date.parse(r.start), e = Date.parse(r.end);
  const range = `${fmtTimeRange(s, e, tzName)} · ${fmtDuration(Math.round((e - s) / 60000))}`;
  return groupKey === 'overdue' ? `${fmtDate(localDate(r.start, tzName))} ${range}` : range;
}

export function projectText(r) {
  return [r.projectName, r.stageName].filter((x) => x).join(' › ');
}

// D9: any stored value -> a valid filter object.
export function normalizeFilters(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    projectId: typeof o.projectId === 'string' ? o.projectId : '',
    priority: PRIORITIES.includes(o.priority) ? o.priority : '',
    deadlineType: DEADLINE_TYPES.some(([v]) => v === o.deadlineType) ? o.deadlineType : 'any',
    showDone: o.showDone === true,
    query: typeof o.query === 'string' ? o.query : '',
  };
}

export function filterOptions(f) {
  return { projectId: f.projectId || undefined, priority: f.priority || undefined,
           deadlineType: f.deadlineType === 'any' ? undefined : f.deadlineType, query: f.query };
}

// Filtered + grouped agenda for display.
export function visibleGroups(agenda, filters, now, tzName) {
  const o = filterOptions(filters);
  return groupAgenda({ ...agenda, rows: filterAgenda(agenda.rows, o), unscheduled: filterAgenda(agenda.unscheduled, o) },
                     { now, tz: tzName, showDone: filters.showDone });
}

function loadFilters() {
  try { return normalizeFilters(JSON.parse(sessionStorage.getItem(FILTER_KEY) || 'null')); } catch { return { ...DEFAULT_FILTERS }; }
}
function saveFilters(f) { try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* storage unavailable */ } }

export function render(container, route, ctx) {
  const view = { ctx, alive: true, agenda: null, error: null, filters: loadFilters(), selectedKey: null, flat: [],
                 busy: false, seq: 0, listEl: null, projectSel: null, projectSig: null };
  view.listEl = h('div', { class: 'agenda-groups' });
  container.append(h('section', { class: 'agenda' }, h('h2', { class: 'agenda-heading' }, 'Agenda'), buildFilters(view), view.listEl));
  const unsub = subscribe(() => load(view));
  const onKey = (e) => onKeydown(view, e);
  document.addEventListener('keydown', onKey);
  drawList(view);
  load(view);
  return () => { view.alive = false; unsub(); document.removeEventListener('keydown', onKey); closePopover(); };
}

async function load(view) {
  const seq = ++view.seq;
  try {
    const a = await api.getAgenda();
    if (!view.alive || seq !== view.seq) return;
    view.agenda = { now: a && a.now, today: a && a.today, horizonEnd: a && a.horizonEnd,
                    rows: (a && a.rows) || [], unscheduled: (a && a.unscheduled) || [] };
    view.error = null;
  } catch (e) {
    if (!view.alive || seq !== view.seq) return;
    view.error = e.message;
  }
  drawList(view);
}

// Filter bar, built once per mount (D9). Every change saves the filters and redraws the list only.
function buildFilters(view) {
  const f = view.filters;
  const changed = () => { saveFilters(view.filters); drawList(view); };
  view.projectSel = h('select', { class: 'agenda-filter', 'aria-label': 'Project', onchange: (e) => { view.filters.projectId = e.target.value; changed(); } });
  const prioritySel = h('select', { class: 'agenda-filter', 'aria-label': 'Priority',
    onchange: (e) => { f.priority = e.target.value; changed(); } },
    h('option', { value: '' }, 'Any priority'), ...PRIORITIES.map((p) => h('option', { value: p }, p)));
  prioritySel.value = f.priority;
  const deadlineSel = h('select', { class: 'agenda-filter', 'aria-label': 'Deadline type',
    onchange: (e) => { f.deadlineType = e.target.value; changed(); } },
    ...DEADLINE_TYPES.map(([v, label]) => h('option', { value: v }, label)));
  deadlineSel.value = f.deadlineType;
  const doneBox = h('input', { type: 'checkbox', class: 'agenda-filter', checked: f.showDone,
    onchange: (e) => { f.showDone = e.target.checked; changed(); } });
  const search = h('input', { type: 'search', class: 'agenda-filter', placeholder: 'Search', 'aria-label': 'Search',
    oninput: (e) => { f.query = e.target.value; changed(); } });
  search.value = f.query;
  return h('div', { class: 'agenda-filters' }, view.projectSel, prioritySel, deadlineSel,
    h('label', { class: 'agenda-showdone' }, doneBox, ' Show done'), search);
}

function fillProjectOptions(view) {
  const projects = state.projects || [];
  const sig = projects.map((p) => `${p.id}:${p.name}`).join('|');
  if (projects.length && view.filters.projectId && view.filters.projectId !== 'none' && !projects.some((p) => String(p.id) === view.filters.projectId)) {
    view.filters.projectId = ''; saveFilters(view.filters);
  }
  if (sig !== view.projectSig) {
    view.projectSig = sig;
    clear(view.projectSel);
    view.projectSel.append(h('option', { value: '' }, 'All projects'), h('option', { value: 'none' }, 'No project'), ...projects.map((p) => h('option', { value: String(p.id) }, p.name)));
  }
  view.projectSel.value = view.filters.projectId;
  setNewTaskContext(view.filters.projectId && view.filters.projectId !== 'none' ? { projectId: Number(view.filters.projectId) } : null);
}

function drawList(view) {
  if (!view.alive) return;
  fillProjectOptions(view);
  const list = view.listEl;
  clear(list);
  view.flat = [];
  if (!view.agenda) {
    list.append(view.error ? h('p', { class: 'agenda-error' }, `Could not load agenda: ${view.error}`)
                           : h('p', { class: 'agenda-loading' }, 'Loading…'));
    return;
  }
  if (view.error) list.append(h('p', { class: 'agenda-error' }, `Could not refresh agenda: ${view.error}`));
  const tzName = tz();
  for (const g of visibleGroups(view.agenda, view.filters, Date.now(), tzName)) {
    const items = g.rows.map((r) => { view.flat.push(r); return rowEl(view, r, g.key, tzName); });
    list.append(h('section', { class: 'agenda-group', dataset: { group: g.key } },
      h('h3', { class: 'agenda-group-head' }, g.label),
      items.length ? h('ul', { class: 'agenda-list' }, items) : h('p', { class: 'agenda-empty' }, 'Nothing scheduled')));
  }
  if (view.selectedKey && !view.flat.some((r) => rowKey(r) === view.selectedKey)) view.selectedKey = null;
  markSelected(view, false);
}

function rowEl(view, r, groupKey, tzName) {
  const checked = !!(r.completed || r.done);
  const cb = h('input', { type: 'checkbox', class: 'agenda-check', 'aria-label': 'Done', checked,
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); cb.blur(); toggleRow(view, r, cb); } });
  const badge = deadlineBadge(r, tzName);
  const proj = projectText(r);
  const actions = [];
  if (r.blockId != null) actions.push(actionBtn('Show in calendar', () => view.ctx.navigate(`#/day/${localDate(r.start, tzName)}?block=${r.blockId}`)));
  if (r.blockId != null && r.kind === 'task' && groupKey === 'overdue') actions.push(actionBtn("Didn't do it", () => run(view, () => api.deleteBlock(r.blockId))));
  return h('li', { class: 'agenda-row' + (checked ? ' is-done' : '') + (groupKey === 'overdue' ? ' is-missed' : ''),
                   dataset: { key: rowKey(r) }, onclick: () => openRow(view, r) },
    cb,
    h('div', { class: 'agenda-main' },
      h('div', { class: 'agenda-line1' },
        h('span', { class: 'agenda-title' }, r.title),
        r.partCount >= 2 ? h('span', { class: 'agenda-part' }, `part ${r.partIndex} of ${r.partCount}`) : null,
        r.pinned ? h('span', { class: 'badge badge-pin' }, 'PIN') : null),
      h('div', { class: 'agenda-line2' },
        h('span', { class: 'agenda-time' }, timeText(r, groupKey, tzName)),
        proj ? h('span', { class: 'agenda-project' }, h('span', { class: 'agenda-dot', style: { background: r.projectColor || '#8e7cc3' } }), proj) : null,
        r.priority ? h('span', { class: `agenda-chip prio-${r.priority}` }, r.priority) : null,
        badge ? h('span', { class: `agenda-deadline ${badge.cls}` }, badge.text) : null)),
    actions.length ? h('div', { class: 'agenda-actions' }, actions) : null);
}

function actionBtn(label, fn) {
  return h('button', { class: 'btn agenda-btn', type: 'button', onclick: (e) => { e.stopPropagation(); fn(); } }, label);
}

function openRow(view, r) {
  if (r.kind === 'task') view.ctx.navigate('#/task/' + r.taskId);
  else view.ctx.navigate('#/recurring');
}

// One mutation at a time per view (D11).
async function run(view, fn) {
  if (view.busy) return;
  view.busy = true;
  try { await mutate(fn); closePopover(); }
  catch (e) { toast(e.message, 'error'); if (view.alive) load(view); }
  finally { view.busy = false; }
}

function toggleRow(view, r, anchor) {
  switch (checkAction(r)) {
    case 'menu':
      if (view.busy) return;
      openPopover(anchor, h('div', { class: 'popover-body' }, h('h3', {}, r.title), h('p', {}, `Part ${r.partIndex} of ${r.partCount}`),
        h('div', { class: 'popover-actions' },
          actionBtn('Whole task done', () => run(view, () => api.updateTask(r.taskId, { status: 'done' }))),
          actionBtn('This part only', () => run(view, () => api.updateBlock(r.blockId, { completed: true }))))));
      return;
    case 'doneTask': return run(view, () => api.updateTask(r.taskId, { status: 'done' }));
    case 'doneOccurrence': return run(view, () => api.markOccurrenceDone(r.recurringId, r.occurrenceDate));
    case 'untickPart': return run(view, () => api.updateBlock(r.blockId, { completed: false }));
    case 'reopenTask': return run(view, () => api.updateTask(r.taskId, { status: 'todo' }));
    case 'undoOccurrence': return run(view, () => api.unmarkOccurrenceDone(r.recurringId, r.occurrenceDate));
  }
}

function rowNodes(view) { return [...view.listEl.querySelectorAll('.agenda-row')]; }

function markSelected(view, scroll) {
  for (const node of rowNodes(view)) node.classList.toggle('selected', node.dataset.key === view.selectedKey);
  if (scroll) {
    const sel = rowNodes(view).find((node) => node.dataset.key === view.selectedKey);
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
}

// Keyboard (D15): j/k move, x toggles, Enter opens. Ignored while typing or while a popover/modal is open.
function onKeydown(view, e) {
  if (!view.alive || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!['j', 'k', 'x', 'Enter'].includes(e.key)) return;
  const a = document.activeElement;
  const tag = a ? a.tagName : '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (a && a.isContentEditable)) return;
  if (document.querySelector('.popover, .modal, .modal-backdrop, [aria-modal="true"]')) return;
  const n = view.flat.length;
  if (!n) return;
  const idx = view.flat.findIndex((r) => rowKey(r) === view.selectedKey);
  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    const next = idx === -1 ? 0 : e.key === 'j' ? Math.min(idx + 1, n - 1) : Math.max(idx - 1, 0);
    view.selectedKey = rowKey(view.flat[next]);
    markSelected(view, true);
    return;
  }
  if (idx === -1) return;
  const r = view.flat[idx];
  if (e.key === 'x') {
    e.preventDefault();
    const node = rowNodes(view).find((el) => el.dataset.key === view.selectedKey);
    toggleRow(view, r, (node && node.querySelector('.agenda-check')) || node || view.listEl);
    return;
  }
  // Enter on a focused control inside the list (row action buttons) is the browser's. A control elsewhere, e.g. the
  // nav link just clicked to reach this view, keeps focus and must not swallow Enter.
  if ((tag === 'BUTTON' || tag === 'A') && view.listEl && view.listEl.contains(a)) return;
  e.preventDefault();
  openRow(view, r);
}
