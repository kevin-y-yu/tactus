// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Input validation for the HTTP API (spec §8, §7, §5.5). Pure: throws HttpError (400) with `<field>: <reason>` messages.
'use strict';
const { GRID, ceilGrid, parseHHMM, isValidTimeZone, addDays } = require('../public/shared/time.js');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const badRequest = (field, reason) => new HttpError(400, `${field}: ${reason}`);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function requireObject(body) {
  if (body === undefined) return {};
  if (isPlainObject(body)) return body;
  throw badRequest('body', 'must be a JSON object');
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoInstant(v) {
  return typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
}

const normIso = (v) => new Date(v).toISOString();

function isIntStep(v, min, max, step) {
  return Number.isInteger(v) && v >= min && v <= max && v % step === 0;
}

// v2 §R6: defaultScheduleId is server-only (the client settings sections do not list it; T-V2-SET-4 filters it out).
const SETTINGS_KEYS = ['timezone', 'workHours', 'defaultMinBlockMin', 'breakMin', 'breakIntervalMin', 'meetingBufferMin',
  'horizonDays', 'hardDeadlineMarginMin', 'allDayEventsBlock', 'icsRefreshMinutes', 'weekStartsOn', 'defaultScheduleId',
  'lunchMin', 'lunchStart', 'lunchEnd', 'clock24'];

// v1 workHours rules; `field` names the 400 prefix (settings: workHours, schedules: hours — v2 §R6 V2-D14).
function validateWorkHours(w, field = 'workHours') {
  const fail = (reason) => badRequest(field, reason);
  if (!isPlainObject(w) || Object.keys(w).sort().join(',') !== '0,1,2,3,4,5,6') {
    throw fail('must be an object with keys "0" to "6"');
  }
  const days = [0, 1, 2, 3, 4, 5, 6];
  for (const k of days) {
    const ranges = w[k];
    if (!Array.isArray(ranges) || !ranges.every((r) => Array.isArray(r) && r.length === 2
      && typeof r[0] === 'string' && typeof r[1] === 'string')) {
      throw fail(`day ${k} must be a list of [start, end] pairs`);
    }
    const mins = ranges.map((r) => r.map((s) => {
      let m;
      try { m = parseHHMM(s); } catch (_) { m = NaN; }
      return m;
    }));
    if (mins.some((pair) => !pair.every(Number.isFinite))) throw fail(`day ${k} has an invalid time`);
    if (mins.some((pair) => !pair.every((m) => m % 15 === 0))) throw fail(`day ${k} times must be on the 15-minute grid`);
    if (mins.some(([s, e]) => !(s < e))) throw fail(`day ${k} range start must be before end`);
    for (let i = 1; i < mins.length; i++) {
      if (!(mins[i][0] >= mins[i - 1][1])) throw fail(`day ${k} ranges must be sorted and non-overlapping`);
    }
  }
}

const SETTINGS_RULES = {
  timezone: [(v) => typeof v === 'string' && isValidTimeZone(v), 'must be a valid IANA time zone'],
  defaultMinBlockMin: [(v) => isIntStep(v, 15, 240, 15), 'must be an integer 15-240 in steps of 15'],
  breakMin: [(v) => isIntStep(v, 0, 60, 5), 'must be an integer 0-60 in steps of 5'],
  breakIntervalMin: [(v) => v === 0 || isIntStep(v, 30, 480, 15), 'must be 0 or an integer 30-480 in steps of 15'],
  meetingBufferMin: [(v) => isIntStep(v, 0, 60, 5), 'must be an integer 0-60 in steps of 5'],
  horizonDays: [(v) => isIntStep(v, 7, 90, 1), 'must be an integer 7-90'],
  hardDeadlineMarginMin: [(v) => isIntStep(v, 0, 1440, 15), 'must be an integer 0-1440 in steps of 15'],
  allDayEventsBlock: [(v) => typeof v === 'boolean', 'must be a boolean'],
  icsRefreshMinutes: [(v) => isIntStep(v, 5, 1440, 1), 'must be an integer 5-1440'],
  weekStartsOn: [(v) => v === 0 || v === 1, 'must be 0 or 1'],
  lunchMin: [(v) => isIntStep(v, 0, 120, 15), 'must be an integer 0-120 in steps of 15 (0 = no lunch)'],
  lunchStart: [(v) => isGridHHMM(v), 'must be HH:MM on the 15-minute grid'],
  lunchEnd: [(v) => isGridHHMM(v), 'must be HH:MM on the 15-minute grid'],
  clock24: [(v) => typeof v === 'boolean', 'must be a boolean'],
  // Type check only; the settings route also checks that the schedule exists (same message).
  defaultScheduleId: [(v) => Number.isInteger(v) && v > 0, 'must be an existing schedule'],
};

function validateSettings(s) {
  for (const key of SETTINGS_KEYS) {
    if (key === 'workHours') { validateWorkHours(s.workHours); continue; }
    const [ok, msg] = SETTINGS_RULES[key];
    if (!ok(s[key])) throw badRequest(key, msg);
  }
  if (!(parseHHMM(s.lunchEnd) > parseHHMM(s.lunchStart))) throw badRequest('lunchEnd', 'must be after lunchStart');
  if (s.lunchMin > 0 && parseHHMM(s.lunchEnd) - parseHHMM(s.lunchStart) < s.lunchMin) throw badRequest('lunchEnd', 'the lunch window must be at least as long as the lunch');
}

const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const isNullOrIso = (v) => v === null || isIsoInstant(v);
const normNullableIso = (v) => (v === null ? null : normIso(v));

function validateTaskFields(t) {
  if (typeof t.title !== 'string' || t.title.trim().length < 1 || t.title.trim().length > 200) {
    throw badRequest('title', 'must be 1-200 characters');
  }
  if (typeof t.notes !== 'string') throw badRequest('notes', 'must be a string');
  if (!(t.projectId === null || Number.isInteger(t.projectId))) throw badRequest('projectId', 'must be null (no project) or an integer');
  if (!(t.stageId === null || Number.isInteger(t.stageId))) throw badRequest('stageId', 'must be null or an integer');
  if (!isIntStep(t.durationMin, 15, 2880, 15)) throw badRequest('durationMin', 'must be an integer 15-2880 in steps of 15');
  if (!PRIORITIES.includes(t.priority)) throw badRequest('priority', 'must be one of urgent, high, medium, low');
  if (!isNullOrIso(t.deadline)) throw badRequest('deadline', 'must be an ISO instant or null');
  if (t.deadlineType !== 'hard' && t.deadlineType !== 'soft') throw badRequest('deadlineType', 'must be hard or soft');
  if (!isNullOrIso(t.startAfter)) throw badRequest('startAfter', 'must be an ISO instant or null');
  if (!(t.minBlockMin === null || isIntStep(t.minBlockMin, 15, 240, 15))) {
    throw badRequest('minBlockMin', 'must be null or an integer 15-240 in steps of 15');
  }
  if (!(t.maxBlockMin === null || isIntStep(t.maxBlockMin, 15, 2880, 15))) {
    throw badRequest('maxBlockMin', 'must be null or an integer 15-2880 in steps of 15');
  }
  if (t.maxBlockMin !== null && t.minBlockMin !== null && t.maxBlockMin < t.minBlockMin) {
    throw badRequest('maxBlockMin', 'must be >= minBlockMin');
  }
  if (typeof t.dontSplit !== 'boolean') throw badRequest('dontSplit', 'must be a boolean');
  if (!Number.isInteger(t.sortOrder)) throw badRequest('sortOrder', 'must be an integer');
  return {
    title: t.title.trim(), notes: t.notes, projectId: t.projectId, stageId: t.stageId, durationMin: t.durationMin,
    priority: t.priority, deadline: normNullableIso(t.deadline), deadlineType: t.deadlineType,
    startAfter: normNullableIso(t.startAfter), minBlockMin: t.minBlockMin, maxBlockMin: t.maxBlockMin,
    dontSplit: t.dontSplit, sortOrder: t.sortOrder, scheduleId: t.scheduleId,
  };
}

const has = (o, k) => o[k] !== undefined;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validateName(name) {
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 100) {
    throw badRequest('name', 'must be 1-100 characters');
  }
  return name.trim();
}

