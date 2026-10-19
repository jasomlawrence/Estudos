// Quadro Kanban: colunas, cards, arrastar e soltar, rolagem infinita
import { h, $, $$, clear, textColorFor, fmtShortDate, fmtDuration, avatar, fieldText, colorPicker, icon, backgroundCss } from './util.js';
import { get, post, patch, del, attempt, popover, confirmDialog, toast } from './api.js';
import { state, canEdit, userById, labelById, columnById, markLocalEdit } from './state.js';
import { openCard } from './card.js';

/* global Sortable */

let sortables = [];

// Opções de arraste pensadas para toque (tablet/celular) e mouse:
// - forceFallback: o próprio Sortable desenha o card arrastado (mais fluido que o arraste nativo do navegador)
// - touchStartThreshold: pequenos tremores do dedo durante a espera não cancelam o arraste
export const DRAG_OPTIONS = {
  forceFallback: true,
  fallbackOnBody: true,
  fallbackTolerance: 3,
  delay: 160,
  delayOnTouchOnly: true,
  touchStartThreshold: 8,
  animation: 180,
  easing: 'cubic-bezier(.2, .8, .2, 1)',
  onChoose: () => navigator.vibrate?.(8), // leve vibração quando o card "gruda" no dedo (Android)
};
// Chamados depois de cada recarga do quadro (ex.: o calendário se atualiza junto)
export const boardLoadedHooks = [];

export async function loadBoard({ keepScroll = true } = {}) {
  if (!state.boardId) return;
  if (state.dragging) { state.pendingReload = true; return; }
  const loaded = Math.max(state.pageSize, ...state.columns.map((c) => c.cards?.length || 0));
  const params = new URLSearchParams({ limit: loaded });
  if (state.search) params.set('q', state.search);
  if (state.archived) params.set('archived', '1');
  const data = await get(`/boards/${state.boardId}?${params}`);
  Object.assign(state, { board: data.board, columns: data.columns, labels: data.labels, fields: data.fields, users: data.users, correiosEnabled: data.correios_enabled });
  state.boardStale = false;
  renderBoard(keepScroll);
  boardLoadedHooks.forEach((fn) => fn());
}

export const reloadSoon = (() => {
  let t;
  return () => { clearTimeout(t); t = setTimeout(() => loadBoard().catch(() => {}), 200); };
})();

function renderBoard(keepScroll) {
  const root = $('#board');
  const scrollLeft = keepScroll ? root.scrollLeft : 0;
  const colScroll = Object.fromEntries($$('.cards', root).map((el) => [el.dataset.columnId, el.scrollTop]));
  sortables.forEach((s) => s.destroy());
  sortables = [];
  document.documentElement.style.setProperty('--board-bg', backgroundCss(state.board.background));
  $('#board-name').value = state.board.name;

  const list = h('div', { class: 'board-columns' });
  for (const col of state.columns) list.append(columnElement(col));
  if (canEdit() && !state.archived) list.append(addColumnElement());
  clear(root, list);

  root.scrollLeft = scrollLeft;
  for (const el of $$('.cards', root)) el.scrollTop = colScroll[el.dataset.columnId] || 0;
  if (canEdit()) setupSortables(list);
  setupInfiniteScroll(root);
}

