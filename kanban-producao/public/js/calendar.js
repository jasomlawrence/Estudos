// Visualização em calendário: cards distribuídos pela data escolhida (prazo, criação ou campo de data)
import { h, $, $$, clear, textColorFor, avatar, fieldText, icon } from './util.js';
import { get, put, patch, attempt, popover, toast } from './api.js';
import { state, canEdit, userById, labelById, columnById, markLocalEdit } from './state.js';
import { openCard } from './card.js';
import { boardLoadedHooks, DRAG_OPTIONS, reloadSoon, highlightRing } from './board.js';

/* global Sortable */

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MONTH_LIMIT = 3; // cards visíveis por dia na visão de mês

const cal = { anchor: startOfDay(new Date()), prefs: null, data: null, sortables: [], loading: false };

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function range() {
  if (cal.prefs.mode === 'week') {
    const start = addDays(cal.anchor, -cal.anchor.getDay());
    return { start, days: 7 };
  }
  const first = new Date(cal.anchor.getFullYear(), cal.anchor.getMonth(), 1);
  return { start: addDays(first, -first.getDay()), days: 42 };
}

// ---------------- Datas de cada card ----------------
function sourceField() {
  const m = /^field:(\d+)$/.exec(cal.prefs.date_source);
  return m ? state.fields.find((f) => f.id === Number(m[1])) : null;
}

function cardDate(card) {
  const src = cal.prefs.date_source;
  if (src === 'due_date') return card.due_date;
  if (src === 'created_at') return card.created_at;
  const f = sourceField();
  return f ? card.fields[f.id] : null;
}

