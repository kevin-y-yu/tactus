// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Block routes (spec §8.1, §8.2, §9.10): pinned-block create (E5: recurring occurrence must match the rule), PATCH
// (pinned/start/end, or completed with credit, auto-complete and reopen) and DELETE (pinned blocks, or missed task blocks).
'use strict';
const express = require('express');
const { HttpError, requireObject, validateBlockTimes, badRequest, isDateString } = require('../validate.js');
const { occurrenceDates } = require('../recurrence.js');
const { markTaskDone, markTaskTodo } = require('./tasks.js');

// D11: §8.1 Block shape for API responses.
function toApiBlock(b, nowMs) {
  return { id: b.id, kind: b.kind, taskId: b.taskId, recurringId: b.recurringId, occurrenceDate: b.occurrenceDate,
    start: b.start, end: b.end, pinned: b.pinned, completed: b.completed,
    missed: Date.parse(b.end) <= nowMs && !b.completed && !b.done,
    title: b.title, color: b.color, projectId: b.projectId, done: b.done };
}

const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
const notFound = () => new HttpError(404, 'block not found');

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
      await repo.updateBlock(id, { completed: body.completed });
      if (body.completed && task.status === 'todo') {
        const doneMin = (await repo.listBlocksForTask(task.id)).filter((b) => b.completed)
          .reduce((sum, b) => sum + (Date.parse(b.end) - Date.parse(b.start)) / 60000, 0);
        if (doneMin >= task.durationMin) await markTaskDone(repo, task.id, nowMs, { moveBlocks: false });   // §8.2 auto-complete
      } else if (!body.completed && task.status === 'done') {
        await markTaskTodo(repo, task.id, nowMs);                                      // DL-28 reopen
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

  r.delete('/blocks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const block = id === null ? null : await repo.getBlock(id);
    if (!block) throw notFound();
    const nowMs = now();
    if (block.kind === 'recurring' && Date.parse(block.start) < nowMs) {
      throw new HttpError(409, 'a passed recurring occurrence cannot be deleted');
    }
    const missedTaskBlock = block.kind === 'task' && Date.parse(block.end) <= nowMs && !block.completed;
    if (!block.pinned && !missedTaskBlock) throw new HttpError(409, 'only pinned blocks or missed task blocks can be deleted');
    await repo.deleteBlock(id);
    await scheduleService.reschedule('block-delete');
    res.status(204).end();
  });

  return r;
}

module.exports = { blocksRoutes, toApiBlock };
