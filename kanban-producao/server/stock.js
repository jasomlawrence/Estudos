'use strict';
// Estoque de pedras: diamantes de laboratório e moissanites (uma pedra por código) e pedras pequenas (por quantidade).
// A baixa acontece pelos campos do card ("Pedra do estoque" e "Pedras pequenas") ou manualmente na tela de Estoque.
const { q, now } = require('./db');

const KINDS = { lab: 'Diamante lab', moissanite: 'Moissanite' };
const SHAPES = ['Redonda', 'Oval', 'Gota', 'Navete', 'Baguete', 'Princesa', 'Esmeralda', 'Almofada', 'Coração', 'Radiante', 'Asscher', 'Trilliant', 'Outro'];
// Nomes em inglês dos certificados → nomes usados aqui
const SHAPE_WORDS = [
  [/round|brilliant cut round/i, 'Redonda'], [/oval/i, 'Oval'], [/pear/i, 'Gota'], [/marquise|navette/i, 'Navete'], [/baguette|tapered/i, 'Baguete'],
  [/princess/i, 'Princesa'], [/emerald/i, 'Esmeralda'], [/cushion/i, 'Almofada'], [/heart/i, 'Coração'], [/radiant/i, 'Radiante'], [/asscher/i, 'Asscher'],
  [/trill?i(on|ant)|triangle/i, 'Trilliant'],
];
const STOCK_TYPES = ['stone', 'melee'];

const normCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');
const clean = (s, max = 120) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** "Oval Brilliant" → "Oval"; nomes que já estão em português passam direto */
function shapeName(text) {
  const t = clean(text, 60);
  if (!t) return '';
  const pt = SHAPES.find((s) => s.toLowerCase() === t.toLowerCase());
  if (pt) return pt;
  return SHAPE_WORDS.find(([re]) => re.test(t))?.[1] || t.charAt(0).toUpperCase() + t.slice(1);
}

/** "9.75 X 6.33 X 3.71 MM" → "9,75 × 6,33 × 3,71"; "3.45 - 3.48 X 2.07" → "3,45 – 3,48 × 2,07"; "7*7mm" → "7 × 7" */
function formatMeasurements(text) {
  let t = clean(text, 80).replace(/\s*mm\s*$/i, '');
  if (!t) return '';
  t = t.replace(/(\d)\.(\d)/g, '$1,$2').replace(/\s*[x×*]\s*/gi, ' × ').replace(/\s*[-–]\s*/g, ' – ');
  return t;
}

/** Tamanho das pedras pequenas: "1.5" → "1,5 mm"; "5x3" → "5 × 3 mm" */
function formatSize(text) {
  const t = formatMeasurements(text);
  return t ? `${t} mm` : '';
}
const sizeNorm = (size) => String(size).toLowerCase().replace(/mm/g, '').replace(/,/g, '.').replace(/[^0-9.]+/g, 'x').replace(/^x|x$/g, '');

function parseCarat(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d,.]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : null;
}
const fmtCarat = (n) => (n ? `${String(n).replace('.', ',')} ct` : '');

// ---------------- Pedras com código ----------------
const STONE_FIELDS = ['kind', 'code', 'shape', 'measurements', 'carat', 'color', 'clarity', 'cut_grade', 'polish', 'symmetry', 'fluorescence', 'lab', 'method', 'report_date', 'notes', 'photo'];

function sanitizeStone(input, current = {}) {
  const v = { ...current };
  for (const k of STONE_FIELDS) if (k in input) v[k] = input[k];
  const out = {
    kind: KINDS[v.kind] ? v.kind : 'lab',
    code: clean(v.code, 60),
    shape: shapeName(v.shape),
    measurements: formatMeasurements(v.measurements),
    carat: parseCarat(v.carat),
    color: clean(v.color, 20).toUpperCase(),
    clarity: clean(v.clarity, 20).toUpperCase().replace(/\s+/g, ''),
    cut_grade: clean(v.cut_grade, 30),
    polish: clean(v.polish, 30),
    symmetry: clean(v.symmetry, 30),
    fluorescence: clean(v.fluorescence, 30),
    lab: clean(v.lab, 30).toUpperCase(),
    method: clean(v.method, 20).toUpperCase(),
    report_date: /^\d{4}-\d{2}-\d{2}$/.test(String(v.report_date || '')) ? v.report_date : '',
    notes: String(v.notes ?? '').trim().slice(0, 2000),
    photo: v.photo && /^stone-[\w.-]+$/.test(v.photo) ? v.photo : null,
  };
  if (out.kind === 'moissanite') Object.assign(out, { clarity: '', cut_grade: '', polish: '', symmetry: '', fluorescence: '', method: '' });
  if (!normCode(out.code)) throw httpError(400, 'Informe o código da pedra.');
  return out;
}

