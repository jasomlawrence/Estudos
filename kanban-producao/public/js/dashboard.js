// Painel (dashboard): como anda a produção — indicadores, velocímetro de prazos, gráficos e pedidos por período
import { h, $, clear, avatar, fmtDuration, icon } from './util.js';
import { get } from './api.js';
import { state, userById, columnById } from './state.js';
import { openCard } from './card.js';
import { boardLoadedHooks } from './board.js';

// Cores dos gráficos: paleta categórica validada (slots 1 e 2) e cores de status reservadas (sempre com ícone + texto)
const SERIES = ['#2a78d6', '#eb6834'];
const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b', neutral: '#9a96ad' };
const ZONES = [
  { from: 0, to: 65, color: STATUS.critical, label: 'Crítico', icon: 'octagon' },
  { from: 65, to: 85, color: STATUS.warning, label: 'Atenção', icon: 'alert' },
  { from: 85, to: 100, color: STATUS.good, label: 'Dentro do prazo', icon: 'check' },
];
const DAY = 864e5;

const dash = { data: null, mode: 'due', group: 'today', loading: false, observers: [] };

// ---------- Datas no horário local ----------
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const keyOf = (iso) => (iso ? dayKey(new Date(iso)) : null);
const fmtDay = (key) => { const [, m, d] = key.split('-'); return `${d}/${m}`; };
const fmtDays = (ms) => (ms == null ? '—' : `${(ms / DAY).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} d`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function periods() {
  const now = new Date();
  const today = dayKey(now);
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { today, weekFrom: dayKey(monday), weekTo: dayKey(sunday), month: today.slice(0, 7) };
}

// ---------- SVG ----------
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
/** Barra horizontal com a ponta arredondada (4px) e a base reta, presa no eixo */
function hbar(x, y, w, hgt, r = 4) {
  if (w <= 0) return '';
  const rr = Math.min(r, w, hgt / 2);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt - rr}Q${x + w},${y + hgt} ${x + w - rr},${y + hgt}H${x}Z`;
}
function vbar(x, y, w, hgt, r = 4) {
  if (hgt <= 0) return '';
  const rr = Math.min(r, hgt, w / 2);
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}
function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

// ---------- Dica ao passar o mouse ----------
let tipEl;
function tip(e, content) {
  tipEl ||= document.body.appendChild(h('div', { class: 'viz-tip', role: 'tooltip' }));
  clear(tipEl, content);
  tipEl.hidden = false;
  const pad8 = 14;
  const { innerWidth: W, innerHeight: H } = window;
  const r = tipEl.getBoundingClientRect();
  let x = e.clientX + pad8;
  let y = e.clientY + pad8;
  if (x + r.width > W - 8) x = e.clientX - r.width - pad8;
  if (y + r.height > H - 8) y = e.clientY - r.height - pad8;
  tipEl.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}
const untip = () => { if (tipEl) tipEl.hidden = true; };
const tipLines = (title, ...rows) => [h('strong', {}, title), ...rows.filter(Boolean).map((r) => h('div', {}, r))];
const swatchRow = (color, label, value) => h('div', { class: 'tip-row' }, h('span', { class: 'tip-key', style: { background: color } }), label, h('b', {}, value));

/** Área sensível maior que a marca: o mouse/dedo não precisa acertar a barra fina */
function hit(x, y, w, hgt, onenter, onclick) {
  const r = s('rect', { x, y, width: Math.max(w, 1), height: Math.max(hgt, 1), fill: 'transparent', class: onclick ? 'hit clickable' : 'hit' });
  r.addEventListener('pointermove', onenter);
  r.addEventListener('pointerleave', untip);
  if (onclick) r.addEventListener('click', onclick);
  return r;
}

// ---------- Carregamento ----------
export async function loadDashboard() {
  const root = $('#dashboard');
  if (!root || !state.boardId || dash.loading) return;
  dash.loading = true;
  if (!dash.data) clear(root, h('p', { class: 'muted dash-loading' }, 'Calculando indicadores…'));
  try {
    dash.data = await get(`/boards/${state.boardId}/dashboard`);
    render();
  } catch (err) {
    clear(root, h('p', { class: 'error' }, err.message));
  } finally {
    dash.loading = false;
  }
}

boardLoadedHooks.push(() => { if (state.view === 'dashboard') loadDashboard(); });

function render() {
  const root = $('#dashboard');
  const d = dash.data;
  dash.observers.forEach((o) => o.disconnect());
  dash.observers = [];
  const updated = new Date(d.generated_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  clear(root, h('div', { class: 'dash' },
    h('div', { class: 'dash-head' },
      h('div', {}, h('h2', {}, 'Painel de produção'),
        h('p', { class: 'muted small' }, `Atualizado às ${updated} · cronômetro de "${d.cycle.start?.name || '—'}" até "${d.cycle.end?.name || '—'}"`))),
    h('div', { class: 'dash-top' }, gaugeCard(d), kpiGrid(d)),
    h('div', { class: 'dash-grid' },
      chartCard('Cards por etapa', 'Quantos cards estão em cada coluna agora', (el) => stageChart(el, d)),
      chartCard('Entradas × concluídos', 'Por semana (segunda a domingo), últimas 8 semanas', (el) => flowChart(el, d), legend([[SERIES[0], 'Entradas'], [SERIES[1], 'Concluídos']])),
      chartCard('Tempo médio em cada etapa', 'Cards concluídos nos últimos 90 dias', (el) => stageTimeChart(el, d)),
      chartCard('Tempo de produção', 'Média dos cards concluídos em cada semana', (el) => leadChart(el, d))),
    ordersCard(d)));
}

function chartCard(title, subtitle, draw, extra = null) {
  const body = h('div', { class: 'chart-body' });
  const card = h('section', { class: 'dash-card' }, h('header', {}, h('h3', {}, title), h('p', { class: 'muted small' }, subtitle), extra), body);
  let lastW = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.floor(body.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    clear(body);
    draw(body);
  });
  ro.observe(body);
  dash.observers.push(ro);
  return card;
}

const legend = (items) => h('div', { class: 'viz-legend' }, items.map(([c, l]) => h('span', {}, h('i', { style: { background: c } }), l)));

// ---------- Velocímetro ----------
function zoneOf(score) { return ZONES.find((z) => score < z.to) || ZONES[ZONES.length - 1]; }

function gaugeCard(d) {
  const g = d.gauge;
  const cx = 130; const cy = 128; const r = 100; const sw = 18;
  const pt = (v, rad = r) => { const a = Math.PI * (1 - v / 100); return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)]; };
  const arc = (from, to) => { const [x1, y1] = pt(from); const [x2, y2] = pt(to); return `M${x1},${y1}A${r},${r} 0 0 1 ${x2},${y2}`; };
  const GAP = 0.9; // espaço entre as faixas
  const svg = s('svg', { viewBox: '0 0 260 150', class: 'gauge', role: 'img', 'aria-label': g.score == null ? 'Sem prazos para medir' : `Saúde dos prazos: ${g.score}%` },
    s('path', { d: arc(0, 100), stroke: 'var(--surface-2)', 'stroke-width': sw + 6, fill: 'none' }),
    ZONES.map((z) => s('path', { d: arc(z.from + (z.from ? GAP : 0), z.to - (z.to < 100 ? GAP : 0)), stroke: z.color, 'stroke-width': sw, fill: 'none', opacity: g.score == null || zoneOf(g.score) === z ? 1 : 0.35 })),
    [0, 65, 85, 100].map((v) => { const [x, y] = pt(v, r - sw / 2 - 12); return s('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'gauge-tick' }, String(v)); }));
  if (g.score != null) {
    const [nx, ny] = pt(g.score, r - sw / 2 - 4);
    svg.append(
      s('line', { x1: cx, y1: cy, x2: nx, y2: ny, stroke: 'var(--ink)', 'stroke-width': 4, 'stroke-linecap': 'round', class: 'gauge-needle' }),
      s('circle', { cx, cy, r: 9, fill: 'var(--ink)' }),
      s('circle', { cx, cy, r: 3.5, fill: 'var(--surface)' }));
  }
  const z = g.score == null ? null : zoneOf(g.score);
  return h('section', { class: 'dash-card gauge-card' },
    h('header', {}, h('h3', {}, 'Saúde dos prazos'), h('p', { class: 'muted small' }, 'Cards ativos dentro do prazo + entregues no prazo nos últimos 30 dias')),
    svg,
    h('div', { class: 'gauge-value' },
      h('strong', {}, g.score == null ? '—' : `${g.score}%`),
      z ? h('span', { class: 'status-pill', style: { '--st': z.color } }, icon(z.icon, 14), z.label) : h('span', { class: 'muted small' }, 'Nenhum card com prazo ainda')),
    h('ul', { class: 'gauge-facts small' },
      h('li', {}, h('b', {}, `${g.active_ok} de ${g.active_due}`), ' cards em andamento estão no prazo'),
      h('li', {}, h('b', {}, `${g.done_ok} de ${g.done_due}`), ' entregues no prazo (30 dias)')),
    h('p', { class: 'muted tiny' }, 'Verde a partir de 85%, amarelo de 65% a 84%, vermelho abaixo de 65%.'));
}

// ---------- Indicadores ----------
function delta(cur, prev, { lowerIsBetter = false, fmt = (v) => String(v) } = {}) {
  if (prev == null || cur == null || !prev) return 'sem comparação com os 30 dias anteriores';
  const diff = cur - prev;
  if (Math.abs(diff) < 1e-9) return 'igual aos 30 dias anteriores';
  const better = lowerIsBetter ? diff < 0 : diff > 0;
  return h('span', {}, h('span', { class: `delta ${better ? 'up' : 'down'}` }, `${diff > 0 ? '▲' : '▼'} ${fmt(Math.abs(diff))}`), ' vs 30 dias anteriores');
}

function kpiGrid(d) {
  const k = d.kpis;
  const tile = (iconName, label, value, sub, { status, onclick } = {}) => h(onclick ? 'button' : 'div', {
    class: `kpi${onclick ? ' clickable' : ''}`, style: status ? { '--st': status } : {}, onclick, type: onclick ? 'button' : undefined,
  },
  h('span', { class: 'kpi-label' }, icon(iconName, 15), label),
  h('strong', { class: 'kpi-value' }, value),
  h('span', { class: 'kpi-sub muted' }, sub));
  const goTo = (mode, group) => () => { dash.mode = mode; dash.group = group; render(); $('.orders-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  return h('div', { class: 'kpi-grid' },
    tile('play', 'Em produção', String(k.producing), 'cronômetro rodando'),
    tile('pause', 'Em espera', String(k.waiting), 'ainda não entraram na produção'),
    tile('check', 'Concluídos', String(k.done_30), delta(k.done_30, k.done_prev), { onclick: goTo('done', 'month') }),
    tile('clock', 'Tempo médio de produção', fmtDays(k.avg_ms_30), delta(k.avg_ms_30, k.avg_ms_prev, { lowerIsBetter: true, fmt: fmtDays })),
    tile('octagon', 'Atrasados', String(k.overdue), k.overdue ? 'prazo vencido, ainda em produção' : 'nenhum atrasado', { status: k.overdue ? STATUS.critical : null, onclick: goTo('due', 'late') }),
    tile('alert', `Em risco (até ${d.risk_days} dias)`, String(k.risk), k.on_time_30 == null ? 'prazo bem próximo' : `${Math.round(k.on_time_30 * 100)}% entregues no prazo em 30 dias`, { status: k.risk ? STATUS.warning : null, onclick: goTo('due', 'week') }));
}

// ---------- Gráficos ----------
function horizontalBars(el, rows, { value, label, color, valueText, noteText, tipContent, onclick }) {
  if (!rows.length) return el.append(h('p', { class: 'muted small empty-chart' }, 'Sem dados ainda.'));
  const W = el.clientWidth;
  const labelW = Math.min(150, Math.max(90, W * 0.32));
  const valueW = rows.some((r) => noteText?.(r)) ? 112 : 56;
  const rowH = 30; const barH = 12;
  const max = Math.max(...rows.map(value), 1);
  const plotW = Math.max(40, W - labelW - valueW);
  const svg = s('svg', { width: W, height: rows.length * rowH + 4, class: 'viz', role: 'img' });
  rows.forEach((r, i) => {
    const y = i * rowH + 4;
    const w = (value(r) / max) * plotW;
    const dot = r.color ? s('circle', { cx: 6, cy: y + rowH / 2 - 2, r: 5, fill: r.color, stroke: 'rgba(42,37,64,.25)', 'stroke-width': 1 }) : null;
    const text = s('text', { x: r.color ? 16 : 0, y: y + rowH / 2 - 2, 'dominant-baseline': 'middle', class: 'viz-label' }, label(r));
    svg.append(
      dot, text,
      s('line', { x1: labelW, x2: labelW, y1: y, y2: y + rowH - 4, class: 'viz-axis' }),
      s('path', { d: hbar(labelW, y + (rowH - 4 - barH) / 2, w, barH), fill: color }),
      s('text', { x: labelW + w + 6, y: y + rowH / 2 - 2, 'dominant-baseline': 'middle', class: 'viz-value' }, valueText(r),
        noteText?.(r) ? s('tspan', { class: 'viz-note', dx: 6 }, noteText(r)) : null),
      hit(0, y, W, rowH, (e) => tip(e, tipContent(r)), onclick ? () => onclick(r) : null));
    // Corta rótulos longos para caberem na coluna de nomes
    requestAnimationFrame(() => {
      let t = label(r);
      while (text.getComputedTextLength?.() > labelW - (r.color ? 22 : 6) && t.length > 4) { t = t.slice(0, -2); text.textContent = `${t}…`; }
    });
  });
  el.append(svg);
}

function stageChart(el, d) {
  horizontalBars(el, d.stages, {
    value: (r) => r.count, label: (r) => r.name, color: SERIES[0],
    valueText: (r) => String(r.count), noteText: (r) => (r.overdue ? `${r.overdue} atrasado${r.overdue > 1 ? 's' : ''}` : ''),
    tipContent: (r) => tipLines(r.name, plural(r.count, 'card', 'cards'), r.overdue ? `${plural(r.overdue, 'atrasado', 'atrasados')} (prazo vencido)` : null, r.is_end ? 'Coluna final (produção concluída)' : null),
  });
}

function stageTimeChart(el, d) {
  horizontalBars(el, d.stage_time, {
    value: (r) => r.avg_ms, label: (r) => r.name, color: SERIES[0], valueText: (r) => fmtDays(r.avg_ms),
    tipContent: (r) => tipLines(r.name, `Tempo médio: ${fmtDuration(r.avg_ms)}`, `Base: ${plural(r.count, 'card concluído', 'cards concluídos')}`),
  });
}

function columnChart(el, d, { series, height = 190, onhover }) {
  const W = el.clientWidth;
  const m = { l: 30, r: 8, t: 10, b: 24 };
  const plotW = W - m.l - m.r; const plotH = height - m.t - m.b;
  const max = niceMax(Math.max(...d.weekly.flatMap((w) => series.map((sr) => sr.value(w) || 0)), 1));
  const svg = s('svg', { width: W, height, class: 'viz', role: 'img' });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i; const y = m.t + plotH - (v / max) * plotH;
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: i ? 'viz-grid' : 'viz-axis' }),
      s('text', { x: m.l - 6, y, 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'viz-tick' }, Number.isInteger(v) ? String(v) : v.toFixed(1)));
  }
  const band = plotW / d.weekly.length;
  return { svg, band, m, plotH, max, W, height, x: (i) => m.l + i * band };
}

function flowChart(el, d) {
  const series = [{ value: (w) => w.created, color: SERIES[0] }, { value: (w) => w.done, color: SERIES[1] }];
  const c = columnChart(el, d, { series });
  const barW = Math.max(4, Math.min(18, (c.band - 10) / 2 - 1));
  const hover = s('rect', { y: c.m.t, height: c.plotH, width: c.band, class: 'viz-band', visibility: 'hidden' });
  c.svg.prepend(hover);
  d.weekly.forEach((w, i) => {
    const x0 = c.x(i) + (c.band - (barW * 2 + 2)) / 2;
    series.forEach((sr, j) => {
      const v = sr.value(w); const hh = (v / c.max) * c.plotH;
      c.svg.append(s('path', { d: vbar(x0 + j * (barW + 2), c.m.t + c.plotH - hh, barW, hh), fill: sr.color }));
    });
    if (i % (c.band < 34 ? 2 : 1) === 0 || i === d.weekly.length - 1) {
      c.svg.append(s('text', { x: c.x(i) + c.band / 2, y: c.height - 6, 'text-anchor': 'middle', class: 'viz-tick' }, i === d.weekly.length - 1 ? 'esta sem.' : fmtDay(w.week)));
    }
    c.svg.append(hit(c.x(i), c.m.t, c.band, c.plotH + c.m.b, (e) => {
      hover.setAttribute('x', c.x(i)); hover.setAttribute('visibility', 'visible');
      tip(e, [h('strong', {}, i === d.weekly.length - 1 ? 'Esta semana' : `Semana de ${fmtDay(w.week)}`),
        swatchRow(SERIES[0], 'Entradas', w.created), swatchRow(SERIES[1], 'Concluídos', w.done),
        w.done ? h('div', { class: 'muted' }, `${w.on_time} de ${w.done} no prazo`) : null]);
    }));
  });
  c.svg.addEventListener('pointerleave', () => hover.setAttribute('visibility', 'hidden'));
  el.append(c.svg);
}

function leadChart(el, d) {
  const pts = d.weekly.map((w) => (w.avg_ms == null ? null : w.avg_ms / DAY));
  if (pts.every((v) => v == null)) return el.append(h('p', { class: 'muted small empty-chart' }, 'Ainda não há cards concluídos nas últimas 8 semanas.'));
  const c = columnChart(el, { weekly: d.weekly }, { series: [{ value: (w) => (w.avg_ms == null ? 0 : w.avg_ms / DAY) }] });
  const cx = (i) => c.x(i) + c.band / 2;
  const cy = (v) => c.m.t + c.plotH - (v / c.max) * c.plotH;
  // Linha interrompida nas semanas sem conclusões
  let path = ''; let pen = false;
  pts.forEach((v, i) => { if (v == null) { pen = false; return; } path += `${pen ? 'L' : 'M'}${cx(i)},${cy(v)}`; pen = true; });
  const cross = s('line', { y1: c.m.t, y2: c.m.t + c.plotH, class: 'viz-cross', visibility: 'hidden' });
  c.svg.append(cross, s('path', { d: path, fill: 'none', stroke: SERIES[0], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  pts.forEach((v, i) => { if (v != null) c.svg.append(s('circle', { cx: cx(i), cy: cy(v), r: 4, fill: SERIES[0], stroke: 'var(--surface)', 'stroke-width': 2 })); });
  const lastI = pts.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop();
  c.svg.append(s('text', { x: Math.min(cx(lastI), c.W - 30), y: cy(pts[lastI]) - 10, 'text-anchor': 'middle', class: 'viz-value' }, fmtDays(pts[lastI] * DAY)));
  d.weekly.forEach((w, i) => {
    if (i % (c.band < 34 ? 2 : 1) === 0 || i === d.weekly.length - 1) {
      c.svg.append(s('text', { x: cx(i), y: c.height - 6, 'text-anchor': 'middle', class: 'viz-tick' }, i === d.weekly.length - 1 ? 'esta sem.' : fmtDay(w.week)));
    }
    c.svg.append(hit(c.x(i), c.m.t, c.band, c.plotH + c.m.b, (e) => {
      cross.setAttribute('x1', cx(i)); cross.setAttribute('x2', cx(i)); cross.setAttribute('visibility', 'visible');
      tip(e, tipLines(i === d.weekly.length - 1 ? 'Esta semana' : `Semana de ${fmtDay(w.week)}`,
        w.avg_ms == null ? 'Nenhum card concluído' : `Tempo médio: ${fmtDuration(w.avg_ms)}`, w.done ? plural(w.done, 'card concluído', 'cards concluídos') : null));
    }));
  });
  c.svg.addEventListener('pointerleave', () => cross.setAttribute('visibility', 'hidden'));
  el.append(c.svg);
}

// ---------- Pedidos por período ----------
function statusOf(card, riskDays) {
  if (card.cycle_ended_at) {
    const late = card.due_date && card.cycle_ended_at > card.due_date;
    return late ? { key: 'done-late', label: 'Entregue com atraso', color: STATUS.warning, icon: 'alert' } : { key: 'done', label: 'Concluído', color: STATUS.good, icon: 'check' };
  }
  if (card.due_date) {
    const diff = Date.parse(card.due_date) - Date.now();
    if (diff < 0) return { key: 'late', label: 'Atrasado', color: STATUS.critical, icon: 'octagon' };
    if (diff <= riskDays * DAY) return { key: 'risk', label: 'Em risco', color: STATUS.warning, icon: 'alert' };
  }
  if (!card.cycle_started_at) return { key: 'wait', label: 'Aguardando', color: STATUS.neutral, icon: 'pause' };
  return { key: 'ok', label: 'No prazo', color: STATUS.good, icon: 'play' };
}

const MODES = [['due', 'Prazo de entrega', 'due_date'], ['created', 'Entrada do pedido', 'created_at'], ['done', 'Conclusão', 'cycle_ended_at']];

function relative(iso) {
  const days = Math.round((new Date(keyOf(iso)) - new Date(keyOf(new Date().toISOString()))) / DAY);
  if (days === 0) return 'hoje';
  if (days === 1) return 'amanhã';
  if (days === -1) return 'ontem';
  return days > 0 ? `em ${days} dias` : `há ${-days} dias`;
}

function ordersCard(d) {
  const [, , dateKey] = MODES.find(([k]) => k === dash.mode);
  const p = periods();
  const dated = d.cards.filter((c) => c[dateKey]);
  const groups = {
    today: dated.filter((c) => keyOf(c[dateKey]) === p.today),
    week: dated.filter((c) => { const k = keyOf(c[dateKey]); return k >= p.weekFrom && k <= p.weekTo; }),
    month: dated.filter((c) => keyOf(c[dateKey]).startsWith(p.month)),
  };
  if (dash.mode === 'due') groups.late = d.cards.filter((c) => !c.cycle_ended_at && c.due_date && Date.parse(c.due_date) < Date.now());
  if (!groups[dash.group]) dash.group = 'today';
  const tabs = [['today', 'Hoje'], ['week', 'Esta semana'], ['month', 'Este mês'], ...(groups.late ? [['late', 'Atrasados']] : [])];
  const list = [...groups[dash.group]].sort((a, b) => (a[dateKey] || '').localeCompare(b[dateKey] || ''));
  if (dash.mode !== 'due') list.reverse();
  const counts = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));

  // Resumo por status do grupo escolhido
  const byStatus = {};
  for (const c of list) { const st = statusOf(c, d.risk_days); (byStatus[st.key] ||= { ...st, n: 0 }).n++; }

  const dateHead = { due: 'Prazo', created: 'Entrada', done: 'Concluído em' }[dash.mode];
  return h('section', { class: 'dash-card orders-card' },
    h('header', { class: 'orders-head' },
      h('div', {}, h('h3', {}, 'Pedidos por período'), h('p', { class: 'muted small' }, 'Clique em um pedido para abrir o card.')),
      h('div', { class: 'segmented' }, MODES.map(([k, l]) => h('button', { class: dash.mode === k ? 'active' : '', onclick: () => { dash.mode = k; render(); } }, l)))),
    h('div', { class: 'period-tabs', role: 'tablist' }, tabs.map(([k, l]) => h('button', {
      role: 'tab', class: `${dash.group === k ? 'active' : ''}${k === 'late' && counts.late ? ' late' : ''}`, 'aria-selected': String(dash.group === k),
      onclick: () => { dash.group = k; render(); },
    }, l, h('span', { class: 'count' }, String(counts[k]))))),
    list.length ? h('div', { class: 'status-summary' }, Object.values(byStatus).map((st) => h('span', { class: 'status-pill', style: { '--st': st.color } }, icon(st.icon, 13), `${st.n} ${st.label.toLowerCase()}`))) : null,
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'orders-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Pedido'), h('th', {}, 'Etapa'), h('th', {}, dateHead), dash.mode !== 'due' ? h('th', {}, 'Prazo') : null, h('th', {}, 'Situação'), h('th', {}, 'Responsáveis'), h('th', { class: 'num' }, 'Em produção'))),
      h('tbody', {}, list.map((c) => {
        const col = columnById(c.column_id);
        const st = statusOf(c, d.risk_days);
        const ms = c.cycle_started_at ? Date.parse(c.cycle_ended_at || new Date().toISOString()) - Date.parse(c.cycle_started_at) : null;
        return h('tr', { class: 'clickable', tabIndex: 0, onclick: () => openCard(c.id), onkeydown: (e) => { if (e.key === 'Enter') openCard(c.id); } },
          h('td', {}, h('div', { class: 'order-title' }, c.cover ? h('img', { src: c.cover, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb-empty' }, icon('gem', 14)), h('span', {}, c.title))),
          h('td', {}, col ? h('span', { class: 'stage' }, h('i', { style: { background: col.color } }), col.name) : '—'),
          h('td', { class: 'nowrap' }, fmtDay(keyOf(c[dateKey])), h('small', { class: 'muted' }, ` · ${relative(c[dateKey])}`)),
          dash.mode !== 'due' ? h('td', { class: 'nowrap' }, c.due_date ? fmtDay(keyOf(c.due_date)) : '—') : null,
          h('td', {}, h('span', { class: 'status-pill', style: { '--st': st.color } }, icon(st.icon, 13), st.label)),
          h('td', {}, h('span', { class: 'card-members' }, c.members.map(userById).filter(Boolean).map((u) => avatar(u, 22)))),
          h('td', { class: 'num nowrap' }, ms == null ? '—' : fmtDuration(ms)));
      })))) : h('p', { class: 'muted empty-orders' }, {
      today: 'Nenhum pedido para hoje.', week: 'Nenhum pedido nesta semana.', month: 'Nenhum pedido neste mês.', late: 'Nenhum pedido atrasado. 🎉',
    }[dash.group]));
}
document.addEventListener('scroll', untip, true);
