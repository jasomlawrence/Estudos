// Estoque de pedras: diamantes lab e moissanites (uma por código) e pedras pequenas (por quantidade)
// + os campos do card que dão baixa no estoque ("Pedra do estoque" e "Pedras pequenas")
/* global ZXingWASM */
import { h, clear, icon, fmtDateTime, debounce } from './util.js';
import { get, post, patch, put, del, api, attempt, modal, confirmDialog, toast, popover } from './api.js';
import { state, canEdit, isAdmin } from './state.js';
import { openLightbox } from './lightbox.js';

const KIND_LABEL = { lab: 'Diamante lab', moissanite: 'Moissanite' };
const KIND_SHORT = { lab: 'lab', moissanite: 'moissanite' };
let SHAPES = ['Redonda', 'Oval', 'Gota', 'Navete', 'Baguete', 'Princesa', 'Esmeralda', 'Almofada', 'Coração', 'Radiante', 'Asscher', 'Trilliant', 'Outro'];
const MELEE_SHAPES = ['Redonda', 'Navete', 'Gota', 'Baguete', 'Oval', 'Princesa', 'Esmeralda', 'Coração', 'Trilliant', 'Outro'];

const fmtCt = (n) => (n ? `${String(n).replace('.', ',')} ct` : '');
const pref = (key, value) => {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* navegação privada */ }
  return null;
};
const segmented = (options, current, onPick, cls = '') => h('div', { class: `segmented ${cls}`, role: 'tablist' },
  options.map(([value, label]) => h('button', { type: 'button', class: value === current ? 'active' : '', onclick: () => onPick(value) }, label)));

/** append que ignora os itens vazios (o append do navegador escreveria "null") */
const add = (parent, ...kids) => parent.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

let openCardFn = null; // definido por quem abre o estoque (evita importar card.js aqui)

// =============================================================== Tela de Estoque
export function openStock(openCard, { section } = {}) {
  if (openCard) openCardFn = openCard;
  const m = modal({ title: 'Estoque de pedras', wide: true, className: 'stock-modal' });
  const view = { section: section || pref('stock:section') || 'lab', status: pref('stock:status') || 'available', shape: '', text: '', meleeKind: '' };
  let info = null;

  const head = h('div', { class: 'stock-head' });
  const content = h('div', { class: 'stock-content' });
  add(m.body, head, content);

  async function load() {
    info = await attempt(() => get('/stock'));
    if (!info) return;
    SHAPES = info.shapes;
    drawHead();
    drawContent();
  }

  const count = (kind, status) => info.counts.filter((c) => c.kind === kind && (!status || c.status === status)).reduce((n, c) => n + c.n, 0);

  function drawHead() {
    const tabs = segmented([
      ['lab', `Diamantes lab · ${count('lab', 'available')}`],
      ['moissanite', `Moissanites · ${count('moissanite', 'available')}`],
      ['melee', `Pedras pequenas · ${info.melee.length}`],
    ], view.section, (s) => { view.section = s; view.shape = ''; pref('stock:section', s); drawHead(); drawContent(); }, 'stock-tabs');
    const actions = h('div', { class: 'row' },
      canEdit() ? (view.section === 'melee'
        ? h('button', { class: 'btn primary', onclick: () => meleeForm(null, { onSaved: load }) }, icon('plus', 16), ' Novo item')
        : h('button', { class: 'btn primary', onclick: () => stoneForm(null, { kind: view.section, onSaved: load }) }, icon('camera', 16), ' Nova pedra')) : null,
      isAdmin() ? h('button', { class: 'icon-btn square', title: 'Leitura automática dos certificados', onclick: () => aiSettings(info.ai, load) }, icon('settings', 17)) : null);
    clear(head, tabs, actions);
  }

  function drawContent() {
    if (view.section === 'melee') return drawMelee();
    return drawStones();
  }

  // ---------- Diamantes lab e moissanites ----------
  function drawStones() {
    const kind = view.section;
    const shapes = new Map();
    for (const c of info.counts) if (c.kind === kind && (view.status === 'all' || c.status === view.status)) shapes.set(c.shape || 'Sem corte', (shapes.get(c.shape || 'Sem corte') || 0) + c.n);
    const ordered = [...shapes].sort((a, b) => SHAPES.indexOf(a[0]) - SHAPES.indexOf(b[0]));
    const search = h('label', { class: 'search stock-search' }, icon('search', 15),
      h('input', { type: 'search', placeholder: 'Código, pedido ou observação', value: view.text, oninput: debounce((e) => { view.text = e.target.value; drawList(); }, 250) }));
    const filters = h('div', { class: 'stock-filters' },
      search,
      segmented([['available', 'Disponíveis'], ['used', 'Usadas'], ['all', 'Todas']], view.status, (s) => { view.status = s; pref('stock:status', s); drawContent(); }, 'small'));
    const shapeChips = h('div', { class: 'stock-shapes' },
      h('button', { class: `chip toggle${view.shape ? '' : ' on'}`, onclick: () => { view.shape = ''; drawContent(); } }, `Todos · ${[...shapes.values()].reduce((a, b) => a + b, 0)}`),
      ordered.map(([shape, n]) => h('button', { class: `chip toggle${view.shape === shape ? ' on' : ''}`, onclick: () => { view.shape = shape; drawContent(); } }, `${shape} · ${n}`)));
    const list = h('div', { class: 'stone-list' }, h('p', { class: 'muted' }, 'Carregando…'));
    clear(content, boardFieldsHint(), filters, shapeChips, list);

    async function drawList() {
      const params = new URLSearchParams({ kind, status: view.status === 'all' ? '' : view.status, shape: view.shape === 'Sem corte' ? '' : view.shape, q: view.text });
      const rows = await attempt(() => get(`/stones?${params}`));
      if (!rows) return;
      if (!rows.length) {
        clear(list, h('div', { class: 'stock-empty' }, h('p', {}, view.text ? 'Nenhuma pedra encontrada.' : view.status === 'used' ? 'Nenhuma pedra usada ainda.' : 'Nenhuma pedra disponível aqui.'),
          canEdit() && !view.text && view.status !== 'used' ? h('p', { class: 'muted small' }, 'Toque em "Nova pedra" e fotografe o certificado (ou a etiqueta da moissanite): os campos são preenchidos sozinhos.') : null));
        return;
      }
      clear(list, rows.map((s) => stoneRow(s, () => stoneDetail(s.id, { onChange: load }))));
    }
    drawList();
  }

  // ---------- Pedras pequenas ----------
  function drawMelee() {
    const filters = h('div', { class: 'stock-filters' },
      h('label', { class: 'search stock-search' }, icon('search', 15),
        h('input', { type: 'search', placeholder: 'Formato ou tamanho', value: view.text, oninput: debounce((e) => { view.text = e.target.value; drawList(); }, 200) })),
      segmented([['', 'Todas'], ['lab', 'Lab'], ['moissanite', 'Moissanite']], view.meleeKind, (k) => { view.meleeKind = k; drawContent(); }, 'small'));
    const list = h('div', { class: 'melee-list' });
    clear(content, boardFieldsHint(), filters, list);
    function drawList() {
      const t = view.text.trim().toLowerCase().replace(',', '.');
      const rows = info.melee.filter((m) => (!view.meleeKind || m.kind === view.meleeKind)
        && (!t || `${m.shape} ${m.size}`.toLowerCase().replace(/,/g, '.').includes(t)));
      if (!rows.length) {
        clear(list, h('div', { class: 'stock-empty' }, h('p', {}, info.melee.length ? 'Nada encontrado.' : 'Nenhuma pedra pequena cadastrada.'),
          canEdit() && !info.melee.length ? h('p', { class: 'muted small' }, 'Cadastre cada combinação de formato e tamanho (ex.: Redonda 1,5 mm) com a quantidade que você tem. A baixa acontece pelo campo "Pedras pequenas" do card.') : null));
        return;
      }
      clear(list, rows.map((item) => meleeRow(item, load)));
    }
    drawList();
  }

  // Dica: o quadro precisa dos campos de pedra para dar baixa pelos cards
  function boardFieldsHint() {
    const type = view.section === 'melee' ? 'melee' : 'stone';
    if (!state.boardId || state.fields.some((f) => f.type === type)) return null;
    const name = type === 'melee' ? 'Pedras laterais' : 'Pedra central';
    return h('div', { class: 'callout stock-hint' },
      h('span', {}, `Para dar baixa pelos cards, crie no quadro um campo do tipo "${type === 'melee' ? 'Pedras pequenas' : 'Pedra do estoque'}".`),
      canEdit() ? h('button', { class: 'btn small primary', onclick: async () => {
        if (await attempt(() => post(`/boards/${state.boardId}/fields`, { name, type, show_on_card: true }), `Campo "${name}" criado no quadro`)) {
          const board = await get(`/boards/${state.boardId}?limit=10`).catch(() => null);
          if (board) state.fields = board.fields;
          drawContent();
        }
      } }, `Criar "${name}"`) : null);
  }

  load();
  return m;
}

