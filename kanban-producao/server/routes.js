'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { q, getSetting, setSetting, now, UPLOAD_DIR, DEFAULT_BACKGROUND, DEFAULT_COLUMN_COLOR } = require('./db');
const auth = require('./auth');
const events = require('./events');
const cards = require('./cards');
const shopify = require('./shopify');
const sheets = require('./sheets');
const notifications = require('./notifications');
const correios = require('./correios');
const { cycleMs, stats, columnDurations, resolveCycleColumns } = require('./cycle');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const { httpError, logActivity, parseJSON } = cards;
const AVATAR_COLORS = ['#5b6ee1', '#e1765b', '#2fa36b', '#b25be1', '#e1b25b', '#3aa0c8', '#c84a7a', '#6b7a8f'];

// ---------------- Autenticação ----------------
router.get('/auth/me', (req, res) => {
  const hasUsers = !!q.get('SELECT 1 FROM users LIMIT 1');
  res.json({ user: auth.publicUser(req.user), needsSetup: !hasUsers });
});

router.post('/auth/setup', (req, res) => {
  if (q.get('SELECT 1 FROM users LIMIT 1')) throw httpError(400, 'A configuração inicial já foi feita.');
  const { name, email, password } = req.body;
  if (!name || !email || String(password || '').length < 6) throw httpError(400, 'Informe nome, e-mail e uma senha com pelo menos 6 caracteres.');
  const info = q.run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', name, email.trim(), auth.hashPassword(password), 'admin');
  seedBoard(Number(info.lastInsertRowid));
  auth.setSessionCookie(req, res, auth.createSession(Number(info.lastInsertRowid)));
  res.json({ ok: true });
});

router.post('/auth/login', (req, res) => {
  const user = q.get('SELECT * FROM users WHERE email = ? AND active = 1', String(req.body.email || '').trim());
  if (!user || !auth.verifyPassword(String(req.body.password || ''), user.password_hash)) throw httpError(401, 'E-mail ou senha incorretos.');
  auth.setSessionCookie(req, res, auth.createSession(user.id));
  res.json({ user: auth.publicUser(user) });
});

router.post('/auth/logout', (req, res) => {
  if (req.sessionToken) q.run('DELETE FROM sessions WHERE token = ?', req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.use(auth.requireAuth);

router.post('/auth/password', (req, res) => {
  const { current, password } = req.body;
  if (!auth.verifyPassword(String(current || ''), req.user.password_hash)) throw httpError(400, 'Senha atual incorreta.');
  if (String(password || '').length < 6) throw httpError(400, 'A nova senha precisa de pelo menos 6 caracteres.');
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), req.user.id);
  res.json({ ok: true });
});

router.get('/events', (req, res) => events.addClient(res, req.user.id));

// ---------------- Usuários ----------------
router.get('/users', (req, res) => {
  res.json(q.all('SELECT * FROM users ORDER BY name').map(auth.publicUser));
});

router.post('/users', auth.requireAdmin, (req, res) => {
  const { name, email, password, role = 'member' } = req.body;
  if (!name || !email || String(password || '').length < 6) throw httpError(400, 'Informe nome, e-mail e senha (mín. 6 caracteres).');
  if (!['admin', 'member', 'viewer'].includes(role)) throw httpError(400, 'Perfil inválido.');
  if (q.get('SELECT 1 FROM users WHERE email = ?', email.trim())) throw httpError(400, 'Já existe um usuário com esse e-mail.');
  const color = AVATAR_COLORS[(q.get('SELECT COUNT(*) AS n FROM users').n) % AVATAR_COLORS.length];
  const info = q.run('INSERT INTO users (name, email, password_hash, role, avatar_color) VALUES (?, ?, ?, ?, ?)', name, email.trim(), auth.hashPassword(password), role, color);
  logActivity(null, null, req.user.id, 'user.created', { name, role });
  res.json(auth.publicUser(q.get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid)));
});

router.patch('/users/:id', auth.requireAdmin, (req, res) => {
  const user = q.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!user) throw httpError(404, 'Usuário não encontrado.');
  const { name, role, active, password } = req.body;
  if (user.id === req.user.id && (role && role !== 'admin' || active === false)) throw httpError(400, 'Você não pode remover seu próprio acesso de administrador.');
  if (name) q.run('UPDATE users SET name = ? WHERE id = ?', name, user.id);
  if (role && ['admin', 'member', 'viewer'].includes(role)) q.run('UPDATE users SET role = ? WHERE id = ?', role, user.id);
  if (active !== undefined) {
    q.run('UPDATE users SET active = ? WHERE id = ?', active ? 1 : 0, user.id);
    if (!active) q.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  }
  if (password) {
    if (String(password).length < 6) throw httpError(400, 'Senha muito curta.');
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), user.id);
  }
  logActivity(null, null, req.user.id, 'user.updated', { name: user.name, changes: Object.keys(req.body).filter((k) => k !== 'password').concat(password ? ['senha'] : []) });
  res.json(auth.publicUser(q.get('SELECT * FROM users WHERE id = ?', user.id)));
});

