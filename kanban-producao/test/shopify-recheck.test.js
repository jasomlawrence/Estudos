'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const { q, setSetting } = require('../server/db');
const { seedBoard } = require('../server/routes');
const shopify = require('../server/shopify');

q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'a@a.com', 'x', 'admin')");
const boardId = seedBoard(1);
const col = q.get('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1', boardId);
setSetting('shopify', { enabled: true, shop_domain: 'loja.myshopify.com', access_token: 'shpat_x', board_id: boardId, column_id: col.id, tags: 'anel', attach_images: false, due_days: 30 });

// Pedido como a API GraphQL devolve (PIX: entrou "autorizado" e foi pago 30 s depois)
const gqlOrder = (status) => ({
  id: 'gid://shopify/Order/555', legacyResourceId: '555', name: '#200094692', createdAt: '2026-10-23T19:19:00Z', displayFinancialStatus: status, cancelledAt: null,
  email: 'c@c.com', customAttributes: [], totalPriceSet: { shopMoney: { amount: '5000.00' } }, customer: { firstName: 'Ana', lastName: 'Lima' }, shippingAddress: null,
  lineItems: { nodes: [{ id: 'gid://shopify/LineItem/9', title: 'Solitário', variantTitle: '', quantity: 1, customAttributes: [], originalUnitPriceSet: { shopMoney: { amount: '5000.00' } }, product: { id: 'gid://shopify/Product/1', tags: ['anel'], productType: '' } }] },
});

function mockShopify(handler) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    return { ok: true, status: 200, json: async () => ({ data: handler(body) }) };
  };
  return calls;
}

test('pedido que entrou sem pagamento é conferido de novo e entra quando a Shopify mostra pago', async () => {
  const realFetch = global.fetch;
  const unpaid = shopify.normalizeGraphqlOrder(gqlOrder('AUTHORIZED'), 'loja.myshopify.com');
  await shopify.importOrder(unpaid, shopify.getConfig(), null, { source: 'webhook' });
  assert.strictEqual(shopify.recentLog(1)[0].status, 'unpaid');

  let status = 'AUTHORIZED';
  const calls = mockShopify((b) => (b.query.includes('order(id:') ? { order: gqlOrder(status) } : {}));
  assert.strictEqual(await shopify.recheckUnpaid(), 0, 'ainda autorizado: espera');
  assert.strictEqual(shopify.recentLog(1)[0].status, 'unpaid', 'não enche o registro enquanto espera');
  assert.strictEqual(calls[0].variables.id, 'gid://shopify/Order/555');

  status = 'PAID';
  assert.strictEqual(await shopify.recheckUnpaid(), 1);
  const log = shopify.recentLog(1)[0];
  assert.strictEqual(log.status, 'created');
  assert.strictEqual(log.source, 'recheck');
  assert.strictEqual(q.all("SELECT * FROM cards WHERE source = 'shopify'").length, 1);
  const before = calls.length;
  assert.strictEqual(await shopify.recheckUnpaid(), 0, 'já entrou: não confere mais');
  assert.strictEqual(calls.length, before);
  global.fetch = realFetch;
});

test('avisos da Shopify: cadastra os que faltam no mesmo endereço dos que já existem', async () => {
  const realFetch = global.fetch;
  const uri = 'https://kanban.exemplo.com/webhooks/shopify/orders';
  const calls = mockShopify((b) => (b.query.includes('webhookSubscriptions')
    ? { webhookSubscriptions: { nodes: [{ id: '1', topic: 'ORDERS_CREATE', uri }] } }
    : { webhookSubscriptionCreate: { webhookSubscription: { id: '2' }, userErrors: [] } }));
  assert.deepStrictEqual(await shopify.ensureWebhooks(), ['ORDERS_PAID', 'ORDERS_CANCELLED']);
  assert.ok(calls.filter((c) => c.variables?.url).every((c) => c.variables.url === uri));
  global.fetch = realFetch;
});
