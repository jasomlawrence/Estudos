// Inicialização: login, barra superior, tempo real, notificações
import { h, $, clear, avatar, timeAgo, debounce, icon } from './util.js';
import { get, post, patch, attempt, popover, toast } from './api.js';
import { state, isAdmin, isOwnEcho } from './state.js';
import { loadBoard, reloadSoon, enableDragScroll } from './board.js';
import { openCard, refreshOpenCard } from './card.js';
import { openSettings } from './settings.js';
import { openMetrics } from './metrics.js';
import { openActivity } from './activity.js';
import { loadCalendar } from './calendar.js';

async function start() {
  const me = await get('/auth/me');
  if (me.needsSetup) return authScreen('setup');
  if (!me.user) return authScreen('login');
  state.user = me.user;
  await startApp();
}

function authScreen(mode) {
  const name = h('input', { placeholder: 'Seu nome', required: true, autocomplete: 'name' });
  const email = h('input', { type: 'email', placeholder: 'E-mail', required: true, autocomplete: 'email' });
  const password = h('input', { type: 'password', placeholder: 'Senha', required: true, autocomplete: mode === 'setup' ? 'new-password' : 'current-password' });
  const error = h('p', { class: 'error' });
  const form = h('form', { class: 'auth-box', onsubmit: async (e) => {
    e.preventDefault();
    try {
      if (mode === 'setup') await post('/auth/setup', { name: name.value, email: email.value, password: password.value });
      else await post('/auth/login', { email: email.value, password: password.value });
      location.reload();
    } catch (err) { error.textContent = err.message; }
  } },
  h('div', { class: 'logo' }, icon('gem', 30)),
  h('h1', {}, mode === 'setup' ? 'Configuração inicial' : 'Produção de Anéis'),
  mode === 'setup' ? h('p', { class: 'muted' }, 'Crie a conta de administrador. Um quadro de produção de anéis de noivado será criado para você.') : null,
  mode === 'setup' ? name : null, email, password, error,
  h('button', { class: 'btn primary block', type: 'submit' }, mode === 'setup' ? 'Criar conta e começar' : 'Entrar'));
  clear(document.body, h('div', { class: 'auth-screen' }, form));
  (mode === 'setup' ? name : email).focus();
}

async function startApp() {
  state.boards = await get('/boards');
  const saved = Number(localStorage.getItem('boardId'));
  state.boardId = state.boards.some((b) => b.id === saved) ? saved : state.boards[0]?.id;
  renderShell();
  await loadBoard({ keepScroll: false });
  connectEvents();
  refreshNotifications();
  const m = location.hash.match(/card=(\d+)/);
  if (m) openCard(Number(m[1]));
  // Volta da autorização da Shopify (#shopify=ok ou #shopify=erro&msg=…)
  const back = new URLSearchParams(location.hash.slice(1));
  if (back.get('shopify')) {
    history.replaceState(null, '', location.pathname);
    if (back.get('shopify') === 'ok') toast('Loja conectada com a Shopify! Agora clique em "Registrar webhook".', 'ok');
    else toast(back.get('msg') || 'Não foi possível conectar com a Shopify.', 'error');
    openSettings('shopify');
  }
  setInterval(() => { if (!state.dragging && !document.hidden) reloadSoon(); }, 60000); // atualiza cronômetros
}

