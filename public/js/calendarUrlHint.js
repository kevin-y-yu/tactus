// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Pure helpers for the "Link a calendar" panel (v2 chunk 24, spec v2 §R7). No DOM, no fetch.
export const PROVIDERS = [
  { key: 'google', label: 'Google Calendar', short: 'Google', article: 'a', steps: [
    'On a computer, open Google Calendar → Settings (gear) → Settings.',
    "Under 'Settings for my calendars' pick the calendar → 'Integrate calendar'.",
    "Copy 'Secret address in iCal format' (ends in .ics). Keep it private.",
    'Google can take several hours to show changes.'] },
  { key: 'icloud', label: 'Apple iCloud', short: 'iCloud', article: 'an', steps: [
    'In the Calendar app (Mac) or icloud.com/calendar, click the share icon next to the calendar.',
    "Turn on 'Public Calendar' and copy the link (starts with webcal://).",
    'Anyone with the link can read the calendar.'] },
  { key: 'outlook', label: 'Outlook / Microsoft 365', short: 'Outlook', article: 'an', steps: [
    "In Outlook on the web: Settings (gear) → Calendar → Shared calendars → 'Publish a calendar'.",
    "Pick the calendar and 'Can view all details', click Publish, then copy the ICS link.",
    'Work accounts may have publishing turned off by IT.'] },
  { key: 'other', label: 'Other (.ics link)', short: 'Other', article: 'an', steps: [
    'Paste any https:// or webcal:// link that ends in .ics.'] },
];

const OUTLOOK_HOSTS = ['outlook.office365.com', 'outlook.live.com', 'outlook.office.com'];
const PROTOCOLS = ['http:', 'https:', 'webcal:'];

// url: raw input string; provider: selected tab key. Returns {level:'none'|'ok'|'warn'|'error', message}.
export function calendarUrlHint(url, provider) {
  const s = typeof url === 'string' ? url.trim() : '';
  if (s === '') return { level: 'none', message: '' };
  let u = null;
  try { u = new URL(s); } catch { u = null; }
  if (!u || !PROTOCOLS.includes(u.protocol) || !u.hostname) return { level: 'error', message: 'Use the https:// or webcal:// link.' };
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  let detected = null;           // provider key of an ok match
  let okMessage = '';
  if (host === 'calendar.google.com') {
    if (path.includes('/ical/') && path.endsWith('.ics')) { detected = 'google'; okMessage = 'Looks like a Google iCal address.'; }
    else return { level: 'error', message: "This is a Google share link. Copy 'Secret address in iCal format' instead." };
  } else if ((host === 'icloud.com' || host.endsWith('.icloud.com')) && path.includes('/published/')) {
    detected = 'icloud'; okMessage = 'Looks like an iCloud public calendar link.';
  } else if (OUTLOOK_HOSTS.includes(host) && path.endsWith('.ics')) {
    detected = 'outlook'; okMessage = 'Looks like an Outlook ICS link.';
  } else if (OUTLOOK_HOSTS.includes(host) && path.endsWith('.html')) {
    return { level: 'error', message: 'This is the HTML link. Copy the ICS link instead.' };
  }
  if (detected) {
    const selected = PROVIDERS.some((p) => p.key === provider) ? provider : 'other';
    if (selected !== 'other' && selected !== detected) {
      const p = PROVIDERS.find((x) => x.key === detected);
      return { level: 'warn', message: `This looks like ${p.article} ${p.short} link.` };
    }
    return { level: 'ok', message: okMessage };
  }
  if (u.protocol === 'http:') return { level: 'warn', message: 'This link is not encrypted.' };
  return { level: 'warn', message: 'Unrecognised link. Tactus will try it.' };
}

// cal: API Calendar returned by POST/PATCH /calendars. Returns {level:'ok'|'warn'|'error', text}.
export function addResultMessage(cal) {
  if (cal.lastError) return { level: 'error', text: `Couldn't read this link: ${cal.lastError}` };
  const n = Number(cal.eventCount) || 0;
  if (n === 0) return { level: 'warn', text: 'Linked, but no events found in the next few weeks. Check you copied the right calendar.' };
  return { level: 'ok', text: `Linked. Found ${n} ${n === 1 ? 'event' : 'events'}.` };
}
