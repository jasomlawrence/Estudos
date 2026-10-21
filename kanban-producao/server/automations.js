'use strict';
// Automações: regras "quando… se… então…" configuradas por quadro
// - "sempre": destaque visual (cor da borda + aviso no card), calculado em serializeCards
// - eventos (card criado, movido, etiqueta adicionada, campo alterado): executam ações
// - "passou a atender às condições": verificado a cada alteração e periodicamente (ex.: prazo a 2 dias)
const { q, now } = require('./db');
const { bus } = require('./events');
const cards = require('./cards');
const notifications = require('./notifications');
const rules = require('./rules');

const TRIGGERS = ['always', 'match', 'created', 'moved', 'label_added', 'field_changed'];
const VISUAL = ['highlight', 'paint']; // ações das regras "sempre" (calculadas na hora, não gravam nada)
const ACTIONS = ['highlight', 'paint', 'notify', 'webhook', 'add_label', 'remove_label', 'add_member', 'set_color', 'move', 'sort'];
const CONDITIONS = ['due_within', 'overdue', 'no_due', 'done', 'not_done', 'has_label', 'not_label', 'in_column', 'not_in_column', 'no_members', 'source', 'field'];

const ids = (list) => (Array.isArray(list) ? list.map(Number).filter(Number.isInteger) : []);
const color = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : null);

