import { Plus, Search, ArrowLeft, ArrowUpRight, X, ChevronDown, Pin, PinOff, GitBranch, SlidersHorizontal, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "./shared"
import { SessionHistoryPanel, type Session } from "./sessions"

export interface ConversationScope { kind: string; id?: string; name: string; cwd?: string }
export function SessionBrowser() {
  return <div className="session-browser shadcn-scope" id="sessionBrowser" data-pane="list" hidden>
    <div className="session-browser-body">
      <aside className="session-browser-list" id="sessionBrowserListPane" aria-label="对话列表"><div className="session-browser-list-tools">
        <div className="session-browser-list-heading"><strong>对话</strong><Button type="button" size="sm" variant="outline" id="newBrowserSession" data-conversation-action="new"><Plus aria-hidden="true" />新建</Button></div>
    <div className="session-browser-scope" id="sessionBrowserScopeBar">
      <details className="session-scope-picker" id="sessionScopePicker"><summary><span id="sessionScopeLabel">全部会话</span><ChevronDown aria-hidden="true" /></summary>
        <div className="session-scope-menu"><Label htmlFor="sessionScopeSearch">切换对话范围</Label><Input id="sessionScopeSearch" type="search" placeholder="搜索任务、项目或目录" /><Button type="button" variant="ghost" size="sm" data-conversation-action="all" id="sessionScopeAll" hidden>查看全部会话</Button><div id="sessionScopeOptions" /></div>
      </details>
      <label id="sessionEnvironmentField" className="session-environment-label" hidden><span>执行环境</span><NativeSelect id="sessionsEnvironment" aria-label="会话环境"><option value="local">本机</option></NativeSelect></label>
    </div>
        <p id="sessionBrowserContext" className="sr-only" />
        <div id="taskConversationTools" className="task-conversation-tools" hidden><Button type="button" variant="outline" size="sm" id="linkTaskConversation" data-session-action="picker">关联已有会话</Button><span className="text-xs text-muted-foreground">仅展示明确关联的会话</span></div>
        <div className="session-browser-search-row">
          <label className="session-browser-search"><Search aria-hidden="true" /><span className="sr-only">搜索对话</span><Input id="sessionBrowserSearch" type="search" placeholder="搜索对话" className="pl-8" /></label>
          <details id="sessionFilterPicker" className="session-filter-picker"><summary aria-label="筛选对话" title="筛选目录与归档"><SlidersHorizontal aria-hidden="true" /><span id="sessionFilterCount" hidden /></summary><div className="session-filter-menu">
            <label id="sessionDirectoryField"><span>工作目录</span><NativeSelect id="sessionDirectoryFilter" aria-label="筛选工作目录" /></label>
            <label className="session-browser-archive"><input id="sessionBrowserArchived" type="checkbox" aria-label="查看已归档对话" />查看已归档对话</label>
          </div></details>
        </div>
        <p id="sessionActiveFilterLabel" className="session-active-filter-label" hidden />
        <div className="session-browser-list-caption"><span id="sessionBrowserCount" role="status" aria-live="polite" /><div className="session-browser-caption-actions"><Button type="button" variant="ghost" size="sm" id="sessionClearFilters" data-conversation-action="clear-filters" hidden>清除筛选</Button><Button type="button" variant="ghost" size="icon" data-conversation-action="refresh" title="刷新对话列表" aria-label="刷新会话列表"><RotateCw aria-hidden="true" /></Button></div></div>
      </div><div id="sessionBrowserError" role="alert" hidden /><div id="sessionBrowserList" /></aside>
      <div id="sessionBrowserResize" className="session-browser-resize" role="separator" tabIndex={0} aria-label="调整对话列表宽度" aria-orientation="vertical" aria-controls="sessionBrowserListPane" aria-valuemin={220} aria-valuemax={520} aria-valuenow={280} />
      <section className="session-browser-detail" aria-label="对话详情"><div className="session-browser-mobile-back"><Button type="button" size="sm" variant="ghost" data-conversation-action="back"><ArrowLeft aria-hidden="true" />对话列表</Button></div>
        <div id="sessionBrowserNewDirectoryField" className="session-browser-new-directory" hidden><Label htmlFor="sessionBrowserNewDirectory">工作目录</Label><NativeSelect id="sessionBrowserNewDirectory" /></div>
        <fieldset id="sessionBrowserAdditionalField" className="session-browser-new-directory" hidden><legend>本次会话可访问的其他项目目录</legend><div id="sessionBrowserAdditionalDirectories" /></fieldset>
        <div id="sessionBrowserEmpty" className="session-browser-empty" role="status">选择一个对话，或新建对话开始工作。</div>
        <aside id="sessionHistoryPanel" className="session-history-panel shadcn-scope" role="region" aria-labelledby="sessionHistoryTitle" hidden><SessionHistoryPanel /></aside>
      </section>
    </div>
  </div>
}
export function ConversationShortcuts({ pinned, recent, selected, loading, error, readOnly }: { pinned: Session[]; recent: Session[]; selected?: string | null; loading?: boolean; error?: string; readOnly?: boolean }) {
  const rows = (sessions: Session[]) => <ul>{sessions.map(s => {
    const directory = s.cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || s.cwd
    const context = [s.context?.project || directory, s.context?.tasks.map(t => t.name).join("、") || s.context?.branch || (s.context?.project ? directory : "")].filter(Boolean).join(" · ")
    const status = s.chat_status === "waiting" ? "待确认" : ["starting", "running", "stopping", "handoff"].includes(s.chat_status || "") ? "运行中" : s.unread ? "有新消息" : ""
    return <li key={s.id} className="conversation-shortcut-row">
      <button type="button" className="conversation-shortcut-open" data-conversation-shortcut={s.id} aria-current={selected === s.id ? "true" : undefined} title={`${s.name || "未命名对话"}\n${context}\n${s.cwd}`}>
        <span className="conversation-shortcut-title">{s.name || "未命名对话"}</span>
        <span className="conversation-shortcut-context">{context}</span>
        {status && <span className="conversation-shortcut-status" data-state={s.chat_status === "waiting" ? "waiting" : s.unread ? "unread" : "running"} title={status}><span className="sr-only">{status}</span></span>}
      </button>
      {!readOnly && <button type="button" className="conversation-shortcut-pin" data-shortcut-pin={s.id} aria-label={`${s.pinned ? "取消固定" : "固定对话"}：${s.name || "未命名对话"}`} title={s.pinned ? "取消固定" : "固定对话"}>{s.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}</button>}
    </li>
  })}</ul>
  return <><section aria-labelledby="shortcutPinnedTitle"><h2 id="shortcutPinnedTitle"><Pin aria-hidden="true" />固定对话</h2>{pinned.length ? <>{rows(pinned.slice(0, 3))}{pinned.length > 3 && <details className="conversation-shortcuts-more"><summary>其余 {pinned.length - 3} 个固定对话</summary>{rows(pinned.slice(3))}</details>}</> : <p className="conversation-shortcuts-empty">固定常用对话，随时回来</p>}</section>
    <section aria-labelledby="shortcutRecentTitle"><h2 id="shortcutRecentTitle">最近对话</h2>{recent.length ? rows(recent) : <p className="conversation-shortcuts-empty">{loading ? "正在读取…" : "打开的对话会显示在这里"}</p>}</section>
    {error && <button type="button" className="conversation-shortcuts-retry" data-conversation-action="refresh-shortcuts" title={error}>读取失败，点击重试</button>}
  </>
}
export function ConversationDialogHeader() {
  return <header className="conversation-dialog-heading"><div><h2 id="conversationDialogTitle">对话</h2><p id="conversationDialogScope" /></div><div className="conversation-dialog-actions"><Button type="button" variant="ghost" size="sm" data-conversation-action="page"><ArrowUpRight aria-hidden="true" />转到会话页</Button><Button type="button" variant="ghost" size="icon" data-conversation-action="close" aria-label="关闭对话，运行继续"><X aria-hidden="true" /></Button></div></header>
}
export function ConversationList({ sessions, selected, showDirectory, loading, taskID }: { sessions: Session[]; selected?: string | null; showDirectory: boolean; loading?: boolean; taskID?: string }) {
  if (!sessions.length) return <p className="session-browser-empty-list">{loading ? "正在读取对话…" : "没有匹配的对话"}</p>
  return <ul className="session-browser-items">{sessions.map(s => {
    const status = ({starting: "正在连接", running: "运行中", waiting: "待确认", stopping: "正在停止", handoff: "等待交接", failed: "本轮未完成", interrupted: "已停止", unknown: "状态待核实"} as Record<string, string>)[s.chat_status || ""] || ""
    const directory = s.cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || s.cwd
    return <li key={s.id}><button type="button" className="session-browser-item" data-conversation-session={s.id} aria-pressed={selected === s.id} title={`${s.name || "未命名对话"}\n${s.cwd}`}>
      <span className="session-browser-item-heading">{s.pinned && <Pin className="session-browser-pin" aria-label="已固定" />}<span className="session-browser-item-title">{s.name || "未命名对话"}</span></span>
      {s.context ? <span className="session-browser-item-context">
        {s.context.tasks.length > 0 && <span className="session-browser-item-task" title={s.context.tasks.map(t => t.name).join("、")}>任务 · {s.context.tasks.map(t => t.name).join("、")}</span>}
        <span className="session-browser-item-project" title={[s.context.project, s.context.branch].filter(Boolean).join(" · ")}>{s.context.project && <span>项目 · {s.context.project}</span>}{s.context.branch && <span className="session-browser-item-branch"><GitBranch aria-hidden="true" />{s.context.branch}</span>}</span>
      </span> : null}
      {showDirectory ? <span className="session-browser-item-directory" title={s.cwd}>{s.context?.kind ? `${s.context.kind} · ` : ""}{directory}</span> : null}
      <span className="session-browser-item-meta"><span data-session-indicators={s.id} data-state={s.chat_status || (s.unread ? "unread" : "idle")}>{status}{s.unread ? `${status ? " · " : ""}有新消息` : ""}</span><time title={s.updated_at ? new Date(s.updated_at * 1000).toLocaleString("zh-CN", {hour12: false}) : undefined} dateTime={s.updated_at ? new Date(s.updated_at * 1000).toISOString() : undefined}>{s.updated_at ? new Date(s.updated_at * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : ""}</time></span>
      {s.error ? <span className="table-message">{s.error}</span> : null}
    </button>{taskID ? <Button type="button" variant="ghost" size="sm" data-conversation-unlink={s.id} data-task={taskID} aria-label={`取消关联 ${s.name || "未命名对话"}`}>取消关联</Button> : null}</li>
  })}</ul>
}
export function ConversationScopes({ scopes }: { scopes: ConversationScope[] }) {
  return <>{scopes.map(s => <Button key={JSON.stringify([s.kind, s.id, s.cwd])} type="button" variant="ghost" className="session-scope-option h-auto w-full justify-between gap-4 whitespace-normal text-left font-normal" data-conversation-scope={JSON.stringify(s)}><span>{s.name}</span><small>{({ all: "所有目录", task: "任务", project: "项目", directory: "工作目录" } as Record<string, string>)[s.kind]}</small></Button>)}</>
}
