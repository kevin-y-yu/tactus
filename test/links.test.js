// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Standalone tasks, task blocked-by links (same project) and blocked-by calendar events.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const C0 = Date.parse('2026-10-19T10:00:00Z');   // Monday 10:00 UTC
const HOUR = 3600000, DAY = 86400000;
const ALL = [['00:00', '24:00']];
const FIXTURE = { timezone: 'UTC', workHours: { '0': ALL, '1': ALL, '2': ALL, '3': ALL, '4': ALL, '5': ALL, '6': ALL }, breakIntervalMin: 0 };

async function setup(t) {
  const { createApp } = require('../lib/app.js'), { loadConfig } = require('../lib/config.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tactus-links-'));
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => C0 });
  const server = created.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    created.scheduleService.stop(); created.calendarSync.stop(); await created.repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  assert.strictEqual((await api('PUT', '/api/settings', FIXTURE)).status, 200);
  return { api, repo: created.repo };
}
const blocksOf = async (api, id) => (await api('GET', `/api/tasks/${id}`)).body.blocks;
const mk = async (api, body) => { const r = await api('POST', '/api/tasks', { durationMin: 60, ...body }); assert.strictEqual(r.status, 201, JSON.stringify(r.body)); return r.body; };

test('a task needs no project', async (t) => {
  const { api } = await setup(t);
  const task = await mk(api, { title: 'Solo' });
  assert.strictEqual(task.projectId, null);
  assert.deepStrictEqual([task.blockedBy, task.blocking, task.eventBlocks], [[], [], []]);
  assert.strictEqual((await api('POST', '/api/tasks', { title: 'x', durationMin: 60, stageId: 1 })).status, 400);
});

test('blocked-by: the blocked task is scheduled after its blocker, and blocking is reported', async (t) => {
  const { api } = await setup(t);
  const p = (await api('POST', '/api/projects', { name: 'P' })).body;
  const b = await mk(api, { title: 'B', projectId: p.id, priority: 'low' });
  const a = await mk(api, { title: 'A', projectId: p.id, priority: 'urgent', blockedBy: [b.id] });
  assert.deepStrictEqual(a.blockedBy, [b.id]);
  const [ba] = await blocksOf(api, a.id), [bb] = await blocksOf(api, b.id);
  assert.ok(Date.parse(ba.start) >= Date.parse(bb.end), 'A starts after B ends');
  assert.deepStrictEqual((await api('GET', `/api/tasks/${b.id}`)).body.task.blocking, [a.id]);
});

test('blocked-by validation: same project, no standalone, no self, no cycle', async (t) => {
  const { api } = await setup(t);
  const p1 = (await api('POST', '/api/projects', { name: 'P1' })).body, p2 = (await api('POST', '/api/projects', { name: 'P2' })).body;
  const x = await mk(api, { title: 'X', projectId: p1.id });
  const y = await mk(api, { title: 'Y', projectId: p1.id, blockedBy: [x.id] });
  const other = await mk(api, { title: 'Other', projectId: p2.id });
  const solo = await mk(api, { title: 'Solo' });
  const bad = async (id, body) => assert.strictEqual((await api('PATCH', `/api/tasks/${id}`, body)).status, 400, JSON.stringify(body));
  await bad(y.id, { blockedBy: [other.id] });
  await bad(solo.id, { blockedBy: [x.id] });
  await bad(x.id, { blockedBy: [x.id] });
  await bad(x.id, { blockedBy: [y.id] });                            // y is blocked by x: cycle
  assert.strictEqual((await api('PATCH', `/api/tasks/${y.id}`, { blockedBy: [] })).body.blockedBy.length, 0);
});

test('moving a task to another project drops its links', async (t) => {
  const { api } = await setup(t);
  const p1 = (await api('POST', '/api/projects', { name: 'P1' })).body;
  const x = await mk(api, { title: 'X', projectId: p1.id });
  const y = await mk(api, { title: 'Y', projectId: p1.id, blockedBy: [x.id] });
  const moved = (await api('PATCH', `/api/tasks/${x.id}`, { projectId: null })).body;
  assert.strictEqual(moved.projectId, null);
  assert.deepStrictEqual((await api('GET', `/api/tasks/${y.id}`)).body.task.blockedBy, []);
});