function renderShell() {
  const boardSelect = h('select', { class: 'board-select', title: 'Trocar de quadro', onchange: (e) => {
    state.boardId = Number(e.target.value);
    localStorage.setItem('boardId', state.boardId);
    state.columns = [];
    loadBoard({ keepScroll: false });
  } }, state.boards.map((b) => h('option', { value: b.id, selected: b.id === state.boardId }, b.name)));
  const searchInput = h('input', { type: 'search', placeholder: 'Buscar cards (título, cliente, pedido…)', 'aria-label': 'Buscar cards',
    oninput: debounce((e) => { state.search = e.target.value.trim(); state.columns = []; loadBoard({ keepScroll: false }); }, 300) });
  const search = h('label', { class: 'search' }, icon('search', 16), searchInput);
  const topBtn = (name, label, title, onclick) => h('button', { class: 'top-btn', title, onclick }, icon(name, 17), h('span', { class: 'lbl' }, label));
  const archivedBtn = topBtn('archive', 'Arquivados', 'Mostrar cards arquivados', () => {
    state.archived = !state.archived;
    archivedBtn.classList.toggle('active', state.archived);
    document.body.classList.toggle('show-archived', state.archived);
    state.columns = [];
    loadBoard({ keepScroll: false });
  });
  // Alternar entre quadro e calendário (lembrado neste navegador)
  const setView = (view) => {
    state.view = view;
    try { localStorage.setItem('view', view); } catch { /* navegação privada */ }
    $('#board').hidden = view !== 'board';
    $('#calendar').hidden = view !== 'calendar';
    for (const b of viewSwitch.children) b.classList.toggle('active', b.dataset.view === view);
    if (view === 'calendar' && state.board) loadCalendar();
    if (view === 'board' && state.boardStale) loadBoard();
  };
  const viewSwitch = h('div', { class: 'view-switch', role: 'tablist' },
    h('button', { dataset: { view: 'board' }, title: 'Quadro', onclick: () => setView('board') }, icon('kanban', 16), h('span', { class: 'lbl' }, 'Quadro')),
    h('button', { dataset: { view: 'calendar' }, title: 'Calendário', onclick: () => setView('calendar') }, icon('calendar', 16), h('span', { class: 'lbl' }, 'Calendário')));
  const bell = h('button', { class: 'top-btn bell', title: 'Notificações', onclick: (e) => openNotifications(e.currentTarget) }, icon('bell', 17), h('span', { class: 'badge-count', id: 'notif-count', hidden: true }));
  const userBtn = h('button', { class: 'top-btn user', onclick: (e) => {
    const pop = popover(e.currentTarget, h('div', { class: 'menu' },
      h('div', { class: 'menu-title' }, `${state.user.name} (${({ admin: 'administrador', member: 'editor', viewer: 'somente leitura' })[state.user.role]})`),
      h('button', { class: 'menu-item', onclick: () => { pop.close(); openSettings('account'); } }, 'Minha conta'),
      h('button', { class: 'menu-item', onclick: async () => { await post('/auth/logout'); location.reload(); } }, 'Sair')), { width: 220 });
  } }, avatar(state.user, 30));

  clear(document.body,
    h('header', { class: 'topbar' },
      h('span', { class: 'logo' }, icon('gem', 20)),
      state.boards.length > 1 ? boardSelect : null,
      h('input', { id: 'board-name', class: 'board-name', readOnly: !isAdmin(), title: 'Nome do quadro',
        onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
        onchange: (e) => attempt(() => patch(`/boards/${state.boardId}`, { name: e.target.value })) }),
      viewSwitch,
      search,
      h('div', { class: 'top-actions' },
        topBtn('clock', 'Produção', 'Tempo de produção', () => openMetrics(openCard)),
        topBtn('history', 'Atividade', 'Histórico de alterações', () => openActivity(openCard)),
        archivedBtn,
        topBtn('settings', 'Configurações', 'Configurações', () => openSettings()),
        bell, userBtn)),
    h('main', { id: 'board', class: 'board' }),
    h('main', { id: 'calendar', class: 'calendar', hidden: true }));
  enableDragScroll($('#board'));
  let saved = 'board';
  try { saved = localStorage.getItem('view') || 'board'; } catch { /* navegação privada */ }
  setView(saved === 'calendar' ? 'calendar' : 'board');
}

// ---------------- Tempo real (Server-Sent Events) ----------------
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('board', (e) => {
    const data = JSON.parse(e.data);
    if (data.boardId !== state.boardId) return;
    if (isOwnEcho(data)) return; // a tela já mostra a alteração que este navegador acabou de fazer
    reloadSoon();
    if (data.userId !== state.user.id) refreshOpenCard(data.cardIds);
  });
  es.addEventListener('notification', (e) => {
    const n = JSON.parse(e.data);
    toast(n.message, 'warn');
    refreshNotifications();
    if ('Notification' in window && Notification.permission === 'granted') {
      const notif = new Notification('Prazo de entrega', { body: n.message, tag: `card-${n.card_id}` });
      notif.onclick = () => { window.focus(); if (n.card_id) openCard(n.card_id); };
    }
  });
}

async function refreshNotifications() {
  const r = await get('/notifications').catch(() => null);
  if (!r) return;
  const badge = $('#notif-count');
  badge.hidden = !r.unread;
  badge.textContent = r.unread > 99 ? '99+' : String(r.unread);
  return r;
}

async function openNotifications(anchor) {
  const r = await refreshNotifications();
  const pop = popover(anchor, h('div', { class: 'menu notifications' },
    h('div', { class: 'menu-title' }, 'Notificações'),
    'Notification' in window && Notification.permission === 'default'
      ? h('button', { class: 'btn small block', onclick: () => Notification.requestPermission() }, 'Ativar notificações do navegador') : null,
    r?.items.length ? r.items.map((n) => h('button', { class: `notif${n.read ? '' : ' unread'}`, onclick: () => { pop.close(); if (n.card_id) openCard(n.card_id); } },
      h('div', {}, n.message.split('\n')[0]), h('small', { class: 'muted' }, timeAgo(n.created_at)))) : h('p', { class: 'muted' }, 'Nenhuma notificação.')), { width: 360 });
  if (r?.unread) { await post('/notifications/read'); refreshNotifications(); }
}

window.addEventListener('hashchange', () => {
  const m = location.hash.match(/card=(\d+)/);
  if (m && Number(m[1]) !== state.openCardId) openCard(Number(m[1]));
});

start().catch((err) => { document.body.textContent = `Erro ao iniciar: ${err.message}`; });
