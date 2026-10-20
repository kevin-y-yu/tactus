// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Reschedule orchestration (spec §9.10 steps 1-9), TaskStatus derivation (§8.1), serialized runs (AC4) and the 15-min timer (§9.10); v2 §R6 V2-D15/V2-D18 schedule wiring (Chunk 19).
'use strict';
const { schedule } = require('./scheduler.js');
const { generateOccurrences, placeOccurrences } = require('./recurrence.js');
const { placeLunches } = require('./lunch.js');
const { MIN, addDays, utcToZoned, zonedToUtc } = require('../public/shared/time.js');

const DAY = 86400000, HOUR = 3600000, TIMER_MS = 15 * 60000;
const iso = (ms) => new Date(ms).toISOString();
const isoOrNull = (ms) => (ms == null ? null : iso(ms));
const msOrNull = (s) => (s == null ? null : Date.parse(s));
const ceil15 = (m) => Math.ceil(m / 15) * 15;
const minutesOf = (b) => (Date.parse(b.end) - Date.parse(b.start)) / MIN;
const key = (recurringId, date) => `${recurringId}|${date}`;
// V2-D18 orchestration guard: resolveSchedule trusts entry.hours, so only entries with an hours object are passed (Chunk 19 D2).
const hasHours = (s) => s.hours != null && typeof s.hours === 'object' && !Array.isArray(s.hours);

// §2 glossary: a block is fixed when completed, or when it is pinned/started and still running.
function isFixedBlock(b, nowMs) {
  return b.completed || (Date.parse(b.end) > nowMs && (b.pinned || Date.parse(b.start) < nowMs));
}

// D6: status shape before any run has happened.
function EMPTY_STATUS() {
  return { ranAt: null, horizonEnd: null, meta: { path: null, repairPasses: 0 }, tasks: [], atRisk: [], tight: [], dropped: [] };
}

// §9.10 step 9 / §8.1: build the status object from one run's results (D6-D8).
function buildStatus({ nowMs, res, occ, tasks, credited, fixedEnd, dropped = [] }) {
  const atRisk = [
    ...res.atRisk.map((a) => ({ taskId: a.taskId, recurringId: null, occurrenceDate: null, kind: a.kind,
      deadline: isoOrNull(a.deadline), deadlineType: a.deadlineType, plannedEnd: isoOrNull(a.plannedEnd),
      unscheduledMin: a.unscheduledMin, overdue: a.overdue })),
    ...occ.atRisk.map((a) => ({ taskId: null, recurringId: a.recurringId, occurrenceDate: a.occurrenceDate, kind: a.kind,
      deadline: iso(a.deadline), deadlineType: null, plannedEnd: null, unscheduledMin: a.unscheduledMin, overdue: false })),
  ];
  const tight = res.tight.map((x) => ({ taskId: x.taskId, deadline: iso(x.deadline), plannedEnd: iso(x.plannedEnd),
    slackMin: x.slackMin }));
  const atRiskByTask = new Map(res.atRisk.map((a) => [a.taskId, a.kind]));
  const tightIds = new Set(res.tight.map((x) => x.taskId));
  const taskStatus = [...tasks].sort((a, b) => a.id - b.id).map((t) => {
    const placed = res.blocks.filter((b) => b.taskId === t.id);
    const scheduledMin = placed.reduce((sum, b) => sum + (b.end - b.start) / MIN, 0);
    const ends = [fixedEnd.get(t.id), ...placed.map((b) => b.end)].filter((x) => x != null);
    const plannedEnd = ends.length ? Math.max(...ends) : null;
    const state = atRiskByTask.get(t.id) ?? (tightIds.has(t.id) ? 'tight' : 'ok');
    return {
      taskId: t.id, state, overdue: t.deadline != null && t.deadline <= nowMs,
      deadline: isoOrNull(t.deadline), deadlineType: t.deadlineType, plannedEnd: isoOrNull(plannedEnd),
      scheduledMin, unscheduledMin: t.remainingMin - scheduledMin, creditedMin: credited.get(t.id) ?? 0,
      slackMin: t.deadline != null && plannedEnd != null ? (t.deadline - plannedEnd) / MIN : null,
    };
  });
  return {
    ranAt: iso(nowMs), horizonEnd: iso(res.horizonEnd), meta: { path: res.meta.path, repairPasses: res.meta.repairPasses },
    tasks: taskStatus, atRisk, tight, dropped,
  };
}