function stoneRow(s, onclick) {
  const sub = [s.shape, fmtCt(s.carat), s.measurements ? `${s.measurements} mm` : ''].filter(Boolean).join(' · ');
  return h('button', { class: `stone-row${s.status === 'used' ? ' used' : ''}`, onclick },
    s.photo_url ? h('img', { class: 'stone-thumb', src: s.photo_url, alt: '', loading: 'lazy' }) : h('span', { class: 'stone-thumb empty' }, icon('gem', 18)),
    h('span', { class: 'stone-main' }, h('strong', {}, s.code), h('small', { class: 'muted' }, sub || '—')),
    h('span', { class: 'stone-grades' }, s.color ? h('span', { class: 'grade' }, s.color) : null, s.clarity ? h('span', { class: 'grade' }, s.clarity) : null),
    s.status === 'used'
      ? h('span', { class: 'chip late stone-status', title: s.used_order }, `Usada · ${s.used_order || 'sem pedido'}`)
      : h('span', { class: 'chip ok stone-status' }, 'Disponível'));
}

// =============================================================== Cadastro de pedra
/** Reduz a foto do celular (12 MP) para ~1800 px: envio rápido e leitura igual */
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const scale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.85));
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function stoneForm(stone, { kind = 'lab', onSaved } = {}) {
  const editing = !!stone;
  const m = modal({ title: editing ? `Editar ${stone.code}` : 'Nova pedra', className: 'stone-form-modal' });
  const v = { kind: stone?.kind || kind, photo: stone?.photo || null, photo_url: stone?.photo_url || null };
  const input = (key, attrs = {}) => h('input', { value: stone?.[key] ?? '', dataset: { key }, ...attrs });
  const f = {
    code: input('code', { placeholder: 'Ex.: LG797609310 ou GRA 28063453', autocapitalize: 'characters' }),
    shape: h('select', { dataset: { key: 'shape' } }, h('option', { value: '' }, '—'), SHAPES.map((s) => h('option', { value: s, selected: stone?.shape === s }, s))),
    carat: input('carat', { inputmode: 'decimal', placeholder: 'Ex.: 1,51', value: stone?.carat ? String(stone.carat).replace('.', ',') : '' }),
    measurements: input('measurements', { placeholder: 'Ex.: 9,75 × 6,33 × 3,71' }),
    color: input('color', { placeholder: 'Ex.: F', autocapitalize: 'characters' }),
    clarity: input('clarity', { placeholder: 'Ex.: VVS2', autocapitalize: 'characters' }),
    cut_grade: input('cut_grade'), polish: input('polish'), symmetry: input('symmetry'), fluorescence: input('fluorescence'),
    lab: input('lab', { placeholder: 'Ex.: IGI' }), method: input('method', { placeholder: 'CVD ou HPHT' }),
    report_date: input('report_date', { type: 'date' }),
    notes: h('textarea', { rows: 2, dataset: { key: 'notes' }, placeholder: 'Observações (opcional)' }, stone?.notes || ''),
  };
  const status = h('div', { class: 'stone-read-status', hidden: true });
  const dupWarn = h('p', { class: 'error small', hidden: true });
  const photoBox = h('div', { class: 'stone-photo-box' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => { const file = e.target.files[0]; e.target.value = ''; if (file) readPhoto(file); } });
  const labOnly = [];
  const row = (label, el, { lab = false } = {}) => { const r = h('label', { class: 'form-row' }, label, el); if (lab) labOnly.push(r); return r; };
  const more = h('details', { class: 'stone-more', open: editing && !!(stone.cut_grade || stone.polish) },
    h('summary', {}, 'Mais informações do certificado'),
    row('Lapidação (Cut)', f.cut_grade), row('Polimento', f.polish), row('Simetria', f.symmetry), row('Fluorescência', f.fluorescence),
    row('Laboratório', f.lab), row('Método', f.method), row('Data do certificado', f.report_date));
  labOnly.push(more);
  const kindSwitch = h('div', {});
  const setKind = (k) => {
    v.kind = k;
    clear(kindSwitch, segmented([['lab', 'Diamante lab'], ['moissanite', 'Moissanite']], k, setKind));
    for (const el of labOnly) el.hidden = k === 'moissanite';
  };

  function drawPhoto() {
    clear(photoBox, v.photo_url
      ? h('div', { class: 'stone-photo' },
        h('img', { src: v.photo_url, alt: 'Foto do certificado', onclick: () => openLightbox([{ url: v.photo_url, name: f.code.value || 'Certificado' }]) }),
        h('button', { type: 'button', class: 'btn small', onclick: () => fileInput.click() }, icon('camera', 14), ' Trocar foto'))
      : h('button', { type: 'button', class: 'stone-photo-empty', onclick: () => fileInput.click() },
        icon('camera', 28), h('strong', {}, 'Fotografar certificado ou etiqueta'),
        h('small', {}, 'Os campos são preenchidos sozinhos. Você confere antes de salvar.')));
  }

  const setStatus = (text, cls = '') => { status.hidden = !text; status.className = `stone-read-status ${cls}`; clear(status, text || ''); };

  async function readPhoto(file) {
    setStatus(h('span', {}, h('span', { class: 'spinner' }), ' Lendo a foto…'));
    const small = await compressImage(file);
    v.photo_url = URL.createObjectURL(small);
    drawPhoto();
    const info = await get('/stock').catch(() => ({ ai: {} }));
    const fd = new FormData();
    fd.append('photo', small, 'certificado.jpg');
    const [up, barcode] = await Promise.all([
      api('POST', `/stones/photo${info.ai?.configured ? '?read=1' : ''}`, fd).catch((err) => ({ error: err.message })),
      v.kind === 'moissanite' ? null : decodeImage(file),
    ]);
    if (!up.photo) { setStatus(up.error || 'Não deu para enviar a foto.', 'error'); return; }
    v.photo = up.photo;
    v.photo_url = up.photo_url;
    drawPhoto();
    const notes = [];
    if (up.fields) {
      const d = up.fields;
      if (!d.legible) notes.push('A foto não parece um certificado legível: confira os campos.');
      setKind(d.kind);
      for (const k of ['code', 'measurements', 'color', 'clarity', 'cut_grade', 'polish', 'symmetry', 'fluorescence', 'lab', 'method', 'report_date']) if (d[k]) f[k].value = d[k];
      if (d.carat) f.carat.value = String(d.carat).replace('.', ',');
      if (d.shape) f.shape.value = d.shape;
      if (d.problems) notes.push(d.problems);
    } else if (up.error) {
      notes.push(up.error);
    }
    // O código de barras do IGI traz o número do relatório sem o "LG": serve para conferir a leitura
    const bc = barcode && /^\d{5,}$/.test(barcode) ? barcode : null;
    if (bc && v.kind === 'lab') {
      const digits = f.code.value.replace(/\D/g, '');
      if (!f.code.value) { f.code.value = bc; notes.push('Código preenchido pelo código de barras. Confira o prefixo (ex.: LG).'); }
      else if (digits && digits !== bc) notes.push(`Atenção: o código de barras (${bc}) não bate com o código lido (${f.code.value}). Confira na foto.`);
    }
    checkDuplicate();
    if (!up.fields && !up.error && !info.ai?.configured) notes.push('Leitura automática desligada: preencha os campos olhando a foto.');
    setStatus(notes.length ? notes.join('\n') : up.fields ? '✓ Campos preenchidos pela foto. Confira antes de salvar.' : '', notes.length ? 'warn' : 'ok');
  }

  async function checkDuplicate() {
    const code = f.code.value.trim();
    if (!code) { dupWarn.hidden = true; return; }
    const found = (await get(`/stones/lookup?code=${encodeURIComponent(code)}`).catch(() => [])).filter((s) => s.id !== stone?.id);
    dupWarn.hidden = !found.length;
    if (found.length) clear(dupWarn, `Já cadastrada: ${found[0].code} (${found[0].status === 'used' ? `usada no pedido ${found[0].used_order}` : 'disponível'}).`);
  }
  f.code.addEventListener('change', checkDuplicate);

  async function save(again) {
    const body = {
      kind: v.kind, photo: v.photo,
      ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])),
    };
    const saved = await attempt(() => (editing ? patch(`/stones/${stone.id}`, body) : post('/stones', body)), editing ? 'Pedra atualizada' : `Pedra ${body.code.trim()} cadastrada`);
    if (!saved) return;
    m.close();
    onSaved?.(saved);
    if (again) stoneForm(null, { kind: v.kind, onSaved });
  }

  setKind(v.kind);
  drawPhoto();
  add(m.body, 
    photoBox, fileInput, status,
    kindSwitch,
    row('Código', f.code), dupWarn,
    row('Corte', f.shape),
    h('div', { class: 'stone-grid' }, row('Peso (ct)', f.carat), row('Dimensões (mm)', f.measurements), row('Cor', f.color), row('Claridade', f.clarity, { lab: true })),
    more,
    row('Observações', f.notes),
    h('div', { class: 'row end wrap' },
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      editing ? null : h('button', { class: 'btn', onclick: () => save(true) }, 'Salvar e cadastrar outra'),
      h('button', { class: 'btn primary', onclick: () => save(false) }, 'Salvar')));
  setKind(v.kind);
  if (!editing) setTimeout(() => f.code.focus({ preventScroll: true }), 50);
  return m;
}

