'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const { q, setSetting } = require('../server/db');
const { seedBoard } = require('../server/routes');
const cards = require('../server/cards');

q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Ana', 'a@a.com', 'x', 'admin')");
const boardId = seedBoard(1);
const cols = q.all('SELECT * FROM columns WHERE board_id = ? ORDER BY position', boardId);
const serialized = (id) => cards.serializeCards([q.get('SELECT * FROM cards WHERE id = ?', id)])[0];

test('duplicar: copia o que foi escolhido, fica logo abaixo do original e não leva o vínculo do Shopify', () => {
  const field = q.get("SELECT id FROM field_defs WHERE board_id = ? AND name = 'Cliente'", boardId).id;
  const label = q.get('SELECT id FROM labels WHERE board_id = ? LIMIT 1', boardId).id;
  const src = cards.createCard({ columnId: cols[1].id, title: '#1001 · Maria', description: 'Gravação: Para sempre', color: '#ffd6e0', dueDate: '2026-11-20T12:00:00.000Z',
    fields: { [field]: 'Maria Souza' }, labels: [label], source: 'shopify', externalId: 'shopify:1001:1', externalUrl: 'https://loja/orders/x' }, 1);
  const after = cards.createCard({ columnId: cols[1].id, title: 'depois' }, 1);
  q.run('INSERT INTO card_members (card_id, user_id) VALUES (?, 1)', src);
  const att = Number(q.run("INSERT INTO attachments (card_id, filename, original_name, mime, size, created_at) VALUES (?, 'foto.png', 'foto.png', 'image/png', 10, 'x')", src).lastInsertRowid);
  q.run('UPDATE cards SET cover_attachment_id = ? WHERE id = ?', att, src);

  const copy = cards.duplicateCard(src, {}, 1);
  const c = serialized(copy);
  const raw = q.get('SELECT * FROM cards WHERE id = ?', copy);
  assert.strictEqual(c.title, 'Cópia de #1001 · Maria');
  assert.strictEqual(c.fields[field], 'Maria Souza');
  assert.deepStrictEqual(c.labels, [label]);
  assert.deepStrictEqual(c.members, [1]);
  assert.strictEqual(raw.description, 'Gravação: Para sempre');
  assert.strictEqual(raw.color, '#ffd6e0');
  assert.strictEqual(raw.due_date, '2026-11-20T12:00:00.000Z');
  assert.strictEqual(raw.external_id, null, 'não leva o vínculo com o pedido');
  assert.strictEqual(raw.source, 'manual');
  assert.ok(c.cover && c.cover.endsWith('foto.png'), 'capa copiada (mesmo arquivo)');
  const order = q.all('SELECT id FROM cards WHERE column_id = ? ORDER BY position', cols[1].id).map((r) => r.id);
  assert.deepStrictEqual(order, [src, copy, after], 'fica logo abaixo do original');
  assert.ok(q.get("SELECT 1 FROM activity WHERE card_id = ? AND action = 'card.duplicated'", copy));

  const partial = cards.duplicateCard(src, { title: 'Outra', columnId: cols[2].id, include: ['description'] }, 1);
  const p = serialized(partial);
  assert.strictEqual(p.title, 'Outra');
  assert.strictEqual(p.column_id, cols[2].id);
  assert.deepStrictEqual([p.labels, p.members, p.fields, p.cover], [[], [], {}, null]);
  assert.strictEqual(q.get('SELECT due_date FROM cards WHERE id = ?', partial).due_date, null);
});

test('selo "Novo": vale pelo tempo configurado e some quando o card é movido', () => {
  const id = cards.createCard({ columnId: cols[0].id, title: 'Pedido novo' }, 1);
  assert.strictEqual(serialized(id).is_new, true, 'padrão: 24 horas');
  q.run('UPDATE cards SET created_at = ? WHERE id = ?', new Date(Date.now() - 30 * 36e5).toISOString(), id);
  assert.strictEqual(serialized(id).is_new, false, '30 h depois já não é novo');
  setSetting(`board_prefs:${boardId}`, { new_hours: 72 });
  assert.strictEqual(serialized(id).is_new, true, 'com 3 dias configurados volta a ser novo');
  cards.moveCard(id, { columnId: cols[1].id }, 1);
  assert.strictEqual(serialized(id).is_new, false, 'depois de mover deixa de ser novo');
  setSetting(`board_prefs:${boardId}`, { new_hours: 0 });
  const other = cards.createCard({ columnId: cols[0].id, title: 'Sem selo' }, 1);
  assert.strictEqual(serialized(other).is_new, false, '0 = desligado');
});
