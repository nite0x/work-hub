import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react"
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react"
import { ArrowLeft, Folder, GitBranch, LoaderCircle, MessageSquare, Plus, Search } from "lucide-react"
import { Thread } from "@/components/assistant-ui/elements/thread.aui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { ConversationList } from "@/workspace/session-browser"
import { conversationContext } from "@/workspace/conversation-context"
import type { Session } from "@/workspace/sessions"
import type { Project, Task } from "@/workspace/types"
import "../web/features/sessions/sessions.css"
import "../web/features/sessions/session-workspace.css"
import "../frontend/chat/style.css"
import "./conversation.css"

type Conversation = Session & { taskID: string; projectID: string; messages: ThreadMessageLike[]; running?: boolean }
const message = (role: "user" | "assistant", text: string): ThreadMessageLike => ({ id: crypto.randomUUID(), role, content: [{ type: "text", text }] })
function initialConversations(tasks: Task[]): Conversation[] {
  return [
    { taskID: "workspace-polish", projectID: "web-app", name: "梳理任务工作区的信息层级", pinned: true,
      messages: [message("user", "帮我看看任务页，如何更快找到需要处理的项目？"), message("assistant", "可以先按任务集中展示项目，再突出当前需要处理的状态。\n\n- **Web 前端**：4 项未提交改动，另有 2 个提交待推送。\n- **API 服务**：没有未提交改动。\n- **共享组件**：工作目录丢失，需要更换目录。\n\n建议把分支和状态放在项目名称下方，保留「打开工作目录」和「查看改动」两个主要操作。"), message("user", "保留完整路径，但不要让路径抢占视觉重点。"), message("assistant", "可以将路径放在次要一行，使用较浅的等宽文字，并在点击时复制完整路径。分支、修改状态和下一步操作继续保持在主视线中。\n\n这样能直接从当前任务进入对应项目，继续工作。") ] },
    { taskID: "directory-recovery", projectID: "api-server", name: "确认工作目录恢复方案", unread: true,
      messages: [message("user", "工作目录丢失时，任务页应该怎么提示？"), message("assistant", "在项目行明确标出 **目录丢失**，保留原路径供核对，并提供「更换工作目录」。\n\n选择新目录后重新检查分支和改动状态，让用户能从原任务继续工作。") ] },
    { taskID: "review-flow", projectID: "web-app", name: "整理收尾检查清单",
      messages: [message("user", "整理一下任务结束前需要检查的项目状态。"), message("assistant", "建议逐个项目确认：\n\n1. 是否仍有未提交改动。\n2. 是否有尚未推送的提交。\n3. 是否存在进行中的 Git 操作。\n4. 工作目录是否仍需保留。\n\n先展示状态，再由用户决定下一步操作。") ] },
  ].map((item, i) => ({ ...item, id: `conversation-${i + 1}`, cwd: tasks.find(t => t.id === item.taskID)?.members.find(m => m.project_id === item.projectID)?.path || "", environment_id: "local", environment_name: "本机 · Ubuntu", available: true, updated_at: Date.now() / 1000 - i * 3600 }))
}
function Welcome() {
  return <div className="demo-chat-welcome"><MessageSquare size={28} /><h2>从当前工作现场开始</h2><p>描述本次任务的目标，或交代下一步要处理的项目。</p></div>
}
const threadComponents = { Welcome }
function MessageThread({ conversation, send, stop }: { conversation: Conversation; send: (id: string, text: string) => Promise<void>; stop: (id: string) => void }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: conversation.messages, convertMessage: item => item, isRunning: !!conversation.running,
    isSendDisabled: !!conversation.running,
    onNew: async item => { const text = item.content.filter(p => p.type === "text").map(p => p.text).join("\n"); await send(conversation.id, text) },
    onCancel: async () => stop(conversation.id),
  })
  return <AssistantRuntimeProvider runtime={runtime}><Thread autoFocus={false} components={threadComponents}
    composerLeadingControls={<span className="demo-chat-model">模拟回复</span>}
    composerStatus={conversation.running ? <div className="demo-chat-running" role="status"><LoaderCircle size={14} />正在生成演示回复…</div> : undefined} /></AssistantRuntimeProvider>
}

