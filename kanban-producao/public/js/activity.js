// Histórico de alterações (quem fez o quê e quando)
import { h, fmtDateTime, timeAgo, avatar, clear } from './util.js';
import { get, modal } from './api.js';
import { state, userById } from './state.js';

const q = (s) => `"${s ?? ''}"`;

export function describe(a, { withCard = false } = {}) {
  const d = a.details || {};
  const card = withCard && a.card_title ? ` em ${q(a.card_title)}` : '';
  switch (a.action) {
    case 'card.created': return `criou o card ${q(d.title)} em ${d.column}${d.source === 'shopify' ? ' (pedido do Shopify)' : ''}`;
    case 'card.moved': return `moveu${card || ' o card'} de ${d.from} para ${d.to}`;
    case 'card.updated':
      if (d.attribute === 'título') return `renomeou o card de ${q(d.from)} para ${q(d.to)}`;
      if (d.attribute === 'prazo de entrega') return d.to ? `definiu o prazo de entrega para ${fmtDateTime(d.to)}${card}` : `removeu o prazo de entrega${card}`;
      if (d.attribute === 'cor') return d.to ? `mudou a cor do card${card} para ${d.to}` : `removeu a cor do card${card}`;
      if (d.attribute === 'arquivado') return d.to === 'sim' ? `arquivou o card${card}` : `restaurou o card${card}`;
      return `alterou ${d.attribute}${card}`;
    case 'card.field': return `alterou o campo ${q(d.field)}${card}: ${d.from ? `${q(d.from)} → ` : ''}${d.to ? q(d.to) : '(vazio)'}`;
    case 'card.label_added': return `adicionou a etiqueta ${q(d.label || d.color)}${card}`;
    case 'card.label_removed': return `removeu a etiqueta ${q(d.label || d.color)}${card}`;
    case 'card.member_added': return `adicionou ${d.member} como responsável${card}`;
    case 'card.member_removed': return `removeu ${d.member} dos responsáveis${card}`;
    case 'card.notified': return `enviou aviso "${d.alert}"${card} (${d.channels || 'sem canais'})`;
    case 'card.deleted': return `excluiu o card ${q(d.title)}`;
    case 'attachment.added': return `anexou ${q(d.name)}${card}`;
    case 'attachment.removed': return `removeu o anexo ${q(d.name)}${card}`;
    case 'column.created': return `criou a coluna ${q(d.name)}`;
    case 'column.renamed': return `renomeou a coluna ${q(d.from)} para ${q(d.to)}`;
    case 'column.color': return `mudou a cor da coluna ${q(d.name)}`;
    case 'column.moved': return `reordenou a coluna ${q(d.name)}`;
    case 'column.deleted': return `excluiu a coluna ${q(d.name)}`;
    case 'label.created': return `criou a etiqueta ${q(d.label)}`;
    case 'label.deleted': return `excluiu a etiqueta ${q(d.label)}`;
    case 'field.created': return `criou o campo ${q(d.name)}`;
    case 'field.renamed': return `renomeou o campo ${q(d.from)} para ${q(d.to)}`;
    case 'field.deleted': return `excluiu o campo ${q(d.name)}`;
    case 'board.created': return `criou o quadro ${q(d.name)}`;
    case 'board.cycle': return `definiu o cronômetro de produção: de ${q(d.start)} até ${q(d.end)}`;
    case 'shopify.imported': return `importou o pedido ${d.order} do Shopify (${d.cards} card${d.cards > 1 ? 's' : ''})`;
    case 'integration.shopify': return 'alterou a integração com o Shopify';
    case 'integration.sheets': return 'alterou a integração com o Google Planilhas';
    case 'user.created': return `cadastrou o usuário ${d.name} (${d.role})`;
    case 'user.updated': return `alterou o usuário ${d.name}`;
    default: return a.action;
  }
}

export function activityItem(a, opts) {
  const user = userById(a.user_id);
  return h('li', { class: 'activity-item' },
    user ? avatar(user, 28) : h('span', { class: 'avatar system', title: 'Sistema' }, a.action.startsWith('shopify') || a.action === 'card.created' ? '🛍' : '⚙'),
    h('div', {},
      h('div', {}, h('strong', {}, a.user_name || 'Sistema'), ' ', describe(a, opts)),
      h('time', { title: fmtDateTime(a.created_at) }, timeAgo(a.created_at))));
}

export function openActivity(openCardFn) {
  const m = modal({ title: 'Atividade do quadro', wide: true });
  const list = h('ul', { class: 'activity' });
  const filter = h('select', { onchange: () => { lastId = null; clear(list); more(); } },
    h('option', { value: '' }, 'Todos os usuários'), state.users.map((u) => h('option', { value: u.id }, u.name)));
  const moreBtn = h('button', { class: 'btn', onclick: () => more() }, 'Carregar mais');
  let lastId = null;
  let loading = false;
  async function more() {
    if (loading) return;
    loading = true;
    try { await fetchPage(); } finally { loading = false; }
  }
  async function fetchPage() {
    const params = new URLSearchParams();
    if (lastId) params.set('before', lastId);
    if (filter.value) params.set('user', filter.value);
    const rows = await get(`/boards/${state.boardId}/activity?${params}`);
    for (const a of rows) {
      const li = activityItem(a, { withCard: true });
      if (a.card_id && a.card_title) { li.classList.add('clickable'); li.onclick = () => { m.close(); openCardFn(a.card_id); }; }
      list.append(li);
    }
    lastId = rows.at(-1)?.id ?? lastId;
    moreBtn.hidden = rows.length < 50;
  }
  m.body.append(h('div', { class: 'row' }, h('label', {}, 'Filtrar: ', filter)), list, moreBtn);
  // Rolagem infinita do histórico
  m.body.addEventListener('scroll', () => {
    if (!moreBtn.hidden && m.body.scrollTop + m.body.clientHeight > m.body.scrollHeight - 200) moreBtn.click();
  });
  more();
}
