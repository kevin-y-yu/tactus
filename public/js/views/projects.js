// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Projects view (spec §10.5, v2 R8). groupTasks/moveStage are DOM-free; DOM work happens only inside render()/draw().
import { timeInput } from '../timeInput.js';
import { dateInput } from '../datePicker.js';
import { h, clear, toast, fmtDuration, openPopover, closePopover } from '../ui.js';
import { state, subscribe, mutate, tz } from '../state.js';
import * as api from '../api.js';
import { openTaskEditor, stateBadges, fmtInstant } from './taskEditor.js';
import { deadlineToIso, deadlineFromIso, timeAfterDateChange } from '../deadlineInput.js';
import { setNewTaskContext, newTaskHash } from '../newTask.js';
import { moveTaskBody, moveTargets } from '../projectDnd.js';
import { createProjectsDrag } from './projectsDrag.js';
import { scheduleOptions, scheduleValue, scheduleIdFromValue } from '../scheduleModel.js';

export const sortStages = (stages) => [...(stages || [])].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

// -> [{stage: Stage|null, tasks: Task[]}]: one entry per stage (sorted), then the No-stage entry (stage null).
// todo and done are task arrays already in display order; done tasks follow todo tasks within each group.
export function groupTasks(project, todo, done) {
  const stages = sortStages(project.stages);
  const ids = new Set(stages.map((s) => s.id));
  const mine = [...todo, ...done].filter((t) => t.projectId === project.id);
  const groups = stages.map((s) => ({ stage: s, tasks: mine.filter((t) => t.stageId === s.id) }));
  groups.push({ stage: null, tasks: mine.filter((t) => t.stageId == null || !ids.has(t.stageId)) });
  return groups;
}

// ids with ids[index] moved by delta (-1 up, +1 down); out-of-range -> copy unchanged.
export function moveStage(ids, index, delta) {
  const j = index + delta, out = [...ids];
  if (index < 0 || index >= ids.length || j < 0 || j >= ids.length) return out;
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}

let showDone = false;      // module-level: survives remounts (D4)
let doneTasks = [];

export function render(container, route, ctx) {
  const view = { container, ctx, alive: true, editingStageId: null };
  const reloadDone = async () => {
    if (!showDone) return;
    try { doneTasks = (await api.getTasks({ status: 'done' })) || []; } catch (e) { toast(e.message, 'error'); }
    draw(view);
  };
  view.reloadDone = reloadDone;
  view.drag = createProjectsDrag({
    container,
    redraw: () => draw(view),
    onTaskDrop: (taskId, target) => { const t = state.tasks.find((x) => x.id === taskId); if (t) moveTask(t, target); },
    onStageDrop: (projectId, ids) => tryMutate(() => api.reorderStages(projectId, ids)),
  });
  const unsub = subscribe(() => { draw(view); reloadDone(); });
  // "+ Task" context: last project/stage group clicked or focused. Never preventDefault/stopPropagation.
  const onCtx = (e) => {
    const t = e.target && typeof e.target.closest === 'function' ? e.target.closest('.proj-group, .proj-head') : null;
    if (!t || !container.contains(t)) return;
    const projectId = Number(t.dataset.projectId);
    if (!Number.isInteger(projectId)) return;
    if (t.classList.contains('proj-group')) setNewTaskContext({ projectId, stageId: t.dataset.stageId === '' ? null : Number(t.dataset.stageId) });
    else setNewTaskContext({ projectId });
  };
  container.addEventListener('pointerdown', onCtx);
  container.addEventListener('focusin', onCtx);
  draw(view);
  reloadDone();
  const closeEditor = route.name === 'task'
    ? openTaskEditor({ id: route.params.id, query: route.query, onClose: () => ctx.navigate('#/projects') })
    : null;
  return () => {
    view.alive = false; unsub();
    view.drag.destroy();
    container.removeEventListener('pointerdown', onCtx);
    container.removeEventListener('focusin', onCtx);
    if (closeEditor) closeEditor();
  };
}

