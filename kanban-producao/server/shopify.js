'use strict';
// Integração Shopify: recebe pedidos (webhook) e transforma pedidos de anel de noivado em cards
const crypto = require('node:crypto');
const { q, getSetting, setSetting } = require('./db');
const { createCard, logActivity } = require('./cards');
const correios = require('./correios');
const images = require('./images');

// Versão estável mais recente (out/2026). Versões antigas salvas são trocadas automaticamente
// por esta, porque a Shopify desativa cada versão ~12 meses após o lançamento.
const DEFAULT_API_VERSION = '2026-10';
const OLDEST_SUPPORTED_VERSION = '2026-01';

// Dados do pedido que podem preencher campos do card
const SOURCES = [
  { key: 'order_name', label: 'Número do pedido (#1001)' },
  { key: 'created_at', label: 'Data do pedido' },
  { key: 'customer_name', label: 'Nome do cliente' },
  { key: 'customer_email', label: 'E-mail do cliente' },
  { key: 'customer_phone', label: 'Telefone do cliente' },
  { key: 'shipping_address', label: 'Endereço de entrega' },
  { key: 'shipping_zip', label: 'CEP de entrega' },
  { key: 'promised_date', label: 'Data de entrega prometida (Correios)' },
  { key: 'correios_days', label: 'Prazo dos Correios (dias úteis)' },
  { key: 'posting_deadline', label: 'Postar até (Correios)' },
  { key: 'order_note', label: 'Observação do pedido' },
  { key: 'total_price', label: 'Valor total do pedido' },
  { key: 'financial_status', label: 'Status do pagamento' },
  { key: 'product_title', label: 'Produto' },
  { key: 'variant_title', label: 'Variante (ex.: aro / metal)' },
  { key: 'sku', label: 'SKU' },
  { key: 'vendor', label: 'Fornecedor' },
  { key: 'quantity', label: 'Quantidade' },
  { key: 'line_price', label: 'Preço do item' },
];

function getConfig() {
  const stored = getSetting('shopify', {});
  if (!stored.api_version || stored.api_version < OLDEST_SUPPORTED_VERSION) stored.api_version = DEFAULT_API_VERSION;
  return {
    enabled: false,
    shop_domain: '',
    webhook_secret: '',
    client_id: '',
    client_secret: '',
    access_token: '',
    api_version: DEFAULT_API_VERSION,
    board_id: null,
    column_id: null,
    keywords: 'anel de noivado, noivado, solitário',
    product_ids: '',
    tags: '',
    mode: 'line_item',
    title_template: '{order_name} · {customer_name} · {product_title}',
    mapping: {},
    due_days: 30,
    label_ids: [],
    ...stored,
  };
}

function verifyHmac(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader || !rawBody) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(String(hmacHeader), 'base64');
  return given.length === digest.length && crypto.timingSafeEqual(digest, given);
}

const fold = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const splitList = (s) => String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const gidToId = (gid) => String(gid || '').split('/').pop();

function formatAddress(a) {
  if (!a) return '';
  return [a.name, a.address1, a.address2, [a.city, a.province_code || a.province].filter(Boolean).join(' - '), a.zip, a.country]
    .filter(Boolean).join(', ');
}

/** Pedido no formato do webhook (REST) → formato interno */
function normalizeRestOrder(o, shopDomain) {
  const c = o.customer || {};
  return {
    id: String(o.id),
    name: o.name || `#${o.order_number}`,
    created_at: o.created_at,
    email: o.email || c.email || '',
    phone: o.phone || c.phone || o.shipping_address?.phone || '',
    note: o.note || '',
    currency: o.currency,
    total_price: o.total_price,
    financial_status: o.financial_status || '',
    customer_name: [c.first_name, c.last_name].filter(Boolean).join(' ') || o.shipping_address?.name || o.billing_address?.name || '',
    shipping_address: formatAddress(o.shipping_address),
    zip: o.shipping_address?.zip || '',
    attributes: Object.fromEntries((o.note_attributes || []).map((a) => [a.name, a.value])),
    admin_url: shopDomain ? `https://${shopDomain}/admin/orders/${o.id}` : null,
    status_url: o.order_status_url || null, // página do pedido que o cliente vê (abre sem login no admin)
    line_items: (o.line_items || []).map((li) => ({
      id: String(li.id),
      title: li.title || li.name || '',
      variant_title: li.variant_title || '',
      sku: li.sku || '',
      vendor: li.vendor || '',
      quantity: li.quantity || 1,
      price: li.price,
      product_id: li.product_id ? String(li.product_id) : '',
      properties: Object.fromEntries((li.properties || []).map((p) => [p.name, p.value])),
      image_url: null, // o webhook não traz a foto; buscada depois pela API (enrichImages)
    })),
  };
}

