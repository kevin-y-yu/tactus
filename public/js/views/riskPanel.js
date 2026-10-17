// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Risk panel (mounted into #risk-panel by app.js). Chunk 14.
// Pure helpers (DOM-free, verified in Node): RISK_GROUPS, fmtInstant, lastScheduledText, riskGroups.
// render(container, route, ctx) -> cleanup. Redraws on every state notify.
import { h, clear, fmtDate, fmtTime } from '../ui.js';
import { state, subscribe, tz } from '../state.js';
import { utcToZoned } from '../../shared/time.js';

export const RISK_GROUPS = [
  ['hard', 'Hard deadline at risk'],
  ['soft', 'Past soft deadline'],
  ['unscheduled', 'Unscheduled in horizon'],
  ['tight', 'Tight (within safety margin)'],
];

export function fmtInstant(iso, tzName) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) return null;
  return `${fmtDate(utcToZoned(ms, tzName).date)} ${fmtTime(ms, tzName)}`;
}

export function lastScheduledText(status, tzName) {
  const ms = status && typeof status.ranAt === 'string' ? Date.parse(status.ranAt) : NaN;
  return Number.isNaN(ms) ? 'Last scheduled —' : `Last scheduled ${fmtTime(ms, tzName)}`;
}

// -> [{kind, title, items:[{key, title, deadline, plannedEnd, overdue, href}]}], non-empty groups only, RISK_GROUPS order.
export function riskGroups(status, tasks, recurring) {
  if (!status) return [];
  const taskTitle = (id) => { const t = (tasks || []).find((x) => x.id === id); return t ? t.title : `Task #${id}`; };
  const recTitle = (id) => { const r = (recurring || []).find((x) => x.id === id); return r ? r.title : `Recurring #${id}`; };
  const taskOverdue = (id) => { const s = (status.tasks || []).find((x) => x.taskId === id); return !!(s && s.overdue); };
  const fromAtRisk = (a) => (a.taskId != null
    ? { key: `t${a.taskId}-${a.kind}`, title: taskTitle(a.taskId), deadline: a.deadline, plannedEnd: a.plannedEnd,
        overdue: !!a.overdue, href: `#/task/${a.taskId}` }
    : { key: `r${a.recurringId}-${a.occurrenceDate}`, title: `${recTitle(a.recurringId)} (${fmtDate(a.occurrenceDate)})`,
        deadline: a.deadline, plannedEnd: a.plannedEnd, overdue: !!a.overdue, href: `#/recurring?edit=${a.recurringId}` });
  const fromTight = (t) => ({ key: `t${t.taskId}-tight`, title: taskTitle(t.taskId), deadline: t.deadline,
    plannedEnd: t.plannedEnd, overdue: taskOverdue(t.taskId), href: `#/task/${t.taskId}` });
  return RISK_GROUPS
    .map(([kind, title]) => ({ kind, title, items: kind === 'tight'
      ? (status.tight || []).map(fromTight)
      : (status.atRisk || []).filter((a) => a.kind === kind).map(fromAtRisk) }))
    .filter((g) => g.items.length > 0);
}

export function render(container, route, ctx) {
  const draw = () => {
    clear(container);
    const tzName = tz();
    const groups = riskGroups(state.status, state.tasks, state.recurring);
    const children = [h('h2', { class: 'rp-title' }, 'Risks')];
    for (const g of groups) {
      children.push(h('section', { class: 'rp-group' },
        h('h3', {}, g.title),
        g.items.map((item) => h('a', { class: 'rp-item', href: item.href },
          h('div', { class: 'rp-item-title' }, item.title, item.overdue ? h('span', { class: 'rp-overdue' }, 'overdue') : null),
          h('div', { class: 'rp-item-meta' },
            `Deadline ${fmtInstant(item.deadline, tzName) ?? 'none'} · Planned end ${fmtInstant(item.plannedEnd, tzName) ?? 'not planned'}`)))));
    }
    if (groups.length === 0) children.push(h('p', { class: 'rp-empty' }, 'All on track'));
    children.push(h('div', { class: 'rp-footer' }, lastScheduledText(state.status, tzName)));
    container.appendChild(h('div', { class: 'rp' }, children));
  };
  draw();
  const unsub = subscribe(draw);
  return () => { unsub(); };
}
