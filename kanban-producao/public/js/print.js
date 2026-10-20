// Etiquetas de impressão (Zebra ZD220 e outras térmicas): modelo, prévia e impressão pelo navegador
import qrcode from '/vendor/qrcode/qrcode.mjs';
import { h, clear, fieldText, icon, checklistItems } from './util.js';
import { get, put, post, attempt, modal, toast, confirmDialog } from './api.js';
import { state, columnById, labelById, userById, canEdit } from './state.js';

/* global Sortable, JsBarcode */

// Tamanhos P / M / G / GG
const FONT_PT = { s: 9, m: 12, l: 16, xl: 22 };
const QR_MM = { s: 18, m: 26, l: 34, xl: 44 };
const PHOTO_MM = { s: 22, m: 34, l: 48, xl: 70 };
const BAR_MM = { s: 8, m: 12, l: 16, xl: 22 };
const SIZE_LABELS = [['s', 'P'], ['m', 'M'], ['l', 'G'], ['xl', 'GG']];

const BASE_ITEMS = [
  ['title', 'Título do card'], ['card_id', 'Número do card'], ['column', 'Etapa (coluna)'], ['due_date', 'Prazo de entrega'],
  ['created_at', 'Data de entrada'], ['labels', 'Etiquetas'], ['members', 'Responsáveis'], ['description', 'Descrição'],
  ['photo', 'Foto (capa do card)'], ['qr', 'QR code (abre o card)'], ['barcode', 'Código de barras'], ['text', 'Texto fixo'], ['divider', 'Linha divisória'],
];
const NAMED = new Set(['column', 'due_date', 'created_at', 'labels', 'members', 'description', 'card_id']);

const fieldOf = (key) => { const m = /^field:(\d+)$/.exec(key); return m ? state.fields.find((f) => f.id === Number(m[1])) : null; };
function itemName(key) {
  const f = fieldOf(key);
  if (f) return f.name;
  return BASE_ITEMS.find(([k]) => k === key)?.[1] || key;
}
const fmtDate = (iso, withTime = false) => (iso ? new Date(iso).toLocaleString('pt-BR', withTime ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short' }) : '');

// ---------- Código de barras (biblioteca carregada só quando usada) ----------
let barcodeLib;
function loadBarcode() {
  barcodeLib ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsbarcode/JsBarcode.all.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Não foi possível carregar o gerador de código de barras.'));
    document.head.append(s);
  });
  return barcodeLib;
}

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const box = h('div', { class: 'lbl-qr' });
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  return box;
}

function barcodeSvg(value) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try {
    JsBarcode(svg, String(value), { format: 'CODE128', displayValue: true, margin: 0, fontSize: 14, height: 60, width: 2 });
  } catch { return h('span', { class: 'lbl-warn' }, 'Código inválido'); }
  // Escala sem distorcer: o tamanho vem do viewBox, a altura vem do tamanho escolhido (P/M/G/GG)
  const w = parseFloat(svg.getAttribute('width'));
  const hgt = parseFloat(svg.getAttribute('height'));
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  svg.classList.add('lbl-barcode');
  return svg;
}

// ---------- Desenho de uma etiqueta ----------
/** Tamanho do conteúdo: deitada = largura e altura trocadas (o conteúdo é girado na hora de imprimir) */
const contentSize = (t) => (t.orientation === 'landscape' ? [t.height_mm, t.width_mm] : [t.width_mm, t.height_mm]);

