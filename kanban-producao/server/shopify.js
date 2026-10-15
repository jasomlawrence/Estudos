'use strict';
// Integração Shopify: recebe pedidos (webhook) e transforma pedidos de anel de noivado em cards
const crypto = require('node:crypto');
const { q, getSetting } = require('./db');
const { createCard, logActivity } = require('./cards');

const DEFAULT_API_VERSION = '2025-07';

// Dados do pedido que podem preencher campos do card
const SOURCES = [
  { key: 'order_name', label: 'Número do pedido (#1001)' },
  { key: 'created_at', label: 'Data do pedido' },
  { key: 'customer_name', label: 'Nome do cliente' },
  { key: 'customer_email', label: 'E-mail do cliente' },
  { key: 'customer_phone', label: 'Telefone do cliente' },
  { key: 'shipping_address', label: 'Endereço de entrega' },
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
  return {
    enabled: false,
    shop_domain: '',
    webhook_secret: '',
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
    ...getSetting('shopify', {}),
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
    email: o.email || c.email || '',
    phone: o.phone || c.phone || o.shippingAddress?.phone || '',
    note: o.note || '',
    currency: o.currencyCode,
    total_price: o.totalPriceSet?.shopMoney?.amount,
    financial_status: (o.displayFinancialStatus || '').toLowerCase(),
    customer_name: [c.firstName, c.lastName].filter(Boolean).join(' ') || o.shippingAddress?.name || '',
    shipping_address: formatAddress(addr),
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
    };
  });
}

/** Grava os cards de um pedido. Retorna quantos foram criados (pedidos repetidos são ignorados). */
async function importOrder(order, config = getConfig(), userId = null) {
  if (!config.board_id || !config.column_id) throw new Error('Escolha o quadro e a coluna de entrada nas configurações do Shopify.');
  let productInfo = {};
  if (splitList(config.tags).length && config.access_token) {
    const ids = [...new Set(order.line_items.filter((li) => li.product_id && !li.product_tags).map((li) => li.product_id))];
    if (ids.length) productInfo = await fetchProductInfo(config, ids).catch(() => ({}));
  }
  let created = 0;
  for (const data of buildCards(order, config, productInfo)) {
    if (q.get('SELECT id FROM cards WHERE external_id = ?', data.externalId)) continue;
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

async function graphql(config, query, variables = {}) {
  if (!config.shop_domain || !config.access_token) throw new Error('Informe o domínio da loja e o token de acesso da Admin API.');
  const res = await fetch(`https://${config.shop_domain}/admin/api/${config.api_version || DEFAULT_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.access_token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) throw new Error(`Shopify respondeu ${res.status}: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  return body.data;
}

const ORDER_FIELDS = `
  id legacyResourceId name createdAt note email phone currencyCode displayFinancialStatus
  totalPriceSet { shopMoney { amount } }
  customer { firstName lastName email phone }
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
  const data = await graphql(config, `mutation($url: URL!) {
    webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { callbackUrl: $url, format: JSON }) {
      webhookSubscription { id }
      userErrors { field message }
    } }`, { url: callbackUrl });
  const errors = data.webhookSubscriptionCreate.userErrors;
  if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
  return data.webhookSubscriptionCreate.webhookSubscription.id;
}

module.exports = {
  SOURCES, getConfig, verifyHmac, normalizeRestOrder, normalizeGraphqlOrder, matchLineItem, buildCards,
  importOrder, fetchRecentOrders, registerWebhook, graphql, renderTemplate,
};