/** Dia (AAAA-MM-DD, horário local) e hora do card no calendário */
function cardDay(card) {
  const value = cardDate(card);
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { key: value, time: null };
  const d = new Date(value);
  return { key: dayKey(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

const dateLabel = () => {
  const src = cal.prefs.date_source;
  if (src === 'due_date') return 'Prazo de entrega';
  if (src === 'created_at') return 'Data de criação';
  return sourceField()?.name || 'Data';
};

// ---------------- Carregamento ----------------
export async function loadCalendar() {
  if (!isCalendarVisible() || state.dragging) return; // durante o arraste a recarga vem no fim
  if (cal.loading) { cal.again = true; return; } // recarrega de novo quando a atual terminar
  cal.loading = true;
  try {
    if (!cal.prefs || cal.prefs.boardId !== state.boardId) {
      const first = await get(`/boards/${state.boardId}/calendar?from=1970-01-01&to=1970-01-02`);
      cal.prefs = { ...first.prefs, boardId: state.boardId };
    }
    const { start, days } = range();
    // Folga de 1 dia nas pontas por causa do fuso horário; o posicionamento final é feito aqui no navegador
    const params = new URLSearchParams({
      from: addDays(start, -1).toISOString(), to: addDays(start, days + 1).toISOString(), date: cal.prefs.date_source,
    });
    if (state.search) params.set('q', state.search);
    if (state.archived) params.set('archived', '1');
    cal.data = await get(`/boards/${state.boardId}/calendar?${params}`);
    cal.prefs.date_source = cal.data.prefs.date_source;
    render();
  } finally {
    cal.loading = false;
    if (cal.again) { cal.again = false; loadCalendar(); }
  }
}

export const isCalendarVisible = () => $('#calendar') && !$('#calendar').hidden;
boardLoadedHooks.push(() => loadCalendar().catch(() => {}));

async function savePrefs(change) {
  Object.assign(cal.prefs, change);
  const saved = await attempt(() => put(`/boards/${state.boardId}/calendar-prefs`, change));
  if (saved) Object.assign(cal.prefs, saved);
}

// ---------------- Desenho ----------------
function render() {
  const root = $('#calendar');
  const { start, days } = range();
  const today = dayKey(new Date());
  const byDay = new Map();
  for (const card of cal.data.cards) {
    const d = cardDay(card);
    if (!d) continue;
    if (!byDay.has(d.key)) byDay.set(d.key, []);
    byDay.get(d.key).push({ card, time: d.time });
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));

  const isWeek = cal.prefs.mode === 'week';
  const title = isWeek
    ? weekTitle(start)
    : cal.anchor.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase());

  const grid = h('div', { class: `cal-grid ${isWeek ? 'week' : 'month'}` },
    WEEKDAYS.map((w) => h('div', { class: 'cal-weekday' }, w)));
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i);
    const key = dayKey(day);
    const items = byDay.get(key) || [];
    const outside = !isWeek && day.getMonth() !== cal.anchor.getMonth();
    const visible = isWeek ? items : items.slice(0, MONTH_LIMIT);
    const list = h('div', { class: 'cal-day-cards', dataset: { date: key } }, visible.map((it) => chip(it.card, it.time)));
    grid.append(h('div', { class: `cal-day${outside ? ' outside' : ''}${key === today ? ' today' : ''}${[0, 6].includes(day.getDay()) ? ' weekend' : ''}` },
      h('div', { class: 'cal-day-head' },
        isWeek ? h('span', { class: 'cal-weekday-inline' }, WEEKDAYS[day.getDay()]) : null,
        h('span', { class: 'cal-day-num' }, String(day.getDate())),
        items.length ? h('span', { class: 'cal-day-count' }, String(items.length)) : null),
      list,
      items.length > visible.length ? h('button', { class: 'cal-more', onclick: (e) => showDay(e.currentTarget, day, items) }, `+ ${items.length - visible.length} mais`) : null));
  }

  const undated = h('div', { class: 'cal-day-cards undated', dataset: { date: '' } }, cal.data.undated.map((c) => chip(c, null)));
  const canDrop = canEdit() && cal.prefs.date_source !== 'created_at';
  clear(root,
    h('div', { class: 'cal-toolbar' },
      h('div', { class: 'cal-nav' },
        h('button', { class: 'icon-btn square', title: 'Anterior', onclick: () => move(-1) }, icon('collapse', 16)),
        h('button', { class: 'btn small', onclick: () => { cal.anchor = startOfDay(new Date()); loadCalendar(); } }, 'Hoje'),
        h('button', { class: 'icon-btn square', title: 'Próximo', onclick: () => move(1) }, icon('expand', 16)),
        h('h2', { class: 'cal-title' }, title)),
      h('div', { class: 'cal-options' },
        segmented([['month', 'Mês'], ['week', 'Semana']], cal.prefs.mode, async (mode) => { await savePrefs({ mode }); loadCalendar(); }),
        h('label', { class: 'cal-source', title: 'Qual data do card posiciona ele no calendário' }, icon('calendar', 15), dateSourceSelect()),
        h('button', { class: 'btn small', onclick: (e) => displayMenu(e.currentTarget) }, icon('settings', 15), 'Exibir'))),
    h('div', { class: 'cal-body' },
      grid,
      h('aside', { class: 'cal-side' },
        h('h3', {}, `Sem ${dateLabel().toLowerCase()}`, h('span', { class: 'cal-day-count' }, String(cal.data.undated_total))),
        canDrop ? h('p', { class: 'muted small' }, 'Arraste um card para um dia para definir a data.') : null,
        undated,
        cal.data.undated_total > cal.data.undated.length ? h('p', { class: 'muted small' }, `Mostrando os ${cal.data.undated.length} mais recentes.`) : null)));

  setupDrag(root, canDrop);
}