// Runs a mutation; errors become toasts (D8).
async function tryMutate(fn) {
  try { await mutate(fn); } catch (e) { toast(e.message, 'error'); }
}

// Shared by drop and Move…: PATCH only when something changes; Undo restores both projectId and stageId.
async function moveTask(task, target) {
  const body = moveTaskBody(task, target);
  if (!body) return;
  const orig = { projectId: task.projectId, stageId: task.stageId ?? null };
  const to = allMoveTargets().find((m) => m.projectId === target.projectId && m.stageId === (target.stageId ?? null));
  const label = to ? to.label : 'the new location';
  try { await mutate(() => api.updateTask(task.id, body)); } catch (e) { toast(e.message, 'error'); return; }
  toast(`Moved to ${label}`, 'info', { label: 'Undo', onClick: () => tryMutate(() => api.updateTask(task.id, orig)) });
}

const allMoveTargets = () => [{ projectId: null, stageId: null, label: 'No project' }, ...moveTargets(state.projects)];

function openMoveMenu(anchor, task) {
  const targets = allMoveTargets();
  const sel = h('select', { 'aria-label': 'Move to' }, targets.map((m, i) => h('option', { value: String(i) }, m.label)));
  const cur = targets.findIndex((m) => m.projectId === task.projectId && m.stageId === (task.stageId ?? null));
  if (cur >= 0) sel.value = String(cur);
  const go = () => { const m = targets[Number(sel.value)]; closePopover(); if (m) moveTask(task, m); };
  openPopover(anchor, h('div', { class: 'move-menu' },
    h('h3', {}, `Move "${task.title}"`), sel,
    h('div', { class: 'popover-actions' }, h('button', { type: 'button', class: 'btn', onclick: go }, 'Move'))));
  sel.focus();
}

// Prompt helper: null on cancel or empty after trim (D7).
function askName(message, dflt) {
  const v = window.prompt(message, dflt);
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

// Resolves 'extend' | 'resize' | null (cancel): what to do with the later stages when this deadline moves later.
function askLaterStages(stageName, count) {
  return new Promise((resolve) => {
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    const back = h('div', { class: 'ls-backdrop', onclick: (e) => { if (e.target === back) done(null); } },
      h('div', { class: 'ls-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Later stages' },
        h('h3', {}, `Extending "${stageName}"`),
        h('p', {}, `${count} later stage${count === 1 ? '' : 's'} ${count === 1 ? 'has' : 'have'} a deadline. What should happen to ${count === 1 ? 'it' : 'them'}?`),
        h('button', { type: 'button', class: 'btn primary', onclick: () => done('extend') }, 'Extend them too (shift by the same amount)'),
        h('button', { type: 'button', class: 'btn', onclick: () => done('resize') }, 'Resize them to still finish by the original final deadline'),
        h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'Cancel')));
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
  });
}