export function ConversationPreview({ tasks, projects, active, taskScope, projectScope, navigate }: {
  tasks: Task[]; projects: Project[]; active: boolean; taskScope?: string; projectScope?: string; navigate: (route: string) => void
}) {
  const [conversations, setConversations] = useState(() => initialConversations(tasks))
  const [selected, setSelected] = useState("conversation-1")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [detailOpen, setDetailOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [targetTask, setTargetTask] = useState(taskScope || tasks[0]?.id || "")
  const [listWidth, setListWidth] = useState(280)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; resolve: () => void }>())
  const workspace = { tasks, projects }
  const scope = taskScope ? `task:${taskScope}` : projectScope ? `project:${projectScope}` : "all"
  const scoped = conversations.filter(c => (!taskScope || c.taskID === taskScope) && (!projectScope || c.projectID === projectScope))
  const current = scoped.find(c => c.id === selected) || scoped[0]
  const context = current ? conversationContext(current.cwd, workspace, current.taskID) : undefined
  const task = tasks.find(t => t.id === current?.taskID)
  const creationTask = tasks.find(t => t.id === targetTask)
  const choices = creationTask?.members.filter(m => m.state === "ready" && !m.worktree?.missing) || []
  const visible = scoped.filter(c => (status === "all" || (status === "running" ? c.running : c.unread)) && `${c.name} ${c.cwd} ${conversationContext(c.cwd, workspace).project || ""} ${conversationContext(c.cwd, workspace).branch || ""}`.toLowerCase().includes(search.toLowerCase()))
  useEffect(() => { setSearch(""); setStatus("all"); setDetailOpen(!!taskScope || !!projectScope); if (taskScope) setTargetTask(taskScope) }, [taskScope, projectScope])
  useEffect(() => () => { for (const run of pending.current.values()) { clearTimeout(run.timer); run.resolve() } pending.current.clear() }, [])
  function patch(id: string, update: (c: Conversation) => Conversation) { setConversations(items => items.map(c => c.id === id ? update(c) : c)) }
  function stop(id: string) {
    const run = pending.current.get(id)
    if (!run) return
    clearTimeout(run.timer); pending.current.delete(id); run.resolve()
    patch(id, c => ({ ...c, running: false, messages: [...c.messages, message("assistant", "已停止本轮模拟回复。可以补充说明后继续。") ] }))
  }
  function send(id: string, text: string) {
    if (!text.trim() || pending.current.has(id)) return Promise.resolve()
    patch(id, c => ({ ...c, running: true, unread: false, updated_at: Date.now() / 1000, messages: [...c.messages, message("user", text)] }))
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        pending.current.delete(id)
        patch(id, c => ({ ...c, running: false, messages: [...c.messages, message("assistant", `收到：${text.trim()}\n\n这是用于调整对话设计的**模拟回复**。可以继续围绕当前项目讨论任务目标、分支和目录状态。\n\n- 先确认需要处理的项目与工作目录。\n- 再从任务工作区查看改动，并继续下一步工作。`)] }))
        resolve()
      }, 1800)
      pending.current.set(id, { timer, resolve })
    })
  }
  function listAction(e: MouseEvent<HTMLElement>) {
    const button = (e.target as HTMLElement).closest<HTMLElement>("[data-conversation-session], [data-conversation-action]")
    if (!button) return
    if (button.dataset.conversationSession) {
      const id = button.dataset.conversationSession
      setSelected(id); setDetailOpen(true); patch(id, c => ({ ...c, unread: false }))
    } else if (button.dataset.conversationAction === "new") { setTargetTask(taskScope || tasks[0]?.id || ""); setNewOpen(true) }
    else { setSearch(""); setStatus("all") }
  }
  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const member = choices.find(m => m.project_id === data.get("project"))
    const name = String(data.get("name") || "").trim()
    if (!member || !creationTask || !name) return
    const id = crypto.randomUUID()
    setConversations(items => [{ id, name, taskID: creationTask.id, projectID: member.project_id, cwd: member.path, messages: [], available: true, environment_id: "local", environment_name: creationTask.environment_name, updated_at: Date.now() / 1000 }, ...items])
    setSelected(id); setSearch(""); setStatus("all"); setDetailOpen(true); setNewOpen(false)
    if ((taskScope && taskScope !== creationTask.id) || (projectScope && projectScope !== member.project_id)) navigate(`/sessions/task/${creationTask.id}`)
  }
  return <>
    <div className="session-browser shadcn-scope demo-conversation-browser" data-pane={detailOpen ? "detail" : "list"} style={{ "--conversation-list-width": `${listWidth}px` } as CSSProperties}>
      <div className="session-browser-body">
        <aside className="session-browser-list" aria-label="对话列表" onClick={listAction}>
          <div className="session-browser-list-tools">
            <div className="session-browser-list-heading"><strong>对话</strong><Button size="sm" variant="outline" onClick={() => { setTargetTask(taskScope || tasks[0]?.id || ""); setNewOpen(true) }}><Plus />新建对话</Button></div>
            <label className="demo-chat-scope"><span className="sr-only">对话范围</span><select aria-label="对话范围" value={scope} onChange={e => { const v = e.target.value; navigate(v === "all" ? "/sessions" : `/sessions/${v.replace(":", "/")}`) }}><option value="all">全部对话</option>{tasks.map(t => <option key={t.id} value={`task:${t.id}`}>任务 · {t.name}</option>)}{projects.map(p => <option key={p.id} value={`project:${p.id}`}>项目 · {p.name}</option>)}</select></label>
            <div className="session-browser-search"><Search /><Input aria-label="搜索对话、项目或分支" placeholder="搜索对话、项目或分支" value={search} onChange={e => setSearch(e.target.value)} /></div>
            <div className="session-status-filters" role="group" aria-label="按对话状态筛选">{[["all", "全部"], ["running", "进行中"], ["unread", "未读"]].map(([value, label]) => <button type="button" key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{label}<span>{scoped.filter(c => value === "all" || (value === "running" ? c.running : c.unread)).length}</span></button>)}</div>
            <div className="session-browser-list-caption" role="status">{visible.length} 个对话</div>
          </div>
          <div className="demo-chat-results"><ConversationList sessions={visible.map(c => ({ ...c, chat_status: c.running ? "running" : "idle", context: conversationContext(c.cwd, workspace, c.taskID) }))} selected={current?.id} showDirectory filtered={!!search || status !== "all"} /></div>
        </aside>
        <div className="session-browser-resize" role="separator" tabIndex={0} aria-label="调整对话列表宽度" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={480} aria-valuenow={listWidth}
          onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, width: listWidth } }}
          onPointerMove={e => { if (drag.current) setListWidth(Math.max(220, Math.min(480, drag.current.width + e.clientX - drag.current.x))) }}
          onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
          onKeyDown={e => { if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); setListWidth(v => Math.max(220, Math.min(480, v + (e.key === "ArrowLeft" ? -20 : 20)))) } }} />
        <section className="session-browser-detail" aria-label="对话详情">
          <div className="session-browser-mobile-back"><Button size="sm" variant="ghost" onClick={() => setDetailOpen(false)}><ArrowLeft />对话列表</Button></div>
          {current ? <>
            <header className="chat-panel-header demo-chat-header"><div className="chat-panel-toolbar"><h2>{current.name}</h2><Button size="sm" variant="ghost" onClick={() => navigate(`/requirements/${current.taskID}`)}>查看任务</Button></div>
              <details className="chat-workspace-context"><summary><span className="chat-workspace-project"><Folder size={14} />{context?.project || "工作目录"}</span><span className="chat-workspace-branch"><GitBranch size={14} />{context?.branch || "main"}</span></summary><dl className="chat-context-facts"><dt>执行环境</dt><dd>{current.environment_name}</dd><dt>工作目录</dt><dd>{current.cwd}</dd><dt>目录类型</dt><dd>{context?.kind}</dd><dt>关联任务</dt><dd>{task?.name || "未关联任务"}</dd><dt>相关项目</dt><dd>{task?.members.map(m => m.project_name).join("、") || "无"}</dd></dl></details>
            </header>
            <div className="assistant-chat-scope demo-chat-thread">{active && <MessageThread key={current.id} conversation={current} send={send} stop={stop} />}</div>
            <p className="demo-chat-notice">设计演示 · 消息仅保留在当前页面，回复为模拟内容</p>
          </> : <div className="session-browser-empty"><MessageSquare size={26} /><p>当前范围还没有对话。</p><Button onClick={() => setNewOpen(true)}><Plus />新建对话</Button></div>}
        </section>
      </div>
    </div>
    <Dialog open={newOpen} onOpenChange={setNewOpen}><DialogContent className="shadcn-scope demo-dialog"><DialogTitle>新建对话</DialogTitle><DialogDescription>选择本次工作的任务与项目目录。</DialogDescription><form className="demo-form" onSubmit={create}><label>对话名称<Input name="name" required maxLength={80} placeholder="例如：梳理任务页布局" /></label><label>关联任务<select aria-label="关联任务" value={targetTask} onChange={e => setTargetTask(e.target.value)}>{tasks.filter(t => t.state !== "archived").map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>工作项目<select key={targetTask} name="project" aria-label="工作项目" required defaultValue={choices[0]?.project_id || ""}>{!choices.length && <option value="">此任务暂无可用工作目录</option>}{choices.map(m => <option key={m.project_id} value={m.project_id}>{m.project_name} · {m.worktree?.branch}</option>)}</select></label><div className="demo-form-footer"><Button type="button" variant="outline" onClick={() => setNewOpen(false)}>取消</Button><Button type="submit" disabled={!choices.length}>创建对话</Button></div></form></DialogContent></Dialog>
  </>
}
