// Utilitários de interface: criação de elementos, formatação e cores

/** Cria um elemento: h('div', { class: 'x', onclick }, 'texto', filho) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val); // variáveis CSS (ex.: cor da coluna)
        else el.style[prop] = val;
      }
    }
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

// Pastéis vivos: a 1ª linha é mais suave (colunas, cards), a 2ª mais intensa (etiquetas)
export const PALETTE = [
  '#ffd6e0', '#ffe5b4', '#fff3b0', '#d4f8d4', '#c7f0ec', '#cde7ff', '#dcd3ff', '#f3d1ff', '#ffc8b4', '#eef1f8',
  '#ff9ebb', '#ffb86b', '#ffd95e', '#7ee0a1', '#5fd4d0', '#7ab8ff', '#a79bff', '#e39bff', '#ff8f7a', '#94a3b8',
];

// Fundos do quadro (degradês em tons pastéis)
export const BACKGROUNDS = {
  'g:aurora': { name: 'Aurora', css: 'radial-gradient(at 0% 0%, #ffd6e8 0, transparent 55%), radial-gradient(at 100% 0%, #d6e4ff 0, transparent 55%), radial-gradient(at 100% 100%, #d4f7e9 0, transparent 55%), radial-gradient(at 0% 100%, #fff1c9 0, transparent 55%), #f3f0ff' },
  'g:algodao': { name: 'Algodão-doce', css: 'linear-gradient(135deg, #ffd6e8 0%, #e9d8ff 50%, #d6ecff 100%)' },
  'g:por-do-sol': { name: 'Pôr do sol', css: 'linear-gradient(135deg, #ffe1c6 0%, #ffd1dc 50%, #e8d5ff 100%)' },
  'g:menta': { name: 'Menta', css: 'linear-gradient(135deg, #d4f7e9 0%, #d6f0ff 55%, #eee6ff 100%)' },
  'g:lavanda': { name: 'Lavanda', css: 'linear-gradient(160deg, #ece6ff 0%, #f6e3ff 50%, #ffe6f1 100%)' },
  'g:pessego': { name: 'Pêssego', css: 'linear-gradient(135deg, #fff1c9 0%, #ffe1c6 50%, #ffd6d6 100%)' },
  'g:nuvem': { name: 'Nuvem', css: 'linear-gradient(180deg, #f7f8fc 0%, #eef1f8 100%)' },
};
export const DEFAULT_BACKGROUND = 'g:aurora';
export const backgroundCss = (bg) => BACKGROUNDS[bg]?.css || (/^#[0-9a-f]{6}$/i.test(bg || '') ? bg : BACKGROUNDS[DEFAULT_BACKGROUND].css);

// Ícones de traço (estilo Lucide)
const ICONS = {
  gem: '<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  collapse: '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
  expand: '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  kanban: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  text: '<path d="M15 12H3"/><path d="M17 18H3"/><path d="M21 6H3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  play: '<path d="M6 3l14 9-14 9Z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  checklist: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  sort: '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  select: '<rect width="18" height="18" x="3" y="3" rx="3"/><path d="m8 12 3 3 5-6"/>',
  tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  move: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  octagon: '<path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  trend: '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

export function textColorFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#2a2540' : '#ffffff';
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
/** Itens de um campo checklist (os do modelo + os só deste card) e quantos estão marcados */
export function checklistItems(def, value) {
  const done = new Set(value?.done || []);
  const items = [...def.options.map((o) => ({ id: o.id, label: o.label, extra: false })), ...(value?.extra || []).map((x) => ({ ...x, extra: true }))]
    .map((it) => ({ ...it, done: done.has(it.id) }));
  return items;
}
export function checklistProgress(def, value) {
  const items = checklistItems(def, value);
  return { done: items.filter((i) => i.done).length, total: items.length };
}

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
    case 'checklist': { const p = checklistProgress(def, value); return p.total ? `${p.done}/${p.total}` : ''; }
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
  wrap.append(h('label', { class: 'swatch custom', title: 'Cor personalizada' }, custom, icon('plus', 14)));
  if (allowNone) wrap.append(h('button', { type: 'button', class: 'btn small subtle', onclick: () => onPick(null) }, 'Sem cor'));
  return wrap;
}

export function copyText(text) {
  navigator.clipboard?.writeText(text);
}