// ---------------- Quadros ----------------
function seedBoard(userId) {
  const info = q.run('INSERT INTO boards (name, background) VALUES (?, ?)', 'Produção de Anéis de Noivado', DEFAULT_BACKGROUND);
  const boardId = Number(info.lastInsertRowid);
  const cols = [['Novos pedidos', '#cde7ff'], ['Design / CAD', '#dcd3ff'], ['Fundição', '#ffe5b4'], ['Cravação', '#fff3b0'], ['Polimento', '#c7f0ec'], ['Controle de qualidade', '#ffd6e0'], ['Pronto para envio', '#d4f8d4']];
  const colIds = cols.map(([name, color], i) => Number(q.run('INSERT INTO columns (board_id, name, color, position) VALUES (?, ?, ?, ?)', boardId, name, color, (i + 1) * 1024).lastInsertRowid));
  q.run('UPDATE boards SET cycle_start_column_id = ?, cycle_end_column_id = ? WHERE id = ?', colIds[1], colIds[colIds.length - 1], boardId);
  for (const [name, color] of [['Urgente', '#ff8f9e'], ['Ouro amarelo', '#ffd166'], ['Ouro branco', '#cbd5e1'], ['Gravação', '#b8a6ff']]) {
    q.run('INSERT INTO labels (board_id, name, color) VALUES (?, ?, ?)', boardId, name, color);
  }
  const fields = [
    ['Cliente', 'text', [], 1], ['Pedido Shopify', 'text', [], 1], ['Tamanho do aro', 'number', [], 1],
    ['Metal', 'select', [{ id: 'o1', label: 'Ouro amarelo 18k', color: '#ffe08a' }, { id: 'o2', label: 'Ouro branco 18k', color: '#e2e8f0' }, { id: 'o3', label: 'Ouro rosé 18k', color: '#ffd0c2' }, { id: 'o4', label: 'Platina', color: '#d5dcea' }], 1],
    ['Pedra', 'text', [], 0], ['Gravação', 'text', [], 0], ['Valor', 'currency', [], 0], ['Telefone', 'phone', [], 0], ['E-mail', 'email', [], 0],
  ];
  fields.forEach(([name, type, options, show], i) => q.run('INSERT INTO field_defs (board_id, name, type, options, position, show_on_card) VALUES (?, ?, ?, ?, ?, ?)', boardId, name, type, JSON.stringify(options), (i + 1) * 1024, show));
  logActivity(boardId, null, userId, 'board.created', { name: 'Produção de Anéis de Noivado' });
  return boardId;
}

function boardOr404(id) {
  const board = q.get('SELECT * FROM boards WHERE id = ?', id);
  if (!board) throw httpError(404, 'Quadro não encontrado.');
  return board;
}

router.get('/boards', (req, res) => res.json(q.all('SELECT id, name, background FROM boards ORDER BY id')));

router.post('/boards', auth.requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim() || 'Novo quadro';
  const id = Number(q.run('INSERT INTO boards (name, background) VALUES (?, ?)', name, DEFAULT_BACKGROUND).lastInsertRowid);
  [['A fazer', '#cde7ff'], ['Fazendo', '#fff3b0'], ['Concluído', '#d4f8d4']].forEach(([n, color], i) => q.run('INSERT INTO columns (board_id, name, color, position) VALUES (?, ?, ?, ?)', id, n, color, (i + 1) * 1024));
  logActivity(id, null, req.user.id, 'board.created', { name });
  res.json({ id });
});

function cardFilter(search) {
  if (!search) return { sql: '', params: [] };
  const like = `%${search}%`;
  return {
    sql: `AND (c.title LIKE ? OR c.description LIKE ? OR c.id = ? OR c.id IN (SELECT card_id FROM card_field_values WHERE value LIKE ?))`,
    params: [like, like, Number(search) || -1, like],
  };
}

router.get('/boards/:id', (req, res) => {
  const board = boardOr404(req.params.id);
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 10), 1000);
  const archived = req.query.archived === '1' ? 1 : 0;
  const filter = cardFilter(String(req.query.q || '').trim());
  const prefs = Object.fromEntries(q.all('SELECT column_id, collapsed FROM column_prefs WHERE user_id = ?', req.user.id).map((p) => [p.column_id, !!p.collapsed]));
  const columns = cards.boardColumns(board.id).map((col) => {
    const rows = q.all(`SELECT * FROM cards c WHERE c.column_id = ? AND c.archived = ? ${filter.sql} ORDER BY c.position LIMIT ?`, col.id, archived, ...filter.params, limit);
    const total = q.get(`SELECT COUNT(*) AS n FROM cards c WHERE c.column_id = ? AND c.archived = ? ${filter.sql}`, col.id, archived, ...filter.params).n;
    return { ...col, collapsed: !!prefs[col.id], total, cards: cards.serializeCards(rows) };
  });
  res.json({
    board,
    columns,
    labels: q.all('SELECT * FROM labels WHERE board_id = ? ORDER BY id', board.id),
    fields: cards.fieldDefs(board.id),
    users: q.all('SELECT * FROM users WHERE active = 1 ORDER BY name').map(auth.publicUser),
    correios_enabled: !!correios.getConfig().enabled,
  });
});

