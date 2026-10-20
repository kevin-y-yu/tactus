// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// PURE tactus-only user event helpers: form <-> API conversion and ids. No I/O, no clock reads except via parameters, no DOM.
import { zonedToUtc, utcToZoned, addDays, parseHHMM, formatHHMM } from '../shared/time.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isUserEvent = (ev) => ev.uid === 'user' && ev.calendarId === null;
export const userEventDbId = (ev) => Number(String(ev.id).slice(5));   // 'user:7' -> 7

// Form values {title, date 'YYYY-MM-DD', start 'HH:MM', end 'HH:MM'} in tz -> API body {title, start, end} (ISO).
// End '00:00' means midnight at the end of `date`. Throws Error with a user-facing message.
export function userEventBody(v, tz) {
  const title = String(v.title ?? '').trim();
  if (!title) throw new Error('Enter a title');
  const s = parseHHMM(v.start), e = parseHHMM(v.end);
  if (!DATE_RE.test(String(v.date)) || !Number.isFinite(s) || !Number.isFinite(e)) throw new Error('Enter a date, start and end time');
  const endMs = e === 0 ? zonedToUtc(addDays(v.date, 1), 0, tz) : zonedToUtc(v.date, e, tz);
  const startMs = zonedToUtc(v.date, s, tz);
  if (!(endMs > startMs)) throw new Error('End must be after start');
  return { title, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

// API event -> form values in tz.
export function userEventFormValues(ev, tz) {
  const s = utcToZoned(Date.parse(ev.start), tz), e = utcToZoned(Date.parse(ev.end), tz);
  return { title: ev.title, date: s.date, start: formatHHMM(s.minutes), end: formatHHMM(e.minutes) };
}

// "+ Event" defaults: the next full hour after now in tz, 60 minutes.
export function defaultNewEventValues(now, tz) {
  const z = utcToZoned(now, tz);
  let date = z.date, m = Math.floor(z.minutes / 60) * 60 + 60;
  if (m >= 1440) { date = addDays(date, 1); m = 0; }
  return { title: '', date, start: formatHHMM(m), end: formatHHMM((m + 60) % 1440) };
}
