// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Calendar sync (spec §9.12): fetch through a provider seam, store on hash change, reschedule. S-3: never log or return a full feed URL.
'use strict';
const crypto = require('node:crypto');
const { parseIcs, redactUrl } = require('./ics.js');
const { addDays, utcToZoned, zonedToUtc } = require('../public/shared/time.js');

const FETCH_TIMEOUT_MS = 20000;
const MAX_FEED_BYTES = 15 * 1024 * 1024;
const TICK_MS = 60000;
const RESCHEDULE_REASON = 'calendar-sync';

const toHttps = (url) => String(url).replace(/^webcal:\/\//i, 'https://');
const errMsg = (err) => (err && typeof err.message === 'string' ? err.message : String(err));

async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new Error('feed too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new Error('feed too large'); }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

async function fetchIcs(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(toHttps(url), {
    headers: { 'User-Agent': 'Tactus/0.1', Accept: 'text/calendar, */*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await readCapped(res, MAX_FEED_BYTES);
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('not an iCalendar feed');
  return text;
}

function createIcsProvider(fetchImpl = globalThis.fetch) {
  return {
    async fetchEvents(calendar, opts) { return parseIcs(await fetchIcs(calendar.url, fetchImpl), opts); },
  };
}

function scrubUrl(message, url) {
  let out = String(message);
  if (!url) return out;
  const redacted = redactUrl(url);
  const https = toHttps(url);
  const candidates = [String(url), https];
  try {
    const u = new URL(https);
    candidates.push(u.href);
    if (u.pathname + u.search !== '/') candidates.push(u.pathname + u.search);
  } catch { /* unparsable url: literal forms only */ }
  for (const c of [...new Set(candidates)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(c).join(redacted);
  }
  return out;
}

function createCalendarSync({ repo, scheduleService, fetchImpl = globalThis.fetch, log = console, now = Date.now, providers } = {}) {
  const providerMap = providers ?? { ics: createIcsProvider(fetchImpl) };
  const inflight = new Map();
  const generation = new Map();   // id -> number; a superseding refresh bumps it so older runs drop their result
  let timer = null;
  let ticking = false;

  async function doRefresh(id, reschedule, isCurrent) {
    const cal = await repo.getCalendar(id);
    if (!cal) return { changed: false };
    const settings = await repo.getSettings();
    const tz = settings.timezone;
    const nowMs = now();
    const today = utcToZoned(nowMs, tz).date;
    const opts = {
      rangeStart: zonedToUtc(addDays(today, -35), 0, tz),
      rangeEnd: zonedToUtc(addDays(today, settings.horizonDays + 7), 0, tz),
      defaultTz: tz,
    };
    const fetchedAt = new Date(nowMs).toISOString();
    let result;
    try {
      const name = cal.provider || 'ics';
      const provider = providerMap[name];
      if (!provider) throw new Error(`unsupported provider ${name}`);
      result = await provider.fetchEvents(cal, opts);
    } catch (err) {
      if (!isCurrent()) return { changed: false };   // superseded (url changed): write and log nothing
      const lastError = scrubUrl(errMsg(err), cal.url).slice(0, 500);
      await repo.setCalendarFetchResult(cal.id, { lastFetchedAt: fetchedAt, lastError });
      log.warn(`calendar ${cal.id} refresh failed: ${lastError}`);
      return { changed: false };
    }
    if (!isCurrent()) return { changed: false };   // superseded: never store the old url's events
    const events = result.events;
    const warnings = result.warnings || [];
    if (warnings.length) {
      log.warn(scrubUrl(`calendar ${cal.id}: ${warnings.length} warning(s): ${warnings.slice(0, 5).join('; ')}`, cal.url));
    }
    const hash = crypto.createHash('sha256').update(JSON.stringify(events)).digest('hex');
    const key = `icsHash:${cal.id}`;
    const changed = hash !== (await repo.getMeta(key));
    if (changed) {
      await repo.replaceCalendarEvents(cal.id, events.map((e) => ({
        ...e, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(),
      })));
      await repo.setMeta(key, hash);
      log.info(`calendar ${cal.id}: ${events.length} events stored`);
    }
    await repo.setCalendarFetchResult(cal.id, { lastFetchedAt: fetchedAt, lastError: null, eventCount: events.length });
    if (changed && reschedule) await scheduleService.reschedule(RESCHEDULE_REASON);
    return { changed };
  }

  // supersede: the calendar row changed (e.g. its url). Older in-flight runs discard their result, and a fresh run
  // starts once the old one settles, so the two never interleave repo writes. Without it, join any in-flight run.
  function refreshCalendar(id, { reschedule = true, supersede = false } = {}) {
    const key = Number(id);
    const prev = inflight.get(key);
    if (prev && !supersede) return prev.promise;
    if (supersede) generation.set(key, (generation.get(key) ?? 0) + 1);
    const gen = generation.get(key) ?? 0;
    const isCurrent = () => (generation.get(key) ?? 0) === gen;
    const run = () => doRefresh(key, reschedule, isCurrent);
    const entry = {};
    entry.promise = (prev ? prev.promise.catch(() => {}).then(run) : run())
      .finally(() => { if (inflight.get(key) === entry) inflight.delete(key); });
    inflight.set(key, entry);
    return entry.promise;
  }

  async function refreshList(calendars) {
    let changed = false;
    for (const cal of calendars) {
      try {
        const r = await refreshCalendar(cal.id, { reschedule: false });
        if (r.changed) changed = true;
      } catch (err) {
        log.error(`calendar ${cal.id} refresh failed: ${scrubUrl(errMsg(err), cal.url)}`);
      }
    }
    if (changed) await scheduleService.reschedule(RESCHEDULE_REASON);
    return { changed };
  }

  async function refreshAll() {
    return refreshList((await repo.listCalendars()).filter((c) => c.enabled));
  }

  // Refresh enabled calendars last fetched more than maxAgeMs ago, without rescheduling: the caller reschedules next.
  // Never throws and never waits longer than timeoutMs, so a slow feed cannot stall a task save.
  async function refreshStale({ maxAgeMs = 60000, timeoutMs = 5000 } = {}) {
    try {
      const nowMs = now();
      const stale = (await repo.listCalendars()).filter((c) => c.enabled
        && (!c.lastFetchedAt || !(nowMs - Date.parse(c.lastFetchedAt) < maxAgeMs)));
      if (!stale.length) return;
      let t;
      const timeout = new Promise((resolve) => { t = setTimeout(resolve, timeoutMs); });
      await Promise.race([
        Promise.all(stale.map((c) => refreshCalendar(c.id, { reschedule: false }).catch((err) =>
          log.error(`calendar ${c.id} refresh failed: ${scrubUrl(errMsg(err), c.url)}`)))),
        timeout,
      ]);
      clearTimeout(t);
    } catch (err) {
      log.error(`refreshStale failed: ${errMsg(err)}`);
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const settings = await repo.getSettings();
      const nowMs = now();
      const maxAgeMs = settings.icsRefreshMinutes * 60000;
      const due = (await repo.listCalendars()).filter((c) => c.enabled
        && (!c.lastFetchedAt || !(nowMs - Date.parse(c.lastFetchedAt) < maxAgeMs)));
      if (due.length) await refreshList(due);
    } catch (err) {
      log.error(`calendar sync tick failed: ${errMsg(err)}`);
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick(); }, TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
    tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { refreshCalendar, refreshAll, refreshStale, start, stop };
}

module.exports = { createCalendarSync, fetchIcs, createIcsProvider, scrubUrl };