/** Pedido vindo da Admin GraphQL API → formato interno */
function normalizeGraphqlOrder(o, shopDomain) {
  const id = o.legacyResourceId || gidToId(o.id);
  const c = o.customer || {};
  const addr = o.shippingAddress && { ...o.shippingAddress, province_code: o.shippingAddress.provinceCode };
  return {
    id: String(id),
    name: o.name,
    created_at: o.createdAt,
    email: o.email || c.defaultEmailAddress?.emailAddress || '',
    phone: o.phone || c.defaultPhoneNumber?.phoneNumber || o.shippingAddress?.phone || '',
    note: o.note || '',
    currency: o.currencyCode,
    total_price: o.totalPriceSet?.shopMoney?.amount,
    financial_status: (o.displayFinancialStatus || '').toLowerCase(),
    customer_name: [c.firstName, c.lastName].filter(Boolean).join(' ') || o.shippingAddress?.name || '',
    shipping_address: formatAddress(addr),
    zip: o.shippingAddress?.zip || '',
    attributes: Object.fromEntries((o.customAttributes || []).map((a) => [a.key, a.value])),
    admin_url: shopDomain ? `https://${shopDomain}/admin/orders/${id}` : null,
    status_url: o.statusPageUrl || null,
    line_items: (o.lineItems?.nodes || []).map((li) => ({
      id: gidToId(li.id),
      title: li.title || '',
      variant_title: li.variantTitle || '',
      sku: li.sku || '',
      vendor: li.vendor || '',
      quantity: li.quantity || 1,
      price: li.originalUnitPriceSet?.shopMoney?.amount,
      product_id: li.product ? gidToId(li.product.id) : '',
      product_tags: li.product?.tags || [],
      product_type: li.product?.productType || '',
      properties: Object.fromEntries((li.customAttributes || []).map((p) => [p.key, p.value])),
      image_url: li.image?.url || null,
    })),
  };
}

/** O item do pedido é um anel de noivado (ou o que estiver configurado)? */
function matchLineItem(li, config, productInfo = {}) {
  const keywords = splitList(config.keywords).map(fold);
  const productIds = splitList(config.product_ids);
  const tags = splitList(config.tags).map(fold);
  if (!keywords.length && !productIds.length && !tags.length) return true; // sem filtro: todo pedido entra
  const info = productInfo[li.product_id] || {};
  const productTags = (li.product_tags || info.tags || []).map(fold);
  const productType = fold(li.product_type || info.productType || '');
  // As palavras valem para o nome, a variante, o SKU e também o TIPO do produto
  // (ex.: "Anel de Ouro com Moissanite Lien" não diz "noivado", mas o tipo é "anéis de noivado")
  const haystack = fold([li.title, li.variant_title, li.sku, li.vendor, productType].join(' '));
  if (keywords.some((k) => haystack.includes(k))) return true;
  if (li.product_id && productIds.includes(li.product_id)) return true;
  return tags.some((t) => productTags.includes(t) || productType === t);
}

