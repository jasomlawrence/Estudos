// Configurações → Automações: regras "Quando… Se… Então…" do quadro
import { h, clear, PALETTE, icon } from './util.js';
import { get, post, put, del, attempt, confirmDialog, toast } from './api.js';
import { state } from './state.js';
import { sortChoices, SORT_DIRS } from './board.js';

const TRIGGERS = [
  ['always', 'Sempre que o card atender às condições (destaque visual)'],
  ['match', 'Quando o card passar a atender às condições (ex.: prazo chegando)'],
  ['moved', 'Quando o card for movido'],
  ['created', 'Quando um card for criado'],
  ['label_added', 'Quando uma etiqueta for adicionada'],
  ['field_changed', 'Quando um campo for alterado'],
];
const CONDITIONS = [
  ['due_within', 'Prazo de entrega nos próximos… dias'], ['overdue', 'Prazo vencido'], ['no_due', 'Sem prazo de entrega'],
  ['has_label', 'Tem a etiqueta'], ['not_label', 'Não tem a etiqueta'], ['in_column', 'Está na coluna'], ['not_in_column', 'Não está na coluna'],
  ['field', 'Campo'], ['no_members', 'Sem responsável'], ['not_done', 'Produção não concluída'], ['done', 'Produção concluída'], ['source', 'Origem do card'],
];
const ACTIONS = [
  ['notify', 'Avisar pessoas (sininho, navegador e e-mail)'], ['webhook', 'Enviar para webhook (WhatsApp via Zapier/Make, Slack…)'],
  ['add_label', 'Adicionar etiqueta'], ['remove_label', 'Remover etiqueta'], ['add_member', 'Adicionar responsável'],
  ['set_color', 'Mudar a cor do card'], ['move', 'Mover para a coluna'], ['sort', 'Ordenar a coluna do card'],
];
const OPS = {
  text: [['contains', 'contém'], ['equals', 'é igual a'], ['not_equals', 'é diferente de']],
  number: [['equals', '='], ['gt', 'maior que'], ['lt', 'menor que'], ['not_equals', 'diferente de']],
  date: [['equals', 'é o dia'], ['gt', 'depois de'], ['lt', 'antes de']],
  select: [['equals', 'é'], ['not_equals', 'não é']],
  checkbox: [['equals', 'é']],
};
const CHECKLIST_OPS = [['complete', 'está todo marcado'], ['incomplete', 'tem itens sem marcar'], ['filled', 'tem algum item marcado'], ['empty', 'não tem nada marcado']];
const noValueOps = new Set(['filled', 'empty', 'complete', 'incomplete']);
const opsFor = (def) => (def?.type === 'checklist' ? CHECKLIST_OPS : [...(OPS[{ textarea: 'text', url: 'text', email: 'text', phone: 'text', currency: 'number', datetime: 'date', multiselect: 'select' }[def?.type] || def?.type] || OPS.text),
  ['filled', 'está preenchido'], ['empty', 'está vazio']]);
