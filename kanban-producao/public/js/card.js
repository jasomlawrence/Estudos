// Janela de detalhes do card: campos personalizados, anexos/capa, cor, etiquetas, histórico, tempo de produção
import { h, $, clear, textColorFor, fmtDateTime, fmtDuration, avatar, toLocalInput, colorPicker, PALETTE, copyText, icon } from './util.js';
import { get, post, patch, del, api, attempt, modal, popover, confirmDialog, toast } from './api.js';
import { state, canEdit, userById, labelById } from './state.js';
import { activityItem } from './activity.js';
import { reloadSoon } from './board.js';

let current = null; // { card, modal }

export async function openCard(id) {
  const card = await attempt(() => get(`/cards/${id}`));
  if (!card) return;
  current?.modal.close();
  const m = modal({ wide: true, className: 'card-modal', onClose: () => { if (current?.modal === m) current = null; state.openCardId = null; history.replaceState(null, '', location.pathname); } });
  current = { card, modal: m };
  state.openCardId = id;
  history.replaceState(null, '', `#card=${id}`);
  m.el.addEventListener('paste', onPaste);
  render();
}

/** Atualiza a janela se outra pessoa alterou o card (sem atrapalhar quem está digitando) */
export async function refreshOpenCard(cardIds = []) {
  if (!current || (cardIds.length && !cardIds.includes(current.card.id))) return;
  const active = document.activeElement;
  if (active && current.modal.el.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName)) return;
  const card = await get(`/cards/${current.card.id}`).catch(() => null);
  if (!card) { current.modal.close(); return; }
  current.card = card;
  render();
}

async function save(patchBody) {
  const card = await attempt(() => patch(`/cards/${current.card.id}`, patchBody));
  if (card && current) { current.card = card; render(); reloadSoon(); }
  return card;
}

function render() {
  const { card, modal: m } = current;
  const scroll = m.body.scrollTop;
  const focusKey = document.activeElement?.dataset?.key;
  const editable = canEdit();
  const col = state.columns.find((c) => c.id === card.column_id);
  $('.modal-head h2', m.el).textContent = '';

  const cover = card.cover ? h('div', { class: 'modal-cover', style: { backgroundImage: `url("${card.cover}")` } },
    editable ? h('button', { class: 'btn small', onclick: () => save({ cover_attachment_id: null }) }, 'Remover capa') : null) : null;

  const title = h('textarea', {
    class: 'card-title-input', rows: 1, value: card.title, readOnly: !editable, dataset: { key: 'title' },
    oninput: (e) => autosize(e.target),
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
    onchange: (e) => save({ title: e.target.value }),
  });

  const columnSelect = h('select', {
    disabled: !editable, dataset: { key: 'column' },
    onchange: async (e) => {
      await attempt(() => post(`/cards/${card.id}/move`, { columnId: Number(e.target.value) }));
      current.card = await get(`/cards/${card.id}`); render(); reloadSoon();
    },
  }, state.columns.map((c) => h('option', { value: c.id, selected: c.id === card.column_id }, c.name)));

  const body = h('div', { class: 'card-detail', style: card.color ? { '--card-accent': card.color } : {} },
    cover,
    card.color ? h('div', { class: 'color-strip', style: { background: card.color } }) : null,
    h('div', { class: 'card-detail-head' },
      title,
      h('div', { class: 'muted' }, 'na coluna ', columnSelect,
        card.source === 'shopify' ? h('span', { class: 'chip shopify' }, icon('bag', 12), ' Pedido Shopify') : null,
        card.archived ? h('span', { class: 'chip warn' }, 'Arquivado') : null)),
    h('div', { class: 'card-detail-grid' },
      h('div', { class: 'card-main' },
        metaRow(card, editable),
        fieldsSection(card, editable),
        h('section', {},
          h('h3', {}, 'Descrição'),
          h('textarea', { class: 'description', rows: 4, placeholder: 'Detalhes, observações da produção…', value: card.description, readOnly: !editable, dataset: { key: 'description' }, onchange: (e) => save({ description: e.target.value }) })),
        attachmentsSection(card, editable),
        productionSection(card),
        h('section', {},
          h('h3', {}, 'Histórico de alterações'),
          card.activity.length ? h('ul', { class: 'activity' }, card.activity.map((a) => activityItem(a))) : h('p', { class: 'muted' }, 'Sem registros.'))),
      sidebar(card, editable, col)));

  clear(m.body, body);
  autosize(title);
  m.body.scrollTop = scroll;
  if (focusKey) m.body.querySelector(`[data-key="${focusKey}"]`)?.focus();
}

