'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const { q, setSetting, UPLOAD_DIR } = require('../server/db');
const { seedBoard } = require('../server/routes');
const shopify = require('../server/shopify');
const images = require('../server/images');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('pedido do Shopify: baixa a foto do produto e usa como capa', async () => {
  q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'a@a.com', 'x', 'admin')");
  const boardId = seedBoard(1);
  const col = q.get('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1', boardId).id;
  setSetting('shopify', { shop_domain: 'atelie.myshopify.com', access_token: 'shpat_x' });
  const downloads = [];
  global.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes('/graphql.json')) {
      const { variables } = JSON.parse(opts.body);
      assert.strictEqual(variables.id, 'gid://shopify/Order/5123456789');
      return { ok: true, status: 200, text: async () => '', json: async () => ({ data: { order: { lineItems: { nodes: [
        { id: 'gid://shopify/LineItem/11111', image: { url: 'https://cdn.shopify.com/s/files/1/0001/products/solitario.jpg?v=1' }, customAttributes: [] },
      ] } } } }) };
    }
    downloads.push(url);
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => PNG };
  };
  const order = JSON.parse(JSON.stringify(require('./fixtures/order.json')));
  order.line_items[0].properties.push({ name: 'Foto de referência', value: 'https://cdn.shopify.com/s/files/1/0001/uploads/ref-cliente.png' });
  const config = { ...shopify.getConfig(), board_id: boardId, column_id: col, tags: 'solitario', title_template: '{order_name}' };
  const normalized = shopify.normalizeRestOrder(order, 'atelie.myshopify.com');
  normalized.line_items[0].product_tags = ['solitario'];
  normalized.line_items[1].product_tags = [];
  assert.strictEqual(await shopify.importOrder(normalized, config), 1);

  const card = q.get("SELECT * FROM cards WHERE source = 'shopify'");
  const atts = q.all('SELECT * FROM attachments WHERE card_id = ? ORDER BY id', card.id);
  assert.strictEqual(atts.length, 2); // foto do produto + foto enviada na personalização
  assert.strictEqual(card.cover_attachment_id, atts[0].id); // a foto do produto vira capa
  assert.strictEqual(atts[0].original_name, 'solitario.jpg');
  assert.ok(fs.existsSync(path.join(UPLOAD_DIR, atts[0].filename)));
  assert.ok(downloads[0].includes('width=1600')); // pede versão menor ao CDN da Shopify

  // Botão "Buscar foto do pedido": não duplica o que já foi anexado
  assert.strictEqual(await shopify.attachOrderImages(card, 1), 0);
  assert.strictEqual(q.get('SELECT COUNT(*) AS n FROM attachments WHERE card_id = ?', card.id).n, 2);
});

test('acha links de imagem nas personalizações', () => {
  assert.deepStrictEqual(images.imageUrlsIn({ a: 'veja https://site.com/x.JPG?v=2 ok', b: 'texto', c: 'https://cdn.shopify.com/s/files/1/uploads/abc' }),
    ['https://site.com/x.JPG?v=2', 'https://cdn.shopify.com/s/files/1/uploads/abc']);
});