// ---------------- Calendário ----------------
const CALENDAR_DEFAULTS = { date_source: 'due_date', show: ['title', 'column', 'labels', 'time'], color_by: 'card', mode: 'month' };
const calendarPrefsKey = (userId, boardId) => `calendar:${userId}:${boardId}`;

function calendarPrefs(userId, boardId) {
  return { ...CALENDAR_DEFAULTS, ...getSetting(calendarPrefsKey(userId, boardId), {}) };
}

/** Coluna SQL que contém a data usada no calendário (prazo, criação ou um campo de data) */
function calendarDateSql(source, boardId) {
  if (source === 'due_date' || source === 'created_at') return { join: '', expr: `c.${source}`, params: [] };
  const m = /^field:(\d+)$/.exec(source);
  const field = m && q.get("SELECT id FROM field_defs WHERE id = ? AND board_id = ? AND type IN ('date', 'datetime')", Number(m[1]), boardId);
  if (!field) throw httpError(400, 'Escolha uma data válida para o calendário.');
  return { join: 'LEFT JOIN card_field_values v ON v.card_id = c.id AND v.field_id = ?', expr: "json_extract(v.value, '$')", params: [field.id] };
}

router.get('/boards/:id/calendar', (req, res) => {
  const board = boardOr404(req.params.id);
  const prefs = calendarPrefs(req.user.id, board.id);
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!from || !to) throw httpError(400, 'Informe o período.');
  let date;
  try { date = calendarDateSql(String(req.query.date || prefs.date_source), board.id); } catch {
    prefs.date_source = 'due_date'; // o campo de data escolhido foi excluído
    date = calendarDateSql('due_date', board.id);
  }
  const archived = req.query.archived === '1' ? 1 : 0;
  const filter = cardFilter(String(req.query.q || '').trim());
  const base = `FROM cards c ${date.join} WHERE c.board_id = ? AND c.archived = ? ${filter.sql}`;
  const params = [...date.params, board.id, archived, ...filter.params];
  const rows = q.all(`SELECT c.* ${base} AND ${date.expr} >= ? AND ${date.expr} < ? ORDER BY ${date.expr} LIMIT 3000`, ...params, from, to);
  const undated = q.all(`SELECT c.* ${base} AND ${date.expr} IS NULL ORDER BY c.created_at DESC LIMIT 100`, ...params);
  const undatedTotal = q.get(`SELECT COUNT(*) AS n ${base} AND ${date.expr} IS NULL`, ...params).n;
  res.json({ prefs, cards: cards.serializeCards(rows), undated: cards.serializeCards(undated), undated_total: undatedTotal });
});

// Preferências do calendário são de cada usuário (o que mostrar, qual data usar)
router.put('/boards/:id/calendar-prefs', (req, res) => {
  const board = boardOr404(req.params.id);
  const current = calendarPrefs(req.user.id, board.id);
  const next = { ...current };
  const { date_source, show, color_by, mode } = req.body;
  if (date_source !== undefined) { calendarDateSql(String(date_source), board.id); next.date_source = String(date_source); }
  if (Array.isArray(show)) next.show = show.map(String).filter((k) => /^(title|column|labels|members|time|cover|field:\d+)$/.test(k));
  if (['card', 'column', 'label'].includes(color_by)) next.color_by = color_by;
  if (['month', 'week'].includes(mode)) next.mode = mode;
  setSetting(calendarPrefsKey(req.user.id, board.id), next);
  res.json(next);
});

// Rolagem infinita: próxima página de cards de uma coluna
router.get('/columns/:id/cards', (req, res) => {
  const col = q.get('SELECT * FROM columns WHERE id = ?', req.params.id);
  if (!col) throw httpError(404, 'Coluna não encontrada.');
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const limit = Math.min(Number(req.query.limit) || 40, 200);
  const filter = cardFilter(String(req.query.q || '').trim());
  const archived = req.query.archived === '1' ? 1 : 0;
  const rows = q.all(`SELECT * FROM cards c WHERE c.column_id = ? AND c.archived = ? ${filter.sql} ORDER BY c.position LIMIT ? OFFSET ?`, col.id, archived, ...filter.params, limit, offset);
  res.json(cards.serializeCards(rows));
});