function autosize(el) {
  requestAnimationFrame(() => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; });
}

// ---------- Etiquetas, responsáveis, prazo, cor ----------
function metaRow(card, editable) {
  const labels = card.labels.map(labelById).filter(Boolean);
  const members = card.members.map(userById).filter(Boolean);
  return h('div', { class: 'meta-row' },
    h('div', { class: 'meta' }, h('h4', {}, 'Etiquetas'),
      h('div', { class: 'row wrap' },
        labels.map((l) => h('span', { class: 'label big', style: { background: l.color, color: textColorFor(l.color) } }, l.name || ' ')),
        editable ? h('button', { class: 'icon-btn square', title: 'Etiquetas', onclick: (e) => labelPicker(e.currentTarget, card) }, '+') : null)),
    h('div', { class: 'meta' }, h('h4', {}, 'Responsáveis'),
      h('div', { class: 'row wrap' },
        members.map((u) => avatar(u, 30)),
        editable ? h('button', { class: 'icon-btn square', title: 'Responsáveis', onclick: (e) => memberPicker(e.currentTarget, card) }, '+') : null)),
    h('div', { class: 'meta' }, h('h4', {}, 'Prazo de entrega'),
      h('div', { class: 'row' },
        h('input', { type: 'datetime-local', value: toLocalInput(card.due_date), readOnly: !editable, dataset: { key: 'due' }, onchange: (e) => save({ due_date: e.target.value ? new Date(e.target.value).toISOString() : null }) }),
        card.due_date && editable ? h('button', { class: 'icon-btn', title: 'Remover prazo', onclick: () => save({ due_date: null }) }, icon('x')) : null)),
    h('div', { class: 'meta' }, h('h4', {}, 'Cor do card'),
      h('button', { class: 'swatch big', disabled: !editable, style: { background: card.color || 'transparent' }, title: 'Mudar cor', onclick: (e) => {
        const pop = popover(e.currentTarget, h('div', {}, h('div', { class: 'menu-title' }, 'Cor do card'), colorPicker(card.color, (c) => { pop.close(); save({ color: c }); })));
      } }, card.color ? '' : '∅')));
}

function labelPicker(anchor, card) {
  const content = h('div', { class: 'menu' });
  const draw = () => {
    clear(content,
      h('div', { class: 'menu-title' }, 'Etiquetas'),
      state.labels.map((l) => {
        const on = current.card.labels.includes(l.id);
        return h('div', { class: 'label-option' },
          h('button', { class: `label big grow${on ? ' on' : ''}`, style: { background: l.color, color: textColorFor(l.color) }, onclick: async () => {
            const next = on ? current.card.labels.filter((x) => x !== l.id) : [...current.card.labels, l.id];
            await save({ labels: next }); draw();
          } }, l.name || ' ', on ? ' ✓' : ''),
          h('button', { class: 'icon-btn', title: 'Editar etiqueta', onclick: () => editLabel(l) }, '✎'));
      }),
      h('hr'),
      h('button', { class: 'btn small', onclick: () => editLabel(null) }, '+ Criar etiqueta'));
  };
  const editLabel = (label) => {
    let color = label?.color || PALETTE[10];
    const name = h('input', { value: label?.name || '', placeholder: 'Nome da etiqueta' });
    const preview = h('span', { class: 'label big', style: { background: color, color: textColorFor(color) } }, label?.name || 'Prévia');
    name.oninput = () => { preview.textContent = name.value || 'Prévia'; };
    clear(content,
      h('div', { class: 'menu-title' }, label ? 'Editar etiqueta' : 'Nova etiqueta'),
      preview, name,
      colorPicker(color, (c) => { color = c || '#dfe1e6'; preview.style.background = color; preview.style.color = textColorFor(color); }, { allowNone: false }),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary small', onclick: async () => {
          if (label) await attempt(() => patch(`/labels/${label.id}`, { name: name.value, color }));
          else {
            const created = await attempt(() => post(`/boards/${state.boardId}/labels`, { name: name.value, color }));
            if (created) { state.labels.push(created); await save({ labels: [...current.card.labels, created.id] }); }
          }
          if (label) Object.assign(label, { name: name.value, color });
          reloadSoon(); draw(); render();
        } }, 'Salvar'),
        label ? h('button', { class: 'btn danger small', onclick: async () => {
          if (!(await confirmDialog(`Excluir a etiqueta "${label.name}" de todos os cards?`))) return;
          await attempt(() => del(`/labels/${label.id}`));
          state.labels = state.labels.filter((x) => x.id !== label.id);
          current.card.labels = current.card.labels.filter((x) => x !== label.id);
          reloadSoon(); draw(); render();
        } }, 'Excluir') : null,
        h('button', { class: 'btn small', onclick: draw }, 'Voltar')));
    name.focus();
  };
  draw();
  popover(anchor, content, { width: 300 });
}

