// Relatório de produção: quanto tempo os cards levam da coluna inicial até a final
import { h, clear, fmtDuration, fmtDateTime } from './util.js';
import { get, modal } from './api.js';
import { state } from './state.js';

export function openMetrics(openCardFn) {
  const m = modal({ title: 'Tempo de produção', wide: true });
  const period = h('select', { onchange: () => draw() },
    [['30', 'Últimos 30 dias'], ['90', 'Últimos 90 dias'], ['365', 'Último ano'], ['0', 'Todo o período']].map(([v, l]) => h('option', { value: v }, l)));
  const content = h('div', {});
  m.body.append(h('div', { class: 'row' }, h('label', {}, 'Concluídos em: ', period)), content);

  async function draw() {
    clear(content, h('p', { class: 'muted' }, 'Calculando…'));
    const r = await get(`/boards/${state.boardId}/metrics?days=${period.value}`);
    const maxCol = Math.max(1, ...r.per_column.map((c) => c.avg));
    const row = (c) => h('tr', { class: 'clickable', onclick: () => { m.close(); openCardFn(c.id); } },
      h('td', {}, c.title), h('td', {}, c.column_name), h('td', {}, fmtDateTime(c.cycle_started_at)),
      h('td', {}, c.cycle_ended_at ? fmtDateTime(c.cycle_ended_at) : '—'),
      h('td', { class: 'num' }, fmtDuration(c.ms)),
      h('td', {}, c.due_date ? h('span', { class: `chip ${c.late ? 'late' : 'ok'}` }, c.late ? 'Atrasado' : 'No prazo') : '—'));
    const s = r.summary;
    clear(content,
      h('p', { class: 'muted' }, `Medindo de "${r.start?.name}" até "${r.end?.name}". Ajuste em Configurações → Cronômetro de produção.`),
      h('div', { class: 'stats-row big' },
        stat('Concluídos', String(s.count)),
        stat('Tempo médio', fmtDuration(s.avg)),
        stat('Mediana', fmtDuration(s.median)),
        stat('Mais rápido', fmtDuration(s.min)),
        stat('Mais lento', fmtDuration(s.max)),
        stat('Entregues no prazo', r.on_time == null ? '—' : `${Math.round(r.on_time * 100)}%`),
        stat('Em produção agora', String(r.wip.length))),
      h('h3', {}, 'Tempo médio em cada etapa'),
      r.per_column.length ? h('div', { class: 'bars' }, r.per_column.map((c) => h('div', { class: 'bar-row' },
        h('span', { class: 'bar-label' }, c.name),
        h('span', { class: 'bar' }, h('span', { style: { width: `${(c.avg / maxCol) * 100}%`, background: c.color } })),
        h('span', { class: 'bar-value' }, fmtDuration(c.avg))))) : h('p', { class: 'muted' }, 'Ainda não há cards concluídos neste período.'),
      h('h3', {}, `Em produção (${r.wip.length})`),
      table(r.wip.map(row), 'Há quanto tempo'),
      h('h3', {}, `Concluídos (${r.done.length})`),
      table(r.done.map(row), 'Tempo total'));
  }
  draw();
}

const stat = (label, value) => h('div', { class: 'stat' }, h('small', {}, label), h('strong', {}, value));

function table(rows, timeLabel) {
  if (!rows.length) return h('p', { class: 'muted' }, 'Nenhum card.');
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Card', 'Coluna', 'Início', 'Fim', timeLabel, 'Prazo'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows)));
}
