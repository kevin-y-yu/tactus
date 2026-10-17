// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// Hardening: auth gate before body parsing (H-JSON), AUTH_TOKEN strength at startup (H-TOK),
// PATCH calendar url during an in-flight refresh (H-CAL).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../lib/app.js');
const { loadConfig, assertAuthTokenStrength } = require('../lib/config.js');

const C0 = Date.parse('2026-10-19T10:00:00Z');
const ALL = [['00:00', '24:00']];
const FIXTURE = { timezone: 'UTC', workHours: { '0': ALL, '1': ALL, '2': ALL, '3': ALL, '4': ALL, '5': ALL, '6': ALL }, breakIntervalMin: 0 };
const BEARER = { authorization: 'Bearer s3cret' };
const BAD_JSON = '{"title":';
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tactus-test-'));

// Same as test/api.test.js serve(), but returns { api, base } so tests can also send raw (malformed) bodies.
async function serve(t, created, tmp, setupHeaders = {}) {
  const server = created.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    created.scheduleService.stop(); created.calendarSync.stop(); await created.repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const put = await api('PUT', '/api/settings', FIXTURE, setupHeaders);
  assert.strictEqual(put.status, 200);
  return { api, base };
}
const raw = async (base, method, url, text, headers = {}) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: text });
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null, headers: res.headers };
};
async function appWith(t, env = {}) {
  const tmp = mkTmp();
  const created = await createApp(loadConfig({ DATA_DIR: tmp, ...env }), { now: () => C0 });
  return serve(t, created, tmp, env.AUTH_TOKEN ? { authorization: `Bearer ${env.AUTH_TOKEN}` } : {});
}

// ---------- H-JSON: unauthenticated requests are refused before the body is parsed ----------

test('H-JSON-1: unauthenticated malformed JSON to gated routes is 401', async (t) => {
  const { api, base } = await appWith(t, { AUTH_TOKEN: 's3cret' });
  for (const [m, u] of [['POST', '/api/tasks'], ['PATCH', '/api/settings'], ['POST', '/api/no-such-route']]) {
    const r = await raw(base, m, u, BAD_JSON);
    assert.strictEqual(r.status, 401, `${m} ${u}`);
    assert.deepStrictEqual(r.body, { error: 'authentication required' });
  }
  assert.strictEqual((await api('GET', '/api/health')).status, 200);
  assert.strictEqual((await fetch(base + '/')).status, 200);
});

test('H-JSON-2: authenticated malformed JSON is 400 invalid JSON', async (t) => {
  const { base } = await appWith(t, { AUTH_TOKEN: 's3cret' });
  const r = await raw(base, 'POST', '/api/tasks', BAD_JSON, BEARER);
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(r.body, { error: 'body: invalid JSON' });
});

test('H-JSON-3: login still parses its JSON body; a malformed login body is 400', async (t) => {
  const { api, base } = await appWith(t, { AUTH_TOKEN: 's3cret' });
  const bad = await raw(base, 'POST', '/api/auth/login', BAD_JSON);
  assert.strictEqual(bad.status, 400);
  assert.deepStrictEqual(bad.body, { error: 'body: invalid JSON' });
  const wrong = await api('POST', '/api/auth/login', { password: 'wrong' });
  assert.strictEqual(wrong.status, 401);
  assert.deepStrictEqual(wrong.body, { error: 'invalid password' });
  const ok = await api('POST', '/api/auth/login', { password: 's3cret' });
  assert.strictEqual(ok.status, 204);
  assert.strictEqual(ok.headers.getSetCookie().filter((c) => c.startsWith('tactus_session=')).length, 1);
});

test('H-JSON-4: with auth off, malformed JSON is still 400', async (t) => {
  const { base } = await appWith(t);
  const r = await raw(base, 'POST', '/api/tasks', BAD_JSON);
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(r.body, { error: 'body: invalid JSON' });
});

// ---------- H-TOK: AUTH_TOKEN must be at least 24 characters at startup ----------

const WEAK = 'AUTH_TOKEN must be at least 24 characters (generate one with: openssl rand -hex 24)';

test('H-TOK-1: a 23-character AUTH_TOKEN is rejected with the fixed message, which never contains the token', () => {
  const token = 'Zq7'.repeat(7) + 'Zq';                     // 23 characters
  assert.strictEqual(token.length, 23);
  assert.throws(() => assertAuthTokenStrength(loadConfig({ AUTH_TOKEN: token })), (err) => {
    assert.strictEqual(err.message, WEAK);
    assert.strictEqual(err.message.includes(token), false);
    assert.strictEqual(err.message.includes('Zq7'), false);
    return true;
  });
});

test('H-TOK-2: a 24-character AUTH_TOKEN is accepted', () => {
  assert.doesNotThrow(() => assertAuthTokenStrength(loadConfig({ AUTH_TOKEN: 'a'.repeat(24) })));
});

test('H-TOK-3: unset or empty AUTH_TOKEN (auth off) is accepted', () => {
  assert.doesNotThrow(() => assertAuthTokenStrength(loadConfig({})));
  assert.doesNotThrow(() => assertAuthTokenStrength(loadConfig({ AUTH_TOKEN: '' })));
});

