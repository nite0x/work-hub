import { Plus, Search, ArrowLeft, X, ChevronDown, Pin, PinOff, GitBranch, SlidersHorizontal, RotateCw, Check, Folder, Ellipsis, MessageSquare, CircleAlert, Files, Maximize2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "./shared"
import { SessionHistoryPanel, type Session } from "./sessions"

export interface ConversationScope { kind: string; id?: string; name: string; cwd?: string; environment?: string }
export function SessionBrowser() {
  return <><div className="session-browser shadcn-scope" id="sessionBrowser" data-pane="list" hidden>
    <div className="session-browser-body">
      <aside className="session-browser-list" id="sessionBrowserListPane" aria-label="对话列表"><div className="session-browser-list-tools">
        <div className="session-browser-list-heading"><strong>对话</strong>
          <div className="session-browser-heading-actions">
            <Button type="button" size="sm" className="h-[30px] [.has-association_&]:rounded-r-none" id="newBrowserSession" data-conversation-action="new" aria-label="新建对话"><Plus aria-hidden="true" /><span>新建对话</span></Button>
            <details id="sessionActionPicker" className="session-action-picker" hidden><summary aria-label="更多对话操作" title="更多对话操作"><ChevronDown aria-hidden="true" /></summary>
              <div id="taskConversationTools" className="session-action-menu" role="group" aria-label="对话操作" hidden>
                <Button type="button" variant="ghost" size="sm" id="linkTaskConversation" data-session-action="picker" aria-label="关联已有对话">关联已有对话</Button>
              </div>
            </details>
          </div>
        </div>
    <div className="session-browser-scope" id="sessionBrowserScopeBar">
      <details className="session-scope-picker" id="sessionScopePicker"><summary aria-label="切换对话范围"><Folder aria-hidden="true" /><span id="sessionScopeLabel">全部对话</span><ChevronDown aria-hidden="true" /></summary>
        <div className="session-scope-menu" popover="manual"><Label htmlFor="sessionScopeSearch">切换对话范围</Label><Input id="sessionScopeSearch" type="search" placeholder="搜索任务、项目或目录" /><Button type="button" variant="ghost" size="sm" data-conversation-action="all" id="sessionScopeAll" hidden>查看全部对话</Button><div id="sessionScopeOptions" /></div>
      </details>
      <Button type="button" variant="ghost" size="sm" id="pinConversationDirectory" data-conversation-action="pin-directory" hidden><Pin aria-hidden="true" /><span>固定此目录</span></Button>
    </div>
        <p id="sessionBrowserContext" className="sr-only" />
        <div className="session-browser-search-row">
          <div className="session-browser-search"><Search aria-hidden="true" /><label className="sr-only" htmlFor="sessionBrowserSearch">搜索对话、项目或分支</label><Input id="sessionBrowserSearch" className="px-8" type="search" placeholder="搜索对话、项目或分支" autoComplete="off" /><button type="button" id="sessionSearchClear" data-conversation-action="clear-search" aria-label="清除搜索" title="清除搜索" hidden><X aria-hidden="true" /></button></div>
          <details id="sessionFilterPicker" className="session-filter-picker"><summary aria-label="筛选对话" title="筛选环境、目录与归档"><SlidersHorizontal aria-hidden="true" /><span id="sessionFilterCount" hidden /></summary><div className="session-filter-menu" role="group" aria-label="对话筛选条件">
            <div className="session-filter-heading"><strong>筛选对话</strong><button type="button" data-conversation-action="close-filters" aria-label="关闭筛选"><X aria-hidden="true" /></button></div>
            <label id="sessionEnvironmentField" className="session-environment-label" hidden><span>执行环境</span><NativeSelect id="sessionsEnvironment" aria-label="筛选对话环境"><option value="">全部环境</option></NativeSelect></label>
            <label id="sessionDirectoryField"><span>工作目录</span><NativeSelect id="sessionDirectoryFilter" aria-label="筛选工作目录" /></label>
            <label className="session-browser-archive"><input id="sessionBrowserArchived" type="checkbox" aria-label="查看已归档对话" /><span>仅查看已归档对话</span></label>
            <p className="session-filter-hint">筛选仅影响列表，运行中的对话会继续。</p>
          </div></details>
        </div>
        <div id="sessionStatusFilters" className="session-status-filters" role="group" aria-label="按对话状态筛选">{[["all", "全部"], ["running", "进行中"], ["waiting", "待确认"], ["unread", "未读"]].map(([value, label]) => <button key={value} type="button" data-conversation-status={value} aria-pressed={value === "all"}>{label}<span data-status-count={value} hidden /></button>)}</div>
        <p id="sessionActiveFilterLabel" className="session-active-filter-label" hidden />
        <div className="session-browser-list-caption"><span id="sessionBrowserCount" role="status" aria-live="polite" /><div className="session-browser-caption-actions"><Button type="button" variant="ghost" size="sm" id="sessionClearFilters" data-conversation-action="clear-filters" hidden>清除筛选</Button><Button type="button" variant="ghost" size="icon" data-conversation-action="refresh" title="刷新对话列表" aria-label="刷新对话列表"><RotateCw aria-hidden="true" /></Button></div></div>
      </div><div id="sessionBrowserError" role="alert" hidden /><div id="sessionBrowserList" aria-label="对话结果" /></aside>
      <div id="sessionBrowserResize" className="session-browser-resize" role="separator" tabIndex={0} aria-label="调整对话列表宽度" aria-orientation="vertical" aria-controls="sessionBrowserListPane" aria-valuemin={220} aria-valuemax={520} aria-valuenow={280} />
      <section className="session-browser-detail" aria-label="对话详情">
        <div className="session-reading-toolbar"><div className="session-browser-mobile-back"><Button type="button" size="sm" variant="ghost" data-conversation-action="back"><ArrowLeft aria-hidden="true" />对话列表</Button></div></div>
        <div className="session-reading-layout" id="sessionReadingLayout"><div className="session-reading-chat">
        <div id="sessionBrowserNewDirectoryField" className="session-browser-new-directory" hidden><Label htmlFor="sessionBrowserNewDirectory">工作目录</Label><NativeSelect id="sessionBrowserNewDirectory" /></div>
        <fieldset id="sessionBrowserAdditionalField" className="session-browser-new-directory" hidden><legend>本次对话可访问的其他项目目录</legend><div id="sessionBrowserAdditionalDirectories" /></fieldset>
        <div id="sessionBrowserEmpty" className="session-browser-empty" role="status">选择一个对话，或新建对话开始工作。</div>
        <aside id="sessionHistoryPanel" className="session-history-panel shadcn-scope" role="region" aria-labelledby="sessionHistoryTitle" hidden><SessionHistoryPanel /></aside>
        </div><div id="conversationFilesResize" className="reading-splitter conversation-files-resize" role="separator" tabIndex={0} aria-label="调整对话与文件区域大小" aria-orientation="vertical" aria-controls="conversationFilesDock" hidden /><div id="conversationFilesDock" className="conversation-files-dock" hidden><aside id="conversationFilesPane" className="conversation-files-pane" aria-labelledby="conversationFilesTitle">
          <header className="conversation-files-heading"><h3 id="conversationFilesTitle"><Files aria-hidden="true" />文件与改动</h3><div><Button type="button" size="sm" variant="ghost" id="expandConversationFiles" aria-label="全屏查看文件" aria-pressed={false}><Maximize2 aria-hidden="true" />全屏</Button><Button type="button" size="icon-sm" variant="ghost" id="closeConversationFiles" aria-label="关闭文件面板"><X aria-hidden="true" /></Button></div></header>
          <div id="conversationFilesMount" />
        </aside></div></div>
      </section>
    </div>
  </div><dialog id="conversationFilesDialog" className="conversation-files-dialog shadcn-scope" aria-labelledby="conversationFilesTitle" /></>
}
interface ShortcutTask { environment?: string; id: string; name: string; projects: string; pinned: boolean; archived: boolean }
interface ShortcutDirectory { key?: string; environment?: string; cwd: string; name: string; parent: string; pinned: boolean }
export function ConversationShortcuts({ tasks, directories, pinnedDirectories, selected, selectedDirectory, search, archived, environment }: {
  tasks: ShortcutTask[]; directories: ShortcutDirectory[]; pinnedDirectories: ShortcutDirectory[];
  selected?: string | null; selectedDirectory?: string | null; search: string; archived: boolean; environment: string;
}) {
  const pinned = tasks.filter(task => task.pinned && !task.archived)
  const query = search.trim().toLowerCase()
  const matches = (values: string[]) => values.join(" ").toLowerCase().includes(query)
  const visibleTasks = tasks.filter(task => (archived || !task.archived) && matches([task.name, task.projects, task.environment || ""]))
  const visibleDirectories = directories.filter(directory => matches([directory.cwd, directory.name, directory.parent]))
  return <section aria-labelledby="shortcutPinnedTitle">
    <div className="task-shortcuts-heading"><h2 id="shortcutPinnedTitle"><Pin aria-hidden="true" />固定入口</h2>
      <details id="taskShortcutPicker" className="task-shortcut-picker"><summary aria-label="管理固定入口" title="固定任务或目录"><Plus aria-hidden="true" /></summary>
        <div className="task-shortcut-options" id="shortcutPickerPanel" popover="manual">
          <Label htmlFor="shortcutSearch">搜索任务或目录</Label><Input id="shortcutSearch" type="search" placeholder="任务名、项目名或路径" defaultValue={search} />
          <p className="shortcut-picker-caption">{environment} · {tasks.filter(task => !task.archived).length} 个未归档任务 · 已固定 {pinned.length} 个</p>
          <label className="shortcut-archive-toggle"><input id="shortcutArchived" type="checkbox" defaultChecked={archived} />显示归档任务</label>
          <div className="shortcut-picker-results">
            <h3>任务</h3><div role="group" aria-label="固定任务">{visibleTasks.length ? visibleTasks.map(task => <button key={task.id} type="button" data-task-shortcut-pin={task.id} aria-pressed={task.pinned} disabled={task.archived && !task.pinned} title={task.archived ? "取消归档后可固定" : task.projects}>
              <span><span className="shortcut-option-title">{task.name}{task.archived && <small> · 已归档</small>}</span><small>{task.projects}{task.environment && ` · ${task.environment}`}</small></span><span className="shortcut-option-state">{task.pinned ? <><Check aria-hidden="true" />已固定</> : "固定"}</span>
            </button>) : <p className="conversation-shortcuts-empty">{query ? "没有匹配的任务" : "暂无任务"}</p>}</div>
            <h3>目录</h3><div role="group" aria-label="固定目录">{visibleDirectories.length ? visibleDirectories.map(directory => <button key={directory.key || directory.cwd} type="button" data-directory-shortcut-pin={directory.key || directory.cwd} aria-pressed={directory.pinned} title={directory.cwd}>
              <span><span className="shortcut-option-title"><Folder aria-hidden="true" />{directory.name}</span><small>{directory.parent}</small></span><span className="shortcut-option-state">{directory.pinned ? <><Check aria-hidden="true" />已固定</> : "固定"}</span>
            </button>) : <p className="conversation-shortcuts-empty">{query ? "没有匹配的目录" : "暂无已登记的工作目录"}</p>}</div>
          </div>
        </div>
      </details>
    </div>
    {pinned.length ? <ul>{pinned.map(task => <li key={task.id} className="conversation-shortcut-row">
      <button type="button" className="conversation-shortcut-open" data-task-shortcut={task.id} aria-current={selected === task.id ? "true" : undefined} title={`${task.name}\n${task.projects}\n打开任务对话`}>
        <span className="conversation-shortcut-title">{task.name}<small className="shortcut-entry-kind">任务对话</small></span><span className="conversation-shortcut-context">{task.projects || "任务对话"}{task.environment && ` · ${task.environment}`}</span>
      </button>
      <button type="button" className="conversation-shortcut-pin" data-task-shortcut-pin={task.id} aria-label={`取消固定任务：${task.name}`} title="取消固定任务"><PinOff aria-hidden="true" /></button>
    </li>)}</ul> : <p className="conversation-shortcuts-empty">点击 + 固定任务或目录</p>}
    {pinnedDirectories.length > 0 && <><h3 className="shortcut-directory-heading">目录</h3><ul>{pinnedDirectories.map(directory => <li key={directory.key || directory.cwd} className="conversation-shortcut-row">
      <button type="button" className="conversation-shortcut-open" data-directory-shortcut={directory.key || directory.cwd} aria-current={selectedDirectory === (directory.key || directory.cwd) ? "true" : undefined} title={directory.cwd}><span className="conversation-shortcut-title"><Folder aria-hidden="true" />{directory.name}</span><span className="conversation-shortcut-context">{directory.parent}</span></button>
      <button type="button" className="conversation-shortcut-pin" data-directory-shortcut-pin={directory.key || directory.cwd} aria-label={`取消固定目录：${directory.cwd}`} title="取消固定目录"><PinOff aria-hidden="true" /></button>
    </li>)}</ul></>}
  </section>
}
export function ConversationList({ sessions, selected, showDirectory, showContext = true, loading, taskID, filtered, error, canCreate = true, now = Date.now() }: { sessions: Session[]; selected?: string | null; showDirectory: boolean; showContext?: boolean; loading?: boolean; taskID?: string; filtered?: boolean; error?: boolean; canCreate?: boolean; now?: number }) {
  if (!sessions.length) return <div className="session-browser-empty-list" role="status">
    {loading ? <RotateCw className="session-list-loading" aria-hidden="true" /> : error ? <CircleAlert aria-hidden="true" /> : filtered ? <Search aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}
    <strong>{loading ? "正在读取对话…" : error ? "暂时无法读取对话" : filtered ? "没有匹配的对话" : "还没有对话"}</strong>
    <p>{loading ? "正在同步各执行环境的记录" : error ? "检查执行环境连接后重试。" : filtered ? "试试其他关键词，或清除筛选条件。" : canCreate ? "新建对话，从当前工作现场开始。" : "当前范围暂无对话，可切换范围查看。"}</p>
    {!loading && (error || filtered || canCreate) && <Button type="button" variant="outline" size="sm" data-conversation-action={error ? "refresh" : filtered ? "reset-list" : "new"}>{error ? "重新加载" : filtered ? "清除搜索与筛选" : "新建对话"}</Button>}
  </div>
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const week = new Date(today)
  week.setDate(week.getDate() - 6)
  const group = (s: Session) => s.pinned ? "已固定" : !s.updated_at ? "更早" : s.updated_at * 1000 >= +today ? "今天" : s.updated_at * 1000 >= +yesterday ? "昨天" : s.updated_at * 1000 >= +week ? "近 7 天" : "更早"
  const groups = ["已固定", "今天", "昨天", "近 7 天", "更早"].map(label => ({label, items: sessions.filter(s => group(s) === label)})).filter(g => g.items.length)
  return <div className="session-browser-groups">{groups.map(g => <section className="session-browser-group" key={g.label} aria-label={g.label}>
    <h3 className="session-browser-group-heading">{g.label === "已固定" && <Pin aria-hidden="true" />}{g.label}<span>{g.items.length}</span></h3>
    <ul className="session-browser-items">{g.items.map(s => {
    const status = ({starting: "正在连接", running: "运行中", waiting: "待确认", stopping: "正在停止", handoff: "等待交接", failed: "本轮未完成", interrupted: "已停止", unknown: "状态待核实"} as Record<string, string>)[s.chat_status || ""] || ""
    const directory = s.cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || s.cwd
    const key = s.browser_key || s.id
    const date = s.updated_at ? new Date(s.updated_at * 1000) : null
    const dateLabel = date ? date >= today ? date.toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit", hour12: false}) : date >= yesterday ? "昨天" : date.toLocaleDateString("zh-CN", {year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined, month: "numeric", day: "numeric"}) : ""
    return <li key={key} className={taskID ? "has-session-menu" : undefined}><button type="button" className="session-browser-item" data-conversation-session={key} data-environment={s.environment_id} aria-pressed={selected === key} title={`${s.name || "未命名对话"}\n${s.environment_name || ""}\n${s.cwd}${s.context?.branch ? `\n${s.context.branch}` : ""}`}>
      <span className="session-browser-item-heading"><span className="session-browser-item-title">{s.name || "未命名对话"}</span>{s.unread && <span className="session-browser-unread-dot" aria-label="有新消息" />}</span>
      {showContext && s.context?.project ? <span className="session-browser-item-context">
        <span className="session-browser-item-project" title={`${s.cwd}${s.context.branch ? `\n${s.context.branch}` : ""}`}><span>{s.context.project}</span>{s.context.branch && <span className="session-browser-item-branch"><GitBranch aria-hidden="true" /><span>{s.context.branch}</span></span>}</span>
      </span> : null}
      {showDirectory && !s.context?.project ? <span className="session-browser-item-directory" title={s.cwd}>{directory}</span> : null}
      <span className="session-browser-item-meta"><span className="session-browser-item-signals">{s.environment_name && <span className="session-browser-environment" title={s.environment_name}>{s.environment_name}</span>}<span data-session-indicators={s.id} data-environment={s.environment_id} data-state={s.chat_status || (s.unread ? "unread" : "idle")} hidden={!status && !s.unread}>{status || (s.unread ? "有新消息" : "")}</span></span><time title={date?.toLocaleString("zh-CN", {hour12: false})} dateTime={date?.toISOString()}>{dateLabel}</time></span>
      {s.error ? <span className="table-message">{s.error}</span> : null}
    </button>{taskID ? <details className="session-item-menu" data-session-menu={key}><summary aria-label={`对话操作：${s.name || "未命名对话"}`} title="对话操作"><Ellipsis aria-hidden="true" /></summary><div><Button type="button" variant="ghost" size="sm" data-conversation-unlink={s.id} data-environment={s.environment_id} data-task={taskID} aria-label={`取消关联 ${s.name || "未命名对话"}`}>取消关联</Button></div></details> : null}</li>
  })}</ul></section>)}</div>
}
export function ConversationScopes({ scopes }: { scopes: ConversationScope[] }) {
  return <>{scopes.map(s => <Button key={JSON.stringify([s.environment, s.kind, s.id, s.cwd])} type="button" variant="ghost" className="session-scope-option h-auto w-full justify-between gap-4 whitespace-normal text-left font-normal" data-conversation-scope={JSON.stringify(s)}><span>{s.name}</span><small>{({ all: "所有目录", task: "任务", project: "项目", directory: "工作目录" } as Record<string, string>)[s.kind]}</small></Button>)}</>
}
