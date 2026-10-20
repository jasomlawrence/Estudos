// Comentários nos cards e conversa da equipe, com menções (@Nome) que avisam a pessoa
import { h, $, clear, avatar, timeAgo, fmtDateTime, icon } from './util.js';
import { get, post, patch, del, attempt, confirmDialog } from './api.js';
import { state, isAdmin } from './state.js';

const fold = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const activeUsers = () => state.users.filter((u) => u.active !== false);

// ---------- Texto com menções e links ----------
/** Mostra a mensagem com as menções destacadas e os links clicáveis (sem HTML vindo do texto) */
export function renderBody(text) {
  const names = activeUsers().map((u) => u.name).sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(@(?:${[...names.map(esc), ...names.map((n) => esc(n.split(' ')[0]))].join('|') || '\\u0000'}))(?![\\p{L}\\p{N}])|(https?:\\/\\/[^\\s]+)`, 'giu');
  const out = h('div', { class: 'comment-body' });
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    out.append(text.slice(last, m.index));
    if (m[1]) {
      const name = m[1].slice(1);
      const user = activeUsers().find((u) => fold(u.name) === fold(name)) || activeUsers().find((u) => fold(u.name.split(' ')[0]) === fold(name));
      out.append(h('span', { class: `mention${user?.id === state.user.id ? ' me' : ''}`, title: user?.name || '' }, m[1]));
    } else {
      out.append(h('a', { href: m[2], target: '_blank', rel: 'noopener noreferrer' }, m[2]));
    }
    last = m.index + m[0].length;
  }
  out.append(text.slice(last));
  return out;
}

// ---------- Caixa de texto com sugestões de @ ----------
export function mentionInput({ placeholder = 'Escreva… use @ para chamar alguém', rows = 2, onSubmit, submitLabel = 'Enviar' }) {
  const chosen = new Set();
  const area = h('textarea', { rows, placeholder, class: 'mention-input' });
  const list = h('div', { class: 'mention-list', hidden: true, role: 'listbox' });
  let items = [];
  let index = 0;
  let range = null; // posição do "@texto" sendo digitado

  const close = () => { list.hidden = true; items = []; range = null; };
  const pick = (u) => {
    const before = area.value.slice(0, range.start);
    const after = area.value.slice(range.end);
    area.value = `${before}@${u.name} ${after}`;
    const caret = before.length + u.name.length + 2;
    area.setSelectionRange(caret, caret);
    chosen.add(u.id);
    close();
    area.focus();
  };
  const draw = () => {
    clear(list, items.map((u, i) => h('button', {
      type: 'button', class: `mention-option${i === index ? ' active' : ''}`, role: 'option',
      onmousedown: (e) => { e.preventDefault(); pick(u); },
    }, avatar(u, 22), h('span', {}, u.name), u.id === state.user.id ? h('small', { class: 'muted' }, ' (você)') : null)));
    list.hidden = !items.length;
  };
  const update = () => {
    const caret = area.selectionStart;
    const m = /(^|[\s(])@([\p{L}\p{N}._-]{0,30})$/u.exec(area.value.slice(0, caret));
    if (!m) return close();
    range = { start: caret - m[2].length - 1, end: caret };
    const qy = fold(m[2]);
    items = activeUsers().filter((u) => !qy || fold(u.name).split(' ').some((w) => w.startsWith(qy)) || fold(u.name).startsWith(qy)).slice(0, 8);
    index = 0;
    draw();
  };
  const submit = async () => {
    const body = area.value.trim();
    if (!body) return;
    send.disabled = true;
    const ok = await onSubmit(body, [...chosen]);
    send.disabled = false;
    if (ok) { area.value = ''; chosen.clear(); area.style.height = ''; }
    area.focus();
  };
  area.addEventListener('input', () => { update(); area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, 200)}px`; });
  area.addEventListener('click', update);
  area.addEventListener('blur', () => setTimeout(close, 150));
  area.addEventListener('keydown', (e) => {
    if (!list.hidden && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); index = (index + 1) % items.length; return draw(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); index = (index - 1 + items.length) % items.length; return draw(); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pick(items[index]); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  const atBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Mencionar alguém', onclick: () => {
    const pos = area.selectionStart;
    const needsSpace = pos > 0 && !/\s/.test(area.value[pos - 1]);
    area.setRangeText(`${needsSpace ? ' ' : ''}@`, pos, area.selectionEnd, 'end');
    area.focus();
    update();
  } }, '@');
  const send = h('button', { type: 'button', class: 'btn primary small', onclick: submit }, submitLabel);
  const el = h('div', { class: 'mention-box' }, list, area,
    h('div', { class: 'mention-actions' }, atBtn, h('small', { class: 'muted' }, 'Enter envia · Shift+Enter quebra linha'), send));
  return { el, area, focus: () => area.focus() };
}

