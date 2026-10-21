'use strict';
// Regras de negócio de cards: criação, movimentação, edição, histórico
const { q, transaction, now } = require('./db');
const { bus, boardChanged } = require('./events');
const { computeCycle, columnDurations } = require('./cycle');
const rules = require('./rules');

const FIELD_TYPES = ['text', 'textarea', 'number', 'currency', 'date', 'datetime', 'checkbox', 'select', 'multiselect', 'checklist', 'url', 'email', 'phone'];

function logActivity(boardId, cardId, userId, action, details = {}) {
  q.run('INSERT INTO activity (board_id, card_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    boardId, cardId, userId ?? null, action, JSON.stringify(details), now());
}

function parseJSON(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

function fieldDefs(boardId) {
  return q.all('SELECT * FROM field_defs WHERE board_id = ? ORDER BY position', boardId)
    .map((f) => ({ ...f, options: parseJSON(f.options, []), show_on_card: !!f.show_on_card }));
}

/** Normaliza o valor digitado conforme o tipo do campo. Retorna null para "vazio". */
function normalizeValue(def, value) {
  if (value === undefined || value === null || value === '') return null;
  switch (def.type) {
    case 'number':
    case 'currency': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }
    case 'checkbox': return value === true || value === 'true' || value === 1 || value === '1';
    case 'date': {
      const s = String(value).slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    }
    case 'datetime': {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    case 'select': {
      const opt = def.options.find((o) => o.id === value || o.label === value);
      return opt ? opt.id : null;
    }
    case 'multiselect': {
      const arr = Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim());
      const ids = arr.map((v) => def.options.find((o) => o.id === v || o.label === v)?.id).filter(Boolean);
      return ids.length ? [...new Set(ids)] : null;
    }
    case 'checklist': {
      // { done: [ids marcados], extra: [{ id, label }] } — itens do modelo (opções do campo) + itens só deste card
      const v = typeof value === 'string' ? parseJSON(value, null) : value;
      if (!v || typeof v !== 'object') return null;
      const extra = (Array.isArray(v.extra) ? v.extra : []).filter((x) => x && String(x.label || '').trim()).slice(0, 50)
        .map((x) => ({ id: String(x.id || Math.random().toString(36).slice(2, 10)).slice(0, 24), label: String(x.label).trim().slice(0, 200) }));
      const valid = new Set([...def.options.map((o) => o.id), ...extra.map((x) => x.id)]);
      const done = [...new Set((Array.isArray(v.done) ? v.done : []).map(String))].filter((id) => valid.has(id));
      return done.length || extra.length ? { done, extra } : null;
    }
    default: return String(value);
  }
}

/** Progresso de um campo checklist: quantos itens marcados de quantos */
function checklistProgress(def, value) {
  const total = def.options.length + (value?.extra?.length || 0);
  return { done: Math.min(value?.done?.length || 0, total), total };
}

/** Texto legível do valor (usado no histórico e na planilha). */
function displayValue(def, value) {
  if (value === null || value === undefined) return '';
  switch (def.type) {
    case 'checkbox': return value ? 'Sim' : 'Não';
    case 'currency': return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    case 'number': return String(value).replace('.', ',');
    case 'date': { const [y, m, d] = value.split('-'); return `${d}/${m}/${y}`; }
    case 'datetime': return new Date(value).toLocaleString('pt-BR', { timeZone: process.env.TZ || 'America/Sao_Paulo' });
    case 'select': return def.options.find((o) => o.id === value)?.label ?? '';
    case 'multiselect': return value.map((id) => def.options.find((o) => o.id === id)?.label).filter(Boolean).join(', ');
    case 'checklist': { const p = checklistProgress(def, value); return p.total ? `${p.done}/${p.total} itens marcados` : ''; }
    default: return String(value);
  }
}

function boardColumns(boardId) {
  return q.all('SELECT * FROM columns WHERE board_id = ? ORDER BY position', boardId);
}

function columnName(id) {
  return q.get('SELECT name FROM columns WHERE id = ?', id)?.name ?? '(coluna removida)';
}

function applyCycle(card, toColumnId, at) {
  const board = q.get('SELECT * FROM boards WHERE id = ?', card.board_id);
  const next = computeCycle({
    columns: boardColumns(card.board_id),
    startId: board.cycle_start_column_id,
    endId: board.cycle_end_column_id,
    toColumnId,
    card,
    at,
  });
  q.run('UPDATE cards SET cycle_started_at = ?, cycle_ended_at = ? WHERE id = ?', next.cycle_started_at, next.cycle_ended_at, card.id);
  return next;
}

function positionBetween(columnId, prevId, nextId, excludeId) {
  const prev = prevId ? q.get('SELECT position FROM cards WHERE id = ? AND column_id = ?', prevId, columnId) : null;
  const next = nextId ? q.get('SELECT position FROM cards WHERE id = ? AND column_id = ?', nextId, columnId) : null;
  if (prev && next) {
    if (next.position - prev.position < 1e-6) {
      renumberColumn(columnId, excludeId);
      return positionBetween(columnId, prevId, nextId, excludeId);
    }
    return (prev.position + next.position) / 2;
  }
  if (prev) return prev.position + 1024;
  if (next) return next.position - 1024;
  const max = q.get('SELECT MAX(position) AS p FROM cards WHERE column_id = ? AND id != ?', columnId, excludeId ?? 0).p;
  return (max ?? 0) + 1024;
}

function renumberColumn(columnId, excludeId) {
  const rows = q.all('SELECT id FROM cards WHERE column_id = ? AND id != ? ORDER BY position', columnId, excludeId ?? 0);
  rows.forEach((r, i) => q.run('UPDATE cards SET position = ? WHERE id = ?', (i + 1) * 1024, r.id));
}

const setFieldValues = (card, values, userId, log = true) => {
  const defs = fieldDefs(card.board_id);
  const changes = [];
  for (const [fieldId, raw] of Object.entries(values || {})) {
    const def = defs.find((d) => d.id === Number(fieldId));
    if (!def) continue;
    const value = normalizeValue(def, raw);
    const old = q.get('SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?', card.id, def.id);
    const oldValue = old ? parseJSON(old.value, null) : null;
    if (JSON.stringify(oldValue) === JSON.stringify(value)) continue;
    if (value === null) q.run('DELETE FROM card_field_values WHERE card_id = ? AND field_id = ?', card.id, def.id);
    else q.run(`INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)
                ON CONFLICT(card_id, field_id) DO UPDATE SET value = excluded.value`, card.id, def.id, JSON.stringify(value));
    changes.push({ fieldId: def.id, field: def.name, from: displayValue(def, oldValue), to: displayValue(def, value) });
  }
  if (log) for (const { fieldId, ...c } of changes) logActivity(card.board_id, card.id, userId, 'card.field', c);
  return changes;
};

const createCard = transaction((data, userId) => {
  const column = q.get('SELECT * FROM columns WHERE id = ?', data.columnId);
  if (!column) throw httpError(400, 'Coluna inválida.');
  const at = now();
  const position = data.top
    ? (q.get('SELECT MIN(position) AS p FROM cards WHERE column_id = ?', column.id).p ?? 1024) - 1024
    : positionBetween(column.id, null, null);
  const ship = data.shipping || {};
  const info = q.run(`INSERT INTO cards (board_id, column_id, title, description, color, position, due_date, source, external_id, external_url, created_by, created_at, updated_at,
                                         shipping_zip, promised_date, correios_days, correios_service)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    column.board_id, column.id, String(data.title || 'Sem título').slice(0, 500), data.description || '', data.color || null, position,
    data.dueDate || null, data.source || 'manual', data.externalId || null, data.externalUrl || null, userId ?? null, at, at,
    ship.zip || null, ship.promised || null, ship.days ?? null, ship.service || null);
  const cardId = Number(info.lastInsertRowid);
  const card = q.get('SELECT * FROM cards WHERE id = ?', cardId);
  q.run('INSERT INTO card_movements (card_id, from_column_id, to_column_id, user_id, moved_at) VALUES (?, NULL, ?, ?, ?)', cardId, column.id, userId ?? null, at);
  applyCycle(card, column.id, at);
  setFieldValues(card, data.fields, userId, false);
  for (const labelId of data.labels || []) q.run('INSERT OR IGNORE INTO card_labels (card_id, label_id) SELECT ?, id FROM labels WHERE id = ? AND board_id = ?', cardId, labelId, column.board_id);
  logActivity(column.board_id, cardId, userId, 'card.created', { title: card.title, column: column.name, source: card.source });
  afterChange(column.board_id, cardId, userId, [{ type: 'created', toColumnId: column.id }]);
  return cardId;
});

const moveCard = transaction((cardId, { columnId, prevId, nextId }, userId) => {
  const card = q.get('SELECT * FROM cards WHERE id = ?', cardId);
  if (!card) throw httpError(404, 'Card não encontrado.');
  const target = q.get('SELECT * FROM columns WHERE id = ? AND board_id = ?', columnId, card.board_id);
  if (!target) throw httpError(400, 'Coluna inválida.');
  const position = positionBetween(target.id, prevId, nextId, card.id);
  const at = now();
  const events = [];
  q.run('UPDATE cards SET column_id = ?, position = ?, updated_at = ? WHERE id = ?', target.id, position, at, card.id);
  if (card.column_id !== target.id) {
    q.run('INSERT INTO card_movements (card_id, from_column_id, to_column_id, user_id, moved_at) VALUES (?, ?, ?, ?, ?)', card.id, card.column_id, target.id, userId ?? null, at);
    applyCycle(card, target.id, at);
    logActivity(card.board_id, card.id, userId, 'card.moved', { from: columnName(card.column_id), to: target.name });
    events.push({ type: 'moved', fromColumnId: card.column_id, toColumnId: target.id });
  }
  afterChange(card.board_id, card.id, userId, events);
});

const updateCard = transaction((cardId, patch, userId) => {
  const card = q.get('SELECT * FROM cards WHERE id = ?', cardId);
  if (!card) throw httpError(404, 'Card não encontrado.');
  const events = [];
  const simple = { title: 'título', description: 'descrição', color: 'cor', due_date: 'prazo de entrega', cover_attachment_id: 'capa', archived: 'arquivado' };
  for (const [key, label] of Object.entries(simple)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (key === 'archived') value = value ? 1 : 0;
    if (key === 'title') value = String(value || '').trim().slice(0, 500) || card.title;
    if (key === 'due_date' && value) { const d = new Date(value); value = Number.isNaN(d.getTime()) ? null : d.toISOString(); }
    if (value === '') value = null;
    if (key === 'description' && value === null) value = '';
    if (value === card[key]) continue;
    q.run(`UPDATE cards SET ${key} = ? WHERE id = ?`, value, card.id);
    if (key === 'due_date') q.run("DELETE FROM notification_log WHERE dedupe_key LIKE ?", `due:${card.id}:%`);
    const details = { attribute: label };
    if (key === 'title' || key === 'color') Object.assign(details, { from: card[key], to: value });
    if (key === 'due_date') Object.assign(details, { from: card.due_date, to: value });
    if (key === 'archived') details.to = value ? 'sim' : 'não';
    logActivity(card.board_id, card.id, userId, 'card.updated', details);
  }
  if (Array.isArray(patch.labels)) {
    const current = q.all('SELECT l.id, l.name, l.color FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = ?', card.id);
    const wanted = new Set(patch.labels.map(Number));
    for (const l of current) if (!wanted.has(l.id)) {
      q.run('DELETE FROM card_labels WHERE card_id = ? AND label_id = ?', card.id, l.id);
      logActivity(card.board_id, card.id, userId, 'card.label_removed', { label: l.name, color: l.color });
    }
    for (const id of wanted) if (!current.some((l) => l.id === id)) {
      const l = q.get('SELECT * FROM labels WHERE id = ? AND board_id = ?', id, card.board_id);
      if (!l) continue;
      q.run('INSERT OR IGNORE INTO card_labels (card_id, label_id) VALUES (?, ?)', card.id, id);
      logActivity(card.board_id, card.id, userId, 'card.label_added', { label: l.name, color: l.color });
      events.push({ type: 'label_added', labelId: id });
    }
  }
  if (Array.isArray(patch.members)) {
    const current = q.all('SELECT u.id, u.name FROM card_members cm JOIN users u ON u.id = cm.user_id WHERE cm.card_id = ?', card.id);
    const wanted = new Set(patch.members.map(Number));
    for (const u of current) if (!wanted.has(u.id)) {
      q.run('DELETE FROM card_members WHERE card_id = ? AND user_id = ?', card.id, u.id);
      logActivity(card.board_id, card.id, userId, 'card.member_removed', { member: u.name });
    }
    for (const id of wanted) if (!current.some((u) => u.id === id)) {
      const u = q.get('SELECT * FROM users WHERE id = ?', id);
      if (!u) continue;
      q.run('INSERT OR IGNORE INTO card_members (card_id, user_id) VALUES (?, ?)', card.id, id);
      logActivity(card.board_id, card.id, userId, 'card.member_added', { member: u.name });
    }
  }
  if (patch.fields) {
    for (const c of setFieldValues(card, patch.fields, userId)) events.push({ type: 'field_changed', fieldId: c.fieldId });
  }
  q.run('UPDATE cards SET updated_at = ? WHERE id = ?', now(), card.id);
  afterChange(card.board_id, card.id, userId, events);
});

// ---------------- Ordenar os cards de uma coluna ----------------
const SORT_LABELS = { due_date: 'prazo de entrega', created_at: 'data de entrada', updated_at: 'última alteração', title: 'título / nº do pedido' };

/** Valor usado para ordenar (null = vai para o fim) */
function sortValue(card, by, def, values) {
  if (!def) return card[by] || null;
  const v = values.get(card.id);
  if (v === undefined || v === null) return null;
  switch (def.type) {
    case 'number': case 'currency': return Number(v);
    case 'checkbox': return v ? 1 : 0;
    case 'select': { const i = def.options.findIndex((o) => o.id === v); return i < 0 ? null : i; } // ordem das opções do campo
    case 'multiselect': { const i = Math.min(...v.map((id) => def.options.findIndex((o) => o.id === id)).filter((n) => n >= 0)); return Number.isFinite(i) ? i : null; }
    case 'checklist': { const p = checklistProgress(def, v); return p.total ? p.done / p.total : null; }
    default: return displayValue(def, v) || null;
  }
}

const sortColumn = transaction((columnId, { by = 'due_date', dir = 'asc' } = {}, userId = null) => {
  const column = q.get('SELECT * FROM columns WHERE id = ?', columnId);
  if (!column) throw httpError(404, 'Coluna não encontrada.');
  const m = /^field:(\d+)$/.exec(by);
  const def = m ? fieldDefs(column.board_id).find((f) => f.id === Number(m[1])) : null;
  if (!def && !SORT_LABELS[by]) throw httpError(400, 'Escolha por qual informação ordenar.');
  const rows = q.all('SELECT * FROM cards WHERE column_id = ? AND archived = 0 ORDER BY position', column.id);
  const values = new Map(def ? q.all('SELECT card_id, value FROM card_field_values WHERE field_id = ?', def.id).map((v) => [v.card_id, parseJSON(v.value, null)]) : []);
  const sign = dir === 'desc' ? -1 : 1;
  const keyed = rows.map((card, i) => ({ card, i, key: sortValue(card, by, def, values) }));
  keyed.sort((a, b) => {
    if (a.key === null || b.key === null) return (a.key === null) - (b.key === null) || a.i - b.i; // vazios sempre no fim
    const c = typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key
      : String(a.key).localeCompare(String(b.key), 'pt-BR', { numeric: true, sensitivity: 'base' });
    return c * sign || a.i - b.i;
  });
  // Arquivados ficam depois dos ativos, na mesma ordem de antes
  const archived = q.all('SELECT id FROM cards WHERE column_id = ? AND archived = 1 ORDER BY position', column.id);
  [...keyed.map((k) => k.card.id), ...archived.map((a) => a.id)].forEach((id, i) => q.run('UPDATE cards SET position = ? WHERE id = ?', (i + 1) * 1024, id));
  logActivity(column.board_id, null, userId, 'column.sorted', { name: column.name, by: def ? def.name : SORT_LABELS[by], dir });
  setImmediate(() => boardChanged(column.board_id, userId));
  return rows.length;
});

function deleteCard(cardId, userId) {
  const card = q.get('SELECT * FROM cards WHERE id = ?', cardId);
  if (!card) throw httpError(404, 'Card não encontrado.');
  const files = q.all('SELECT filename FROM attachments WHERE card_id = ?', card.id);
  q.run('DELETE FROM cards WHERE id = ?', card.id);
  logActivity(card.board_id, null, userId, 'card.deleted', { title: card.title, cardId: card.id });
  bus.emit('card:deleted', { cardId: card.id, boardId: card.board_id });
  boardChanged(card.board_id, userId, card.id);
  return files.map((f) => f.filename);
}

function afterChange(boardId, cardId, userId, events = []) {
  // Alterações feitas por uma automação não disparam outras automações (evita repetição sem fim)
  const byAutomation = !!bus.automationActive;
  // Executa depois do COMMIT para que os ouvintes leiam o estado final
  setImmediate(() => {
    bus.emit('card:changed', { cardId, boardId, byAutomation });
    for (const evt of events) bus.emit('card:event', { ...evt, cardId, boardId, userId, byAutomation });
    boardChanged(boardId, userId, cardId);
  });
}

/** Regras de automação do quadro (com JSON já convertido) */
function loadRules(boardId) {
  return q.all('SELECT * FROM automations WHERE board_id = ? ORDER BY position, id', boardId).map((r) => ({
    ...r, enabled: !!r.enabled, trigger: parseJSON(r.trigger, { type: 'always' }), conditions: parseJSON(r.conditions, []), actions: parseJSON(r.actions, []),
  }));
}

/** Dados resumidos de vários cards, para exibir no quadro. */
/** Busca em lotes (o SQLite limita a quantidade de "?" por consulta) e agrupa as linhas por card */
function groupedByCard(sql, ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    for (const row of q.all(sql.replace('%IDS%', chunk.map(() => '?').join(',')), ...chunk)) {
      const list = map.get(row.card_id);
      if (list) list.push(row); else map.set(row.card_id, [row]);
    }
  }
  return map;
}

/** Dados resumidos de vários cards, para exibir no quadro (cresce em proporção ao número de cards) */
function serializeCards(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const labels = groupedByCard('SELECT card_id, label_id FROM card_labels WHERE card_id IN (%IDS%)', ids);
  const members = groupedByCard('SELECT card_id, user_id FROM card_members WHERE card_id IN (%IDS%)', ids);
  const values = groupedByCard('SELECT card_id, field_id, value FROM card_field_values WHERE card_id IN (%IDS%)', ids);
  const atts = groupedByCard('SELECT card_id, COUNT(*) AS n FROM attachments WHERE card_id IN (%IDS%) GROUP BY card_id', ids);
  const comments = groupedByCard('SELECT card_id, COUNT(*) AS n FROM comments WHERE card_id IN (%IDS%) GROUP BY card_id', ids);
  const covers = groupedByCard('SELECT a.id, a.filename, a.card_id FROM attachments a JOIN cards c ON c.cover_attachment_id = a.id WHERE c.id IN (%IDS%)', ids);
  // Regras de destaque visual ("sempre"), por quadro
  const visual = {};
  for (const boardId of new Set(rows.map((r) => r.board_id))) {
    const list = loadRules(boardId).filter((r) => r.enabled && r.trigger.type === 'always');
    visual[boardId] = list.length ? { rules: list, ctx: { now: Date.now(), fields: fieldDefs(boardId) } } : null;
  }
  const withHighlights = (card) => {
    const v = visual[card.board_id];
    card.highlights = v ? rules.highlightsFor(card, v.rules, v.ctx) : [];
    return card;
  };
  return rows.map((r) => withHighlights({
    id: r.id,
    board_id: r.board_id,
    column_id: r.column_id,
    title: r.title,
    description: r.description,
    color: r.color,
    position: r.position,
    due_date: r.due_date,
    source: r.source,
    external_url: r.external_url,
    shipping_zip: r.shipping_zip,
    promised_date: r.promised_date,
    correios_days: r.correios_days,
    correios_service: r.correios_service,
    archived: !!r.archived,
    cycle_started_at: r.cycle_started_at,
    cycle_ended_at: r.cycle_ended_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    cover: covers.has(r.id) ? `/uploads/${covers.get(r.id)[0].filename}` : null,
    cover_attachment_id: r.cover_attachment_id,
    labels: (labels.get(r.id) || []).map((l) => l.label_id),
    members: (members.get(r.id) || []).map((m) => m.user_id),
    fields: Object.fromEntries((values.get(r.id) || []).map((v) => [v.field_id, parseJSON(v.value, null)])),
    attachment_count: atts.get(r.id)?.[0].n || 0,
    comment_count: comments.get(r.id)?.[0].n || 0,
  }));
}

function cardDetail(cardId) {
  const row = q.get('SELECT * FROM cards WHERE id = ?', cardId);
  if (!row) throw httpError(404, 'Card não encontrado.');
  const [card] = serializeCards([row]);
  // Link do admin da Shopify (o link principal do card é a página aberta do pedido)
  card.admin_url = row.external_id?.startsWith('shopify:') ? require('./shopify').adminOrderUrl(row) : null;
  card.attachments = q.all(`SELECT a.*, u.name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
                            WHERE a.card_id = ? ORDER BY a.id DESC`, cardId)
    .map((a) => ({ ...a, url: `/uploads/${a.filename}`, is_image: a.mime.startsWith('image/') }));
  const movements = q.all(`SELECT m.*, u.name AS user_name, fc.name AS from_name, tc.name AS to_name
                           FROM card_movements m LEFT JOIN users u ON u.id = m.user_id
                           LEFT JOIN columns fc ON fc.id = m.from_column_id LEFT JOIN columns tc ON tc.id = m.to_column_id
                           WHERE m.card_id = ? ORDER BY m.moved_at, m.id`, cardId);
  const durations = columnDurations(movements);
  card.movements = movements;
  card.column_time = Object.entries(durations).map(([columnId, ms]) => ({ column_id: Number(columnId), name: columnName(Number(columnId)), ms }));
  card.activity = q.all(`SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
                         WHERE a.card_id = ? ORDER BY a.id DESC LIMIT 300`, cardId)
    .map((a) => ({ ...a, details: parseJSON(a.details, {}) }));
  return card;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  FIELD_TYPES, fieldDefs, normalizeValue, displayValue, logActivity, createCard, moveCard, updateCard, deleteCard,
  serializeCards, groupedByCard, cardDetail, httpError, boardColumns, applyCycle, parseJSON, loadRules, sortColumn, checklistProgress, SORT_LABELS,
};