function memberPicker(anchor, card) {
  const content = h('div', { class: 'menu' });
  const draw = () => clear(content, h('div', { class: 'menu-title' }, 'Responsáveis'),
    state.users.map((u) => {
      const on = current.card.members.includes(u.id);
      return h('button', { class: `menu-item${on ? ' on' : ''}`, onclick: async () => {
        await save({ members: on ? current.card.members.filter((x) => x !== u.id) : [...current.card.members, u.id] }); draw();
      } }, avatar(u, 24), ` ${u.name}`, on ? ' ✓' : '');
    }));
  draw();
  popover(anchor, content);
}

// ---------- Campos personalizados ----------
function fieldsSection(card, editable) {
  if (!state.fields.length) return h('section', {}, h('h3', {}, 'Campos'), h('p', { class: 'muted' }, 'Nenhum campo personalizado. Crie em Configurações → Campos.'));
  return h('section', {},
    h('h3', {}, 'Campos'),
    h('div', { class: 'fields-grid' }, state.fields.map((f) => h('label', { class: `field field-${f.type}` },
      h('span', { class: 'field-name' }, f.name),
      fieldInput(f, card.fields[f.id], editable, (value) => save({ fields: { [f.id]: value } }))))));
}

function fieldInput(def, value, editable, onSave) {
  const key = `field-${def.id}`;
  const common = { readOnly: !editable, disabled: !editable && ['checkbox', 'select'].includes(def.type), dataset: { key } };
  switch (def.type) {
    case 'textarea':
      return h('textarea', { ...common, rows: 3, value: value ?? '', onchange: (e) => onSave(e.target.value) });
    case 'number':
      return h('input', { ...common, type: 'number', step: 'any', value: value ?? '', onchange: (e) => onSave(e.target.value) });
    case 'currency':
      return h('div', { class: 'input-prefix' }, h('span', {}, 'R$'), h('input', { ...common, type: 'number', step: '0.01', value: value ?? '', onchange: (e) => onSave(e.target.value) }));
    case 'date':
      return h('input', { ...common, type: 'date', value: value ?? '', onchange: (e) => onSave(e.target.value) });
    case 'datetime':
      return h('input', { ...common, type: 'datetime-local', value: toLocalInput(value), onchange: (e) => onSave(e.target.value ? new Date(e.target.value).toISOString() : null) });
    case 'checkbox':
      return h('input', { ...common, type: 'checkbox', checked: !!value, onchange: (e) => onSave(e.target.checked) });
    case 'select':
      return h('select', { ...common, onchange: (e) => onSave(e.target.value || null) },
        h('option', { value: '' }, '—'), def.options.map((o) => h('option', { value: o.id, selected: o.id === value }, o.label)));
    case 'multiselect': {
      const selected = new Set(value || []);
      return h('div', { class: 'row wrap' }, def.options.map((o) => h('button', {
        type: 'button', class: `chip toggle${selected.has(o.id) ? ' on' : ''}`, disabled: !editable,
        style: selected.has(o.id) ? { background: o.color, color: textColorFor(o.color) } : {},
        onclick: (e) => { e.preventDefault(); selected.has(o.id) ? selected.delete(o.id) : selected.add(o.id); onSave([...selected]); },
      }, o.label)));
    }
    case 'url':
      return h('div', { class: 'row' }, h('input', { ...common, type: 'url', value: value ?? '', placeholder: 'https://', onchange: (e) => onSave(e.target.value) }),
        value ? h('a', { href: value, target: '_blank', rel: 'noopener', class: 'icon-btn', title: 'Abrir' }, '↗') : null);
    case 'email':
      return h('div', { class: 'row' }, h('input', { ...common, type: 'email', value: value ?? '', onchange: (e) => onSave(e.target.value) }),
        value ? h('a', { href: `mailto:${value}`, class: 'icon-btn', title: 'Enviar e-mail' }, '✉') : null);
    case 'phone': {
      const digits = String(value || '').replace(/\D/g, '');
      return h('div', { class: 'row' }, h('input', { ...common, type: 'tel', value: value ?? '', onchange: (e) => onSave(e.target.value) }),
        digits ? h('a', { href: `https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}`, target: '_blank', rel: 'noopener', class: 'icon-btn', title: 'Abrir WhatsApp' }, '💬') : null);
    }
    default:
      return h('input', { ...common, type: 'text', value: value ?? '', onchange: (e) => onSave(e.target.value) });
  }
}