// =============================================================== Detalhe da pedra
export async function stoneDetail(id, { onChange } = {}) {
  const s = await attempt(() => get(`/stones/${id}`));
  if (!s) return;
  const m = modal({ title: s.code, className: 'stone-detail-modal' });
  const refresh = () => { m.close(); onChange?.(); stoneDetail(id, { onChange }); };
  const facts = [
    ['Tipo', KIND_LABEL[s.kind]], ['Corte', s.shape], ['Peso', fmtCt(s.carat)], ['Dimensões', s.measurements ? `${s.measurements} mm` : ''],
    ['Cor', s.color], ['Claridade', s.clarity], ['Lapidação', s.cut_grade], ['Polimento', s.polish], ['Simetria', s.symmetry],
    ['Fluorescência', s.fluorescence], ['Laboratório', s.lab], ['Método', s.method], ['Data do certificado', s.report_date ? s.report_date.split('-').reverse().join('/') : ''],
  ].filter(([, val]) => val);
  const statusBox = s.status === 'used'
    ? h('div', { class: 'callout stone-used' },
      h('strong', {}, `Usada no pedido ${s.used_order || '(sem pedido)'}`),
      h('div', { class: 'small muted' }, `${fmtDateTime(s.used_at)}${s.used_by_name ? ` · ${s.used_by_name}` : ''}${s.card?.archived ? ' · card arquivado' : s.card ? ` · ${s.card.column_name}` : ''}`),
      h('div', { class: 'row wrap' },
        s.card && openCardFn ? h('button', { class: 'btn small', onclick: () => { m.close(); document.querySelector('.stock-modal')?.closest('.modal-overlay')?.remove(); openCardFn(s.card.id); } }, 'Abrir card') : null,
        canEdit() ? h('button', { class: 'btn small subtle', onclick: async () => {
          const msg = s.card ? `Devolver ${s.code} ao estoque?\n\nO campo de pedra do card "${s.card.title}" fica vazio.` : `Devolver ${s.code} ao estoque?`;
          if (await confirmDialog(msg, { ok: 'Devolver', danger: false }) && await attempt(() => post(`/stones/${s.id}/return`), 'Pedra devolvida ao estoque')) refresh();
        } }, 'Devolver ao estoque') : null))
    : h('div', { class: 'callout stone-available' },
      h('strong', {}, 'Disponível no estoque'),
      canEdit() ? h('div', { class: 'row wrap' }, h('button', { class: 'btn small subtle', onclick: () => manualUse(s, refresh) }, 'Dar baixa sem card…')) : null);
  const ACTIONS = { created: 'Cadastrada', edited: 'Editada', used: 'Baixa', returned: 'Devolvida ao estoque' };
  add(m.body, 
    s.photo_url ? h('img', { class: 'stone-detail-photo', src: s.photo_url, alt: 'Certificado', onclick: () => openLightbox([{ url: s.photo_url, name: s.code }]) }) : null,
    statusBox,
    h('dl', { class: 'stone-facts' }, facts.map(([k, val]) => [h('dt', {}, k), h('dd', {}, val)])),
    s.notes ? h('p', { class: 'stone-notes' }, s.notes) : null,
    h('h4', {}, 'Histórico'),
    h('ul', { class: 'stone-history' }, s.history.map((l) => h('li', {},
      h('strong', {}, ACTIONS[l.action] || l.action), l.order_ref ? ` · ${l.order_ref}` : '', l.detail ? h('span', { class: 'muted' }, ` (${l.detail})`) : null,
      h('div', { class: 'small muted' }, `${fmtDateTime(l.created_at)}${l.user_name ? ` · ${l.user_name}` : ''}`)))),
    h('div', { class: 'row end wrap' },
      isAdmin() && s.status !== 'used' ? h('button', { class: 'btn subtle', onclick: async () => {
        if (await confirmDialog(`Excluir ${s.code} do estoque? O histórico dela também é apagado.`) && await attempt(() => del(`/stones/${s.id}`), 'Pedra excluída')) { m.close(); onChange?.(); }
      } }, 'Excluir') : null,
      canEdit() ? h('button', { class: 'btn primary', onclick: () => { m.close(); stoneForm(s, { onSaved: () => { onChange?.(); stoneDetail(id, { onChange }); } }); } }, 'Editar') : null));
}

