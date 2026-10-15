'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { q, setSetting } = require('../server/db');
const { seedBoard } = require('../server/routes');
const cards = require('../server/cards');
const sheets = require('../server/sheets');

test('envia para a planilha só os campos escolhidos, com JWT válido', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  q.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'a@a.com', 'x', 'admin')");
  const boardId = seedBoard(1);
  const col = q.get('SELECT * FROM columns WHERE board_id = ? ORDER BY position LIMIT 1', boardId);
  const cliente = q.get("SELECT id FROM field_defs WHERE name = 'Cliente'").id;
  const aro = q.get("SELECT id FROM field_defs WHERE name = 'Tamanho do aro'").id;
  const metal = q.get("SELECT id FROM field_defs WHERE name = 'Metal'").id;
  const cardId = cards.createCard({ columnId: col.id, title: 'Anel Maria', fields: { [cliente]: 'Maria', [aro]: '15,5', [metal]: 'Platina' } }, 1);

  setSetting(`sheets:${boardId}`, {
    enabled: true, auto_sync: false, spreadsheet_id: 'PLANILHA', sheet_name: 'Produção',
    credentials: { client_email: 'bot@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    columns: ['title', `field:${cliente}`, `field:${aro}`, `field:${metal}`, 'column'],
  });

  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const json = (data) => ({ ok: true, json: async () => data });
    if (String(url).includes('oauth2')) {
      const jwt = new URLSearchParams(opts.body).get('assertion').split('.');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), publicKey, Buffer.from(jwt[2], 'base64url'));
      assert.ok(ok, 'assinatura JWT inválida');
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (opts.method === 'GET' && String(url).includes('A%3AA')) return json({ values: [] });
    return json({});
  };

  await sheets.upsertCard(boardId, cardId);
  const writes = calls.filter((c) => c.opts.method !== 'GET' && !c.url.includes('oauth2'));
  assert.deepStrictEqual(JSON.parse(writes[0].opts.body).values[0], ['ID do card', 'Título', 'Cliente', 'Tamanho do aro', 'Metal', 'Coluna atual']);
  assert.ok(writes[1].url.includes(':append'));
  assert.deepStrictEqual(JSON.parse(writes[1].opts.body).values[0], [cardId, 'Anel Maria', 'Maria', 15.5, 'Platina', 'Novos pedidos']);
  assert.ok(calls.every((c) => c.url.includes('oauth2') || c.opts.headers.Authorization === 'Bearer tok'));
});
