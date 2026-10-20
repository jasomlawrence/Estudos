'use strict';
// Comentários nos cards e conversa do quadro, com menções (@Nome) que avisam a pessoa
const { q, now } = require('./db');
const { broadcast, sendToUser } = require('./events');
const { httpError, parseJSON } = require('./cards');
const notifications = require('./notifications');
const { fold } = require('./rules');

const MAX_BODY = 4000;

/**
 * Quem foi mencionado: "@Nome Completo" ou só "@Nome" quando o primeiro nome é único.
 * Também aceita ids escolhidos na lista de sugestões (mais confiável que o texto).
 */
function parseMentions(body, users, chosen = []) {
  const text = fold(body);
  const found = new Set(chosen.map(Number).filter((id) => users.some((u) => u.id === id && text.includes(`@${fold(u.name).split(' ')[0]}`))));
  const firstCount = {};
  for (const u of users) { const f = fold(u.name).split(' ')[0]; firstCount[f] = (firstCount[f] || 0) + 1; }
  for (const u of users) {
    const full = fold(u.name);
    const first = full.split(' ')[0];
    const at = (name) => new RegExp(`(^|[^\\p{L}\\p{N}])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(text);
    if (at(full) || (firstCount[first] === 1 && at(first))) found.add(u.id);
  }
  return [...found];
}

const serialize = (c) => ({ ...c, mentions: parseJSON(c.mentions, []) });

function listComments({ boardId, cardId = null, before = null, limit = 50 }) {
  const rows = q.all(`SELECT c.*, u.name AS user_name FROM comments c LEFT JOIN users u ON u.id = c.user_id
                      WHERE c.board_id = ? AND ${cardId ? 'c.card_id = ?' : 'c.card_id IS NULL'} ${before ? 'AND c.id < ?' : ''}
                      ORDER BY c.id DESC LIMIT ?`, ...[boardId, cardId, before].filter((v) => v !== null), limit);
  return rows.reverse().map(serialize);
}

function snippet(body) {
  const s = String(body).replace(/\s+/g, ' ').trim();
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
}

/** Avisa quem foi mencionado: sininho + notificação do navegador (e e-mail, se os avisos por e-mail estiverem ligados) */
async function notifyMentions(comment, author, card) {
  const ids = parseJSON(comment.mentions, []).filter((id) => id !== author.id);
  if (!ids.length) return;
  const where = card ? `no card "${card.title}"` : 'na conversa do quadro';
  const text = `💬 ${author.name} mencionou você ${where}: "${snippet(comment.body)}"`;
  const users = ids.map((id) => q.get('SELECT * FROM users WHERE id = ? AND active = 1', id)).filter(Boolean);
  for (const u of users) {
    const info = q.run('INSERT INTO notifications (user_id, card_id, message, created_at) VALUES (?, ?, ?, ?)', u.id, card?.id ?? null, text, now());
    sendToUser(u.id, 'notification', { id: Number(info.lastInsertRowid), card_id: card?.id ?? null, message: text, title: `${author.name} mencionou você`, chat: !card });
  }
  const cfg = notifications.getConfig(comment.board_id);
  if (cfg.email && card) {
    await notifications.deliver({ card, recipients: users, text, subject: `${author.name} mencionou você: ${card.title}`, inApp: false, email: true })
      .catch((err) => console.error('[menções]', err.message));
  }
}

function addComment({ boardId, cardId = null, user, body, mentions = [] }) {
  const text = String(body || '').trim().slice(0, MAX_BODY);
  if (!text) throw httpError(400, 'Escreva a mensagem.');
  const card = cardId ? q.get('SELECT * FROM cards WHERE id = ?', cardId) : null;
  if (cardId && !card) throw httpError(404, 'Card não encontrado.');
  const users = q.all('SELECT id, name FROM users WHERE active = 1');
  const ids = parseMentions(text, users, mentions);
  const info = q.run('INSERT INTO comments (board_id, card_id, user_id, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    card?.board_id ?? boardId, card?.id ?? null, user.id, text, JSON.stringify(ids), now());
  const comment = q.get('SELECT c.*, u.name AS user_name FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?', Number(info.lastInsertRowid));
  notifyMentions(comment, user, card).catch(() => {});
  broadcast('comment', { boardId: comment.board_id, cardId: comment.card_id, id: comment.id, userId: user.id });
  return serialize(comment);
}

function editComment(id, user, body) {
  const c = q.get('SELECT * FROM comments WHERE id = ?', id);
  if (!c) throw httpError(404, 'Mensagem não encontrada.');
  if (c.user_id !== user.id) throw httpError(403, 'Só quem escreveu pode editar a mensagem.');
  const text = String(body || '').trim().slice(0, MAX_BODY);
  if (!text) throw httpError(400, 'Escreva a mensagem.');
  const users = q.all('SELECT id, name FROM users WHERE active = 1');
  const before = parseJSON(c.mentions, []);
  const ids = parseMentions(text, users);
  q.run('UPDATE comments SET body = ?, mentions = ?, edited_at = ? WHERE id = ?', text, JSON.stringify(ids), now(), c.id);
  const updated = q.get('SELECT c.*, u.name AS user_name FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?', c.id);
  // Quem foi mencionado só na edição também é avisado
  const added = ids.filter((m) => !before.includes(m));
  if (added.length) notifyMentions({ ...updated, mentions: JSON.stringify(added) }, user, c.card_id ? q.get('SELECT * FROM cards WHERE id = ?', c.card_id) : null).catch(() => {});
  broadcast('comment', { boardId: c.board_id, cardId: c.card_id, id: c.id, userId: user.id });
  return serialize(updated);
}

function deleteComment(id, user) {
  const c = q.get('SELECT * FROM comments WHERE id = ?', id);
  if (!c) throw httpError(404, 'Mensagem não encontrada.');
  if (c.user_id !== user.id && user.role !== 'admin') throw httpError(403, 'Só quem escreveu (ou um administrador) pode apagar.');
  q.run('DELETE FROM comments WHERE id = ?', c.id);
  broadcast('comment', { boardId: c.board_id, cardId: c.card_id, id: c.id, userId: user.id, deleted: true });
}

// Mensagens da conversa do quadro ainda não lidas por esta pessoa
const readKey = (userId, boardId) => `chat_read:${userId}:${boardId}`;
function chatUnread(userId, boardId) {
  const last = q.get('SELECT value FROM settings WHERE key = ?', readKey(userId, boardId));
  const lastId = last ? Number(JSON.parse(last.value)) : 0;
  return q.get('SELECT COUNT(*) AS n FROM comments WHERE board_id = ? AND card_id IS NULL AND id > ? AND user_id IS NOT ?', boardId, lastId, userId).n;
}
function markChatRead(userId, boardId) {
  const last = q.get('SELECT MAX(id) AS id FROM comments WHERE board_id = ? AND card_id IS NULL', boardId).id || 0;
  q.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, readKey(userId, boardId), JSON.stringify(last));
}

module.exports = { parseMentions, listComments, addComment, editComment, deleteComment, chatUnread, markChatRead };
