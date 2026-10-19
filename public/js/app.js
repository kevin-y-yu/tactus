// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Browser entry (spec §10.1). The only module that touches the DOM at load.
import * as api from './api.js';
import { state, loadAll, refresh, subscribe } from './state.js';
import { h, clear, toast, closePopover, parseRoute } from './ui.js';
import { setNewTaskContext, getNewTaskContext, newTaskHash } from './newTask.js';

// Route table (§10.1). Modules owned by Chunks 12-14 may not exist yet -> placeholder.
const VIEW_MODULES = {
  week: './views/calendar.js',
  day: './views/calendar.js',
  agenda: './views/agenda.js',
  projects: './views/projects.js',
  task: './views/projects.js',      // #/task/<id>: projects view + editor modal (Chunk 13)
  recurring: './views/recurring.js',
  settings: './views/settings.js',
};
const VIEW_TITLES = { agenda: 'Agenda', projects: 'Projects', task: 'Task', recurring: 'Recurring', settings: 'Settings',
                      login: 'Sign in', riskPanel: 'Risks' };
const POLL_MS = 60000;
const NAV_ROUTE = { task: 'projects' };   // which nav link is active for a route

let started = false;        // listeners/poll registered once
let viewCleanup = null;
let asideCleanup = null;
let mountSeq = 0;
let baseHash = null;        // hash of the mounted non-task view; a task editor opened from it overlays it instead of replacing it
let editorCleanup = null;
const ctx = { navigate: (hash) => { location.hash = hash; }, restart: () => start() };
const el = (id) => document.getElementById(id);

async function loadModule(path) {
  try { const m = await import(path); return typeof m.render === 'function' ? m : null; } catch { return null; }
}
function placeholder(container, title) {
  clear(container);
  container.append(h('section', { class: 'placeholder' }, h('h2', {}, title), h('p', {}, 'This view is not available yet.')));
}
// Mounts module `path` into container; returns its cleanup (or null).
async function mount(container, path, route, title) {
  const m = await loadModule(path);
  clear(container);
  if (!m) { placeholder(container, title); return null; }
  const c = m.render(container, route, ctx);
  return typeof c === 'function' ? c : null;
}
async function renderRoute() {
  const route = parseRoute(location.hash);
  if (!route) { location.replace('#/week'); return; }   // replace fires hashchange -> renderRoute again
  const seq = ++mountSeq;
  closePopover();
  if (editorCleanup) { editorCleanup(); editorCleanup = null; }
  if (baseHash && route.name === 'task') {
    // Open the editor over the view the user came from, so Esc returns to it (no remount, selection kept).
    const m = await import('./views/taskEditor.js').catch(() => null);
    if (seq !== mountSeq) return;
    if (m) {
      const back = baseHash;
      editorCleanup = m.openTaskEditor({ id: route.params.id, query: route.query, onClose: () => ctx.navigate(back) });
      return;
    }
  }
  if (baseHash && location.hash === baseHash) return;   // editor closed: the base view is still mounted
  baseHash = null;
  if (viewCleanup) { viewCleanup(); viewCleanup = null; }
  setActiveNav(route.name);
  el('app-header').classList.remove('nav-open');
  setNewTaskContext(null);
  const cleanup = await mount(el('view'), VIEW_MODULES[route.name], route, VIEW_TITLES[route.name] || 'View');
  if (seq !== mountSeq) { if (cleanup) cleanup(); return; }   // a newer navigation won
  viewCleanup = cleanup;
  baseHash = route.name === 'task' ? null : location.hash;
}

function setActiveNav(name) {
  for (const a of el('nav').querySelectorAll('a')) {
    a.classList.toggle('active', a.dataset.route === (NAV_ROUTE[name] || name));
  }
}

function renderBanner() {
  const banner = el('tz-banner');
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  clear(banner);
  if (state.settings && state.settings.timezone !== browserTz) {
    banner.append(
      h('span', {}, `Times are shown in ${state.settings.timezone}; this browser is in ${browserTz}. `),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        try { await api.putSettings({ timezone: browserTz }); await refresh(); } catch (e) { toast(e.message, 'error'); }
      } }, `Use ${browserTz}`));
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

async function showLogin() {
  mountSeq++;
  if (viewCleanup) { viewCleanup(); viewCleanup = null; }
  if (asideCleanup) { asideCleanup(); asideCleanup = null; }
  clear(el('risk-panel'));
  viewCleanup = await mount(el('view'), './views/login.js', { name: 'login', params: {}, query: new URLSearchParams() }, 'Sign in');
}

function wireOnce() {
  if (started) return;
  started = true;
  el('menu-toggle').addEventListener('click', () => {
    const open = el('app-header').classList.toggle('nav-open');
    el('menu-toggle').setAttribute('aria-expanded', String(open));
  });
  el('btn-refresh-calendars').addEventListener('click', async () => {
    try { await api.refreshAllCalendars(); await refresh(); toast('Calendars refreshed'); } catch (e) { toast(e.message, 'error'); }
  });
  el('btn-reschedule').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try { await api.runSchedule(); await refresh(); toast('Rescheduled'); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
  });
  el('btn-new-task').addEventListener('click', () => { location.hash = newTaskHash(getNewTaskContext()); });
  window.addEventListener('hashchange', renderRoute);
  document.addEventListener('keydown', async (e) => {   // Cmd/Ctrl+Z undoes the last change (text fields keep their own undo)
    if (e.key.toLowerCase() !== 'z' || e.shiftKey || e.altKey || !(e.metaKey || e.ctrlKey)) return;
    const a = document.activeElement;
    if (a && (['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName) || a.isContentEditable)) return;
    if (document.querySelector('.popover, .modal, .modal-backdrop, [aria-modal="true"]')) return;
    e.preventDefault();
    try { await api.undo(); await refresh(); toast('Undone'); } catch (err) { toast(err.message, 'error'); }
  });
  subscribe(renderBanner);
  setInterval(() => { refresh().catch((e) => console.warn('poll failed', e)); }, POLL_MS);
  api.setUnauthorizedHandler(showLogin);
}

async function start() {
  wireOnce();
  let auth;
  try { auth = await api.getAuthStatus(); } catch (e) {
    const view = el('view');
    clear(view);
    view.append(h('section', { class: 'placeholder' }, h('h2', {}, 'Cannot reach the server'), h('p', {}, e.message)));
    return;
  }
  if (auth.authRequired && !auth.authenticated) { await showLogin(); return; }
  try { await loadAll(); } catch (e) { toast(`Could not load data: ${e.message}`, 'error'); return; }
  renderBanner();
  if (asideCleanup) asideCleanup();
  asideCleanup = await mount(el('risk-panel'), './views/riskPanel.js', { name: 'riskPanel', params: {}, query: new URLSearchParams() }, 'Risks');
  await renderRoute();
}

start();
