'use strict';
// Avisos de prazo de entrega: no app (sininho + notificação do navegador), e-mail e webhook (Slack, Discord, Zapier/Make → WhatsApp…)
const nodemailer = require('nodemailer');
const { q, getSetting, now } = require('./db');
const { sendToUser } = require('./events');
const { logActivity } = require('./cards');

const TZ = process.env.TZ || 'America/Sao_Paulo';

function getConfig(boardId) {
  return {
    enabled: true, days_before: [3, 1], overdue: true, in_app: true,
    email: false, extra_emails: '', webhook_url: '', ...getSetting(`notifications:${boardId}`, {}),
  };
}

function smtpConfig() {
  return { host: '', port: 587, secure: false, user: '', pass: '', from: '', ...getSetting('smtp', {}) };
}

function appUrl() {
  return (getSetting('app', {}).public_url || process.env.PUBLIC_URL || '').replace(/\/$/, '');
}

const fmtDate = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });

/**
 * Decide qual aviso enviar agora para um prazo. Retorna { kind, label } ou null.
 * Envia somente o aviso mais próximo do prazo (evita mandar "3 dias" e "1 dia" juntos).
 */
function dueAlert(dueISO, nowMs, config) {
  const diff = Date.parse(dueISO) - nowMs;
  if (diff <= 0) return config.overdue ? { kind: 'overdue', label: 'Prazo de entrega VENCIDO' } : null;
  const days = [...(config.days_before || [])].map(Number).filter((d) => d >= 0).sort((a, b) => a - b);
  const hit = days.find((d) => diff <= Math.max(d, 0.25) * 864e5); // "0 dias" = nas últimas 6 horas
  if (hit === undefined) return null;
  const label = hit === 0 ? 'Prazo de entrega é HOJE' : `Prazo de entrega em ${hit} dia${hit > 1 ? 's' : ''}`;
  return { kind: `d${hit}`, label, all: days.filter((d) => d >= hit).map((d) => `d${d}`) };
}

/** Usuários ativos que recebem o aviso: responsáveis do card (ou todos, se não houver) */
function cardRecipients(card) {
  const members = q.all('SELECT u.* FROM card_members cm JOIN users u ON u.id = cm.user_id WHERE cm.card_id = ? AND u.active = 1', card.id);
  return members.length ? members : q.all("SELECT * FROM users WHERE active = 1 AND role != 'viewer'");
}

/**
 * Entrega um aviso pelos canais pedidos. Usado pelos avisos de prazo e pelas automações.
 * Retorna a lista de canais usados (para o histórico).
 */
async function deliver({ card, recipients, text, subject, inApp = true, email = false, extraEmails = '', webhookUrl = '', payload = {}, title = '' }) {
  const results = [];
  if (inApp) {
    for (const u of recipients) {
      const info = q.run('INSERT INTO notifications (user_id, card_id, message, created_at) VALUES (?, ?, ?, ?)', u.id, card.id, text, now());
      sendToUser(u.id, 'notification', { id: Number(info.lastInsertRowid), card_id: card.id, message: text, title });
    }
    results.push(`app (${recipients.length})`);
  }
  if (email) {
    const smtp = smtpConfig();
    const to = [...new Set([...recipients.map((u) => u.email), ...String(extraEmails).split(/[,;\s]+/).filter(Boolean)])];
    if (!smtp.host) results.push('e-mail não enviado (SMTP não configurado)');
    else if (to.length) {
      try {
        const transport = nodemailer.createTransport({ host: smtp.host, port: Number(smtp.port), secure: !!smtp.secure, auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined });
        await transport.sendMail({ from: smtp.from || smtp.user, to: to.join(', '), subject, text });
        results.push(`e-mail (${to.length})`);
      } catch (err) { results.push(`e-mail falhou: ${err.message}`); }
    }
  }
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text, ...payload }) });
      results.push(res.ok ? 'webhook' : `webhook falhou (${res.status})`);
    } catch (err) { results.push(`webhook falhou: ${err.message}`); }
  }
  return results;
}

const cardLink = (card) => (appUrl() ? `${appUrl()}/#card=${card.id}` : '');

async function notifyCard(card, label, { userId = null } = {}) {
  const config = getConfig(card.board_id);
  const column = q.get('SELECT name FROM columns WHERE id = ?', card.column_id)?.name;
  const link = cardLink(card);
  const text = `⏰ ${label}: "${card.title}"${card.due_date ? ` — entrega ${fmtDate(card.due_date)}` : ''}${column ? ` — etapa: ${column}` : ''}${link ? `\n${link}` : ''}`;
  const results = await deliver({
    card, recipients: cardRecipients(card), text, subject: `${label}: ${card.title}`, title: 'Prazo de entrega',
    inApp: config.in_app, email: config.email, extraEmails: config.extra_emails, webhookUrl: config.webhook_url,
    payload: { event: 'due_date_alert', alert: label, card: { id: card.id, title: card.title, due_date: card.due_date, column, url: link } },
  });
  logActivity(card.board_id, card.id, userId, 'card.notified', { alert: label, channels: results.join(', ') });
  return results;
}

let running = false;
async function checkDueDates(nowMs = Date.now()) {
  if (running) return;
  running = true;
  try {
    const cards = q.all(`SELECT c.* FROM cards c WHERE c.archived = 0 AND c.due_date IS NOT NULL AND c.cycle_ended_at IS NULL`);
    for (const card of cards) {
      const config = getConfig(card.board_id);
      if (!config.enabled) continue;
      const alert = dueAlert(card.due_date, nowMs, config);
      if (!alert) continue;
      const key = `due:${card.id}:${card.due_date}:${alert.kind}`;
      if (q.get('SELECT 1 FROM notification_log WHERE dedupe_key = ?', key)) continue;
      for (const k of alert.all || [alert.kind]) q.run('INSERT OR IGNORE INTO notification_log (dedupe_key) VALUES (?)', `due:${card.id}:${card.due_date}:${k}`);
      await notifyCard(card, alert.label).catch((err) => console.error('[notificações]', err.message));
    }
  } finally {
    running = false;
  }
}

function start() {
  const minutes = Number(process.env.NOTIFY_INTERVAL_MINUTES || 10);
  setTimeout(() => checkDueDates(), 5000);
  setInterval(() => checkDueDates(), minutes * 60000).unref();
}

module.exports = { getConfig, smtpConfig, dueAlert, notifyCard, checkDueDates, start, deliver, cardRecipients, cardLink, fmtDate };