function sourceValues(order, items) {
  const props = {};
  for (const li of items) for (const [k, v] of Object.entries(li.properties)) props[`prop:${k}`] = props[`prop:${k}`] ? `${props[`prop:${k}`]} | ${v}` : v;
  const join = (fn) => items.map(fn).filter((v) => v !== '' && v != null).join(' | ');
  return {
    order_name: order.name,
    created_at: order.created_at,
    customer_name: order.customer_name,
    customer_email: order.email,
    customer_phone: order.phone,
    shipping_address: order.shipping_address,
    order_note: order.note,
    total_price: order.total_price,
    financial_status: order.financial_status,
    product_title: join((li) => li.title),
    variant_title: join((li) => li.variant_title),
    sku: join((li) => li.sku),
    vendor: join((li) => li.vendor),
    quantity: items.reduce((s, li) => s + Number(li.quantity || 0), 0),
    line_price: items.length === 1 ? items[0].price : join((li) => li.price),
    ...props,
  };
}

function renderTemplate(template, values) {
  return String(template || '').replace(/\{([^}]+)\}/g, (_, key) => values[key.trim()] ?? '')
    .replace(/(\s*·\s*)+$/, '').replace(/^(\s*·\s*)+/, '').trim();
}

/** Monta os dados dos cards a criar para um pedido (sem gravar nada). */
function buildCards(order, config, productInfo = {}) {
  const matching = order.line_items.filter((li) => matchLineItem(li, config, productInfo));
  if (!matching.length) return [];
  const groups = [];
  if (config.mode === 'order') groups.push({ items: matching, ext: `shopify:${order.id}` });
  else for (const li of matching) {
    if (config.mode === 'unit' && li.quantity > 1) {
      for (let n = 1; n <= li.quantity; n++) groups.push({ items: [{ ...li, quantity: 1 }], ext: `shopify:${order.id}:${li.id}:${n}`, unit: `${n}/${li.quantity}` });
    } else groups.push({ items: [li], ext: `shopify:${order.id}:${li.id}` });
  }
  const dueDays = Number(config.due_days);
  const dueDate = dueDays > 0 ? new Date(Date.parse(order.created_at || Date.now()) + dueDays * 864e5).toISOString() : null;
  return groups.map((g) => {
    const values = sourceValues(order, g.items);
    const fields = {};
    for (const [fieldId, source] of Object.entries(config.mapping || {})) {
      if (source && values[source] !== undefined && values[source] !== '') fields[fieldId] = values[source];
    }
    const propsText = g.items.flatMap((li) => Object.entries(li.properties).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `- **${k}:** ${v}`));
    const description = [
      `Pedido ${order.name} recebido do Shopify.`,
      ...g.items.map((li) => `- ${li.quantity}× ${li.title}${li.variant_title ? ` (${li.variant_title})` : ''}${li.sku ? ` — SKU ${li.sku}` : ''}`),
      ...(propsText.length ? ['', 'Personalização:', ...propsText] : []),
      ...(order.note ? ['', `Observação do cliente: ${order.note}`] : []),
    ].join('\n');
    return {
      externalId: g.ext,
      externalUrl: order.status_url || order.admin_url,
      title: renderTemplate(config.title_template, values) + (g.unit ? ` (${g.unit})` : '') || order.name,
      description,
      fields,
      dueDate,
      labels: config.label_ids || [],
      props: Object.assign({}, ...g.items.map((li) => li.properties)),
      images: [...g.items.map((li) => li.image_url), ...g.items.flatMap((li) => images.imageUrlsIn(li.properties))].filter(Boolean),
      shipping: { zip: correios.onlyDigits(order.zip) || null },
    };
  });
}

// ---------------- Registro dos pedidos recebidos (para saber por que um pedido entrou ou não) ----------------
const LOG_STATUS = { created: 'Card criado', exists: 'Já estava no quadro', ignored: 'Ignorado pelo filtro', disabled: 'Integração desligada', signature: 'Assinatura inválida', error: 'Erro' };

