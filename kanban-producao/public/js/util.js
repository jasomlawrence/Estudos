// Utilitários de interface: criação de elementos, formatação e cores

/** Cria um elemento: h('div', { class: 'x', onclick }, 'texto', filho) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export const PALETTE = [
  '#61bd4f', '#f2d600', '#ff9f1a', '#eb5a46', '#c377e0', '#0079bf', '#00c2e0', '#51e898', '#ff78cb', '#344563',
  '#cfe2ff', '#e2d9f3', '#ffe5d0', '#fff3cd', '#d1ecf1', '#f8d7da', '#d1e7dd', '#ebecf0', '#d4a72c', '#a0aec0',
];

export function textColorFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#172b4d' : '#ffffff';
}

const dtf = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });
export const fmtDateTime = (iso) => (iso ? dtf.format(new Date(iso)) : '');
export const fmtShortDate = (iso) => (iso ? df.format(new Date(iso)).replace('.', '') : '');
export const fmtMoney = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function fmtDuration(ms) {
  if (ms == null) return '—';
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const hr = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}min`;
  return `${m}min`;
}

export function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 7) return `há ${Math.floor(s / 86400)} d`;
  return fmtDateTime(iso);
}

/** Valor de input datetime-local a partir de ISO (horário local) */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

export function avatar(user, size = 26) {
  if (!user) return null;
  return h('span', { class: 'avatar', title: user.name, style: { background: user.avatar_color, width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` } }, initials(user.name));
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Exibe um valor de campo personalizado como texto */
export function fieldText(def, value) {
  if (value === null || value === undefined || value === '') return '';
  switch (def.type) {
    case 'checkbox': return value ? '✔ Sim' : 'Não';
    case 'currency': return fmtMoney(value);
    case 'number': return Number(value).toLocaleString('pt-BR');
    case 'date': { const [y, m, d] = value.split('-'); return `${d}/${m}/${y}`; }
    case 'datetime': return fmtDateTime(value);
    case 'select': return def.options.find((o) => o.id === value)?.label ?? '';
    case 'multiselect': return value.map((id) => def.options.find((o) => o.id === id)?.label).filter(Boolean).join(', ');
    default: return String(value);
  }
}

/** Seletor de cor: paleta + cor livre */
export function colorPicker(current, onPick, { allowNone = true } = {}) {
  const wrap = h('div', { class: 'color-picker' });
  for (const c of PALETTE) {
    wrap.append(h('button', { type: 'button', class: `swatch${c === current ? ' active' : ''}`, style: { background: c }, title: c, onclick: () => onPick(c) }));
  }
  const custom = h('input', { type: 'color', value: current && /^#[0-9a-f]{6}$/i.test(current) ? current : '#888888', title: 'Cor personalizada', onchange: (e) => onPick(e.target.value) });
  wrap.append(h('label', { class: 'swatch custom', title: 'Cor personalizada' }, custom, '＋'));
  if (allowNone) wrap.append(h('button', { type: 'button', class: 'btn small subtle', onclick: () => onPick(null) }, 'Sem cor'));
  return wrap;
}

export function copyText(text) {
  navigator.clipboard?.writeText(text);
}