router.patch('/boards/:id', (req, res) => {
  const board = boardOr404(req.params.id);
  const { name, background, cycle_start_column_id, cycle_end_column_id } = req.body;
  if (name !== undefined) q.run('UPDATE boards SET name = ? WHERE id = ?', String(name).trim() || board.name, board.id);
  if (background !== undefined && /^(#[0-9a-f]{6}|g:[a-z-]+)$/i.test(background)) q.run('UPDATE boards SET background = ? WHERE id = ?', background, board.id);
  if (cycle_start_column_id !== undefined || cycle_end_column_id !== undefined) {
    if (req.user.role !== 'admin') throw httpError(403, 'Apenas administradores alteram o cronômetro de produção.');
    q.run('UPDATE boards SET cycle_start_column_id = ?, cycle_end_column_id = ? WHERE id = ?',
      cycle_start_column_id ?? board.cycle_start_column_id, cycle_end_column_id ?? board.cycle_end_column_id, board.id);
    logActivity(board.id, null, req.user.id, 'board.cycle', {
      start: q.get('SELECT name FROM columns WHERE id = ?', cycle_start_column_id ?? board.cycle_start_column_id)?.name,
      end: q.get('SELECT name FROM columns WHERE id = ?', cycle_end_column_id ?? board.cycle_end_column_id)?.name,
    });
  }
  events.boardChanged(board.id, req.user.id);
  res.json(q.get('SELECT * FROM boards WHERE id = ?', board.id));
});

router.delete('/boards/:id', auth.requireAdmin, (req, res) => {
  const board = boardOr404(req.params.id);
  if (q.get('SELECT COUNT(*) AS n FROM boards').n <= 1) throw httpError(400, 'Mantenha pelo menos um quadro.');
  q.run('DELETE FROM cards WHERE board_id = ?', board.id);
  q.run('DELETE FROM boards WHERE id = ?', board.id);
  res.json({ ok: true });
});

// ---------------- Colunas ----------------
router.post('/boards/:id/columns', (req, res) => {
  const board = boardOr404(req.params.id);
  const max = q.get('SELECT MAX(position) AS p FROM columns WHERE board_id = ?', board.id).p ?? 0;
  const name = String(req.body.name || '').trim() || 'Nova coluna';
  const info = q.run('INSERT INTO columns (board_id, name, color, position) VALUES (?, ?, ?, ?)', board.id, name, req.body.color || DEFAULT_COLUMN_COLOR, max + 1024);
  logActivity(board.id, null, req.user.id, 'column.created', { name });
  events.boardChanged(board.id, req.user.id);
  res.json(q.get('SELECT * FROM columns WHERE id = ?', info.lastInsertRowid));
});

router.patch('/columns/:id', (req, res) => {
  const col = q.get('SELECT * FROM columns WHERE id = ?', req.params.id);
  if (!col) throw httpError(404, 'Coluna não encontrada.');
  const { name, color, collapsed, prevId, nextId } = req.body;
  if (name !== undefined && String(name).trim() && name !== col.name) {
    q.run('UPDATE columns SET name = ? WHERE id = ?', String(name).trim(), col.id);
    logActivity(col.board_id, null, req.user.id, 'column.renamed', { from: col.name, to: String(name).trim() });
  }
  if (color !== undefined && color !== col.color) {
    q.run('UPDATE columns SET color = ? WHERE id = ?', color, col.id);
    logActivity(col.board_id, null, req.user.id, 'column.color', { name: col.name, to: color });
  }
  if (collapsed !== undefined) {
    // Minimizar é uma preferência de cada usuário
    q.run(`INSERT INTO column_prefs (user_id, column_id, collapsed) VALUES (?, ?, ?)
           ON CONFLICT(user_id, column_id) DO UPDATE SET collapsed = excluded.collapsed`, req.user.id, col.id, collapsed ? 1 : 0);
  }
  if (prevId !== undefined || nextId !== undefined) {
    const prev = prevId ? q.get('SELECT position FROM columns WHERE id = ?', prevId) : null;
    const next = nextId ? q.get('SELECT position FROM columns WHERE id = ?', nextId) : null;
    let pos = prev && next ? (prev.position + next.position) / 2 : prev ? prev.position + 1024 : next ? next.position - 1024 : col.position;
    if (prev && next && next.position - prev.position < 1e-6) {
      q.all('SELECT id FROM columns WHERE board_id = ? ORDER BY position', col.board_id).forEach((c, i) => q.run('UPDATE columns SET position = ? WHERE id = ?', (i + 1) * 1024, c.id));
      const p2 = q.get('SELECT position FROM columns WHERE id = ?', prevId).position;
      pos = p2 + 512;
    }
    q.run('UPDATE columns SET position = ? WHERE id = ?', pos, col.id);
    logActivity(col.board_id, null, req.user.id, 'column.moved', { name: col.name });
  }
  if (collapsed === undefined || Object.keys(req.body).length > 1) events.boardChanged(col.board_id, req.user.id);
  res.json({ ok: true });
});

router.delete('/columns/:id', (req, res) => {
  const col = q.get('SELECT * FROM columns WHERE id = ?', req.params.id);
  if (!col) throw httpError(404, 'Coluna não encontrada.');
  const count = q.get('SELECT COUNT(*) AS n FROM cards WHERE column_id = ?', col.id).n;
  const moveTo = req.query.moveTo ? Number(req.query.moveTo) : null;
  if (count && !moveTo) throw httpError(400, 'A coluna tem cards. Escolha para onde movê-los.');
  {
    if (count) {
      const target = q.get('SELECT * FROM columns WHERE id = ? AND board_id = ? AND id != ?', moveTo, col.board_id, col.id);
      if (!target) throw httpError(400, 'Coluna de destino inválida.');
      for (const card of q.all('SELECT id FROM cards WHERE column_id = ? ORDER BY position', col.id)) cards.moveCard(card.id, { columnId: target.id }, req.user.id);
    }
    q.run('UPDATE boards SET cycle_start_column_id = NULL WHERE cycle_start_column_id = ?', col.id);
    q.run('UPDATE boards SET cycle_end_column_id = NULL WHERE cycle_end_column_id = ?', col.id);
    q.run('DELETE FROM columns WHERE id = ?', col.id);
    logActivity(col.board_id, null, req.user.id, 'column.deleted', { name: col.name });
  }
  events.boardChanged(col.board_id, req.user.id);
  res.json({ ok: true });
});

// ---------------- Etiquetas ----------------
router.post('/boards/:id/labels', (req, res) => {
  const board = boardOr404(req.params.id);
  const info = q.run('INSERT INTO labels (board_id, name, color) VALUES (?, ?, ?)', board.id, String(req.body.name || ''), req.body.color || '#61bd4f');
  logActivity(board.id, null, req.user.id, 'label.created', { label: req.body.name, color: req.body.color });
  events.boardChanged(board.id, req.user.id);
  res.json(q.get('SELECT * FROM labels WHERE id = ?', info.lastInsertRowid));
});

router.patch('/labels/:id', (req, res) => {
  const label = q.get('SELECT * FROM labels WHERE id = ?', req.params.id);
  if (!label) throw httpError(404, 'Etiqueta não encontrada.');
  q.run('UPDATE labels SET name = ?, color = ? WHERE id = ?', req.body.name ?? label.name, req.body.color ?? label.color, label.id);
  events.boardChanged(label.board_id, req.user.id);
  res.json({ ok: true });
});

router.delete('/labels/:id', (req, res) => {
  const label = q.get('SELECT * FROM labels WHERE id = ?', req.params.id);
  if (!label) throw httpError(404, 'Etiqueta não encontrada.');
  q.run('DELETE FROM labels WHERE id = ?', label.id);
  logActivity(label.board_id, null, req.user.id, 'label.deleted', { label: label.name, color: label.color });
  events.boardChanged(label.board_id, req.user.id);
  res.json({ ok: true });
});

// ---------------- Campos personalizados ----------------
function cleanOptions(options) {
  return (Array.isArray(options) ? options : []).filter((o) => o && String(o.label || '').trim())
    .map((o) => ({ id: o.id || crypto.randomBytes(4).toString('hex'), label: String(o.label).trim(), color: o.color || '#dfe1e6' }));
}

router.post('/boards/:id/fields', (req, res) => {
  const board = boardOr404(req.params.id);
  const { name, type, options, show_on_card } = req.body;
  if (!String(name || '').trim()) throw httpError(400, 'Dê um nome ao campo.');
  if (!cards.FIELD_TYPES.includes(type)) throw httpError(400, 'Tipo de campo inválido.');
  const max = q.get('SELECT MAX(position) AS p FROM field_defs WHERE board_id = ?', board.id).p ?? 0;
  const info = q.run('INSERT INTO field_defs (board_id, name, type, options, position, show_on_card) VALUES (?, ?, ?, ?, ?, ?)',
    board.id, String(name).trim(), type, JSON.stringify(cleanOptions(options)), max + 1024, show_on_card ? 1 : 0);
  logActivity(board.id, null, req.user.id, 'field.created', { name, type });
  events.boardChanged(board.id, req.user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});

router.patch('/fields/:id', (req, res) => {
  const f = q.get('SELECT * FROM field_defs WHERE id = ?', req.params.id);
  if (!f) throw httpError(404, 'Campo não encontrado.');
  const { name, options, show_on_card, position } = req.body;
  q.run('UPDATE field_defs SET name = ?, options = ?, show_on_card = ?, position = ? WHERE id = ?',
    String(name ?? f.name).trim() || f.name, options ? JSON.stringify(cleanOptions(options)) : f.options,
    show_on_card === undefined ? f.show_on_card : show_on_card ? 1 : 0, position ?? f.position, f.id);
  if (name && name !== f.name) logActivity(f.board_id, null, req.user.id, 'field.renamed', { from: f.name, to: name });
  events.boardChanged(f.board_id, req.user.id);
  res.json({ ok: true });
});

router.delete('/fields/:id', (req, res) => {
  const f = q.get('SELECT * FROM field_defs WHERE id = ?', req.params.id);
  if (!f) throw httpError(404, 'Campo não encontrado.');
  q.run('DELETE FROM field_defs WHERE id = ?', f.id);
  logActivity(f.board_id, null, req.user.id, 'field.deleted', { name: f.name });
  events.boardChanged(f.board_id, req.user.id);
  res.json({ ok: true });
});

// ---------------- Cards ----------------
router.post('/columns/:id/cards', (req, res) => {
  const col = q.get('SELECT * FROM columns WHERE id = ?', req.params.id);
  if (!col) throw httpError(404, 'Coluna não encontrada.');
  const id = cards.createCard({ ...req.body, columnId: col.id, dueDate: req.body.due_date }, req.user.id);
  res.json(cards.cardDetail(id));
});

router.get('/cards/:id', (req, res) => res.json(cards.cardDetail(Number(req.params.id))));

router.patch('/cards/:id', (req, res) => {
  cards.updateCard(Number(req.params.id), req.body, req.user.id);
  res.json(cards.cardDetail(Number(req.params.id)));
});

router.post('/cards/:id/move', (req, res) => {
  cards.moveCard(Number(req.params.id), { columnId: Number(req.body.columnId), prevId: req.body.prevId, nextId: req.body.nextId }, req.user.id);
  // Devolve o card atualizado para a tela trocar só ele, sem redesenhar o quadro inteiro
  res.json(cards.serializeCards([q.get('SELECT * FROM cards WHERE id = ?', Number(req.params.id))])[0]);
});

router.delete('/cards/:id', (req, res) => {
  const files = cards.deleteCard(Number(req.params.id), req.user.id);
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f), { force: true }, () => {});
  res.json({ ok: true });
});

// Recalcula o prazo do card pelos Correios (CEP e data prometida podem ser corrigidos aqui)
router.post('/cards/:id/correios', wrap(async (req, res) => {
  const card = q.get('SELECT * FROM cards WHERE id = ?', req.params.id);
  if (!card) throw httpError(404, 'Card não encontrado.');
  const config = correios.getConfig();
  if (!config.enabled) throw httpError(400, 'A integração com os Correios está desligada.');
  const zip = correios.onlyDigits(req.body.zip ?? card.shipping_zip);
  const promised = req.body.promised_date ? correios.parseDate(req.body.promised_date) : card.promised_date;
  if (!promised) throw httpError(400, 'Informe a data de entrega prometida ao cliente.');
  let r;
  try { r = await correios.deadline({ zip, promised }, config); } catch (err) { throw httpError(400, err.message); }
  q.run('UPDATE cards SET shipping_zip = ?, promised_date = ?, correios_days = ?, correios_service = ? WHERE id = ?', zip, promised, r.days, r.service, card.id);
  logActivity(card.board_id, card.id, req.user.id, 'card.correios', { summary: r.summary });
  if (req.body.apply !== false) cards.updateCard(card.id, { due_date: r.dueDate }, req.user.id);
  else events.boardChanged(card.board_id, req.user.id, card.id);
  res.json({ ...r, card: cards.cardDetail(card.id) });
}));

router.post('/cards/:id/notify', wrap(async (req, res) => {
  const card = q.get('SELECT * FROM cards WHERE id = ?', req.params.id);
  if (!card) throw httpError(404, 'Card não encontrado.');
  const label = card.due_date ? 'Lembrete de prazo de entrega' : 'Lembrete';
  res.json({ channels: await notifications.notifyCard(card, label, { userId: req.user.id }) });
}));

// ---------------- Anexos ----------------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 20) * 1024 * 1024 },
});

