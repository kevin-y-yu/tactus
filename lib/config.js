// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

// Env -> config (spec §5.2). Pure except for the optional <repo>/.env load,
// which happens only when called with the real process.env.
function loadConfig(env = process.env) {
  if (env === process.env) {
    const envFile = path.join(REPO_ROOT, '.env');
    if (fs.existsSync(envFile)) process.loadEnvFile(envFile); // malformed file throws
  }
  const port = Number(env.PORT) || 3200;
  const host = env.HOST || '127.0.0.1';
  const dataDir = path.resolve(env.DATA_DIR || path.join(REPO_ROOT, 'data'));
  const dbPath = env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(dataDir, 'tactus.db');
  const authToken = env.AUTH_TOKEN || null;
  const trustProxy = env.TRUST_PROXY === '1';
  const isLoopback = LOOPBACK_HOSTS.includes(host);
  return { port, host, dataDir, dbPath, authToken, trustProxy, isLoopback };
}

module.exports = { loadConfig };
