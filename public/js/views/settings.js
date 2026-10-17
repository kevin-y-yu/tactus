// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Settings view (#/settings/<section>): left-nav shell, one section at a time (v2 R3, V2-D11). v2 chunk 20.
// render(container, route, ctx) -> cleanup. Sections live in views/settings/<id>.js, each render(host, ctx) -> cleanup.
// Pure helpers live in ../settingsModel.js.
import { h } from '../ui.js';
import { SETTINGS_SECTIONS, sectionFromRoute } from '../settingsModel.js';
import * as schedules from './settings/schedules.js';
import * as calendars from './settings/calendars.js';
import * as rules from './settings/rules.js';
import * as general from './settings/general.js';

const SECTION_MODULES = { schedules, calendars, rules, general };

export function render(container, route, ctx) {
  const active = sectionFromRoute(route && route.params ? route.params.section : null);
  const meta = SETTINGS_SECTIONS.find((s) => s.id === active);
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' },
    SETTINGS_SECTIONS.map((s) => h('a', {
      href: `#/settings/${s.id}`,
      class: s.id === active ? 'active' : null,
      'aria-current': s.id === active ? 'page' : null,
      dataset: { section: s.id },
    }, s.label)));
  const host = h('div', { class: 'settings-section', dataset: { section: active } });
  container.appendChild(h('div', { class: 'settings-view' },
    h('div', { class: 'settings-layout' }, nav,
      h('div', { class: 'settings-content' }, h('h2', {}, meta.label), host))));
  const cleanup = SECTION_MODULES[active].render(host, ctx);
  return () => { if (typeof cleanup === 'function') cleanup(); };
}