router.post('/cards/:id/attachments', upload.array('files', 20), (req, res) => {
  const card = q.get('SELECT * FROM cards WHERE id = ?', req.params.id);
  if (!card) throw httpError(404, 'Card não encontrado.');
  let firstImage = null;
  for (const f of req.files || []) {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const info = q.run('INSERT INTO attachments (card_id, filename, original_name, mime, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      card.id, f.filename, name, f.mimetype, f.size, req.user.id, now());
    if (!firstImage && f.mimetype.startsWith('image/')) firstImage = Number(info.lastInsertRowid);
    logActivity(card.board_id, card.id, req.user.id, 'attachment.added', { name });
  }
  // Primeira imagem vira capa automaticamente se o card ainda não tiver (pode ser desfeito)
  if (firstImage && !card.cover_attachment_id && req.query.cover !== '0') cards.updateCard(card.id, { cover_attachment_id: firstImage }, req.user.id);
  else events.boardChanged(card.board_id, req.user.id, card.id);
  res.json(cards.cardDetail(card.id));
});

router.delete('/attachments/:id', (req, res) => {
  const a = q.get('SELECT a.*, c.board_id, c.cover_attachment_id FROM attachments a JOIN cards c ON c.id = a.card_id WHERE a.id = ?', req.params.id);
  if (!a) throw httpError(404, 'Anexo não encontrado.');
  if (a.cover_attachment_id === a.id) cards.updateCard(a.card_id, { cover_attachment_id: null }, req.user.id);
  q.run('DELETE FROM attachments WHERE id = ?', a.id);
  fs.rm(path.join(UPLOAD_DIR, a.filename), { force: true }, () => {});
  logActivity(a.board_id, a.card_id, req.user.id, 'attachment.removed', { name: a.original_name });
  events.boardChanged(a.board_id, req.user.id, a.card_id);
  res.json(cards.cardDetail(a.card_id));
});

// ---------------- Atividade e notificações ----------------
router.get('/boards/:id/activity', (req, res) => {
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = q.all(`SELECT a.*, u.name AS user_name, c.title AS card_title FROM activity a
                      LEFT JOIN users u ON u.id = a.user_id LEFT JOIN cards c ON c.id = a.card_id
                      WHERE (a.board_id = ? OR a.board_id IS NULL) AND a.id < ? ${req.query.user ? 'AND a.user_id = ?' : ''}
                      ORDER BY a.id DESC LIMIT 50`, req.params.id, before, ...(req.query.user ? [Number(req.query.user)] : []));
  res.json(rows.map((r) => ({ ...r, details: parseJSON(r.details, {}) })));
});

router.get('/notifications', (req, res) => {
  res.json({
    unread: q.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', req.user.id).n,
    items: q.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id),
  });
});