/** Valida e limpa uma regra vinda da tela de configurações */
function sanitize(input) {
  const trigger = { type: TRIGGERS.includes(input.trigger?.type) ? input.trigger.type : 'always' };
  if (trigger.type === 'moved') { trigger.columns = ids(input.trigger.columns); trigger.from = ids(input.trigger.from); }
  if (trigger.type === 'label_added') trigger.labels = ids(input.trigger.labels);
  if (trigger.type === 'field_changed') trigger.field = Number(input.trigger.field) || null;

  const conditions = (Array.isArray(input.conditions) ? input.conditions : []).filter((c) => CONDITIONS.includes(c?.type)).map((c) => {
    const out = { type: c.type };
    if (c.type === 'due_within') out.days = Math.max(0, Number(c.days) || 0);
    if (['has_label', 'not_label'].includes(c.type)) out.label = Number(c.label);
    if (['in_column', 'not_in_column'].includes(c.type)) out.columns = ids(c.columns);
    if (c.type === 'source') out.source = c.source === 'shopify' ? 'shopify' : 'manual';
    if (c.type === 'field') Object.assign(out, { field: Number(c.field), op: String(c.op || 'filled'), value: c.value ?? '' });
    return out;
  });

  const visual = trigger.type === 'always';
  const actions = (Array.isArray(input.actions) ? input.actions : [])
    .filter((a) => ACTIONS.includes(a?.type) && (visual ? VISUAL.includes(a.type) : !VISUAL.includes(a.type)))
    .map((a) => {
      switch (a.type) {
        case 'highlight': return { type: 'highlight', color: color(a.color) || '#ff6b6b', text: String(a.text || '').slice(0, 40) };
        case 'paint': return color(a.color) ? { type: 'paint', color: color(a.color) } : null;
        case 'notify': return {
          type: 'notify', to: ['members', 'all', 'users', 'admins'].includes(a.to) ? a.to : 'members', users: ids(a.users),
          message: String(a.message || '').slice(0, 1000), email: !!a.email,
        };
        case 'webhook': return { type: 'webhook', url: /^https?:\/\//.test(a.url || '') ? String(a.url) : '', message: String(a.message || '').slice(0, 1000) };
        case 'add_label': case 'remove_label': return { type: a.type, label: Number(a.label) };
        case 'add_member': return { type: a.type, user: Number(a.user) };
        case 'set_color': return { type: a.type, color: color(a.color) }; // null = tira a cor
        case 'move': return { type: a.type, column: Number(a.column) };
        case 'sort': return { type: a.type, by: /^(due_date|created_at|updated_at|title|field:\d+)$/.test(a.by || '') ? a.by : 'due_date', dir: a.dir === 'desc' ? 'desc' : 'asc' };
        default: return null;
      }
    }).filter(Boolean);

  return {
    name: String(input.name || '').trim().slice(0, 120) || 'Automação',
    enabled: input.enabled !== false,
    trigger, conditions, actions,
  };
}

function serializedCard(cardId) {
  const row = q.get('SELECT * FROM cards WHERE id = ?', cardId);
  return row ? cards.serializeCards([row])[0] : null;
}

/** Variáveis que podem ir na mensagem: {titulo}, {coluna}, {prazo}, {usuario}, {regra}, {link}, {campo:Nome} */
function messageVars(card, rule, evt) {
  const fields = cards.fieldDefs(card.board_id);
  return {
    titulo: card.title,
    coluna: q.get('SELECT name FROM columns WHERE id = ?', card.column_id)?.name || '',
    prazo: card.due_date ? notifications.fmtDate(card.due_date) : 'sem prazo',
    usuario: evt?.userId ? q.get('SELECT name FROM users WHERE id = ?', evt.userId)?.name || '' : 'sistema',
    regra: rule.name,
    link: notifications.cardLink(card),
    fieldsByName: Object.fromEntries(fields.map((f) => [rules.fold(f.name), cards.displayValue(f, card.fields[f.id] ?? null)])),
  };
}

function defaultMessage(rule, evt) {
  if (evt?.type === 'moved') return '🔔 "{titulo}" foi movido para {coluna} por {usuario}';
  if (evt?.type === 'created') return '🆕 Novo card "{titulo}" em {coluna}';
  return `🔔 ${rule.name}: "{titulo}" ({coluna}, prazo {prazo})`;
}

function recipients(card, action) {
  const active = (sql, ...p) => q.all(sql, ...p).filter((u) => u.active);
  if (action.to === 'all') return active("SELECT * FROM users WHERE role != 'viewer'");
  if (action.to === 'admins') return active("SELECT * FROM users WHERE role = 'admin'");
  if (action.to === 'users') {
    const list = action.users.map((id) => q.get('SELECT * FROM users WHERE id = ?', id)).filter((u) => u?.active);
    return list.length ? list : notifications.cardRecipients(card);
  }
  return notifications.cardRecipients(card);
}

/** Alterações no card feitas pela automação não disparam outras automações */
function asAutomation(fn) {
  bus.automationActive = true;
  try { return fn(); } finally { bus.automationActive = false; }
}

async function runRule(rule, cardId, evt = null) {
  let card = serializedCard(cardId);
  if (!card || card.archived) return null;
  const done = [];
  for (const action of rule.actions) {
    try {
      switch (action.type) {
        case 'notify': {
          const vars = messageVars(card, rule, evt);
          const text = rules.renderMessage(action.message || defaultMessage(rule, evt), vars) + (vars.link ? `\n${vars.link}` : '');
          const to = recipients(card, action);
          const r = await notifications.deliver({ card, recipients: to, text, subject: `${rule.name}: ${card.title}`, email: action.email, title: rule.name });
          done.push(`avisou ${to.map((u) => u.name).join(', ') || 'ninguém'} (${r.join(', ')})`);
          break;
        }
        case 'webhook': {
          if (!action.url) break;
          const vars = messageVars(card, rule, evt);
          const text = rules.renderMessage(action.message || defaultMessage(rule, evt), vars);
          const r = await notifications.deliver({
            card, recipients: [], inApp: false, text, webhookUrl: action.url,
            payload: { event: 'automation', rule: rule.name, trigger: evt?.type || rule.trigger.type, card: { id: card.id, title: card.title, column: vars.coluna, due_date: card.due_date, url: vars.link } },
          });
          done.push(r.join(', '));
          break;
        }
        case 'add_label':
          if (!card.labels.includes(action.label)) asAutomation(() => cards.updateCard(card.id, { labels: [...card.labels, action.label] }, null));
          done.push('adicionou etiqueta');
          break;
        case 'remove_label':
          if (card.labels.includes(action.label)) asAutomation(() => cards.updateCard(card.id, { labels: card.labels.filter((l) => l !== action.label) }, null));
          done.push('removeu etiqueta');
          break;
        case 'add_member':
          if (!card.members.includes(action.user)) asAutomation(() => cards.updateCard(card.id, { members: [...card.members, action.user] }, null));
          done.push('adicionou responsável');
          break;
        case 'set_color':
          asAutomation(() => cards.updateCard(card.id, { color: action.color }, null));
          done.push('mudou a cor');
          break;
        case 'move':
          if (card.column_id !== action.column) asAutomation(() => cards.moveCard(card.id, { columnId: action.column }, null));
          done.push('moveu o card');
          break;
        case 'sort':
          cards.sortColumn(card.column_id, { by: action.by, dir: action.dir }, null);
          done.push('ordenou a coluna');
          break;
        default: break;
      }
    } catch (err) {
      done.push(`falhou: ${err.message}`);
    }
    card = serializedCard(cardId) || card;
  }
  q.run('UPDATE automations SET run_count = run_count + 1, last_run_at = ? WHERE id = ?', now(), rule.id);
  cards.logActivity(card.board_id, card.id, null, 'automation.ran', { rule: rule.name, actions: done.join('; ') });
  return done;
}

const matchKey = (rule, cardId) => `auto:${rule.id}:${cardId}`;

/** Regras "passou a atender": executa uma vez quando o card entra na condição; libera de novo quando ele sai */
async function checkMatchRules(boardId, cardIds = null) {
  const list = cards.loadRules(boardId).filter((r) => r.enabled && r.trigger.type === 'match' && r.conditions.length);
  if (!list.length) return;
  const ids = cardIds || q.all('SELECT id FROM cards WHERE board_id = ? AND archived = 0', boardId).map((r) => r.id);
  const ctx = { now: Date.now(), fields: cards.fieldDefs(boardId) };
  // Em lotes de 300 cards: com milhares de cards a memória do servidor não dispara
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const rows = q.all(`SELECT * FROM cards WHERE archived = 0 AND id IN (${chunk.map(() => '?').join(',')})`, ...chunk);
    await checkRows(rows, list, ctx);
  }
}

