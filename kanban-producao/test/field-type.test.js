'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const { q } = require('../server/db');
const { seedBoard } = require('../server/routes');
const cards = require('../server/cards');
const rules = require('../server/rules');
const automations = require('../server/automations');

q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Ana', 'a@a.com', 'x', 'admin')");
const boardId = seedBoard(1);
const col = q.get('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1', boardId).id;
const addField = (name, type, options = []) => Number(q.run('INSERT INTO field_defs (board_id, name, type, options, position) VALUES (?, ?, ?, ?, 999)', boardId, name, type, JSON.stringify(options)).lastInsertRowid);
const value = (cardId, fieldId) => { const r = q.get('SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?', cardId, fieldId); return r ? JSON.parse(r.value) : null; };

test('trocar o tipo: texto → lista cria as opções; texto → número converte o que dá e apaga o resto', () => {
  const metal = addField('Metal (texto)', 'text');
  const aro = addField('Aro (texto)', 'text');
  const a = cards.createCard({ columnId: col, title: 'A', fields: { [metal]: 'Ouro 18k', [aro]: '14' } }, 1);
  const b = cards.createCard({ columnId: col, title: 'B', fields: { [metal]: 'Prata', [aro]: 'a definir' } }, 1);
  const c = cards.createCard({ columnId: col, title: 'C', fields: { [metal]: 'Ouro 18k', [aro]: 'aro 16,5' } }, 1);

  assert.deepStrictEqual(cards.changeFieldType(aro, 'number', { dryRun: true }), { converted: 2, lost: 1, from: 'text', to: 'number' });
  assert.strictEqual(value(b, aro), 'a definir', 'simulação não muda nada');
  cards.changeFieldType(aro, 'number');
  assert.deepStrictEqual([value(a, aro), value(b, aro), value(c, aro)], [14, null, 16.5]);

  const r = cards.changeFieldType(metal, 'select');
  assert.strictEqual(r.lost, 0);
  const def = cards.fieldDefs(boardId).find((f) => f.id === metal);
  assert.deepStrictEqual(def.options.map((o) => o.label), ['Ouro 18k', 'Prata']);
  assert.strictEqual(value(a, metal), value(c, metal));
  assert.strictEqual(def.options.find((o) => o.id === value(b, metal)).label, 'Prata');

  // lista → múltipla escolha → checklist mantêm as opções
  cards.changeFieldType(metal, 'multiselect');
  assert.strictEqual(value(a, metal).length, 1);
  cards.changeFieldType(metal, 'checklist');
  assert.deepStrictEqual(value(a, metal).done.length, 1);
  // de volta para texto
  cards.changeFieldType(metal, 'text');
  assert.strictEqual(value(b, metal), '1/2 itens marcados');
  assert.ok(q.get("SELECT 1 FROM activity WHERE action = 'field.type_changed'"));
});

test('datas: texto dd/mm/aaaa → data; data → data e hora; sim/não → checkbox', () => {
  const entrega = addField('Entrega (texto)', 'text');
  const pago = addField('Pago (texto)', 'text');
  const a = cards.createCard({ columnId: col, title: 'D', fields: { [entrega]: '25/12/2026', [pago]: 'Sim' } }, 1);
  cards.changeFieldType(entrega, 'date');
  assert.strictEqual(value(a, entrega), '2026-12-25');
  cards.changeFieldType(entrega, 'datetime');
  assert.match(value(a, entrega), /^2026-12-25T/);
  cards.changeFieldType(pago, 'checkbox');
  assert.strictEqual(value(a, pago), true);
});

test('automação "sempre" com cor do card: pinta enquanto atende e não grava nada', () => {
  const label = q.get('SELECT id FROM labels WHERE board_id = ? LIMIT 1', boardId).id;
  const r = automations.sanitize({ name: 'Urgente', trigger: { type: 'always' }, conditions: [{ type: 'has_label', label }], actions: [{ type: 'paint', color: '#ffd6e0' }, { type: 'highlight', color: '#ff4d6d' }, { type: 'notify' }] });
  assert.deepStrictEqual(r.actions.map((x) => x.type), ['paint', 'highlight'], 'regra visual só aceita borda e cor');
  q.run('INSERT INTO automations (board_id, name, enabled, trigger, conditions, actions, position, created_at) VALUES (?, ?, 1, ?, ?, ?, 1, ?)',
    boardId, r.name, JSON.stringify(r.trigger), JSON.stringify(r.conditions), JSON.stringify(r.actions), new Date().toISOString());
  const id = cards.createCard({ columnId: col, title: 'E', color: '#cde7ff' }, 1);
  const get = () => cards.serializeCards([q.get('SELECT * FROM cards WHERE id = ?', id)])[0];
  assert.strictEqual(get().auto_color, null);
  cards.updateCard(id, { labels: [label] }, 1);
  assert.strictEqual(get().auto_color, '#ffd6e0');
  assert.strictEqual(get().color, '#cde7ff', 'a cor escolhida no card continua guardada');
  cards.updateCard(id, { labels: [] }, 1);
  assert.strictEqual(get().auto_color, null);
  assert.strictEqual(rules.autoColorFor({ labels: [] }, [], {}), null);
  // ação "mudar a cor" (eventos) aceita tirar a cor
  assert.deepStrictEqual(automations.sanitize({ trigger: { type: 'moved' }, actions: [{ type: 'set_color' }] }).actions, [{ type: 'set_color', color: null }]);
});
