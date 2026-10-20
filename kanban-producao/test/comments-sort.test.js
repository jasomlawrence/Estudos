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
const comments = require('../server/comments');
const rules = require('../server/rules');

q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Ana Volpi', 'a@a.com', 'x', 'admin')");
q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Bruno Ourives', 'b@a.com', 'x', 'member')");
q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Bruna Lima', 'c@a.com', 'x', 'member')");
const boardId = seedBoard(1);
const cols = q.all('SELECT * FROM columns WHERE board_id = ? ORDER BY position', boardId);
const user = (id) => q.get('SELECT * FROM users WHERE id = ?', id);

test('menções: nome completo, primeiro nome único, sem confundir nomes parecidos', () => {
  const users = q.all('SELECT id, name FROM users');
  assert.deepStrictEqual(comments.parseMentions('@Bruno Ourives pode ver?', users), [2]);
  assert.ok(comments.parseMentions('oi @bruno, e @Ana', users).includes(1));
  assert.ok(comments.parseMentions('oi @bruno, e @Ana', users).includes(2));
  assert.ok(!comments.parseMentions('oi @bruno', users).includes(3), '@bruno não pega Bruna');
  assert.deepStrictEqual(comments.parseMentions('email a@a.com sem menção', users), []);
});

test('comentário no card avisa quem foi mencionado (e não o autor); conversa do quadro conta não lidas', () => {
  const id = cards.createCard({ columnId: cols[0].id, title: 'Solitário Ana' }, 1);
  const c = comments.addComment({ boardId, cardId: id, user: user(1), body: 'Confere a cravação @Bruno Ourives e @Ana Volpi', mentions: [2] });
  assert.deepStrictEqual(c.mentions.sort(), [1, 2]);
  const notes = q.all('SELECT * FROM notifications WHERE user_id = 2');
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].message, /Ana Volpi mencionou você no card "Solitário Ana"/);
  assert.strictEqual(q.all('SELECT * FROM notifications WHERE user_id = 1').length, 0, 'autor não é avisado');
  assert.strictEqual(cards.serializeCards([q.get('SELECT * FROM cards WHERE id = ?', id)])[0].comment_count, 1);

  comments.addComment({ boardId, user: user(2), body: 'Bom dia equipe' });
  comments.addComment({ boardId, user: user(2), body: '@Ana chegou o lote de pedras' });
  assert.strictEqual(comments.chatUnread(1, boardId), 2);
  assert.strictEqual(comments.chatUnread(2, boardId), 0, 'as próprias mensagens não contam');
  comments.markChatRead(1, boardId);
  assert.strictEqual(comments.chatUnread(1, boardId), 0);
  assert.strictEqual(comments.listComments({ boardId }).length, 2);

  const edited = comments.editComment(c.id, user(1), 'Confere @Bruna Lima');
  assert.deepStrictEqual(edited.mentions, [3]);
  assert.throws(() => comments.editComment(c.id, user(2), 'x'), /Só quem escreveu/);
  comments.deleteComment(c.id, user(1));
  assert.strictEqual(comments.listComments({ boardId, cardId: id }).length, 0);
});

test('ordenar coluna: por prazo, por campo de lista (ordem das opções) e vazios no fim', () => {
  const col = cols[1];
  const metal = q.get("SELECT * FROM field_defs WHERE board_id = ? AND type = 'select' LIMIT 1", boardId);
  const opts = JSON.parse(metal.options);
  const mk = (title, due, opt) => cards.createCard({ columnId: col.id, title, dueDate: due, fields: opt ? { [metal.id]: opt.id } : {} }, 1);
  mk('#1003', '2026-11-20T12:00:00Z', opts[1]);
  mk('#1001', null, opts[0]);
  mk('#1010', '2026-11-05T12:00:00Z', null);
  mk('#1002', '2026-11-10T12:00:00Z', opts[0]);
  const titles = () => q.all('SELECT title FROM cards WHERE column_id = ? ORDER BY position', col.id).map((r) => r.title);
  cards.sortColumn(col.id, { by: 'due_date' });
  assert.deepStrictEqual(titles(), ['#1010', '#1002', '#1003', '#1001']);
  cards.sortColumn(col.id, { by: 'title', dir: 'desc' });
  assert.deepStrictEqual(titles(), ['#1010', '#1003', '#1002', '#1001'], 'número em ordem numérica');
  cards.sortColumn(col.id, { by: `field:${metal.id}` });
  assert.deepStrictEqual(titles(), ['#1002', '#1001', '#1003', '#1010'], 'segue a ordem das opções; empate mantém a ordem anterior; vazio no fim');
  assert.throws(() => cards.sortColumn(col.id, { by: 'nada' }), /Escolha/);
});

test('checklist: itens do modelo + extras, progresso e condição "todo marcado"', () => {
  const info = q.run("INSERT INTO field_defs (board_id, name, type, options, position, show_on_card) VALUES (?, 'Controle de qualidade', 'checklist', ?, 9999, 1)",
    boardId, JSON.stringify([{ id: 'a', label: 'Polimento' }, { id: 'b', label: 'Cravação firme' }]));
  const def = cards.fieldDefs(boardId).find((f) => f.id === Number(info.lastInsertRowid));
  assert.strictEqual(cards.normalizeValue(def, { done: [] }), null);
  const v = cards.normalizeValue(def, { done: ['a', 'zzz', 'x1'], extra: [{ id: 'x1', label: 'Gravação "Para sempre"' }, { label: '   ' }] });
  assert.deepStrictEqual(v, { done: ['a', 'x1'], extra: [{ id: 'x1', label: 'Gravação "Para sempre"' }] });
  assert.strictEqual(cards.displayValue(def, v), '2/3 itens marcados');
  const ctx = { now: Date.now(), fields: [def] };
  const card = { labels: [], members: [], fields: { [def.id]: v } };
  assert.ok(rules.conditionMatches(card, { type: 'field', field: def.id, op: 'incomplete' }, ctx));
  card.fields[def.id] = { ...v, done: ['a', 'b', 'x1'] };
  assert.ok(rules.conditionMatches(card, { type: 'field', field: def.id, op: 'complete' }, ctx));
});