router.post('/notifications/read', (req, res) => {
  q.run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
});

// ---------------- Métricas de produção ----------------
router.get('/boards/:id/metrics', (req, res) => {
  const board = boardOr404(req.params.id);
  const days = Number(req.query.days) || 0;
  const since = days ? new Date(Date.now() - days * 864e5).toISOString() : '';
  const columns = cards.boardColumns(board.id);
  const { start, end } = resolveCycleColumns(columns, board.cycle_start_column_id, board.cycle_end_column_id);
  const done = q.all(`SELECT c.*, col.name AS column_name FROM cards c JOIN columns col ON col.id = c.column_id
                      WHERE c.board_id = ? AND c.cycle_ended_at IS NOT NULL AND c.cycle_ended_at >= ? ORDER BY c.cycle_ended_at DESC`, board.id, since);
  const wip = q.all(`SELECT c.*, col.name AS column_name FROM cards c JOIN columns col ON col.id = c.column_id
                     WHERE c.board_id = ? AND c.archived = 0 AND c.cycle_started_at IS NOT NULL AND c.cycle_ended_at IS NULL ORDER BY c.cycle_started_at`, board.id);
  // Tempo médio por etapa considerando os cards concluídos no período
  const perColumn = {};
  for (const card of done) {
    const moves = q.all('SELECT * FROM card_movements WHERE card_id = ? ORDER BY moved_at, id', card.id);
    for (const [colId, ms] of Object.entries(columnDurations(moves, card.cycle_ended_at))) {
      if (Number(colId) === end?.id) continue;
      (perColumn[colId] ||= []).push(ms);
    }
  }
  const slim = (c) => ({ id: c.id, title: c.title, column_name: c.column_name, due_date: c.due_date, cycle_started_at: c.cycle_started_at, cycle_ended_at: c.cycle_ended_at, ms: cycleMs(c), late: !!(c.due_date && (c.cycle_ended_at || now()) > c.due_date) });
  res.json({
    start: start && { id: start.id, name: start.name },
    end: end && { id: end.id, name: end.name },
    summary: stats(done.map((c) => cycleMs(c))),
    on_time: done.filter((c) => c.due_date).length ? done.filter((c) => c.due_date && c.cycle_ended_at <= c.due_date).length / done.filter((c) => c.due_date).length : null,
    done: done.map(slim),
    wip: wip.map(slim),
    per_column: columns.filter((c) => perColumn[c.id]).map((c) => ({ id: c.id, name: c.name, color: c.color, ...stats(perColumn[c.id]) })),
  });
});

