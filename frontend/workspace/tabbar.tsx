import { memo, useLayoutEffect, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { flushSync } from "react-dom"
import { CopyPlus, FolderGit2, ListTodo, MessageSquare, Plus, Settings2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface TabItem { id: string; title: string; context?: string; environment: string; kind: string }
interface TabbarProps {
  tabs: TabItem[]; selected: string; ready: boolean
  select: (id: string) => void; close: (id: string) => void
  create: () => void; duplicate: () => void
}
const icons = { requirements: ListTodo, projects: FolderGit2, sessions: MessageSquare, settings: Settings2 }

const WorkspaceTabItem = memo(function WorkspaceTabItem({ id, title, context, environment, kind, active, select, close }: TabItem & {
  active: boolean; select: TabbarProps["select"]; close: TabbarProps["close"]
}) {
  const Icon = icons[kind as keyof typeof icons] || ListTodo
  return <div className="workspace-tab-item" data-active={active}
    onAuxClick={event => { if (event.button === 1) {event.preventDefault(); close(id)} }}>
    <TabsTrigger id={`tab-${id}`} value={id} variant="plain" aria-controls={`page-${id}`} className="workspace-tab-trigger"
      onClick={() => { if (!active) select(id) }}
      title={[title, context, environment === "local" ? "" : environment].filter(Boolean).join("\n")}>
      <Icon className="workspace-tab-type" aria-hidden="true" /><span className="workspace-tab-label">{title}</span>
    </TabsTrigger>
    <Button type="button" variant="ghost" size="icon-xs" className="workspace-tab-close" aria-label={`关闭标签页：${title}`}
      onClick={() => close(id)}><X aria-hidden="true" /></Button>
  </div>
})

function WorkspaceTabbar({ tabs, selected, ready, select, close, create, duplicate }: TabbarProps) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    root.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({block:"nearest", inline:"nearest"})
  }, [selected])
  return <div ref={root} className="workspace-tabbar-content shadcn-scope">
    <Tabs value={selected} onValueChange={select} className="workspace-tabs-root">
      <TabsList id="workspaceTabs" variant="line" aria-label="打开的页面" className="workspace-tab-list">
        {tabs.map(tab => <WorkspaceTabItem key={tab.id} {...tab} active={tab.id === selected} select={select} close={close} />)}
      </TabsList>
    </Tabs>
    <div className="workspace-tab-actions">
      <Button type="button" id="workspaceTabNew" variant="ghost" size="icon-xs" disabled={!ready} title="新建标签页（⌘/Ctrl+T）" aria-label="新建标签页" onClick={create}><Plus aria-hidden="true" /></Button>
      <Button type="button" id="workspaceTabDuplicate" variant="ghost" size="icon-xs" disabled={!tabs.length} title="在新标签页打开当前页面" aria-label="在新标签页打开当前页面" onClick={duplicate}><CopyPlus aria-hidden="true" /></Button>
    </div>
  </div>
}

const roots = new WeakMap<HTMLElement, Root>()
export function render(container: HTMLElement, props: TabbarProps) {
  let root = roots.get(container)
  if (!root) { root = createRoot(container); roots.set(container, root) }
  flushSync(() => root.render(<WorkspaceTabbar {...props} />))
}
