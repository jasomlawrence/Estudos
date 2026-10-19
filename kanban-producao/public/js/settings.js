// Configurações: quadro, campos, etiquetas, cronômetro, Shopify, Google Planilhas, notificações, usuários
import { h, clear, textColorFor, colorPicker, PALETTE, copyText, avatar, BACKGROUNDS, backgroundCss, icon } from './util.js';
import { get, post, patch, put, del, attempt, modal, confirmDialog, toast } from './api.js';
import { state, isAdmin } from './state.js';
import { loadBoard } from './board.js';

const FIELD_TYPES = [
  ['text', 'Texto curto'], ['textarea', 'Texto longo'], ['number', 'Número'], ['currency', 'Valor (R$)'],
  ['date', 'Data'], ['datetime', 'Data e hora'], ['checkbox', 'Sim / Não'], ['select', 'Lista de opções'],
  ['multiselect', 'Múltipla escolha'], ['url', 'Link'], ['email', 'E-mail'], ['phone', 'Telefone / WhatsApp'],
];

export function openSettings(tab = 'board') {
  const m = modal({ title: 'Configurações', wide: true, className: 'settings-modal', onClose: () => loadBoard() });
  const tabs = [
    ['board', 'Quadro'], ['fields', 'Campos do card'], ['labels', 'Etiquetas'], ['cycle', 'Cronômetro de produção'],
    ...(isAdmin() ? [['shopify', 'Shopify'], ['correios', 'Correios'], ['sheets', 'Google Planilhas'], ['notifications', 'Notificações'], ['users', 'Usuários']] : []),
    ['account', 'Minha conta'],
  ];
  const nav = h('nav', { class: 'tabs' });
  const panel = h('div', { class: 'tab-panel' });
  const show = (key) => {
    for (const b of nav.children) b.classList.toggle('active', b.dataset.tab === key);
    clear(panel, h('p', { class: 'muted' }, 'Carregando…'));
    PANELS[key](panel).catch((err) => clear(panel, h('p', { class: 'error' }, err.message)));
  };
  for (const [key, label] of tabs) nav.append(h('button', { dataset: { tab: key }, onclick: () => show(key) }, label));
  m.body.append(h('div', { class: 'settings' }, nav, panel));
  show(tabs.some(([k]) => k === tab) ? tab : 'board');
}

