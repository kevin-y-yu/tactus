// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Block routes (spec §8.1, §8.2, §9.10): pinned-block create (E5: recurring occurrence must match the rule), PATCH
// (pinned/start/end, or completed with credit, auto-complete and reopen), POST partial-done (shrink to the worked
// minutes and complete) and DELETE (pinned blocks, or past task blocks).
'use strict';
const express = require('express');
const { HttpError, requireObject, validateBlockTimes, badRequest, isDateString } = require('../validate.js');
const { occurrenceDates } = require('../recurrence.js');
const { markTaskDone, markTaskTodo } = require('./tasks.js');
const { planDoneMove } = require('../doneMove.js');

// D11: §8.1 Block shape for API responses.
function toApiBlock(b, nowMs) {
  return { id: b.id, kind: b.kind, taskId: b.taskId, recurringId: b.recurringId, occurrenceDate: b.occurrenceDate,
    start: b.start, end: b.end, pinned: b.pinned, completed: b.completed,
    missed: Date.parse(b.end) <= nowMs && !b.completed && !b.done,
    title: b.title, color: b.color, projectId: b.projectId, done: b.done };
}

const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
const notFound = () => new HttpError(404, 'block not found');

// §8.2: marks one task block completed (optionally changing other columns in the same update, e.g. a shorter end for
// partial-done) and auto-completes the task when its completed-block minutes reach durationMin. Caller ensures the
// block is a task block and the task is todo.
async function completeTaskBlock(repo, blockId, task, nowMs, extra = {}) {
  await repo.updateBlock(blockId, { ...extra, completed: true });
  const doneMin = (await repo.listBlocksForTask(task.id)).filter((b) => b.completed)
    .reduce((sum, b) => sum + (Date.parse(b.end) - Date.parse(b.start)) / 60000, 0);
  if (doneMin >= task.durationMin) await markTaskDone(repo, task.id, nowMs, { moveBlocks: false });   // §8.2 auto-complete
}