// ---------------- Integrações (somente administradores) ----------------
const mask = (s) => (s ? `••••••${String(s).slice(-4)}` : '');
const isMasked = (s) => typeof s === 'string' && s.startsWith('••••••');

router.get('/integrations/shopify', auth.requireAdmin, (req, res) => {
  const c = shopify.getConfig();
  res.json({ ...c, webhook_secret: mask(c.webhook_secret), access_token: mask(c.access_token), client_secret: mask(c.client_secret), sources: shopify.SOURCES, webhook_path: '/webhooks/shopify/orders', default_api_version: shopify.DEFAULT_API_VERSION });
});

router.put('/integrations/shopify', auth.requireAdmin, (req, res) => {
  const current = shopify.getConfig();
  const next = { ...current, ...req.body };
  delete next.sources; delete next.webhook_path;
  delete next.default_api_version;
  for (const k of ['webhook_secret', 'access_token', 'client_secret']) if (isMasked(next[k])) next[k] = current[k];
  next.client_id = String(next.client_id || '').trim();
  next.shop_domain = shopify.normalizeShopDomain(next.shop_domain);
  setSetting('shopify', next);
  logActivity(next.board_id, null, req.user.id, 'integration.shopify', {});
  res.json({ ok: true });
});

router.post('/integrations/shopify/import', auth.requireAdmin, wrap(async (req, res) => {
  const config = shopify.getConfig();
  const orders = await shopify.fetchRecentOrders(config, Number(req.body.days) || 30);
  let created = 0;
  for (const order of orders) created += await shopify.importOrder(order, config, req.user.id);
  res.json({ orders: orders.length, created });
}));

