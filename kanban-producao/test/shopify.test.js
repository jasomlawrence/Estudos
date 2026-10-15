'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const shopify = require('../server/shopify');

const order = require('./fixtures/order.json');

test('valida a assinatura HMAC do webhook', () => {
  const body = Buffer.from(JSON.stringify(order));
  const hmac = crypto.createHmac('sha256', 'segredo').update(body).digest('base64');
  assert.ok(shopify.verifyHmac(body, hmac, 'segredo'));
  assert.ok(!shopify.verifyHmac(body, hmac, 'outro'));
  assert.ok(!shopify.verifyHmac(body, 'lixo', 'segredo'));
});

test('só itens de anel de noivado viram cards (ignora acentos/maiúsculas)', () => {
  const o = shopify.normalizeRestOrder(order, 'loja.myshopify.com');
  const cfg = { keywords: 'anel de noivado, solitario', mode: 'line_item', title_template: '{order_name} · {customer_name} · {product_title}', mapping: { 1: 'customer_name', 2: 'prop:Tamanho do aro', 3: 'variant_title' }, due_days: 30 };
  const cards = shopify.buildCards(o, cfg);
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].title, '#1001 · Maria Souza · Anel de Noivado Solitário');
  assert.strictEqual(cards[0].externalId, `shopify:${order.id}:${order.line_items[0].id}`);
  assert.deepStrictEqual(cards[0].fields, { 1: 'Maria Souza', 2: '15', 3: 'Ouro amarelo 18k' });
  assert.strictEqual(cards[0].externalUrl, `https://loja.myshopify.com/admin/orders/${order.id}`);
  assert.ok(cards[0].description.includes('Gravação'));
  assert.strictEqual(new Date(cards[0].dueDate).toISOString().slice(0, 10), '2026-11-14');
});

test('modo "por unidade" cria um card para cada peça', () => {
  const o = shopify.normalizeRestOrder({ ...order, line_items: [{ ...order.line_items[0], quantity: 2 }] }, '');
  const cards = shopify.buildCards(o, { keywords: 'noivado', mode: 'unit', title_template: '{order_name}' });
  assert.deepStrictEqual(cards.map((c) => c.title), ['#1001 (1/2)', '#1001 (2/2)']);
});

test('modo "por pedido" agrupa os itens', () => {
  const o = shopify.normalizeRestOrder(order, '');
  const cards = shopify.buildCards(o, { keywords: '', mode: 'order', title_template: '{order_name}' });
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].externalId, `shopify:${order.id}`);
});

test('webhook assinado cria o card uma única vez', async () => {
  const { setSetting, q } = require('../server/db');
  const { seedBoard } = require('../server/routes');
  const app = require('../server/index');
  q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'a@a.com', 'x', 'admin')");
  const boardId = seedBoard(1);
  const col = q.get('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1', boardId);
  const field = q.get("SELECT id FROM field_defs WHERE board_id = ? AND name = 'Tamanho do aro'", boardId);
  setSetting('shopify', { enabled: true, webhook_secret: 'segredo', board_id: boardId, column_id: col.id, keywords: 'anel de noivado', mapping: { [field.id]: 'prop:Tamanho do aro' }, due_days: 30 });

  const server = app.listen(0);
  const url = `http://localhost:${server.address().port}/webhooks/shopify/orders`;
  const body = JSON.stringify(order);
  const hmac = crypto.createHmac('sha256', 'segredo').update(body).digest('base64');
  const send = (sig) => fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': sig, 'X-Shopify-Topic': 'orders/create' } });
  assert.strictEqual((await send('invalida')).status, 401);
  assert.strictEqual((await send(hmac)).status, 200);
  assert.strictEqual((await send(hmac)).status, 200); // reenvio do Shopify
  await new Promise((r) => setTimeout(r, 300));
  server.close();

  const cards = q.all("SELECT * FROM cards WHERE source = 'shopify'");
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].column_id, col.id);
  const value = q.get('SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?', cards[0].id, field.id);
  assert.strictEqual(JSON.parse(value.value), 15);
  assert.ok(q.get("SELECT 1 FROM activity WHERE action = 'shopify.imported'"));
});