const PANELS = {
  // ---------------- Quadro ----------------
  async board(panel) {
    const name = h('input', { value: state.board.name });
    let bg = state.board.background;
    const boards = await get('/boards');
    clear(panel,
      h('h3', {}, 'Quadro atual'),
      h('label', { class: 'form-row' }, 'Nome', name),
      h('div', { class: 'form-row' }, 'Fundo do quadro', backgroundPicker(bg, (b) => { bg = b; document.documentElement.style.setProperty('--board-bg', backgroundCss(b)); })),
      h('button', { class: 'btn primary', onclick: () => attempt(() => patch(`/boards/${state.boardId}`, { name: name.value, background: bg }), 'Quadro salvo') }, 'Salvar'),
      isAdmin() ? [
        h('h3', {}, 'Outros quadros'),
        h('ul', { class: 'simple-list' }, boards.map((b) => h('li', {}, b.name, b.id === state.boardId ? h('span', { class: 'chip' }, 'atual') : null,
          boards.length > 1 ? h('button', { class: 'btn small subtle', onclick: async () => {
            if (!(await confirmDialog(`Excluir o quadro "${b.name}" e TODOS os seus cards?`, { ok: 'Excluir quadro' }))) return;
            if (await attempt(() => del(`/boards/${b.id}`), 'Quadro excluído')) location.reload();
          } }, 'Excluir') : null))),
        h('button', { class: 'btn', onclick: async () => {
          const r = await attempt(() => post('/boards', { name: 'Novo quadro' }));
          if (r) { localStorage.setItem('boardId', r.id); location.reload(); }
        } }, '+ Criar novo quadro'),
      ] : null);
  },

  // ---------------- Campos ----------------
  async fields(panel) {
    const data = await get(`/boards/${state.boardId}?limit=10`);
    state.fields = data.fields;
    const list = h('div', { class: 'field-defs' });
    const redraw = () => PANELS.fields(panel);
    for (const [i, f] of state.fields.entries()) list.append(fieldDefEditor(f, i, redraw));
    const newName = h('input', { placeholder: 'Nome do novo campo (ex.: Tamanho do aro)' });
    const newType = h('select', {}, FIELD_TYPES.map(([v, l]) => h('option', { value: v }, l)));
    clear(panel,
      h('h3', {}, 'Campos personalizados dos cards'),
      h('p', { class: 'muted' }, 'Crie quantos campos quiser. Marque "Mostrar no card" para exibir o valor direto no quadro.'),
      list,
      h('div', { class: 'row add-field' }, newName, newType,
        h('button', { class: 'btn primary', onclick: async () => {
          if (!newName.value.trim()) return toast('Dê um nome ao campo.', 'error');
          const opts = ['select', 'multiselect'].includes(newType.value) ? [{ label: 'Opção 1', color: PALETTE[0] }] : [];
          if (await attempt(() => post(`/boards/${state.boardId}/fields`, { name: newName.value, type: newType.value, options: opts, show_on_card: false }), 'Campo criado')) redraw();
        } }, '+ Adicionar campo')));
  },

  // ---------------- Etiquetas ----------------
  async labels(panel) {
    const data = await get(`/boards/${state.boardId}?limit=10`);
    state.labels = data.labels;
    const redraw = () => PANELS.labels(panel);
    const row = (l) => {
      let color = l?.color || PALETTE[10];
      const name = h('input', { value: l?.name || '', placeholder: 'Nome da etiqueta' });
      const sw = h('button', { class: 'swatch big', style: { background: color }, onclick: (e) => {
        const p = colorPicker(color, (c) => { color = c; sw.style.background = c; p.remove(); }, { allowNone: false });
        e.currentTarget.after(p);
      } });
      return h('div', { class: 'row label-row' }, sw, name,
        h('button', { class: 'btn small primary', onclick: async () => {
          if (l) await attempt(() => patch(`/labels/${l.id}`, { name: name.value, color }), 'Etiqueta salva');
          else await attempt(() => post(`/boards/${state.boardId}/labels`, { name: name.value, color }), 'Etiqueta criada');
          redraw();
        } }, l ? 'Salvar' : 'Criar'),
        l ? h('button', { class: 'btn small subtle', onclick: async () => {
          if (await confirmDialog(`Excluir a etiqueta "${l.name}"?`)) { await attempt(() => del(`/labels/${l.id}`)); redraw(); }
        } }, 'Excluir') : null);
    };
    clear(panel, h('h3', {}, 'Etiquetas coloridas'),
      state.labels.map((l) => h('div', {}, h('span', { class: 'label big', style: { background: l.color, color: textColorFor(l.color) } }, l.name || ' '), row(l))),
      h('h4', {}, 'Nova etiqueta'), row(null));
  },

  // ---------------- Cronômetro ----------------
  async cycle(panel) {
    const cols = [...state.columns].sort((a, b) => a.position - b.position);
    const sel = (value, fallback) => h('select', { disabled: !isAdmin() }, cols.map((c) => h('option', { value: c.id, selected: c.id === (value || fallback) }, c.name)));
    const start = sel(state.board.cycle_start_column_id, cols[0]?.id);
    const end = sel(state.board.cycle_end_column_id, cols.at(-1)?.id);
    clear(panel,
      h('h3', {}, 'Cronômetro de produção'),
      h('p', { class: 'muted' }, 'O tempo de produção de cada card começa a contar quando ele entra na coluna inicial (ou em qualquer coluna depois dela) e para quando chega na coluna final. Os relatórios ficam no botão "Produção" no topo.'),
      h('label', { class: 'form-row' }, 'Começa a contar em', start),
      h('label', { class: 'form-row' }, 'Para de contar em', end),
      isAdmin() ? h('button', { class: 'btn primary', onclick: () => attempt(() => patch(`/boards/${state.boardId}`, { cycle_start_column_id: Number(start.value), cycle_end_column_id: Number(end.value) }), 'Cronômetro atualizado') }, 'Salvar') : h('p', { class: 'muted' }, 'Somente administradores podem alterar.'),
      h('p', { class: 'muted small' }, 'Cards que voltarem da coluna final continuam contando a partir do início original.'));
  },

  // ---------------- Shopify ----------------
  async shopify(panel) {
    const c = await get('/integrations/shopify');
    const cols = state.columns;
    const f = {
      enabled: h('input', { type: 'checkbox', checked: c.enabled }),
      shop_domain: h('input', { value: c.shop_domain, placeholder: 'minhaloja.myshopify.com (ou cole o link do admin)' }),
      client_id: h('input', { value: c.client_id, placeholder: 'Client ID do app (Dev Dashboard → Configurações)', autocomplete: 'off' }),
      client_secret: h('input', { value: c.client_secret, placeholder: 'Client secret do app', autocomplete: 'off' }),
      webhook_secret: h('input', { value: c.webhook_secret, placeholder: 'Só se criou o webhook manualmente no admin', autocomplete: 'off' }),
      access_token: h('input', { value: c.access_token, placeholder: 'shpat_… (só para apps antigos criados no admin)', autocomplete: 'off' }),
      api_version: h('input', { value: c.api_version, placeholder: c.default_api_version }),
      column_id: h('select', {}, cols.map((col) => h('option', { value: col.id, selected: col.id === c.column_id }, col.name))),
      keywords: h('input', { value: c.keywords }),
      product_ids: h('input', { value: c.product_ids, placeholder: 'IDs separados por vírgula' }),
      tags: h('input', { value: c.tags, placeholder: 'ex.: anel-noivado' }),
      mode: h('select', {},
        [['line_item', 'Um card por produto do pedido'], ['unit', 'Um card por unidade (qtd. 2 = 2 cards)'], ['order', 'Um card por pedido']]
          .map(([v, l]) => h('option', { value: v, selected: v === c.mode }, l))),
      title_template: h('input', { value: c.title_template }),
      due_days: h('input', { type: 'number', min: 0, value: c.due_days }),
    };
    const labelSet = new Set(c.label_ids || []);
    const labelsBox = h('div', { class: 'row wrap' }, state.labels.map((l) => h('button', {
      type: 'button', class: `label big toggle${labelSet.has(l.id) ? ' on' : ''}`, style: { background: l.color, color: textColorFor(l.color) },
      onclick: (e) => { labelSet.has(l.id) ? labelSet.delete(l.id) : labelSet.add(l.id); e.currentTarget.classList.toggle('on'); },
    }, l.name || ' ')));

    // Mapeamento: dado do pedido → campo do card
    const mapping = { ...(c.mapping || {}) };
    const mapRows = state.fields.map((fd) => {
      const currentVal = mapping[fd.id] || '';
      const isProp = currentVal.startsWith('prop:');
      const propInput = h('input', { placeholder: 'Nome da personalização (ex.: Tamanho do aro)', value: isProp ? currentVal.slice(5) : '', hidden: !isProp,
        oninput: (e) => { mapping[fd.id] = `prop:${e.target.value}`; } });
      const select = h('select', { onchange: (e) => {
        propInput.hidden = e.target.value !== 'prop';
        mapping[fd.id] = e.target.value === 'prop' ? `prop:${propInput.value}` : e.target.value;
      } },
      h('option', { value: '' }, '— não preencher —'),
      c.sources.map((s) => h('option', { value: s.key, selected: s.key === currentVal }, s.label)),
      h('option', { value: 'prop', selected: isProp }, 'Personalização do produto (campo do pedido)…'));
      return h('tr', {}, h('td', {}, fd.name), h('td', {}, select, propInput));
    });

    const webhookUrl = `${location.origin}${c.webhook_path}`;
    const collect = () => ({
      enabled: f.enabled.checked, shop_domain: f.shop_domain.value, webhook_secret: f.webhook_secret.value, access_token: f.access_token.value,
      client_id: f.client_id.value, client_secret: f.client_secret.value,
      api_version: f.api_version.value, board_id: state.boardId, column_id: Number(f.column_id.value), keywords: f.keywords.value,
      product_ids: f.product_ids.value, tags: f.tags.value, mode: f.mode.value, title_template: f.title_template.value,
      due_days: Number(f.due_days.value), label_ids: [...labelSet], mapping,
    });
    const saveCfg = () => attempt(() => put('/integrations/shopify', collect()), 'Configuração do Shopify salva');
    const days = h('input', { type: 'number', value: 30, min: 1, style: { width: '80px' } });
    const publicUrl = h('input', { value: location.origin.startsWith('https') ? location.origin : '', placeholder: 'https://seu-dominio.com' });

    clear(panel,
      h('h3', {}, 'Pedidos do Shopify → cards de produção'),
      h('p', { class: 'muted' }, 'Toda vez que entrar um pedido com anel de noivado, um card é criado automaticamente na coluna escolhida, já com os dados do cliente.'),
      h('label', { class: 'check' }, f.enabled, ' Integração ativa'),
      h('fieldset', {}, h('legend', {}, '1. Conexão'),
        h('details', { class: 'callout', open: !c.client_id && !c.access_token }, h('summary', {}, 'Passo a passo para conectar (app no Dev Dashboard)'),
          h('p', { class: 'small' }, 'Desde janeiro de 2026 a Shopify não permite mais criar "apps personalizados" dentro do admin. O app agora é criado no Dev Dashboard e a conexão usa o Client ID e o Client secret.'),
          h('ol', { class: 'small' },
            h('li', {}, 'No admin da Shopify, vá em Configurações → Apps → Desenvolver apps e abra o Dev Dashboard (ou acesse dev.shopify.com com a mesma conta). Clique em "Criar app", escolha começar pelo Dev Dashboard e dê um nome (ex.: Kanban Produção).'),
            h('li', {}, `Na aba Versões, crie uma versão: em "App URL" use ${location.origin}; versão da API de webhooks ${c.default_api_version}; e marque os escopos read_orders, read_products e read_customers. Clique em Lançar (Release).`),
            h('li', {}, 'Na visão geral do app, clique em "Instalar app" e escolha a sua loja.'),
            h('li', {}, 'Nas configurações do app, copie o Client ID e o Client secret e cole nos campos abaixo. No domínio, pode colar o link do admin (admin.shopify.com/store/…) que o sistema converte.'),
            h('li', {}, 'Clique em Salvar, depois em "Testar conexão" e por fim em "Registrar webhook".'),
            h('li', {}, 'Se o nome, o endereço ou o e-mail do cliente chegarem vazios nos cards, peça no Dev Dashboard o acesso a "dados protegidos de clientes" (nome, endereço, e-mail e telefone).'))),
        h('label', { class: 'form-row' }, 'Domínio da loja', f.shop_domain),
        h('label', { class: 'form-row' }, 'Client ID', f.client_id),
        h('label', { class: 'form-row' }, 'Client secret', f.client_secret),
        h('label', { class: 'form-row' }, 'Versão da API', f.api_version),
        h('div', { class: 'form-row' }, 'Endereço público deste sistema', publicUrl),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', onclick: async () => { await saveCfg(); const s = await attempt(() => post('/integrations/shopify/test')); if (s) toast(`Conectado à loja ${s.name}`, 'ok'); } }, 'Testar conexão'),
          h('button', { class: 'btn', onclick: async () => {
            await saveCfg();
            if (await attempt(() => post('/integrations/shopify/register-webhook', { public_url: publicUrl.value }))) toast('Webhook registrado: novos pedidos já entram no quadro', 'ok');
          } }, 'Registrar webhook')),
        h('details', {}, h('summary', {}, 'Outras formas de conexão'),
          h('div', { class: 'form-row' }, 'Endereço do webhook', h('div', { class: 'row' }, h('code', { class: 'grow' }, webhookUrl), h('button', { class: 'btn small', onclick: () => { copyText(webhookUrl); toast('Copiado', 'ok'); } }, 'Copiar'))),
          h('label', { class: 'form-row' }, 'Chave do webhook criado no admin', f.webhook_secret),
          h('p', { class: 'muted small' }, 'Se preferir criar o webhook à mão (Configurações → Notificações → Webhooks → evento "Criação de pedido", formato JSON, com o endereço acima), cole aqui a chave mostrada lá ("seus webhooks serão assinados com…").'),
          h('label', { class: 'form-row' }, 'Token de app antigo (shpat_)', f.access_token),
          h('p', { class: 'muted small' }, 'Só para quem já tinha um app personalizado criado no admin antes de 2026. Se preenchido, ele é usado no lugar do Client ID/secret.'))),
      h('fieldset', {}, h('legend', {}, '2. Quais pedidos entram'),
        h('label', { class: 'form-row' }, 'Palavras no nome do produto', f.keywords),
        h('label', { class: 'form-row' }, 'Ou IDs de produtos', f.product_ids),
        h('label', { class: 'form-row' }, 'Ou tags / tipo de produto', f.tags),
        h('p', { class: 'muted small' }, 'Basta uma regra bater (as palavras ignoram acentos e maiúsculas). Tags exigem a conexão com Client ID e Client secret. Deixe tudo vazio para trazer todos os pedidos.')),
      h('fieldset', {}, h('legend', {}, '3. Como o card é criado'),
        h('label', { class: 'form-row' }, 'Coluna de entrada', f.column_id),
        h('label', { class: 'form-row' }, 'Quantidade de cards', f.mode),
        h('label', { class: 'form-row' }, 'Título do card', f.title_template),
        h('p', { class: 'muted small' }, 'Use {order_name}, {customer_name}, {product_title}, {variant_title}, {sku} ou {prop:Nome da personalização}.'),
        h('label', { class: 'form-row' }, 'Prazo de entrega (dias após o pedido)', f.due_days),
        h('div', { class: 'form-row' }, 'Etiquetas automáticas', labelsBox),
        h('h4', {}, 'Preencher campos do card com dados do pedido'),
        state.fields.length ? h('table', { class: 'map-table' }, h('tbody', {}, mapRows)) : h('p', { class: 'muted' }, 'Crie campos na aba "Campos do card" para mapear.')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: saveCfg }, 'Salvar')),
      h('fieldset', {}, h('legend', {}, 'Pedidos antigos'),
        h('div', { class: 'row' }, 'Importar pedidos dos últimos', days, 'dias',
          h('button', { class: 'btn', onclick: async () => {
            await saveCfg();
            const r = await attempt(() => post('/integrations/shopify/import', { days: Number(days.value) }));
            if (r) { toast(`${r.orders} pedidos lidos, ${r.created} card(s) criados`, 'ok'); loadBoard(); }
          } }, 'Importar'))));
  },

  // ---------------- Correios ----------------
  async correios(panel) {
    const c = await get('/integrations/correios');
    const f = {
      enabled: h('input', { type: 'checkbox', checked: c.enabled }),
      environment: h('select', {}, [['producao', 'Produção'], ['homologacao', 'Homologação (testes)']].map(([v, l]) => h('option', { value: v, selected: v === c.environment }, l))),
      usuario: h('input', { value: c.usuario, placeholder: 'Usuário do Meu Correios / CNPJ', autocomplete: 'off' }),
      codigo_acesso: h('input', { value: c.codigo_acesso, placeholder: 'Código de acesso às APIs (gerado no CWS)', autocomplete: 'off' }),
      cartao: h('input', { value: c.cartao, placeholder: 'Número do cartão de postagem', inputMode: 'numeric' }),
      contrato: h('input', { value: c.contrato, placeholder: 'Opcional', inputMode: 'numeric' }),
      cep_origem: h('input', { value: c.cep_origem, placeholder: 'CEP de onde as peças são postadas', inputMode: 'numeric' }),
      servico: h('select', {}, c.services.map((s) => h('option', { value: s.code, selected: s.code === c.servico }, `${s.label} — ${s.code}`)),
        c.services.some((s) => s.code === c.servico) ? null : h('option', { value: c.servico, selected: true }, c.servico)),
      promised_source: h('select', {},
        [['auto', 'Procurar em todo o pedido (personalização, atributos e observação)'], ['property', 'Só na personalização do produto'], ['attribute', 'Só nos atributos do pedido'], ['days', 'X dias depois do pedido']]
          .map(([v, l]) => h('option', { value: v, selected: v === c.promised_source }, l))),
      promised_name: h('input', { value: c.promised_name, placeholder: 'Ex.: Data estimada de entrega' }),
      promised_days: h('input', { type: 'number', min: 0, value: c.promised_days }),
      margem_dias: h('input', { type: 'number', min: 0, value: c.margem_dias }),
      hora_postagem: h('input', { type: 'time', value: c.hora_postagem }),
    };
    const nameRow = h('label', { class: 'form-row' }, 'Nome do campo com a data', f.promised_name);
    const daysRow = h('label', { class: 'form-row' }, 'Dias depois do pedido', f.promised_days);
    const syncSource = () => { nameRow.hidden = f.promised_source.value === 'days'; daysRow.hidden = f.promised_source.value !== 'days'; };
    f.promised_source.onchange = syncSource;
    syncSource();
    const collect = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
    const save = () => attempt(() => put('/integrations/correios', collect()), 'Configuração dos Correios salva');
    const testZip = h('input', { placeholder: 'CEP de destino', inputMode: 'numeric', style: { width: '140px' } });
    const testDate = h('input', { type: 'date' });
    const result = h('p', { class: 'callout', hidden: true });
    clear(panel,
      h('h3', {}, 'Prazo automático pelos Correios'),
      h('p', { class: 'muted' }, 'Quando um pedido chega do Shopify, o sistema consulta o prazo dos Correios até o CEP do cliente e define o prazo do card como: data de entrega prometida − prazo dos Correios − folga. Fins de semana e feriados nacionais não contam.'),
      h('label', { class: 'check' }, f.enabled, ' Integração ativa'),
      h('fieldset', {}, h('legend', {}, '1. Acesso à API (contrato)'),
        h('label', { class: 'form-row' }, 'Ambiente', f.environment),
        h('label', { class: 'form-row' }, 'Usuário', f.usuario),
        h('label', { class: 'form-row' }, 'Código de acesso', f.codigo_acesso),
        h('label', { class: 'form-row' }, 'Cartão de postagem', f.cartao),
        h('label', { class: 'form-row' }, 'Contrato', f.contrato),
        h('p', { class: 'muted small' }, 'O código de acesso é gerado em cws.correios.com.br → "Gestão de acesso a API\'s" (não é a senha do site). O contrato precisa ter o serviço 38210 – API PRAZOS liberado; se não tiver, peça ao seu consultor dos Correios.')),
      h('fieldset', {}, h('legend', {}, '2. Envio'),
        h('label', { class: 'form-row' }, 'CEP de origem', f.cep_origem),
        h('label', { class: 'form-row' }, 'Serviço', f.servico),
        h('label', { class: 'form-row' }, 'Folga extra (dias úteis)', f.margem_dias),
        h('label', { class: 'form-row' }, 'Horário limite de postagem', f.hora_postagem)),
      h('fieldset', {}, h('legend', {}, '3. Onde está a data de entrega prometida'),
        h('label', { class: 'form-row' }, 'Origem da data', f.promised_source),
        nameRow, daysRow,
        h('p', { class: 'muted small' }, `Aceita datas como 25/12/2026, 25/12, 2026-12-25, "25 de dezembro" ou "25 de dez."; num intervalo ("20/11 a 25/11") usa a primeira data. Se a data não for encontrada ou os Correios não responderem, o card usa o prazo padrão do Shopify e a descrição explica o motivo.`)),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Salvar')),
      h('fieldset', {}, h('legend', {}, 'Testar'),
        h('div', { class: 'row wrap' }, testZip, h('span', { class: 'muted small' }, 'entrega prometida (opcional)'), testDate,
          h('button', { class: 'btn', onclick: async () => {
            await save();
            const r = await attempt(() => post('/integrations/correios/test', { zip: testZip.value, promised_date: testDate.value }));
            if (!r) return;
            result.hidden = false;
            result.textContent = r.summary || `Prazo dos Correios: ${r.days} dia(s) útil(eis)${r.message ? ` — ${r.message}` : ''}`;
          } }, 'Consultar prazo')),
        result));
  },

  // ---------------- Google Planilhas ----------------
  async sheets(panel) {
    const c = await get(`/integrations/sheets/${state.boardId}`);
    const enabled = h('input', { type: 'checkbox', checked: c.enabled });
    const auto = h('input', { type: 'checkbox', checked: c.auto_sync });
    const sheetId = h('input', { value: c.spreadsheet_id ? `https://docs.google.com/spreadsheets/d/${c.spreadsheet_id}` : '', placeholder: 'Cole o link da planilha' });
    const sheetName = h('input', { value: c.sheet_name });
    const creds = h('textarea', { rows: 4, placeholder: c.credentials ? `Credencial atual: ${c.credentials.client_email} (cole outro JSON para trocar)` : 'Cole aqui o conteúdo do arquivo JSON da conta de serviço' });
    const credFile = h('input', { type: 'file', accept: '.json,application/json', onchange: async (e) => { creds.value = await e.target.files[0].text(); } });

    // Colunas selecionadas (com ordem)
    const options = [...c.builtin_columns, ...state.fields.map((f) => ({ key: `field:${f.id}`, label: `Campo: ${f.name}` }))];
    let selected = c.columns.filter((k) => options.some((o) => o.key === k));
    const colList = h('div', { class: 'sheet-columns' });
    const drawCols = () => clear(colList,
      h('div', { class: 'muted small' }, 'Selecionados (na ordem das colunas da planilha):'),
      h('ol', { class: 'chosen' }, selected.map((k, i) => h('li', {},
        options.find((o) => o.key === k)?.label,
        k === 'id' ? h('small', { class: 'muted' }, ' (obrigatório, coluna A)') : [
          h('button', { class: 'icon-btn', title: 'Subir', disabled: i <= 1, onclick: () => { [selected[i - 1], selected[i]] = [selected[i], selected[i - 1]]; drawCols(); } }, '↑'),
          h('button', { class: 'icon-btn', title: 'Descer', disabled: i === selected.length - 1, onclick: () => { [selected[i + 1], selected[i]] = [selected[i], selected[i + 1]]; drawCols(); } }, '↓'),
          h('button', { class: 'icon-btn', title: 'Remover', onclick: () => { selected = selected.filter((x) => x !== k); drawCols(); } }, icon('x')),
        ]))),
      h('div', { class: 'muted small' }, 'Disponíveis (clique para adicionar):'),
      h('div', { class: 'row wrap' }, options.filter((o) => !selected.includes(o.key)).map((o) => h('button', { class: 'chip toggle', onclick: () => { selected.push(o.key); drawCols(); } }, `＋ ${o.label}`))));
    if (!selected.includes('id')) selected.unshift('id');
    drawCols();

    const collect = () => ({ enabled: enabled.checked, auto_sync: auto.checked, spreadsheet_id: sheetId.value, sheet_name: sheetName.value, columns: selected, credentials: creds.value });
    const save = async () => {
      const r = await attempt(() => put(`/integrations/sheets/${state.boardId}`, collect()), 'Configuração salva');
      if (r) PANELS.sheets(panel);
      return r;
    };
    const status = c.status ? h('p', { class: c.status.ok ? 'ok-text' : 'error' }, `Última sincronização: ${new Date(c.status.at).toLocaleString('pt-BR')} — ${c.status.message}`) : null;

    clear(panel,
      h('h3', {}, 'Google Planilhas'),
      h('p', { class: 'muted' }, 'Cada card vira uma linha na planilha. Você escolhe quais campos viram colunas. Com a sincronização automática, toda alteração no card atualiza a linha em poucos segundos.'),
      status,
      h('label', { class: 'check' }, enabled, ' Integração ativa'),
      h('label', { class: 'check' }, auto, ' Sincronizar automaticamente a cada alteração'),
      h('label', { class: 'form-row' }, 'Planilha', sheetId),
      h('label', { class: 'form-row' }, 'Nome da aba', sheetName),
      h('div', { class: 'form-row' }, 'Conta de serviço do Google', h('div', {}, creds, credFile)),
      c.credentials ? h('p', { class: 'callout' }, 'Compartilhe a planilha (botão "Compartilhar" do Google Planilhas) com ', h('code', {}, c.credentials.client_email), ' como Editor.', ' ',
        h('button', { class: 'btn small', onclick: () => { copyText(c.credentials.client_email); toast('E-mail copiado', 'ok'); } }, 'Copiar e-mail')) : null,
      h('details', {}, h('summary', {}, 'Como criar a conta de serviço (5 minutos)'),
        h('ol', { class: 'small' },
          h('li', {}, 'Acesse console.cloud.google.com e crie (ou escolha) um projeto.'),
          h('li', {}, 'Em "APIs e serviços" → "Biblioteca", ative a "Google Sheets API".'),
          h('li', {}, 'Em "IAM e administrador" → "Contas de serviço", crie uma conta de serviço.'),
          h('li', {}, 'Abra a conta criada → "Chaves" → "Adicionar chave" → "JSON". Um arquivo será baixado.'),
          h('li', {}, 'Envie esse arquivo aqui e compartilhe a planilha com o e-mail da conta de serviço.'))),
      h('h4', {}, 'Campos que vão para a planilha'),
      colList,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: save }, 'Salvar'),
        h('button', { class: 'btn', onclick: async () => {
          if (!(await save())) return;
          const r = await attempt(() => post(`/integrations/sheets/${state.boardId}/sync`));
          if (r) { toast(r.message, 'ok'); PANELS.sheets(panel); }
        } }, 'Salvar e enviar todos os cards agora')),
      h('p', { class: 'muted small' }, '"Enviar todos" reescreve a aba inteira (cabeçalho + uma linha por card). Não edite a coluna A (ID do card): ela é usada para localizar cada linha.'));
  },

  // ---------------- Notificações ----------------
  async notifications(panel) {
    const c = await get(`/integrations/notifications/${state.boardId}`);
    const f = {
      enabled: h('input', { type: 'checkbox', checked: c.enabled }),
      days_before: h('input', { value: (c.days_before || []).join(', ') }),
      overdue: h('input', { type: 'checkbox', checked: c.overdue }),
      in_app: h('input', { type: 'checkbox', checked: c.in_app }),
      email: h('input', { type: 'checkbox', checked: c.email }),
      extra_emails: h('input', { value: c.extra_emails, placeholder: 'outra@pessoa.com, ...' }),
      webhook_url: h('input', { value: c.webhook_url, placeholder: 'https://hooks.slack.com/... ou Zapier/Make' }),
    };
    const s = {
      host: h('input', { value: c.smtp.host, placeholder: 'smtp.gmail.com' }), port: h('input', { type: 'number', value: c.smtp.port }),
      secure: h('input', { type: 'checkbox', checked: c.smtp.secure }), user: h('input', { value: c.smtp.user }),
      pass: h('input', { type: 'password', value: c.smtp.pass }), from: h('input', { value: c.smtp.from, placeholder: 'Ateliê <contato@...>' }),
    };
    const publicUrl = h('input', { value: c.app.public_url || location.origin });
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    clear(panel,
      h('h3', {}, 'Avisos de prazo de entrega'),
      h('p', { class: 'muted' }, 'O sistema verifica os prazos a cada 10 minutos e avisa os responsáveis do card (ou todos, se o card não tiver responsável). Cards que já chegaram na coluna final não geram aviso.'),
      h('label', { class: 'check' }, f.enabled, ' Avisos ativos'),
      h('label', { class: 'form-row' }, 'Avisar quantos dias antes', f.days_before),
      h('p', { class: 'muted small' }, 'Ex.: "3, 1, 0" = avisa 3 dias antes, 1 dia antes e no dia.'),
      h('label', { class: 'check' }, f.overdue, ' Avisar quando o prazo vencer'),
      h('fieldset', {}, h('legend', {}, 'Canais'),
        h('label', { class: 'check' }, f.in_app, ' No sistema (sininho + notificação do navegador)'),
        h('div', { class: 'row' }, h('span', { class: 'muted small' }, `Notificações do navegador neste computador: ${({ granted: 'permitidas', denied: 'bloqueadas', default: 'não configuradas', unsupported: 'não suportadas' })[perm]}`),
          perm === 'default' ? h('button', { class: 'btn small', onclick: () => Notification.requestPermission().then(() => PANELS.notifications(panel)) }, 'Permitir') : null),
        h('label', { class: 'check' }, f.email, ' Por e-mail'),
        h('label', { class: 'form-row' }, 'E-mails adicionais', f.extra_emails),
        h('label', { class: 'form-row' }, 'Webhook (Slack, Discord, Zapier, Make → WhatsApp)', f.webhook_url)),
      h('fieldset', {}, h('legend', {}, 'Servidor de e-mail (SMTP)'),
        h('label', { class: 'form-row' }, 'Servidor', s.host), h('label', { class: 'form-row' }, 'Porta', s.port),
        h('label', { class: 'check' }, s.secure, ' Conexão segura (SSL, porta 465)'),
        h('label', { class: 'form-row' }, 'Usuário', s.user), h('label', { class: 'form-row' }, 'Senha', s.pass), h('label', { class: 'form-row' }, 'Remetente', s.from),
        h('p', { class: 'muted small' }, 'Gmail: servidor smtp.gmail.com, porta 465 com SSL, e uma "senha de app" gerada em myaccount.google.com/apppasswords.')),
      h('label', { class: 'form-row' }, 'Endereço deste sistema (para links nos avisos)', publicUrl),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => attempt(() => put(`/integrations/notifications/${state.boardId}`, {
          enabled: f.enabled.checked, days_before: f.days_before.value, overdue: f.overdue.checked, in_app: f.in_app.checked,
          email: f.email.checked, extra_emails: f.extra_emails.value, webhook_url: f.webhook_url.value,
          smtp: { host: s.host.value, port: Number(s.port.value), secure: s.secure.checked, user: s.user.value, pass: s.pass.value, from: s.from.value },
          app: { public_url: publicUrl.value },
        }), 'Notificações salvas') }, 'Salvar'),
        h('button', { class: 'btn', onclick: () => attempt(() => post('/integrations/notifications/check'), 'Prazos verificados') }, 'Verificar prazos agora')));
  },

  // ---------------- Usuários ----------------
  async users(panel) {
    const users = await get('/users');
    const roles = [['admin', 'Administrador'], ['member', 'Editor'], ['viewer', 'Somente leitura']];
    const name = h('input', { placeholder: 'Nome' });
    const email = h('input', { type: 'email', placeholder: 'E-mail' });
    const pass = h('input', { type: 'text', placeholder: 'Senha inicial (mín. 6)' });
    const role = h('select', {}, roles.map(([v, l]) => h('option', { value: v, selected: v === 'member' }, l)));
    clear(panel,
      h('h3', {}, 'Usuários com acesso'),
      h('p', { class: 'muted' }, 'Cada alteração em cards fica registrada com o nome de quem fez. Editores mexem nos cards e colunas; administradores também acessam integrações e usuários.'),
      h('table', { class: 'users-table' }, h('tbody', {}, users.map((u) => h('tr', { class: u.active ? '' : 'inactive' },
        h('td', {}, avatar(u, 28)), h('td', {}, h('strong', {}, u.name), h('br'), h('small', { class: 'muted' }, u.email)),
        h('td', {}, h('select', { onchange: (e) => attempt(() => patch(`/users/${u.id}`, { role: e.target.value }), 'Perfil alterado') }, roles.map(([v, l]) => h('option', { value: v, selected: v === u.role }, l)))),
        h('td', {}, h('button', { class: 'btn small', onclick: async () => {
          const p = prompt(`Nova senha para ${u.name}:`);
          if (p) await attempt(() => patch(`/users/${u.id}`, { password: p }), 'Senha redefinida');
        } }, 'Redefinir senha')),
        h('td', {}, h('button', { class: 'btn small subtle', onclick: async () => {
          if (await attempt(() => patch(`/users/${u.id}`, { active: !u.active }), u.active ? 'Acesso bloqueado' : 'Acesso liberado')) PANELS.users(panel);
        } }, u.active ? 'Bloquear' : 'Reativar')))))),
      h('h4', {}, 'Adicionar usuário'),
      h('div', { class: 'row wrap' }, name, email, pass, role,
        h('button', { class: 'btn primary', onclick: async () => {
          if (await attempt(() => post('/users', { name: name.value, email: email.value, password: pass.value, role: role.value }), 'Usuário criado')) PANELS.users(panel);
        } }, 'Adicionar')));
  },

  // ---------------- Conta ----------------
  async account(panel) {
    const cur = h('input', { type: 'password', placeholder: 'Senha atual' });
    const next = h('input', { type: 'password', placeholder: 'Nova senha' });
    clear(panel,
      h('h3', {}, 'Minha conta'),
      h('p', {}, `${state.user.name} — ${state.user.email}`),
      h('h4', {}, 'Trocar senha'),
      h('div', { class: 'row wrap' }, cur, next,
        h('button', { class: 'btn primary', onclick: () => attempt(() => post('/auth/password', { current: cur.value, password: next.value }), 'Senha alterada') }, 'Salvar')));
  },
};