function itemContent(item, card) {
  const named = (name, value) => [item.show_name ? h('span', { class: 'lbl-name' }, `${name}: `) : null, value];
  const f = fieldOf(item.key);
  if (f?.type === 'checklist') {
    // Lista de verificação impressa com quadradinhos (para conferir à mão na bancada)
    const items = checklistItems(f, card.fields[f.id]);
    return [item.show_name ? h('span', { class: 'lbl-name lbl-block' }, `${f.name}:`) : null,
      h('ul', { class: 'lbl-check' }, items.map((it) => h('li', {}, `${it.done ? '☑' : '☐'} ${it.label}`)))];
  }
  if (f) {
    const v = card.fields[f.id];
    const text = fieldText(f, v) || '—';
    return named(f.name, h('span', {}, text));
  }
  switch (item.key) {
    case 'title': return h('span', {}, card.title);
    case 'card_id': return named('Card', h('span', {}, `#${card.id}`));
    case 'column': return named('Etapa', h('span', {}, columnById(card.column_id)?.name || '—'));
    case 'due_date': return named('Prazo', h('span', {}, fmtDate(card.due_date) || 'sem prazo'));
    case 'created_at': return named('Entrada', h('span', {}, fmtDate(card.created_at)));
    case 'labels': {
      const list = card.labels.map(labelById).filter(Boolean);
      return named('Etiquetas', list.length ? list.map((l) => h('span', { class: 'lbl-chip' }, l.name || '•')) : h('span', {}, '—'));
    }
    case 'members': return named('Responsáveis', h('span', {}, card.members.map(userById).filter(Boolean).map((u) => u.name).join(', ') || '—'));
    case 'description': return named('Descrição', h('span', { class: 'lbl-desc' }, (card.description || '—').replace(/\*\*/g, '')));
    case 'text': return h('span', {}, item.text || '');
    case 'divider': return h('hr', { class: 'lbl-hr' });
    case 'qr': {
      const box = qrSvg(`${location.origin}/#card=${card.id}`);
      box.style.width = box.style.height = `calc(${QR_MM[item.size]}mm * var(--fit))`;
      return box;
    }
    case 'photo': {
      if (!card.cover) return h('div', { class: 'lbl-photo empty', style: { height: `calc(${PHOTO_MM[item.size]}mm * var(--fit))` } }, 'sem foto');
      return h('img', { class: 'lbl-photo', src: card.cover, alt: '', style: { height: `calc(${PHOTO_MM[item.size]}mm * var(--fit))` } });
    }
    case 'barcode': {
      const src = item.source || 'card_id';
      const sf = fieldOf(src);
      const value = sf ? fieldText(sf, card.fields[sf.id]) : String(card.id);
      if (!value) return h('span', { class: 'lbl-warn' }, `${sf?.name || 'Campo'} vazio`);
      const svg = barcodeSvg(value);
      if (svg.style) {
        svg.style.height = `calc(${BAR_MM[item.size]}mm * var(--fit))`;
        svg.setAttribute('preserveAspectRatio', `${{ left: 'xMin', center: 'xMid', right: 'xMax' }[item.align || 'left']}YMin meet`);
      }
      return svg;
    }
    default: return null;
  }
}

/** Conteúdo de uma etiqueta no tamanho real (mm) */
export function renderLabel(card, tpl) {
  const [w, hgt] = contentSize(tpl);
  const box = h('div', { class: 'plabel', style: { width: `${w}mm`, height: `${hgt}mm`, padding: `${tpl.margin_mm}mm`, '--fit': '1' } });
  for (const item of tpl.items) {
    const content = itemContent(item, card);
    if (content == null) continue;
    box.append(h('div', {
      class: `lbl-item ${item.width} key-${item.key.replace(':', '-')}${item.bold ? ' bold' : ''}`,
      style: { fontSize: `calc(${FONT_PT[item.size] || 12}pt * var(--fit))`, textAlign: item.align || 'left', justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[item.align || 'left'] },
    }, content));
  }
  return box;
}

/** Diminui tudo aos poucos até caber (texto longo, muitos campos); avisa se ainda assim não couber */
function fit(box) {
  let f = 1;
  box.style.setProperty('--fit', '1');
  while (box.scrollHeight > box.clientHeight + 1 && f > 0.55) {
    f -= 0.05;
    box.style.setProperty('--fit', f.toFixed(2));
  }
  box.classList.toggle('overflow', box.scrollHeight > box.clientHeight + 1);
  return f;
}