function validateProjectFields(p, { create } = {}) {
  const out = {};
  if (has(p, 'name') || create) out.name = validateName(p.name);
  if (has(p, 'color')) {
    if (typeof p.color !== 'string' || !COLOR_RE.test(p.color)) throw badRequest('color', 'must be #rrggbb');
    out.color = p.color;
  }
  if (has(p, 'sortOrder')) {
    if (!Number.isInteger(p.sortOrder)) throw badRequest('sortOrder', 'must be an integer');
    out.sortOrder = p.sortOrder;
  }
  if (has(p, 'archived')) {
    if (typeof p.archived !== 'boolean') throw badRequest('archived', 'must be a boolean');
    out.archived = p.archived;
  }
  if (has(p, 'scheduleId')) out.scheduleId = p.scheduleId;   // checked against the repo by the route (checkScheduleId)
  return out;
}

function validateStageFields(s, { create } = {}) {
  const out = {};
  if (has(s, 'name') || create) out.name = validateName(s.name);
  if (has(s, 'deadline') || has(s, 'deadlineType')) {
    if (has(s, 'deadline') && !isNullOrIso(s.deadline)) throw badRequest('deadline', 'must be an ISO instant or null');
    if (has(s, 'deadlineType') && s.deadlineType !== 'hard' && s.deadlineType !== 'soft') {
      throw badRequest('deadlineType', 'must be hard or soft');
    }
    if (has(s, 'deadline')) out.deadline = normNullableIso(s.deadline);
    if (has(s, 'deadlineType')) out.deadlineType = s.deadlineType;
  }
  return out;
}

