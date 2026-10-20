'use strict';
// Modelos de etiqueta para impressão (ex.: Zebra ZD220, 100 × 150 mm)
const { getSetting, setSetting } = require('./db');
const { fieldDefs } = require('./cards');

const ITEM_KEYS = ['title', 'card_id', 'column', 'due_date', 'created_at', 'labels', 'members', 'description', 'qr', 'barcode', 'photo', 'text', 'divider'];
const SIZES = ['s', 'm', 'l', 'xl'];
const key = (boardId) => `print_templates:${boardId}`;
const uid = () => Math.random().toString(36).slice(2, 10);

/** Modelo inicial: título, foto + QR lado a lado, prazo, etapa e os campos do quadro */
function defaultTemplate(boardId) {
  const fields = fieldDefs(boardId);
  return {
    id: 'padrao',
    name: 'Ficha de produção',
    width_mm: 100,
    height_mm: 150,
    orientation: 'portrait',
    margin_mm: 4,
    items: [
      { key: 'title', size: 'l', bold: true, width: 'full' },
      { key: 'photo', size: 'm', width: 'half' },
      { key: 'qr', size: 'm', width: 'half' },
      { key: 'due_date', size: 'm', bold: true, show_name: true, width: 'half' },
      { key: 'column', size: 's', show_name: true, width: 'half' },
      { key: 'divider', width: 'full' },
      ...fields.map((f) => ({ key: `field:${f.id}`, size: 'm', show_name: true, width: ['textarea', 'text'].includes(f.type) ? 'full' : 'half' })),
    ],
  };
}

function sanitizeItem(item, fieldIds) {
  const k = String(item?.key || '');
  const fieldMatch = /^field:(\d+)$/.exec(k);
  if (!ITEM_KEYS.includes(k) && !(fieldMatch && fieldIds.has(Number(fieldMatch[1])))) return null;
  const out = {
    key: k,
    size: SIZES.includes(item.size) ? item.size : 'm',
    width: item.width === 'half' ? 'half' : 'full',
    bold: !!item.bold,
    show_name: !!item.show_name,
    align: ['left', 'center', 'right'].includes(item.align) ? item.align : 'left',
  };
  if (k === 'text') out.text = String(item.text || '').slice(0, 300);
  if (k === 'barcode') {
    const src = String(item.source || 'card_id');
    out.source = src === 'card_id' || (/^field:(\d+)$/.test(src) && fieldIds.has(Number(src.slice(6)))) ? src : 'card_id';
  }
  return out;
}

function sanitizeTemplate(t, boardId) {
  const fieldIds = new Set(fieldDefs(boardId).map((f) => f.id));
  const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def; };
  return {
    id: /^[a-z0-9-]{1,40}$/i.test(t?.id || '') ? t.id : uid(),
    name: String(t?.name || '').trim().slice(0, 80) || 'Etiqueta',
    width_mm: num(t?.width_mm, 20, 300, 100),
    height_mm: num(t?.height_mm, 20, 300, 150),
    orientation: t?.orientation === 'landscape' ? 'landscape' : 'portrait',
    margin_mm: num(t?.margin_mm, 0, 20, 4),
    items: (Array.isArray(t?.items) ? t.items : []).slice(0, 60).map((i) => sanitizeItem(i, fieldIds)).filter(Boolean),
  };
}

function getTemplates(boardId) {
  const stored = getSetting(key(boardId), null);
  if (!stored?.templates?.length) return { templates: [defaultTemplate(boardId)], default_id: 'padrao' };
  return stored;
}

function saveTemplates(boardId, body) {
  const templates = (Array.isArray(body?.templates) ? body.templates : []).slice(0, 20).map((t) => sanitizeTemplate(t, boardId));
  if (!templates.length) templates.push(defaultTemplate(boardId));
  const ids = new Set();
  for (const t of templates) { while (ids.has(t.id)) t.id = uid(); ids.add(t.id); }
  const defaultId = templates.some((t) => t.id === body?.default_id) ? body.default_id : templates[0].id;
  const value = { templates, default_id: defaultId };
  setSetting(key(boardId), value);
  return value;
}

module.exports = { getTemplates, saveTemplates, sanitizeTemplate, defaultTemplate, ITEM_KEYS };
