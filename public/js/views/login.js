// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
// Login view (mounted by app.js when auth is required and not authenticated). Chunk 14.
// render(container, route, ctx) -> cleanup. ctx.restart() re-runs the shell start().
import { h } from '../ui.js';
import * as api from '../api.js';
import { ApiError } from '../api.js';

export function render(container, route, ctx) {
  const err = h('p', { class: 'form-error' });
  const input = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, autofocus: true });
  const button = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'login-form' },
    h('label', {}, 'Password', input),
    err,
    h('div', {}, button));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    button.disabled = true;
    try {
      await api.login(input.value);
      await ctx.restart();
    } catch (ex) {
      err.textContent = ex instanceof ApiError && ex.status === 401 ? 'Incorrect password.' : ex.message;
      input.value = '';
      button.disabled = false;
    }
  });

  container.appendChild(h('div', { class: 'login-view' }, h('h2', {}, 'Sign in'), form));
  input.focus();
  return () => {};
}
