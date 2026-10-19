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
  // webhook registrado pelo app vem assinado com o Client secret
  setSetting('shopify', { ...require('../server/db').getSetting('shopify'), client_secret: 'segredo-do-app' });
  const appSig = crypto.createHmac('sha256', 'segredo-do-app').update(body).digest('base64');
  assert.strictEqual((await send(appSig)).status, 200);
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

test('conecta com Client ID/secret (app do Dev Dashboard) e registra o webhook com "uri"', async () => {
  const { setSetting } = require('../server/db');
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
    if (String(url).endsWith('/admin/oauth/access_token')) {
      const body = new URLSearchParams(opts.body);
      assert.strictEqual(body.get('grant_type'), 'client_credentials');
      assert.strictEqual(body.get('client_id'), 'cid');
      assert.strictEqual(body.get('client_secret'), 'csecret');
      return json(200, { access_token: 'tok-24h', scope: 'read_orders', expires_in: 86399 });
    }
    assert.strictEqual(opts.headers['X-Shopify-Access-Token'], 'tok-24h');
    const { query, variables } = JSON.parse(opts.body);
    if (query.includes('webhookSubscriptionCreate')) {
      assert.match(query, /uri: \$url/);
      assert.doesNotMatch(query, /callbackUrl/);
      assert.strictEqual(variables.url, 'https://kanban.exemplo.com/webhooks/shopify/orders');
      return json(200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1' }, userErrors: [] } } });
    }
    return json(200, { data: { shop: { name: 'Ateliê', myshopifyDomain: 'atelie.myshopify.com' } } });
  };
  // versão antiga salva é atualizada automaticamente
  setSetting('shopify', { shop_domain: 'atelie.myshopify.com', client_id: 'cid', client_secret: 'csecret', api_version: '2025-07' });
  const config = shopify.getConfig();
  assert.strictEqual(config.api_version, '2026-10');
  const shop = await shopify.graphql(config, '{ shop { name myshopifyDomain } }');
  assert.strictEqual(shop.shop.name, 'Ateliê');
  assert.ok(calls[1].url.includes('/admin/api/2026-10/graphql.json'));
  await shopify.registerWebhook(config, 'https://kanban.exemplo.com/webhooks/shopify/orders');
  // o token é reaproveitado (só uma troca de credenciais)
  assert.strictEqual(calls.filter((c) => c.url.endsWith('/admin/oauth/access_token')).length, 1);
});

test('normaliza o domínio da loja', () => {
  assert.strictEqual(shopify.normalizeShopDomain('https://admin.shopify.com/store/atelie-joias/orders'), 'atelie-joias.myshopify.com');
  assert.strictEqual(shopify.normalizeShopDomain('Atelie-Joias'), 'atelie-joias.myshopify.com');
  assert.strictEqual(shopify.normalizeShopDomain('https://atelie-joias.myshopify.com/admin'), 'atelie-joias.myshopify.com');
});

test('erros da Shopify viram mensagens claras (em vez de "erro interno")', async () => {
  const config = { shop_domain: 'atelie.myshopify.com', access_token: 'shpat_x', api_version: '2026-10' };
  global.fetch = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  await assert.rejects(shopify.graphql(config, '{ shop { name } }'), /não foi encontrada/);
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ errors: '[API] Invalid API key or access token' }) });
  await assert.rejects(shopify.graphql(config, '{ shop { name } }'), /não aceitou as credenciais/);
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'Access denied for orders field.' }] }) });
  await assert.rejects(shopify.graphql(config, '{ shop { name } }'), /Acesso negado.*read_orders/);
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('html'); } });
  await assert.rejects(shopify.graphql(config, '{ shop { name } }'), /resposta inesperada/);
});


test('mostra o motivo real quando a Shopify recusa o Client ID/secret (resposta em texto)', async () => {
  const config = { shop_domain: 'atelie.myshopify.com', client_id: 'outro', client_secret: 's', api_version: '2026-10' };
  global.fetch = async () => ({ ok: false, status: 400, json: async () => { throw new Error('x'); }, text: async () => 'Oauth error shop_not_permitted: Client credentials cannot be performed on this shop.' });
  await assert.rejects(shopify.graphql(config, '{ shop { name } }'), /mesma organização.*Conectar com a Shopify/);
  global.fetch = async () => ({ ok: false, status: 400, text: async () => '<html><body><h1>Oauth error invalid_request: missing parameter</h1></body></html>' });
  await assert.rejects(shopify.graphql(config, '{ shop { name } }'), /erro 400: Oauth error invalid_request: missing parameter/);
});

test('autorização direta (OAuth): link, assinatura do retorno, troca do código e renovação', async () => {
  const { setSetting, getSetting } = require('../server/db');
  setSetting('shopify', { shop_domain: 'atelie.myshopify.com', client_id: 'cid', client_secret: 'csecret' });
  let config = shopify.getConfig();
  const url = new URL(shopify.authorizeUrl(config, 'https://kanban.exemplo.com/api/shopify/oauth/callback', 'abc'));
  assert.strictEqual(url.origin + url.pathname, 'https://atelie.myshopify.com/admin/oauth/authorize');
  assert.strictEqual(url.searchParams.get('scope'), 'read_orders,read_products,read_customers');

  const query = { code: 'c0de', shop: 'atelie.myshopify.com', state: 'abc', timestamp: '1700000000' };
  const msg = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join('&');
  const hmac = crypto.createHmac('sha256', 'csecret').update(msg).digest('hex');
  assert.ok(shopify.verifyCallback({ ...query, hmac }, 'csecret'));
  assert.ok(!shopify.verifyCallback({ ...query, hmac }, 'outro'));
  assert.ok(!shopify.verifyCallback({ ...query, code: 'alterado', hmac }, 'csecret'));

  const calls = [];
  global.fetch = async (u, opts = {}) => {
    calls.push(new URLSearchParams(opts.body));
    const body = new URLSearchParams(opts.body);
    const data = body.get('code')
      ? { access_token: 'shpat_a', expires_in: 3600, refresh_token: 'shprt_1', refresh_token_expires_in: 7776000, scope: 'read_orders' }
      : { access_token: 'shpat_b', expires_in: 3600, refresh_token: 'shprt_2', refresh_token_expires_in: 7776000 };
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  await shopify.exchangeCode(config, 'c0de');
  assert.strictEqual(calls[0].get('expiring'), '1');
  config = shopify.getConfig();
  assert.strictEqual(await shopify.accessToken(config), 'shpat_a');
  // token vencido → usa o refresh token e guarda o novo par
  setSetting('shopify', { ...getSetting('shopify'), oauth: { ...config.oauth, expires_at: Date.now() - 1000 } });
  assert.strictEqual(await shopify.accessToken(shopify.getConfig()), 'shpat_b');
  assert.strictEqual(calls[1].get('grant_type'), 'refresh_token');
  assert.strictEqual(calls[1].get('refresh_token'), 'shprt_1');
  assert.strictEqual(getSetting('shopify').oauth.refresh_token, 'shprt_2');
});