function stageDeadlineForm(view, stage) {
  const dl = deadlineFromIso(stage.deadline, tz());
  const dateEl = dateInput({ value: dl.date, 'aria-label': 'Deadline date' });
  const timeEl = timeInput({ value: dl.time, 'aria-label': 'Deadline time' });   // no step: 23:59 must stay valid
  dateEl.addEventListener('change', () => { timeEl.value = timeAfterDateChange(dateEl.value, timeEl.value); });
  const typeSel = h('select', {}, h('option', { value: 'hard' }, 'Hard'), h('option', { value: 'soft' }, 'Soft'));
  typeSel.value = stage.deadlineType || 'hard';
  const finish = () => { view.editingStageId = null; draw(view); };
  const save = async () => {
    try {
      const deadline = deadlineToIso(dateEl.value, timeEl.value, tz());
      const body = { deadline, deadlineType: typeSel.value };
      const proj = state.projects.find((p) => p.id === stage.projectId);
      const later = (proj?.stages || []).filter((x) => x.sortOrder > stage.sortOrder && x.deadline);
      if (deadline && stage.deadline && Date.parse(deadline) > Date.parse(stage.deadline) && later.length) {
        const choice = await askLaterStages(stage.name, later.length);
        if (!choice) return;
        body.laterStages = choice;
      }
      await mutate(() => api.updateStage(stage.id, body));
      finish();
    } catch (e) { toast(e.message, 'error'); }
  };
  const clearDl = async () => {
    dateEl.value = ''; timeEl.value = '';
    try {
      await mutate(() => api.updateStage(stage.id, { deadline: null }));
      finish();
    } catch (e) { toast(e.message, 'error'); }
  };
  return h('div', { class: 'proj-stage-form' }, h('span', { class: 'dl-inputs' }, dateEl, timeEl), typeSel,
    h('button', { type: 'button', class: 'btn', onclick: save }, 'Save'),
    h('button', { type: 'button', class: 'btn', onclick: clearDl }, 'Clear'),
    h('button', { type: 'button', class: 'btn', onclick: () => finish() }, 'Cancel'));
}

function stageHeader(view, p, stage, stageIds) {
  const i = stageIds.indexOf(stage.id);
  const move = (delta) => () => tryMutate(() => api.reorderStages(p.id, moveStage(stageIds, i, delta)));
  return h('div', { class: 'proj-stage-row' },
    chevron(`s${stage.id}`, view, stage.name),
    h('span', {
      class: 'dnd-grip stage-grip', role: 'img', 'aria-label': `Drag to reorder stage ${stage.name}`, title: 'Drag to reorder',
      dataset: { stageId: String(stage.id), projectId: String(p.id) },
    }, '⠿'),
    h('span', { class: 'proj-stage-name' }, stage.name),
    stage.deadline ? h('span', { class: 'proj-deadline' }, fmtInstant(stage.deadline, tz())) : null,
    stage.deadline ? h('span', { class: `dl-badge dl-${stage.deadlineType || 'hard'}` }, stage.deadlineType === 'soft' ? 'Soft' : 'Hard') : null,
    h('button', { type: 'button', class: 'btn', title: 'Move up', disabled: i <= 0, onclick: move(-1) }, '↑'),
    h('button', { type: 'button', class: 'btn', title: 'Move down', disabled: i < 0 || i >= stageIds.length - 1, onclick: move(1) }, '↓'),
    h('button', {
      type: 'button', class: 'btn',
      onclick: async () => {
        const name = askName('Stage name', stage.name);
        if (name === null) return;
        await tryMutate(() => api.updateStage(stage.id, { name }));
      },
    }, 'Rename'),
    h('button', {
      type: 'button', class: 'btn',
      onclick: () => { view.editingStageId = view.editingStageId === stage.id ? null : stage.id; draw(view); },
    }, 'Deadline…'),
    h('button', {
      type: 'button', class: 'btn',
      onclick: () => {
        if (!window.confirm(`Delete stage "${stage.name}"? Its tasks move to No stage.`)) return;
        tryMutate(() => api.deleteStage(stage.id));
      },
    }, 'Delete'));
}