// ---------- Modelos ----------
async function loadTemplates() {
  return get(`/boards/${state.boardId}/print-templates`);
}

const needsBarcode = (tpl) => tpl.items.some((i) => i.key === 'barcode');

// ---------- Prévia e impressão ----------
export async function openPrint(cardIds) {
  if (!cardIds.length) return toast('Selecione pelo menos um card.', 'error');
  const [data, cards] = await Promise.all([loadTemplates(), get(`/boards/${state.boardId}/cards?ids=${cardIds.join(',')}`)]);
  let tpl = data.templates.find((t) => t.id === data.default_id) || data.templates[0];
  const m = modal({ title: `Imprimir ${cards.length} etiqueta${cards.length > 1 ? 's' : ''}`, wide: true, className: 'print-modal' });
  const sheet = h('div', { class: 'print-preview' });
  const info = h('span', { class: 'muted small' });
  const select = h('select', { onchange: () => { tpl = data.templates.find((t) => t.id === select.value); draw(); } },
    data.templates.map((t) => h('option', { value: t.id, selected: t.id === tpl.id }, t.name)));
  const printBtn = h('button', { class: 'btn primary', onclick: () => doPrint(cards, tpl) }, icon('printer', 16), 'Imprimir');
  m.body.append(
    h('div', { class: 'print-toolbar' },
      h('label', { class: 'row' }, 'Modelo:', select), info,
      h('div', { class: 'grow' }),
      canEdit() ? h('button', { class: 'btn subtle', onclick: () => { m.close(); openPrintSettings(); } }, 'Editar modelos') : null,
      printBtn),
    sheet,
    setupHelp());

  async function draw() {
    if (needsBarcode(tpl)) await loadBarcode();
    clear(sheet);
    const [w] = contentSize(tpl);
    const zoom = Math.min(1, 300 / (w * 3.78)); // cada etiqueta com ~300 px de largura na tela
    let cut = 0;
    for (const card of cards) {
      const label = renderLabel(card, tpl);
      sheet.append(h('div', { class: 'print-thumb', style: { zoom: String(zoom) } }, label));
      fit(label);
      if (label.classList.contains('overflow')) cut++;
    }
    info.textContent = `${tpl.width_mm} × ${tpl.height_mm} mm · ${tpl.orientation === 'landscape' ? 'deitada' : 'em pé'}${cut ? ` · ⚠ ${cut} etiqueta(s) com conteúdo cortado: tire campos ou diminua o tamanho` : ''}`;
  }
  await draw();
}