function weekTitle(start) {
  const end = addDays(start, 6);
  const f = (d, opts) => d.toLocaleDateString('pt-BR', opts);
  return start.getMonth() === end.getMonth()
    ? `${start.getDate()} – ${f(end, { day: 'numeric', month: 'long', year: 'numeric' })}`
    : `${f(start, { day: 'numeric', month: 'short' })} – ${f(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function move(dir) {
  if (cal.prefs.mode === 'week') cal.anchor = addDays(cal.anchor, dir * 7);
  else cal.anchor = new Date(cal.anchor.getFullYear(), cal.anchor.getMonth() + dir, 1);
  loadCalendar();
}

function segmented(options, value, onChange) {
  return h('div', { class: 'segmented' }, options.map(([v, label]) =>
    h('button', { class: v === value ? 'active' : '', onclick: () => v !== value && onChange(v) }, label)));
}

function dateSourceSelect() {
  const dateFields = state.fields.filter((f) => f.type === 'date' || f.type === 'datetime');
  return h('select', { onchange: async (e) => { await savePrefs({ date_source: e.target.value }); loadCalendar(); } },
    h('option', { value: 'due_date', selected: cal.prefs.date_source === 'due_date' }, 'Prazo de entrega'),
    h('option', { value: 'created_at', selected: cal.prefs.date_source === 'created_at' }, 'Data de criação'),
    dateFields.map((f) => h('option', { value: `field:${f.id}`, selected: cal.prefs.date_source === `field:${f.id}` }, f.name)));
}

/** Escolha do que aparece em cada card do calendário */
function displayMenu(anchor) {
  const show = new Set(cal.prefs.show);
  const options = [
    ['title', 'Título'], ['time', 'Horário'], ['column', 'Etapa (coluna)'], ['labels', 'Etiquetas'],
    ['members', 'Responsáveis'], ['cover', 'Imagem de capa'],
    ...state.fields.map((f) => [`field:${f.id}`, f.name]),
  ];
  const toggle = async (key, on) => {
    on ? show.add(key) : show.delete(key);
    await savePrefs({ show: options.map(([k]) => k).filter((k) => show.has(k)) });
    render();
  };
  popover(anchor, h('div', { class: 'menu' },
    h('div', { class: 'menu-title' }, 'Mostrar nos cards'),
    options.slice(0, 6).map(([k, label]) => checkRow(k, label, show.has(k), toggle)),
    state.fields.length ? h('div', { class: 'menu-title' }, 'Campos') : null,
    options.slice(6).map(([k, label]) => checkRow(k, label, show.has(k), toggle)),
    h('div', { class: 'menu-title' }, 'Cor do card no calendário'),
    h('select', { onchange: async (e) => { await savePrefs({ color_by: e.target.value }); render(); } },
      [['card', 'Cor do card (ou da coluna)'], ['column', 'Cor da coluna'], ['label', 'Cor da 1ª etiqueta']]
        .map(([v, l]) => h('option', { value: v, selected: cal.prefs.color_by === v }, l)))), { width: 270 });
}

function checkRow(key, label, checked, onToggle) {
  return h('label', { class: 'check menu-check' }, h('input', { type: 'checkbox', checked, onchange: (e) => onToggle(key, e.target.checked) }), label);
}

// ---------------- Card compacto ----------------
function chipColor(card) {
  const col = columnById(card.column_id);
  if (cal.prefs.color_by === 'column') return col?.color;
  if (cal.prefs.color_by === 'label') return labelById(card.labels[0])?.color || col?.color;
  return card.color || col?.color;
}

function chip(card, time) {
  const show = new Set(cal.prefs.show);
  const bg = chipColor(card) || '#eef1f8';
  const col = columnById(card.column_id);
  const done = !!card.cycle_ended_at;
  const overdue = cal.prefs.date_source === 'due_date' && !done && card.due_date && Date.parse(card.due_date) < Date.now();
  const fields = state.fields.filter((f) => show.has(`field:${f.id}`) && card.fields[f.id] != null && card.fields[f.id] !== '');
  const labels = card.labels.map(labelById).filter(Boolean);
  const members = card.members.map(userById).filter(Boolean);
  const hl = card.highlights || [];
  const style = { background: bg, color: textColorFor(bg) || '#2a2540' };
  if (hl.length) style['--hl-ring'] = highlightRing(hl);
  return h('div', {
    class: `cal-chip${done ? ' done' : ''}${overdue ? ' overdue' : ''}${hl.length ? ' highlighted' : ''}`, dataset: { cardId: card.id }, tabIndex: 0,
    style,
    title: `${card.title}${col ? ` · ${col.name}` : ''}`,
    onclick: () => openCard(card.id),
    onkeydown: (e) => { if (e.key === 'Enter') openCard(card.id); },
  },
  show.has('cover') && card.cover ? h('img', { class: 'cal-chip-cover', src: card.cover, alt: '', loading: 'lazy', decoding: 'async', draggable: false }) : null,
  h('div', { class: 'cal-chip-line' },
    show.has('time') && time ? h('span', { class: 'cal-chip-time' }, time) : null,
    show.has('title') || (!fields.length && !show.has('column')) ? h('span', { class: 'cal-chip-title' }, card.title) : null,
    done ? h('span', { class: 'cal-chip-flag', title: 'Produção concluída' }, '✓') : null),
  show.has('column') && col ? h('div', { class: 'cal-chip-sub' }, h('span', { class: 'cal-dot', style: { background: col.color } }), col.name) : null,
  show.has('labels') && labels.length ? h('div', { class: 'cal-chip-labels' }, labels.map((l) => h('span', { class: 'cal-label', title: l.name, style: { background: l.color, color: textColorFor(l.color) } }, l.name))) : null,
  fields.map((f) => h('div', { class: 'cal-chip-sub' }, h('span', { class: 'muted-inherit' }, `${f.name}: `), fieldText(f, card.fields[f.id]))),
  show.has('members') && members.length ? h('div', { class: 'cal-chip-members' }, members.map((u) => avatar(u, 18))) : null);
}

function showDay(anchor, day, items) {
  popover(anchor, h('div', { class: 'menu cal-day-pop' },
    h('div', { class: 'menu-title' }, day.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })),
    items.map((it) => chip(it.card, it.time))), { width: 300 });
}

// ---------------- Arrastar para mudar a data ----------------
function setupDrag(root, enabled) {
  cal.sortables.forEach((s) => s.destroy());
  cal.sortables = [];
  if (!enabled) return;
  for (const list of $$('.cal-day-cards', root)) {
    cal.sortables.push(Sortable.create(list, {
      ...DRAG_OPTIONS,
      group: 'calendar', sort: false, draggable: '.cal-chip',
      ghostClass: 'card-ghost', dragClass: 'card-drag',
      scroll: true, bubbleScroll: true, scrollSensitivity: 80, scrollSpeed: 14,
      onStart: () => { state.dragging = true; document.body.classList.add('dragging'); },
      onEnd: async (evt) => {
        state.dragging = false;
        document.body.classList.remove('dragging');
        if (evt.from === evt.to) return;
        const id = Number(evt.item.dataset.cardId);
        const card = [...cal.data.cards, ...cal.data.undated].find((c) => c.id === id);
        const date = evt.to.dataset.date || null;
        markLocalEdit(id);
        const updated = await attempt(() => patch(`/cards/${id}`, datePatch(card, date)));
        if (!updated) return loadCalendar(); // deu erro: volta ao estado real
        toast(date ? `${dateLabel()} alterado` : `${dateLabel()} removido`, 'ok');
        // Atualiza só a memória local e redesenha o calendário, sem buscar tudo de novo
        const wasUndated = !evt.from.dataset.date;
        cal.data.cards = cal.data.cards.filter((c) => c.id !== id);
        cal.data.undated = cal.data.undated.filter((c) => c.id !== id);
        if (date) cal.data.cards.push(updated);
        else cal.data.undated.unshift(updated);
        cal.data.undated_total += (wasUndated ? -1 : 0) + (date ? 0 : 1);
        state.boardStale = true; // o quadro (oculto) é atualizado quando voltar para ele
        if (state.pendingReload) { state.pendingReload = false; reloadSoon(); } else render();
      },
    }));
  }
}

/** Monta a alteração do card mantendo o horário que ele já tinha */
function datePatch(card, key) {
  const src = cal.prefs.date_source;
  const f = sourceField();
  if (f?.type === 'date') return { fields: { [f.id]: key } };
  if (!key) return src === 'due_date' ? { due_date: null } : { fields: { [f.id]: null } };
  const old = cardDate(card) ? new Date(cardDate(card)) : null;
  const [y, m, d] = key.split('-').map(Number);
  const next = new Date(y, m - 1, d, old ? old.getHours() : 18, old ? old.getMinutes() : 0);
  return src === 'due_date' ? { due_date: next.toISOString() } : { fields: { [f.id]: next.toISOString() } };
}