test('blocked by an event: starts after the event ends; a vanished event stops blocking', async (t) => {
  const { api, repo } = await setup(t);
  const cal = await repo.createCalendar({ name: 'C', url: 'https://example.test/c.ics', provider: 'ics' });
  const evStart = new Date(C0 + 2 * HOUR).toISOString(), evEnd = new Date(C0 + 4 * HOUR).toISOString();
  await repo.replaceCalendarEvents(cal.id, [{ uid: 'e1', title: 'Meeting', start: evStart, end: evEnd }]);
  const task = await mk(api, { title: 'After meeting', eventBlocks: [{ calendarId: cal.id, uid: 'e1', start: evStart }] });
  assert.strictEqual(task.eventBlocks[0].title, 'Meeting');
  let [b] = await blocksOf(api, task.id);
  assert.ok(Date.parse(b.start) >= Date.parse(evEnd));
  assert.strictEqual((await api('PATCH', `/api/tasks/${task.id}`, { eventBlocks: [{ calendarId: cal.id, uid: 'nope', start: evStart }] })).status, 400);
  await repo.replaceCalendarEvents(cal.id, []);
  await api('POST', '/api/schedule/run');
  const t2 = (await api('GET', `/api/tasks/${task.id}`)).body;
  assert.strictEqual(t2.task.eventBlocks[0].stale, true);
  b = t2.blocks[0];
  assert.ok(Date.parse(b.start) < Date.parse(evEnd), 'no longer held back');
});

test('blocking an event: the event start becomes the task deadline (the earlier of the two)', async (t) => {
  const { api, repo } = await setup(t);
  const cal = await repo.createCalendar({ name: 'C', url: 'https://example.test/c.ics', provider: 'ics' });
  const evStart = new Date(C0 + 6 * HOUR).toISOString(), evEnd = new Date(C0 + 7 * HOUR).toISOString();
  await repo.replaceCalendarEvents(cal.id, [{ uid: 'e1', title: 'Presentation', start: evStart, end: evEnd }]);
  const task = await mk(api, { title: 'Prepare', durationMin: 120, blocksEvents: [{ calendarId: cal.id, uid: 'e1', start: evStart }] });
  assert.strictEqual(task.blocksEvents[0].title, 'Presentation');
  let data = (await api('GET', `/api/tasks/${task.id}`)).body;
  assert.ok(data.blocks.every((b) => Date.parse(b.end) <= Date.parse(evStart)), 'finishes before the event');
  assert.strictEqual(data.status.state, 'ok');
  // too long to fit before the event: it is at risk against the event start
  await api('PATCH', `/api/tasks/${task.id}`, { durationMin: 600 });
  data = (await api('GET', `/api/tasks/${task.id}`)).body;
  assert.notStrictEqual(data.status.state, 'ok');
  // a vanished event stops constraining it
  await repo.replaceCalendarEvents(cal.id, []);
  await api('POST', '/api/schedule/run');
  data = (await api('GET', `/api/tasks/${task.id}`)).body;
  assert.strictEqual(data.task.blocksEvents[0].stale, true);
  assert.strictEqual(data.status.state, 'ok');
  assert.strictEqual((await api('PATCH', `/api/tasks/${task.id}`, { blocksEvents: [{ calendarId: cal.id, uid: 'nope', start: evStart }] })).status, 400);
});

