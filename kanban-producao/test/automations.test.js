'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const { q, now } = require('../server/db');
const { seedBoard } = require('../server/routes');
const cards = require('../server/cards');
const automations = require('../server/automations');
const rules = require('../server/rules');

const DAY = 864e5;
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { await tick(); await tick(); await automations.idle(); await tick(); await automations.idle(); };

function addRule(boardId, input) {
  const r = automations.sanitize(input);
  const info = q.run('INSERT INTO automations (board_id, name, enabled, trigger, conditions, actions, position, created_at) VALUES (?, ?, 1, ?, ?, ?, 1, ?)',
    boardId, r.name, JSON.stringify(r.trigger), JSON.stringify(r.conditions), JSON.stringify(r.actions), now());
  return Number(info.lastInsertRowid);
}

test('condições: prazo próximo, vencido, etiqueta e campo', () => {
  const ctx = { now: Date.parse('2026-10-15T12:00:00Z'), fields: [{ id: 1, type: 'select', options: [{ id: 'o', label: 'Ouro' }] }, { id: 2, type: 'number' }, { id: 3, type: 'text' }] };
  const card = { labels: [5], members: [], column_id: 9, due_date: new Date(ctx.now + 1.5 * DAY).toISOString(), cycle_ended_at: null, fields: { 1: 'o', 2: 18, 3: 'Gravação: Para sempre' } };
  assert.ok(rules.conditionMatches(card, { type: 'due_within', days: 2 }, ctx));
  assert.ok(!rules.conditionMatches(card, { type: 'due_within', days: 1 }, ctx));
  assert.ok(!rules.conditionMatches(card, { type: 'overdue' }, ctx));
  assert.ok(rules.conditionMatches({ ...card, due_date: new Date(ctx.now - DAY).toISOString() }, { type: 'overdue' }, ctx));
  assert.ok(!rules.conditionMatches({ ...card, cycle_ended_at: 'x', due_date: new Date(ctx.now - DAY).toISOString() }, { type: 'overdue' }, ctx), 'concluído não fica vencido');
  assert.ok(rules.conditionMatches(card, { type: 'has_label', label: 5 }, ctx));
  assert.ok(rules.conditionMatches(card, { type: 'field', field: 1, op: 'equals', value: 'o' }, ctx));
  assert.ok(rules.conditionMatches(card, { type: 'field', field: 2, op: 'gt', value: '17,5' }, ctx));
  assert.ok(rules.conditionMatches(card, { type: 'field', field: 3, op: 'contains', value: 'para SEMPRE' }, ctx));
  assert.ok(!rules.conditionMatches(card, { type: 'field', field: 3, op: 'empty' }, ctx));
  assert.strictEqual(rules.renderMessage('{titulo} em {coluna} / {campo:Metal}', { titulo: 'Anel', coluna: 'Fundição', fieldsByName: { metal: 'Ouro' } }), 'Anel em Fundição / Ouro');
});

test('destaque visual vem junto com o card e avisos disparam ao mover', async () => {
  q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'a@a.com', 'x', 'admin')");
  q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Ourives', 'o@a.com', 'x', 'member')");
  const boardId = seedBoard(1);
  const cols = q.all('SELECT * FROM columns WHERE board_id = ? ORDER BY position', boardId);
  const label = q.get('SELECT * FROM labels WHERE board_id = ? LIMIT 1', boardId);

  addRule(boardId, { name: 'Prazo próximo', trigger: { type: 'always' }, conditions: [{ type: 'due_within', days: 3 }], actions: [{ type: 'highlight', color: '#ff9f43', text: 'Prazo perto' }] });
  addRule(boardId, { name: 'Urgente', trigger: { type: 'always' }, conditions: [{ type: 'has_label', label: label.id }], actions: [{ type: 'highlight', color: '#ff4d6d' }, { type: 'notify' }] });
  addRule(boardId, { name: 'Chegou na fundição', trigger: { type: 'moved', columns: [cols[2].id] }, actions: [{ type: 'notify', to: 'users', users: [2], message: '{titulo} chegou em {coluna}' }, { type: 'add_label', label: label.id }] });

  const id = cards.createCard({ columnId: cols[0].id, title: 'Solitário Ana', dueDate: new Date(Date.now() + 2 * DAY).toISOString() }, 1);
  let [c] = cards.serializeCards([q.get('SELECT * FROM cards WHERE id = ?', id)]);
  assert.deepStrictEqual(c.highlights.map((x) => x.color), ['#ff9f43']);
  assert.strictEqual(c.highlights[0].text, 'Prazo perto');

  cards.moveCard(id, { columnId: cols[2].id }, 1);
  await settle();
  const notes = q.all('SELECT * FROM notifications WHERE user_id = 2');
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].message, /Solitário Ana chegou em/);
  [c] = cards.serializeCards([q.get('SELECT * FROM cards WHERE id = ?', id)]);
  assert.ok(c.labels.includes(label.id), 'etiqueta adicionada pela automação');
  assert.deepStrictEqual(c.highlights.map((x) => x.color), ['#ff9f43', '#ff4d6d']);
  assert.ok(q.get("SELECT 1 FROM activity WHERE action = 'automation.ran'"));

  // mover para outra coluna não dispara
  cards.moveCard(id, { columnId: cols[1].id }, 1);
  await settle();
  assert.strictEqual(q.all('SELECT * FROM notifications WHERE user_id = 2').length, 1);
});

test('"passou a atender": dispara uma vez e de novo só depois de sair da condição', async () => {
  const boardId = q.get('SELECT id FROM boards LIMIT 1').id;
  const cols = q.all('SELECT * FROM columns WHERE board_id = ? ORDER BY position', boardId);
  const rule = addRule(boardId, { name: 'Vencido', trigger: { type: 'match' }, conditions: [{ type: 'overdue' }], actions: [{ type: 'notify', to: 'admins' }] });
  const id = cards.createCard({ columnId: cols[0].id, title: 'Aliança', dueDate: new Date(Date.now() - DAY).toISOString() }, 1);
  await settle();
  await automations.sweep();
  const count = () => q.all("SELECT * FROM notifications WHERE user_id = 1 AND message LIKE '%Aliança%'").length;
  assert.strictEqual(count(), 1);
  cards.updateCard(id, { title: 'Aliança' , description: 'x' }, 1);
  await settle();
  assert.strictEqual(count(), 1);
  cards.updateCard(id, { due_date: new Date(Date.now() + 5 * DAY).toISOString() }, 1);
  await settle();
  assert.ok(!q.get('SELECT 1 FROM notification_log WHERE dedupe_key = ?', `auto:${rule}:${id}`));
  cards.updateCard(id, { due_date: new Date(Date.now() - 2 * DAY).toISOString() }, 1);
  await settle();
  assert.strictEqual(count(), 2);
});

test('sanitize: regra visual só aceita destaque; eventos não aceitam destaque', () => {
  const v = automations.sanitize({ trigger: { type: 'always' }, actions: [{ type: 'notify' }, { type: 'highlight', color: 'red' }] });
  assert.deepStrictEqual(v.actions, [{ type: 'highlight', color: '#ff6b6b', text: '' }]);
  const e = automations.sanitize({ trigger: { type: 'moved', columns: ['3'] }, actions: [{ type: 'highlight' }, { type: 'webhook', url: 'javascript:x' }] });
  assert.deepStrictEqual(e.trigger, { type: 'moved', columns: [3], from: [] });
  assert.deepStrictEqual(e.actions, [{ type: 'webhook', url: '', message: '' }]);
});
