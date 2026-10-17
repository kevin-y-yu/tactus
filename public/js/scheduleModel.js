// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Pure schedule helpers (v2 §R6 UI; AC-ARCH rule 2: no I/O, no clock, no DOM). v2 chunk 22.
// Exports: DEFAULT_COLOR, sortSchedules, defaultSchedule, scheduleIdFromValue, scheduleValue, scheduleOptions,
// scheduleUsage, timeOptions, startTimeOptions, endTimeOptions, cloneHours, copyToWeekdays, nextScheduleName,
// nextRange, normalizeHours, hoursError, scheduleCardActions, deleteScheduleMessage.

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS = ['0', '1', '2', '3', '4', '5', '6'];

export const DEFAULT_COLOR = '#1a73e8';

// Default first, then by id. Returns a new array.
export function sortSchedules(schedules) {
  return [...(schedules || [])].sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || a.id - b.id);
}
export function defaultSchedule(schedules) { return (schedules || []).find((s) => s.isDefault) || null; }

// '' | null | undefined -> null; else Number(v).
export function scheduleIdFromValue(v) { return v === '' || v === null || v === undefined ? null : Number(v); }
// null/undefined -> ''; else String(id).
export function scheduleValue(id) { return id === null || id === undefined ? '' : String(id); }

// project: the selected Project or null. -> [{value, label}]: inherit option first, then each schedule (sortSchedules order).
export function scheduleOptions(schedules, project = null) {
  const list = sortSchedules(schedules);
  const projSched = project && project.scheduleId != null ? list.find((s) => s.id === project.scheduleId) : null;
  const def = defaultSchedule(list);
  const first = projSched ? `Project default (${projSched.name})` : def ? `Default (${def.name})` : 'Default';
  return [{ value: '', label: first }, ...list.map((s) => ({ value: String(s.id), label: s.name }))];
}

// Counts what uses schedule `id`: todo tasks (status === 'todo'), projects, recurring rules with scheduleId === id.
export function scheduleUsage(id, { tasks = [], projects = [], recurring = [] } = {}) {
  return {
    tasks: tasks.filter((t) => t.status === 'todo' && t.scheduleId === id).length,
    projects: projects.filter((p) => p.scheduleId === id).length,
    recurring: recurring.filter((r) => r.scheduleId === id).length,
  };
}

// 97 strings '00:00','00:15',…,'23:45','24:00'.
export function timeOptions() {
  return Array.from({ length: 97 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);
}
export const startTimeOptions = () => timeOptions().slice(0, 96);   // '00:00'…'23:45'
export const endTimeOptions = () => timeOptions().slice(1);         // '00:15'…'24:00'

// Deep copy with all keys '0'..'6' present (missing -> []); ranges copied as new [s, e] arrays.
export function cloneHours(hours) {
  const out = {};
  for (const d of DAYS) out[d] = ((hours && hours[d]) || []).map((r) => [r[0], r[1]]);
  return out;
}

// New hours object: keys '1'..'5' = copies of hours[day]'s ranges; other keys copied unchanged. Input not mutated. day: number|string.
export function copyToWeekdays(hours, day) {
  const out = cloneHours(hours);
  const src = out[String(day)];
  for (const d of ['1', '2', '3', '4', '5']) out[d] = src.map((r) => [r[0], r[1]]);
  return out;
}

// 'New schedule' if no existing name equals it case-insensitively (after trim); else 'New schedule 2', ' 3', … first free.
export function nextScheduleName(schedules) {
  const taken = new Set((schedules || []).map((s) => String(s.name).trim().toLowerCase()));
  const base = 'New schedule';
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function fromMin(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// D14. ranges: [[s,e],…] -> [s, e]
export function nextRange(ranges) {
  if (!ranges || ranges.length === 0) return ['09:00', '17:00'];
  const endMin = toMin(ranges[ranges.length - 1][1]);
  if (endMin >= 24 * 60) return ['23:00', '24:00'];
  return [fromMin(endMin), fromMin(Math.min(endMin + 60, 24 * 60))];
}

// cloneHours + each day sorted by start (string compare; '24:00' never a start).
export function normalizeHours(hours) {
  const out = cloneHours(hours);
  for (const d of DAYS) out[d].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

// First problem or null. Days checked in weekdayOrder(weekStartsOn) order (0 -> Sun first, else Mon..Sun).
// Per day, on the normalized ranges: s >= e -> `${DAY_SHORT[d]}: each range must start before it ends.`
// a range starting before the previous one's end -> `${DAY_SHORT[d]}: ranges overlap.`
export function hoursError(hours, weekStartsOn) {
  const order = weekStartsOn === 0 ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
  const norm = normalizeHours(hours);
  for (const d of order) {
    const ranges = norm[String(d)];
    for (let i = 0; i < ranges.length; i++) {
      if (toMin(ranges[i][0]) >= toMin(ranges[i][1])) return `${DAY_SHORT[d]}: each range must start before it ends.`;
      if (i > 0 && toMin(ranges[i][0]) < toMin(ranges[i - 1][1])) return `${DAY_SHORT[d]}: ranges overlap.`;
    }
  }
  return null;
}

export function scheduleCardActions(schedule) {
  return { canEditName: true, canEditColor: true, canEditHours: true,
    canDelete: !schedule.isDefault, canMakeDefault: !schedule.isDefault };
}

// usage from scheduleUsage. total 0 -> `Delete schedule "${name}"? Nothing uses it.`
// else -> `Delete schedule "${name}"? ${n(tasks,'todo task')}, ${n(projects,'project')} and ${n(recurring,'recurring item')} use it; they will move to the default schedule "${defaultName}".`
// where n(1,'project') = '1 project', n(k,'project') = `${k} projects` (k ≠ 1).
export function deleteScheduleMessage(name, usage, defaultName) {
  const total = usage.tasks + usage.projects + usage.recurring;
  if (total === 0) return `Delete schedule "${name}"? Nothing uses it.`;
  const n = (k, word) => (k === 1 ? `1 ${word}` : `${k} ${word}s`);
  return `Delete schedule "${name}"? ${n(usage.tasks, 'todo task')}, ${n(usage.projects, 'project')} and ${n(usage.recurring, 'recurring item')} use it; they will move to the default schedule "${defaultName}".`;
}
