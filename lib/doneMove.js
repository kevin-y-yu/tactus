// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Done-move rule (spec v2 §R1 V2-D2, user ruling UR-1). Pure: no I/O, no clock (AC-ARCH rule 2).
'use strict';

const MINUTE = 60000;
const KEEP_WITHIN_MS = 30 * MINUTE;   // planned completion <= 30 min after now -> blocks keep their times
const iso = (ms) => new Date(ms).toISOString();

// blocks: [{ id, start, end, completed, ... }] of ONE task or ONE occurrence; extra fields are ignored.
// Returns openIds (blocks with completed false and end > now, in (start, id) order) and moves ([{ id, start, end }],
// ISO strings, same order): open blocks packed back-to-back so the last ends at now floored to the minute.
function planDoneMove(blocks, nowMs) {
  const open = blocks
    .filter((b) => !b.completed && Date.parse(b.end) > nowMs)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id - b.id);
  const openIds = open.map((b) => b.id);
  if (open.length === 0) return { openIds, moves: [] };
  const plannedEnd = Math.max(...open.map((b) => Date.parse(b.end)));
  if (plannedEnd - nowMs <= KEEP_WITHIN_MS) return { openIds, moves: [] };
  const moves = [];
  let cursor = Math.floor(nowMs / MINUTE) * MINUTE;
  for (let i = open.length - 1; i >= 0; i--) {
    const b = open[i];
    const dur = Date.parse(b.end) - Date.parse(b.start);
    moves.unshift({ id: b.id, start: iso(cursor - dur), end: iso(cursor) });
    cursor -= dur;
  }
  return { openIds, moves };
}

module.exports = { planDoneMove };
