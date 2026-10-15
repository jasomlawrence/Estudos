'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const { dueAlert } = require('../server/notifications');

const now = Date.parse('2026-10-15T12:00:00Z');
const cfg = { days_before: [3, 1, 0], overdue: true };
const inDays = (d) => new Date(now + d * 864e5).toISOString();

test('avisos de prazo escolhem o mais próximo', () => {
  assert.strictEqual(dueAlert(inDays(5), now, cfg), null);
  assert.strictEqual(dueAlert(inDays(2.5), now, cfg).kind, 'd3');
  assert.strictEqual(dueAlert(inDays(0.9), now, cfg).kind, 'd1');
  assert.deepStrictEqual(dueAlert(inDays(0.9), now, cfg).all, ['d1', 'd3']);
  assert.strictEqual(dueAlert(inDays(0.1), now, cfg).kind, 'd0');
  assert.strictEqual(dueAlert(inDays(-1), now, cfg).kind, 'overdue');
  assert.strictEqual(dueAlert(inDays(-1), now, { ...cfg, overdue: false }), null);
});