// Cores fortes para a borda (as pastéis do quadro somem no fundo claro)
const RING_COLORS = ['#ff4d6d', '#ff8a3d', '#f5b700', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#475569'];

const name = (list, id) => list.find((x) => x.id === Number(id))?.name ?? '?';
const columnsText = (ids) => (ids?.length ? ids.map((id) => name(state.columns, id)).join(' ou ') : 'qualquer coluna');

/** Frase que resume a regra na lista */
function summary(rule) {
  const t = rule.trigger;
  const when = {
    always: 'Sempre',
    match: 'Quando passar a atender',
    moved: `Ao mover para ${columnsText(t.columns)}`,
    created: 'Ao criar card',
    label_added: `Ao adicionar ${t.labels?.length ? t.labels.map((id) => `"${state.labels.find((l) => l.id === id)?.name || '?'}"`).join(' ou ') : 'qualquer etiqueta'}`,
    field_changed: `Ao alterar ${t.field ? `"${state.fields.find((f) => f.id === t.field)?.name || '?'}"` : 'qualquer campo'}`,
  }[t.type];
  const cond = rule.conditions.map((c) => {
    const label = CONDITIONS.find(([k]) => k === c.type)?.[1] || c.type;
    if (c.type === 'due_within') return `prazo em até ${c.days} dia(s)`;
    if (c.type === 'has_label' || c.type === 'not_label') return `${c.type === 'not_label' ? 'sem' : 'com'} etiqueta "${state.labels.find((l) => l.id === c.label)?.name || '?'}"`;
    if (c.type === 'in_column' || c.type === 'not_in_column') return `${c.type === 'not_in_column' ? 'fora de' : 'em'} ${columnsText(c.columns)}`;
    if (c.type === 'field') {
      const def = state.fields.find((f) => f.id === c.field);
      const op = opsFor(def).find(([k]) => k === c.op)?.[1] || c.op;
      const value = noValueOps.has(c.op) ? '' : ` "${def?.options?.find((o) => o.id === c.value)?.label ?? (c.value === true || c.value === 'true' ? 'Sim' : c.value === 'false' ? 'Não' : c.value)}"`;
      return `"${def?.name || '?'}" ${op}${value}`;
    }
    return label.toLowerCase();
  });
  const then = rule.actions.map((a) => ({
    highlight: `borda ${a.text ? `+ aviso "${a.text}"` : 'colorida'}`,
    notify: `avisar ${a.to === 'users' ? a.users.map((id) => name(state.users, id)).join(', ') || 'pessoas' : { members: 'responsáveis', all: 'todos', admins: 'administradores' }[a.to]}`,
    webhook: 'webhook',
    add_label: `etiqueta "${state.labels.find((l) => l.id === a.label)?.name || '?'}"`,
    remove_label: `tirar etiqueta "${state.labels.find((l) => l.id === a.label)?.name || '?'}"`,
    add_member: `responsável ${name(state.users, a.user)}`,
    set_color: 'mudar cor',
    move: `mover para ${name(state.columns, a.column)}`,
    sort: `ordenar a coluna por ${(sortChoices().find(([v]) => v === a.by)?.[1] || 'prazo').replace('Campo: ', '').toLowerCase()}`,
  })[a.type]);
  return h('span', {}, h('b', {}, when), cond.length ? ` · se ${cond.join(' e ')}` : '', ' → ', then.join(', ') || 'nada');
}

// ---------- Componentes do editor ----------
function sel(options, value, onchange, attrs = {}) {
  return h('select', { ...attrs, onchange: (e) => onchange(e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, l)));
}

/** Botões liga/desliga para escolher vários itens (colunas, etiquetas, pessoas) */
function chips(items, selected, onchange, { color } = {}) {
  const set = new Set((selected || []).map(Number));
  return h('div', { class: 'chip-picker' }, items.map((it) => h('button', {
    type: 'button', class: `chip-toggle${set.has(it.id) ? ' on' : ''}`,
    style: color ? { '--chip': color(it) } : {},
    onclick: (e) => { set.has(it.id) ? set.delete(it.id) : set.add(it.id); e.currentTarget.classList.toggle('on'); onchange([...set]); },
  }, it.name || ' ')));
}

function ringColors(value, onpick) {
  const custom = h('input', { type: 'color', value: value || '#ff4d6d', title: 'Outra cor', oninput: (e) => { mark(e.target.value); onpick(e.target.value); } });
  const buttons = RING_COLORS.map((c) => h('button', { type: 'button', class: 'ring-swatch', style: { '--c': c }, title: c, onclick: () => { mark(c); onpick(c); } }));
  const mark = (c) => buttons.forEach((b, i) => b.classList.toggle('on', RING_COLORS[i] === c));
  mark(value);
  return h('div', { class: 'row wrap ring-colors' }, buttons, custom);
}

function fieldValueInput(def, value, onchange) {
  if (!def) return null;
  if (def.type === 'select' || def.type === 'multiselect') return sel([['', '—'], ...def.options.map((o) => [o.id, o.label])], value, onchange);
  if (def.type === 'checkbox') return sel([['true', 'Sim'], ['false', 'Não']], value === false || value === 'false' ? 'false' : 'true', onchange);
  const type = { date: 'date', datetime: 'date', number: 'number', currency: 'number' }[def.type] || 'text';
  return h('input', { type, value: value ?? '', placeholder: 'valor', oninput: (e) => onchange(e.target.value) });
}

function conditionRow(c, onremove, redraw) {
  const params = [];
  if (c.type === 'due_within') params.push(h('input', { type: 'number', min: 0, value: c.days ?? 2, style: { width: '70px' }, oninput: (e) => { c.days = Number(e.target.value); } }), 'dia(s)');
  if (c.type === 'has_label' || c.type === 'not_label') {
    c.label ??= state.labels[0]?.id;
    params.push(sel(state.labels.map((l) => [l.id, l.name || l.color]), c.label, (v) => { c.label = Number(v); }));
  }
  if (c.type === 'in_column' || c.type === 'not_in_column') params.push(chips(state.columns, c.columns, (v) => { c.columns = v; }, { color: (col) => col.color }));
  if (c.type === 'source') { c.source ??= 'shopify'; params.push(sel([['shopify', 'Pedido do Shopify'], ['manual', 'Criado à mão']], c.source, (v) => { c.source = v; })); }
  if (c.type === 'field') {
    c.field ??= state.fields[0]?.id;
    const def = state.fields.find((f) => f.id === Number(c.field));
    if (!opsFor(def).some(([k]) => k === c.op)) c.op = opsFor(def)[0][0];
    params.push(
      sel(state.fields.map((f) => [f.id, f.name]), c.field, (v) => { c.field = Number(v); c.value = ''; redraw(); }),
      sel(opsFor(def), c.op, (v) => { c.op = v; redraw(); }),
      noValueOps.has(c.op) ? null : fieldValueInput(def, c.value, (v) => { c.value = v; }));
  }
  return h('div', { class: 'rule-line' },
    sel(CONDITIONS, c.type, (v) => { for (const k of Object.keys(c)) delete c[k]; c.type = v; redraw(); }),
    ...params,
    h('button', { type: 'button', class: 'icon-btn', title: 'Remover condição', onclick: onremove }, icon('x', 14)));
}

function actionRow(a, visual, onremove, redraw) {
  const params = [];
  if (a.type === 'highlight') {
    a.color ??= RING_COLORS[0];
    params.push(h('div', { class: 'grow' },
      ringColors(a.color, (c) => { a.color = c; }),
      h('input', { value: a.text || '', maxLength: 40, placeholder: 'Aviso no card (opcional), ex.: Prazo próximo', oninput: (e) => { a.text = e.target.value; } })));
  }
  if (a.type === 'notify') {
    a.to ??= 'members';
    params.push(h('div', { class: 'grow stack' },
      h('div', { class: 'row wrap' }, 'Para:', sel([['members', 'Responsáveis do card (ou todos, se não houver)'], ['users', 'Pessoas escolhidas'], ['admins', 'Administradores'], ['all', 'Todos os usuários']], a.to, (v) => { a.to = v; redraw(); })),
      a.to === 'users' ? chips(state.users, a.users, (v) => { a.users = v; }) : null,
      h('textarea', { rows: 2, value: a.message || '', placeholder: 'Mensagem (opcional). Ex.: {titulo} chegou em {coluna} — prazo {prazo}', oninput: (e) => { a.message = e.target.value; } }),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!a.email, onchange: (e) => { a.email = e.target.checked; } }), ' Também por e-mail (usa o SMTP de Notificações)')));
  }
  if (a.type === 'webhook') {
    params.push(h('div', { class: 'grow stack' },
      h('input', { value: a.url || '', placeholder: 'https://hooks.zapier.com/… ou https://hook.make.com/…', oninput: (e) => { a.url = e.target.value; } }),
      h('textarea', { rows: 2, value: a.message || '', placeholder: 'Mensagem (opcional). Ex.: {titulo} foi para {coluna}', oninput: (e) => { a.message = e.target.value; } })));
  }
  if (a.type === 'add_label' || a.type === 'remove_label') { a.label ??= state.labels[0]?.id; params.push(sel(state.labels.map((l) => [l.id, l.name || l.color]), a.label, (v) => { a.label = Number(v); })); }
  if (a.type === 'add_member') { a.user ??= state.users[0]?.id; params.push(sel(state.users.map((u) => [u.id, u.name]), a.user, (v) => { a.user = Number(v); })); }
  if (a.type === 'sort') {
    a.by ??= 'due_date'; a.dir ??= 'asc';
    params.push(sel(sortChoices(), a.by, (v) => { a.by = v; }), sel(SORT_DIRS, a.dir, (v) => { a.dir = v; }));
  }
  if (a.type === 'move') { a.column ??= state.columns[0]?.id; params.push(sel(state.columns.map((c) => [c.id, c.name]), a.column, (v) => { a.column = Number(v); })); }
  if (a.type === 'set_color') {
    a.color ??= PALETTE[0];
    const sw = h('div', { class: 'row wrap' }, PALETTE.slice(0, 12).map((c) => h('button', { type: 'button', class: `swatch${a.color === c ? ' on' : ''}`, style: { background: c }, onclick: (e) => {
      a.color = c; for (const b of sw.children) b.classList.remove('on'); e.currentTarget.classList.add('on');
    } })));
    params.push(sw);
  }
  return h('div', { class: 'rule-line' },
    visual ? h('span', { class: 'rule-tag' }, 'Cor da borda') : sel(ACTIONS, a.type, (v) => { for (const k of Object.keys(a)) delete a[k]; a.type = v; redraw(); }),
    ...params,
    visual ? null : h('button', { type: 'button', class: 'icon-btn', title: 'Remover ação', onclick: onremove }, icon('x', 14)));
}