function manualUse(s, done) {
  const m = modal({ title: `Baixa de ${s.code}` });
  const order = h('input', { placeholder: 'Ex.: Pedido #1043 · Maria, ou "quebrou na cravação"' });
  add(m.body, 
    h('p', { class: 'muted' }, 'Use quando a pedra saiu do estoque sem passar por um card (pedido antigo, quebra, devolução ao fornecedor). Para pedidos no quadro, prefira escolher a pedra no campo do card.'),
    h('label', { class: 'form-row' }, 'Pedido ou motivo', order),
    h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (await attempt(() => post(`/stones/${s.id}/use`, { order: order.value }), 'Baixa registrada')) { m.close(); done(); }
      } }, 'Dar baixa')));
  setTimeout(() => order.focus(), 50);
}

// =============================================================== Pedras pequenas
function meleeRow(item, reload) {
  const low = item.min_qty > 0 && item.qty <= item.min_qty;
  return h('div', { class: `melee-row${low ? ' low' : ''}${item.qty ? '' : ' empty'}` },
    h('button', { class: 'melee-main', onclick: () => meleeDetail(item.id, reload) },
      h('strong', {}, `${item.shape} ${item.size}`),
      h('span', { class: `chip kind-${item.kind}` }, KIND_SHORT[item.kind]),
      low ? h('span', { class: 'chip late', title: `Mínimo: ${item.min_qty}` }, 'estoque baixo') : null),
    h('span', { class: 'melee-qty' }, h('strong', {}, String(item.qty)), h('small', {}, 'un.')),
    canEdit() ? h('div', { class: 'melee-actions' },
      h('button', { class: 'icon-btn square', title: 'Saída', onclick: (e) => meleeMove(e.currentTarget, item, -1, reload) }, icon('minus', 16)),
      h('button', { class: 'icon-btn square', title: 'Entrada (compra)', onclick: (e) => meleeMove(e.currentTarget, item, 1, reload) }, icon('plus', 16))) : null);
}

