'use strict';
// Baixa imagens de outros sites (ex.: foto do produto no Shopify) e anexa ao card
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { q, now, UPLOAD_DIR } = require('./db');
const cards = require('./cards');
const { boardChanged } = require('./events');

const MAX_BYTES = 15 * 1024 * 1024;
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/heic': '.heic' };

/** Links de imagem dentro das personalizações do pedido (ex.: foto enviada pelo cliente) */
function imageUrlsIn(values) {
  return Object.values(values || {}).flatMap((v) => String(v || '').match(/https?:\/\/[^\s"'<>]+/g) || [])
    .filter((u) => /\.(jpe?g|png|webp|gif|avif|heic)(\?|$)/i.test(u) || /cdn\.shopify\.com\/.*\/(files|uploads)\//i.test(u));
}

/** Imagens do CDN da Shopify vêm em tamanho original; pede uma versão de até 1600px (mais leve) */
function sizedUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)cdn\.shopify\.com$|shopifycdn\.net$/.test(u.hostname) && !u.searchParams.has('width')) u.searchParams.set('width', '1600');
    return u.toString();
  } catch { return url; }
}

/**
 * Anexa as imagens ao card (ignora as que já foram anexadas antes, pelo endereço de origem).
 * A primeira imagem vira capa se o card ainda não tiver uma. Retorna quantas foram anexadas.
 */
async function attachRemoteImages(cardId, urls, { userId = null, makeCover = true } = {}) {
  const card = q.get('SELECT * FROM cards WHERE id = ?', cardId);
  if (!card) return 0;
  let added = 0;
  for (const url of [...new Set(urls.filter(Boolean))].slice(0, 10)) {
    if (q.get('SELECT 1 FROM attachments WHERE card_id = ? AND source_url = ?', cardId, url)) continue;
    try {
      const original = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'foto') || 'foto';
      // A foto do produto é igual em todos os pedidos dele: reaproveita o arquivo já baixado (economiza disco)
      const known = q.get('SELECT filename, mime, size FROM attachments WHERE source_url = ? ORDER BY id DESC LIMIT 1', url);
      let file = known && fs.existsSync(path.join(UPLOAD_DIR, known.filename)) ? known : null;
      if (!file) {
        const res = await fetch(sizedUrl(url), { signal: AbortSignal.timeout(20000) });
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (!res.ok || !type.startsWith('image/')) throw new Error(`resposta ${res.status} ${type}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) throw new Error('imagem maior que 15 MB');
        file = { filename: `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${EXT[type] || '.img'}`, mime: type, size: buf.length };
        fs.writeFileSync(path.join(UPLOAD_DIR, file.filename), buf);
      }
      const info = q.run(`INSERT INTO attachments (card_id, filename, original_name, mime, size, uploaded_by, created_at, source_url)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, cardId, file.filename, original, file.mime, file.size, userId, now(), url);
      cards.logActivity(card.board_id, cardId, userId, 'attachment.added', { name: original });
      added++;
      const current = q.get('SELECT cover_attachment_id FROM cards WHERE id = ?', cardId);
      if (makeCover && !current.cover_attachment_id) cards.updateCard(cardId, { cover_attachment_id: Number(info.lastInsertRowid) }, userId);
    } catch (err) {
      console.error(`[imagens] card ${cardId}: não foi possível baixar ${url}: ${err.message}`);
    }
  }
  if (added) boardChanged(card.board_id, userId, cardId);
  return added;
}

module.exports = { attachRemoteImages, imageUrlsIn, sizedUrl };
