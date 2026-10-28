import {useLayoutEffect, useRef, useState} from "react";
import type {ChatController} from "./controller";

// Track a message anchor so reflow and prepending history preserve the text in view.
export function useChatReading(controller: ChatController) {
  const container = useRef<HTMLDivElement>(null);
  const [hasNew, setHasNew] = useState(false);
  useLayoutEffect(() => {
    const viewport = container.current?.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!viewport) return;
    setHasNew(false);
    let frame = 0;
    let restoring = false;
    let initialized = false;
    const visible = () => !viewport.closest('[hidden]');
    const messages = () => [...viewport.querySelectorAll<HTMLElement>('[data-chat-message-id]')];
    const record = () => {
      if (restoring || !initialized || !visible()) return;
      const bottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 80;
      const top = viewport.getBoundingClientRect().top;
      const anchor = messages().find(node => node.getBoundingClientRect().bottom > top);
      controller.reading = {top: viewport.scrollTop, bottom, anchor: anchor?.dataset.chatMessageId || "", offset: anchor ? anchor.getBoundingClientRect().top - top : 0, latest: bottom ? controller.latestMessage() : controller.reading.latest};
      if (bottom) setHasNew(false);
    };
    const restore = () => {
      frame = 0;
      if (!visible()) return;
      const saved = controller.reading;
      const anchor = messages().find(node => node.dataset.chatMessageId === saved.anchor);
      restoring = true;
      viewport.scrollTop = saved.bottom ? viewport.scrollHeight : anchor ? viewport.scrollTop + anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - saved.offset : saved.top;
      restoring = false;
      if (!controller.opening) {
        initialized = true;
        if (saved.bottom) { saved.latest = controller.latestMessage(); setHasNew(false); }
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(restore); };
    const layout = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.phase === 'before') record();
      else if (detail?.visible) schedule();
    };
    const fingerprint = () => {
      const tail = messages().at(-1);
      return tail ? tail.dataset.chatMessageId + ':' + tail.textContent : "";
    };
    let last = fingerprint();
    const observer = new MutationObserver(() => {
      const next = fingerprint();
      if (!controller.opening && last && next !== last && !controller.reading.bottom) setHasNew(true);
      last = next;
      schedule();
    });
    observer.observe(viewport.querySelector('[data-slot="aui_message-group"]') || viewport, {childList: true, subtree: true, characterData: true});
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    resize?.observe(viewport);
    if (viewport.firstElementChild) resize?.observe(viewport.firstElementChild);
    viewport.addEventListener('scroll', record, {passive: true});
    window.addEventListener('workhub:chat-layout', layout);
    const unsubscribe = controller.subscribe(schedule);
    schedule();
    return () => {
      record(); cancelAnimationFrame(frame); observer.disconnect(); resize?.disconnect();
      viewport.removeEventListener('scroll', record); window.removeEventListener('workhub:chat-layout', layout);
      unsubscribe();
    };
  }, [controller]);
  const latest = () => {
    controller.reading.bottom = true;
    controller.reading.latest = controller.latestMessage();
    const viewport = container.current?.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    setHasNew(false);
  };
  return {container, hasNew, latest};
}