async function checkRows(rows, list, ctx) {
  for (const card of cards.serializeCards(rows)) {
    for (const rule of list) {
      const key = matchKey(rule, card.id);
      const matches = rules.cardMatches(card, rule.conditions, ctx);
      const fired = !!q.get('SELECT 1 FROM notification_log WHERE dedupe_key = ?', key);
      if (matches && !fired) {
        q.run('INSERT OR IGNORE INTO notification_log (dedupe_key) VALUES (?)', key);
        await runRule(rule, card.id, { type: 'match' });
      } else if (!matches && fired) {
        q.run('DELETE FROM notification_log WHERE dedupe_key = ?', key);
      }
    }
  }
}

async function handleEvent(evt) {
  if (evt.byAutomation) return;
  const card = serializedCard(evt.cardId);
  if (!card) return;
  const ctx = { now: Date.now(), fields: cards.fieldDefs(evt.boardId) };
  for (const rule of cards.loadRules(evt.boardId)) {
    if (!rule.enabled || !rules.triggerMatches(rule.trigger, evt)) continue;
    if (!rules.cardMatches(serializedCard(evt.cardId) || card, rule.conditions, ctx)) continue;
    await runRule(rule, evt.cardId, evt);
  }
}

// Fila: um evento por vez, na ordem em que aconteceram
let queue = Promise.resolve();
const enqueue = (fn) => { queue = queue.then(fn).catch((err) => console.error('[automações]', err.message)); return queue; };

bus.on('card:event', (evt) => enqueue(() => handleEvent(evt)));
bus.on('card:changed', ({ boardId, cardId }) => enqueue(() => checkMatchRules(boardId, [cardId])));

async function sweep() {
  for (const b of q.all('SELECT DISTINCT board_id FROM automations WHERE enabled = 1')) await checkMatchRules(b.board_id);
}

function start() {
  const minutes = Number(process.env.NOTIFY_INTERVAL_MINUTES || 10);
  setTimeout(() => enqueue(sweep), 8000);
  setInterval(() => enqueue(sweep), minutes * 60000).unref();
}

const idle = () => queue;

module.exports = { sanitize, runRule, handleEvent, checkMatchRules, sweep, start, idle, TRIGGERS, ACTIONS, CONDITIONS };