function meleeMove(anchor, item, sign, reload) {
  const qty = h('input', { type: 'number', min: 1, value: 1, inputmode: 'numeric' });
  const note = h('input', { placeholder: sign > 0 ? 'Fornecedor / nota (opcional)' : 'Pedido ou motivo (obrigatório)' });
  const pop = popover(anchor, h('div', { class: 'menu melee-move' },
    h('div', { class: 'menu-title' }, `${sign > 0 ? 'Entrada' : 'Saída'} · ${item.shape} ${item.size} (${KIND_SHORT[item.kind]})`),
    h('label', { class: 'form-row' }, 'Quantidade', qty),
    h('label', { class: 'form-row' }, sign > 0 ? 'Observação' : 'Motivo', note),
    h('p', { class: 'small muted' }, sign < 0 ? 'Saídas para pedidos do quadro acontecem sozinhas pelo campo do card.' : `Hoje: ${item.qty} un.`),
    h('button', { class: 'btn primary small', onclick: async () => {
      const n = Math.round(Number(qty.value) || 0);
      if (n <= 0) return toast('Informe a quantidade.', 'error');
      if (await attempt(() => post(`/melee/${item.id}/moves`, { delta: sign * n, note: note.value }), sign > 0 ? `+${n} un. lançadas` : `−${n} un. lançadas`)) { pop.close(); reload(); }
      return null;
    } }, sign > 0 ? 'Lançar entrada' : 'Lançar saída')), { width: 300 });
  setTimeout(() => qty.select(), 30);
}

function meleeForm(item, { onSaved } = {}) {
  const editing = !!item;
  const m = modal({ title: editing ? `${item.shape} ${item.size}` : 'Novo item de pedras pequenas' });
  let kind = item?.kind || 'lab';
  const kindBox = h('div', {});
  const setKind = (k) => { kind = k; clear(kindBox, segmented([['lab', 'Diamante lab'], ['moissanite', 'Moissanite']], k, setKind)); };
  setKind(kind);
  const shape = h('select', {}, MELEE_SHAPES.map((s) => h('option', { value: s, selected: item?.shape === s }, s)));
  const size = h('input', { value: item?.size?.replace(/ mm$/, '') || '', placeholder: 'Ex.: 1,5 ou 5x3', inputmode: 'decimal' });
  const qty = h('input', { type: 'number', min: 0, value: 0, inputmode: 'numeric' });
  const min = h('input', { type: 'number', min: 0, value: item?.min_qty ?? 0, inputmode: 'numeric' });
  const notes = h('input', { value: item?.notes || '', placeholder: 'Opcional' });
  add(m.body, 
    kindBox,
    h('label', { class: 'form-row' }, 'Formato', shape),
    h('label', { class: 'form-row' }, 'Tamanho (mm)', size),
    editing ? null : h('label', { class: 'form-row' }, 'Quantidade que você tem hoje', qty),
    h('label', { class: 'form-row' }, 'Avisar quando ficar com', h('div', { class: 'row' }, min, h('span', { class: 'muted small' }, 'un. ou menos (0 = sem aviso)'))),
    h('label', { class: 'form-row' }, 'Observações', notes),
    h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: async () => {
        const body = { kind, shape: shape.value, size: size.value, min_qty: min.value, notes: notes.value, ...(editing ? {} : { qty: qty.value }) };
        const r = await attempt(() => (editing ? patch(`/melee/${item.id}`, body) : post('/melee', body)), editing ? 'Item atualizado' : 'Item cadastrado');
        if (r) { m.close(); onSaved?.(r); }
      } }, 'Salvar')));
  if (!editing) setTimeout(() => size.focus(), 50);
}

