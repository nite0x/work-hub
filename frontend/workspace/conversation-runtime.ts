export function setupConversationResize(conversationHost: HTMLElement, window: Window) {
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => conversationHost.querySelector<T>(selector)!
  const handle = $('#sessionBrowserResize');
  const list = $('#sessionBrowserListPane');
  const body = conversationHost.querySelector<HTMLElement>('.session-browser-body')!;
  const storageKey = 'workhub:conversation-list-width:v1';
  let drag: {id: number; x: number; width: number; moved: boolean} | null = null;
  try {
    const saved = Number(window.localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= 220 && saved <= 520) conversationHost.style.setProperty('--conversation-list-width', saved + 'px');
  } catch { /* Storage is optional. */ }
  function limits() {
    const width = body.getBoundingClientRect().width;
    return width > 620 ? { min: 220, max: Math.min(520, width - 328) } : null;
  }
  function sync() {
    const bounds = limits();
    if (!bounds) return;
    handle.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
    handle.setAttribute('aria-valuenow', String(Math.round(list.getBoundingClientRect().width)));
  }
  function resize(width: number) {
    const bounds = limits();
    if (!bounds) return;
    const next = Math.round(Math.max(bounds.min, Math.min(bounds.max, width)));
    conversationHost.style.setProperty('--conversation-list-width', next + 'px');
    handle.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
    handle.setAttribute('aria-valuenow', String(next));
  }
  function remember() {
    try { window.localStorage.setItem(storageKey, String(parseFloat(conversationHost.style.getPropertyValue('--conversation-list-width')))); } catch { /* Keep the in-memory size. */ }
  }
  function finish(event?: {pointerId?: number}) {
    if (!drag || event?.pointerId != null && event.pointerId !== drag.id) return;
    const current = drag;
    drag = null;
    delete conversationHost.dataset.resizing;
    if (handle.hasPointerCapture?.(current.id)) handle.releasePointerCapture(current.id);
    if (current.moved) remember();
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag || !limits()) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, width: list.getBoundingClientRect().width, moved: false };
    conversationHost.dataset.resizing = '';
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!limits()) { finish(event); return; }
    drag.moved = true;
    resize(drag.width + event.clientX - drag.x);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, event => finish(event as PointerEvent));
  handle.addEventListener('keydown', event => {
    const bounds = limits();
    if (!bounds || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const width = list.getBoundingClientRect().width;
    resize(event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10));
    remember();
  });
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => { if (drag && !limits()) finish(); sync(); });
    observer.observe(body);
    observer.observe(list);
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }
  window.addEventListener('resize', sync);
  window.addEventListener('blur', () => finish());
  window.addEventListener('pagehide', () => finish());
}

export const conversationPathKey = (path: string) => {
 let value = String(path || '').replace(/\\/g, '/');
 if (value !== '/') value = value.replace(/\/+$/, '');
 if (/^[a-z]:/i.test(value) || value.startsWith('//')) value = value.toLowerCase();
 return value;
};
export const conversationEnvironmentKey = (environment: string,id: string) => environment === 'local' ? id : JSON.stringify([environment,id]);