test('lunch: placed once a day in its window, as a pseudo-event, and tasks avoid it', async (t) => {
  const { api } = await setup(t);
  assert.strictEqual((await api('PUT', '/api/settings', { lunchMin: 60, lunchStart: '12:00', lunchEnd: '14:00' })).status, 200);
  assert.strictEqual((await api('PUT', '/api/settings', { lunchMin: 60, lunchStart: '12:00', lunchEnd: '12:30' })).status, 400);
  const task = await mk(api, { title: 'Long', durationMin: 600 });
  const cal = (await api('GET', `/api/calendar?from=${encodeURIComponent(new Date(C0).toISOString())}&to=${encodeURIComponent(new Date(C0 + 2 * DAY).toISOString())}`)).body;
  const lunches = cal.events.filter((e) => e.uid === 'lunch');
  assert.deepStrictEqual(lunches.map((l) => [l.start, l.end]), [['2026-10-19T12:00:00.000Z', '2026-10-19T13:00:00.000Z'], ['2026-10-20T12:00:00.000Z', '2026-10-20T13:00:00.000Z']]);
  const blocks = (await api('GET', `/api/tasks/${task.id}`)).body.blocks;
  assert.ok(blocks.every((b) => Date.parse(b.end) <= Date.parse(lunches[0].start) || Date.parse(b.start) >= Date.parse(lunches[0].end) || Date.parse(b.start) >= Date.parse(lunches[1].end) || Date.parse(b.end) <= Date.parse(lunches[1].start)));
  assert.ok(blocks.every((b) => !(Date.parse(b.start) < Date.parse(lunches[0].end) && Date.parse(b.end) > Date.parse(lunches[0].start))), 'no block overlaps lunch');
});

test('lunch: drag moves one day\'s lunch, survives reschedule, and tasks plan around it', async (t) => {
  const { api } = await setup(t);
  assert.strictEqual((await api('PUT', '/api/settings', { lunchMin: 60, lunchStart: '12:00', lunchEnd: '14:00' })).status, 200);
  const task = await mk(api, { title: 'Long', durationMin: 600 });
  const from = encodeURIComponent(new Date(C0).toISOString()), to = encodeURIComponent(new Date(C0 + 2 * DAY).toISOString());
  const pairsOf = async () => (await api('GET', `/api/calendar?from=${from}&to=${to}`)).body.events
    .filter((e) => e.uid === 'lunch').map((l) => [l.start, l.end]);
  const move = await api('PUT', '/api/lunch/2026-10-19', { start: '2026-10-19T15:00:00Z' });
  assert.strictEqual(move.status, 200, JSON.stringify(move.body));
  assert.deepStrictEqual(move.body, { date: '2026-10-19', start: '2026-10-19T15:00:00.000Z', end: '2026-10-19T16:00:00.000Z' });
  const expected = [['2026-10-19T15:00:00.000Z', '2026-10-19T16:00:00.000Z'], ['2026-10-20T12:00:00.000Z', '2026-10-20T13:00:00.000Z']];
  assert.deepStrictEqual(await pairsOf(), expected);
  assert.strictEqual((await api('POST', '/api/schedule/run')).status, 200);
  assert.deepStrictEqual(await pairsOf(), expected);
  const blocks = (await api('GET', `/api/tasks/${task.id}`)).body.blocks;
  const ov = (a, b) => blocks.some((x) => Date.parse(x.start) < Date.parse(b) && Date.parse(x.end) > Date.parse(a));
  assert.ok(!ov('2026-10-19T15:00:00Z', '2026-10-19T16:00:00Z'), 'no block overlaps the moved lunch');
  assert.ok(ov('2026-10-19T12:00:00Z', '2026-10-19T13:00:00Z'), 'work fills the old lunch slot');
  const past = await api('PUT', '/api/lunch/2026-10-19', { start: '2026-10-19T09:00:00Z' });
  assert.strictEqual(past.status, 400);
  assert.strictEqual(past.body.error, 'start: must not be in the past');
  const grid = await api('PUT', '/api/lunch/2026-10-19', { start: '2026-10-19T15:10:00Z' });
  assert.strictEqual(grid.status, 400);
  assert.strictEqual(grid.body.error, 'start: must be on the 15-minute grid');
  const wrongDay = await api('PUT', '/api/lunch/2026-10-20', { start: '2026-10-19T15:00:00Z' });
  assert.strictEqual(wrongDay.status, 400);
  assert.strictEqual(wrongDay.body.error, 'start: lunch must start and end on that day');
  const endsNextDay = await api('PUT', '/api/lunch/2026-10-19', { start: '2026-10-19T23:30:00Z' });
  assert.strictEqual(endsNextDay.status, 400);
  assert.strictEqual(endsNextDay.body.error, 'start: lunch must start and end on that day');
  assert.strictEqual((await api('PUT', '/api/lunch/nope', { start: '2026-10-19T15:00:00Z' })).status, 400);
  assert.strictEqual((await api('PUT', '/api/lunch/2026-12-31', { start: '2026-12-31T12:00:00Z' })).status, 400);
  assert.strictEqual((await api('PUT', '/api/settings', { lunchMin: 0 })).status, 200);
  assert.strictEqual((await api('PUT', '/api/lunch/2026-10-20', { start: '2026-10-20T15:00:00Z' })).status, 409);
});

