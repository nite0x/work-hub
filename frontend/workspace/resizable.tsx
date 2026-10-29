import { useLayoutEffect, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { flushSync } from "react-dom"
import { Group, Panel, Separator } from "react-resizable-panels"

// The panel library owns sizing and keyboard navigation. Existing controllers
// still own the content nodes inside each stable panel boundary.
function NativePanel({ node, className = "" }: { node: HTMLElement; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { ref.current?.append(node); return () => node.remove() }, [node])
  return <div ref={ref} className={`ui-panel-node ${className}`} />
}
type PanelPair = { container: HTMLElement; list: HTMLElement; detail: HTMLElement; legacy: HTMLElement; conversation: boolean; width: number }
function Panels({ container, list, detail, legacy, conversation, width }: PanelPair) {
  const key = conversation ? "workhub:conversation-list-width:v1" : "workhub:project-list-width:v1"
  let saved = conversation ? 280 : 248
  try { const value = Number(localStorage.getItem(key)); if (Number.isFinite(value) && value >= 200) saved = value } catch { /* Persistence is optional. */ }
  const narrow = width < (conversation ? 620 : 680)
  return <>
    {narrow ? <div className="ui-narrow-panels"><NativePanel node={list} className="ui-narrow-list" /><NativePanel node={detail} className="ui-narrow-detail" /></div> : <Group orientation="horizontal" className="ui-panel-group"
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction) return
        // The callback precedes the browser's layout pass; use the library's
        // completed percentages rather than reading the previous DOM width.
        const available = container.getBoundingClientRect().width - 8
        const percentage = layout[conversation ? "conversation-list-frame" : "project-list-frame"]
        if (available > 0 && Number.isFinite(percentage)) { try { localStorage.setItem(key, String(Math.round(available * percentage / 100))) } catch { /* Persistence is optional. */ } }
      }}>
      <Panel id={conversation ? "conversation-list-frame" : "project-list-frame"} defaultSize={saved} minSize={conversation ? 220 : 200} maxSize={conversation ? 520 : 640} groupResizeBehavior="preserve-pixel-size" className="ui-panel"
        onResize={size => { if (!size.inPixels) return; container.style.setProperty(conversation ? "--conversation-list-width" : "--project-list-width", `${Math.round(size.inPixels)}px`) }}>
        <NativePanel node={list} />
      </Panel>
      <Separator className="ui-resizable-separator" aria-label={conversation ? "调整对话列表宽度" : "调整项目列表宽度"} />
      <Panel id={conversation ? "conversation-detail-frame" : "project-detail-frame"} minSize={conversation ? 328 : 340} className="ui-panel"><NativePanel node={detail} /></Panel>
    </Group>}
    <NativePanel node={legacy} className="ui-legacy-resizer" />
  </>
}

export function setupWorkspacePanels() {
  // Without layout measurements (e.g. a DOM-only host), retain native resizing.
  if (typeof ResizeObserver === "undefined") return
  const roots = new Map<HTMLElement, { root: Root; observer: ResizeObserver; width: number; pair: PanelPair }>()
  let queued = false, disposed = false
  const scan = () => {
    queued = false
    if (disposed) return
    for (const [container, entry] of roots) if (!container.isConnected) { entry.observer.disconnect(); entry.root.unmount(); roots.delete(container) }
    for (const container of document.querySelectorAll<HTMLElement>(".project-workspace, .session-browser-body")) {
      if (roots.has(container)) continue
      const conversation = container.classList.contains("session-browser-body")
      const list = container.querySelector<HTMLElement>(conversation ? ".session-browser-list" : ".project-browser")
      const detail = container.querySelector<HTMLElement>(conversation ? ".session-browser-detail" : ".project-detail")
      const legacy = container.querySelector<HTMLElement>(conversation ? "#sessionBrowserResize" : "[data-project-resize]")
      if (!list || !detail || !legacy) continue
      const host = document.createElement("div"); host.className = "ui-panels-host"
      const root = createRoot(host), width = container.getBoundingClientRect().width
      const pair = { container, list, detail, legacy, conversation, width }
      container.dataset.reactPanels = width < (conversation ? 620 : 680) ? "narrow" : "wide"
      const observer = new ResizeObserver(() => {
        const entry = roots.get(container), next = Math.round(container.getBoundingClientRect().width)
        if (!entry || next === entry.width || !next) return
        const mode = next < (conversation ? 620 : 680) ? "narrow" : "wide"
        const switching = container.dataset.reactPanels !== mode
        const focused = switching && container.contains(document.activeElement) ? document.activeElement as HTMLElement : null
        entry.width = next; entry.pair.width = next; container.dataset.reactPanels = mode
        if (switching) { flushSync(() => entry.root.render(<Panels {...entry.pair} />)); if (focused?.isConnected) focused.focus({ preventScroll: true }) }
        else entry.root.render(<Panels {...entry.pair} />)
      })
      roots.set(container, { root, observer, width, pair })
      container.replaceChildren(host)
      flushSync(() => root.render(<Panels {...pair} />))
      observer.observe(container)
    }
  }
  const changes = new MutationObserver(() => { if (!queued && !disposed) { queued = true; queueMicrotask(scan) } })
  changes.observe(document.body, { childList: true, subtree: true })
  scan()
  window.addEventListener("pagehide", () => { disposed = true; changes.disconnect(); for (const entry of roots.values()) { entry.observer.disconnect(); entry.root.unmount() } roots.clear() }, { once: true })
}
