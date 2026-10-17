// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Task editor modal (spec §10.5). Pure helpers are DOM-free; DOM work happens only inside openTaskEditor().
import { timeInput, dateTimeInput } from '../timeInput.js';
import { dateInput } from '../datePicker.js';
import { durationInput as makeDuration } from '../durationInput.js';
import { openEventPicker } from '../eventPicker.js';
import { utcToZoned, formatHHMM, localInputToIso, isoToLocalInput } from '../../shared/time.js';
import { deadlineToIso, deadlineFromIso, timeAfterDateChange } from '../deadlineInput.js';
import { fmtDate, fmtTimeRange, h, clear } from '../ui.js';
import { state, mutate, tz } from '../state.js';
import * as api from '../api.js';
import { scheduleOptions, scheduleValue, scheduleIdFromValue } from '../scheduleModel.js';

export const STATE_LABELS = { ok: 'ok', tight: 'tight', hard: 'hard at risk', soft: 'past soft deadline', unscheduled: 'unscheduled' };

export function fmtInstant(iso, tzName) {
  const ms = typeof iso === 'string' && iso !== '' ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) return '';
  const z = utcToZoned(ms, tzName);
  return `${fmtDate(z.date)} ${formatHHMM(z.minutes)}`;
}

// TaskStatus|null -> [{text, cls}]
export function stateBadges(ts) {
  if (!ts) return [];
  const out = [{ text: STATE_LABELS[ts.state] || ts.state, cls: `state-badge state-${ts.state}` }];
  if (ts.overdue) out.push({ text: 'overdue', cls: 'state-badge state-overdue' });
  return out;
}

const intOrNull = (s) => (s === '' || s === null || s === undefined ? null : Number(s));

// v: raw form values (strings; dontSplit boolean; deadline as deadlineDate + deadlineTime) -> PATCH/POST body (§8.1 Task fields)
export function taskBodyFromForm(v, tzName) {
  return {
    title: String(v.title).trim(),
    projectId: v.projectId === '' || v.projectId == null ? null : Number(v.projectId),
    stageId: v.projectId === '' || v.projectId == null ? null : intOrNull(v.stageId),
    scheduleId: scheduleIdFromValue(v.scheduleId),
    durationMin: Number(v.durationMin),
    priority: v.priority,
    deadline: deadlineToIso(v.deadlineDate, v.deadlineTime, tzName),
    deadlineType: v.deadlineType,
    startAfter: localInputToIso(v.startAfter, tzName),
    dontSplit: Boolean(v.dontSplit),
    minBlockMin: intOrNull(v.minBlockMin),
    maxBlockMin: intOrNull(v.maxBlockMin),
    notes: String(v.notes),
    status: v.status,
    ...(v.blocking ? { blocking: v.projectId === '' || v.projectId == null ? [] : v.blocking.map(Number) } : {}),
    ...(v.blockedBy ? { blockedBy: v.projectId === '' || v.projectId == null ? [] : v.blockedBy.map(Number) } : {}),
    ...(v.eventBlocks ? { eventBlocks: v.eventBlocks.map((e) => ({ calendarId: e.calendarId, uid: e.uid, start: e.start })) } : {}),
    ...(v.blocksEvents ? { blocksEvents: v.blocksEvents.map((e) => ({ calendarId: e.calendarId, uid: e.uid, start: e.start })) } : {}),
  };
}

