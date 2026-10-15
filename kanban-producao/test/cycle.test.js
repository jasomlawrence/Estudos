'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeCycle, columnDurations, stats } = require('../server/cycle');

const columns = [1, 2, 3, 4].map((id) => ({ id, position: id * 1024 }));

test('cronômetro começa na coluna inicial e para na final', () => {
  let card = { cycle_started_at: null, cycle_ended_at: null };
  card = computeCycle({ columns, startId: 2, endId: 4, toColumnId: 1, card, at: 't0' });
  assert.deepStrictEqual(card, { cycle_started_at: null, cycle_ended_at: null });
  card = computeCycle({ columns, startId: 2, endId: 4, toColumnId: 2, card, at: 't1' });
  assert.strictEqual(card.cycle_started_at, 't1');
  card = computeCycle({ columns, startId: 2, endId: 4, toColumnId: 3, card, at: 't2' });
  assert.strictEqual(card.cycle_started_at, 't1');
  card = computeCycle({ columns, startId: 2, endId: 4, toColumnId: 4, card, at: 't3' });
  assert.deepStrictEqual(card, { cycle_started_at: 't1', cycle_ended_at: 't3' });
});

test('pular a coluna inicial também inicia; voltar da final reabre', () => {
  let card = computeCycle({ columns, startId: 2, endId: 4, toColumnId: 3, card: {}, at: 't1' });
  assert.strictEqual(card.cycle_started_at, 't1');
  card = computeCycle({ columns, startId: 2, endId: 4, toColumnId: 4, card, at: 't2' });
  card = computeCycle({ columns, startId: 2, endId: 4, toColumnId: 3, card, at: 't3' });
  assert.deepStrictEqual(card, { cycle_started_at: 't1', cycle_ended_at: null });
});

test('sem configuração usa primeira e última coluna', () => {
  const card = computeCycle({ columns, startId: null, endId: null, toColumnId: 4, card: {}, at: 'x' });
  assert.deepStrictEqual(card, { cycle_started_at: 'x', cycle_ended_at: 'x' });
});

test('tempo por coluna a partir das movimentações', () => {
  const d = columnDurations([
    { id: 1, to_column_id: 1, moved_at: '2026-01-01T00:00:00.000Z' },
    { id: 2, to_column_id: 2, moved_at: '2026-01-01T10:00:00.000Z' },
    { id: 3, to_column_id: 1, moved_at: '2026-01-02T00:00:00.000Z' },
  ], '2026-01-02T01:00:00.000Z');
  assert.strictEqual(d[1], 11 * 3600e3);
  assert.strictEqual(d[2], 14 * 3600e3);
});

test('estatísticas', () => {
  assert.deepStrictEqual(stats([4, 1, 3, 2]), { count: 4, avg: 2.5, median: 2.5, min: 1, max: 4 });
});