test('lunch: a move to a day with no lunch is refused with 409', async (t) => {
  const { api } = await setup(t);
  assert.strictEqual((await api('PUT', '/api/settings', { lunchMin: 60, lunchStart: '12:00', lunchEnd: '14:00' })).status, 200);
  const off = { ...FIXTURE.workHours, '3': [] };
  assert.strictEqual((await api('PUT', '/api/settings', { workHours: off })).status, 200);
  const cal = (await api('GET', `/api/calendar?from=${encodeURIComponent(new Date(C0).toISOString())}&to=${encodeURIComponent(new Date(C0 + 4 * DAY).toISOString())}`)).body;
  assert.ok(!cal.events.some((e) => e.uid === 'lunch' && e.start.startsWith('2026-10-21')), 'Wednesday has no lunch');
  const r = await api('PUT', '/api/lunch/2026-10-21', { start: '2026-10-21T15:00:00Z' });
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'no lunch that day');
});

test('lunch: a missed lunch today can be moved to a later time and survives reschedule', async (t) => {
  const { api, repo } = await setup(t);
  assert.strictEqual((await api('PUT', '/api/settings', { lunchMin: 60, lunchStart: '12:00', lunchEnd: '14:00' })).status, 200);
  const task = await mk(api, { title: 'Long', durationMin: 600 });
  const from = encodeURIComponent(new Date(C0 - DAY).toISOString()), to = encodeURIComponent(new Date(C0 + 2 * DAY).toISOString());
  const pairsOf = async () => (await api('GET', `/api/calendar?from=${from}&to=${to}`)).body.events
    .filter((e) => e.uid === 'lunch').map((l) => [l.start, l.end]);
  await repo.setMeta('lunchBlocks', [{ start: '2026-10-18T12:00:00.000Z', end: '2026-10-18T13:00:00.000Z' }, { start: '2026-10-19T08:00:00.000Z', end: '2026-10-19T09:00:00.000Z' }]);
  assert.strictEqual((await api('POST', '/api/schedule/run')).status, 200);
  assert.deepStrictEqual(await pairsOf(), [
    ['2026-10-18T12:00:00.000Z', '2026-10-18T13:00:00.000Z'],
    ['2026-10-19T08:00:00.000Z', '2026-10-19T09:00:00.000Z'],
    ['2026-10-20T12:00:00.000Z', '2026-10-20T13:00:00.000Z'],
  ]);
  const move = await api('PUT', '/api/lunch/2026-10-19', { start: '2026-10-19T15:00:00Z' });
  assert.strictEqual(move.status, 200, JSON.stringify(move.body));
  assert.deepStrictEqual(move.body, { date: '2026-10-19', start: '2026-10-19T15:00:00.000Z', end: '2026-10-19T16:00:00.000Z' });
  const expected = [
    ['2026-10-18T12:00:00.000Z', '2026-10-18T13:00:00.000Z'],
    ['2026-10-19T15:00:00.000Z', '2026-10-19T16:00:00.000Z'],
    ['2026-10-20T12:00:00.000Z', '2026-10-20T13:00:00.000Z'],
  ];
  assert.deepStrictEqual(await pairsOf(), expected);
  assert.strictEqual((await api('POST', '/api/schedule/run')).status, 200);
  assert.deepStrictEqual(await pairsOf(), expected);
  const blocks = (await api('GET', `/api/tasks/${task.id}`)).body.blocks;
  assert.ok(blocks.every((b) => Date.parse(b.start) >= C0), 'no block starts before now');
  assert.ok(!blocks.some((x) => Date.parse(x.start) < Date.parse('2026-10-19T16:00:00Z') && Date.parse(x.end) > Date.parse('2026-10-19T15:00:00Z')), 'no block overlaps the moved lunch');
  const past = await api('PUT', '/api/lunch/2026-10-19', { start: '2026-10-19T09:00:00Z' });
  assert.strictEqual(past.status, 400);
  assert.strictEqual(past.body.error, 'start: must not be in the past');
  assert.strictEqual((await api('PUT', '/api/lunch/2026-10-18', { start: '2026-10-18T13:00:00Z' })).status, 400);
  assert.deepStrictEqual(await repo.getMeta('lunchOverrides'), { '2026-10-19': '15:00' });
});