async function meleeDetail(id, reload) {
  const item = await attempt(() => get(`/melee/${id}`));
  if (!item) return;
  const m = modal({ title: item.label, className: 'melee-detail-modal' });
  add(m.body, 
    h('div', { class: 'melee-summary' }, h('strong', {}, `${item.qty} un.`), h('span', { class: 'muted' }, item.min_qty ? ` · aviso com ${item.min_qty} un. ou menos` : ' · sem aviso de estoque baixo')),
    item.notes ? h('p', { class: 'muted' }, item.notes) : null,
    h('h4', {}, 'Entradas e saídas'),
    item.history.length ? h('ul', { class: 'stone-history' }, item.history.map((mv) => h('li', {},
      h('strong', { class: mv.delta > 0 ? 'ok-text' : '' }, `${mv.delta > 0 ? '+' : '−'}${Math.abs(mv.delta)} un.`), ` → ${mv.qty_after} · `,
      mv.card && openCardFn ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); document.querySelectorAll('.modal-overlay').forEach((o) => o.remove()); openCardFn(mv.card.id); } }, mv.order_ref || mv.card.title) : mv.order_ref || '',
      mv.note && mv.note !== mv.order_ref ? h('span', { class: 'muted' }, ` (${mv.note})`) : null,
      h('div', { class: 'small muted' }, `${fmtDateTime(mv.created_at)}${mv.user_name ? ` · ${mv.user_name}` : ''}`)))) : h('p', { class: 'muted' }, 'Nenhuma movimentação ainda.'),
    h('div', { class: 'row end wrap' },
      isAdmin() ? h('button', { class: 'btn subtle', onclick: async () => {
        if (await confirmDialog(`Excluir ${item.label} do estoque?`) && await attempt(() => del(`/melee/${item.id}`), 'Item excluído')) { m.close(); reload(); }
      } }, 'Excluir') : null,
      canEdit() ? h('button', { class: 'btn primary', onclick: () => { m.close(); meleeForm(item, { onSaved: reload }); } }, 'Editar') : null));
}

// =============================================================== Leitura automática (chave da API)
function aiSettings(ai, reload) {
  const m = modal({ title: 'Leitura automática dos certificados' });
  const key = h('input', { type: 'password', value: ai.key || '', placeholder: 'sk-ant-…', autocomplete: 'off' });
  add(m.body, 
    h('p', {}, 'Ao fotografar um certificado (IGI, GIA…) ou a etiqueta de uma moissanite, o sistema lê os campos com a inteligência artificial da Anthropic (Claude). Custa em torno de US$ 0,03 por foto, cobrados na sua conta da Anthropic.'),
    h('ol', { class: 'small' },
      h('li', {}, 'Crie uma conta em console.anthropic.com e adicione crédito (Billing).'),
      h('li', {}, 'Em "API Keys", crie uma chave e cole abaixo.')),
    ai.from_env ? h('p', { class: 'callout small' }, 'Já existe uma chave configurada no servidor (variável ANTHROPIC_API_KEY). Uma chave colada aqui tem prioridade.') : null,
    h('label', { class: 'form-row' }, 'Chave da API', key),
    h('p', { class: 'small muted' }, `Status: ${ai.configured ? '✓ ligada' : 'desligada (o cadastro é feito à mão)'} · modelo ${ai.model}`),
    h('div', { class: 'row end' },
      ai.key ? h('button', { class: 'btn subtle', onclick: async () => { if (await attempt(() => put('/stock/ai', { api_key: '' }), 'Chave removida')) { m.close(); reload(); } } }, 'Remover chave') : null,
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: async () => { if (await attempt(() => put('/stock/ai', { api_key: key.value }), 'Chave salva')) { m.close(); reload(); } } }, 'Salvar')));
}

// =============================================================== Código de barras (câmera)
// zxing-wasm: o mesmo leitor (ZXing C++) que leu os certificados do IGI nos testes; só carrega quando é usado
let zxingLoading = null;
function loadZxing() {
  zxingLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/zxing/iife/reader/index.js';
    s.onload = () => {
      ZXingWASM.prepareZXingModule({ overrides: { locateFile: (file, prefix) => (file.endsWith('.wasm') ? `/vendor/zxing/reader/${file}` : prefix + file) }, fireImmediately: true })
        .then(resolve, reject);
    };
    s.onerror = () => reject(new Error('Não deu para carregar o leitor de código de barras.'));
    document.head.append(s);
  }).catch((err) => { zxingLoading = null; throw err; });
  return zxingLoading;
}

