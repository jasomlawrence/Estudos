'use strict';
const path = require('node:path');
const express = require('express');
const { UPLOAD_DIR, getSetting, setSetting } = require('./db');
const auth = require('./auth');
const shopify = require('./shopify');
const notifications = require('./notifications');
const automations = require('./automations');
const { router } = require('./routes');
require('./sheets'); // registra a sincronização automática com Google Planilhas

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

// Webhook do Shopify: precisa do corpo bruto para validar a assinatura HMAC
app.post('/webhooks/shopify/orders', express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
  const config = shopify.getConfig();
  // Webhooks registrados pelo app são assinados com o Client secret; os criados no admin, com a chave de lá
  const signature = req.get('X-Shopify-Hmac-Sha256');
  let order = null;
  try { order = JSON.parse(req.body.toString('utf8')); } catch { /* corpo inválido */ }
  if (![config.client_secret, config.webhook_secret].some((secret) => shopify.verifyHmac(req.body, signature, secret))) {
    shopify.logOrder({ order, status: 'signature', detail: 'A assinatura do webhook não confere com o Client secret nem com a chave do webhook. Confira o Client secret salvo.' });
    return res.status(401).send('assinatura inválida');
  }
  res.status(200).send('ok'); // responde logo; o Shopify espera no máximo 5 s
  if (!order) return;
  if (!config.enabled) return shopify.logOrder({ order, status: 'disabled', detail: 'Marque "Integração ativa" em Configurações → Shopify.' });
  const topic = req.get('X-Shopify-Topic') || 'orders/create';
  if (!/^orders\/(create|paid|updated)$/.test(topic)) return;
  shopify.importOrder(shopify.normalizeRestOrder(order, config.shop_domain || req.get('X-Shopify-Shop-Domain')), config, null, { source: 'webhook' })
    .then((n) => n && console.log(`[shopify] pedido ${order.name}: ${n} card(s) criado(s)`))
    .catch((err) => console.error('[shopify]', err.message));
});

// Retorno da autorização direta da Shopify (validado pelo "state" e pela assinatura hmac)
app.get('/api/shopify/oauth/callback', async (req, res) => {
  const back = (params) => res.redirect(`/#${new URLSearchParams(params)}`);
  try {
    const config = shopify.getConfig();
    const saved = getSetting('shopify_oauth_state', {});
    setSetting('shopify_oauth_state', {});
    if (req.query.error) return back({ shopify: 'erro', msg: `A Shopify não autorizou: ${req.query.error_description || req.query.error}` });
    if (!saved.state || saved.state !== req.query.state || saved.exp < Date.now()) return back({ shopify: 'erro', msg: 'Autorização expirada. Clique em "Conectar com a Shopify" de novo.' });
    if (!shopify.verifyCallback(req.query, config.client_secret)) return back({ shopify: 'erro', msg: 'Assinatura da Shopify inválida. Confira o Client secret.' });
    if (shopify.normalizeShopDomain(req.query.shop) !== config.shop_domain) return back({ shopify: 'erro', msg: `A autorização veio da loja ${req.query.shop}, mas a configurada é ${config.shop_domain}.` });
    await shopify.exchangeCode(config, String(req.query.code || ''));
    back({ shopify: 'ok' });
  } catch (err) {
    console.error('[shopify oauth]', err.message);
    back({ shopify: 'erro', msg: err.message });
  }
});

app.use(express.json({ limit: '2mb' }));
app.use(auth.loadUser);
app.use('/api', router);

// Anexos só para usuários logados
app.use('/uploads', (req, res, next) => (req.user ? next() : res.status(401).end()), express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));
app.use('/vendor/sortable', express.static(path.dirname(require.resolve('sortablejs/Sortable.min.js'))));
// QR code e código de barras das etiquetas de impressão
app.use('/vendor/qrcode', express.static(path.dirname(require.resolve('qrcode-generator'))));
app.use('/vendor/jsbarcode', express.static(path.join(path.dirname(require.resolve('jsbarcode/package.json')), 'dist')));
// "no-cache": o navegador confere com o servidor a cada abertura, então uma atualização nunca mistura arquivos novos e antigos
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, file) => { if (/\.(html|js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
}));

app.use((err, req, res, _next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !err.status ? 'Erro interno do servidor.' : err.message });
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, () => console.log(`Kanban de produção rodando em http://localhost:${PORT}`));
  notifications.start();
  automations.start();
}

module.exports = app;