test('a task can be set to block other tasks of its project', async (t) => {
  const { api } = await setup(t);
  const p = (await api('POST', '/api/projects', { name: 'P' })).body;
  const a = await mk(api, { title: 'A', projectId: p.id });
  const b = await mk(api, { title: 'B', projectId: p.id, blocking: [] });
  const c = await mk(api, { title: 'C', projectId: p.id, blocking: [a.id] });
  assert.deepStrictEqual((await api('GET', `/api/tasks/${a.id}`)).body.task.blockedBy, [c.id]);
  assert.strictEqual((await api('PATCH', `/api/tasks/${c.id}`, { blocking: [a.id, b.id] })).status, 200);
  assert.deepStrictEqual((await api('GET', `/api/tasks/${c.id}`)).body.task.blocking.sort(), [a.id, b.id].sort());
  assert.strictEqual((await api('PATCH', `/api/tasks/${c.id}`, { blocking: [b.id] })).status, 200);
  assert.deepStrictEqual((await api('GET', `/api/tasks/${a.id}`)).body.task.blockedBy, []);
  // c blocks b, so b cannot block c
  const bad = await api('PATCH', `/api/tasks/${b.id}`, { blocking: [c.id] });
  assert.strictEqual(bad.status, 400);
  const solo = await mk(api, { title: 'Solo' });
  assert.strictEqual((await api('PATCH', `/api/tasks/${solo.id}`, { blocking: [a.id] })).status, 400);
});

test('stage deadline changes flow to its tasks; extending can shift or resize later stages', async (t) => {
  const { api } = await setup(t);
  const p = (await api('POST', '/api/projects', { name: 'P' })).body;
  const D = (n) => new Date(C0 + n * DAY).toISOString();
  const s1 = (await api('POST', `/api/projects/${p.id}/stages`, { name: 'S1', deadline: D(5), deadlineType: 'hard' })).body;
  const s2 = (await api('POST', `/api/projects/${p.id}/stages`, { name: 'S2', deadline: D(10), deadlineType: 'hard' })).body;
  const s3 = (await api('POST', `/api/projects/${p.id}/stages`, { name: 'S3', deadline: D(20), deadlineType: 'hard' })).body;
  const t1 = await mk(api, { title: 'T1', projectId: p.id, stageId: s1.id, deadline: D(4) });
  const t2 = await mk(api, { title: 'T2', projectId: p.id, stageId: s2.id });
  const get = async (id) => (await api('GET', `/api/tasks/${id}`)).body.task;
  const dl = async (id) => (await api('GET', '/api/projects')).body.find((x) => x.id === p.id).stages.find((x) => x.id === id).deadline;
  await api('PATCH', `/api/stages/${s1.id}`, { deadline: D(6), deadlineType: 'soft', laterStages: 'extend' });
  assert.deepStrictEqual([(await get(t1.id)).deadline, (await get(t1.id)).deadlineType], [D(6), 'soft']);
  assert.strictEqual((await get(t2.id)).deadline, D(11));
  assert.deepStrictEqual([await dl(s2.id), await dl(s3.id)], [D(11), D(21)]);
  // resize: s2 and s3 squeezed between the new s1 deadline (D8) and the original final D21
  await api('PATCH', `/api/stages/${s1.id}`, { deadline: D(8), laterStages: 'resize' });
  assert.strictEqual(await dl(s3.id), D(21));
  assert.strictEqual(await dl(s2.id), new Date(C0 + Math.round(8 * DAY + (5 / 15) * 13 * DAY)).toISOString());
  assert.strictEqual((await api('PATCH', `/api/stages/${s1.id}`, { deadline: D(30), laterStages: 'resize' })).status, 400);
});