function editor(rule, onsaved, oncancel) {
  const box = h('div', { class: 'rule-editor' });
  const draw = () => {
    const visual = rule.trigger.type === 'always';
    if (visual) rule.actions = [rule.actions.find((a) => a.type === 'highlight') || { type: 'highlight' }];
    else rule.actions = rule.actions.filter((a) => a.type !== 'highlight');
    const t = rule.trigger;
    clear(box,
      h('label', { class: 'form-row' }, 'Nome da automação', h('input', { value: rule.name || '', placeholder: 'Ex.: Avisar ourives quando chegar na Fundição', oninput: (e) => { rule.name = e.target.value; } })),
      h('div', { class: 'rule-block' }, h('div', { class: 'rule-step' }, 'Quando'),
        sel(TRIGGERS, t.type, (v) => { rule.trigger = { type: v }; draw(); }),
        t.type === 'moved' ? h('div', { class: 'stack' }, h('small', { class: 'muted' }, 'Para a coluna (nenhuma marcada = qualquer):'), chips(state.columns, t.columns, (v) => { t.columns = v; }, { color: (c) => c.color })) : null,
        t.type === 'label_added' ? h('div', { class: 'stack' }, h('small', { class: 'muted' }, 'Etiqueta (nenhuma marcada = qualquer):'), chips(state.labels, t.labels, (v) => { t.labels = v; }, { color: (l) => l.color })) : null,
        t.type === 'field_changed' ? sel([['', 'Qualquer campo'], ...state.fields.map((f) => [f.id, f.name])], t.field, (v) => { t.field = Number(v) || null; }) : null,
        t.type === 'always' ? h('p', { class: 'muted small' }, 'A borda aparece enquanto o card atender às condições e some sozinha quando deixar de atender. Condições de prazo são reavaliadas a cada minuto.') : null,
        t.type === 'match' ? h('p', { class: 'muted small' }, 'Executa uma vez quando o card entra na condição (verificado a cada alteração e a cada 10 minutos). Se sair e voltar, executa de novo.') : null),
      h('div', { class: 'rule-block' }, h('div', { class: 'rule-step' }, 'Se', h('small', { class: 'muted' }, rule.trigger.type === 'match' || visual ? ' (pelo menos uma)' : ' (opcional)')),
        rule.conditions.map((c, i) => conditionRow(c, () => { rule.conditions.splice(i, 1); draw(); }, draw)),
        h('button', { type: 'button', class: 'btn small', onclick: () => { rule.conditions.push({ type: visual ? 'due_within' : 'has_label', days: 2 }); draw(); } }, '+ Condição')),
      h('div', { class: 'rule-block' }, h('div', { class: 'rule-step' }, 'Então'),
        rule.actions.map((a, i) => actionRow(a, visual, () => { rule.actions.splice(i, 1); draw(); }, draw)),
        visual ? null : h('button', { type: 'button', class: 'btn small', onclick: () => { rule.actions.push({ type: 'notify' }); draw(); } }, '+ Ação')),
      h('p', { class: 'muted small' }, 'Na mensagem: {titulo}, {coluna}, {prazo}, {usuario} (quem mexeu), {link} e {campo:Nome do campo}.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          if ((visual || rule.trigger.type === 'match') && !rule.conditions.length) return toast('Adicione pelo menos uma condição.', 'error');
          if (!rule.actions.length) return toast('Adicione pelo menos uma ação.', 'error');
          const ok = rule.id ? await attempt(() => put(`/automations/${rule.id}`, rule), 'Automação salva') : await attempt(() => post(`/boards/${state.boardId}/automations`, rule), 'Automação criada');
          if (ok) onsaved();
        } }, 'Salvar automação'),
        h('button', { class: 'btn subtle', onclick: oncancel }, 'Cancelar')));
  };
  draw();
  return box;
}