function logOrder({ source = 'webhook', order = null, status, detail = '', cards = 0 }) {
  q.run('INSERT INTO shopify_log (received_at, source, order_id, order_name, status, detail, cards) VALUES (?, ?, ?, ?, ?, ?, ?)',
    new Date().toISOString(), source, order?.id ? String(order.id) : null, order?.name || null, status, String(detail).slice(0, 500), cards);
  q.run('DELETE FROM shopify_log WHERE id <= (SELECT id FROM shopify_log ORDER BY id DESC LIMIT 1 OFFSET 300)');
}

function recentLog(limit = 50) {
  return q.all('SELECT * FROM shopify_log ORDER BY id DESC LIMIT ?', limit).map((r) => ({ ...r, status_label: LOG_STATUS[r.status] || r.status }));
}

/**
 * Grava os cards de um pedido. Retorna quantos foram criados (pedidos repetidos são ignorados).
 * force: ignora o filtro de produtos (importar manualmente um pedido que não bateu com as palavras).
 */
async function importOrder(order, config = getConfig(), userId = null, { source = 'import', force = false } = {}) {
  try {
    const created = await importOrderCards(order, force ? { ...config, keywords: '', product_ids: '', tags: '' } : config, userId, source);
    return created;
  } catch (err) {
    logOrder({ source, order, status: 'error', detail: err.message });
    throw err;
  }
}

async function importOrderCards(order, config, userId, source) {
  if (!config.board_id || !config.column_id) throw new Error('Escolha o quadro e a coluna de entrada nas configurações do Shopify.');
  let productInfo = {};
  // Tipo e tags do produto (o webhook não traz): usados pelo filtro quando o nome não basta
  const filtering = splitList(config.tags).length || splitList(config.keywords).length;
  if (filtering && hasApiAccess(config) && !order.line_items.every((li) => matchLineItem(li, config))) {
    const ids = [...new Set(order.line_items.filter((li) => li.product_id && !li.product_tags).map((li) => li.product_id))];
    if (ids.length) productInfo = await fetchProductInfo(config, ids).catch(() => ({}));
  }
  let planned = buildCards(order, config, productInfo);
  if (!planned.length) {
    const titles = order.line_items.map((li) => {
      const type = li.product_type || productInfo[li.product_id]?.productType;
      return `"${li.title}"${type ? ` (tipo: ${type})` : ''}`;
    }).join(', ');
    logOrder({ source, order, status: 'ignored', detail: `Nenhum produto bateu com o filtro: ${titles || 'pedido sem itens'}` });
    return 0;
  }
  let created = 0;
  const correiosConfig = correios.getConfig();
  const withImages = config.attach_images !== false;
  if (withImages) {
    await enrichImages(order, config);
    planned = buildCards(order, config, productInfo); // agora com as fotos dos produtos
  }
  for (const data of planned) {
    if (q.get('SELECT id FROM cards WHERE external_id = ?', data.externalId)) continue;
    if (correiosConfig.enabled) await applyCorreios(data, order, config, correiosConfig);
    try {
      const cardId = createCard({ ...data, boardId: config.board_id, columnId: config.column_id, source: 'shopify' }, userId);
      created++;
      if (withImages && data.images.length) await images.attachRemoteImages(cardId, data.images, { userId });
    } catch (err) {
      if (!/UNIQUE/.test(err.message)) throw err; // webhook duplicado chegando ao mesmo tempo
    }
  }
  if (created) logActivity(config.board_id, null, userId, 'shopify.imported', { order: order.name, cards: created });
  logOrder({ source, order, status: created ? 'created' : 'exists', cards: created, detail: created ? '' : 'Os cards deste pedido já existiam' });
  return created;
}

/** O webhook do pedido não traz as fotos dos produtos: busca pela API (se houver acesso) */
async function enrichImages(order, config) {
  if (order.line_items.every((li) => li.image_url) || !hasApiAccess(config)) return;
  try {
    const found = await fetchLineItemImages(config, order.id);
    for (const li of order.line_items) li.image_url ||= found[li.id] || null;
  } catch (err) {
    console.error(`[shopify] fotos do pedido ${order.name}:`, err.message);
  }
}