router.post('/integrations/shopify/register-webhook', auth.requireAdmin, wrap(async (req, res) => {
  const base = String(req.body.public_url || getSetting('app', {}).public_url || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) throw httpError(400, 'Informe o endereço público (https) deste sistema.');
  const id = await shopify.registerWebhook(shopify.getConfig(), `${base}/webhooks/shopify/orders`);
  res.json({ id });
}));

router.post('/integrations/shopify/test', auth.requireAdmin, wrap(async (req, res) => {
  const data = await shopify.graphql(shopify.getConfig(), '{ shop { name myshopifyDomain } }');
  res.json(data.shop);
}));

router.get('/integrations/correios', auth.requireAdmin, (req, res) => {
  const c = correios.getConfig();
  res.json({ ...c, codigo_acesso: mask(c.codigo_acesso), services: correios.SERVICES });
});

router.put('/integrations/correios', auth.requireAdmin, (req, res) => {
  const current = correios.getConfig();
  const next = { ...current, ...req.body };
  delete next.services;
  if (isMasked(next.codigo_acesso)) next.codigo_acesso = current.codigo_acesso;
  if (!['producao', 'homologacao'].includes(next.environment)) next.environment = 'producao';
  if (!['auto', 'property', 'attribute', 'days'].includes(next.promised_source)) next.promised_source = 'auto';
  next.cep_origem = correios.onlyDigits(next.cep_origem);
  next.servico = String(next.servico || '03220').replace(/[^\w]/g, '');
  next.margem_dias = Math.max(0, Number(next.margem_dias) || 0);
  next.promised_days = Math.max(0, Number(next.promised_days) || 0);
  setSetting('correios', next);
  logActivity(null, null, req.user.id, 'integration.correios', {});
  res.json({ ok: true });
});

router.post('/integrations/correios/test', auth.requireAdmin, wrap(async (req, res) => {
  try {
    const config = correios.getConfig();
    const r = await correios.quote(req.body.zip, config);
    const promised = correios.parseDate(req.body.promised_date);
    res.json({ ...r, ...(promised ? await correios.deadline({ zip: req.body.zip, promised }, config) : {}) });
  } catch (err) { throw httpError(400, err.message); }
}));

router.get('/integrations/sheets/:boardId', auth.requireAdmin, (req, res) => {
  const c = sheets.getConfig(Number(req.params.boardId));
  res.json({
    ...c,
    credentials: c.credentials ? { client_email: c.credentials.client_email } : null,
    builtin_columns: sheets.BUILTIN_COLUMNS,
    status: getSetting(`sheets_status:${req.params.boardId}`, null),
  });
});

router.put('/integrations/sheets/:boardId', auth.requireAdmin, (req, res) => {
  const boardId = Number(req.params.boardId);
  const current = sheets.getConfig(boardId);
  const next = { ...current, ...req.body };
  delete next.builtin_columns; delete next.status;
  if (typeof req.body.credentials === 'string' && req.body.credentials.trim()) {
    try { next.credentials = JSON.parse(req.body.credentials); } catch { throw httpError(400, 'O JSON da conta de serviço é inválido.'); }
  } else next.credentials = current.credentials;
  next.spreadsheet_id = sheets.parseSpreadsheetId(next.spreadsheet_id);
  next.sheet_name = String(next.sheet_name || 'Produção').trim() || 'Produção';
  setSetting(`sheets:${boardId}`, next);
  logActivity(boardId, null, req.user.id, 'integration.sheets', { columns: next.columns.length });
  res.json({ ok: true, client_email: next.credentials?.client_email });
});

router.post('/integrations/sheets/:boardId/sync', auth.requireAdmin, wrap(async (req, res) => {
  const boardId = Number(req.params.boardId);
  const count = await sheets.enqueue(boardId, () => sheets.fullSync(boardId)).then(() => getSetting(`sheets_status:${boardId}`));
  if (!count?.ok) throw httpError(400, count?.message || 'Falha ao sincronizar.');
  res.json(count);
}));

router.get('/integrations/notifications/:boardId', auth.requireAdmin, (req, res) => {
  const smtp = notifications.smtpConfig();
  res.json({ ...notifications.getConfig(Number(req.params.boardId)), smtp: { ...smtp, pass: mask(smtp.pass) }, app: getSetting('app', {}) });
});

router.put('/integrations/notifications/:boardId', auth.requireAdmin, (req, res) => {
  const { smtp, app, ...config } = req.body;
  config.days_before = String(config.days_before ?? '').split(/[,;\s]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  setSetting(`notifications:${req.params.boardId}`, { ...notifications.getConfig(Number(req.params.boardId)), ...config });
  if (smtp) {
    const current = notifications.smtpConfig();
    setSetting('smtp', { ...current, ...smtp, pass: isMasked(smtp.pass) ? current.pass : smtp.pass });
  }
  if (app) setSetting('app', { ...getSetting('app', {}), ...app });
  res.json({ ok: true });
});

router.post('/integrations/notifications/check', auth.requireAdmin, wrap(async (req, res) => {
  await notifications.checkDueDates();
  res.json({ ok: true });
}));

module.exports = { router, seedBoard };
