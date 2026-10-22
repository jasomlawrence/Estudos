'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const { q } = require('../server/db');
const { seedBoard } = require('../server/routes');
const cards = require('../server/cards');
const stock = require('../server/stock');
const certificate = require('../server/certificate');

q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Ana', 'a@a.com', 'x', 'admin')");
const boardId = seedBoard(1);
const col = q.get('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1', boardId).id;
const addField = (name, type) => Number(q.run('INSERT INTO field_defs (board_id, name, type, options, position) VALUES (?, ?, ?, ?, ?)', boardId, name, type, '[]', 99999).lastInsertRowid);
const centralField = addField('Pedra central', 'stone');
const sideField = addField('Pedras laterais', 'melee');
const serialized = (id) => cards.serializeCards([q.get('SELECT * FROM cards WHERE id = ?', id)])[0];

const igi = stock.createStone({ kind: 'lab', code: 'LG797609310', shape: 'OVAL BRILLIANT', measurements: '9.75 X 6.33 X 3.71 MM', carat: '1.51', color: 'F', clarity: 'VVS 2', polish: 'Excellent', lab: 'igi' }, 1);
const gra = stock.createStone({ kind: 'moissanite', code: 'GRA 28063453', shape: 'Trillion', measurements: '7*7mm', carat: '1.2ct', color: 'D', clarity: 'VS1' }, 1);

test('cadastro: corte e medidas em português, código único, moissanite sem claridade', () => {
  assert.strictEqual(igi.shape, 'Oval');
  assert.strictEqual(igi.measurements, '9,75 × 6,33 × 3,71');
  assert.strictEqual(igi.carat, 1.51);
  assert.strictEqual(igi.clarity, 'VVS2');
  assert.strictEqual(igi.lab, 'IGI');
  assert.strictEqual(gra.shape, 'Trilliant');
  assert.strictEqual(gra.measurements, '7 × 7');
  assert.strictEqual(gra.clarity, '', 'moissanite não guarda claridade');
  assert.strictEqual(stock.formatMeasurements('3.45 - 3.48 X 2.07 MM'), '3,45 – 3,48 × 2,07');
  assert.throws(() => stock.createStone({ code: 'lg 797-609-310' }, 1), /já está cadastrada/);
  assert.throws(() => stock.createStone({ code: '  ' }, 1), /Informe o código/);
  assert.strictEqual(stock.stoneLabel(igi), 'LG797609310 · Oval 1,51 ct F VVS2');
});

test('busca pelo código: o código de barras do IGI vem sem "LG"; GRA com ou sem espaço', () => {
  assert.deepStrictEqual(stock.findByCode('797609310').map((s) => s.id), [igi.id]);
  assert.deepStrictEqual(stock.findByCode('lg797609310').map((s) => s.id), [igi.id]);
  assert.deepStrictEqual(stock.findByCode('GRA28063453').map((s) => s.id), [gra.id]);
  assert.deepStrictEqual(stock.findByCode('28063453').map((s) => s.id), [gra.id]);
  assert.deepStrictEqual(stock.findByCode('12345'), [], 'código de barras falso da etiqueta não encontra nada');
  assert.deepStrictEqual(stock.searchStones({ text: '6093' }).map((s) => s.id), [igi.id]);
  assert.deepStrictEqual(stock.searchStones({ kind: 'moissanite' }).map((s) => s.id), [gra.id]);
});