function taskRow(t, ts, ctx) {
  const done = t.status === 'done';
  return h('li', { class: 'proj-task' + (done ? ' done' : '') },
    done || t.projectId == null ? null : h('span', {
      class: 'dnd-grip task-grip', role: 'img', 'aria-label': `Drag to move ${t.title}`, title: 'Drag to move',
      dataset: { taskId: String(t.id) },
    }, '⠿'),
    h('input', {
      type: 'checkbox', checked: done,
      onchange: (e) => tryMutate(() => api.updateTask(t.id, { status: e.target.checked ? 'done' : 'todo' })),
    }),
    h('span', { class: 'proj-task-title' }, t.title),
    (t.blockedBy && t.blockedBy.length) ? h('span', { class: 'chip', title: 'Blocked by other tasks' }, `blocked by ${t.blockedBy.length}`) : null,
    (t.eventBlocks && t.eventBlocks.length) ? h('span', { class: 'chip', title: t.eventBlocks.map((e) => e.title).join(', ') }, 'after event') : null,
    (t.blocksEvents && t.blocksEvents.length) ? h('span', { class: 'chip', title: t.blocksEvents.map((e) => e.title).join(', ') }, 'before event') : null,
    h('span', {}, fmtDuration(t.durationMin)),
    h('span', { class: `prio-chip prio-${t.priority}` }, t.priority),
    t.deadline ? h('span', { class: 'proj-deadline' }, fmtInstant(t.deadline, tz())) : null,
    t.deadline ? h('span', { class: `dl-badge dl-${t.deadlineType || 'hard'}` }, t.deadlineType === 'soft' ? 'Soft' : 'Hard') : null,
    done ? null : stateBadges(ts).map((b) => h('span', { class: b.cls }, b.text)),
    ts && ts.plannedEnd ? h('span', { class: 'proj-planned' }, `ends ${fmtInstant(ts.plannedEnd, tz())}`) : null,
    done ? null : h('button', { type: 'button', class: 'btn', onclick: (e) => openMoveMenu(e.currentTarget, t) }, 'Move…'),
    h('button', { type: 'button', class: 'btn', onclick: () => ctx.navigate('#/task/' + t.id) }, 'Edit'),
    h('button', {
      type: 'button', class: 'btn',
      onclick: () => {
        if (!window.confirm(`Delete task "${t.title}"?`)) return;
        tryMutate(() => api.deleteTask(t.id));
      },
    }, 'Delete'));
}

// Collapsed cards are remembered in this browser ('none' is the standalone card).
const COLLAPSE_KEY = 'tactus.projectsCollapsed';
const collapsed = (() => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch { return new Set(); } })();
function toggleCollapsed(key, view) {
  if (!collapsed.delete(key)) collapsed.add(key);
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch { /* ignore */ }
  draw(view);
}
const chevron = (key, view, label) => h('button', {
  type: 'button', class: 'btn proj-toggle', 'aria-expanded': String(!collapsed.has(key)), 'aria-label': `${collapsed.has(key) ? 'Expand' : 'Collapse'} ${label}`,
  onclick: () => toggleCollapsed(key, view),
}, collapsed.has(key) ? '▸' : '▾');