function createScheduleService({ repo, now = Date.now, log = console }) {
  async function run(reason) {
    // 1
    const settings = await repo.getSettings();
    const nowMs = now(); const tz = settings.timezone; const nowIso = iso(nowMs);
    const today = utcToZoned(nowMs, tz).date;
    const lastDate = addDays(today, settings.horizonDays - 1);
    const horizonEnd = zonedToUtc(addDays(today, settings.horizonDays), 0, tz);
    // 1 (v2 §R6 V2-D18 orchestration): schedules for the pure scheduler; settings.workHours stays as the fallback alias.
    const schedSettings = { ...settings, defaultScheduleId: settings.defaultScheduleId,
      schedules: (await repo.listSchedules()).filter(hasHours).map((s) => ({ id: s.id, hours: s.hours })) };
    // 2
    await repo.pruneBlocks(iso(nowMs - 30 * DAY));
    // 3
    const credited = new Map(); const fixedEnd = new Map();
    for (const b of await repo.listFixedBlocks(nowIso)) {
      if (b.taskId == null) continue;
      credited.set(b.taskId, (credited.get(b.taskId) ?? 0) + minutesOf(b));
      fixedEnd.set(b.taskId, Math.max(fixedEnd.get(b.taskId) ?? -Infinity, Date.parse(b.end)));
    }
    // 4 events (D19 blocking rule; enabled already filtered by the repo)
    const busy = [];
    const evFrom = zonedToUtc(addDays(today, -1), 0, tz), evTo = zonedToUtc(addDays(today, settings.horizonDays + 1), 0, tz);
    for (const e of await repo.listEventsInRange(iso(evFrom), iso(evTo))) {
      if (!e.calendarBlocking || e.transparent) continue;
      if (e.allDay) {
        if (!settings.allDayEventsBlock) continue;
        busy.push({ start: e.startDate ? zonedToUtc(e.startDate, 0, tz) : Date.parse(e.start),
          end: e.endDate ? zonedToUtc(e.endDate, 0, tz) : Date.parse(e.end), kind: 'allday' });
      } else busy.push({ start: Date.parse(e.start), end: Date.parse(e.end), kind: 'event' });
    }
    // tactus-only user events: always blocking, timed, kind 'event' so the meeting buffer applies
    for (const e of await repo.listUserEventsInRange(iso(evFrom), iso(evTo))) busy.push({ start: Date.parse(e.start), end: Date.parse(e.end), kind: 'event' });
    // 4 work (D10)
    const fromDate = addDays(today, -31);
    const recent = await repo.listBlocksInRange(iso(zonedToUtc(fromDate, 0, tz)), iso(horizonEnd));
    for (const b of recent) {
      if (Date.parse(b.end) > nowMs - 12 * HOUR && (isFixedBlock(b, nowMs) || Date.parse(b.start) < nowMs)) {
        busy.push({ start: Date.parse(b.start), end: Date.parse(b.end), kind: 'work' });
      }
    }
    // 4b lunches: placed before recurring tasks and tasks; each one is a gap (it resets the break rule's work run)
    const prevLunch = ((await repo.getMeta('lunchBlocks')) ?? []).map((l) => ({ start: Date.parse(l.start), end: Date.parse(l.end) }));
    const lunchOverrides = (await repo.getMeta('lunchOverrides')) ?? {};
    const lunches = placeLunches(schedSettings, busy, nowMs, prevLunch, lunchOverrides);
    for (const l of lunches) if (l.end > nowMs - 12 * HOUR) busy.push({ start: l.start, end: l.end, kind: 'lunch' });
    await repo.setMeta('lunchBlocks', lunches.filter((l) => l.end > nowMs - 35 * DAY).map((l) => ({ start: iso(l.start), end: iso(l.end) })));
    // 5 occurrences + recurring skip rule
    const done = new Set((await repo.listOccurrenceDone(fromDate)).map((d) => key(d.recurringId, d.occurrenceDate)));
    const workedMin = new Map();   // minutes of an occurrence already behind us or pinned ahead (never moved)
    for (const b of recent) {
      if (b.kind !== 'recurring') continue;
      if (Date.parse(b.start) < nowMs || b.pinned) {                                                      // 5b, 5c
        const k = key(b.recurringId, b.occurrenceDate);
        workedMin.set(k, (workedMin.get(k) ?? 0) + (Date.parse(b.end) - Date.parse(b.start)) / 60000);
      }
    }
    const occs = [];
    const projectSchedule = new Map((await repo.listProjects()).map((p) => [p.id, p.scheduleId ?? null]));  // V2-D15, once per run
    for (const rec of await repo.listRecurring()) {
      if (!rec.active) continue;
      const recScheduleId = rec.scheduleId
        ?? (rec.projectId != null ? projectSchedule.get(rec.projectId) ?? null : null) ?? settings.defaultScheduleId;  // V2-D15
      for (const o of generateOccurrences(rec, fromDate, lastDate, tz, settings.weekStartsOn ?? 1)) {
        const k = key(o.recurringId, o.occurrenceDate);
        const remaining = o.durationMin - (workedMin.get(k) ?? 0);
        if (o.periodEnd <= nowMs || done.has(k) || remaining <= 0 || o.periodStart <= nowMs - 30 * DAY) continue;
        occs.push({ ...o, durationMin: Math.ceil(remaining / 15) * 15, scheduleId: recScheduleId,
          minBlockMin: rec.minBlockMin ?? settings.defaultMinBlockMin, droppable: !!rec.droppable });
      }
    }
    // 6 tasks (D9 effective deadline)
    const taskRows = await repo.listTasksForScheduling();
    const openIds = new Set(taskRows.map((t) => t.id));
    const blockersOf = new Map();                                    // task id -> open blocker ids (done blockers no longer block)
    for (const d of await repo.listTaskDependencies()) {
      if (!openIds.has(d.blockerId) || !openIds.has(d.taskId)) continue;
      if (!blockersOf.has(d.taskId)) blockersOf.set(d.taskId, []);
      blockersOf.get(d.taskId).push(d.blockerId);
    }
    const eventEndOf = new Map();                                    // task id -> latest end of its blocking events; a vanished event is ignored
    for (const e of await repo.listTaskEventLinks()) {
      if (e.end == null) continue;
      const endMs = e.allDay && e.endDate ? zonedToUtc(e.endDate, 0, tz) : Date.parse(e.end);
      eventEndOf.set(e.taskId, Math.max(eventEndOf.get(e.taskId) ?? -Infinity, endMs));
    }
    const eventStartOf = new Map();                                  // task id -> earliest start of the events it must finish before
    for (const e of await repo.listTaskEventLinks(null, 'before')) {
      if (e.stale) continue;
      const startMs = Date.parse(e.start);
      eventStartOf.set(e.taskId, Math.min(eventStartOf.get(e.taskId) ?? Infinity, startMs));
    }
    const tasks = taskRows.map((t) => {
      const own = t.deadline != null; const dl = own ? t.deadline : t.stageDeadline;
      let deadline = msOrNull(dl); let deadlineType = dl == null ? null : (own ? t.deadlineType : t.stageDeadlineType);
      const evStart = eventStartOf.get(t.id);                        // an event this task blocks: its start is a hard deadline
      if (evStart !== undefined && (deadline === null || evStart < deadline)) { deadline = evStart; deadlineType = 'hard'; }
      return { id: t.id, projectId: t.projectId, stageSortOrder: t.stageSortOrder, priority: t.priority,
        remainingMin: ceil15(Math.max(0, t.durationMin - (credited.get(t.id) ?? 0))),
        deadline, deadlineType,
        startAfter: Math.max(msOrNull(t.startAfter) ?? -Infinity, eventEndOf.get(t.id) ?? -Infinity) === -Infinity ? null
          : Math.max(msOrNull(t.startAfter) ?? -Infinity, eventEndOf.get(t.id) ?? -Infinity),
        blockedBy: blockersOf.get(t.id) ?? [], minBlockMin: t.minBlockMin, maxBlockMin: t.maxBlockMin, dontSplit: t.dontSplit,
        fixedEnd: fixedEnd.get(t.id) ?? null, sortOrder: t.sortOrder, createdAt: Date.parse(t.createdAt),
        scheduleId: t.scheduleId ?? t.projectScheduleId ?? null };
    });
    // 5d/7: place occurrences then tasks. A low-priority recurring occurrence marked droppable is given up, one at a time
    // (earliest first), while that lets more tasks meet their deadlines.
    const attempt = (dropped) => {
      const o = placeOccurrences(occs.filter((x) => !dropped.has(key(x.recurringId, x.occurrenceDate))), busy, schedSettings, nowMs);
      return { occ: o, res: schedule(tasks, [...busy, ...o.blocks.map((b) => ({ start: b.start, end: b.end, kind: 'work' }))], schedSettings, nowMs) };
    };
    const droppedKeys = new Set();
    let { occ, res } = attempt(droppedKeys);
    const candidates = occs.filter((x) => x.droppable).sort((a, b) => a.periodStart - b.periodStart);
    for (const c of candidates) {
      if (!res.atRisk.length) break;
      droppedKeys.add(key(c.recurringId, c.occurrenceDate));
      const next = attempt(droppedKeys);
      if (next.res.atRisk.length < res.atRisk.length) { ({ occ, res } = next); } else droppedKeys.delete(key(c.recurringId, c.occurrenceDate));
    }
    const dropped = candidates.filter((c) => droppedKeys.has(key(c.recurringId, c.occurrenceDate)))
      .map((c) => ({ recurringId: c.recurringId, occurrenceDate: c.occurrenceDate }));
    // 8 (A3 element shapes)
    const stored = [
      ...occ.blocks.map((b) => ({ recurringId: b.recurringId, occurrenceDate: b.occurrenceDate, start: iso(b.start), end: iso(b.end) })),
      ...res.blocks.map((b) => ({ taskId: b.taskId, start: iso(b.start), end: iso(b.end) })),
    ];
    await repo.replaceScheduledBlocks(nowIso, stored);
    // 9
    const status = buildStatus({ nowMs, res, occ, tasks, credited, fixedEnd, dropped });
    await repo.setMeta('lastSchedule', status);
    log.info(`reschedule(${reason}): ${stored.length} blocks, ${status.atRisk.length} at risk, path=${res.meta.path}`);
    return status;
  }

  // D3: every call is appended to one promise chain; a failed run only rejects its own caller.
  let chain = Promise.resolve(); let timer = null;
  function reschedule(reason = 'unspecified') {
    const p = chain.then(() => run(reason)); chain = p.catch(() => {}); return p;
  }
  // D5: 15-minute timer, no immediate run.
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      reschedule('timer').catch((err) => log.error(`reschedule(timer) failed: ${err && err.message}`));
    }, TIMER_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { reschedule, start, stop };
}

module.exports = { createScheduleService, isFixedBlock, EMPTY_STATUS };
