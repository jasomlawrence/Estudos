'use strict';
// Condições das automações (funções puras, sem banco — fáceis de testar)

const DAY = 864e5;
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);

/** O valor do campo atende à comparação? (op: filled, empty, equals, not_equals, contains, gt, lt) */
function fieldMatches(def, value, op, expected) {
  if (op === 'filled') return !isEmpty(value);
  if (op === 'empty') return isEmpty(value);
  if (!def || isEmpty(value)) return op === 'not_equals' && !isEmpty(expected);
  switch (def.type) {
    case 'checkbox': {
      const want = expected === true || expected === 'true' || expected === '1';
      return op === 'not_equals' ? !!value !== want : !!value === want;
    }
    case 'select':
      return op === 'not_equals' ? value !== expected : value === expected;
    case 'multiselect': {
      const has = value.includes(expected);
      return op === 'not_equals' ? !has : has;
    }
    case 'number':
    case 'currency': {
      const a = Number(value);
      const b = Number(String(expected).replace(',', '.'));
      if (!Number.isFinite(b)) return false;
      return { equals: a === b, not_equals: a !== b, gt: a > b, lt: a < b }[op] ?? false;
    }
    case 'date':
    case 'datetime': {
      const a = String(value).slice(0, 10);
      const b = String(expected).slice(0, 10);
      return { equals: a === b, not_equals: a !== b, gt: a > b, lt: a < b }[op] ?? false;
    }
    default: {
      const a = fold(value);
      const b = fold(expected);
      return { equals: a === b, not_equals: a !== b, contains: a.includes(b) }[op] ?? false;
    }
  }
}

/**
 * card: formato de serializeCards (labels e members como listas de ids, fields por id do campo).
 * ctx: { now (ms), fields (definições dos campos do quadro) }
 */
function conditionMatches(card, cond, ctx) {
  const done = !!card.cycle_ended_at;
  const due = card.due_date ? Date.parse(card.due_date) : null;
  switch (cond.type) {
    case 'due_within': return !done && due !== null && due >= ctx.now && due - ctx.now <= Number(cond.days || 0) * DAY;
    case 'overdue': return !done && due !== null && due < ctx.now;
    case 'no_due': return due === null;
    case 'done': return done;
    case 'not_done': return !done;
    case 'has_label': return card.labels.includes(Number(cond.label));
    case 'not_label': return !card.labels.includes(Number(cond.label));
    case 'in_column': return (cond.columns || []).map(Number).includes(card.column_id);
    case 'not_in_column': return !(cond.columns || []).map(Number).includes(card.column_id);
    case 'no_members': return !card.members.length;
    case 'source': return card.source === cond.source;
    case 'field': {
      const def = ctx.fields.find((f) => f.id === Number(cond.field));
      return fieldMatches(def, card.fields[cond.field], cond.op || 'filled', cond.value);
    }
    default: return false;
  }
}

const cardMatches = (card, conditions, ctx) => (conditions || []).every((c) => conditionMatches(card, c, ctx));

/** Destaques visuais (cor de borda + aviso) das regras "sempre" que o card atende, na ordem das regras */
function highlightsFor(card, rules, ctx) {
  const out = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger.type !== 'always' || !cardMatches(card, rule.conditions, ctx)) continue;
    for (const a of rule.actions) if (a.type === 'highlight') out.push({ rule: rule.id, name: rule.name, color: a.color || '#ff6b6b', text: a.text || '' });
  }
  return out;
}

/** O evento dispara a regra? (antes de conferir as condições) */
function triggerMatches(trigger, evt) {
  if (trigger.type !== evt.type) return false;
  const anyOf = (list, value) => !list?.length || list.map(Number).includes(Number(value));
  if (evt.type === 'moved') return anyOf(trigger.columns, evt.toColumnId) && anyOf(trigger.from, evt.fromColumnId);
  if (evt.type === 'label_added') return anyOf(trigger.labels, evt.labelId);
  if (evt.type === 'field_changed') return !trigger.field || Number(trigger.field) === Number(evt.fieldId);
  return true;
}

/** Texto com {titulo}, {coluna}, {prazo}, {usuario}, {regra} e {campo:Nome} substituídos */
function renderMessage(template, vars) {
  return String(template || '').replace(/\{([^}]+)\}/g, (m, key) => {
    const k = fold(key);
    if (k.startsWith('campo:')) return vars.fieldsByName?.[fold(key.slice(6))] ?? '';
    return vars[k] ?? m;
  });
}

module.exports = { fieldMatches, conditionMatches, cardMatches, highlightsFor, triggerMatches, renderMessage, fold };