// ---------------- Colunas ----------------
function columnElement(col) {
  const fg = textColorFor(col.color) || '#2a2540';
  if (col.collapsed) {
    return h('div', { class: 'column collapsed', dataset: { columnId: col.id }, style: { background: col.color, color: fg }, title: 'Clique para expandir', onclick: () => toggleCollapse(col) },
      h('span', { class: 'collapsed-count' }, String(col.total)),
      h('span', { class: 'collapsed-name' }, col.name),
      h('span', { class: 'collapsed-icon' }, icon('expand', 16)));
  }
  const cards = h('div', { class: 'cards', dataset: { columnId: col.id } }, col.cards.map(cardElement));
  if (col.cards.length < col.total) cards.append(h('div', { class: 'sentinel', dataset: { columnId: col.id } }, 'Carregando…'));
  const cycle = cycleTag(col);
  return h('section', { class: 'column', dataset: { columnId: col.id }, style: { '--col': col.color, '--col-fg': fg } },
    h('header', { class: 'column-head' },
      h('span', { class: 'column-dot' }),
      h('input', {
        class: 'column-title', value: col.name, readOnly: !canEdit(), 'aria-label': 'Nome da coluna',
        onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
        onchange: (e) => attempt(() => patch(`/columns/${col.id}`, { name: e.target.value })),
      }),
      h('span', { class: 'count', title: 'Quantidade de cards' }, String(col.total)),
      cycle,
      h('button', { class: 'icon-btn', title: 'Minimizar coluna', onclick: () => toggleCollapse(col) }, icon('collapse', 16)),
      canEdit() ? h('button', { class: 'icon-btn', title: 'Mais opções', onclick: (e) => columnMenu(e.currentTarget, col) }, icon('more', 18)) : null),
    cards,
    canEdit() && !state.archived ? addCardElement(col) : null);
}

function cycleTag(col) {
  const cols = [...state.columns].sort((a, b) => a.position - b.position);
  const start = cols.find((c) => c.id === state.board.cycle_start_column_id) || cols[0];
  const end = cols.find((c) => c.id === state.board.cycle_end_column_id) || cols[cols.length - 1];
  if (col.id === start?.id) return h('span', { class: 'cycle-tag', title: 'O cronômetro de produção começa nesta coluna' }, icon('play', 11), 'início');
  if (col.id === end?.id) return h('span', { class: 'cycle-tag', title: 'O cronômetro de produção para nesta coluna' }, icon('flag', 11), 'fim');
  return null;
}

async function toggleCollapse(col) {
  col.collapsed = !col.collapsed;
  renderBoard(true);
  await attempt(() => patch(`/columns/${col.id}`, { collapsed: col.collapsed }));
}

function columnMenu(anchor, col) {
  const others = state.columns.filter((c) => c.id !== col.id);
  const pop = popover(anchor, h('div', { class: 'menu' },
    h('div', { class: 'menu-title' }, 'Cor da coluna'),
    colorPicker(col.color, (c) => { pop.close(); attempt(() => patch(`/columns/${col.id}`, { color: c || '#ebecf0' })).then(reloadSoon); }, { allowNone: true }),
    h('hr'),
    h('button', { class: 'menu-item', onclick: () => { pop.close(); toggleCollapse(col); } }, 'Minimizar coluna'),
    h('button', { class: 'menu-item', onclick: () => { pop.close(); $(`.column[data-column-id="${col.id}"] .add-card-btn`)?.click(); } }, 'Adicionar card'),
    others.length && col.total ? h('div', { class: 'menu-title' }, 'Mover todos os cards para…') : null,
    col.total ? others.map((o) => h('button', { class: 'menu-item indent', onclick: async () => {
      pop.close();
      if (!(await confirmDialog(`Mover os ${col.total} cards de "${col.name}" para "${o.name}"?`, { ok: 'Mover', danger: false }))) return;
      const all = await get(`/columns/${col.id}/cards?offset=0&limit=200`);
      for (const c of all) await post(`/cards/${c.id}/move`, { columnId: o.id });
      reloadSoon();
    } }, o.name)) : null,
    h('hr'),
    h('button', { class: 'menu-item danger', onclick: async () => {
      pop.close();
      if (col.total) {
        const target = others[0];
        if (!target) return toast('Não é possível excluir a única coluna com cards.', 'error');
        const choice = await chooseColumn(`A coluna "${col.name}" tem ${col.total} card(s). Para onde movê-los antes de excluir?`, others);
        if (!choice) return;
        await attempt(() => del(`/columns/${col.id}?moveTo=${choice}`), 'Coluna excluída');
      } else {
        if (!(await confirmDialog(`Excluir a coluna "${col.name}"?`))) return;
        await attempt(() => del(`/columns/${col.id}`), 'Coluna excluída');
      }
      reloadSoon();
    } }, 'Excluir coluna')));
}