/** Monta as páginas no tamanho da etiqueta, abre a janela de impressão e registra no histórico */
async function doPrint(cards, tpl) {
  if (needsBarcode(tpl)) await loadBarcode();
  document.getElementById('print-root')?.remove();
  const root = h('div', { id: 'print-root' });
  const style = h('style', {}, `@page { size: ${tpl.width_mm}mm ${tpl.height_mm}mm; margin: 0; }`);
  const [cw, ch] = contentSize(tpl);
  for (const card of cards) {
    const label = renderLabel(card, tpl);
    const page = h('div', { class: `print-page${tpl.orientation === 'landscape' ? ' landscape' : ''}`, style: { width: `${tpl.width_mm}mm`, height: `${tpl.height_mm}mm` } },
      h('div', { class: 'print-rot', style: { width: `${cw}mm`, height: `${ch}mm`, '--rot-h': `${ch}mm` } }, label));
    root.append(page);
  }
  document.body.append(style, root);
  root.querySelectorAll('.plabel').forEach(fit);
  // Espera as fotos carregarem para não sair etiqueta em branco
  await Promise.all([...root.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
  document.body.classList.add('printing');
  const cleanup = () => { document.body.classList.remove('printing'); root.remove(); style.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
  post('/cards/printed', { ids: cards.map((c) => c.id), template: tpl.name }).catch(() => {});
}

function setupHelp() {
  const link = `${location.origin}`;
  return h('details', { class: 'callout print-help' }, h('summary', {}, 'Configurar a impressora Zebra ZD220 (uma vez só)'),
    h('ol', { class: 'small' },
      h('li', {}, 'No computador da impressora, abra Configurações do Windows → Bluetooth e dispositivos → Impressoras → "ZDesigner ZD220" → Preferências de impressão. (Se ela não aparecer, instale o driver ZDesigner em zebra.com → Suporte → ZD220.)'),
      h('li', {}, 'Em "Opções de página" (Page Setup), defina o papel: largura 100 mm (4,00 pol) e altura 150 mm (6,00 pol), orientação Retrato. Em "Opções avançadas", o tipo de mídia é "com intervalo/etiqueta" e o método é Térmica direta (etiqueta sem ribbon) ou Transferência térmica (com ribbon).'),
      h('li', {}, 'Calibre a etiqueta uma vez: em Preferências → Ferramentas → Ação → Calibrar (ou, com a impressora ligada, segure o botão FEED até a luz piscar 2 vezes e solte). Ela puxa algumas etiquetas e aprende o tamanho.'),
      h('li', {}, 'Na primeira impressão, na janela do Chrome/Edge: Destino "ZDesigner ZD220", Mais definições → Margens "Nenhuma", Escala "Padrão" (100%) e desmarque "Cabeçalhos e rodapés". O navegador lembra essas escolhas.'),
      h('li', {}, 'Se a foto sair clara, aumente a "Escuridão" (Darkness) nas preferências do driver para 20–25.'),
      h('li', {}, ['Para imprimir direto, sem a janela de impressão: deixe a ZD220 como impressora padrão do Windows e crie um atalho do Chrome com ',
        h('code', {}, `chrome.exe --kiosk-printing ${link}`), '. Abrindo o sistema por esse atalho, o botão Imprimir já manda para a Zebra.'])));
}

// ---------- Editor de modelos (Configurações → Impressão) ----------
export function openPrintSettings() {
  import('./settings.js').then(({ openSettings }) => openSettings('printing'));
}

/** Card de exemplo para a prévia do editor: o do quadro com mais campos preenchidos */
function sampleCard() {
  const all = state.columns.flatMap((c) => c.cards || []);
  const best = all.sort((a, b) => Object.keys(b.fields).length + (b.cover ? 2 : 0) - Object.keys(a.fields).length - (a.cover ? 2 : 0))[0];
  return best || {
    id: 1234, title: '#1001 · Maria Silva · Solitário Ouro 18k', column_id: state.columns[1]?.id, due_date: new Date(Date.now() + 5 * 864e5).toISOString(),
    created_at: new Date().toISOString(), labels: state.labels.slice(0, 2).map((l) => l.id), members: [], description: 'Aro 14, gravação "Para sempre".', cover: null,
    fields: Object.fromEntries(state.fields.map((f) => [f.id, f.type === 'select' ? f.options[0]?.id : f.type === 'number' ? 14 : f.type === 'checkbox' ? true : f.type.startsWith('date') ? new Date().toISOString().slice(0, 10) : 'Exemplo'])),
  };
}

export async function printSettingsPanel(panel) {
  const data = await loadTemplates();
  let current = data.templates.find((t) => t.id === data.default_id) || data.templates[0];
  const sample = sampleCard();
  const editable = canEdit();

  const save = async () => {
    const r = await attempt(() => put(`/boards/${state.boardId}/print-templates`, data), 'Modelos de etiqueta salvos');
    if (r) { Object.assign(data, r); current = data.templates.find((t) => t.id === current.id) || data.templates[0]; draw(); }
  };

  const preview = h('div', { class: 'print-editor-preview' });
  const previewInfo = h('p', { class: 'muted small' });
  const redrawPreview = async () => {
    if (needsBarcode(current)) await loadBarcode();
    const label = renderLabel(sample, current);
    const [w] = contentSize(current);
    clear(preview, h('div', { class: 'print-thumb', style: { zoom: String(Math.min(1, 320 / (w * 3.78))) } }, label));
    const f = fit(label);
    previewInfo.textContent = label.classList.contains('overflow')
      ? '⚠ Não coube tudo: tire itens, use tamanhos menores ou "meia linha".'
      : f < 1 ? `Para caber, o conteúdo foi reduzido a ${Math.round(f * 100)}%.` : 'Prévia com um card do quadro.';
  };

  const itemRow = (item, i) => {
    const sizeSel = h('select', { title: 'Tamanho', onchange: (e) => { item.size = e.target.value; redrawPreview(); } }, SIZE_LABELS.map(([v, l]) => h('option', { value: v, selected: item.size === v }, l)));
    const widthSel = h('select', { title: 'Largura', onchange: (e) => { item.width = e.target.value; redrawPreview(); } },
      [['full', 'Linha inteira'], ['half', 'Meia linha']].map(([v, l]) => h('option', { value: v, selected: item.width === v }, l)));
    const alignSel = h('select', { title: 'Alinhamento', onchange: (e) => { item.align = e.target.value; redrawPreview(); } },
      [['left', '⇤ Esq.'], ['center', '↔ Centro'], ['right', '⇥ Dir.']].map(([v, l]) => h('option', { value: v, selected: (item.align || 'left') === v }, l)));
    const check = (prop, label) => h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!item[prop], onchange: (e) => { item[prop] = e.target.checked; redrawPreview(); } }), ` ${label}`);
    const textual = !['qr', 'photo', 'barcode', 'divider'].includes(item.key);
    return h('li', { class: 'print-item', dataset: { index: i } },
      h('span', { class: 'drag-handle', title: 'Arraste para mudar a ordem' }, '⋮⋮'),
      h('div', { class: 'grow' },
        h('strong', {}, itemName(item.key)),
        item.key === 'text' ? h('input', { value: item.text || '', placeholder: 'Ex.: VOLPI JOIAS — Produção', oninput: (e) => { item.text = e.target.value; redrawPreview(); } }) : null,
        item.key === 'barcode' ? h('label', { class: 'row small' }, 'Conteúdo:', h('select', { onchange: (e) => { item.source = e.target.value; redrawPreview(); } },
          h('option', { value: 'card_id', selected: (item.source || 'card_id') === 'card_id' }, 'Número do card'),
          state.fields.map((f) => h('option', { value: `field:${f.id}`, selected: item.source === `field:${f.id}` }, f.name)))) : null,
        h('div', { class: 'row wrap print-item-opts' },
          item.key !== 'divider' ? sizeSel : null, widthSel, item.key !== 'divider' ? alignSel : null,
          textual ? check('bold', 'Negrito') : null,
          textual && (NAMED.has(item.key) || item.key.startsWith('field:')) ? check('show_name', 'Mostrar o nome') : null)),
      h('button', { class: 'icon-btn', title: 'Tirar da etiqueta', onclick: () => { current.items.splice(i, 1); draw(); } }, icon('x', 14)));
  };

  function draw() {
    const t = current;
    const list = h('ul', { class: 'print-items' }, t.items.map(itemRow));
    const used = new Set(t.items.map((i) => i.key));
    const addSel = h('select', {},
      h('option', { value: '' }, '+ Adicionar à etiqueta…'),
      h('optgroup', { label: 'Campos do card' }, state.fields.filter((f) => !used.has(`field:${f.id}`)).map((f) => h('option', { value: `field:${f.id}` }, f.name))),
      h('optgroup', { label: 'Outros' }, BASE_ITEMS.filter(([k]) => !used.has(k) || ['text', 'divider', 'barcode'].includes(k)).map(([k, l]) => h('option', { value: k }, l))));
    addSel.onchange = () => {
      const key = addSel.value;
      if (!key) return;
      current.items.push({ key, size: 'm', width: ['qr', 'photo'].includes(key) ? 'half' : 'full', show_name: NAMED.has(key) || key.startsWith('field:'), bold: false, align: 'left' });
      draw();
    };
    const num = (prop, attrs = {}) => h('input', { type: 'number', value: t[prop], style: { width: '90px', flex: '0 0 90px' }, ...attrs, oninput: (e) => { t[prop] = Number(e.target.value) || t[prop]; redrawPreview(); } });

    clear(panel,
      h('h3', {}, 'Etiquetas de impressão'),
      h('p', { class: 'muted' }, 'Monte o que sai na etiqueta para a produção. Para imprimir, use o botão "Selecionar" no quadro (vários cards ou uma coluna inteira) ou "Imprimir etiqueta" dentro do card.'),
      h('div', { class: 'row wrap' },
        h('label', { class: 'row' }, 'Modelo:', h('select', { onchange: (e) => { current = data.templates.find((x) => x.id === e.target.value); draw(); } },
          data.templates.map((x) => h('option', { value: x.id, selected: x.id === t.id }, `${x.name}${x.id === data.default_id ? ' (padrão)' : ''}`)))),
        editable ? [
          h('button', { class: 'btn small', onclick: () => { const c = JSON.parse(JSON.stringify(t)); c.id = Math.random().toString(36).slice(2, 10); c.name = `${t.name} (cópia)`; data.templates.push(c); current = c; draw(); } }, 'Duplicar'),
          h('button', { class: 'btn small', onclick: () => { const c = { id: Math.random().toString(36).slice(2, 10), name: 'Nova etiqueta', width_mm: 100, height_mm: 150, orientation: 'portrait', margin_mm: 4, items: [{ key: 'title', size: 'l', width: 'full', bold: true }] }; data.templates.push(c); current = c; draw(); } }, '+ Novo modelo'),
          t.id !== data.default_id ? h('button', { class: 'btn small', onclick: () => { data.default_id = t.id; draw(); } }, 'Usar como padrão') : null,
          data.templates.length > 1 ? h('button', { class: 'btn small subtle', onclick: async () => {
            if (!(await confirmDialog(`Excluir o modelo "${t.name}"?`))) return;
            data.templates = data.templates.filter((x) => x !== t);
            if (data.default_id === t.id) data.default_id = data.templates[0].id;
            current = data.templates[0];
            save();
          } }, 'Excluir') : null] : null),
      h('div', { class: 'print-editor' },
        h('div', { class: 'print-editor-form' },
          h('label', { class: 'form-row' }, 'Nome do modelo', h('input', { value: t.name, oninput: (e) => { t.name = e.target.value; } })),
          h('div', { class: 'form-row' }, 'Tamanho da etiqueta (mm)', h('div', {}, h('div', { class: 'row' }, num('width_mm', { min: 20, max: 300 }), '×', num('height_mm', { min: 20, max: 300 })),
            h('small', { class: 'muted' }, 'largura × altura, como a etiqueta sai da impressora (ZD220: 100 × 150)'))),
          h('div', { class: 'form-row' }, 'Orientação', h('div', { class: 'segmented' },
            [['portrait', 'Em pé'], ['landscape', 'Deitada']].map(([v, l]) => h('button', { class: t.orientation === v ? 'active' : '', onclick: () => { t.orientation = v; draw(); } }, l)))),
          h('label', { class: 'form-row' }, 'Margem (mm)', num('margin_mm', { min: 0, max: 20 })),
          h('h4', {}, 'O que sai na etiqueta (arraste para ordenar)'),
          list,
          addSel,
          editable ? h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: save }, 'Salvar modelos')) : h('p', { class: 'muted small' }, 'Seu perfil é somente leitura.')),
        h('div', {}, preview, previewInfo)),
      setupHelp());

    if (editable) {
      Sortable.create(list, {
        handle: '.drag-handle', animation: 150, forceFallback: true, fallbackOnBody: true,
        onEnd: (evt) => { const [moved] = current.items.splice(evt.oldIndex, 1); current.items.splice(evt.newIndex, 0, moved); draw(); },
      });
    }
    redrawPreview();
  }
  draw();
}
