'use strict';
// Regras puras do cronômetro de produção (sem acesso ao banco, fáceis de testar)

/**
 * Define as colunas de início e fim do ciclo de produção.
 * Sem configuração: começa na primeira coluna e termina na última.
 */
function resolveCycleColumns(columns, startId, endId) {
  const ordered = [...columns].sort((a, b) => a.position - b.position);
  if (!ordered.length) return { start: null, end: null, ordered };
  const start = ordered.find((c) => c.id === startId) || ordered[0];
  const end = ordered.find((c) => c.id === endId) || ordered[ordered.length - 1];
  return { start, end, ordered };
}

/**
 * Calcula os novos marcos de produção quando um card entra numa coluna.
 * - Entrou na coluna inicial (ou em qualquer coluna depois dela) pela 1ª vez → inicia.
 * - Entrou na coluna final → encerra (se não tinha iniciado, inicia agora também).
 * - Saiu da coluna final → reabre (o tempo continua contando do início original).
 */
function computeCycle({ columns, startId, endId, toColumnId, card, at }) {
  const { start, end, ordered } = resolveCycleColumns(columns, startId, endId);
  let started = card.cycle_started_at || null;
  let ended = card.cycle_ended_at || null;
  if (!start) return { cycle_started_at: started, cycle_ended_at: ended };
  const idx = (id) => ordered.findIndex((c) => c.id === id);
  const toIdx = idx(toColumnId);
  if (!started && toIdx >= idx(start.id)) started = at;
  if (toColumnId === end.id) {
    if (!started) started = at;
    if (!ended) ended = at;
  } else {
    ended = null;
  }
  return { cycle_started_at: started, cycle_ended_at: ended };
}

/** Tempo (ms) que o card passou em cada coluna, a partir do histórico de movimentações. */
function columnDurations(movements, untilISO = new Date().toISOString()) {
  const sorted = [...movements].sort((a, b) => a.moved_at.localeCompare(b.moved_at) || a.id - b.id);
  const totals = {};
  sorted.forEach((m, i) => {
    const endAt = sorted[i + 1]?.moved_at || untilISO;
    const ms = Math.max(0, Date.parse(endAt) - Date.parse(m.moved_at));
    totals[m.to_column_id] = (totals[m.to_column_id] || 0) + ms;
  });
  return totals;
}

function cycleMs(card, nowISO = new Date().toISOString()) {
  if (!card.cycle_started_at) return null;
  return Date.parse(card.cycle_ended_at || nowISO) - Date.parse(card.cycle_started_at);
}

function stats(values) {
  if (!values.length) return { count: 0, avg: null, median: null, min: null, max: null };
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    count: s.length,
    avg: s.reduce((a, b) => a + b, 0) / s.length,
    median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    min: s[0],
    max: s[s.length - 1],
  };
}

module.exports = { resolveCycleColumns, computeCycle, columnDurations, cycleMs, stats };