test('a droppable low-priority recurring occurrence is dropped to meet a deadline, and only then', async (t) => {
  const { api } = await setup(t);
  const rec = { title: 'Tidy', frequency: 'daily', durationMin: 480, priority: 'low', startDate: '2026-10-19', droppable: true };
  assert.strictEqual((await api('POST', '/api/recurring', { ...rec, priority: 'high' })).status, 400);
  assert.strictEqual((await api('POST', '/api/recurring', rec)).status, 201);
  const task = await mk(api, { title: 'Big', durationMin: 780, deadline: new Date(C0 + 14 * HOUR).toISOString(), deadlineType: 'hard' });
  await api('POST', '/api/schedule/run');
  const st = (await api('GET', `/api/tasks/${task.id}`)).body.status;
  assert.ok(['ok', 'tight'].includes(st.state), st.state);
  const status =(await api('GET', '/api/status')).body;
  assert.ok(status.dropped.some((d) => d.occurrenceDate === '2026-10-19'), JSON.stringify(status.dropped));
  assert.ok(!status.dropped.some((d) => d.occurrenceDate === '2026-10-20'));
});

test('a weekly budget with no weekdays is spread over the week, not packed into Monday', async (t) => {
  const { api } = await setup(t);
  assert.strictEqual((await api('POST', '/api/recurring', { title: 'Learn', frequency: 'weekly', durationMin: 600, priority: 'medium', startDate: '2026-10-19' })).status, 201);
  const cal = (await api('GET', `/api/calendar?from=${encodeURIComponent(new Date(C0).toISOString())}&to=${encodeURIComponent(new Date(C0 + 7 * DAY).toISOString())}`)).body;
  const days = new Set(cal.blocks.filter((b) => b.kind === 'recurring').map((b) => b.start.slice(0, 10)));
  assert.ok(days.size >= 5, [...days].join());
});

test('task links stay inside one stage; a task with no stage may link to any task of its project', async (t) => {
  const { api } = await setup(t);
  const p = (await api('POST', '/api/projects', { name: 'P' })).body;
  const s1 = (await api('POST', `/api/projects/${p.id}/stages`, { name: 'S1' })).body;
  const s2 = (await api('POST', `/api/projects/${p.id}/stages`, { name: 'S2' })).body;
  const a = await mk(api, { title: 'A', projectId: p.id, stageId: s1.id });
  const b = await mk(api, { title: 'B', projectId: p.id, stageId: s2.id });
  const loose = await mk(api, { title: 'Loose', projectId: p.id });
  assert.strictEqual((await api('PATCH', `/api/tasks/${a.id}`, { blockedBy: [b.id] })).status, 400);
  assert.strictEqual((await api('PATCH', `/api/tasks/${a.id}`, { blocking: [b.id] })).status, 400);
  assert.strictEqual((await api('PATCH', `/api/tasks/${loose.id}`, { blockedBy: [a.id, b.id] })).status, 200);
});