const label = (n) => state.labels.find((l) => (l.name || '').toLowerCase().includes(n))?.id;
const TEMPLATES = [
  ['Borda laranja: prazo em até 3 dias', () => ({ name: 'Prazo chegando', trigger: { type: 'always' }, conditions: [{ type: 'due_within', days: 3 }], actions: [{ type: 'highlight', color: '#ff8a3d', text: 'Prazo próximo' }] })],
  ['Borda vermelha: prazo vencido', () => ({ name: 'Atrasado', trigger: { type: 'always' }, conditions: [{ type: 'overdue' }], actions: [{ type: 'highlight', color: '#ff4d6d', text: 'Atrasado' }] })],
  ['Borda com etiqueta "Urgente"', () => ({ name: 'Urgente', trigger: { type: 'always' }, conditions: [{ type: 'has_label', label: label('urgente') ?? state.labels[0]?.id }], actions: [{ type: 'highlight', color: '#8b5cf6' }] })],
  ['Avisar ao mover para uma coluna', () => ({ name: 'Card chegou na etapa', trigger: { type: 'moved', columns: [state.columns[2]?.id].filter(Boolean) }, conditions: [], actions: [{ type: 'notify', to: 'users', users: [], message: '{titulo} chegou em {coluna}' }] })],
  ['Ordenar a coluna quando um card entrar', () => ({ name: 'Manter coluna ordenada por prazo', trigger: { type: 'moved', columns: [state.columns[0]?.id].filter(Boolean) }, conditions: [], actions: [{ type: 'sort', by: 'due_date', dir: 'asc' }] })],
  ['Checklist completo → mover', () => {
    const f = state.fields.find((x) => x.type === 'checklist');
    return { name: 'Checklist completo', trigger: { type: 'field_changed', field: f?.id || null }, conditions: f ? [{ type: 'field', field: f.id, op: 'complete' }] : [], actions: [{ type: 'move', column: state.columns.at(-1)?.id }] };
  }],
  ['Avisar responsáveis: vence em 2 dias', () => ({ name: 'Vence em 2 dias', trigger: { type: 'match' }, conditions: [{ type: 'due_within', days: 2 }], actions: [{ type: 'notify', to: 'members', message: '⏰ {titulo} vence em {prazo} e está em {coluna}' }] })],
];