/** Foto de cada item do pedido (id do item → URL), pela Admin API */
async function fetchLineItemImages(config, orderId) {
  const data = await graphql(config, `query($id: ID!) { order(id: $id) { lineItems(first: 100) { nodes { id image { url } customAttributes { key value } } } } }`,
    { id: `gid://shopify/Order/${orderId}` });
  if (!data.order) throw new Error('pedido não encontrado na Shopify');
  return Object.fromEntries(data.order.lineItems.nodes.map((li) => [gidToId(li.id), li.image?.url || null]));
}

/** Busca e anexa a foto do pedido a um card já existente (botão no card) */
async function attachOrderImages(card, userId) {
  const { orderId, lineItemId } = orderRef(card) || {};
  if (!orderId) throw new Error('Este card não veio de um pedido do Shopify.');
  const config = getConfig();
  if (!hasApiAccess(config)) throw new Error('Conecte a loja em Configurações → Shopify para buscar as fotos.');
  const found = await fetchLineItemImages(config, orderId);
  const urls = lineItemId ? [found[lineItemId]] : Object.values(found);
  if (!urls.filter(Boolean).length) throw new Error('A Shopify não tem foto cadastrada para este produto.');
  return images.attachRemoteImages(card.id, urls, { userId });
}

/** Pedido do Shopify ligado ao card (id do pedido e do item), a partir do external_id "shopify:pedido:item" */
function orderRef(card) {
  const [, orderId, lineItemId] = /^shopify:(\d+)(?::(\d+))?/.exec(card?.external_id || '') || [];
  return orderId ? { orderId, lineItemId } : null;
}

/** Link do pedido no admin da Shopify (para quem tem acesso à loja) */
function adminOrderUrl(card, config = getConfig()) {
  const ref = orderRef(card);
  return ref && config.shop_domain ? `https://${config.shop_domain}/admin/orders/${ref.orderId}` : null;
}

/**
 * Troca o link dos cards antigos (admin da Shopify) pelo link aberto do pedido, o mesmo que o cliente recebe
 * (ex.: https://account.sualoja.com.br/orders/…). Busca até 50 pedidos por consulta.
 */
async function refreshOrderLinks(config = getConfig(), userId = null) {
  const rows = q.all("SELECT id, board_id, external_id, external_url FROM cards WHERE external_id LIKE 'shopify:%'");
  const byOrder = new Map();
  for (const r of rows) {
    const ref = orderRef(r);
    if (ref) (byOrder.get(ref.orderId) || byOrder.set(ref.orderId, []).get(ref.orderId)).push(r);
  }
  const ids = [...byOrder.keys()];
  let updated = 0;
  let missing = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await graphql(config, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id statusPageUrl } } }`,
      { ids: chunk.map((id) => `gid://shopify/Order/${id}`) });
    const found = Object.fromEntries((data.nodes || []).filter((n) => n?.statusPageUrl).map((n) => [gidToId(n.id), n.statusPageUrl]));
    for (const id of chunk) {
      if (!found[id]) { missing += byOrder.get(id).length; continue; }
      for (const card of byOrder.get(id)) {
        if (card.external_url === found[id]) continue;
        q.run('UPDATE cards SET external_url = ? WHERE id = ?', found[id], card.id);
        updated++;
      }
    }
  }
  if (updated) {
    for (const boardId of new Set(rows.map((r) => r.board_id))) logActivity(boardId, null, userId, 'shopify.links', { cards: updated });
  }
  return { cards: rows.length, updated, missing };
}

/**
 * Prazo do card = data de entrega prometida − prazo dos Correios (− folga).
 * Se não der para calcular, mantém o prazo padrão e explica o motivo na descrição.
 */
