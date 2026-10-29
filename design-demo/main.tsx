import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react"
import { createRoot, type Root } from "react-dom/client"
import { ArrowLeft, FolderGit2, ListTodo, MessagesSquare, Palette, PanelLeftClose, PanelLeftOpen, Plus, RotateCcw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { TaskActions, TaskDetail, TaskList } from "@/workspace/tasks"
import type { DirectoryFilter, ProjectFilter } from "@/workspace/projects"
import { taskMatches, type TaskFilter } from "@/workspace/task-signals"
import type { Task } from "@/workspace/types"
import { initialTasks, projectsFor } from "./fixtures"
import { ProjectPreview } from "./project-preview"
import { ConversationPreview } from "./conversation-preview"
import logo from "../web/work-hub.svg"
import "../web/core/style.css"
import "../web/features/projects/projects.css"
import "../web/features/projects/git.css"
import "../web/features/tasks/workspace.css"
import "../frontend/styles.css"
import "../frontend/workspace/interactions.css"
import "./style.css"
import "./polish.css"

type Design = { color: string; radius: number; density: "comfortable" | "compact"; width: number }
const defaults: Design = { color: "#5964cf", radius: 10, density: "comfortable", width: 1200 }
const storageKey = "workhub:design-demo:v1"
function readDesign(): Design {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey) || "null")
    if (v && /^#[0-9a-f]{6}$/i.test(v.color) && ["comfortable", "compact"].includes(v.density) && v.radius >= 0 && v.radius <= 20 && v.width >= 900 && v.width <= 1600) return v
  } catch { /* A fresh session works without storage. */ }
  return defaults
}
function currentRoute() { return location.hash.slice(1) || "/requirements" }
type Modal = "create" | "edit" | "add-projects" | "directory" | "changes" | "git" | null