// ---------- Anexos e capa ----------
async function upload(files) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const card = await attempt(() => api('POST', `/cards/${current.card.id}/attachments`, fd), `${files.length} arquivo(s) anexado(s)`);
  if (card) { current.card = card; render(); reloadSoon(); }
}

function onPaste(e) {
  if (!canEdit()) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); upload(files); }
}

function attachmentsSection(card, editable) {
  const input = h('input', { type: 'file', multiple: true, accept: 'image/*,application/pdf,.stl,.3dm,.obj,.zip', hidden: true, onchange: (e) => upload([...e.target.files]) });
  const drop = editable ? h('div', {
    class: 'dropzone',
    onclick: () => input.click(),
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
    ondragleave: (e) => e.currentTarget.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); upload([...e.dataTransfer.files]); },
  }, icon('clip', 18), h('span', {}, 'Arraste imagens aqui, clique para escolher ou cole (Ctrl+V)'), input) : null;
  return h('section', {},
    h('h3', {}, `Anexos (${card.attachments.length})`),
    drop,
    h('div', { class: 'attachments' }, card.attachments.map((a) => {
      const isCover = card.cover_attachment_id === a.id;
      return h('div', { class: `attachment${isCover ? ' is-cover' : ''}` },
        a.is_image
          ? h('a', { href: a.url, target: '_blank', rel: 'noopener', class: 'thumb', style: { backgroundImage: `url("${a.url}")` }, title: a.original_name })
          : h('a', { href: a.url, target: '_blank', rel: 'noopener', class: 'thumb file' }, (a.original_name.split('.').pop() || 'arquivo').toUpperCase()),
        h('div', { class: 'attachment-info' },
          h('strong', { title: a.original_name }, a.original_name),
          h('small', { class: 'muted' }, `${fmtDateTime(a.created_at)} · ${a.uploaded_by_name || ''}`),
          editable ? h('div', { class: 'row' },
            a.is_image ? h('button', { class: 'btn small', onclick: () => save({ cover_attachment_id: isCover ? null : a.id }) }, isCover ? 'Remover capa' : 'Usar como capa') : null,
            h('button', { class: 'btn small subtle', onclick: async () => {
              if (!(await confirmDialog(`Excluir o anexo "${a.original_name}"?`))) return;
              const c = await attempt(() => del(`/attachments/${a.id}`));
              if (c) { current.card = c; render(); reloadSoon(); }
            } }, 'Excluir')) : null,
          isCover ? h('span', { class: 'chip' }, 'Capa') : null));
    })));
}