// ---------- Uma mensagem ----------
function commentItem(c, { onChanged }) {
  const user = state.users.find((u) => u.id === c.user_id) || { name: c.user_name || 'Usuário removido' };
  const mine = c.user_id === state.user.id;
  const bodyBox = h('div', {}, renderBody(c.body));
  const startEdit = () => {
    const area = h('textarea', { class: 'mention-input', rows: 2, value: c.body });
    clear(bodyBox, area, h('div', { class: 'row' },
      h('button', { class: 'btn small primary', onclick: async () => {
        if (await attempt(() => patch(`/comments/${c.id}`, { body: area.value }))) onChanged();
      } }, 'Salvar'),
      h('button', { class: 'btn small subtle', onclick: () => clear(bodyBox, renderBody(c.body)) }, 'Cancelar')));
    area.focus();
  };
  return h('li', { class: `comment${mine ? ' mine' : ''}${c.mentions.includes(state.user.id) ? ' mentions-me' : ''}`, dataset: { id: c.id } },
    avatar(user, 30),
    h('div', { class: 'comment-main' },
      h('div', { class: 'comment-head' },
        h('strong', {}, user.name),
        h('time', { title: fmtDateTime(c.created_at) }, timeAgo(c.created_at)),
        c.edited_at ? h('small', { class: 'muted', title: `Editado em ${fmtDateTime(c.edited_at)}` }, '(editado)') : null,
        h('span', { class: 'grow' }),
        mine ? h('button', { class: 'link-btn', onclick: startEdit }, 'Editar') : null,
        mine || isAdmin() ? h('button', { class: 'link-btn', onclick: async () => {
          if (await confirmDialog('Apagar esta mensagem?', { ok: 'Apagar' }) && await attempt(() => del(`/comments/${c.id}`))) onChanged();
        } }, 'Apagar') : null),
      bodyBox));
}

// ---------- Comentários dentro do card ----------
/** Bloco persistente: o texto que está sendo escrito não some quando o card se atualiza */
export function commentsPanel(cardId) {
  const title = h('h3', {}, 'Comentários');
  const list = h('ul', { class: 'comments' });
  const input = mentionInput({
    placeholder: 'Escreva um comentário… use @ para avisar alguém',
    onSubmit: async (body, mentions) => {
      const c = await attempt(() => post(`/cards/${cardId}/comments`, { body, mentions }));
      if (c) await load();
      return !!c;
    },
  });
  async function load() {
    const rows = await get(`/cards/${cardId}/comments`).catch(() => null);
    if (!rows) return;
    title.textContent = `Comentários${rows.length ? ` (${rows.length})` : ''}`;
    clear(list, rows.length ? rows.map((c) => commentItem(c, { onChanged: load })) : h('li', { class: 'muted small empty' }, 'Nenhum comentário ainda. Use @ para chamar alguém da equipe.'));
  }
  load();
  const el = h('section', { class: 'comments-section' }, title, input.el, list);
  return { el, refresh: load, cardId };
}

// ---------- Conversa da equipe (painel lateral) ----------
const chat = { panel: null, list: null, oldest: null, done: false };

export function setChatBadge(n) {
  state.chatUnread = n;
  const b = $('#chat-count');
  if (!b) return;
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : String(n);
}

async function loadChat({ older = false } = {}) {
  const url = `/boards/${state.boardId}/chat${older && chat.oldest ? `?before=${chat.oldest}` : ''}`;
  const rows = await get(url).catch(() => null);
  if (!rows || !chat.panel) return;
  const scroller = chat.list.parentElement;
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  const prevHeight = scroller.scrollHeight;
  if (older) {
    chat.list.prepend(...rows.map((c) => commentItem(c, { onChanged: () => reloadChat() })));
  } else {
    clear(chat.list, rows.length ? rows.map((c) => commentItem(c, { onChanged: () => reloadChat() })) : h('li', { class: 'muted small empty' }, 'Comece a conversa. Use @ para chamar alguém.'));
  }
  if (rows.length) chat.oldest = Math.min(chat.oldest ?? Infinity, rows[0].id);
  chat.done = rows.length < 50;
  chat.more.hidden = chat.done;
  if (older) scroller.scrollTop = scroller.scrollHeight - prevHeight;
  else if (atBottom || !older) scroller.scrollTop = scroller.scrollHeight;
  post(`/boards/${state.boardId}/chat/read`).then(() => setChatBadge(0)).catch(() => {});
}

function reloadChat() { chat.oldest = null; return loadChat(); }

export function openChat() {
  if (chat.panel) { chat.input.focus(); return; }
  chat.list = h('ul', { class: 'comments chat-list' });
  chat.more = h('button', { class: 'btn small subtle chat-more', hidden: true, onclick: () => loadChat({ older: true }) }, 'Mensagens anteriores');
  chat.input = mentionInput({
    placeholder: 'Mensagem para a equipe… use @ para chamar alguém',
    onSubmit: async (body, mentions) => {
      const c = await attempt(() => post(`/boards/${state.boardId}/chat`, { body, mentions }));
      if (c) await reloadChat();
      return !!c;
    },
  });
  const close = () => { chat.panel?.remove(); chat.panel = null; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-overlay')) close(); };
  chat.panel = h('aside', { class: 'chat-panel', role: 'dialog', 'aria-label': 'Conversa da equipe' },
    h('header', {}, icon('chat', 18), h('strong', {}, 'Conversa da equipe'), h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn', title: 'Fechar', onclick: close }, icon('x', 18))),
    h('div', { class: 'chat-scroll' }, chat.more, chat.list),
    h('footer', {}, chat.input.el));
  document.body.append(chat.panel);
  document.addEventListener('keydown', onKey);
  chat.oldest = null;
  loadChat();
  chat.input.focus();
}

/** Chamado pelo tempo real quando alguém comenta, edita ou apaga uma mensagem */
export function onCommentEvent(data, openCardPanel) {
  if (data.boardId !== state.boardId) return;
  if (data.cardId) {
    if (openCardPanel?.cardId === data.cardId) openCardPanel.refresh();
    return;
  }
  if (chat.panel) reloadChat();
  else if (data.userId !== state.user.id && !data.deleted) setChatBadge((state.chatUnread || 0) + 1);
}
