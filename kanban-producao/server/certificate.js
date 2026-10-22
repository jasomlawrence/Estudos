'use strict';
// Leitura automática da foto do certificado (IGI, GIA…) ou da etiqueta da moissanite com o Claude (API da Anthropic).
// A chave fica nas configurações do Estoque (ou na variável ANTHROPIC_API_KEY). Sem chave, o cadastro é feito à mão.
const fs = require('node:fs');
const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('./db');
const stock = require('./stock');

const MODEL = 'claude-opus-5-5';

function apiKey() {
  return String(getSetting('stock_ai', {}).api_key || process.env.ANTHROPIC_API_KEY || '').trim();
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['legible', 'kind', 'code', 'shape', 'measurements', 'carat', 'color', 'clarity', 'cut_grade', 'polish', 'symmetry', 'fluorescence', 'lab', 'method', 'report_date', 'problems'],
  properties: {
    legible: { type: 'boolean', description: 'false se a foto não for de um certificado/etiqueta de pedra ou estiver ilegível' },
    kind: { type: 'string', enum: ['lab', 'moissanite', 'unknown'] },
    code: { type: 'string', description: 'Número do relatório/etiqueta exatamente como impresso, com o prefixo (ex.: "LG797609310", "GRA 28063453")' },
    shape: { type: 'string', enum: stock.SHAPES },
    measurements: { type: 'string', description: 'Medidas como impressas, sem "mm" (ex.: "9.75 x 6.33 x 3.71", "3.45 - 3.48 x 2.07", "7 x 7")' },
    carat: { type: 'string', description: 'Peso em quilates, só o número com ponto (ex.: "1.51"), ou ""' },
    color: { type: 'string' },
    clarity: { type: 'string', description: 'Ex.: "VVS2", "VS1" ou ""' },
    cut_grade: { type: 'string' },
    polish: { type: 'string' },
    symmetry: { type: 'string' },
    fluorescence: { type: 'string' },
    lab: { type: 'string', description: 'Laboratório emissor (IGI, GIA, GRA…) ou ""' },
    method: { type: 'string', description: '"CVD", "HPHT" ou ""' },
    report_date: { type: 'string', description: 'Data do certificado em AAAA-MM-DD, ou ""' },
    problems: { type: 'string', description: 'Campos ilegíveis ou dúvidas, em português; "" se tudo estiver legível' },
  },
};

const PROMPT = `Esta é a foto de um certificado de diamante cultivado em laboratório (IGI, GIA etc.) ou da etiqueta do envelope de uma moissanite (ex.: "Trillion 7*7mm 1.2ct D GRA 28063453").
Extraia os campos para o estoque de uma joalheria. Regras:
- Copie os valores exatamente como impressos; não invente. Campo que não aparece fica "".
- Se a foto mostra duas vias do mesmo certificado, use os dados uma vez só.
- code: o número do relatório (Report Number) ou o código da etiqueta, com o prefixo impresso (LG…, GRA …). Ignore números de código de barras.
- shape: converta o corte para a lista (Round → Redonda, Pear → Gota, Marquise → Navete, Cushion → Almofada, Heart → Coração, Trillion/Trilliant → Trilliant; use "Outro" se não houver correspondência).
- kind: "moissanite" para moissanite (etiqueta GRA ou texto "moissanite"), "lab" para "Laboratory Grown Diamond".
- method: CVD ou HPHT quando aparecer nos comentários.`;

/**
 * Lê a foto (JPEG/PNG já comprimida pelo navegador) e devolve os campos prontos para o formulário.
 * Lança erro com mensagem amigável quando a chave falta ou a leitura falha.
 */
async function readCertificate(filePath, mime, { client = null } = {}) {
  const key = apiKey();
  if (!client && !key) {
    const err = new Error('A leitura automática não está configurada. Preencha os campos à mão ou peça ao administrador para colocar a chave da API no Estoque → Leitura automática.');
    err.status = 400;
    throw err;
  }
  const api = client || new Anthropic({ apiKey: key, maxRetries: 2, timeout: 90_000 });
  let response;
  try {
    response = await api.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime === 'image/png' ? 'image/png' : 'image/jpeg', data: fs.readFileSync(filePath).toString('base64') } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });
  } catch (err) {
    const e = new Error(err instanceof Anthropic.AuthenticationError ? 'A chave da API da Anthropic foi recusada. Confira em Estoque → Leitura automática.'
      : err instanceof Anthropic.RateLimitError ? 'Muitas leituras seguidas. Tente de novo em alguns segundos.'
        : err instanceof Anthropic.APIError && err.status === 400 && /credit|billing|balance/i.test(err.message) ? 'A conta da Anthropic está sem crédito. Adicione crédito em console.anthropic.com.'
          : `Não deu para ler a foto agora (${err.message}). Preencha os campos à mão.`);
    e.status = 502;
    throw e;
  }
  if (response.stop_reason === 'refusal') {
    const e = new Error('A leitura automática recusou esta foto. Preencha os campos à mão.');
    e.status = 422;
    throw e;
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try { data = JSON.parse(text); } catch {
    const e = new Error('A leitura automática não devolveu os campos. Preencha à mão.');
    e.status = 502;
    throw e;
  }
  return toForm(data);
}

/** Resposta do modelo → campos do formulário do estoque (formatos brasileiros) */
function toForm(d) {
  return {
    legible: d.legible !== false,
    kind: d.kind === 'moissanite' ? 'moissanite' : 'lab',
    code: String(d.code || '').trim(),
    shape: stock.shapeName(d.shape),
    measurements: stock.formatMeasurements(d.measurements),
    carat: stock.parseCarat(d.carat),
    color: String(d.color || '').trim().toUpperCase(),
    clarity: String(d.clarity || '').replace(/\s+/g, '').toUpperCase(),
    cut_grade: titleCase(d.cut_grade),
    polish: titleCase(d.polish),
    symmetry: titleCase(d.symmetry),
    fluorescence: titleCase(d.fluorescence),
    lab: String(d.lab || '').trim().toUpperCase(),
    method: String(d.method || '').trim().toUpperCase(),
    report_date: /^\d{4}-\d{2}-\d{2}$/.test(d.report_date || '') ? d.report_date : '',
    problems: String(d.problems || '').trim(),
  };
}

const titleCase = (s) => String(s || '').trim().toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

module.exports = { readCertificate, toForm, apiKey, MODEL };