// v2 §R6 V2-D23: name trimmed 1-50 (uniqueness is checked by the route), hours = v1 workHours rules, color #rrggbb.
function validateScheduleFields(s, { create } = {}) {
  const out = {};
  if (has(s, 'name') || create) {
    if (typeof s.name !== 'string' || s.name.trim().length < 1 || s.name.trim().length > 50) {
      throw badRequest('name', 'must be 1-50 characters');
    }
    out.name = s.name.trim();
  }
  if (has(s, 'hours') || create) {
    validateWorkHours(s.hours, 'hours');
    out.hours = s.hours;
  }
  if (has(s, 'color')) {
    if (typeof s.color !== 'string' || !COLOR_RE.test(s.color)) throw badRequest('color', 'must be #rrggbb');
    out.color = s.color;
  }
  return out;
}

function validateBlockTimes(start, end, nowMs) {
  if (!isIsoInstant(start)) throw badRequest('start', 'must be an ISO instant');
  if (!isIsoInstant(end)) throw badRequest('end', 'must be an ISO instant');
  if (Date.parse(start) % GRID !== 0) throw badRequest('start', 'must be on the 15-minute grid');
  if (Date.parse(end) % GRID !== 0) throw badRequest('end', 'must be on the 15-minute grid');
  if (!(Date.parse(end) > Date.parse(start))) throw badRequest('end', 'must be after start');
  if (Date.parse(end) - Date.parse(start) > 86400000) throw badRequest('end', 'block must not exceed 24 h');
  if (!(Date.parse(start) >= ceilGrid(nowMs))) throw badRequest('start', 'must not be in the past');
  return { start: normIso(start), end: normIso(end) };
}

// Tactus-only user event: title, location, and times (grid, order and 24 h cap as validateBlockTimes; past times allowed).
function validateUserEventFields(e) {
  if (typeof e.title !== 'string' || !e.title.trim()) throw badRequest('title', 'must be a non-empty string');
  const title = e.title.trim();
  if (title.length > 200) throw badRequest('title', 'must be at most 200 characters');
  if (typeof e.location !== 'string') throw badRequest('location', 'must be a string');
  if (e.location.length > 500) throw badRequest('location', 'must be at most 500 characters');
  if (!isIsoInstant(e.start)) throw badRequest('start', 'must be an ISO instant');
  if (!isIsoInstant(e.end)) throw badRequest('end', 'must be an ISO instant');
  if (Date.parse(e.start) % GRID !== 0) throw badRequest('start', 'must be on the 15-minute grid');
  if (Date.parse(e.end) % GRID !== 0) throw badRequest('end', 'must be on the 15-minute grid');
  if (!(Date.parse(e.end) > Date.parse(e.start))) throw badRequest('end', 'must be after start');
  if (Date.parse(e.end) - Date.parse(e.start) > 86400000) throw badRequest('end', 'event must not exceed 24 h');
  return { title, location: e.location, start: normIso(e.start), end: normIso(e.end) };
}

function validateRange(from, to) {
  if (!isIsoInstant(from)) throw badRequest('from', 'must be an ISO instant');
  if (!isIsoInstant(to)) throw badRequest('to', 'must be an ISO instant');
  if (!(Date.parse(to) > Date.parse(from))) throw badRequest('to', 'must be after from');
  if (Date.parse(to) - Date.parse(from) > 62 * 86400000) throw badRequest('to', 'range must not exceed 62 days');
  return { from: normIso(from), to: normIso(to) };
}

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDateString(v) { return typeof v === 'string' && DATE_STR_RE.test(v) && addDays(v, 0) === v; }

const FREQUENCIES = ['daily', 'weekdays', 'weekly', 'monthly'];
const isGridHHMM = (v) => { const m = parseHHMM(v); return Number.isFinite(m) && m % 15 === 0; };