test('H-TOK-4: server.js exits 1 with only the message when AUTH_TOKEN is short', () => {
  const tmp = mkTmp();
  try {
    const token = 'tooShortSecretXyz';
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, AUTH_TOKEN: token, DATA_DIR: tmp, PORT: '0', HOST: '127.0.0.1' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stderr.trim(), WEAK);
    assert.strictEqual(`${r.stdout}${r.stderr}`.includes(token), false);
    assert.strictEqual(fs.existsSync(path.join(tmp, 'tactus.db')), false);    // refused before opening the database
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- H-CAL: PATCH url during an in-flight refresh ----------

const OLD_URL = 'https://feeds.test/old.ics', NEW_URL = 'https://feeds.test/new.ics';
const ics = (events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tactus//Hardening Test//EN',
  ...events.flatMap(([uid, day]) => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z',
    `DTSTART:202610${day}T090000Z`, `DTEND:202610${day}T100000Z`, `SUMMARY:${uid}`, 'END:VEVENT']),
  'END:VCALENDAR', ''].join('\r\n');
const OLD_ICS = ics([['OLD-1', '20'], ['OLD-2', '21']]);                   // stored by POST
const OLD_LATER_ICS = ics([['OLD-3', '23'], ['OLD-4', '24'], ['OLD-5', '25']]); // what the held old fetch returns
const NEW_ICS = ics([['NEW-1', '22']]);
const icsResponse = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/calendar' } });

// Fake fetch: answers at once, except the OLD_URL call made after hold(), which stays open until release() (answers
// OLD_LATER_ICS, which differs from what is stored and from NEW_ICS) or fail(err).
function feeds() {
  const calls = [];
  let holdNext = false, pending = null, markStarted;
  const started = new Promise((r) => { markStarted = r; });
  const fetchImpl = async (u) => {
    const url = String(u); calls.push(url);
    if (url === OLD_URL && holdNext) {
      holdNext = false; markStarted();
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    }
    return icsResponse(url === OLD_URL ? OLD_ICS : NEW_ICS);
  };
  return { fetchImpl, calls, started, hold: () => { holdNext = true; },
    release: () => pending.resolve(icsResponse(OLD_LATER_ICS)), fail: (err) => pending.reject(err) };
}
async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const titlesOf = async (repo, calendarId) => (await repo.listEventsInRange('2026-10-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'))
  .filter((e) => e.calendarId === calendarId).map((e) => e.title);

// Create the calendar on OLD_URL, then record every calendar write and console.warn, hold a timer-style refresh open,
// PATCH the url to NEW_URL and wait until the row has the new url. The caller then releases or fails the old fetch.
async function raceSetup(t) {
  const tmp = mkTmp();
  const f = feeds();
  const created = await createApp(loadConfig({ DATA_DIR: tmp }), { now: () => C0, fetchImpl: f.fetchImpl });
  const { api } = await serve(t, created, tmp);
  const c = await api('POST', '/api/calendars', { name: 'Feed', url: OLD_URL });
  assert.strictEqual(c.status, 201);
  assert.strictEqual(c.body.eventCount, 2);
  const id = c.body.id;
  const writes = { replace: [], fetchResults: [] };
  const { repo } = created;
  const origReplace = repo.replaceCalendarEvents, origResult = repo.setCalendarFetchResult;
  repo.replaceCalendarEvents = async (cid, events) => { writes.replace.push(events.map((e) => e.title)); return origReplace(cid, events); };
  repo.setCalendarFetchResult = async (cid, r) => { writes.fetchResults.push({ lastError: r.lastError ?? null, eventCount: r.eventCount }); return origResult(cid, r); };
  const warn = t.mock.method(console, 'warn', () => {});
  f.hold();
  const timerRun = created.calendarSync.refreshCalendar(id);       // stands in for the 60 s timer tick
  await f.started;
  const patching = api('PATCH', `/api/calendars/${id}`, { url: NEW_URL });
  await waitFor(async () => (await repo.getCalendar(id)).url === NEW_URL);
  await new Promise((r) => setImmediate(r));
  return { f, created, id, timerRun, patching, writes, warn };
}

test('H-CAL-1: PATCH url during an in-flight refresh stores and returns the new feed; the old result is dropped', async (t) => {
  const { f, created, id, timerRun, patching, writes } = await raceSetup(t);
  f.release();
  const res = await patching;
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.eventCount, 1);
  assert.strictEqual(res.body.lastError, null);
  assert.strictEqual(res.body.urlRedacted, 'https://feeds.test/...');
  assert.strictEqual(JSON.stringify(res.body).includes('old.ics'), false);
  assert.strictEqual(JSON.stringify(res.body).includes('new.ics'), false);
  assert.deepStrictEqual(await timerRun, { changed: false });
  assert.deepStrictEqual(writes.replace, [['NEW-1']]);                         // superseded run replaced nothing
  assert.deepStrictEqual(writes.fetchResults, [{ lastError: null, eventCount: 1 }]);
  assert.deepStrictEqual(await titlesOf(created.repo, id), ['NEW-1']);
  assert.strictEqual(f.calls.filter((u) => u === NEW_URL).length, 1);
});

test('H-CAL-2: a superseded refresh whose old fetch fails writes no lastError and logs no warning', async (t) => {
  const { f, created, id, timerRun, patching, writes, warn } = await raceSetup(t);
  f.fail(new Error('boom https://feeds.test/old.ics'));
  const res = await patching;
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.eventCount, 1);
  assert.strictEqual(res.body.lastError, null);
  assert.deepStrictEqual(await timerRun, { changed: false });
  assert.deepStrictEqual(writes.fetchResults, [{ lastError: null, eventCount: 1 }]);  // no lastError write by the old run
  assert.deepStrictEqual(writes.replace, [['NEW-1']]);
  assert.strictEqual(warn.mock.calls.filter((c) => String(c.arguments[0]).includes('refresh failed')).length, 0);
  assert.deepStrictEqual(await titlesOf(created.repo, id), ['NEW-1']);
});