function blocksRoutes({ repo, scheduleService, now }) {
  const r = express.Router();

  r.post('/blocks', async (req, res) => {
    const body = requireObject(req.body);
    // Decision 3: task pin when taskId is an integer and recurringId is absent (null/undefined).
    const isTask = Number.isInteger(body.taskId) && body.recurringId == null;
    const isRecurring = !isTask && Number.isInteger(body.recurringId) && typeof body.occurrenceDate === 'string';
    if (!isTask && !isRecurring) throw badRequest('taskId', 'give taskId, or recurringId with occurrenceDate');
    if (isRecurring && !isDateString(body.occurrenceDate)) throw badRequest('occurrenceDate', 'must be YYYY-MM-DD');
    const { start, end } = validateBlockTimes(body.start, body.end, now());

    if (isTask) {
      const task = await repo.getTask(body.taskId);
      if (!task) throw new HttpError(404, 'task not found');
      if (task.status === 'done') throw new HttpError(409, 'task is done');
      const b = await repo.createPinnedBlock({ taskId: body.taskId, start, end });
      await scheduleService.reschedule('block-pin');
      return res.status(201).json(toApiBlock(b, now()));
    }

    const rec = await repo.getRecurring(body.recurringId);
    if (!rec) throw new HttpError(404, 'recurring task not found');
    const weekStartsOn = (await repo.getSettings()).weekStartsOn ?? 1;
    if (occurrenceDates(rec, body.occurrenceDate, body.occurrenceDate, weekStartsOn).length !== 1) {
      throw badRequest('occurrenceDate', 'not an occurrence of this recurring task');
    }
    const done = (await repo.listOccurrenceDone(body.occurrenceDate))
      .some((d) => d.recurringId === body.recurringId && d.occurrenceDate === body.occurrenceDate);
    if (done) throw new HttpError(409, 'occurrence is done');
    const b = await repo.createPinnedBlock({ recurringId: body.recurringId, occurrenceDate: body.occurrenceDate, start, end });
    await scheduleService.reschedule('block-pin');
    res.status(201).json(toApiBlock(b, now()));
  });

  r.patch('/blocks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const block = id === null ? null : await repo.getBlock(id);
    if (!block) throw notFound();
    const body = requireObject(req.body);
    if (body.completed !== undefined) {
      if (body.pinned !== undefined || body.start !== undefined || body.end !== undefined) {
        throw badRequest('completed', 'cannot be combined with pinned, start or end');
      }
      if (typeof body.completed !== 'boolean') throw badRequest('completed', 'must be a boolean');
      if (block.kind !== 'task') throw badRequest('completed', 'only task blocks can be completed');
      const nowMs = now();
      const task = await repo.getTask(block.taskId);
      if (body.completed && task.status === 'done') throw badRequest('completed', 'task is already done');  // E11 (user)
      if (body.completed) {
        await completeTaskBlock(repo, id, task, nowMs);
      } else {
        await repo.updateBlock(id, { completed: false });
        if (task.status === 'done') await markTaskTodo(repo, task.id, nowMs);          // DL-28 reopen
      }
      const updated = await repo.getBlock(id);                                         // D11: read before reschedule
      await scheduleService.reschedule('block-complete');
      return res.json(toApiBlock(updated, nowMs));
    }
    const hasTimes = body.start !== undefined || body.end !== undefined;
    if (body.pinned === undefined && !hasTimes) throw badRequest('body', 'expected pinned, start or end');
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') throw badRequest('pinned', 'must be a boolean');

    let patch;
    if (hasTimes) {
      const { start, end } = validateBlockTimes(body.start ?? block.start, body.end ?? block.end, now());
      if (block.done) {
        throw new HttpError(409, block.kind === 'recurring' ? 'occurrence is done' : 'task is done');
      }
      patch = { start, end, pinned: true };
    } else {
      patch = { pinned: body.pinned };
    }
    const updated = await repo.updateBlock(id, patch);
    await scheduleService.reschedule('block-update');
    res.json(toApiBlock(updated, now()));
  });

  // Partial done: the first `minutes` of the block become a completed (credited) part; the rest of the block is dropped
  // and the next reschedule re-plans it (remainingMin = durationMin − credited). minutes === block length is a plain
  // part-done. Task blocks only; past, running and future blocks are allowed.
  r.post('/blocks/:id/partial-done', async (req, res) => {
    const id = parseId(req.params.id);
    const block = id === null ? null : await repo.getBlock(id);
    if (!block) throw notFound();
    const body = requireObject(req.body);
    if (block.kind !== 'task') throw badRequest('block', 'only task blocks can be partially done');
    const lengthMin = Math.round((Date.parse(block.end) - Date.parse(block.start)) / 60000);
    if (!Number.isInteger(body.minutes) || body.minutes < 1 || body.minutes > lengthMin) {
      throw badRequest('minutes', `must be a whole number from 1 to ${lengthMin}`);
    }
    if (block.done) throw new HttpError(409, 'task is done');
    if (block.completed) throw new HttpError(409, 'block is already completed');
    const nowMs = now();
    const task = await repo.getTask(block.taskId);
    // The worked part is the first `minutes` of the block; like a whole-task done, a part planned well after now is
    // moved back so it ends at now (done-move rule, doneMove.js).
    const part = { id, start: block.start, completed: false,
      end: body.minutes === lengthMin ? block.end : new Date(Date.parse(block.start) + body.minutes * 60000).toISOString() };
    const [move] = planDoneMove([part], nowMs).moves;
    const extra = move ? { start: move.start, end: move.end } : body.minutes === lengthMin ? {} : { end: part.end };
    await completeTaskBlock(repo, id, task, nowMs, extra);
    const updated = await repo.getBlock(id);                                           // D11: read before reschedule
    await scheduleService.reschedule('block-partial-done');
    res.json(toApiBlock(updated, nowMs));
  });

  r.delete('/blocks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const block = id === null ? null : await repo.getBlock(id);
    if (!block) throw notFound();
    const nowMs = now();
    if (block.kind === 'recurring' && Date.parse(block.start) < nowMs) {
      throw new HttpError(409, 'a passed recurring occurrence cannot be deleted');
    }
    const pastTaskBlock = block.kind === 'task' && Date.parse(block.end) <= nowMs;   // missed or completed
    if (!block.pinned && !pastTaskBlock) throw new HttpError(409, 'only pinned blocks or past task blocks can be deleted');
    await repo.deleteBlock(id);
    await scheduleService.reschedule('block-delete');
    res.status(204).end();
  });

  return r;
}

module.exports = { blocksRoutes, toApiBlock };
