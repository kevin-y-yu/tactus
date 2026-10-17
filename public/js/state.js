// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Module-level store. Loads are serialized so a mutation's refresh never interleaves with a poll.
import * as api from './api.js';

export const state = {
  settings: null, projects: [], tasks: [], recurring: [], calendars: [], schedules: [], status: null,
  calendar: { from: null, to: null, blocks: [], events: [] },
  loadedAt: null,
};
const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function notify() { for (const fn of [...listeners]) { try { fn(state); } catch (e) { console.error(e); } } }
export function tz() { return (state.settings && state.settings.timezone) || 'UTC'; }

async function loadCalendarData() {
  const { from, to } = state.calendar;
  if (!from) return;
  const data = await api.getCalendarRange(from, to);
  if (state.calendar.from === from && state.calendar.to === to) {
    state.calendar.blocks = (data && data.blocks) || [];
    state.calendar.events = (data && data.events) || [];
  }
}
async function doLoad() {
  const [settings, projects, tasks, recurring, status, calendars, schedules] = await Promise.all([
    api.getSettings(), api.getProjects(), api.getTasks({ status: 'todo' }), api.getRecurring(), api.getStatus(), api.listCalendars(),
    api.listSchedules(),
  ]);
  Object.assign(state, { settings, projects: projects || [], tasks: tasks || [], recurring: recurring || [], status, calendars: calendars || [], schedules: schedules || [] });
  await loadCalendarData();
  state.loadedAt = Date.now();
  notify();
}
let chain = Promise.resolve();
export function loadAll() { const p = chain.then(doLoad, doLoad); chain = p.catch(() => {}); return p; }
export const refresh = loadAll;

// Sets the visible range (ISO strings) and loads it; same range -> keep data and reload.
export async function setCalendarRange(fromIso, toIso) {
  if (state.calendar.from !== fromIso || state.calendar.to !== toIso) {
    state.calendar = { from: fromIso, to: toIso, blocks: [], events: [] };
  }
  await loadCalendarData();
  notify();
}
export async function mutate(fn) { const result = await fn(); await refresh(); return result; }

// ===== chunk 11 additions (only chunk 11 edits this section) =====
// ===== end chunk 11 =====

// ===== chunk 12 additions (only chunk 12 edits this section) =====
// ===== end chunk 12 =====

// ===== chunk 13 additions (only chunk 13 edits this section) =====
// ===== end chunk 13 =====

// ===== chunk 14 additions (only chunk 14 edits this section) =====
// ===== end chunk 14 =====

// ===== v2 chunk 21 additions (only v2 chunk 21 edits this section) =====
// ===== end v2 chunk 21 =====

// ===== v2 chunk 22 additions (only v2 chunk 22 edits this section) =====
// ===== end v2 chunk 22 =====
