// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Pure ICS parsing (spec §9.11). No I/O, no clock reads; instants are epoch ms (A2).
'use strict';
const ICAL = require('ical.js');
const { zonedToUtc, isValidTimeZone, addDays } = require('../public/shared/time.js');

const MAX_ITERATIONS = 50000;
const WINDOWS_TZ = Object.freeze({
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'India Standard Time': 'Asia/Kolkata',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  UTC: 'UTC',
});

// Idea from Super Productivity (MIT): sanitizeIcalData orphan-line unfolding; reimplemented.
function unfoldOrphans(text) {
  return String(text).split(/\r?\n/).map((line) =>
    (line !== '' && !line.includes(':') && !line.includes(';') && !/^\s/.test(line)) ? ' ' + line : line,
  ).join('\r\n');
}

function redactUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return '[invalid url]'; }
  if (!u.host) return '[invalid url]';
  return `${u.protocol}//${u.host}/...`;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const dateOf = (t) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
const tzidOf = (comp, name) => { const p = comp.getFirstProperty(name); return (p && p.getParameter('tzid')) || null; };
const textOf = (comp, name) => { const v = comp.getFirstPropertyValue(name); return v == null ? '' : String(v); };
const uidOf = (comp) => textOf(comp, 'uid');
const isRecurring = (comp) => comp.hasProperty('rrule') || comp.hasProperty('rdate');
const isCancelled = (comp) => textOf(comp, 'status').toUpperCase() === 'CANCELLED';

function parseIcs(text, { rangeStart, rangeEnd, defaultTz }) {
  const warnings = [];
  const warnedTz = new Set();
  const toMs = (time, tzid) => {
    if (time.zone === ICAL.Timezone.utcTimezone) {
      return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
    }
    if (tzid && ICAL.TimezoneService.has(tzid)) return time.toUnixTime() * 1000;
    let zone = defaultTz;
    if (tzid) {
      if (isValidTimeZone(tzid)) zone = tzid;
      else if (Object.hasOwn(WINDOWS_TZ, tzid)) zone = WINDOWS_TZ[tzid];
      else if (!warnedTz.has(tzid)) { warnedTz.add(tzid); warnings.push(`unknown TZID ${tzid}`); }
    }
    return zonedToUtc(dateOf(time), time.hour * 60 + time.minute, zone) + time.second * 1000;
  };

  let jcal;
  try { jcal = ICAL.parse(unfoldOrphans(text)); } catch (err) { throw new Error(`invalid iCalendar data: ${err.message}`); }
  if (Array.isArray(jcal[0])) { if (jcal.length > 1) warnings.push('extra VCALENDAR ignored'); jcal = jcal[0]; }
  const root = new ICAL.Component(jcal);

  const registered = [];
  try {
    for (const vtz of root.getAllSubcomponents('vtimezone')) {
      const tzid = textOf(vtz, 'tzid');
      if (tzid && !ICAL.TimezoneService.has(tzid)) { ICAL.TimezoneService.register(vtz); registered.push(tzid); }
    }

    const out = [];
    const emit = (comp, startT, endT, startTz, endTz) => {
      if (isCancelled(comp)) return;
      const summary = textOf(comp, 'summary');
      const rec = { uid: uidOf(comp), title: summary.trim() ? summary : '(busy)', location: textOf(comp, 'location'),
        start: 0, end: 0, allDay: false, startDate: null, endDate: null,
        transparent: textOf(comp, 'transp').toUpperCase() === 'TRANSPARENT' };
      if (startT.isDate) {
        const startDate = dateOf(startT);
        let endDate = endT ? dateOf(endT) : null;
        if (!endDate || endDate <= startDate) endDate = addDays(startDate, 1);
        Object.assign(rec, { allDay: true, startDate, endDate,
          start: zonedToUtc(startDate, 0, defaultTz), end: zonedToUtc(endDate, 0, defaultTz) });
      } else {
        rec.start = toMs(startT, startTz);
        rec.end = endT ? toMs(endT, endTz) : rec.start;
        if (rec.end < rec.start) rec.end = rec.start;
      }
      const overlaps = rec.end === rec.start
        ? rec.start >= rangeStart && rec.start < rangeEnd
        : rec.start < rangeEnd && rec.end > rangeStart;
      if (overlaps) out.push(rec);
    };
    const guarded = (comp, fn) => {
      try { fn(); } catch (err) { warnings.push(`skipped VEVENT ${uidOf(comp) || '(no UID)'}: ${err.message}`); }
    };
    const emitSingle = (comp) => {
      if (!comp.hasProperty('dtstart')) throw new Error('no DTSTART');
      const ev = new ICAL.Event(comp);
      const st = tzidOf(comp, 'dtstart');
      emit(comp, ev.startDate, ev.endDate, st, tzidOf(comp, 'dtend') || st);
    };
    const expand = (ev, uid) => {
      const comp = ev.component;
      if (!comp.hasProperty('dtstart')) throw new Error('no DTSTART');
      const st = tzidOf(comp, 'dtstart');
      const it = ev.iterator();
      for (let n = 0; ; n++) {
        if (n >= MAX_ITERATIONS) { warnings.push(`recurrence limit reached for UID ${uid}`); break; }
        const next = it.next();
        if (!next) break;
        if (toMs(next, st) >= rangeEnd) break;
        const d = ev.getOccurrenceDetails(next);
        if (d.item === ev) emit(comp, d.startDate, d.endDate, st, st);
        else {
          const xc = d.item.component;
          const xs = tzidOf(xc, 'dtstart');
          emit(xc, d.startDate, d.endDate, xs, tzidOf(xc, 'dtend') || xs);
        }
      }
    };

    // §9.11 step 2 grouping (D8)
    const mains = [];
    const exceptionsByUid = new Map();
    for (const c of root.getAllSubcomponents('vevent')) {
      if (c.hasProperty('recurrence-id')) {
        const uid = uidOf(c);
        if (!exceptionsByUid.has(uid)) exceptionsByUid.set(uid, []);
        exceptionsByUid.get(uid).push(c);
      } else mains.push(c);
    }
    const masterByUid = new Map();
    for (const c of mains) {
      const uid = uidOf(c);
      if (uid && isRecurring(c) && !masterByUid.has(uid)) masterByUid.set(uid, c);
    }
    for (const c of mains) guarded(c, () => {
      if (!isRecurring(c)) return emitSingle(c);
      if (isCancelled(c)) return;
      const uid = uidOf(c);
      const ev = new ICAL.Event(c);
      if (masterByUid.get(uid) === c) for (const x of exceptionsByUid.get(uid) || []) ev.relateException(x);
      expand(ev, uid);
    });
    for (const [uid, xs] of exceptionsByUid) {
      if (!masterByUid.has(uid)) for (const x of xs) guarded(x, () => emitSingle(x));
    }

    out.sort((a, b) => a.start - b.start || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    return { events: out, warnings };
  } finally {
    for (const tzid of registered) ICAL.TimezoneService.remove(tzid);
  }
}

module.exports = { parseIcs, unfoldOrphans, redactUrl, WINDOWS_TZ };
