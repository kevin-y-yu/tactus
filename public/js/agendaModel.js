// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// PURE agenda grouping and filtering (spec §5.7, §10.4). No I/O, no clock, no randomness, no DOM.
import { utcToZoned, addDays } from '../shared/time.js';
import { fmtDate, todayIn } from './ui.js';

const byStart = (a, b) => Date.parse(a.start) - Date.parse(b.start) || a.blockId - b.blockId;

// agenda: §8.1 Agenda. now: epoch ms (A2). Returns [{key, label, rows}] per §10.4 grouping rules 1-4.
export function groupAgenda(agenda, { now, tz, showDone = false } = {}) {
  const today = todayIn(tz, now);
  const tomorrow = addDays(today, 1);
  const lastDate = agenda && agenda.horizonEnd ? utcToZoned(Date.parse(agenda.horizonEnd) - 1, tz).date : null;
  const afterHorizon = (d) => lastDate !== null && d > lastDate;
  const overdue = [];
  const byDate = new Map();
  const put = (d, r) => { if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(r); };
  for (const r of (agenda && agenda.rows) || []) {
    const d = utcToZoned(Date.parse(r.start), tz).date;
    if (r.completed || r.done) {
      if (!showDone || d < today || afterHorizon(d)) continue;
      put(d, r);
    } else if (r.missed || Date.parse(r.end) <= now) {
      if (r.kind === 'recurring' && d < today) continue;   // recurring skip rule (§9.10), block's local day
      overdue.push(r);
    } else {
      if (afterHorizon(d)) continue;
      put(d < today ? today : d, r);                       // in progress across midnight -> Today
    }
  }
  const groups = [];
  if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', rows: overdue.sort(byStart) });
  groups.push({ key: 'today', label: 'Today', rows: (byDate.get(today) || []).sort(byStart) });
  if (byDate.has(tomorrow)) groups.push({ key: 'tomorrow', label: 'Tomorrow', rows: byDate.get(tomorrow).sort(byStart) });
  for (const d of [...byDate.keys()].filter((x) => x > tomorrow).sort()) {
    groups.push({ key: d, label: fmtDate(d), rows: byDate.get(d).sort(byStart) });
  }
  const uns = (agenda && agenda.unscheduled) || [];
  if (uns.length) groups.push({ key: 'unscheduled', label: 'Unscheduled', rows: [...uns] });
  return groups;
}

// AND-combined client filters; input order preserved (§10.4 Filters, D6).
export function filterAgenda(rows, { projectId, priority, deadlineType, query } = {}) {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const hasProject = projectId !== undefined && projectId !== null && projectId !== '';
  return (rows || []).filter((r) => {
    if (hasProject && (projectId === 'none' ? r.projectId != null : String(r.projectId) !== String(projectId))) return false;
    if (priority && r.priority !== priority) return false;
    if (deadlineType === 'hard' || deadlineType === 'soft') {
      if (r.deadline == null || r.deadlineType !== deadlineType) return false;
    } else if (deadlineType === 'none') {
      if (r.deadline != null) return false;
    }
    if (q && !String(r.title || '').toLowerCase().includes(q)) return false;
    return true;
  });
}