async function readCode(image, tryHarder = true) {
  const results = await ZXingWASM.readBarcodes(image, { tryHarder, maxNumberOfSymbols: 1 });
  return results.find((r) => r.isValid && r.text)?.text || null;
}

/** Código de barras de uma foto (null se não achar) */
async function decodeImage(file) {
  try {
    await loadZxing();
    return await Promise.race([readCode(file), new Promise((r) => setTimeout(() => r(null), 10000))]);
  } catch { return null; }
}

/** Abre a câmera e devolve o código lido (ou null se cancelar) */
export async function scanBarcode(title = 'Aponte para o código de barras') {
  try { await loadZxing(); } catch (err) { toast(err.message, 'error'); return null; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (err) {
    toast(/NotAllowed|Permission/i.test(`${err.name} ${err.message}`) ? 'Permita o uso da câmera para ler o código.' : `Câmera indisponível: ${err.message}`, 'error');
    return null;
  }
  return new Promise((resolve) => {
    let done = false;
    const video = h('video', { class: 'scan-video', playsInline: true, muted: true, autoplay: true });
    video.srcObject = stream;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const finish = (text) => {
      if (done) return;
      done = true;
      stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
      resolve(text);
    };
    const overlay = h('div', { class: 'scan-overlay' },
      h('div', { class: 'scan-top' }, h('strong', {}, title), h('button', { class: 'lb-btn', 'aria-label': 'Fechar', onclick: () => finish(null) }, icon('x', 20))),
      h('div', { class: 'scan-stage' }, video, h('div', { class: 'scan-frame' })),
      h('p', { class: 'scan-tip' }, 'Segure o certificado parado, a um palmo da câmera. Também dá para digitar o código.'));
    document.body.append(overlay);
    const tick = async () => {
      if (done) return;
      if (video.videoWidth) {
        // Lê só a faixa do meio (onde fica a moldura): mais rápido e sem pegar outros códigos da folha
        const w = video.videoWidth;
        const hgt = Math.round(video.videoHeight * 0.45);
        canvas.width = w;
        canvas.height = hgt;
        ctx.drawImage(video, 0, Math.round((video.videoHeight - hgt) / 2), w, hgt, 0, 0, w, hgt);
        const text = await readCode(ctx.getImageData(0, 0, w, hgt), false).catch(() => null);
        if (text) { navigator.vibrate?.(60); finish(text); return; }
      }
      setTimeout(tick, 200);
    };
    video.play().catch(() => {});
    tick();
  });
}

// =============================================================== Campos do card
/** Campo "Pedra do estoque": digite, bipe (leitor USB) ou leia com a câmera o código da pedra */
export function stoneFieldInput(def, value, card, editable, onSave) {
  const s = card.stock?.[def.id];
  if (value && s) {
    return h('div', { class: 'stock-pick' },
      h('div', { class: 'stock-pick-main' },
        h('strong', {}, s.code), h('span', { class: `chip kind-${s.kind}` }, KIND_SHORT[s.kind]),
        h('div', { class: 'small muted' }, [s.shape, fmtCt(s.carat), s.color, s.clarity, s.measurements ? `${s.measurements} mm` : ''].filter(Boolean).join(' · '))),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small subtle', onclick: () => stoneDetail(s.id) }, 'Ver'),
        editable ? h('button', { type: 'button', class: 'btn small subtle', onclick: async () => {
          if (await confirmDialog(`Tirar ${s.code} deste card?\n\nA pedra volta ao estoque como disponível.`, { ok: 'Tirar e devolver', danger: false })) onSave(null);
        } }, 'Tirar') : null));
  }
  if (!editable) return h('span', { class: 'muted' }, '—');
  const results = h('div', { class: 'stock-suggest', hidden: true });
  const input = h('input', { type: 'text', placeholder: 'Digite ou bipe o código', autocomplete: 'off', autocapitalize: 'characters', dataset: { key: `stone-${def.id}` } });
  const choose = (stone) => {
    if (stone.status === 'used') { toast(`${stone.code} já foi usada no pedido ${stone.used_order || '(sem pedido)'}.`, 'error'); return; }
    delete input.dataset.dirty;
    onSave(stone.id);
  };
  const pickByCode = async (code) => {
    const found = await attempt(() => get(`/stones/lookup?code=${encodeURIComponent(code)}`));
    if (!found) return;
    if (!found.length) { toast(`Nenhuma pedra com o código ${code} no estoque.`, 'error'); return; }
    const free = found.find((x) => x.status === 'available');
    choose(free || found[0]);
  };
  const suggest = debounce(async () => {
    const t = input.value.trim();
    if (t.length < 2) { results.hidden = true; return; }
    const rows = await get(`/stones?status=available&limit=8&q=${encodeURIComponent(t)}`).catch(() => []);
    clear(results, rows.length ? rows.map((x) => h('button', { type: 'button', class: 'stock-suggest-item', onmousedown: (e) => e.preventDefault(), onclick: () => choose(x) },
      h('strong', {}, x.code), h('span', { class: 'muted small' }, ` ${[x.shape, fmtCt(x.carat), x.color, x.clarity].filter(Boolean).join(' · ')}`)))
      : h('div', { class: 'muted small stock-suggest-empty' }, 'Nenhuma pedra disponível com esse código.'));
    results.hidden = false;
  }, 250);
  input.addEventListener('input', suggest);
  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    e.preventDefault(); // leitor de código de barras USB digita o código e aperta Enter
    pickByCode(input.value.trim());
  });
  return h('div', { class: 'stock-field' },
    h('div', { class: 'row' }, input,
      h('button', { type: 'button', class: 'icon-btn square', title: 'Ler o código de barras com a câmera', onclick: async () => {
        const code = await scanBarcode('Leia o código de barras do certificado');
        if (code) pickByCode(code);
      } }, icon('scan', 18)),
      h('button', { type: 'button', class: 'icon-btn square', title: 'Escolher no estoque', onclick: (e) => pickFromStock(e.currentTarget, choose) }, icon('box', 18))),
    results);
}

