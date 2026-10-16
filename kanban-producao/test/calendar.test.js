'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const { q } = require('../server/db');
const auth = require('../server/auth');
const { seedBoard } = require('../server/routes');
const cards = require('../server/cards');
const app = require('../server/index');

test('calendário traz cards pela data escolhida e guarda as preferências do usuário', async () => {
  q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Ana', 'ana@x.com', ?, 'viewer')", auth.hashPassword('123456'));
  const boardId = seedBoard(1);
  const col = q.get('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1', boardId).id;
  const dateField = Number(q.run("INSERT INTO field_defs (board_id, name, type, position) VALUES (?, 'Data da prova', 'date', 99)", boardId).lastInsertRowid);
  const a = cards.createCard({ columnId: col, title: 'Com prazo', dueDate: '2026-10-20T15:00:00.000Z', fields: { [dateField]: '2026-11-03' } }, 1);
  cards.createCard({ columnId: col, title: 'Prazo em dezembro', dueDate: '2026-12-01T15:00:00.000Z' }, 1);
  const c = cards.createCard({ columnId: col, title: 'Sem prazo' }, 1);

  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ana@x.com', password: '123456' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (url, opts = {}) => fetch(`${base}${url}`, { ...opts, headers: { Cookie: cookie, 'Content-Type': 'application/json' } }).then((r) => r.json());

  const oct = await call(`/boards/${boardId}/calendar?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`);
  assert.deepStrictEqual(oct.cards.map((x) => x.id), [a]);
  assert.strictEqual(oct.undated_total, 1);
  assert.strictEqual(oct.undated[0].id, c);

  // Usuário somente leitura também pode escolher o que ver
  const prefs = await call(`/boards/${boardId}/calendar-prefs`, { method: 'PUT', body: JSON.stringify({ date_source: `field:${dateField}`, show: ['title', `field:${dateField}`, 'hack'], mode: 'week' }) });
  assert.deepStrictEqual(prefs.show, ['title', `field:${dateField}`]);
  assert.strictEqual(prefs.mode, 'week');
  const nov = await call(`/boards/${boardId}/calendar?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z`);
  assert.deepStrictEqual(nov.cards.map((x) => x.id), [a]);
  assert.strictEqual(nov.undated_total, 2);

  // Campo de data excluído: volta para o prazo de entrega
  q.run('DELETE FROM field_defs WHERE id = ?', dateField);
  const fallback = await call(`/boards/${boardId}/calendar?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`);
  assert.strictEqual(fallback.prefs.date_source, 'due_date');
  assert.deepStrictEqual(fallback.cards.map((x) => x.id), [a]);
  server.close();
});
