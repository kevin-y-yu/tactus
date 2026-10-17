// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Settings section "General" (#/settings/general): timezone, week start. v2 chunk 20 (v1 content moved).
import { h } from '../../ui.js';
import { state } from '../../state.js';
import { timeZoneOptions } from '../../settingsModel.js';
import { gridRow, settingsCard, whenSettings } from './form.js';

export function render(host, ctx) {
  const body = h('div');
  host.appendChild(body);
  return whenSettings(body, (rebuild) => {
    const s = state.settings;
    const tzIn = h('input', { type: 'text', name: 'timezone', required: true, list: 'tz-options', value: s.timezone || '' });
    const useBrowser = h('button', {
      class: 'btn', type: 'button',
      onclick: () => { tzIn.value = Intl.DateTimeFormat().resolvedOptions().timeZone; },
    }, 'Use browser timezone');
    const datalist = h('datalist', { id: 'tz-options' }, timeZoneOptions().map((z) => h('option', { value: z })));
    const weekSel = h('select', { name: 'weekStartsOn' },
      h('option', { value: '0', selected: Number(s.weekStartsOn) === 0 }, 'Sunday'),
      h('option', { value: '1', selected: Number(s.weekStartsOn) === 1 }, 'Monday'));
    const clock24 = h('input', { type: 'checkbox', name: 'clock24', checked: Boolean(s.clock24) });
    body.appendChild(settingsCard({
      title: 'Time zone, week and clock',
      rows: [gridRow('Timezone', tzIn, { extra: [useBrowser, datalist] }), gridRow('Week starts on', weekSel),
        gridRow('24-hour clock', clock24, { hint: 'Type times as 13:00 instead of 1:00 PM.' })],
      collect: () => ({ timezone: tzIn.value.trim(), weekStartsOn: Number(weekSel.value), clock24: clock24.checked }),
      onSaved: rebuild,
    }));
  });
}