// ---------- Tempo de produção ----------
function productionSection(card) {
  const started = card.cycle_started_at;
  const ended = card.cycle_ended_at;
  const total = started ? Date.parse(ended || new Date().toISOString()) - Date.parse(started) : null;
  const maxMs = Math.max(1, ...card.column_time.map((c) => c.ms));
  return h('section', { class: 'production' },
    h('h3', {}, 'Tempo de produção'),
    h('div', { class: 'stats-row' },
      stat('Início da produção', started ? fmtDateTime(started) : 'Ainda não iniciou'),
      stat('Conclusão', ended ? fmtDateTime(ended) : started ? 'Em andamento' : '—'),
      stat(ended ? 'Tempo total' : 'Em produção há', fmtDuration(total), ended ? 'ok' : ''),
      card.due_date ? stat('Prazo', fmtDateTime(card.due_date), (ended || new Date().toISOString()) > card.due_date ? 'late' : 'ok') : null),
    h('h4', {}, 'Tempo em cada coluna'),
    h('div', { class: 'bars' }, card.column_time.map((c) => {
      const color = state.columns.find((x) => x.id === c.column_id)?.color || '#ccc';
      return h('div', { class: 'bar-row' }, h('span', { class: 'bar-label' }, c.name),
        h('span', { class: 'bar' }, h('span', { style: { width: `${(c.ms / maxMs) * 100}%`, background: color } })),
        h('span', { class: 'bar-value' }, fmtDuration(c.ms)));
    })),
    h('details', {}, h('summary', {}, `Movimentações (${card.movements.length})`),
      h('ol', { class: 'timeline' }, card.movements.map((mv) => h('li', {},
        h('time', {}, fmtDateTime(mv.moved_at)), ' — ',
        mv.from_column_id ? `${mv.from_name || '?'} → ${mv.to_name || '?'}` : `entrou em ${mv.to_name || '?'}`,
        mv.user_name ? h('span', { class: 'muted' }, ` por ${mv.user_name}`) : h('span', { class: 'muted' }, ' (automático)'))))));
}

const stat = (label, value, cls = '') => h('div', { class: `stat ${cls}` }, h('small', {}, label), h('strong', {}, value));

// ---------- Ações ----------
function sidebar(card, editable, col) {
  return h('aside', { class: 'card-side' },
    h('h4', {}, 'Ações'),
    card.external_url ? h('a', { class: 'btn block', href: card.external_url, target: '_blank', rel: 'noopener' }, icon('bag'), 'Abrir pedido no Shopify') : null,
    editable ? h('button', { class: 'btn block', onclick: async () => {
      const r = await attempt(() => post(`/cards/${card.id}/notify`));
      if (r) { toast(`Aviso enviado: ${r.channels.join(', ') || 'nenhum canal ativo'}`, 'ok'); current.card = await get(`/cards/${card.id}`); render(); }
    } }, icon('bell'), 'Enviar aviso de prazo agora') : null,
    h('button', { class: 'btn block', onclick: () => { copyText(`${location.origin}/#card=${card.id}`); toast('Link copiado', 'ok'); } }, icon('link'), 'Copiar link do card'),
    editable ? h('button', { class: 'btn block', onclick: () => save({ archived: !card.archived }) }, card.archived ? [icon('restore'), 'Restaurar card'] : [icon('archive'), 'Arquivar card']) : null,
    editable ? h('button', { class: 'btn block danger', onclick: async () => {
      if (!(await confirmDialog(`Excluir definitivamente o card "${card.title}"? Os anexos também serão apagados.`, { ok: 'Excluir' }))) return;
      if (await attempt(() => del(`/cards/${card.id}`), 'Card excluído')) { current.modal.close(); reloadSoon(); }
    } }, icon('trash'), 'Excluir card') : null,
    h('div', { class: 'side-info muted' },
      h('div', {}, `Card #${card.id}`),
      h('div', {}, `Criado em ${fmtDateTime(card.created_at)}`),
      col ? h('div', {}, `Coluna: ${col.name}`) : null));
}