async function applyCorreios(data, order, config, correiosConfig) {
  const promised = correios.promisedDate({ props: data.props, attributes: order.attributes, note: order.note, createdAt: order.created_at }, correiosConfig);
  data.shipping = { ...data.shipping, promised };
  let values = { promised_date: promised, shipping_zip: data.shipping.zip };
  try {
    const r = await correios.deadline({ zip: order.zip, promised }, correiosConfig);
    data.dueDate = r.dueDate;
    data.shipping = { ...data.shipping, days: r.days, service: r.service };
    data.description += `\n\n📦 ${r.summary}`;
    values = r.values;
  } catch (err) {
    data.description += `\n\n⚠️ Prazo dos Correios não calculado (${err.message}). Foi usado o prazo padrão.`;
  }
  for (const [fieldId, source] of Object.entries(config.mapping || {})) {
    if (source in values && values[source] != null && values[source] !== '') data.fields[fieldId] = values[source];
  }
}

// ---------------- Acesso à Admin API ----------------
// Desde 01/01/2026 a Shopify não deixa mais criar "apps personalizados" no admin (que davam o token shpat_).
// Apps novos são criados no Dev Dashboard e o sistema troca Client ID + Client secret por um token
// que vale 24 h (client credentials grant). O token shpat_ antigo continua aceito para apps já existentes.
const tokenCache = new Map();

/**
 * Aceita "minhaloja", "minhaloja.myshopify.com", o link do admin (admin.shopify.com/store/minhaloja)
 * ou uma URL completa, e devolve sempre "minhaloja.myshopify.com" — o único endereço aceito pela API.
 */
function normalizeShopDomain(input) {
  const s = String(input || '').trim().toLowerCase();
  const admin = /admin\.shopify\.com\/store\/([a-z0-9-]+)/.exec(s);
  if (admin) return `${admin[1]}.myshopify.com`;
  const host = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host) return '';
  return host.includes('.') ? host : `${host}.myshopify.com`;
}

/** fetch com mensagem clara quando a loja nem responde (domínio errado, sem internet…) */
async function shopFetch(config, path, opts) {
  try {
    return await fetch(`https://${config.shop_domain}${path}`, opts);
  } catch (err) {
    const code = err.cause?.code || err.code || '';
    if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
      throw new Error(`A loja "${config.shop_domain}" não foi encontrada. Use o domínio .myshopify.com (aparece em Configurações → Domínios no admin da Shopify) ou cole o link do admin (admin.shopify.com/store/…).`);
    }
    throw new Error(`Não consegui me comunicar com a Shopify (${code || err.message}). Tente de novo em alguns minutos.`);
  }
}

/** Monta uma mensagem legível a partir dos erros da GraphQL da Shopify */
function graphqlError(status, body) {
  const list = Array.isArray(body.errors) ? body.errors : body.errors ? [body.errors] : [];
  const text = list.map((e) => (typeof e === 'string' ? e : e.message)).filter(Boolean).join('; ') || JSON.stringify(body).slice(0, 200);
  if (status === 401) return 'A Shopify não aceitou as credenciais (401). Confira o Client ID/secret e se o app está instalado na loja.';
  if (status === 403 || /access denied|ACCESS_DENIED/i.test(text)) {
    return `Acesso negado pela Shopify: ${text}. Confira os escopos do app (read_orders, read_products, read_customers), lance uma nova versão no Dev Dashboard e aprove a atualização na loja.`;
  }
  if (status === 404) return 'Loja ou versão da API não encontrada (404). Confira o domínio .myshopify.com.';
  return `A Shopify respondeu ${status}: ${text}`;
}

const hasApiAccess = (config) => !!(config.shop_domain && (config.access_token || (config.client_id && config.client_secret)));

/** Lê a resposta do endpoint de token, que pode vir em JSON ou em texto/HTML ("Oauth error shop_not_permitted: …") */
async function readTokenResponse(res) {
  const text = await res.text().catch(() => '');
  let body = {};
  try { body = JSON.parse(text); } catch { /* não é JSON */ }
  const detail = body.error_description || body.error || (typeof body.errors === 'string' ? body.errors : '')
    || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { body, detail };
}