test('card: pedra central dá baixa, não pode ir para dois pedidos, troca devolve a antiga', () => {
  const a = cards.createCard({ columnId: col, title: '#1001 · Maria · Solitário' }, 1);
  const b = cards.createCard({ columnId: col, title: '#1002 · João' }, 1);
  cards.updateCard(a, { fields: { [centralField]: igi.id } }, 1);
  let s = stock.stoneRow(igi.id);
  assert.strictEqual(s.status, 'used');
  assert.strictEqual(s.card_id, a);
  assert.strictEqual(s.used_order, '#1001 · Maria · Solitário');
  assert.strictEqual(serialized(a).stock_text[centralField], 'LG797609310 · Oval 1,51 ct F VVS2');
  assert.strictEqual(cards.cardDetail(a).stock[centralField].id, igi.id);

  assert.throws(() => cards.updateCard(b, { fields: { [centralField]: igi.id } }, 1), /já foi usada no pedido #1001/);
  assert.strictEqual(serialized(b).fields[centralField], undefined, 'nada gravado no outro card');

  cards.updateCard(a, { fields: { [centralField]: gra.id } }, 1);
  assert.strictEqual(stock.stoneRow(igi.id).status, 'available', 'a antiga voltou');
  assert.strictEqual(stock.stoneRow(gra.id).card_id, a);
  cards.updateCard(a, { fields: { [centralField]: null } }, 1);
  assert.strictEqual(stock.stoneRow(gra.id).status, 'available');
  const log = stock.stoneHistory(igi.id).map((l) => l.action);
  assert.deepStrictEqual(log, ['returned', 'used', 'created']);
  const act = q.get("SELECT details FROM activity WHERE card_id = ? AND action = 'card.field' ORDER BY id LIMIT 1", a);
  assert.match(act.details, /LG797609310/, 'histórico do card mostra o código');
});

test('pedras pequenas: baixa só da diferença, recusa sem estoque, devolve ao excluir o card', () => {
  const round = stock.createMelee({ kind: 'lab', shape: 'Redonda', size: '1.3', qty: 20, min_qty: 10 }, 1);
  const pear = stock.createMelee({ kind: 'moissanite', shape: 'gota', size: '5x3', qty: 4 }, 1);
  assert.strictEqual(round.size, '1,3 mm');
  assert.strictEqual(pear.size, '5 × 3 mm');
  assert.strictEqual(pear.shape, 'Gota');
  assert.throws(() => stock.createMelee({ kind: 'lab', shape: 'Redonda', size: '1,3 mm' }, 1), /já está cadastrada/);

  const c = cards.createCard({ columnId: col, title: '#1003 · Bia' }, 1);
  cards.updateCard(c, { fields: { [sideField]: [{ item: round.id, qty: 8 }, { item: pear.id, qty: 2 }] } }, 1);
  assert.strictEqual(stock.meleeRow(round.id).qty, 12);
  assert.strictEqual(stock.meleeRow(pear.id).qty, 2);
  assert.strictEqual(serialized(c).stock_text[sideField], '8× Redonda 1,3 mm (lab), 2× Gota 5 × 3 mm (moissanite)');

  cards.updateCard(c, { fields: { [sideField]: [{ item: round.id, qty: 10 }, { item: pear.id, qty: 2 }] } }, 1);
  assert.strictEqual(stock.meleeRow(round.id).qty, 10, 'pediu só +2');
  const alerts = stock.takeLowStockAlerts();
  assert.deepStrictEqual(alerts.map((a) => a.id), [round.id], 'chegou no mínimo: avisa');

  assert.throws(() => cards.updateCard(c, { fields: { [sideField]: [{ item: round.id, qty: 10 }, { item: pear.id, qty: 9 }] } }, 1), /Só há 2 un\. de Gota/);
  assert.strictEqual(stock.meleeRow(pear.id).qty, 2, 'nada mudou');
  assert.strictEqual(stock.meleeRow(round.id).qty, 10);

  cards.updateCard(c, { fields: { [centralField]: igi.id } }, 1);
  cards.deleteCard(c, 1);
  assert.strictEqual(stock.meleeRow(round.id).qty, 20, 'devolvidas');
  assert.strictEqual(stock.meleeRow(pear.id).qty, 4);
  assert.strictEqual(stock.stoneRow(igi.id).status, 'available');
  assert.throws(() => stock.moveMelee(pear.id, -5, { note: 'quebra' }), /Só há 4/);
  stock.moveMelee(pear.id, 10, { note: 'compra' });
  assert.strictEqual(stock.meleeHistory(pear.id)[0].qty_after, 14);
});

test('arquivar não devolve; duplicar não copia pedras; campo de estoque não muda de tipo; apagar campo devolve', () => {
  const c = cards.createCard({ columnId: col, title: '#1004' }, 1);
  cards.updateCard(c, { fields: { [centralField]: igi.id } }, 1);
  cards.updateCard(c, { archived: true }, 1);
  assert.strictEqual(stock.stoneRow(igi.id).status, 'used', 'pedido entregue continua com a pedra');
  const copy = cards.duplicateCard(c, {}, 1);
  assert.strictEqual(serialized(copy).fields[centralField], undefined);
  assert.throws(() => cards.changeFieldType(centralField, 'text'), /não mudam de tipo/);
  stock.releaseField(centralField, 1);
  assert.strictEqual(stock.stoneRow(igi.id).status, 'available');
  assert.throws(() => stock.deleteStone(gra.id) && stock.deleteStone(gra.id), /não encontrada/);
});

test('leitura do certificado: resposta do modelo vira campos do formulário', async () => {
  const fakeClient = {
    beta: {
      messages: {
        create: async (req) => {
          assert.strictEqual(req.model, 'claude-opus-5-5');
          assert.strictEqual(req.output_config.format.type, 'json_schema');
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify({ legible: true, kind: 'lab', code: 'LG776678013', shape: 'Redonda', measurements: '3.45 - 3.48 x 2.07', carat: '0.15', color: 'E', clarity: 'VVS 2', cut_grade: 'EXCELLENT', polish: 'EXCELLENT', symmetry: 'EXCELLENT', fluorescence: 'NONE', lab: 'IGI', method: 'CVD', report_date: '2026-02-26', problems: '' }) }],
          };
        },
      },
    },
  };
  const file = path.join(process.env.DATA_DIR, 'cert.jpg');
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff]));
  const form = await certificate.readCertificate(file, 'image/jpeg', { client: fakeClient });
  assert.deepStrictEqual(form, {
    legible: true, kind: 'lab', code: 'LG776678013', shape: 'Redonda', measurements: '3,45 – 3,48 × 2,07', carat: 0.15, color: 'E', clarity: 'VVS2',
    cut_grade: 'Excellent', polish: 'Excellent', symmetry: 'Excellent', fluorescence: 'None', lab: 'IGI', method: 'CVD', report_date: '2026-02-26', problems: '',
  });
  await assert.rejects(certificate.readCertificate(file, 'image/jpeg'), /não está configurada/);
});
