// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Settings section "Scheduling rules" (#/settings/rules). v2 chunk 20 (v1 content moved).
import { h } from '../../ui.js';
import { state } from '../../state.js';
import { NUMBER_FIELDS, sectionKeys } from '../../settingsModel.js';
import { gridRow, numberInput, settingsCard, whenSettings } from './form.js';
import { timeInput } from '../../timeInput.js';

export function render(host, ctx) {
  const body = h('div');
  host.appendChild(body);
  return whenSettings(body, (rebuild) => {
    const s = state.settings;
    const fields = NUMBER_FIELDS.filter((f) => sectionKeys('rules').includes(f.key) && !f.key.startsWith('lunch'));
    const inputs = {};
    for (const f of fields) inputs[f.key] = numberInput(f, s[f.key]);
    body.appendChild(settingsCard({
      title: 'Blocks, breaks and buffers',
      rows: fields.map((f) => gridRow(f.label, inputs[f.key], { hint: f.hint || null })),
      note: 'Scheduling slots are 15 minutes.',
      collect: () => Object.fromEntries(fields.map((f) => [f.key, Number(inputs[f.key].value)])),
      onSaved: rebuild,
    }));
    const lunchFields = NUMBER_FIELDS.find((f) => f.key === 'lunchMin');
    const lunchLen = numberInput(lunchFields, s.lunchMin ?? 0);
    const lunchFrom = timeInput({ name: 'lunchStart', required: true, step: 900, value: s.lunchStart || '12:00' });
    const lunchTo = timeInput({ name: 'lunchEnd', required: true, step: 900, value: s.lunchEnd || '14:00' });
    body.appendChild(settingsCard({
      title: 'Lunch',
      rows: [gridRow(lunchFields.label, lunchLen, { hint: lunchFields.hint }), gridRow('Earliest start', lunchFrom), gridRow('Latest end', lunchTo)],
      note: 'Each working day gets one lunch in the earliest free time inside this window and your default schedule\'s hours. It is scheduled before tasks, and it counts as a break: work before and after it is not treated as one continuous stretch.',
      collect: () => ({ lunchMin: Number(lunchLen.value), lunchStart: lunchFrom.value, lunchEnd: lunchTo.value }),
      onSaved: rebuild,
    }));
  });
}
