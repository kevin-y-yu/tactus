// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';
// v2 Chunk 24 — T-V2-ICS-1…12. Spec spec-v2 §R7 Acceptance.
const test = require('node:test');
const assert = require('node:assert');

const mod = () => import('../public/js/calendarUrlHint.js');

const GOOGLE_ICS = 'https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/private-xyz/basic.ics';
const ICLOUD = 'webcal://p12-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEy';
const OUTLOOK_ICS = 'https://outlook.office365.com/owa/calendar/abc@example.com/xyz123/calendar.ics';

test('T-V2-ICS-1: empty input is level none', async () => {
  const { calendarUrlHint } = await mod();
  assert.deepStrictEqual(calendarUrlHint('', 'google'), { level: 'none', message: '' });
  assert.deepStrictEqual(calendarUrlHint('   ', 'other'), { level: 'none', message: '' });
  assert.deepStrictEqual(calendarUrlHint(undefined, 'other'), { level: 'none', message: '' });
});

test('T-V2-ICS-2: unparseable or bad-protocol input is an error', async () => {
  const { calendarUrlHint } = await mod();
  const expected = { level: 'error', message: 'Use the https:// or webcal:// link.' };
  assert.deepStrictEqual(calendarUrlHint('not a url', 'other'), expected);
  assert.deepStrictEqual(calendarUrlHint('ftp://example.com/cal.ics', 'other'), expected);
  assert.deepStrictEqual(calendarUrlHint('mailto:a@b.com', 'other'), expected);
});

test('T-V2-ICS-3: Google iCal link is ok for google (https and webcal)', async () => {
  const { calendarUrlHint } = await mod();
  const expected = { level: 'ok', message: 'Looks like a Google iCal address.' };
  assert.deepStrictEqual(calendarUrlHint(GOOGLE_ICS, 'google'), expected);
  assert.deepStrictEqual(calendarUrlHint(GOOGLE_ICS.replace('https:', 'webcal:'), 'google'), expected);
});

test('T-V2-ICS-4: Google share links are errors, even under another provider', async () => {
  const { calendarUrlHint } = await mod();
  const expected = { level: 'error', message: "This is a Google share link. Copy 'Secret address in iCal format' instead." };
  assert.deepStrictEqual(calendarUrlHint('https://calendar.google.com/calendar/embed?src=abc%40gmail.com&ctz=Europe%2FLondon', 'google'), expected);
  assert.deepStrictEqual(calendarUrlHint('https://calendar.google.com/calendar/u/0?cid=YWJjQGdtYWlsLmNvbQ', 'google'), expected);
  assert.deepStrictEqual(calendarUrlHint('https://calendar.google.com/calendar/r', 'google'), expected);
  assert.deepStrictEqual(calendarUrlHint('https://calendar.google.com/calendar/embed?src=abc%40gmail.com&ctz=Europe%2FLondon', 'outlook'), expected);
});

test('T-V2-ICS-5: iCloud published link is ok, host match is case-insensitive', async () => {
  const { calendarUrlHint } = await mod();
  const expected = { level: 'ok', message: 'Looks like an iCloud public calendar link.' };
  assert.deepStrictEqual(calendarUrlHint(ICLOUD, 'icloud'), expected);
  assert.deepStrictEqual(calendarUrlHint('webcal://P12-CalDAV.iCloud.com/published/2/AbC', 'icloud'), expected);
});

test('T-V2-ICS-6: Outlook ICS link is ok on all three Outlook hosts', async () => {
  const { calendarUrlHint } = await mod();
  const expected = { level: 'ok', message: 'Looks like an Outlook ICS link.' };
  assert.deepStrictEqual(calendarUrlHint(OUTLOOK_ICS, 'outlook'), expected);
  assert.deepStrictEqual(calendarUrlHint(OUTLOOK_ICS.replace('outlook.office365.com', 'outlook.live.com'), 'outlook'), expected);
  assert.deepStrictEqual(calendarUrlHint(OUTLOOK_ICS.replace('outlook.office365.com', 'outlook.office.com'), 'outlook'), expected);
});

