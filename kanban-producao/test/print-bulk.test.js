'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { q } = require('../server/db');
const { router, seedBoard } = require('../server/routes');
const cards = require('../server/cards');
const print = require('../server/print');

q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'a@a.com', 'x', 'admin')");
q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Leitor', 'v@a.com', 'x', 'viewer')");
const boardId = seedBoard(1);
const cols = q.all('SELECT * FROM columns WHERE board_id = ? ORDER BY position', boardId);

function server(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = q.get('SELECT * FROM users WHERE id = ?', userId); next(); });
  app.use('/api', router);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}
async function call(s, method, url, body) {
  const res = await fetch(`http://127.0.0.1:${s.address().port}/api${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('modelo de etiqueta: padrão com os campos do quadro e limpeza do que vem da tela', () => {
  const { templates, default_id } = print.getTemplates(boardId);
  assert.strictEqual(default_id, 'padrao');
  assert.strictEqual(templates[0].width_mm, 100);
  assert.strictEqual(templates[0].height_mm, 150);
  assert.ok(templates[0].items.some((i) => i.key.startsWith('field:')));
  const t = print.sanitizeTemplate({ name: '', width_mm: 9999, orientation: 'x', items: [{ key: 'qr', size: 'huge' }, { key: 'field:99999' }, { key: 'barcode', source: 'field:abc' }, { key: '<script>' }] }, boardId);
  assert.strictEqual(t.name, 'Etiqueta');
  assert.strictEqual(t.width_mm, 300);
  assert.strictEqual(t.orientation, 'portrait');
  assert.deepStrictEqual(t.items.map((i) => [i.key, i.size]), [['qr', 'm'], ['barcode', 'm']]);
  assert.strictEqual(t.items[1].source, 'card_id');
  const saved = print.saveTemplates(boardId, { templates: [t, { ...t, id: t.id, name: 'Outra' }], default_id: 'nao-existe' });
  assert.strictEqual(saved.templates.length, 2);
  assert.notStrictEqual(saved.templates[0].id, saved.templates[1].id, 'ids repetidos são trocados');
  assert.strictEqual(saved.default_id, saved.templates[0].id);
});

test('seleção: ids da coluna, dados dos cards e ações em lote', async () => {
  const a = cards.createCard({ columnId: cols[0].id, title: 'A' }, 1);
  const b = cards.createCard({ columnId: cols[0].id, title: 'B' }, 1);
  const c = cards.createCard({ columnId: cols[1].id, title: 'C' }, 1);
  const s = await server(1);
  try {
    assert.deepStrictEqual((await call(s, 'GET', `/columns/${cols[0].id}/card-ids`)).body, [a, b]);
    const got = (await call(s, 'GET', `/boards/${boardId}/cards?ids=${c},${a},${b}`)).body;
    assert.deepStrictEqual(got.map((x) => x.title), ['A', 'B', 'C'], 'na ordem do quadro');

    let r = await call(s, 'POST', '/cards/bulk', { ids: [a, b, c], action: 'move', value: cols[2].id });
    assert.deepStrictEqual(r.body, { updated: 3, total: 3 });
    assert.deepStrictEqual(q.all('SELECT title FROM cards WHERE column_id = ? ORDER BY position', cols[2].id).map((x) => x.title), ['A', 'B', 'C'], 'mantém a ordem');

    const label = q.get('SELECT id FROM labels WHERE board_id = ? LIMIT 1', boardId).id;
    r = await call(s, 'POST', '/cards/bulk', { ids: [a, b], action: 'add_label', value: label });
    assert.strictEqual(r.body.updated, 2);
    r = await call(s, 'POST', '/cards/bulk', { ids: [a, b], action: 'add_label', value: label });
    assert.strictEqual(r.body.updated, 0, 'quem já tem a etiqueta não muda');
    r = await call(s, 'POST', '/cards/bulk', { ids: [a], action: 'add_member', value: 2 });
    assert.ok(q.get('SELECT 1 FROM card_members WHERE card_id = ? AND user_id = 2', a));
    r = await call(s, 'POST', '/cards/bulk', { ids: [c], action: 'archive' });
    assert.strictEqual(q.get('SELECT archived FROM cards WHERE id = ?', c).archived, 1);
    assert.strictEqual((await call(s, 'POST', '/cards/bulk', { ids: [a], action: 'explodir' })).status, 400);
    assert.ok(q.get("SELECT 1 FROM activity WHERE card_id = ? AND action = 'card.moved'", a), 'histórico registrado');

    await call(s, 'POST', '/cards/printed', { ids: [a, b], template: 'Ficha' });
    assert.strictEqual(q.get("SELECT COUNT(*) AS n FROM activity WHERE action = 'card.printed'").n, 2);
  } finally { s.close(); }
});
