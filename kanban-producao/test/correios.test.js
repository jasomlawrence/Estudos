'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const correios = require('../server/correios');

// Tags dos produtos (na vida real vêm da API da Shopify)
const withTags = (o) => { o.line_items.forEach((li, i) => { li.product_tags = i === 0 ? ['solitario'] : []; }); return o; };

test('lê a data de entrega em vários formatos', () => {
  assert.strictEqual(correios.parseDate('25/12/2026'), '2026-12-25');
  assert.strictEqual(correios.parseDate('5-1-27'), '2027-01-05');
  assert.strictEqual(correios.parseDate('2026-12-25'), '2026-12-25');
  assert.strictEqual(correios.parseDate('25 de Março de 2026'), '2026-03-25');
  assert.strictEqual(correios.parseDate('31/02/2026'), null);
  assert.strictEqual(correios.parseDate('amanhã'), null);
  const ref = new Date('2026-10-15T12:00:00Z');
  assert.strictEqual(correios.parseDate('20/11', ref), '2026-11-20');
  assert.strictEqual(correios.parseDate('05/01', new Date('2026-12-10T12:00:00Z')), '2027-01-05'); // virada do ano
  assert.strictEqual(correios.parseDate('sexta-feira, 20 de nov. – quarta, 25 de nov.', ref), '2026-11-20');
  assert.strictEqual(correios.parseDate('Entre 20/11 e 25/11/2026', ref), '2026-11-20');
});

test('feriados nacionais, inclusive os móveis', () => {
  const h = correios.holidays(2026);
  for (const d of ['2026-04-03', '2026-06-04', '2026-02-16', '2026-02-17', '2026-11-20', '2026-12-25']) assert.ok(h.has(d), d);
});

test('volta dias úteis pulando fim de semana e feriado', () => {
  // 20/11/2026 (sexta, feriado) − 3 dias úteis = 17/11
  assert.strictEqual(correios.subtractBusinessDays('2026-11-20', 3), '2026-11-17');
  // 03/11/2026 (terça) − 2: pula Finados (02/11, segunda) e o fim de semana → 29/10
  assert.strictEqual(correios.subtractBusinessDays('2026-11-03', 2), '2026-10-29');
});

function mockCorreios(prazoEntrega, calls) {
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (String(url).includes('/token/v1/autentica/cartaopostagem')) {
      assert.strictEqual(opts.headers.Authorization, `Basic ${Buffer.from('ateliê:codigo123').toString('base64')}`);
      assert.deepStrictEqual(JSON.parse(opts.body), { numero: '0073423760' });
      return json(201, { token: 'tok-1', expiraEm: new Date(Date.now() + 864e5).toISOString() });
    }
    if (String(url).includes('/prazo/v1/nacional/03220')) {
      assert.strictEqual(opts.headers.Authorization, 'Bearer tok-1');
      return json(200, { coProduto: '03220', prazoEntrega, dataMaxima: '2026-11-30T23:59:00', txErro: null });
    }
    return json(404, { msgs: ['não encontrado'] });
  };
}

test('pedido do Shopify: prazo do card = entrega prometida − Correios − folga', async () => {
  const { q, setSetting } = require('../server/db');
  const { seedBoard } = require('../server/routes');
  const shopify = require('../server/shopify');
  q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'a@a.com', 'x', 'admin')");
  const boardId = seedBoard(1);
  const col = q.get('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1', boardId).id;
  const dateField = Number(q.run("INSERT INTO field_defs (board_id, name, type, position) VALUES (?, 'Entrega ao cliente', 'date', 99)", boardId).lastInsertRowid);
  setSetting('correios', {
    enabled: true, usuario: 'ateliê', codigo_acesso: 'codigo123', cartao: '0073.423.760', cep_origem: '01310-100',
    servico: '03220', promised_source: 'auto', promised_name: 'Data estimada de entrega', margem_dias: 1, hora_postagem: '15:00',
  });
  const calls = [];
  mockCorreios(2, calls);

  const order = JSON.parse(JSON.stringify(require('./fixtures/order.json')));
  order.id = 999; // pedido novo
  order.line_items[0].properties.push({ name: 'Data estimada de entrega:', value: '20/11/2026' });
  order.shipping_address.zip = '20010-000';
  const config = { enabled: true, board_id: boardId, column_id: col, tags: 'solitario', mapping: { [dateField]: 'promised_date' }, due_days: 30, title_template: '{order_name}' };
  assert.strictEqual(await shopify.importOrder(withTags(shopify.normalizeRestOrder(order, '')), config), 1);

  const card = q.get('SELECT * FROM cards WHERE external_id LIKE ?', 'shopify:999:%');
  // 20/11 (feriado) − (2 + 1 folga) dias úteis = 17/11, às 15h de Brasília
  assert.strictEqual(card.due_date, '2026-11-17T18:00:00.000Z');
  assert.strictEqual(card.shipping_zip, '20010000');
  assert.strictEqual(card.promised_date, '2026-11-20');
  assert.strictEqual(card.correios_days, 2);
  assert.match(card.description, /Postar até: 17\/11\/2026/);
  assert.ok(calls.some((c) => c.url.includes('cepOrigem=01310100&cepDestino=20010000')));
  const v = q.get('SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?', card.id, dateField);
  assert.strictEqual(JSON.parse(v.value), '2026-11-20');

  // Sem data prometida: usa o prazo padrão e explica o motivo
  const order2 = JSON.parse(JSON.stringify(require('./fixtures/order.json')));
  order2.id = 1000;
  await shopify.importOrder(withTags(shopify.normalizeRestOrder(order2, '')), config);
  const card2 = q.get('SELECT * FROM cards WHERE external_id LIKE ?', 'shopify:1000:%');
  assert.match(card2.description, /Prazo dos Correios não calculado/);
  assert.strictEqual(card2.due_date.slice(0, 10), '2026-11-14');

  // Data na observação do pedido, como intervalo e sem ano
  const order3 = JSON.parse(JSON.stringify(require('./fixtures/order.json')));
  order3.id = 1001;
  order3.note = 'Presente!\nData estimada de entrega: 20 de nov. - 25 de nov.';
  await shopify.importOrder(withTags(shopify.normalizeRestOrder(order3, '')), config);
  const card3 = q.get('SELECT * FROM cards WHERE external_id LIKE ?', 'shopify:1001:%');
  assert.strictEqual(card3.promised_date, '2026-11-20');
  assert.strictEqual(card3.due_date, '2026-11-17T18:00:00.000Z');
});