function chooseColumn(message, columns) {
  return new Promise((resolve) => {
    const sel = h('select', {}, columns.map((c) => h('option', { value: c.id }, c.name)));
    const pop = h('div', { class: 'modal-overlay' }, h('div', { class: 'modal' },
      h('div', { class: 'modal-body' }, h('p', {}, message), sel,
        h('div', { class: 'row end' },
          h('button', { class: 'btn', onclick: () => { pop.remove(); resolve(null); } }, 'Cancelar'),
          h('button', { class: 'btn danger', onclick: () => { pop.remove(); resolve(Number(sel.value)); } }, 'Mover e excluir')))));
    document.body.append(pop);
  });
}

function addColumnElement() {
  const wrap = h('div', { class: 'add-column' });
  const showForm = () => {
    const input = h('input', { placeholder: 'Nome da coluna', maxLength: 80 });
    const submit = async () => {
      if (!input.value.trim()) return;
      await attempt(() => post(`/boards/${state.boardId}/columns`, { name: input.value.trim() }));
      await loadBoard();
      $('#board').scrollLeft = $('#board').scrollWidth;
      $('.add-column button')?.click();
    };
    clear(wrap, input, h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: submit }, 'Adicionar coluna'),
      h('button', { class: 'icon-btn', title: 'Cancelar', onclick: () => clear(wrap, button) }, icon('x'))));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') clear(wrap, button); });
    input.focus();
  };
  const button = h('button', { class: 'add-column-btn', onclick: showForm }, icon('plus', 16), 'Adicionar coluna');
  wrap.append(button);
  return wrap;
}

function addCardElement(col) {
  const wrap = h('div', { class: 'add-card' });
  const button = h('button', { class: 'add-card-btn', onclick: () => showForm() }, icon('plus', 16), 'Adicionar card');
  const showForm = () => {
    const input = h('textarea', { placeholder: 'Título do card (Enter para salvar)', rows: 2 });
    const submit = async () => {
      const title = input.value.trim();
      if (!title) return;
      input.value = '';
      await attempt(() => post(`/columns/${col.id}/cards`, { title }));
      await loadBoard();
      const list = $(`.cards[data-column-id="${col.id}"]`);
      if (list) list.scrollTop = list.scrollHeight;
      $(`.column[data-column-id="${col.id}"] .add-card-btn`)?.click();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === 'Escape') clear(wrap, button);
    });
    clear(wrap, input, h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: submit }, 'Adicionar'),
      h('button', { class: 'icon-btn', title: 'Cancelar', onclick: () => clear(wrap, button) }, icon('x'))));
    input.focus();
  };
  wrap.append(button);
  return wrap;
}

