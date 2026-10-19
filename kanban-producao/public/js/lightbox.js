// Visualizador de imagens em tela cheia (lightbox): setas, teclado, deslizar no celular e zoom
import { h, clear, icon } from './util.js';

/** images: [{ url, name }] */
export function openLightbox(images, start = 0) {
  if (!images.length) return;
  let index = Math.min(Math.max(start, 0), images.length - 1);
  const img = h('img', { class: 'lb-img', alt: '', draggable: false });
  const stage = h('div', { class: 'lb-stage' }, img);
  const caption = h('div', { class: 'lb-caption' });
  const download = h('a', { class: 'lb-btn', title: 'Baixar', download: '' }, icon('archive', 18));
  const openTab = h('a', { class: 'lb-btn', title: 'Abrir em nova aba', target: '_blank', rel: 'noopener' }, icon('link', 18));
  const strip = images.length > 1 ? h('div', { class: 'lb-strip' }) : null;
  const multiple = images.length > 1;

  const close = () => {
    overlay.remove();
    window.removeEventListener('keydown', onKey, true);
    document.body.style.overflow = '';
  };
  const show = (i) => {
    index = (i + images.length) % images.length;
    const cur = images[index];
    stage.classList.remove('zoomed');
    img.src = cur.url;
    img.alt = cur.name || '';
    clear(caption, h('strong', {}, cur.name || 'Imagem'), multiple ? h('span', {}, ` ${index + 1} / ${images.length}`) : null);
    download.href = cur.url;
    download.setAttribute('download', cur.name || 'imagem');
    openTab.href = cur.url;
    if (strip) [...strip.children].forEach((t, n) => t.classList.toggle('active', n === index));
  };
  if (strip) images.forEach((im, n) => strip.append(h('button', { class: 'lb-thumb', style: { backgroundImage: `url("${im.url}")` }, title: im.name, onclick: () => show(n) })));

  // Clique na imagem: zoom (mostra em tamanho real, arrastável pela rolagem)
  img.addEventListener('click', (e) => { e.stopPropagation(); stage.classList.toggle('zoomed'); });
  // Deslizar para os lados no celular/tablet troca de imagem
  let touchX = null;
  stage.addEventListener('touchstart', (e) => { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (touchX === null || stage.classList.contains('zoomed') || !multiple) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1));
    touchX = null;
  });
  // Esc fecha só o lightbox (não a janela do card que está atrás)
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); close(); }
    else if (multiple && e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
    else if (multiple && e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
  };
  window.addEventListener('keydown', onKey, true);

  const overlay = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Visualizar imagem', onclick: (e) => { if (e.target === overlay || e.target === stage) close(); } },
    h('div', { class: 'lb-top' }, caption, h('div', { class: 'lb-actions' }, download, openTab, h('button', { class: 'lb-btn', title: 'Fechar (Esc)', onclick: close }, icon('x', 20)))),
    stage,
    multiple ? h('button', { class: 'lb-nav prev', title: 'Anterior (←)', onclick: (e) => { e.stopPropagation(); show(index - 1); } }, icon('collapse', 26)) : null,
    multiple ? h('button', { class: 'lb-nav next', title: 'Próxima (→)', onclick: (e) => { e.stopPropagation(); show(index + 1); } }, icon('expand', 26)) : null,
    strip);
  document.body.append(overlay);
  document.body.style.overflow = 'hidden';
  show(index);
}
