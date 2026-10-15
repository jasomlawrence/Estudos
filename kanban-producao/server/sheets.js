'use strict';
// Integração com Google Planilhas via conta de serviço (sem bibliotecas externas)
const crypto = require('node:crypto');
const { q, getSetting, setSetting, now } = require('./db');
const { bus } = require('./events');
const { fieldDefs, displayValue, parseJSON } = require('./cards');
const { cycleMs } = require('./cycle');

const BUILTIN_COLUMNS = [
  { key: 'id', label: 'ID do card' },
  { key: 'title', label: 'Título' },
  { key: 'column', label: 'Coluna atual' },
  { key: 'labels', label: 'Etiquetas' },
  { key: 'members', label: 'Responsáveis' },
  { key: 'due_date', label: 'Prazo de entrega' },
  { key: 'created_at', label: 'Criado em' },
  { key: 'updated_at', label: 'Atualizado em' },
  { key: 'cycle_started_at', label: 'Início da produção' },
  { key: 'cycle_ended_at', label: 'Fim da produção' },
  { key: 'cycle_days', label: 'Tempo de produção (dias)' },
  { key: 'description', label: 'Descrição' },
  { key: 'source', label: 'Origem' },
  { key: 'shopify_url', label: 'Link do pedido no Shopify' },
  { key: 'archived', label: 'Arquivado' },
];

const TZ = process.env.TZ || 'America/Sao_Paulo';
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: TZ }) : '');

function getConfig(boardId) {
  return { enabled: false, spreadsheet_id: '', sheet_name: 'Produção', credentials: null, columns: ['id', 'title', 'column', 'due_date'], auto_sync: true, ...getSetting(`sheets:${boardId}`, {}) };
}

function parseSpreadsheetId(input) {
  const m = String(input || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : String(input || '').trim();
}

// ---------- Autenticação (JWT da conta de serviço) ----------
const tokenCache = new Map();
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

async function accessToken(creds) {
  if (!creds?.client_email || !creds?.private_key) throw new Error('Credenciais da conta de serviço inválidas (envie o arquivo JSON completo).');
  const cached = tokenCache.get(creds.client_email);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: creds.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: creds.token_uri || 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  }));
  const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), creds.private_key));
  const res = await fetch(creds.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google recusou as credenciais: ${body.error_description || body.error}`);
  tokenCache.set(creds.client_email, { token: body.access_token, exp: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

async function api(config, method, path, body) {
  const token = await accessToken(config.credentials);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheet_id}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Sheets: ${data.error?.message || res.status}`);
  return data;
}

const range = (config, a1) => encodeURIComponent(`'${config.sheet_name.replace(/'/g, "''")}'${a1 ? `!${a1}` : ''}`);