function validateRecurringFields(r) {
  if (typeof r.title !== 'string' || r.title.trim().length < 1 || r.title.trim().length > 200) {
    throw badRequest('title', 'must be 1-200 characters');
  }
  if (typeof r.notes !== 'string') throw badRequest('notes', 'must be a string');
  if (!(r.projectId === null || Number.isInteger(r.projectId))) throw badRequest('projectId', 'must be null or an integer');
  if (!FREQUENCIES.includes(r.frequency)) throw badRequest('frequency', 'must be one of daily, weekdays, weekly, monthly');
  let daysOfWeek = [];
  if (r.frequency === 'weekly') {
    const d = r.daysOfWeek;   // empty = a per-week budget placed on any day of the week
    if (!Array.isArray(d) || !d.every((x) => Number.isInteger(x) && x >= 0 && x <= 6) || new Set(d).size !== d.length) {
      throw badRequest('daysOfWeek', 'must be a list of unique weekdays 0-6 (empty for any day of the week)');
    }
    daysOfWeek = [...d].sort((a, b) => a - b);
  }
  let dayOfMonth = null;
  if (r.frequency === 'monthly') {
    if (!(Number.isInteger(r.dayOfMonth) && r.dayOfMonth >= 1 && r.dayOfMonth <= 31)) {
      throw badRequest('dayOfMonth', 'must be an integer 1-31');
    }
    dayOfMonth = r.dayOfMonth;
  }
  const maxDuration = r.frequency === 'weekly' && daysOfWeek.length === 0 ? 2400 : 480;
  if (!isIntStep(r.durationMin, 15, maxDuration, 15)) throw badRequest('durationMin', `must be an integer 15-${maxDuration} in steps of 15`);
  const minBlockMin = r.minBlockMin === undefined ? null : r.minBlockMin;
  if (!(minBlockMin === null || isIntStep(minBlockMin, 15, 240, 15))) {
    throw badRequest('minBlockMin', 'must be null or an integer 15-240 in steps of 15');
  }
  const ws = r.windowStart, we = r.windowEnd;
  if ((ws === null) !== (we === null)) {
    throw badRequest('windowStart', 'windowStart and windowEnd must both be set or both be null');
  }
  if (ws !== null) {
    if (!isGridHHMM(ws)) throw badRequest('windowStart', 'must be HH:MM on the 15-minute grid');
    if (!isGridHHMM(we)) throw badRequest('windowEnd', 'must be HH:MM on the 15-minute grid');
    if (!(parseHHMM(ws) < parseHHMM(we))) throw badRequest('windowEnd', 'must be after windowStart');
  }
  if (!PRIORITIES.includes(r.priority)) throw badRequest('priority', 'must be one of urgent, high, medium, low');
  if (!isDateString(r.startDate)) throw badRequest('startDate', 'must be a YYYY-MM-DD date');
  if (!(r.endDate === null || isDateString(r.endDate))) throw badRequest('endDate', 'must be null or a YYYY-MM-DD date');
  if (r.endDate !== null && r.endDate < r.startDate) throw badRequest('endDate', 'must not be before startDate');
  if (typeof r.active !== 'boolean') throw badRequest('active', 'must be a boolean');
  const droppable = r.droppable === undefined ? false : r.droppable;
  if (typeof droppable !== 'boolean') throw badRequest('droppable', 'must be a boolean');
  if (droppable && r.priority !== 'low') throw badRequest('droppable', 'only low-priority recurring tasks can be dropped');
  return { title: r.title.trim(), notes: r.notes, projectId: r.projectId, frequency: r.frequency, daysOfWeek, dayOfMonth,
    durationMin: r.durationMin, windowStart: ws, windowEnd: we, priority: r.priority, startDate: r.startDate,
    endDate: r.endDate, active: r.active, scheduleId: r.scheduleId, minBlockMin, droppable };
}

const CALENDAR_PROTOCOLS = ['http:', 'https:', 'webcal:'];
function validateCalendarUrl(url) {
  const fail = () => badRequest('url', 'must be an http, https or webcal URL');   // never echo the URL (S-3)
  if (typeof url !== 'string') throw fail();
  const s = url.trim();
  let u = null;
  try { u = new URL(s); } catch { u = null; }
  if (!u || !CALENDAR_PROTOCOLS.includes(u.protocol) || !u.host) throw fail();
  return s;
}

function validateCalendarFields(c, { create } = {}) {
  const out = {};
  if (has(c, 'name') || create) out.name = validateName(c.name);
  if (has(c, 'url') || create) out.url = validateCalendarUrl(c.url);
  if (has(c, 'color')) {
    if (typeof c.color !== 'string' || !COLOR_RE.test(c.color)) throw badRequest('color', 'must be #rrggbb');
    out.color = c.color;
  }
  if (has(c, 'enabled')) {
    if (typeof c.enabled !== 'boolean') throw badRequest('enabled', 'must be a boolean');
    out.enabled = c.enabled;
  }
  if (has(c, 'blocking')) {
    if (typeof c.blocking !== 'boolean') throw badRequest('blocking', 'must be a boolean');
    out.blocking = c.blocking;
  }
  return out;
}

module.exports = {
  HttpError, badRequest, requireObject, isIsoInstant, normIso, isIntStep, SETTINGS_KEYS, validateSettings,
  validateTaskFields, validateProjectFields, validateStageFields, validateBlockTimes, validateUserEventFields, validateRange,
  isDateString, validateRecurringFields, validateCalendarFields, validateScheduleFields,
};