function tokenError(status, detail) {
  if (/shop_not_permitted/.test(detail)) {
    return new Error('A Shopify não liberou o acesso por Client ID/secret porque a loja não está na mesma organização do app no Dev Dashboard. Use o botão "Conectar com a Shopify" (autorização direta), que funciona nesse caso.');
  }
  if (/application_cannot_be_found|invalid_client|client_id/i.test(detail)) {
    return new Error(`Client ID ou Client secret não reconhecidos pela Shopify (${detail}). Copie de novo em Dev Dashboard → seu app → Configurações.`);
  }
  if (/not installed|app_not_installed/i.test(detail)) {
    return new Error('O app ainda não está instalado nesta loja. No Dev Dashboard, abra o app e clique em "Instalar app".');
  }
  return new Error(`A Shopify recusou o acesso (erro ${status}${detail ? `: ${detail}` : ''}).`);
}

async function requestToken(config, params) {
  const res = await shopFetch(config, '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const { body, detail } = await readTokenResponse(res);
  if (!res.ok || !body.access_token) throw tokenError(res.status, detail);
  return body;
}

// ---------- Autorização direta (OAuth "authorization code"): funciona com qualquer loja onde o app foi aprovado ----------
const OAUTH_SCOPES = 'read_orders,read_products,read_customers';

function authorizeUrl(config, redirectUri, state) {
  const qs = new URLSearchParams({ client_id: config.client_id, scope: OAUTH_SCOPES, redirect_uri: redirectUri, state });
  return `https://${config.shop_domain}/admin/oauth/authorize?${qs}`;
}

/** Confere a assinatura que a Shopify coloca nos parâmetros de retorno (hmac) */
function verifyCallback(query, secret) {
  const { hmac, ...rest } = query;
  if (!hmac || !secret) return false;
  const message = Object.keys(rest).sort().map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return digest.length === String(hmac).length && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(hmac)));
}

function saveOAuth(body) {
  const stored = getSetting('shopify', {});
  const oauth = {
    access_token: body.access_token,
    expires_at: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null,
    refresh_token: body.refresh_token || stored.oauth?.refresh_token || null,
    refresh_expires_at: body.refresh_token_expires_in ? Date.now() + Number(body.refresh_token_expires_in) * 1000 : stored.oauth?.refresh_expires_at || null,
    scope: body.scope || '',
    connected_at: stored.oauth?.connected_at || new Date().toISOString(),
  };
  setSetting('shopify', { ...stored, oauth });
  return oauth;
}

async function exchangeCode(config, code) {
  const body = await requestToken(config, { client_id: config.client_id, client_secret: config.client_secret, code, expiring: '1' });
  const stored = getSetting('shopify', {});
  delete stored.oauth; // nova conexão
  setSetting('shopify', stored);
  const oauth = saveOAuth(body);
  tokenCache.clear();
  return oauth;
}

async function accessToken(config) {
  if (config.access_token) return config.access_token; // app antigo criado no admin (shpat_)
  if (!config.client_id || !config.client_secret) throw new Error('Informe o Client ID e o Client secret do app criado no Dev Dashboard da Shopify.');

  // 1) Autorização direta, se já foi feita (renova sozinha com o refresh token)
  const oauth = config.oauth;
  if (oauth?.access_token) {
    if (!oauth.expires_at || oauth.expires_at > Date.now() + 5 * 60000) return oauth.access_token;
    if (oauth.refresh_token && (!oauth.refresh_expires_at || oauth.refresh_expires_at > Date.now())) {
      const body = await requestToken(config, { client_id: config.client_id, client_secret: config.client_secret, grant_type: 'refresh_token', refresh_token: oauth.refresh_token });
      return saveOAuth(body).access_token;
    }
    throw new Error('A autorização da Shopify expirou. Clique em "Conectar com a Shopify" de novo.');
  }

  // 2) Client credentials (app e loja na mesma organização do Dev Dashboard)
  const key = `${config.shop_domain}:${config.client_id}`;
  const cached = tokenCache.get(key);
  if (cached && cached.exp > Date.now() + 5 * 60000) return cached.token;
  const body = await requestToken(config, { grant_type: 'client_credentials', client_id: config.client_id, client_secret: config.client_secret });
  tokenCache.set(key, { token: body.access_token, exp: Date.now() + Number(body.expires_in || 86399) * 1000 });
  return body.access_token;
}