test('T-V2-ICS-7: Outlook HTML link is an error', async () => {
  const { calendarUrlHint } = await mod();
  assert.deepStrictEqual(calendarUrlHint(OUTLOOK_ICS.replace('calendar.ics', 'calendar.html'), 'outlook'),
    { level: 'error', message: 'This is the HTML link. Copy the ICS link instead.' });
});

test('T-V2-ICS-8: mismatch warns only for a specific non-matching provider', async () => {
  const { calendarUrlHint } = await mod();
  assert.deepStrictEqual(calendarUrlHint(GOOGLE_ICS, 'outlook'), { level: 'warn', message: 'This looks like a Google link.' });
  assert.deepStrictEqual(calendarUrlHint(ICLOUD, 'google'), { level: 'warn', message: 'This looks like an iCloud link.' });
  assert.deepStrictEqual(calendarUrlHint(OUTLOOK_ICS, 'icloud'), { level: 'warn', message: 'This looks like an Outlook link.' });
  const google = { level: 'ok', message: 'Looks like a Google iCal address.' };
  assert.deepStrictEqual(calendarUrlHint(GOOGLE_ICS, 'other'), google);
  assert.deepStrictEqual(calendarUrlHint(GOOGLE_ICS, undefined), google);
});

test('T-V2-ICS-9: http link warns as not encrypted; recognised http link still matches first', async () => {
  const { calendarUrlHint } = await mod();
  assert.deepStrictEqual(calendarUrlHint('http://example.com/cal.ics', 'other'), { level: 'warn', message: 'This link is not encrypted.' });
  assert.deepStrictEqual(calendarUrlHint(GOOGLE_ICS.replace('https:', 'http:'), 'google'),
    { level: 'ok', message: 'Looks like a Google iCal address.' });
});

test('T-V2-ICS-10: unrecognised links warn', async () => {
  const { calendarUrlHint } = await mod();
  const expected = { level: 'warn', message: 'Unrecognised link. Tactus will try it.' };
  assert.deepStrictEqual(calendarUrlHint('https://example.com/cal.ics', 'other'), expected);
  assert.deepStrictEqual(calendarUrlHint('webcal://example.com/feed', 'google'), expected);
  assert.deepStrictEqual(calendarUrlHint('https://www.icloud.com/calendar/', 'icloud'), expected);
});

test('T-V2-ICS-11: addResultMessage maps calendar results to ok, warn or error', async () => {
  const { addResultMessage } = await mod();
  assert.deepStrictEqual(addResultMessage({ lastError: 'HTTP 404', eventCount: 0 }),
    { level: 'error', text: "Couldn't read this link: HTTP 404" });
  assert.deepStrictEqual(addResultMessage({ lastError: null, eventCount: 0 }),
    { level: 'warn', text: 'Linked, but no events found in the next few weeks. Check you copied the right calendar.' });
  assert.deepStrictEqual(addResultMessage({ lastError: null, eventCount: 1 }), { level: 'ok', text: 'Linked. Found 1 event.' });
  assert.deepStrictEqual(addResultMessage({ lastError: null, eventCount: 12 }), { level: 'ok', text: 'Linked. Found 12 events.' });
});

test('T-V2-ICS-12: PROVIDERS keys, labels and steps', async () => {
  const { PROVIDERS } = await mod();
  assert.deepStrictEqual(PROVIDERS.map((p) => p.key), ['google', 'icloud', 'outlook', 'other']);
  assert.deepStrictEqual(PROVIDERS.map((p) => p.label), ['Google Calendar', 'Apple iCloud', 'Outlook / Microsoft 365', 'Other (.ics link)']);
  for (const p of PROVIDERS) {
    assert.ok(Array.isArray(p.steps) && p.steps.length > 0, `${p.key} steps non-empty`);
    for (const s of p.steps) assert.strictEqual(typeof s, 'string');
  }
  assert.deepStrictEqual(PROVIDERS.find((p) => p.key === 'other').steps, ['Paste any https:// or webcal:// link that ends in .ics.']);
});