async function ensureSheet(config) {
  const meta = await api(config, 'GET', '?fields=sheets.properties');
  let sheet = meta.sheets.find((s) => s.properties.title === config.sheet_name);
  if (!sheet) {
    const r = await api(config, 'POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: config.sheet_name } } }] });
    sheet = { properties: r.replies[0].addSheet.properties };
  }
  return sheet.properties.sheetId;
}

// ---------- Montagem das linhas ----------
function columnKeys(config) {
  return ['id', ...config.columns.filter((k) => k !== 'id')]; // o ID fica sempre na coluna A (usado para localizar a linha)
}

function headerRow(config, defs) {
  return columnKeys(config).map((key) => {
    if (key.startsWith('field:')) return defs.find((d) => d.id === Number(key.slice(6)))?.name ?? '(campo removido)';
    return BUILTIN_COLUMNS.find((c) => c.key === key)?.label ?? key;
  });
}

function rowsForCards(boardId, config, cardIds) {
  const defs = fieldDefs(boardId);
  const where = cardIds ? `AND c.id IN (${cardIds.map(() => '?').join(',')})` : '';
  const cards = q.all(`SELECT c.*, col.name AS column_name FROM cards c JOIN columns col ON col.id = c.column_id
                       WHERE c.board_id = ? ${where} ORDER BY col.position, c.position`, boardId, ...(cardIds || []));
  return cards.map((card) => {
    const values = Object.fromEntries(q.all('SELECT field_id, value FROM card_field_values WHERE card_id = ?', card.id).map((v) => [v.field_id, parseJSON(v.value, null)]));
    return columnKeys(config).map((key) => {
      if (key.startsWith('field:')) {
        const def = defs.find((d) => d.id === Number(key.slice(6)));
        const v = def ? values[def.id] : null;
        if (v == null) return '';
        return def.type === 'number' || def.type === 'currency' ? Number(v) : displayValue(def, v);
      }
      switch (key) {
        case 'id': return card.id;
        case 'title': return card.title;
        case 'column': return card.column_name;
        case 'labels': return q.all('SELECT l.name, l.color FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = ?', card.id).map((l) => l.name || l.color).join(', ');
        case 'members': return q.all('SELECT u.name FROM card_members cm JOIN users u ON u.id = cm.user_id WHERE cm.card_id = ?', card.id).map((u) => u.name).join(', ');
        case 'due_date': return fmtDateTime(card.due_date);
        case 'created_at': return fmtDateTime(card.created_at);
        case 'updated_at': return fmtDateTime(card.updated_at);
        case 'cycle_started_at': return fmtDateTime(card.cycle_started_at);
        case 'cycle_ended_at': return fmtDateTime(card.cycle_ended_at);
        case 'cycle_days': { const ms = cycleMs(card); return ms == null ? '' : Math.round(ms / 864e4) / 10; }
        case 'description': return card.description;
        case 'source': return card.source === 'shopify' ? 'Shopify' : 'Manual';
        case 'shopify_url': return card.external_url || '';
        case 'archived': return card.archived ? 'Sim' : 'Não';
        default: return '';
      }
    });
  });
}

// ---------- Operações ----------
async function findRow(config, cardId) {
  const data = await api(config, 'GET', `/values/${range(config, 'A:A')}`);
  const idx = (data.values || []).findIndex((r) => String(r[0]) === String(cardId));
  return { row: idx >= 0 ? idx + 1 : null, hasHeader: !!data.values?.length };
}

async function upsertCard(boardId, cardId) {
  const config = getConfig(boardId);
  const [row] = rowsForCards(boardId, config, [cardId]);
  if (!row) return;
  const found = await findRow(config, cardId);
  if (!found.hasHeader) {
    await api(config, 'PUT', `/values/${range(config, 'A1')}?valueInputOption=RAW`, { values: [headerRow(config, fieldDefs(boardId))] });
  }
  if (found.row) await api(config, 'PUT', `/values/${range(config, `A${found.row}`)}?valueInputOption=RAW`, { values: [row] });
  else await api(config, 'POST', `/values/${range(config, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [row] });
}

async function removeCard(boardId, cardId) {
  const config = getConfig(boardId);
  const found = await findRow(config, cardId);
  if (!found.row) return;
  const sheetId = await ensureSheet(config);
  await api(config, 'POST', ':batchUpdate', { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: found.row - 1, endIndex: found.row } } }] });
}

/** Reescreve a aba inteira: cabeçalho + todos os cards do quadro. */
async function fullSync(boardId) {
  const config = getConfig(boardId);
  if (!config.spreadsheet_id || !config.credentials) throw new Error('Configure a planilha e as credenciais primeiro.');
  await ensureSheet(config);
  await api(config, 'POST', `/values/${range(config)}:clear`, {});
  const values = [headerRow(config, fieldDefs(boardId)), ...rowsForCards(boardId, config)];
  await api(config, 'PUT', `/values/${range(config, 'A1')}?valueInputOption=RAW`, { values });
  setStatus(boardId, { ok: true, message: `${values.length - 1} cards enviados` });
  return values.length - 1;
}

function setStatus(boardId, status) {
  setSetting(`sheets_status:${boardId}`, { ...status, at: now() });
}

// ---------- Fila de sincronização automática ----------
// Agrupa alterações seguidas do mesmo card e executa uma de cada vez por quadro (evita linhas duplicadas)
const timers = new Map();
const chains = new Map();

function enqueue(boardId, job) {
  const prev = chains.get(boardId) || Promise.resolve();
  const next = prev.then(job).then(
    () => setStatus(boardId, { ok: true, message: 'Sincronizado' }),
    (err) => { setStatus(boardId, { ok: false, message: err.message }); console.error('[sheets]', err.message); },
  );
  chains.set(boardId, next);
  return next;
}

function isActive(boardId) {
  const c = getConfig(boardId);
  return c.enabled && c.auto_sync && c.spreadsheet_id && c.credentials;
}

bus.on('card:changed', ({ cardId, boardId }) => {
  if (!isActive(boardId)) return;
  clearTimeout(timers.get(cardId));
  timers.set(cardId, setTimeout(() => { timers.delete(cardId); enqueue(boardId, () => upsertCard(boardId, cardId)); }, 2000));
});

bus.on('card:deleted', ({ cardId, boardId }) => {
  if (!isActive(boardId)) return;
  clearTimeout(timers.get(cardId));
  enqueue(boardId, () => removeCard(boardId, cardId));
});

module.exports = { BUILTIN_COLUMNS, getConfig, parseSpreadsheetId, fullSync, enqueue, upsertCard, headerRow, rowsForCards };