function draw(view) {
  if (!view.alive) return;
  if (view.drag && view.drag.deferRedraw()) return;
  const { container, ctx } = view;
  clear(container);
  const statusTasks = (state.status && state.status.tasks) || [];

  const projectCard = (p) => {
    const stageIds = sortStages(p.stages).map((s) => s.id);
    const schedSel = h('select', {
      'aria-label': `Schedule for ${p.name}`,
      onchange: (e) => tryMutate(() => api.updateProject(p.id, { scheduleId: scheduleIdFromValue(e.target.value) })),
    }, scheduleOptions(state.schedules, null).map((o) => h('option', { value: o.value }, o.label)));
    schedSel.value = scheduleValue(p.scheduleId);
    const key = String(p.id);
    const open = !collapsed.has(key);
    const count = state.tasks.filter((t) => t.projectId === p.id).length;
    const head = h('div', { class: 'proj-head', dataset: { projectId: String(p.id) } },
      chevron(key, view, p.name),
      h('span', { class: 'proj-name' }, p.name, open ? null : h('span', { class: 'proj-count' }, ` · ${count} open task${count === 1 ? '' : 's'}`)),
      h('input', {
        type: 'color', value: p.color, title: 'Color',
        onchange: (e) => tryMutate(() => api.updateProject(p.id, { color: e.target.value })),
      }),
      h('label', { class: 'proj-sched' }, 'Schedule ', schedSel),
      h('button', {
        type: 'button', class: 'btn',
        onclick: async () => {
          const name = askName('Project name', p.name);
          if (name === null) return;
          await tryMutate(() => api.updateProject(p.id, { name }));
        },
      }, 'Rename'),
      h('button', {
        type: 'button', class: 'btn',
        onclick: () => {
          if (!window.confirm(`Delete project "${p.name}" and all its tasks?`)) return;
          tryMutate(() => api.deleteProject(p.id));
        },
      }, 'Delete'),
      h('button', {
        type: 'button', class: 'btn',
        onclick: async () => {
          const name = askName('New stage name', '');
          if (name === null) return;
          await tryMutate(() => api.createStage(p.id, { name }));
        },
      }, '+ Stage'));

    const groups = groupTasks(p, state.tasks, showDone ? doneTasks : []).map((g) => {
      const pid = p.id;
      const sid = g.stage ? g.stage.id : null;
      const addTask = () => ctx.navigate(newTaskHash({ projectId: pid, stageId: sid }));
      const header = g.stage
        ? stageHeader(view, p, g.stage, stageIds)
        : h('div', { class: 'proj-stage-row proj-nostage' }, chevron(`n${pid}`, view, 'No stage'), 'No stage');
      const form = g.stage && view.editingStageId === g.stage.id ? stageDeadlineForm(view, g.stage) : null;
      const rows = g.tasks.length
        ? g.tasks.map((t) => taskRow(t, statusTasks.find((x) => x.taskId === t.id), ctx))
        : [h('li', { class: 'proj-empty' }, 'No tasks')];
      const shut = collapsed.has(sid === null ? `n${pid}` : `s${sid}`);
      return h('div', { class: 'proj-group', dataset: { projectId: String(pid), stageId: sid === null ? '' : String(sid) } },
        header, shut ? h('div', { class: 'proj-count proj-collapsed-note' }, `${g.tasks.length} task${g.tasks.length === 1 ? '' : 's'}`) : null,
        shut ? null : form,
        shut ? null : h('ul', { class: 'proj-tasks' }, rows),
        shut ? null : h('button', { type: 'button', class: 'btn', onclick: addTask }, '+ Task'));
    });

    return h('div', {
      class: 'proj-card' + (p.archived ? ' proj-archived' : ''), dataset: { projectId: String(p.id) },
      style: { borderTopColor: p.color },
    }, head, open ? groups : null);
  };

  const toolbar = h('div', { class: 'proj-toolbar' },
    h('h2', {}, 'Projects'),
    h('label', {},
      h('input', {
        type: 'checkbox', checked: showDone,
        onchange: (e) => {
          showDone = e.target.checked;
          if (showDone) view.reloadDone();
          else { doneTasks = []; draw(view); }
        },
      }),
      ' Show done'),
    h('button', {
      type: 'button', class: 'btn',
      onclick: async () => {
        const name = askName('New project name', '');
        if (name === null) return;
        await tryMutate(() => api.createProject({ name }));
      },
    }, '+ Project'));

  const standalone = () => {
    const mine = [...state.tasks, ...(showDone ? doneTasks : [])].filter((t) => t.projectId == null);
    return h('div', { class: 'proj-card proj-standalone' },
      h('div', { class: 'proj-head' }, chevron('none', view, 'No project'), h('span', { class: 'proj-name' }, 'No project')),
      collapsed.has('none') ? null : h('div', { class: 'proj-group' },
        h('ul', { class: 'proj-tasks' }, mine.length
          ? mine.map((t) => taskRow(t, statusTasks.find((x) => x.taskId === t.id), ctx))
          : [h('li', { class: 'proj-empty' }, 'No standalone tasks')]),
        h('button', { type: 'button', class: 'btn', onclick: () => ctx.navigate('#/task/new') }, '+ Task')));
  };
  const list = [standalone(), ...state.projects.map(projectCard)];

  container.appendChild(h('section', { class: 'proj' }, toolbar, h('div', { class: 'proj-list' }, list)));
}