// ---------------- Cards ----------------
export function cardElement(card) {
  const fg = card.color ? textColorFor(card.color) : null;
  const visibleFields = state.fields.filter((f) => f.show_on_card && card.fields[f.id] !== undefined && card.fields[f.id] !== null);
  const due = dueBadge(card);
  const timer = card.cycle_started_at ? h('span', { class: `badge ${card.cycle_ended_at ? 'done' : ''}`, title: card.cycle_ended_at ? 'Tempo total de produção' : 'Em produção há' },
    icon('clock', 13), fmtDuration(Date.parse(card.cycle_ended_at || new Date().toISOString()) - Date.parse(card.cycle_started_at))) : null;
  const hl = card.highlights || [];
  const style = card.color ? { background: card.color, color: fg, '--card-fg': fg } : {};
  if (hl.length) style['--hl-ring'] = highlightRing(hl);
  return h('article', {
    class: `card${card.color ? ' colored' : ''}${hl.length ? ' highlighted' : ''}`, dataset: { cardId: card.id }, tabIndex: 0, style,
    title: hl.length ? `Automação: ${hl.map((x) => x.name).join(', ')}` : undefined,
    onclick: () => openCard(card.id),
    onkeydown: (e) => { if (e.key === 'Enter') openCard(card.id); },
  },
  card.cover ? h('img', { class: 'card-cover', src: card.cover, alt: '', loading: 'lazy', decoding: 'async', draggable: false }) : null,
  h('div', { class: 'card-body' },
    hl.some((x) => x.text) ? h('div', { class: 'card-alerts' }, hl.filter((x) => x.text).map((x) => h('span', { class: 'card-alert', style: { '--hl': x.color } }, x.text))) : null,
    card.labels.length ? h('div', { class: 'card-labels' }, card.labels.map(labelById).filter(Boolean).map((l) => h('span', { class: 'label', style: { background: l.color, color: textColorFor(l.color) }, title: l.name }, l.name))) : null,
    h('div', { class: 'card-title' }, card.title),
    visibleFields.length ? h('dl', { class: 'card-fields' }, visibleFields.map((f) => [h('dt', {}, f.name), h('dd', {}, fieldChip(f, card.fields[f.id]))])) : null,
    h('div', { class: 'card-badges' },
      due, timer,
      card.source === 'shopify' ? h('span', { class: 'badge shopify', title: 'Pedido do Shopify' }, icon('bag', 13)) : null,
      card.description ? h('span', { class: 'badge', title: 'Tem descrição' }, icon('text', 13)) : null,
      card.attachment_count ? h('span', { class: 'badge', title: 'Anexos' }, icon('clip', 13), String(card.attachment_count)) : null,
      card.members.length ? h('span', { class: 'card-members' }, card.members.map(userById).filter(Boolean).map((u) => avatar(u, 22))) : null)));
}

/** Borda colorida por dentro do card: um anel por automação que ele atende (até 3) */
export function highlightRing(list) {
  return list.slice(0, 3).map((x, i) => `inset 0 0 0 ${3 * (i + 1)}px ${x.color}`).join(', ');
}

function fieldChip(def, value) {
  if (def.type === 'select') {
    const o = def.options.find((x) => x.id === value);
    return o ? h('span', { class: 'chip', style: { background: o.color, color: textColorFor(o.color) } }, o.label) : '';
  }
  return fieldText(def, value);
}

export function dueBadge(card) {
  if (!card.due_date) return null;
  const diff = Date.parse(card.due_date) - Date.now();
  let cls = '';
  let title = 'Prazo de entrega';
  if (card.cycle_ended_at) { cls = 'done'; title = 'Concluído'; }
  else if (diff < 0) { cls = 'overdue'; title = 'Prazo vencido'; }
  else if (diff < 2 * 864e5) { cls = 'soon'; title = 'Prazo próximo'; }
  return h('span', { class: `badge due ${cls}`, title }, icon('calendar', 13), fmtShortDate(card.due_date));
}

