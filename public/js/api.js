// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// The only module that calls fetch(). Every path is relative to api/ (AC-ARCH 4).
export class ApiError extends Error {
  constructor(status, message) { super(message); this.name = 'ApiError'; this.status = status; }
}
let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) { unauthorizedHandler = fn; }

// path is relative to api/, e.g. 'tasks/3'. Never starts with '/' or a scheme.
export async function request(method, path, body) {
  if (typeof path !== 'string' || path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new Error(`api path must be relative: ${path}`);
  }
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(`api/${path}`, init);
  if (res.status === 401 && !path.startsWith('auth/') && unauthorizedHandler) unauthorizedHandler();
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) throw new ApiError(res.status, data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
  return data;
}

const enc = encodeURIComponent;
function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---- auth / settings ----
export const getAuthStatus = () => request('GET', 'auth/status');
export const login = (password) => request('POST', 'auth/login', { password });
export const logout = () => request('POST', 'auth/logout');
export const getSettings = () => request('GET', 'settings');
export const putSettings = (partial) => request('PUT', 'settings', partial);

// ---- projects / stages ----
export const getProjects = () => request('GET', 'projects');
export const createProject = (body) => request('POST', 'projects', body);
export const updateProject = (id, body) => request('PATCH', `projects/${enc(id)}`, body);
export const deleteProject = (id) => request('DELETE', `projects/${enc(id)}`);
export const createStage = (projectId, body) => request('POST', `projects/${enc(projectId)}/stages`, body);
export const reorderStages = (projectId, stageIds) => request('POST', `projects/${enc(projectId)}/stages/reorder`, { stageIds });
export const updateStage = (id, body) => request('PATCH', `stages/${enc(id)}`, body);
export const deleteStage = (id) => request('DELETE', `stages/${enc(id)}`);

// ---- tasks ----
export const getTasks = ({ projectId, status } = {}) => request('GET', `tasks${qs({ projectId, status })}`);
export const getTask = (id) => request('GET', `tasks/${enc(id)}`);
export const createTask = (body) => request('POST', 'tasks', body);
export const updateTask = (id, body) => request('PATCH', `tasks/${enc(id)}`, body);
export const deleteTask = (id) => request('DELETE', `tasks/${enc(id)}`);
export const undo = () => request('POST', 'undo');
export const resetTaskProgress = (id) => request('POST', `tasks/${enc(id)}/reset-progress`);

// ---- recurring ----
export const getRecurring = () => request('GET', 'recurring');
export const createRecurring = (body) => request('POST', 'recurring', body);
export const updateRecurring = (id, body) => request('PATCH', `recurring/${enc(id)}`, body);
export const deleteRecurring = (id) => request('DELETE', `recurring/${enc(id)}`);
export const markOccurrenceDone = (id, date) => request('POST', `recurring/${enc(id)}/occurrences/${enc(date)}/done`);
export const unmarkOccurrenceDone = (id, date) => request('DELETE', `recurring/${enc(id)}/occurrences/${enc(date)}/done`);

// ---- calendar / agenda / status / schedule ----
export const getCalendarRange = (fromIso, toIso) => request('GET', `calendar${qs({ from: fromIso, to: toIso })}`);
export const getAgenda = () => request('GET', 'agenda');
export const getStatus = () => request('GET', 'status');
export const runSchedule = () => request('POST', 'schedule/run');

// ---- blocks ----
export const createBlock = (body) => request('POST', 'blocks', body);
export const updateBlock = (id, body) => request('PATCH', `blocks/${enc(id)}`, body);
export const partialDoneBlock = (id, minutes) => request('POST', `blocks/${enc(id)}/partial-done`, { minutes });
export const moveLunch = (date, body) => request('PUT', `lunch/${enc(date)}`, body);
export const deleteBlock = (id) => request('DELETE', `blocks/${enc(id)}`);

// ---- external calendars ----
export const listCalendars = () => request('GET', 'calendars');
export const createCalendar = (body) => request('POST', 'calendars', body);
export const updateCalendar = (id, body) => request('PATCH', `calendars/${enc(id)}`, body);
export const deleteCalendar = (id) => request('DELETE', `calendars/${enc(id)}`);
export const refreshAllCalendars = () => request('POST', 'calendars/refresh');
export const refreshCalendar = (id) => request('POST', `calendars/${enc(id)}/refresh`);

// ===== v2 chunk 21 additions (only v2 chunk 21 edits this section) =====
export const listSchedules = () => request('GET', 'schedules'); // GET /api/schedules -> Schedule[] (v2 §R6)
// ===== end v2 chunk 21 =====

// ===== v2 chunk 22 additions (only v2 chunk 22 edits this section) =====
export const createSchedule = (body) => request('POST', 'schedules', body);                       // {name, hours, color?} -> 201 Schedule
export const updateSchedule = (id, body) => request('PATCH', `schedules/${enc(id)}`, body);       // {name?, hours?, color?} -> Schedule
export const deleteSchedule = (id) => request('DELETE', `schedules/${enc(id)}`);                  // 204; 409 default
export const setDefaultSchedule = (id) => request('PUT', 'settings', { defaultScheduleId: id });  // V2-D14 settings key
// ===== end v2 chunk 22 =====
