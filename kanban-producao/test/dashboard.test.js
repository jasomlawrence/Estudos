'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const { q } = require('../server/db');
const { seedBoard, dashboardData } = require('../server/routes');

const DAY = 864e5;

test('painel: contagens, velocímetro e semanas', () => {
  q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'a@a.com', 'x', 'admin')");
  const boardId = seedBoard(1);
  const cols = q.all('SELECT * FROM columns WHERE board_id = ? ORDER BY position', boardId);
  const now = Date.now();
  const iso = (d) => new Date(now + d * DAY).toISOString();
  const add = (title, col, { due, started, ended, created = -1 } = {}) => {
    const info = q.run(`INSERT INTO cards (board_id, column_id, title, position, due_date, cycle_started_at, cycle_ended_at, created_at, updated_at)
                        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`, boardId, col.id, title, due ?? null, started ?? null, ended ?? null, iso(created), iso(created));
    return Number(info.lastInsertRowid);
  };
  add('espera', cols[0], { due: iso(10) });
  add('produzindo ok', cols[2], { due: iso(5), started: iso(-3) });
  add('em risco', cols[3], { due: iso(1), started: iso(-4) });
  add('atrasado', cols[3], { due: iso(-1), started: iso(-9) });
  add('entregue no prazo', cols.at(-1), { due: iso(-2), started: iso(-10), ended: iso(-3), created: -12 });
  add('entregue atrasado', cols.at(-1), { due: iso(-6), started: iso(-12), ended: iso(-4), created: -14 });

  const d = dashboardData(boardId, now);
  assert.strictEqual(d.kpis.waiting, 1);
  assert.strictEqual(d.kpis.producing, 3);
  assert.strictEqual(d.kpis.overdue, 1);
  assert.strictEqual(d.kpis.risk, 1);
  assert.strictEqual(d.kpis.done_30, 2);
  assert.strictEqual(d.kpis.on_time_30, 0.5);
  assert.deepStrictEqual(d.gauge, { score: 67, active_ok: 3, active_due: 4, done_ok: 1, done_due: 2 }); // (3 + 1) / 6
  assert.strictEqual(d.weekly.length, 8);
  assert.strictEqual(d.weekly.reduce((s, w) => s + w.done, 0), 2);
  assert.strictEqual(d.stages.find((s) => s.id === cols[3].id).count, 2);
  assert.strictEqual(d.stages.find((s) => s.id === cols[3].id).overdue, 1);
  assert.strictEqual(d.cards.length, 6);
});