function Demo() {
  const [tasks, setTasks] = useState(initialTasks)
  const [route, setRoute] = useState(currentRoute)
  const [query, setQuery] = useState("")
  const [archive, setArchive] = useState(false)
  const [filter, setFilter] = useState<TaskFilter>("all")
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>("all")
  const [selectedProject, setSelectedProject] = useState("web-app")
  const [projectDetailOpen, setProjectDetailOpen] = useState(false)
  const [directoryFilter, setDirectoryFilter] = useState<DirectoryFilter>("all")
  const [collapsed, setCollapsed] = useState(() => innerWidth < 1100 && innerWidth > 760)
  const [design, setDesign] = useState(readDesign)
  const [designer, setDesigner] = useState(false)
  const [scenario, setScenario] = useState("mixed")
  const [modal, setModal] = useState<Modal>(null)
  const [contextProject, setContextProject] = useState("web-app")
  const [contextPath, setContextPath] = useState("")
  const [toast, setToast] = useState("")
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const projects = projectsFor(tasks)
  const isProjects = route === "/projects"
  const isConversations = route.startsWith("/sessions")
  const taskScope = route.startsWith("/sessions/task/") ? route.slice("/sessions/task/".length) : undefined
  const projectScope = route.startsWith("/sessions/project/") ? route.slice("/sessions/project/".length) : undefined
  const task = tasks.find(t => route === `/requirements/${t.id}`)
  const navigate = (next: string) => { location.hash = next; setQuery(""); setFilter("all") }
  function notify(message: string) {
    clearTimeout(toastTimer.current); setToast(message)
    toastTimer.current = setTimeout(() => setToast(""), 4000)
  }
  useEffect(() => {
    const onHash = () => { setRoute(currentRoute()); setFilter("all"); setQuery("") }
    addEventListener("hashchange", onHash)
    return () => { removeEventListener("hashchange", onHash); clearTimeout(toastTimer.current) }
  }, [])
  useEffect(() => { document.body.classList.toggle("sidebar-collapsed", collapsed) }, [collapsed])
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty("--demo-primary", design.color)
    root.style.setProperty("--demo-radius", `${design.radius}px`)
    root.style.setProperty("--demo-width", `${design.width}px`)
    document.body.dataset.density = design.density
    try { localStorage.setItem(storageKey, JSON.stringify(design)) } catch { /* Optional persistence. */ }
  }, [design])

  function updateTask(update: (t: Task) => Task) {
    if (task) setTasks(items => items.map(t => t.id === task.id ? update(t) : t))
  }
  function chooseScenario(value: string) {
    setScenario(value); setFilter("all"); setQuery("")
    if (value === "mixed") { setTasks(initialTasks()); return }
    setTasks(initialTasks().map(t => ({ ...t, connected: value !== "offline", members: value === "empty" ? [] : t.members.map(m => ({ ...m, state: "ready", worktree: { ...m.worktree!, missing: value === "issues", dirty: value === "dirty" ? 4 : 0, sync_ahead: 0, status_updated_at: value === "loading" ? undefined : "2026-10-28T09:30:00+08:00" } })) })))
  }
  async function actions(e: MouseEvent<HTMLElement>) {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")
    if (!target || target.matches(":disabled")) return
    e.preventDefault()
    const action = target.dataset.action
    const id = target.dataset.id || target.dataset.project || contextProject
    setContextProject(target.dataset.project || id)
    setContextPath(target.dataset.path || "")
    if (action === "task-conversations") return navigate(`/sessions/task/${id}`)
    if (action === "project-conversations") return navigate(`/sessions/project/${id}`)
    if (action === "open-requirement" || action === "jump-requirement") return navigate(`/requirements/${id}`)
    if (action === "task-project-filter") return setFilter(target.dataset.filter as TaskFilter)
    if (action === "edit-task") return setModal("edit")
    if (action === "add-requirement-projects") return setModal("add-projects")
    if (action === "archive") { updateTask(t => ({ ...t, state: t.state === "archived" ? "ready" : "archived" })); return notify("已更新演示任务的归档状态") }
    if (action === "copy-path" || action?.includes("copy")) {
      try { await navigator.clipboard.writeText(target.dataset.path || ""); notify("已复制路径") } catch { notify("浏览器未允许复制，请在目录详情中选择路径") }
      return
    }
    if (action === "select-project") { setSelectedProject(id); setProjectDetailOpen(true); setDirectoryFilter("all"); return }
    if (action === "project-filter") { setProjectFilter(target.dataset.filter as ProjectFilter); setDirectoryFilter("all"); return }
    if (action === "project-directory-filter") return setDirectoryFilter(target.dataset.filter as DirectoryFilter)
    if (action === "project-list") return setProjectDetailOpen(false)
    if (action === "clear-project-search") return setQuery("")
    if (action === "changes-open") return setModal("changes")
    if (action === "git-open") return setModal("git")
    if (action === "change-task-directory") { if (!task) navigate(`/requirements/${id}`); return setModal("directory") }
    if (action === "remove-task-project") { updateTask(t => ({ ...t, members: t.members.filter(m => m.project_id !== target.dataset.project) })); return notify("已从演示任务移除项目") }
    if (action === "retry" || action === "project-refresh") {
      updateTask(t => ({ ...t, members: t.members.map(m => m.project_id === (target.dataset.project || id) ? { ...m, state: "ready", error: undefined, worktree: { ...m.worktree!, missing: false, error: undefined, status_updated_at: new Date().toISOString() } } : m) })); return notify("已模拟重新检查目录")
    }
    notify(`${target.innerText.trim() || "操作"}：这是设计演示，已展示模拟反馈`)
  }
  function submitTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const name = String(data.get("name") || "").trim()
    if (!name) return
    const description = String(data.get("description") || "").trim()
    if (modal === "edit") updateTask(t => ({ ...t, name, description }))
    else {
      const id = `demo-${Date.now()}`
      const selected = data.getAll("projects")
      const t: Task = { ...initialTasks()[0], id, name, description, state: "ready", members: initialTasks()[0].members.filter(m => selected.includes(m.project_id)), created_at: new Date().toISOString() }
      setTasks(v => [t, ...v]); navigate(`/requirements/${id}`)
    }
    setModal(null); notify("已保存演示任务")
  }
  function submitProjects(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const selected = new FormData(e.currentTarget).getAll("projects")
    updateTask(t => ({ ...t, members: [...t.members, ...initialTasks()[0].members.filter(m => selected.includes(m.project_id) && !t.members.some(v => v.project_id === m.project_id))] }))
    setModal(null); notify("已关联演示项目")
  }
  const filteredTasks = tasks.filter(t => (archive || t.state !== "archived") && taskMatches(t, filter) && `${t.name} ${t.description} ${t.branch}`.toLowerCase().includes(query.toLowerCase()))
  const filteredProjects = projects.filter(p => `${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase()))
  const title = task?.name || (isConversations ? "对话" : isProjects ? "项目" : "任务")
  const modalTitle = { create: "创建任务", edit: "编辑任务信息", "add-projects": "关联项目", directory: "更换工作目录", changes: "查看改动", git: "Git 操作" }
  const contextTree = projects.flatMap(p => p.worktrees).find(t => t.path === contextPath)
  return <>
    <aside className="sidebar" aria-label="主导航">
      <a className="brand" href="#/requirements"><img className="brand-mark" src={logo} width="36" height="36" alt="" /><span>Work Hub<small>让每一份工作，各就其位。</small></span></a>
      <div className="sidebar-controls"><button className="sidebar-toggle" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} onClick={() => setCollapsed(v => !v)}>{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div>
      <div className="nav-label">工作台</div>
      <nav>{[{ path: "/requirements", label: "任务", Icon: ListTodo }, { path: "/projects", label: "项目", Icon: FolderGit2 }, { path: "/sessions", label: "对话", Icon: MessagesSquare }].map(({ path, label, Icon }) => {
        const selected = path === "/sessions" ? isConversations : path === "/projects" ? isProjects : !isProjects && !isConversations
        return <button key={path} className={`nav-item ${selected ? "active" : ""}`} title={label} aria-current={selected ? "page" : undefined} onClick={() => navigate(path)}><span className="nav-icon"><Icon size={18} /></span><span className="nav-text">{label}</span>{path !== "/sessions" && <span className="nav-count">{path === "/projects" ? projects.length : tasks.filter(t => t.state !== "archived").length}</span>}</button>
      })}</nav>
      <footer className="sync workspace-status sidebar-footer"><div className="sidebar-status-copy"><div className="sidebar-status-line"><span className="live-dot" />设计演示</div><div className="sidebar-bottom">模拟数据 · 本地预览</div></div><div className="sidebar-footer-actions"><button className="demo-icon" aria-label="设计调节" title="设计调节" onClick={() => setDesigner(true)}><Palette size={18} /></button></div></footer>
    </aside>
    <div className="shell"><main onClick={actions} className={isConversations ? "demo-conversation-mode" : undefined}>
      <div className={`demo-breadcrumb ${task ? "demo-task-navigation" : ""}`}>{task ? <a className="workspace-back" href="#/requirements"><ArrowLeft size={14} /> 返回任务列表</a> : <><span>设计 Demo</span><span>/</span><span>{title}</span></>}<button onClick={() => setDesigner(true)}><Palette size={14} />设计调节</button></div>
      <div className="page-heading" hidden={isConversations}><div><h1>{title}</h1>{!task && <p>{isProjects ? "管理代码仓库，为任务选择合适的工作目录。" : "围绕一项开发目标，集中管理相关项目的工作目录、分支和会话。"}</p>}</div><div className="shadcn-scope">{task ? <TaskActions task={task} environment={task.environment_name} /> : !isProjects && <Button onClick={() => setModal("create")}><Plus />创建任务</Button>}</div></div>
      {tasks.some(t => !t.connected) && <div className="demo-offline" role="status">执行环境未连接 · 当前显示演示缓存，可在设计调节中切换状态。</div>}
      <section className="content-panel" hidden={isConversations}>
        {!task && <div className="panel-toolbar"><div className="panel-title">{isProjects ? "已登记项目" : "全部任务"}</div><div className="toolbar-actions shadcn-scope"><div className="demo-search"><Search size={15} /><Input aria-label="搜索" placeholder={isProjects ? "搜索项目名称、路径…" : "搜索任务名称、说明…"} value={query} onChange={e => setQuery(e.target.value)} /></div>{!isProjects && <><label className="demo-check"><input type="checkbox" checked={archive} onChange={e => setArchive(e.target.checked)} />显示归档</label><select aria-label="筛选工作目录状态" value={filter} onChange={e => setFilter(e.target.value as TaskFilter)}><option value="all">全部状态</option><option value="issues">目录异常</option><option value="dirty">有改动</option><option value="push">待推送</option><option value="conflicts">Git 操作待处理</option></select></>}</div></div>}
        {task ? <TaskDetail task={task} projects={projects} environment={task.environment_name} filter={filter} /> : isProjects ? <ProjectPreview projects={filteredProjects} selectedID={selectedProject} detailOpen={projectDetailOpen} directoryFilter={directoryFilter} tasks={tasks} filter={projectFilter} searching={!!query} /> : filteredTasks.length ? <TaskList tasks={filteredTasks} /> : <div className="demo-empty"><ListTodo size={28} /><h2>{query || filter !== "all" ? "没有符合条件的任务" : "还没有任务"}</h2><p>调整筛选条件，或创建一个新的开发任务。</p><div className="shadcn-scope"><Button variant="outline" onClick={() => { setQuery(""); setFilter("all") }}>清除筛选</Button> <Button onClick={() => setModal("create")}>创建任务</Button></div></div>}
      </section>
      <section className="demo-conversation-host" hidden={!isConversations} aria-label="对话工作区"><ConversationPreview tasks={tasks} projects={projects} active={isConversations} taskScope={taskScope} projectScope={projectScope} navigate={navigate} /></section>
      <p className="demo-caption" hidden={isConversations}>交互设计演示 · 所有任务和仓库数据均为模拟数据</p>
    </main></div>

    <Dialog open={designer} onOpenChange={setDesigner} modal={false}><DialogContent onInteractOutside={e => e.preventDefault()} className="shadcn-scope demo-dialog demo-design-dialog"><DialogTitle>设计调节</DialogTitle><DialogDescription>即时比较样式和界面状态，偏好保存在当前浏览器。</DialogDescription><div className="demo-design-fields">
      <label>主题色<div className="demo-swatches">{["#5964cf", "#237a69", "#446ba8", "#7958a5"].map(color => <button key={color} type="button" aria-label={`主题色 ${color}`} aria-pressed={design.color === color} style={{ background: color }} onClick={() => setDesign(v => ({ ...v, color }))} />)}<input type="color" aria-label="自定义主题色" value={design.color} onChange={e => setDesign(v => ({ ...v, color: e.target.value }))} /></div></label>
      <label>圆角 <output>{design.radius}px</output><input aria-label="圆角" type="range" min="0" max="20" value={design.radius} onChange={e => setDesign(v => ({ ...v, radius: +e.target.value }))} /></label>
      <label>内容最大宽度 <output>{design.width}px</output><input aria-label="内容最大宽度" type="range" min="900" max="1600" step="50" value={design.width} onChange={e => setDesign(v => ({ ...v, width: +e.target.value }))} /></label>
      <label>内容密度<select value={design.density} onChange={e => setDesign(v => ({ ...v, density: e.target.value as Design["density"] }))}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label>
      <label>演示状态<select value={scenario} onChange={e => chooseScenario(e.target.value)}><option value="mixed">混合状态（默认）</option><option value="clean">全部干净</option><option value="dirty">有未提交改动</option><option value="issues">工作目录丢失</option><option value="loading">正在检查目录</option><option value="empty">未关联项目</option><option value="offline">环境未连接</option></select></label>
      <Button variant="outline" onClick={() => { setDesign(defaults); chooseScenario("mixed") }}><RotateCcw />恢复默认设计</Button>
      <Button onClick={async () => { try { await navigator.clipboard.writeText(`/* Work Hub design demo */\n:root {\n  --demo-primary: ${design.color};\n  --demo-radius: ${design.radius}px;\n  --demo-width: ${design.width}px;\n}\n/* density: ${design.density} */`); notify("已复制设计参数") } catch { notify("复制失败，请检查浏览器剪贴板权限") } }}>复制设计参数</Button>
    </div></DialogContent></Dialog>

    <Dialog open={modal !== null} onOpenChange={open => { if (!open) setModal(null) }}><DialogContent className="shadcn-scope demo-dialog"><DialogTitle>{modal ? modalTitle[modal] : ""}</DialogTitle><DialogDescription>{modal === "create" || modal === "edit" ? "记录开发目标，并关联本次工作涉及的项目。" : "以下为模拟数据，用于检查布局和操作反馈。"}</DialogDescription>
      {(modal === "create" || modal === "edit") && <form key={modal + task?.id} onSubmit={submitTask} className="demo-form"><label>任务名称<Input name="name" required maxLength={80} defaultValue={modal === "edit" ? task?.name : ""} placeholder="例如：优化跨项目工作台" autoFocus /></label><label>任务目标<Textarea name="description" rows={4} defaultValue={modal === "edit" ? task?.description : ""} placeholder="希望解决什么问题？怎样算完成？" /></label>{modal === "create" && <fieldset><legend>关联项目</legend>{projects.map(p => <label className="demo-check" key={p.id}><input type="checkbox" name="projects" value={p.id} />{p.name}</label>)}</fieldset>}<div className="demo-form-footer"><Button type="button" variant="outline" onClick={() => setModal(null)}>取消</Button><Button type="submit">{modal === "create" ? "创建任务" : "保存修改"}</Button></div></form>}
      {modal === "add-projects" && <form onSubmit={submitProjects} className="demo-form">{projects.filter(p => !task?.members.some(m => m.project_id === p.id)).map(p => <label className="demo-check" key={p.id}><input type="checkbox" name="projects" value={p.id} />{p.name}<small>{p.path}</small></label>)}{task?.members.length === projects.length && <p>所有演示项目均已关联。</p>}<Button type="submit">保存关联项目</Button></form>}
      {modal === "directory" && <form className="demo-form" onSubmit={e => { e.preventDefault(); const path = String(new FormData(e.currentTarget).get("path")); updateTask(t => ({ ...t, members: t.members.map(m => m.project_id === contextProject ? { ...m, path, state: "ready", error: undefined, worktree: { ...m.worktree!, path, missing: false, error: undefined, status_updated_at: new Date().toISOString() } } : m) })); setModal(null); notify("已更换演示工作目录") }}><label>工作目录<select name="path"><option value={`/home/demo/projects/${contextProject}`}>项目原目录 · ~/projects/{contextProject}</option><option value={`/home/demo/workspaces/recovered/${contextProject}`}>已有 Worktree · ~/workspaces/recovered/{contextProject}</option></select></label><Button type="submit">使用此目录</Button></form>}
      {modal === "changes" && <div className="demo-changes">{contextTree?.dirty ? <><p>{contextTree.dirty} 个文件有改动 <span>+28 −9</span></p>{["frontend/workspace/tasks.tsx", "frontend/workspace/shared.tsx", "web/features/tasks/workspace.css", "frontend/styles.css"].slice(0, contextTree.dirty).map(file => <div key={file}><code>{file}</code><span>已修改</span></div>)}<pre><code>{"  .task-project {\n-   padding: 20px;\n+   padding: 16px;\n+   border-radius: var(--radius);\n  }"}</code></pre></> : <p>此工作目录没有未提交改动。</p>}<Button onClick={() => { setModal(null); notify("已模拟检查项目改动") }}>完成检查</Button></div>}
      {modal === "git" && <div className="demo-form"><div className="demo-git-summary"><span>当前分支</span><code>codex/workspace-polish</code><span>上游分支</span><code>origin/codex/workspace-polish</code><span>同步状态</span><strong>领先 2 个提交</strong></div><div className="demo-form-footer">{["获取远端", "拉取", "推送"].map(label => <Button key={label} variant={label === "推送" ? "default" : "outline"} onClick={() => { setModal(null); notify(`已模拟${label}`) }}>{label}</Button>)}</div></div>}
    </DialogContent></Dialog>
    {toast && <div className="demo-toast" role="status">{toast}</div>}
  </>
}

// Retain the root when Vite reloads this entry during a design iteration.
const root = (import.meta.hot?.data.root as Root | undefined) || createRoot(document.getElementById("root")!)
if (import.meta.hot) import.meta.hot.data.root = root
root.render(<Demo />)