function stoneRow(id) {
  return q.get(`SELECT s.*, u.name AS used_by_name FROM stones s LEFT JOIN users u ON u.id = s.used_by WHERE s.id = ?`, id);
}

function logStone(stoneId, action, { cardId = null, orderRef = '', userId = null, detail = '' } = {}) {
  q.run('INSERT INTO stone_log (stone_id, action, card_id, order_ref, user_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    stoneId, action, cardId, orderRef, userId, detail, now());
}

function codeTaken(code, exceptId = 0) {
  return q.get('SELECT id, code FROM stones WHERE code_norm = ? AND id != ?', normCode(code), exceptId);
}

function createStone(input, userId) {
  const s = sanitizeStone(input);
  const dup = codeTaken(s.code);
  if (dup) throw httpError(409, `A pedra ${dup.code} já está cadastrada.`);
  const at = now();
  const info = q.run(`INSERT INTO stones (kind, code, code_norm, code_digits, shape, measurements, carat, color, clarity, cut_grade, polish, symmetry, fluorescence,
                                         lab, method, report_date, notes, photo, created_by, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  s.kind, s.code, normCode(s.code), digitsOf(s.code), s.shape, s.measurements, s.carat, s.color, s.clarity, s.cut_grade, s.polish, s.symmetry, s.fluorescence,
  s.lab, s.method, s.report_date, s.notes, s.photo, userId ?? null, at, at);
  const id = Number(info.lastInsertRowid);
  logStone(id, 'created', { userId });
  return stoneRow(id);
}

function updateStone(id, input, userId) {
  const cur = stoneRow(id);
  if (!cur) throw httpError(404, 'Pedra não encontrada.');
  const s = sanitizeStone(input, cur);
  const dup = codeTaken(s.code, id);
  if (dup) throw httpError(409, `Já existe outra pedra com o código ${dup.code}.`);
  q.run(`UPDATE stones SET kind = ?, code = ?, code_norm = ?, code_digits = ?, shape = ?, measurements = ?, carat = ?, color = ?, clarity = ?, cut_grade = ?,
         polish = ?, symmetry = ?, fluorescence = ?, lab = ?, method = ?, report_date = ?, notes = ?, photo = ?, updated_at = ? WHERE id = ?`,
  s.kind, s.code, normCode(s.code), digitsOf(s.code), s.shape, s.measurements, s.carat, s.color, s.clarity, s.cut_grade,
  s.polish, s.symmetry, s.fluorescence, s.lab, s.method, s.report_date, s.notes, s.photo, now(), id);
  const changed = STONE_FIELDS.filter((k) => k !== 'photo' && String(cur[k] ?? '') !== String(s[k] ?? ''));
  if (changed.length) logStone(id, 'edited', { userId, detail: changed.join(', ') });
  return { stone: stoneRow(id), oldPhoto: cur.photo !== s.photo ? cur.photo : null };
}

/** Texto curto da pedra: "LG797609310 · Oval 1,51 ct F VVS2" */
function stoneLabel(s) {
  if (!s) return '(pedra removida do estoque)';
  const parts = [s.shape, fmtCarat(s.carat), s.color, s.clarity].filter(Boolean).join(' ');
  return `${s.code}${parts ? ` · ${parts}` : ''}${s.kind === 'moissanite' ? ' · Moissanite' : ''}`;
}

/** Pedido a partir do card: "#200094690 · Bianca Alves · Solitário" */
const orderRefOf = (card) => clean(card?.title, 160);

/** Encontra pedras pelo código digitado ou bipado (o código de barras do IGI vem sem o "LG") */
function findByCode(text) {
  const n = normCode(text);
  if (!n) return [];
  const rows = q.all('SELECT * FROM stones WHERE code_norm = ?', n);
  if (rows.length) return rows;
  return /^\d{5,}$/.test(n) ? q.all('SELECT * FROM stones WHERE code_digits = ?', n) : [];
}

/** Filtros da lista de pedras (tela de Estoque e campo do card) */
function stoneFilter({ text = '', kind = '', status = '', shape = '', color = '', clarity = '', caratMin = '', caratMax = '' } = {}) {
  const where = [];
  const params = [];
  if (KINDS[kind]) { where.push('s.kind = ?'); params.push(kind); }
  if (['available', 'used'].includes(status)) { where.push('s.status = ?'); params.push(status); }
  if (shape) { where.push('s.shape = ?'); params.push(shape); }
  if (color) { where.push('upper(s.color) = ?'); params.push(String(color).trim().toUpperCase()); }
  if (clarity) { where.push('upper(s.clarity) = ?'); params.push(String(clarity).replace(/\s+/g, '').toUpperCase()); }
  const min = parseCarat(caratMin);
  const max = parseCarat(caratMax);
  if (min) { where.push('s.carat >= ?'); params.push(min); }
  if (max) { where.push('s.carat <= ?'); params.push(max); }
  const n = normCode(text);
  if (n) {
    const like = `%${n}%`;
    const d = digitsOf(text);
    const words = `%${String(text).trim().toUpperCase()}%`;
    where.push(`(s.code_norm LIKE ? ${d.length >= 3 ? 'OR s.code_digits LIKE ?' : ''} OR upper(s.used_order) LIKE ? OR upper(s.notes) LIKE ?)`);
    params.push(like, ...(d.length >= 3 ? [`%${d}%`] : []), words, words);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const STONE_SORTS = {
  code: 's.code_norm', shape: 's.shape', carat: 's.carat', color: 's.color', clarity: 's.clarity',
  status: 's.status', used_at: 's.used_at', created_at: 's.created_at', measurements: 's.measurements',
};

function searchStones({ sort = '', dir = 'asc', limit = 300, offset = 0, ...filters } = {}) {
  const f = stoneFilter(filters);
  const col = STONE_SORTS[sort];
  const order = col ? `${col} IS NULL OR ${col} = '', ${col} ${dir === 'desc' ? 'DESC' : 'ASC'}, s.id DESC` : 's.status, s.shape, s.carat DESC, s.id DESC';
  return q.all(`SELECT s.*, u.name AS used_by_name FROM stones s LEFT JOIN users u ON u.id = s.used_by ${f.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...f.params, Math.min(Number(limit) || 300, 2000), Math.max(Number(offset) || 0, 0));
}

function countStones(filters = {}) {
  const f = stoneFilter(filters);
  return q.get(`SELECT COUNT(*) AS n, ROUND(SUM(s.carat), 3) AS ct FROM stones s ${f.sql}`, ...f.params);
}

/** Quantas pedras (e quantos quilates) por tipo, situação e corte (para as abas e os contadores) */
function stoneCounts() {
  return q.all('SELECT kind, status, shape, COUNT(*) AS n, ROUND(SUM(carat), 3) AS ct FROM stones GROUP BY kind, status, shape');
}

/** Resumo do topo da tela de Estoque */
function stockSummary() {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const melee = q.get('SELECT COUNT(*) AS items, COALESCE(SUM(qty), 0) AS units, SUM(min_qty > 0 AND qty <= min_qty) AS low, SUM(qty = 0) AS empty FROM melee_items');
  return {
    used_30d: q.get("SELECT COUNT(*) AS n FROM stone_log WHERE action = 'used' AND created_at >= ?", since).n
      - q.get("SELECT COUNT(*) AS n FROM stone_log WHERE action = 'returned' AND created_at >= ?", since).n,
    melee_out_30d: -(q.get('SELECT COALESCE(SUM(delta), 0) AS n FROM melee_moves WHERE delta < 0 AND created_at >= ?', since).n)
      - q.get('SELECT COALESCE(SUM(delta), 0) AS n FROM melee_moves WHERE delta > 0 AND card_id IS NOT NULL AND created_at >= ?', since).n,
    melee: { items: melee.items, units: melee.units, low: melee.low || 0, empty: melee.empty || 0 },
  };
}

/** Tudo o que entrou e saiu do estoque (pedras com código e pedras pequenas), do mais recente */
function movements({ kind = '', type = '', text = '', from = '', to = '', limit = 300 } = {}) {
  const rows = q.all(`
    SELECT * FROM (
      SELECT 'stone' AS type, l.id, l.created_at, l.action, l.order_ref, l.card_id, l.detail, u.name AS user_name,
             s.kind, s.code AS item, s.id AS ref_id, NULL AS delta, NULL AS qty_after,
             trim(s.shape || ' ' || COALESCE(replace(CAST(s.carat AS TEXT), '.', ',') || ' ct', '')) AS info
      FROM stone_log l JOIN stones s ON s.id = l.stone_id LEFT JOIN users u ON u.id = l.user_id
      UNION ALL
      SELECT 'melee', m.id, m.created_at, CASE WHEN m.delta > 0 THEN (CASE WHEN m.card_id IS NOT NULL THEN 'returned' ELSE 'in' END) ELSE (CASE WHEN m.card_id IS NOT NULL THEN 'used' ELSE 'out' END) END,
             m.order_ref, m.card_id, m.note, u.name, i.kind, i.shape || ' ' || i.size, i.id, m.delta, m.qty_after, ''
      FROM melee_moves m JOIN melee_items i ON i.id = m.item_id LEFT JOIN users u ON u.id = m.user_id
    ) WHERE (? = '' OR kind = ?) AND (? = '' OR type = ?) AND (? = '' OR created_at >= ?) AND (? = '' OR created_at < ?)
      AND (? = '' OR upper(item || ' ' || order_ref || ' ' || detail) LIKE ?)
    ORDER BY created_at DESC, id DESC LIMIT ?`,
  kind, kind, type, type, from, from, to, to, String(text).trim(), `%${String(text).trim().toUpperCase()}%`, Math.min(Number(limit) || 300, 5000));
  return rows;
}

/** Liga a pedra ao card (baixa). Lança erro se ela já estiver em outro pedido. */
function useStone(stoneId, { card = null, fieldId = null, orderRef = '', userId = null } = {}) {
  const s = stoneRow(stoneId);
  if (!s) throw httpError(404, 'Pedra não encontrada no estoque.');
  if (s.status === 'used') {
    if (card && s.card_id === card.id && s.field_id === fieldId) return s;
    throw httpError(409, `A pedra ${s.code} já foi usada${s.used_order ? ` no pedido ${s.used_order}` : ''}.`);
  }
  const ref = card ? orderRefOf(card) : clean(orderRef, 160);
  q.run("UPDATE stones SET status = 'used', card_id = ?, field_id = ?, used_order = ?, used_at = ?, used_by = ?, updated_at = ? WHERE id = ?",
    card?.id ?? null, fieldId, ref, now(), userId ?? null, now(), s.id);
  logStone(s.id, 'used', { cardId: card?.id ?? null, orderRef: ref, userId, detail: card ? '' : 'baixa manual' });
  return stoneRow(s.id);
}

/** Devolve a pedra ao estoque (desfaz a baixa) */
function returnStone(stoneId, { userId = null, reason = '' } = {}) {
  const s = stoneRow(stoneId);
  if (!s || s.status !== 'used') return s;
  q.run("UPDATE stones SET status = 'available', card_id = NULL, field_id = NULL, used_order = '', used_at = NULL, used_by = NULL, updated_at = ? WHERE id = ?", now(), s.id);
  logStone(s.id, 'returned', { cardId: s.card_id, orderRef: s.used_order, userId, detail: reason });
  return stoneRow(s.id);
}

function deleteStone(id) {
  const s = stoneRow(id);
  if (!s) throw httpError(404, 'Pedra não encontrada.');
  if (s.status === 'used') throw httpError(400, `A pedra ${s.code} está ligada ao pedido ${s.used_order || '(sem pedido)'}. Devolva ao estoque antes de excluir.`);
  q.run('DELETE FROM stones WHERE id = ?', id);
  return s;
}

function stoneHistory(id) {
  return q.all(`SELECT l.*, u.name AS user_name FROM stone_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.stone_id = ? ORDER BY l.id DESC`, id);
}

// ---------------- Pedras pequenas (por quantidade) ----------------
function meleeRow(id) {
  return q.get('SELECT * FROM melee_items WHERE id = ?', id);
}

function meleeLabel(item, qty = null) {
  if (!item) return '(item removido do estoque)';
  return `${qty ? `${qty}× ` : ''}${item.shape} ${item.size} (${item.kind === 'moissanite' ? 'moissanite' : 'lab'})`;
}

function sanitizeMelee(input, current = {}) {
  const v = { ...current, ...input };
  const out = {
    kind: KINDS[v.kind] ? v.kind : 'lab',
    shape: shapeName(v.shape),
    size: current.size && v.size === current.size ? current.size : formatSize(v.size),
    min_qty: Math.max(0, Math.min(99999, Math.round(Number(v.min_qty) || 0))),
    notes: String(v.notes ?? '').trim().slice(0, 500),
  };
  if (!out.shape) throw httpError(400, 'Escolha o formato.');
  if (!sizeNorm(out.size)) throw httpError(400, 'Informe o tamanho em mm (ex.: 1,5 ou 5x3).');
  return out;
}

function meleeTaken(m, exceptId = 0) {
  return q.get('SELECT id FROM melee_items WHERE kind = ? AND shape = ? AND size_norm = ? AND id != ?', m.kind, m.shape, sizeNorm(m.size), exceptId);
}

function createMelee(input, userId) {
  const m = sanitizeMelee(input);
  if (meleeTaken(m)) throw httpError(409, `${meleeLabel(m)} já está cadastrada. Use "Entrada" para somar unidades.`);
  const at = now();
  const id = Number(q.run('INSERT INTO melee_items (kind, shape, size, size_norm, qty, min_qty, notes, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
    m.kind, m.shape, m.size, sizeNorm(m.size), m.min_qty, m.notes, at, at).lastInsertRowid);
  const qty = Math.max(0, Math.round(Number(input.qty) || 0));
  if (qty) moveMelee(id, qty, { userId, note: 'estoque inicial' });
  return meleeRow(id);
}

function updateMelee(id, input) {
  const cur = meleeRow(id);
  if (!cur) throw httpError(404, 'Item não encontrado.');
  const m = sanitizeMelee(input, cur);
  if (meleeTaken(m, id)) throw httpError(409, `${meleeLabel(m)} já está cadastrada.`);
  q.run('UPDATE melee_items SET kind = ?, shape = ?, size = ?, size_norm = ?, min_qty = ?, notes = ?, updated_at = ? WHERE id = ?',
    m.kind, m.shape, m.size, sizeNorm(m.size), m.min_qty, m.notes, now(), id);
  return meleeRow(id);
}

const lowStockAlerts = [];

/** Entrada (+) ou saída (-) de unidades. Saída maior que o estoque é recusada. */
function moveMelee(itemId, delta, { card = null, orderRef = '', userId = null, note = '' } = {}) {
  const item = meleeRow(itemId);
  if (!item) throw httpError(404, 'Pedra pequena não encontrada no estoque.');
  delta = Math.round(Number(delta) || 0);
  if (!delta) return item;
  const after = item.qty + delta;
  if (after < 0) throw httpError(409, `Só há ${item.qty} un. de ${meleeLabel(item)} no estoque.`);
  q.run('UPDATE melee_items SET qty = ?, updated_at = ? WHERE id = ?', after, now(), item.id);
  q.run('INSERT INTO melee_moves (item_id, delta, qty_after, card_id, order_ref, user_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    item.id, delta, after, card?.id ?? null, card ? orderRefOf(card) : clean(orderRef, 160), userId ?? null, clean(note, 200), now());
  if (item.min_qty > 0 && item.qty > item.min_qty && after <= item.min_qty) lowStockAlerts.push({ ...item, qty: after });
  return meleeRow(item.id);
}

function deleteMelee(id) {
  const item = meleeRow(id);
  if (!item) throw httpError(404, 'Item não encontrado.');
  if (q.get("SELECT 1 FROM card_field_values v JOIN field_defs f ON f.id = v.field_id WHERE f.type = 'melee' AND EXISTS (SELECT 1 FROM json_each(v.value) j WHERE json_extract(j.value, '$.item') = ?)", id)) {
    throw httpError(400, `${meleeLabel(item)} está em cards. Tire dos cards antes de excluir.`);
  }
  q.run('DELETE FROM melee_items WHERE id = ?', id);
  return item;
}

function listMelee() {
  return q.all('SELECT * FROM melee_items ORDER BY kind, shape, CAST(size_norm AS REAL), size_norm');
}

function meleeHistory(id) {
  return q.all(`SELECT m.*, u.name AS user_name FROM melee_moves m LEFT JOIN users u ON u.id = m.user_id WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 500`, id);
}

// ---------------- Campos do card ----------------
/** Valor do campo "Pedras pequenas": [{ item, qty }] sem repetição */
function normalizeMeleeValue(value) {
  let list = value;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return null; } }
  if (!Array.isArray(list)) return null;
  const map = new Map();
  for (const x of list) {
    const item = Number(x?.item);
    const qty = Math.round(Number(x?.qty));
    if (!Number.isInteger(item) || item <= 0 || !(qty > 0)) continue;
    map.set(item, Math.min((map.get(item) || 0) + qty, 9999));
  }
  return map.size ? [...map].map(([item, qty]) => ({ item, qty })) : null;
}

/** O card passou a usar outra pedra (ou nenhuma): devolve a antiga e dá baixa na nova */
function applyStoneField(card, def, oldValue, newValue, userId) {
  if (oldValue && oldValue !== newValue) {
    const old = stoneRow(oldValue);
    if (old && old.card_id === card.id && old.field_id === def.id) returnStone(old.id, { userId, reason: `retirada do card (${def.name})` });
  }
  if (newValue) useStone(newValue, { card, fieldId: def.id, userId });
}

/** Mudou a lista de pedras pequenas do card: baixa só da diferença */
function applyMeleeField(card, def, oldValue, newValue, userId) {
  const before = new Map((oldValue || []).map((x) => [x.item, x.qty]));
  const after = new Map((newValue || []).map((x) => [x.item, x.qty]));
  // Primeiro as devoluções, depois as baixas (trocar 10 por 12 do mesmo item só pede 2 a mais)
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const diffs = ids.map((id) => [id, (after.get(id) || 0) - (before.get(id) || 0)]).filter(([, d]) => d).sort((a, b) => a[1] - b[1]);
  for (const [id, d] of diffs) {
    if (d < 0 && !meleeRow(id)) continue; // item excluído do estoque
    moveMelee(id, -d, { card, userId, note: d < 0 ? `devolvida (${def.name})` : def.name });
  }
}

/** Card excluído (ou campo apagado): tudo o que ele usava volta ao estoque */
function releaseCard(cardId, userId, { fieldId = null, reason = 'card excluído' } = {}) {
  const card = q.get('SELECT * FROM cards WHERE id = ?', cardId);
  for (const s of q.all(`SELECT id FROM stones WHERE card_id = ? ${fieldId ? 'AND field_id = ?' : ''}`, cardId, ...(fieldId ? [fieldId] : []))) {
    returnStone(s.id, { userId, reason });
  }
  const rows = q.all(`SELECT v.value, f.id AS field_id, f.name FROM card_field_values v JOIN field_defs f ON f.id = v.field_id
                      WHERE v.card_id = ? AND f.type = 'melee' ${fieldId ? 'AND f.id = ?' : ''}`, cardId, ...(fieldId ? [fieldId] : []));
  for (const r of rows) {
    for (const x of normalizeMeleeValue(r.value) || []) if (meleeRow(x.item)) moveMelee(x.item, x.qty, { card, userId, note: `devolvida (${reason})` });
  }
}

function releaseField(fieldId, userId) {
  const f = q.get('SELECT * FROM field_defs WHERE id = ?', fieldId);
  if (!f || !STOCK_TYPES.includes(f.type)) return;
  const cardIds = q.all('SELECT card_id FROM card_field_values WHERE field_id = ?', fieldId).map((r) => r.card_id);
  for (const id of cardIds) releaseCard(id, userId, { fieldId, reason: `campo "${f.name}" excluído` });
}

/** Textos dos campos de estoque de vários cards de uma vez: { cardId: { fieldId: texto } } */
function stockTexts(values, stockFields) {
  const stoneIds = new Set();
  const meleeIds = new Set();
  for (const v of values) {
    const type = stockFields.get(v.field_id);
    if (type === 'stone') stoneIds.add(Number(v.value));
    if (type === 'melee') for (const x of normalizeMeleeValue(v.value) || []) meleeIds.add(x.item);
  }
  const byIds = (table, ids) => {
    const list = [...ids];
    const map = new Map();
    for (let i = 0; i < list.length; i += 900) {
      const chunk = list.slice(i, i + 900);
      for (const r of q.all(`SELECT * FROM ${table} WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) map.set(r.id, r);
    }
    return map;
  };
  const stones = byIds('stones', stoneIds);
  const melee = byIds('melee_items', meleeIds);
  const out = new Map();
  for (const v of values) {
    const type = stockFields.get(v.field_id);
    if (!type) continue;
    const text = type === 'stone' ? stoneLabel(stones.get(Number(v.value)))
      : (normalizeMeleeValue(v.value) || []).map((x) => meleeLabel(melee.get(x.item), x.qty)).join(', ');
    if (!out.has(v.card_id)) out.set(v.card_id, {});
    out.get(v.card_id)[v.field_id] = text;
  }
  return out;
}

/** Texto de um valor (histórico do card, planilha, mensagens) */
function displayStock(type, value) {
  if (type === 'stone') return stoneLabel(stoneRow(Number(value)));
  return (normalizeMeleeValue(value) || []).map((x) => meleeLabel(meleeRow(x.item), x.qty)).join(', ');
}

/** Detalhes para o card aberto: pedras e itens usados em cada campo de estoque */
function cardStock(cardId) {
  const rows = q.all(`SELECT v.field_id, v.value, f.type FROM card_field_values v JOIN field_defs f ON f.id = v.field_id
                      WHERE v.card_id = ? AND f.type IN ('stone', 'melee')`, cardId);
  const out = {};
  for (const r of rows) {
    const value = JSON.parse(r.value);
    out[r.field_id] = r.type === 'stone' ? stoneRow(Number(value))
      : (normalizeMeleeValue(value) || []).map((x) => ({ ...x, info: meleeRow(x.item) }));
  }
  return out;
}

/** Itens que acabaram de chegar no estoque mínimo (conferidos no banco: uma alteração desfeita não avisa) */
const takeLowStockAlerts = () => {
  const seen = new Set();
  return lowStockAlerts.splice(0).filter((a) => !seen.has(a.id) && seen.add(a.id)).map((a) => meleeRow(a.id)).filter((m) => m && m.min_qty > 0 && m.qty <= m.min_qty);
};

module.exports = {
  KINDS, SHAPES, STOCK_TYPES, normCode, digitsOf, shapeName, formatMeasurements, formatSize, parseCarat,
  createStone, updateStone, deleteStone, stoneRow, stoneLabel, findByCode, searchStones, countStones, stoneCounts, stockSummary, movements, useStone, returnStone, stoneHistory,
  createMelee, updateMelee, moveMelee, deleteMelee, listMelee, meleeRow, meleeLabel, meleeHistory,
  normalizeMeleeValue, applyStoneField, applyMeleeField, releaseCard, releaseField, stockTexts, displayStock, cardStock, takeLowStockAlerts,
};