// Blocks with end > now, sorted by start.
export function upcomingBlocks(blocks, now) {
  return (blocks || []).filter((b) => Date.parse(b.end) > now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export function overEstimateMin(creditedMin, durationMin) {
  return Math.max(0, (creditedMin || 0) - durationMin);
}

const sortedStages = (stages) => [...(stages || [])].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
const projectById = (pid) => state.projects.find((p) => p.id === pid) || null;
const stagesFor = (pid) => { const p = projectById(pid); return p ? sortedStages(p.stages) : []; };

// opts: {id: string ('new' = create), query: URLSearchParams, onClose: () => void}. Returns close() (no onClose call).
export function openTaskEditor({ id, query, onClose }) {
  const isNew = id === 'new';
  const q = query || new URLSearchParams();
  const titleEl = h('h2', {}, isNew ? 'New task' : 'Edit task');
  const contentEl = h('div', {}, isNew ? null : h('p', {}, 'Loading…'));
  const errorEl = h('p', { class: 'te-error', role: 'alert', hidden: true });
  const detailsEl = h('div', { class: 'te-details' });
  const modal = h('div', { class: 'te-modal', role: 'dialog', 'aria-modal': 'true' }, titleEl, contentEl);
  const backdrop = h('div', { class: 'te-backdrop' }, modal);

  let closed = false;
  let onKey = null;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const cancel = () => { close(); onClose(); };
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  onKey = (e) => {
    if (e.key === 'Escape') { cancel(); return; }
    // Cmd+S / Cmd+Enter (Ctrl on other systems) saves the task
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (mod && !e.altKey && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
      e.preventDefault();
      const form = modal.querySelector('form');
      const btn = form && form.querySelector('button[type=submit]');
      if (form && btn && !btn.disabled) form.requestSubmit(btn);
    }
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) cancel(); });
  document.body.appendChild(backdrop);

  const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };

  function renderDetails(data) {
    clear(detailsEl);
    const line = (...kids) => detailsEl.appendChild(h('div', { class: 'te-detail' }, ...kids));
    const ts = data.status;
    line('State: ', ts ? stateBadges(ts).map((b) => h('span', { class: b.cls }, b.text)) : 'done');
    if (ts && ts.plannedEnd) line(`Planned end: ${fmtInstant(ts.plannedEnd, tz())}`);
    if (ts && ts.state === 'tight' && ts.slackMin != null) line(`Slack: ${ts.slackMin} min`);
    const ups = upcomingBlocks(data.blocks, Date.now());
    const items = ups.length
      ? ups.map((b) => {
        const ms = Date.parse(b.start);
        const z = utcToZoned(ms, tz());
        return h('li', {}, `${fmtDate(z.date)} ${fmtTimeRange(ms, Date.parse(b.end), tz())}`, b.pinned ? ' (pinned)' : '');
      })
      : [h('li', {}, 'none')];
    line('Upcoming blocks:', h('ul', { class: 'te-blocks' }, items));
    line(`Credited: ${data.creditedMin} min `, h('button', { type: 'button', class: 'btn', onclick: onReset }, 'Reset progress'));
    const over = overEstimateMin(data.creditedMin, data.task.durationMin);
    if (over > 0) line(`Planned ${over} min over estimate`);
  }

  async function onReset() {
    errorEl.hidden = true;
    try {
      await mutate(() => api.resetTaskProgress(id));
      const fresh = await api.getTask(id);
      if (!closed) renderDetails(fresh);
    } catch (e) {
      if (!closed) showError(e.message);
    }
  }

  function buildForm(task) {
    const editing = Boolean(task);
    const t = task || {};
    const defProject = editing ? t.projectId
      : (projectById(Number(q.get('projectId'))) ? Number(q.get('projectId')) : null);   // no project unless one was asked for
    const qStage = q.get('stageId');
    const defStage = editing ? (t.stageId == null ? '' : String(t.stageId))
      : (qStage !== null && stagesFor(defProject).some((s) => String(s.id) === qStage) ? qStage : '');

    const titleInput = h('input', { type: 'text', required: true, maxlength: 200, value: t.title || '' });
    const projectSel = h('select', {}, h('option', { value: '' }, 'No project'));
    for (const p of state.projects) projectSel.appendChild(h('option', { value: p.id }, p.name));
    const stageSel = h('select', {});
    const fillStages = (pid, selected) => {
      clear(stageSel);
      stageSel.appendChild(h('option', { value: '' }, 'No stage'));
      for (const s of stagesFor(pid)) stageSel.appendChild(h('option', { value: s.id }, s.name));
      stageSel.value = selected;
    };
    projectSel.value = defProject == null ? '' : String(defProject);
    fillStages(defProject, defStage);
    const scheduleSel = h('select', {});
    const fillSchedules = (pid, selected) => {
      clear(scheduleSel);
      for (const o of scheduleOptions(state.schedules, projectById(pid))) scheduleSel.appendChild(h('option', { value: o.value }, o.label));
      scheduleSel.value = selected;
    };
    fillSchedules(defProject, editing ? scheduleValue(t.scheduleId) : '');
    const stageRow = h('label', { class: 'te-row' }, 'Stage', stageSel);

    // ----- blocked by / blocking: other tasks of the same stage (any task of the project when this one has no stage) -----
    const stageNow = () => (stageSel.value === '' ? null : Number(stageSel.value));
    const allowed = (x) => {
      const pid = projectSel.value === '' ? null : Number(projectSel.value);
      return pid !== null && x.id !== t.id && x.projectId === pid && (stageNow() === null || (x.stageId ?? null) === stageNow());
    };
    // Collapsed: label plus the chosen titles. Click to expand, then click a task to tick or untick it.
    const taskPicker = (label, ids, hints) => {
      let open = false;
      const box = h('div', { class: 'te-pick-box' });
      const head = h('button', { type: 'button', class: 'btn te-pick-head', 'aria-expanded': 'false', onclick: () => { open = !open; draw(); } });
      const draw = () => {
        clear(box);
        const pid = projectSel.value === '' ? null : Number(projectSel.value);
        const choices = state.tasks.filter((x) => x.projectId === pid && x.id !== t.id && (allowed(x) || ids.has(x.id)));
        for (const id of [...ids]) if (!state.tasks.some((x) => x.id === id)) ids.delete(id);   // done or deleted since
        const names = choices.filter((c) => ids.has(c.id)).map((c) => c.title);
        head.textContent = `${open ? '▾' : '▸'} ${label}${ids.size ? ` (${ids.size})` : ''}`;
        head.setAttribute('aria-expanded', String(open));
        box.appendChild(head);
        if (!open) { if (names.length) box.appendChild(h('span', { class: 'te-hint' }, names.join(', '))); return; }
        if (!choices.length) { box.appendChild(h('span', { class: 'te-hint' }, pid === null ? hints.noProject : hints.none)); return; }
        const list = h('div', { class: 'te-picklist' });
        for (const c of choices) {
          const on = ids.has(c.id);
          list.appendChild(h('button', { type: 'button', class: 'te-pick' + (on ? ' on' : ''), 'aria-pressed': String(on),
            onclick: () => { if (ids.has(c.id)) ids.delete(c.id); else ids.add(c.id); draw(); } },
            h('span', { class: 'te-pick-mark' }, on ? '✓' : ''), c.title));
        }
        box.appendChild(list);
      };
      draw();
      return { box, draw, prune: () => { const keep = new Set(state.tasks.filter(allowed).map((x) => x.id)); for (const id of [...ids]) if (!keep.has(id)) ids.delete(id); } };
    };
    const blockerIds = new Set(editing ? (t.blockedBy || []) : []);
    const blockingIds = new Set(editing ? (t.blocking || []) : []);
    const blockerPick = taskPicker('Blocked by tasks', blockerIds, { noProject: 'Only tasks in a project can be blocked by other tasks.', none: 'No other open tasks in this stage.' });
    const blockingPick = taskPicker('Blocking tasks', blockingIds, { noProject: 'Only tasks in a project can block other tasks.', none: 'No other open tasks in this stage.' });
    const blockerRow = h('div', { class: 'te-row' }, blockerPick.box);
    const blockingRow = h('div', { class: 'te-row' }, blockingPick.box);
    const drawBlockers = () => blockerPick.draw();
    const drawBlocking = () => blockingPick.draw();

    // A list of chosen calendar events plus a button that opens the week-calendar picker.
    const eventPicker = (label, initial) => {
      const chosen = initial.map((e) => ({ ...e }));
      const list = h('div', { class: 'te-chips' });
      const keyOf = (e) => `${e.calendarId}|${e.uid}|${e.start}`;
      const draw = () => {
        clear(list);
        for (const [i, e] of chosen.entries()) {
          const z = Number.isFinite(Date.parse(e.start)) ? utcToZoned(Date.parse(e.start), tz()) : null;
          const when = z ? `${fmtDate(z.date)} ${formatHHMM(z.minutes)}` : '';
          list.appendChild(h('span', { class: 'chip' }, `${e.title} ${when}${e.stale ? ' (no longer in calendar)' : ''} `,
            h('button', { type: 'button', class: 'btn-link', 'aria-label': `Remove ${e.title}`, onclick: () => { chosen.splice(i, 1); draw(); } }, '×')));
        }
      };
      draw();
      const choose = h('button', { type: 'button', class: 'btn', onclick: () => openEventPicker({
        chosen, title: label,
        onToggle: (e, on) => {
          const i = chosen.findIndex((x) => keyOf(x) === keyOf(e));
          if (on && i < 0) chosen.push(e); else if (!on && i >= 0) chosen.splice(i, 1);
          draw();
        } }) }, 'Choose from calendar…');
      return { chosen, row: h('div', { class: 'te-row' }, label, list, choose) };
    };
    const afterEvents = eventPicker('Starts after calendar events', editing ? (t.eventBlocks || []) : []);
    const beforeEvents = eventPicker('Must finish before calendar events (the event start is its deadline)', editing ? (t.blocksEvents || []) : []);
    const eventBlocks = afterEvents.chosen, blocksEvents = beforeEvents.chosen;
    const eventRow = afterEvents.row;
    const syncProject = () => {
      const has = projectSel.value !== '';
      stageRow.hidden = !has;
      blockerRow.hidden = !has;
      blockingRow.hidden = !has;
      drawBlockers();
      drawBlocking();
    };
    projectSel.addEventListener('change', () => {
      const pid = projectSel.value === '' ? null : Number(projectSel.value);
      fillStages(pid, '');
      fillSchedules(pid, scheduleSel.value);
      blockerPick.prune(); blockingPick.prune();
      syncProject();
    });
    stageSel.addEventListener('change', () => { blockerPick.prune(); blockingPick.prune(); drawBlockers(); drawBlocking(); });
    syncProject();

    const durationInput = makeDuration({ max: 2880, value: editing ? t.durationMin : 60 });
    const prioritySel = h('select', {});
    for (const p of ['urgent', 'high', 'medium', 'low']) prioritySel.appendChild(h('option', { value: p }, p));
    prioritySel.value = editing ? t.priority : 'medium';

    const dl = deadlineFromIso(t.deadline, tz());
    const deadlineDate = dateInput({ value: dl.date, 'aria-label': 'Deadline date' });
    const deadlineTime = timeInput({ value: dl.time, 'aria-label': 'Deadline time' });   // no step: 23:59 must stay valid
    deadlineDate.addEventListener('change', () => { deadlineTime.value = timeAfterDateChange(deadlineDate.value, deadlineTime.value); });
    const clearBtn = h('button', { type: 'button', class: 'btn', onclick: () => { deadlineDate.value = ''; deadlineTime.value = ''; } }, 'Clear');
    const dtSel = h('select', {});
    dtSel.appendChild(h('option', { value: 'hard' }, 'Hard'));
    dtSel.appendChild(h('option', { value: 'soft' }, 'Soft'));
    dtSel.value = editing && t.deadlineType ? t.deadlineType : 'hard';

    // A new task takes its stage's deadline and type until the user edits the deadline themselves.
    let dlAuto = isNew;
    const stageDeadline = () => {
      const st = stagesFor(projectSel.value === '' ? null : Number(projectSel.value)).find((x) => String(x.id) === stageSel.value);
      return st && st.deadline ? st : null;
    };
    const applyStageDeadline = () => {
      if (!dlAuto) return;
      const st = stageDeadline();
      const d = st ? deadlineFromIso(st.deadline, tz()) : { date: '', time: '' };
      deadlineDate.value = d.date; deadlineTime.value = d.time;
      dtSel.value = st && st.deadlineType ? st.deadlineType : 'hard';
    };
    for (const el of [deadlineDate, deadlineTime, dtSel]) el.addEventListener('change', () => { dlAuto = false; });
    clearBtn.addEventListener('click', () => { dlAuto = false; });
    stageSel.addEventListener('change', applyStageDeadline);
    projectSel.addEventListener('change', applyStageDeadline);
    applyStageDeadline();

    const startInput = dateTimeInput({ value: isoToLocalInput(t.startAfter, tz()) });
    const dontSplitCb = h('input', { type: 'checkbox', checked: editing && Boolean(t.dontSplit) });
    const minInput = h('input', {
      type: 'number', min: 15, max: 240, step: 15,
      placeholder: `default (${state.settings ? state.settings.defaultMinBlockMin : 30})`,
      value: editing && t.minBlockMin != null ? t.minBlockMin : '',
    });
    const minRow = h('label', { class: 'te-row' }, 'Min block (min)', minInput);
    const syncDontSplit = () => { minRow.hidden = dontSplitCb.checked; minInput.disabled = dontSplitCb.checked; };
    dontSplitCb.addEventListener('change', syncDontSplit);
    syncDontSplit();

    const maxInput = h('input', {
      type: 'number', min: 15, max: 2880, step: 15, placeholder: 'no max',
      value: editing && t.maxBlockMin != null ? t.maxBlockMin : '',
    });
    const notesEl = h('textarea', { rows: 3 }, editing ? (t.notes || '') : '');
    const statusSel = h('select', {});
    statusSel.appendChild(h('option', { value: 'todo' }, 'To do'));
    statusSel.appendChild(h('option', { value: 'done' }, 'Done'));
    statusSel.value = editing ? t.status : 'todo';

    const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Create' : 'Save', h('span', { class: 'kbd-hint' }, ` ${isMac ? '⌘' : 'Ctrl+'}↵`));
    const cancelBtn = h('button', { type: 'button', class: 'btn', onclick: cancel }, 'Cancel');

    async function onSubmit(e) {
      e.preventDefault();
      errorEl.hidden = true;
      const values = {
        title: titleInput.value, projectId: projectSel.value, stageId: stageSel.value, scheduleId: scheduleSel.value,
        durationMin: durationInput.value, priority: prioritySel.value,
        deadlineDate: deadlineDate.value, deadlineTime: deadlineTime.value, deadlineType: dtSel.value, startAfter: startInput.value,
        dontSplit: dontSplitCb.checked, minBlockMin: minInput.value, maxBlockMin: maxInput.value,
        notes: notesEl.value, status: statusSel.value,
        blockedBy: [...blockerIds], blocking: [...blockingIds], eventBlocks, blocksEvents,
      };
      submitBtn.disabled = true;
      try {
        const payload = taskBodyFromForm(values, tz());
        await mutate(() => (isNew ? api.createTask(payload) : api.updateTask(id, payload)));
        if (!closed) cancel();
      } catch (err) {
        if (!closed) showError(err.message);
      } finally {
        submitBtn.disabled = false;
      }
    }

    const form = h('form', { class: 'te-form', onsubmit: onSubmit },
      h('label', { class: 'te-row' }, 'Title', titleInput),
      h('label', { class: 'te-row' }, 'Project', projectSel),
      stageRow,
      h('label', { class: 'te-row' }, 'Schedule', scheduleSel),
      h('label', { class: 'te-row' }, 'Duration', durationInput),
      h('label', { class: 'te-row' }, 'Priority', prioritySel),
      h('label', { class: 'te-row' }, 'Deadline', h('div', { class: 'te-inline' }, h('span', { class: 'dl-inputs' }, deadlineDate, deadlineTime), clearBtn, dtSel)),
      h('label', { class: 'te-row' }, 'Start after', startInput),
      blockerRow,
      blockingRow,
      eventRow,
      beforeEvents.row,
      h('label', { class: 'te-row te-check' }, dontSplitCb, "Don't split"),
      minRow,
      h('label', { class: 'te-row' }, 'Max block (min)', maxInput),
      h('label', { class: 'te-row' }, 'Notes', notesEl),
      h('label', { class: 'te-row' }, 'Status', statusSel),
      errorEl,
      h('div', { class: 'te-actions' }, cancelBtn, submitBtn),
    );
    return { form, titleInput };
  }

  if (isNew) {
    const built = buildForm(null);
    clear(contentEl);
    contentEl.appendChild(built.form);
    built.titleInput.focus();
  } else {
    api.getTask(id).then((data) => {
      if (closed) return;
      clear(contentEl);
      contentEl.appendChild(detailsEl);
      renderDetails(data);
      const built = buildForm(data.task);
      contentEl.appendChild(built.form);
      built.titleInput.focus();
    }, (e) => {
      if (closed) return;
      clear(contentEl);
      showError(e.message);
      contentEl.append(errorEl, h('div', { class: 'te-actions' }, h('button', { type: 'button', class: 'btn', onclick: cancel }, 'Close')));
    });
  }

  return close;
}
