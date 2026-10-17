// Tactus: personal auto-scheduling planner. Copyright (c) 2026 Kevin Yu
// SPDX-License-Identifier: MIT
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig } = require('../lib/config.js');

const REPO = path.resolve(__dirname, '..');

test('T-CFG-1: loadConfig({}) returns the S-1 defaults', () => {
  assert.deepStrictEqual(loadConfig({}), {
    port: 3200,
    host: '127.0.0.1',
    dataDir: path.join(REPO, 'data'),
    dbPath: path.join(REPO, 'data', 'tactus.db'),
    authToken: null,
    trustProxy: false,
    isLoopback: true,
  });
});

test('T-CFG-2: PORT/HOST/DATA_DIR override (S-1 AC)', () => {
  const c = loadConfig({ PORT: '8080', HOST: '0.0.0.0', DATA_DIR: '/tmp/s' });
  assert.strictEqual(c.port, 8080);
  assert.strictEqual(c.host, '0.0.0.0');
  assert.strictEqual(c.dataDir, '/tmp/s');
  assert.strictEqual(c.dbPath, '/tmp/s/tactus.db');
  assert.strictEqual(c.isLoopback, false);
});

test('T-CFG-3: DB_PATH overrides the default database file', () => {
  const c = loadConfig({ DATA_DIR: '/tmp/s', DB_PATH: '/tmp/other/x.db' });
  assert.strictEqual(c.dataDir, '/tmp/s');
  assert.strictEqual(c.dbPath, '/tmp/other/x.db');
});

test('T-CFG-4: AUTH_TOKEN and TRUST_PROXY', () => {
  const c = loadConfig({ AUTH_TOKEN: 'secret', TRUST_PROXY: '1' });
  assert.strictEqual(c.authToken, 'secret');
  assert.strictEqual(c.trustProxy, true);
  assert.strictEqual(loadConfig({ TRUST_PROXY: 'true' }).trustProxy, false);
  assert.strictEqual(loadConfig({ AUTH_TOKEN: '' }).authToken, null);
});

test('T-CFG-5: isLoopback recognises 127.0.0.1, localhost and ::1 only', () => {
  assert.strictEqual(loadConfig({ HOST: 'localhost' }).isLoopback, true);
  assert.strictEqual(loadConfig({ HOST: '::1' }).isLoopback, true);
  assert.strictEqual(loadConfig({ HOST: '192.168.1.5' }).isLoopback, false);
});

test('T-CFG-6: non-numeric PORT falls back to 3200', () => {
  assert.strictEqual(loadConfig({ PORT: 'abc' }).port, 3200);
});

test('T-CFG-7: a plain env object ignores process.env', () => {
  const saved = process.env.PORT;
  process.env.PORT = '9999';
  try {
    assert.strictEqual(loadConfig({}).port, 3200);
  } finally {
    if (saved === undefined) delete process.env.PORT;
    else process.env.PORT = saved;
  }
});