function backgroundPicker(current, onPick) {
  const wrap = h('div', { class: 'bg-picker' });
  const draw = (sel) => clear(wrap,
    Object.entries(BACKGROUNDS).map(([key, b]) => h('button', {
      type: 'button', class: `bg-option${key === sel ? ' active' : ''}`, title: b.name, style: { background: b.css },
      onclick: () => { onPick(key); draw(key); },
    }, h('span', {}, b.name))),
    h('div', { class: 'muted small' }, 'Ou uma cor sólida:'),
    colorPicker(/^#/.test(sel) ? sel : null, (c) => { if (c) { onPick(c); draw(c); } }, { allowNone: false }));
  draw(current);
  return wrap;
}

function fieldDefEditor(f, index, redraw) {
  const name = h('input', { value: f.name });
  const show = h('input', { type: 'checkbox', checked: f.show_on_card });
  let options = f.options.map((o) => ({ ...o }));
  const optBox = h('div', { class: 'options' });
  const drawOptions = () => clear(optBox, options.map((o, i) => {
    const sw = h('button', { class: 'swatch', style: { background: o.color }, onclick: (e) => {
      const p = colorPicker(o.color, (c) => { o.color = c || '#dfe1e6'; p.remove(); drawOptions(); }, { allowNone: false });
      e.currentTarget.parentElement.after(p);
    } });
    return h('div', { class: 'row' }, sw, h('input', { value: o.label, oninput: (e) => { o.label = e.target.value; } }),
      h('button', { class: 'icon-btn', title: 'Remover opção', onclick: () => { options.splice(i, 1); drawOptions(); } }, icon('x')));
  }), h('button', { class: 'btn small', onclick: () => { options.push({ label: `Opção ${options.length + 1}`, color: PALETTE[options.length % 9] }); drawOptions(); } }, '+ Opção'));
  if (['select', 'multiselect'].includes(f.type)) drawOptions();
  const move = async (dir) => {
    const other = state.fields[index + dir];
    if (!other) return;
    await patch(`/fields/${f.id}`, { position: other.position });
    await patch(`/fields/${other.id}`, { position: f.position });
    redraw();
  };
  return h('div', { class: 'field-def' },
    h('div', { class: 'row' },
      h('div', { class: 'reorder' }, h('button', { class: 'icon-btn', disabled: index === 0, onclick: () => move(-1) }, '↑'), h('button', { class: 'icon-btn', disabled: index === state.fields.length - 1, onclick: () => move(1) }, '↓')),
      name,
      h('span', { class: 'chip' }, FIELD_TYPES.find(([v]) => v === f.type)?.[1]),
      h('label', { class: 'check' }, show, ' Mostrar no card'),
      h('button', { class: 'btn small primary', onclick: async () => {
        if (await attempt(() => patch(`/fields/${f.id}`, { name: name.value, show_on_card: show.checked, options: ['select', 'multiselect'].includes(f.type) ? options : undefined }), 'Campo salvo')) redraw();
      } }, 'Salvar'),
      h('button', { class: 'btn small subtle', onclick: async () => {
        if (await confirmDialog(`Excluir o campo "${f.name}"? Os valores preenchidos em todos os cards serão apagados.`)) { await attempt(() => del(`/fields/${f.id}`)); redraw(); }
      } }, 'Excluir')),
    optBox.childElementCount ? optBox : null);
}