export async function automationsPanel(panel) {
  const list = await get(`/boards/${state.boardId}/automations`);
  const redraw = () => automationsPanel(panel);
  const editArea = h('div', {});
  const openEditor = (rule) => {
    clear(editArea, editor(JSON.parse(JSON.stringify(rule)), redraw, () => clear(editArea)));
    editArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const move = async (i, dir) => {
    const ids = list.map((r) => r.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    if (await attempt(() => put(`/boards/${state.boardId}/automations-order`, { ids }))) redraw();
  };
  clear(panel,
    h('h3', {}, 'Automações'),
    h('p', { class: 'muted' }, 'Regras que agem sozinhas: pintam a borda do card (prazo perto, etiqueta, valor de um campo) ou disparam ações quando algo acontece (mover para uma coluna, criar card, adicionar etiqueta) — como avisar uma pessoa, mandar para o WhatsApp via webhook, pôr etiqueta ou mover o card. Tudo fica registrado no histórico do card.'),
    h('div', { class: 'row wrap templates' }, h('span', { class: 'muted small' }, 'Começar de um modelo:'),
      TEMPLATES.map(([title, make]) => h('button', { class: 'btn small', onclick: () => openEditor({ enabled: true, ...make() }) }, title)),
      h('button', { class: 'btn small primary', onclick: () => openEditor({ name: '', enabled: true, trigger: { type: 'moved', columns: [] }, conditions: [], actions: [{ type: 'notify', to: 'members' }] }) }, '+ Nova automação')),
    editArea,
    list.length ? h('ul', { class: 'rule-list' }, list.map((r, i) => {
      const ring = r.actions.find((a) => a.type === 'highlight');
      return h('li', { class: `rule-item${r.enabled ? '' : ' off'}` },
        h('label', { class: 'switch', title: r.enabled ? 'Ativa' : 'Desligada' }, h('input', { type: 'checkbox', checked: r.enabled, onchange: async (e) => {
          if (await attempt(() => put(`/automations/${r.id}`, { ...r, enabled: e.target.checked }), e.target.checked ? 'Automação ligada' : 'Automação desligada')) redraw();
        } }), h('span', {})),
        ring ? h('span', { class: 'rule-ring', style: { '--c': ring.color }, title: 'Cor da borda' }) : h('span', { class: 'rule-icon' }, icon('bell', 15)),
        h('div', { class: 'grow' }, h('strong', {}, r.name), h('div', { class: 'small muted' }, summary(r)),
          r.run_count ? h('div', { class: 'small muted' }, `Executada ${r.run_count} vez(es)${r.last_run_at ? `, a última em ${new Date(r.last_run_at).toLocaleString('pt-BR')}` : ''}`) : null),
        h('button', { class: 'icon-btn', title: 'Subir', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'icon-btn', title: 'Descer', disabled: i === list.length - 1, onclick: () => move(i, 1) }, '↓'),
        h('button', { class: 'btn small', onclick: () => openEditor(r) }, 'Editar'),
        h('button', { class: 'btn small subtle', onclick: async () => {
          if (await confirmDialog(`Excluir a automação "${r.name}"?`)) { await attempt(() => del(`/automations/${r.id}`), 'Automação excluída'); redraw(); }
        } }, 'Excluir'));
    })) : h('p', { class: 'muted empty-rules' }, 'Nenhuma automação ainda. Escolha um modelo acima para começar.'),
    list.some((r) => r.trigger.type === 'always') ? h('p', { class: 'muted small' }, 'Se o card atender a mais de uma regra de borda, aparecem até 3 bordas, na ordem da lista.') : null);
}
