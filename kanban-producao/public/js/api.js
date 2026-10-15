// Comunicação com o servidor + avisos rápidos (toast) + janelas modais
import { h } from './util.js';

export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${url}`, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/auth')) {
    location.reload();
    throw new Error('Sessão expirada.');
  }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const patch = (url, body) => api('PATCH', url, body);
export const put = (url, body) => api('PUT', url, body);
export const del = (url) => api('DELETE', url);

export function toast(message, type = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${type}` }, message);
  box.append(t);
  setTimeout(() => t.classList.add('hide'), 3500);
  setTimeout(() => t.remove(), 4000);
}

/** Executa uma ação mostrando o erro ao usuário em vez de falhar em silêncio */
export async function attempt(fn, success) {
  try {
    const r = await fn();
    if (success) toast(success, 'ok');
    return r;
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  }
}

/** Abre uma janela modal. Retorna { el, body, close } */
export function modal({ title, wide = false, onClose, className = '' } = {}) {
  const body = h('div', { class: 'modal-body' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape' && document.querySelector('.modal-overlay:last-of-type') === overlay) close(); };
  const box = h('div', { class: `modal ${wide ? 'wide' : ''} ${className}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h2', {}, title || ''), h('button', { class: 'icon-btn', 'aria-label': 'Fechar', onclick: close }, '✕')),
    body);
  const overlay = h('div', { class: 'modal-overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  return { el: box, body, close, overlay };
}

export function confirmDialog(message, { ok = 'Confirmar', danger = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({ title: 'Confirmação', onClose: () => { if (!done) resolve(false); } });
    m.body.append(
      h('p', {}, message),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { done = true; resolve(true); m.close(); } }, ok)),
    );
  });
}

/** Menu suspenso posicionado junto a um elemento */
export function popover(anchor, content, { width = 280 } = {}) {
  document.querySelectorAll('.popover').forEach((p) => p.remove());
  const pop = h('div', { class: 'popover', style: { width: `${width}px` } }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - width - 8);
  pop.style.left = `${Math.max(8, left)}px`;
  const top = r.bottom + 6;
  pop.style.top = `${top}px`;
  const maxH = window.innerHeight - top - 12;
  if (maxH < 200) { pop.style.top = ''; pop.style.bottom = `${window.innerHeight - r.top + 6}px`; }
  else pop.style.maxHeight = `${maxH}px`;
  const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); };
  const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  pop.close = close;
  return pop;
}