// ---------------- Arrastar e soltar ----------------
function setupSortables(list) {
  sortables.push(Sortable.create(list, {
    ...DRAG_OPTIONS,
    handle: '.column-head',
    draggable: '.column',
    filter: 'input,button',
    preventOnFilter: false,
    onStart: () => { state.dragging = true; document.body.classList.add('dragging'); },
    onEnd: async (evt) => {
      state.dragging = false;
      document.body.classList.remove('dragging');
      if (evt.oldIndex !== evt.newIndex) {
        const id = evt.item.dataset.columnId;
        const prevId = evt.item.previousElementSibling?.dataset.columnId;
        const nextId = evt.item.nextElementSibling?.dataset.columnId;
        await attempt(() => patch(`/columns/${id}`, { prevId: prevId ? Number(prevId) : null, nextId: nextId ? Number(nextId) : null }));
      }
      afterDrag();
    },
  }));
  for (const el of $$('.cards', list)) {
    sortables.push(Sortable.create(el, {
      ...DRAG_OPTIONS,
      group: 'cards',
      draggable: '.card',
      filter: '.sentinel',
      ghostClass: 'card-ghost',
      chosenClass: 'card-chosen',
      dragClass: 'card-drag',
      scroll: true, bubbleScroll: true, scrollSensitivity: 80, scrollSpeed: 14,
      onStart: () => { state.dragging = true; document.body.classList.add('dragging'); },
      onEnd: async (evt) => {
        state.dragging = false;
        document.body.classList.remove('dragging');
        const id = Number(evt.item.dataset.cardId);
        const columnId = Number(evt.to.dataset.columnId);
        if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return afterDrag();
        const prevId = evt.item.previousElementSibling?.dataset.cardId;
        const nextEl = evt.item.nextElementSibling;
        const nextId = nextEl?.classList.contains('card') ? nextEl.dataset.cardId : null;
        // Atualiza o estado local imediatamente (sensação de rapidez)
        const fromCol = columnById(Number(evt.from.dataset.columnId));
        const toCol = columnById(columnId);
        const card = fromCol.cards.find((c) => c.id === id);
        if (fromCol !== toCol) { fromCol.total--; toCol.total++; }
        fromCol.cards = fromCol.cards.filter((c) => c.id !== id);
        toCol.cards.splice(Math.min(evt.newIndex, toCol.cards.length), 0, { ...card, column_id: columnId });
        updateCounts();
        markLocalEdit(id);
        const updated = await attempt(() => post(`/cards/${id}/move`, { columnId, prevId: prevId ? Number(prevId) : null, nextId: nextId ? Number(nextId) : null }));
        if (updated) {
          // Troca só o card movido (cronômetro, prazo concluído…) em vez de redesenhar o quadro
          const idx = toCol.cards.findIndex((c) => c.id === id);
          if (idx >= 0) toCol.cards[idx] = updated;
          if (evt.item.isConnected) evt.item.replaceWith(cardElement(updated));
        } else state.pendingReload = true; // deu erro: recarrega para mostrar o estado real
        afterDrag();
      },
    }));
  }
}

function updateCounts() {
  for (const col of state.columns) {
    const el = $(`.column[data-column-id="${col.id}"] .count`);
    if (el) el.textContent = String(col.total);
  }
}

function afterDrag() {
  if (state.pendingReload) { state.pendingReload = false; reloadSoon(); }
}

// ---------------- Rolagem infinita ----------------
let observer;
function setupInfiniteScroll(root) {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) loadMore(Number(e.target.dataset.columnId), e.target);
  }, { root: null, rootMargin: '300px' });
  $$('.sentinel', root).forEach((s) => observer.observe(s));
}

const loadingCols = new Set();
async function loadMore(columnId, sentinel) {
  if (loadingCols.has(columnId)) return;
  const col = columnById(columnId);
  if (!col || col.cards.length >= col.total) return sentinel.remove();
  loadingCols.add(columnId);
  try {
    const params = new URLSearchParams({ offset: col.cards.length, limit: state.pageSize });
    if (state.search) params.set('q', state.search);
    if (state.archived) params.set('archived', '1');
    const more = await get(`/columns/${columnId}/cards?${params}`);
    const fresh = more.filter((c) => !col.cards.some((x) => x.id === c.id));
    col.cards.push(...fresh);
    for (const c of fresh) sentinel.before(cardElement(c));
    if (col.cards.length >= col.total || !more.length) { observer.unobserve(sentinel); sentinel.remove(); }
  } finally {
    loadingCols.delete(columnId);
  }
}

// ---------------- Rolagem horizontal arrastando o fundo (como no Trello) ----------------
export function enableDragScroll(board) {
  let startX = 0;
  let startLeft = 0;
  let active = false;
  board.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !(e.target === board || e.target.classList.contains('board-columns'))) return;
    active = true; startX = e.pageX; startLeft = board.scrollLeft;
    board.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => { if (active) board.scrollLeft = startLeft - (e.pageX - startX); });
  window.addEventListener('mouseup', () => { active = false; board.classList.remove('grabbing'); });
  // Roda do mouse sobre o fundo do quadro rola na horizontal
  board.addEventListener('wheel', (e) => {
    if (e.target.closest('.cards') || e.deltaX) return;
    board.scrollLeft += e.deltaY;
  }, { passive: true });
}