async function graphql(config, query, variables = {}) {
  if (!hasApiAccess(config)) throw new Error('Informe o domínio da loja e o Client ID + Client secret do app (ou o token shpat_ de um app antigo).');
  const res = await shopFetch(config, `/admin/api/${config.api_version || DEFAULT_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await accessToken(config) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) throw new Error(graphqlError(res.status, body));
  if (!body.data) throw new Error('A Shopify devolveu uma resposta inesperada. Confira se o domínio é o .myshopify.com da loja (e não o domínio próprio do site).');
  return body.data;
}

const ORDER_FIELDS = `
  id legacyResourceId name createdAt note email phone currencyCode displayFinancialStatus statusPageUrl
  customAttributes { key value }
  totalPriceSet { shopMoney { amount } }
  customer { firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
  shippingAddress { name address1 address2 city province provinceCode zip country phone }
  lineItems(first: 50) { nodes {
    id title variantTitle sku vendor quantity
    image { url }
    originalUnitPriceSet { shopMoney { amount } }
    customAttributes { key value }
    product { id tags productType }
  } }`;

async function fetchRecentOrders(config, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const orders = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const data = await graphql(config, `query($q: String, $after: String) {
      orders(first: 50, after: $after, sortKey: CREATED_AT, query: $q) {
        nodes { ${ORDER_FIELDS} }
        pageInfo { hasNextPage endCursor }
      } }`, { q: `created_at:>=${since}`, after });
    orders.push(...data.orders.nodes.map((o) => normalizeGraphqlOrder(o, config.shop_domain)));
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return orders;
}

/** Busca um pedido pelo número (#1001 ou 1001) */
async function fetchOrderByName(config, name) {
  const clean = String(name || '').trim().replace(/^#/, '');
  if (!/^[\w-]+$/.test(clean)) throw new Error('Informe o número do pedido, ex.: #1001.');
  const data = await graphql(config, `query($q: String) { orders(first: 1, query: $q) { nodes { ${ORDER_FIELDS} } } }`, { q: `name:${clean}` });
  const o = data.orders.nodes[0];
  if (!o) throw new Error(`Pedido #${clean} não encontrado na loja.`);
  return normalizeGraphqlOrder(o, config.shop_domain);
}

/** Webhooks que o app tem registrados na loja (para conferir se os pedidos novos vão chegar) */
async function listWebhooks(config) {
  const data = await graphql(config, '{ webhookSubscriptions(first: 50) { nodes { id topic uri } } }');
  return data.webhookSubscriptions.nodes;
}

async function fetchProductInfo(config, productIds) {
  const data = await graphql(config, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id tags productType } } }`,
    { ids: productIds.map((id) => `gid://shopify/Product/${id}`) });
  return Object.fromEntries(data.nodes.filter(Boolean).map((p) => [gidToId(p.id), { tags: p.tags, productType: p.productType }]));
}

async function registerWebhook(config, callbackUrl) {
  // Na API atual o endereço vai no campo `uri` (o antigo `callbackUrl` foi removido)
  const data = await graphql(config, `mutation($url: String!) {
    webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { uri: $url, format: JSON }) {
      webhookSubscription { id }
      userErrors { field message }
    } }`, { url: callbackUrl });
  const errors = data.webhookSubscriptionCreate.userErrors;
  if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
  return data.webhookSubscriptionCreate.webhookSubscription.id;
}

module.exports = {
  SOURCES, getConfig, verifyHmac, normalizeRestOrder, normalizeGraphqlOrder, matchLineItem, buildCards,
  importOrder, fetchRecentOrders, registerWebhook, graphql, renderTemplate, hasApiAccess, accessToken, normalizeShopDomain, attachOrderImages, DEFAULT_API_VERSION, authorizeUrl, verifyCallback, exchangeCode,
  refreshOrderLinks, adminOrderUrl, logOrder, recentLog, fetchOrderByName, listWebhooks,
};
