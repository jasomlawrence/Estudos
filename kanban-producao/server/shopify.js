'use strict';
// Integração Shopify: recebe pedidos (webhook) e transforma pedidos de anel de noivado em cards
const crypto = require('node:crypto');
const { q, getSetting } = require('./db');
const { createCard, logActivity } = require('./cards');
const correios = require('./correios');

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
    })),
  };
}

/** O item do pedido é um anel de noivado (ou o que estiver configurado)? */
function matchLineItem(li, config, productInfo = {}) {
  const keywords = splitList(config.keywords).map(fold);
  const productIds = splitList(config.product_ids);
  const tags = splitList(config.tags).map(fold);
  if (!keywords.length && !productIds.length && !tags.length) return true; // sem filtro: todo pedido entra
  const haystack = fold([li.title, li.variant_title, li.sku, li.vendor].join(' '));
  if (keywords.some((k) => haystack.includes(k))) return true;
  if (li.product_id && productIds.includes(li.product_id)) return true;
  const info = productInfo[li.product_id] || {};
  const productTags = (li.product_tags || info.tags || []).map(fold);
  const productType = fold(li.product_type || info.productType || '');
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
      externalUrl: order.admin_url,
      title: renderTemplate(config.title_template, values) + (g.unit ? ` (${g.unit})` : '') || order.name,
      description,
      fields,
      dueDate,
      labels: config.label_ids || [],
      props: Object.assign({}, ...g.items.map((li) => li.properties)),
      shipping: { zip: correios.onlyDigits(order.zip) || null },
    };
  });
}

/** Grava os cards de um pedido. Retorna quantos foram criados (pedidos repetidos são ignorados). */
async function importOrder(order, config = getConfig(), userId = null) {
  if (!config.board_id || !config.column_id) throw new Error('Escolha o quadro e a coluna de entrada nas configurações do Shopify.');
  let productInfo = {};
  if (splitList(config.tags).length && hasApiAccess(config)) {
    const ids = [...new Set(order.line_items.filter((li) => li.product_id && !li.product_tags).map((li) => li.product_id))];
    if (ids.length) productInfo = await fetchProductInfo(config, ids).catch(() => ({}));
  }
  let created = 0;
  const correiosConfig = correios.getConfig();
  for (const data of buildCards(order, config, productInfo)) {
    if (q.get('SELECT id FROM cards WHERE external_id = ?', data.externalId)) continue;
    if (correiosConfig.enabled) await applyCorreios(data, order, config, correiosConfig);
    try {
      createCard({ ...data, boardId: config.board_id, columnId: config.column_id, source: 'shopify' }, userId);
      created++;
    } catch (err) {
      if (!/UNIQUE/.test(err.message)) throw err; // webhook duplicado chegando ao mesmo tempo
    }
  }
  if (created) logActivity(config.board_id, null, userId, 'shopify.imported', { order: order.name, cards: created });
  return created;
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

async function accessToken(config) {
  if (config.access_token) return config.access_token;
  if (!config.client_id || !config.client_secret) throw new Error('Informe o Client ID e o Client secret do app criado no Dev Dashboard da Shopify.');
  const key = `${config.shop_domain}:${config.client_id}`;
  const cached = tokenCache.get(key);
  if (cached && cached.exp > Date.now() + 5 * 60000) return cached.token;
  const res = await shopFetch(config, '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.client_id, client_secret: config.client_secret }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const reason = body.error_description || body.error || `erro ${res.status}`;
    if (/shop_not_permitted/.test(reason)) throw new Error('A Shopify não permitiu o acesso: o app precisa ser criado no Dev Dashboard da mesma organização da loja e estar instalado nela.');
    if (/application_cannot_be_found|invalid_client/.test(reason)) throw new Error('Client ID ou Client secret incorretos (copie de novo em Dev Dashboard → seu app → Configurações).');
    throw new Error(`A Shopify recusou o acesso: ${reason}. Confira se o app está instalado na loja e se o domínio é o .myshopify.com.`);
  }
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
  id legacyResourceId name createdAt note email phone currencyCode displayFinancialStatus
  customAttributes { key value }
  totalPriceSet { shopMoney { amount } }
  customer { firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
  shippingAddress { name address1 address2 city province provinceCode zip country phone }
  lineItems(first: 50) { nodes {
    id title variantTitle sku vendor quantity
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
  importOrder, fetchRecentOrders, registerWebhook, graphql, renderTemplate, hasApiAccess, accessToken, normalizeShopDomain, DEFAULT_API_VERSION,
};
