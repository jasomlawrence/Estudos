'use strict';
// Integração com a API de Prazo dos Correios (clientes com contrato / cartão de postagem).
// Usada para definir o prazo interno do card: data de entrega prometida − prazo dos Correios.
const { getSetting } = require('./db');

const HOSTS = { producao: 'https://api.correios.com.br', homologacao: 'https://apihom.correios.com.br' };
// Permite apontar para um servidor de testes (ex.: CORREIOS_API_URL=http://localhost:4000)
if (process.env.CORREIOS_API_URL) HOSTS.producao = HOSTS.homologacao = process.env.CORREIOS_API_URL;
const SERVICES = [
  { code: '03220', label: 'SEDEX (contrato)' },
  { code: '03298', label: 'PAC (contrato)' },
  { code: '03140', label: 'SEDEX 12 (contrato)' },
  { code: '03158', label: 'SEDEX 10 (contrato)' },
];

function getConfig() {
  return {
    enabled: false,
    environment: 'producao',
    usuario: '',
    codigo_acesso: '',
    cartao: '',
    contrato: '',
    cep_origem: '',
    servico: '03220',
    promised_source: 'property', // property | attribute | days
    promised_name: 'Data de entrega',
    promised_days: 30,
    margem_dias: 1, // dias úteis de folga além do prazo dos Correios
    hora_postagem: '15:00',
    ...getSetting('correios', {}),
  };
}

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

// ---------------- Autenticação (token vale 24 h) ----------------
const tokenCache = new Map();

async function token(config) {
  const key = `${config.environment}:${config.usuario}:${config.cartao}`;
  const cached = tokenCache.get(key);
  if (cached && cached.exp > Date.now() + 5 * 60000) return cached.token;
  if (!config.usuario || !config.codigo_acesso || !config.cartao) throw new Error('Preencha usuário, código de acesso e cartão de postagem dos Correios.');
  const body = { numero: onlyDigits(config.cartao) };
  if (config.contrato) body.contrato = onlyDigits(config.contrato);
  const res = await fetch(`${HOSTS[config.environment] || HOSTS.producao}/token/v1/autentica/cartaopostagem`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.usuario}:${config.codigo_acesso}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(`Correios recusou o login: ${correiosError(data, res.status)}`);
  tokenCache.set(key, { token: data.token, exp: data.expiraEm ? Date.parse(data.expiraEm) : Date.now() + 23 * 3600e3 });
  return data.token;
}

function correiosError(data, status) {
  const msg = data?.msgs?.join?.('; ') || data?.msg || data?.message || data?.txErro || data?.causa;
  return msg ? `${msg} (${status})` : `erro ${status}`;
}

/** Prazo de entrega dos Correios (dias úteis) entre o CEP de origem e o de destino. */
async function quote(cepDestino, config = getConfig()) {
  const destino = onlyDigits(cepDestino);
  const origem = onlyDigits(config.cep_origem);
  if (destino.length !== 8) throw new Error('CEP de destino inválido.');
  if (origem.length !== 8) throw new Error('Configure o CEP de origem nas configurações dos Correios.');
  const url = `${HOSTS[config.environment] || HOSTS.producao}/prazo/v1/nacional/${encodeURIComponent(config.servico)}?cepOrigem=${origem}&cepDestino=${destino}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await token(config)}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.txErro || !Number.isFinite(Number(data.prazoEntrega))) {
    throw new Error(`Correios não informou o prazo: ${correiosError(data, res.status)}`);
  }
  return { days: Number(data.prazoEntrega), service: config.servico, message: data.msgPrazo || '' };
}

// ---------------- Datas ----------------
const MONTHS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** Lê datas como 25/12/2026, 25-12-26, 2026-12-25 ou "25 de dezembro de 2026". Retorna AAAA-MM-DD. */
function parseDate(input) {
  const s = String(input || '').trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  let y; let m; let d;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (r) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s))) [, d, m, y] = r;
  else if ((r = /^(\d{1,2})\s+de\s+([a-z]+)(?:\s+de)?\s+(\d{4})$/.exec(s))) {
    d = r[1]; y = r[3]; m = MONTHS.indexOf(r[2]) + 1;
    if (!m) return null;
  } else return null;
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Feriados nacionais (fixos + Carnaval, Sexta-feira Santa e Corpus Christi), em que os Correios não entregam. */
function holidays(year) {
  const fixed = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map((md) => `${year}-${md}`);
  // Páscoa (algoritmo de Meeus/Jones/Butcher)
  const a = year % 19; const b = Math.floor(year / 100); const c = year % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30; const i = Math.floor(c / 4); const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = Date.UTC(year, month - 1, day);
  const rel = (n) => new Date(easter + n * 864e5).toISOString().slice(0, 10);
  return new Set([...fixed, rel(-48), rel(-47), rel(-2), rel(60)]);
}

function isBusinessDay(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  const wd = date.getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays(date.getUTCFullYear()).has(iso);
}

/** Volta N dias úteis a partir de uma data (AAAA-MM-DD). */
function subtractBusinessDays(iso, n) {
  let t = Date.parse(`${iso}T12:00:00Z`);
  let left = n;
  while (left > 0) {
    t -= 864e5;
    if (isBusinessDay(new Date(t).toISOString().slice(0, 10))) left--;
  }
  // se cair em fim de semana/feriado, recua até um dia útil para postar
  let out = new Date(t).toISOString().slice(0, 10);
  while (!isBusinessDay(out)) { t -= 864e5; out = new Date(t).toISOString().slice(0, 10); }
  return out;
}

const fmt = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

/** Data de entrega prometida ao cliente, conforme configurado. */
function promisedDate({ props = {}, attributes = {}, createdAt }, config = getConfig()) {
  const want = String(config.promised_name || '').trim().toLowerCase();
  const pick = (obj) => Object.entries(obj).find(([k]) => k.trim().toLowerCase() === want)?.[1];
  if (config.promised_source === 'property') return parseDate(pick(props));
  if (config.promised_source === 'attribute') return parseDate(pick(attributes));
  const base = createdAt ? new Date(createdAt) : new Date();
  return new Date(base.getTime() + Number(config.promised_days || 0) * 864e5).toISOString().slice(0, 10);
}

/**
 * Calcula o prazo interno: entrega prometida − (prazo Correios + folga), em dias úteis.
 * Retorna também o texto para a descrição do card e os valores para os campos.
 */
async function deadline({ zip, promised }, config = getConfig()) {
  if (!promised) throw new Error(`não encontrei a data de entrega prometida ("${config.promised_name}")`);
  const q = await quote(zip, config);
  const posting = subtractBusinessDays(promised, q.days + Math.max(0, Number(config.margem_dias) || 0));
  const [hh, mm] = String(config.hora_postagem || '15:00').split(':').map(Number);
  const dueDate = new Date(`${posting}T${String(hh || 15).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}:00-03:00`).toISOString();
  const service = SERVICES.find((s) => s.code === q.service)?.label.replace(' (contrato)', '') || q.service;
  return {
    dueDate,
    posting,
    promised,
    days: q.days,
    service: q.service,
    summary: `Entrega prometida: ${fmt(promised)} · ${service}: ${q.days} dia(s) útil(eis) · Postar até: ${fmt(posting)}`,
    values: { promised_date: promised, correios_days: q.days, posting_deadline: posting, shipping_zip: onlyDigits(zip) },
  };
}

module.exports = { HOSTS, SERVICES, getConfig, quote, deadline, promisedDate, parseDate, subtractBusinessDays, isBusinessDay, holidays, onlyDigits };
