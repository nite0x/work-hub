import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { PanelLeftClose, PanelLeftOpen, ListTodo, FolderGit2, MessagesSquare } from "lucide-react"
import { renderToStaticMarkup } from "react-dom/server"

const storageKey = "workhub:sidebar-collapsed:v1"
function preferredCollapse() {
  try { const saved = localStorage.getItem(storageKey); if (saved !== null) return saved === "true" } catch { /* Storage is optional. */ }
  return window.innerWidth > 760 && window.innerWidth < 1100
}
function SidebarToggle() {
  const [collapsed, setCollapsed] = useState(preferredCollapse)
  useEffect(() => { document.body.classList.toggle("sidebar-collapsed", collapsed) }, [collapsed])
  useEffect(() => {
    const resize = () => setCollapsed(preferredCollapse())
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])
  const label = collapsed ? "展开侧栏" : "收起侧栏"
  return <button type="button" className="sidebar-toggle" aria-label={label} title={label} aria-expanded={!collapsed} aria-controls="workspaceSidebar"
    onClick={() => setCollapsed(current => { const next = !current; try { localStorage.setItem(storageKey, String(next)) } catch { /* Keep the current window preference. */ } return next })}>
    {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
  </button>
}
export function mountWorkspaceSidebar() {
  const sidebar = document.querySelector<HTMLElement>(".sidebar")
  if (!sidebar) return
  sidebar.id = "workspaceSidebar"
  for (const [view, Icon] of [["requirements", ListTodo], ["projects", FolderGit2], ["sessions", MessagesSquare]] as const) {
    const icon = sidebar.querySelector(`[data-view="${view}"] .nav-icon`)
    if (icon) icon.innerHTML = renderToStaticMarkup(<Icon aria-hidden="true" size={18} />)
  }
  document.body.classList.toggle("sidebar-collapsed", preferredCollapse())
  const host = document.createElement("div"); host.className = "sidebar-controls"
  sidebar.querySelector(".brand")?.after(host)
  const root = createRoot(host); root.render(<SidebarToggle />)
  window.addEventListener("pagehide", () => root.unmount(), { once: true })
}