/** Lista de pedras disponíveis para escolher (sem saber o código) */
async function pickFromStock(anchor, choose) {
  const rows = await attempt(() => get('/stones?status=available&limit=200'));
  if (!rows) return;
  const filter = h('input', { type: 'search', placeholder: 'Filtrar (corte, cor, peso…)' });
  const list = h('div', { class: 'stock-pick-list' });
  const draw = () => {
    const t = filter.value.trim().toLowerCase().replace(',', '.');
    const shown = rows.filter((x) => !t || `${x.code} ${x.shape} ${x.carat} ${x.color} ${x.clarity} ${KIND_LABEL[x.kind]}`.toLowerCase().includes(t));
    clear(list, shown.length ? shown.map((x) => h('button', { class: 'menu-item', onclick: () => { pop.close(); choose(x); } },
      h('strong', {}, x.code), h('span', { class: 'muted small' }, ` ${[x.shape, fmtCt(x.carat), x.color, x.clarity].filter(Boolean).join(' · ')}${x.kind === 'moissanite' ? ' · moissanite' : ''}`)))
      : h('p', { class: 'muted small' }, rows.length ? 'Nada encontrado.' : 'Nenhuma pedra disponível no estoque.'));
  };
  filter.addEventListener('input', draw);
  draw();
  const pop = popover(anchor, h('div', { class: 'menu' }, h('div', { class: 'menu-title' }, 'Pedras disponíveis'), filter, list), { width: 320 });
  setTimeout(() => filter.focus(), 30);
}

/** Campo "Pedras pequenas": lista de formato/tamanho com quantidade (baixa só da diferença) */
export function meleeFieldInput(def, value, card, editable, onSave) {
  const lines = (card.stock?.[def.id] || []).map((x) => ({ item: x.item, qty: x.qty, info: x.info }));
  const commit = () => onSave(lines.map(({ item, qty }) => ({ item, qty })));
  const label = (info) => (info ? `${info.shape} ${info.size}` : '(item excluído)');
  const box = h('div', { class: 'melee-field' },
    lines.length ? h('ul', { class: 'melee-lines' }, lines.map((l) => h('li', {},
      h('span', { class: 'melee-line-qty' }, `${l.qty}×`),
      h('span', { class: 'melee-line-name' }, label(l.info), l.info ? h('span', { class: `chip kind-${l.info.kind}` }, KIND_SHORT[l.info.kind]) : null,
        l.info ? h('small', { class: 'muted' }, ` estoque: ${l.info.qty}`) : null),
      editable ? h('span', { class: 'melee-line-actions' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Uma a menos', onclick: () => { if (l.qty > 1) { l.qty--; commit(); } } }, icon('minus', 14)),
        h('button', { type: 'button', class: 'icon-btn', title: 'Uma a mais', onclick: () => { l.qty++; commit(); } }, icon('plus', 14)),
        h('button', { type: 'button', class: 'icon-btn', title: 'Tirar do card (volta ao estoque)', onclick: () => { lines.splice(lines.indexOf(l), 1); commit(); } }, icon('x', 14))) : null)))
      : h('span', { class: 'muted small' }, editable ? 'Nenhuma pedra pequena neste card.' : '—'),
    editable ? h('button', { type: 'button', class: 'btn small', onclick: (e) => addMelee(e.currentTarget, lines, commit) }, icon('plus', 14), ' Adicionar pedras') : null);
  return box;
}

async function addMelee(anchor, lines, commit) {
  const items = await attempt(() => get('/melee'));
  if (!items) return;
  if (!items.length) { toast('Nenhuma pedra pequena cadastrada. Cadastre no Estoque → Pedras pequenas.', 'warn'); return; }
  const select = h('select', {}, ['lab', 'moissanite'].map((k) => {
    const list = items.filter((i) => i.kind === k);
    return list.length ? h('optgroup', { label: KIND_LABEL[k] }, list.map((i) => h('option', { value: i.id, disabled: i.qty <= 0 }, `${i.shape} ${i.size} · ${i.qty} em estoque`))) : null;
  }));
  const firstFree = items.find((i) => i.qty > 0);
  if (firstFree) select.value = firstFree.id;
  const qty = h('input', { type: 'number', min: 1, value: 1, inputmode: 'numeric' });
  const pop = popover(anchor, h('div', { class: 'menu melee-move' },
    h('div', { class: 'menu-title' }, 'Adicionar pedras pequenas'),
    h('label', { class: 'form-row' }, 'Pedra', select),
    h('label', { class: 'form-row' }, 'Quantidade', qty),
    h('button', { class: 'btn primary small', onclick: () => {
      const id = Number(select.value);
      const n = Math.round(Number(qty.value) || 0);
      if (!id || n <= 0) return;
      const line = lines.find((l) => l.item === id);
      if (line) line.qty += n; else lines.push({ item: id, qty: n });
      pop.close();
      commit();
    } }, 'Adicionar e dar baixa')), { width: 320 });
}
