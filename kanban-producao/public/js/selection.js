// Seleção de vários cards: imprimir etiquetas e ações em lote (mover, etiqueta, responsável, arquivar)
import { h, $, $$, clear, icon, textColorFor, avatar } from './util.js';
import { get, post, attempt, popover, confirmDialog, toast } from './api.js';
import { state, canEdit } from './state.js';
import { loadBoard, renderBoard } from './board.js';
import { openPrint } from './print.js';

// id do card → id da coluna (para saber se a coluna inteira está marcada)
state.selected = new Map();
state.selecting = false;

export function setSelecting(on) {
  state.selecting = on;
  if (!on) state.selected.clear();
  document.body.classList.toggle('selecting', on);
  $('#select-btn')?.classList.toggle('active', on);
  renderBoard(true);
  updateBar();
}

export const isSelected = (id) => state.selected.has(id);

export function toggleCard(card) {
  if (state.selected.has(card.id)) state.selected.delete(card.id);
  else state.selected.set(card.id, card.column_id);
  $(`.card[data-card-id="${card.id}"]`)?.classList.toggle('selected', state.selected.has(card.id));
  updateColumnChecks();
  updateBar();
}

const selectedIn = (colId) => [...state.selected.values()].filter((c) => c === colId).length;
export const columnFullySelected = (col) => col.total > 0 && selectedIn(col.id) >= col.total;

/** Marca ou desmarca todos os cards da coluna (inclusive os que ainda não apareceram na rolagem) */
export async function toggleColumn(col) {
  if (columnFullySelected(col)) {
    for (const [id, c] of state.selected) if (c === col.id) state.selected.delete(id);
  } else {
    const params = new URLSearchParams();
    if (state.search) params.set('q', state.search);
    if (state.archived) params.set('archived', '1');
    const ids = await attempt(() => get(`/columns/${col.id}/card-ids?${params}`));
    if (!ids) return;
    for (const id of ids) state.selected.set(id, col.id);
  }
  for (const el of $$(`.cards[data-column-id="${col.id}"] .card`)) el.classList.toggle('selected', state.selected.has(Number(el.dataset.cardId)));
  updateColumnChecks();
  updateBar();
}

function updateColumnChecks() {
  for (const col of state.columns) {
    const btn = $(`.column[data-column-id="${col.id}"] .col-select`);
    if (!btn) continue;
    const n = selectedIn(col.id);
    btn.classList.toggle('on', columnFullySelected(col));
    btn.classList.toggle('partial', n > 0 && !columnFullySelected(col));
  }
}

async function bulk(action, value, message) {
  const ids = [...state.selected.keys()];
  const r = await attempt(() => post('/cards/bulk', { ids, action, value }));
  if (!r) return;
  toast(`${message}: ${r.updated} card(s)`, 'ok');
  // Os cards movidos continuam selecionados, agora na coluna nova
  if (action === 'move') for (const id of ids) state.selected.set(id, Number(value));
  if (action === 'archive') state.selected.clear();
  await loadBoard();
  updateBar();
}

function chooser(anchor, title, items, onpick, { modes } = {}) {
  let mode = modes?.[0][0];
  const seg = modes ? h('div', { class: 'segmented small' }, modes.map(([v, l]) => h('button', { class: v === mode ? 'active' : '', onclick: (e) => {
    mode = v; for (const b of seg.children) b.classList.toggle('active', b === e.currentTarget);
  } }, l))) : null;
  const pop = popover(anchor, h('div', { class: 'menu' },
    h('div', { class: 'menu-title' }, title), seg,
    items.length ? items.map((it) => h('button', { class: 'menu-item', onclick: () => { pop.close(); onpick(it.value, mode); } }, it.content)) : h('p', { class: 'muted small' }, 'Nada para escolher.')), { width: 260 });
}

function updateBar() {
  let bar = $('#select-bar');
  if (!state.selecting) { bar?.remove(); return; }
  if (!bar) { bar = h('div', { id: 'select-bar', class: 'select-bar', role: 'toolbar', 'aria-label': 'Cards selecionados' }); document.body.append(bar); }
  const n = state.selected.size;
  const none = n === 0;
  const btn = (iconName, label, onclick, extra = {}) => h('button', { class: `btn small${extra.primary ? ' primary' : ''}`, title: label, 'aria-label': label, disabled: none && !extra.always, onclick }, icon(iconName, 15), h('span', { class: 'lbl' }, label));
  const editing = canEdit();
  clear(bar,
    h('strong', { class: 'select-count' }, none ? 'Toque nos cards para selecionar' : `${n} selecionado${n > 1 ? 's' : ''}`),
    h('div', { class: 'select-actions' },
      btn('printer', 'Imprimir etiquetas', () => openPrint([...state.selected.keys()]), { primary: true }),
      editing ? [
        btn('move', 'Mover', (e) => chooser(e.currentTarget, 'Mover para a coluna', state.columns.map((c) => ({ value: c.id, content: [h('span', { class: 'dot', style: { background: c.color } }), c.name] })),
          (v) => bulk('move', v, 'Movidos'))),
        btn('tag', 'Etiqueta', (e) => chooser(e.currentTarget, 'Etiqueta', state.labels.map((l) => ({ value: l.id, content: h('span', { class: 'label', style: { background: l.color, color: textColorFor(l.color) } }, l.name || ' ') })),
          (v, mode) => bulk(mode, v, mode === 'add_label' ? 'Etiqueta adicionada' : 'Etiqueta removida'), { modes: [['add_label', 'Adicionar'], ['remove_label', 'Remover']] })),
        btn('user', 'Responsável', (e) => chooser(e.currentTarget, 'Responsável', state.users.map((u) => ({ value: u.id, content: [avatar(u, 22), u.name] })),
          (v, mode) => bulk(mode, v, mode === 'add_member' ? 'Responsável adicionado' : 'Responsável removido'), { modes: [['add_member', 'Adicionar'], ['remove_member', 'Remover']] })),
        btn('archive', state.archived ? 'Restaurar' : 'Arquivar', async () => {
          const action = state.archived ? 'unarchive' : 'archive';
          if (action === 'archive' && !(await confirmDialog(`Arquivar ${n} card(s)?`, { ok: 'Arquivar' }))) return;
          bulk(action, null, action === 'archive' ? 'Arquivados' : 'Restaurados');
        }),
      ] : null,
      none ? null : h('button', { class: 'btn small subtle', onclick: () => { state.selected.clear(); $$('.card.selected').forEach((el) => el.classList.remove('selected')); updateColumnChecks(); updateBar(); } }, 'Limpar'),
      h('button', { class: 'icon-btn', title: 'Sair da seleção (Esc)', onclick: () => setSelecting(false) }, icon('x', 18))));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selecting && !document.querySelector('.modal-overlay, .popover')) setSelecting(false);
});
