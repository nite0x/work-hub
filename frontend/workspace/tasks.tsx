import { Card } from "@/components/ui/card"
import { CircleAlert, ClipboardCheck, Copy, GitBranch, MoreHorizontal, Plus, SlidersHorizontal, Terminal } from "lucide-react"
import { Action, GitSyncStatus, TaskOpenActions, StatusBadge, TreeStatus, canOpenMember, reusesDirectory } from "./shared"
import type { ProjectOpenTool } from "./shared"
import type { Project, Task } from "./types"
import { memberSignals, taskSignals, taskFilterLabels, type TaskFilter } from "./task-signals"
import { compactWorkspacePath } from "./workspace-path"

export function TaskList({ tasks }: { tasks: Task[] }) {
  return <div className="task-list shadcn-scope divide-y divide-border">{tasks.map(q => {
    const {issues,dirty,push,conflicts,checking} = taskSignals(q)
    const status = !q.connected ? "环境未连接" : !q.members.length ? "待关联项目" : [issues ? `${issues} 个目录异常` : "", conflicts ? `${conflicts} 个 Git 操作待处理` : "", dirty ? `${dirty} 个项目有改动` : "", push ? `${push} 个项目待推送` : ""].filter(Boolean).join(" · ") || (checking ? "等待检查工作目录" : "无未提交改动")
    return <Card key={`${q.environment_id}:${q.id}`} className="gap-0 rounded-none border-0 p-0 shadow-none"><a className="list-row focus-visible:outline-ring" href={`?environment=${encodeURIComponent(q.environment_id)}#/requirements/${encodeURIComponent(q.id)}`} data-action="open-requirement" data-id={q.id} data-environment={q.environment_id} aria-label={`打开任务 ${q.name}`}><div className="row-main"><div className="row-title">{q.name}{q.state === "archived" ? <StatusBadge kind="archived" /> : null}</div>{q.description?.trim() && q.description.trim() !== q.name.trim() ? <div className="task-list-description">{q.description}</div> : null}<div className="row-subtitle">{q.members.length} 个项目 · {q.environment_name}</div></div><div className="row-meta"><span className={`task-list-status${issues || conflicts || !q.connected ? " has-issues" : dirty || push ? " has-work" : ""}`}>{status}</span><time className="row-time" dateTime={q.created_at} title={`创建时间：${new Date(q.created_at).toLocaleString("zh-CN")}`}>创建于 {new Date(q.created_at).toLocaleDateString("zh-CN")}</time></div><span className="chevron" aria-hidden="true">›</span></a></Card>
  })}</div>
}

export function TaskActions({ task: q, environment }: { task: Task; environment: string }) {
  return <div className="task-page-actions shadcn-scope">
    <span className="task-environment">{environment}</span><StatusBadge kind={q.state === "archived" ? "archived" : "neutral"}>{q.state === "archived" ? "已归档" : "未归档"}</StatusBadge>
    <Action action="task-conversations" id={q.id}>查看相关会话</Action>
    <details className="task-more" data-workspace-detail="task-actions"><summary>更多</summary><div className="task-more-menu">
      <Action action="edit-task" id={q.id} disabled={q.state === "creating"}>编辑任务信息</Action>
      <Action action="archive" id={q.id}>{q.state === "archived" ? "取消归档" : "归档任务"}</Action>
    </div></details>
  </div>
}

export function TaskDetail({ task: q, projects, openTool = "vscode", filter = "all" }: { task: Task; projects: Project[]; environment: string; openTool?: ProjectOpenTool; filter?: TaskFilter }) {
  const pending = (m: Task["members"][number]) => m.state === "ready" && !m.worktree?.status_updated_at && (!m.worktree || !!projects.find(p => p.id === m.project_id)?.refreshing)
  const editable = q.state !== "archived" && q.state !== "creating"
  const signals = taskSignals(q)
  const available = q.members.filter(canOpenMember).length
  const summary = !q.members.length ? "关联项目后，在这里查看分支、改动和目录状态。" : [
    `${q.members.length} 个关联项目`, `${available} 个目录可打开`,
    signals.issues ? `${signals.issues} 个目录需要处理` : "",
    signals.checking ? `${signals.checking} 个目录正在检查` : "",
  ].filter(Boolean).join(" · ")
  const members = q.members.filter(m => filter === "all" || memberSignals(m)[filter])
  const filterKinds = Object.keys(taskFilterLabels) as TaskFilter[]
  const quickFilters = filterKinds.filter(kind => kind === "all" || kind === filter || signals[kind] > 0)
  const otherFilters = filterKinds.filter(kind => !quickFilters.includes(kind))
  const filterButton = (kind: TaskFilter) => <Action key={kind} action="task-project-filter" id={q.id} data-filter={kind} aria-pressed={kind === filter} className={kind === "issues" && signals.issues ? "task-issue-filter" : undefined} variant={kind === filter ? "secondary" : "outline"}>{kind === "issues" && signals.issues ? <CircleAlert aria-hidden="true" /> : null}{taskFilterLabels[kind]} · {kind === "all" ? q.members.length : signals[kind]}</Action>
  return <Card className="shadcn-scope requirement-workspace gap-4 rounded-none border-0 p-5 shadow-none">
    <section className={`task-info${q.description?.trim() ? "" : " task-info-empty"}`} aria-label="任务目标"><div className="task-info-heading"><strong>任务目标</strong>{q.description?.trim() ? <div className="flex items-center gap-3"><button type="button" className="task-info-toggle" data-action="task-info-toggle" aria-controls="taskDescription" aria-expanded="false" hidden>查看全部</button><Action variant="ghost" action="edit-task" id={q.id} disabled={q.state === "creating"}>编辑目标</Action></div> : null}</div>
      {q.description?.trim() ? <p id="taskDescription" className="task-description task-description-clamped">{q.description}</p> : <div className="task-goal-prompt"><Action variant="ghost" action="edit-task" id={q.id} disabled={q.state === "creating"}><Plus aria-hidden="true" />添加任务目标</Action><span>记录目标和完成条件，方便下次继续。</span></div>}
    </section>
    <div className="task-directory-overview"><div className="detail-top"><div className="min-w-0"><h2 className="m-0 text-base font-semibold">关联项目与工作目录</h2><p className="task-project-summary">{summary}</p></div><div className="detail-actions"><Action action="add-requirement-projects" id={q.id} disabled={!editable || q.members.length >= 30}><Plus aria-hidden="true" />添加项目</Action></div></div>
      {q.members.length ? <div className="task-signal-filters" aria-label="按项目状态筛选">{quickFilters.map(filterButton)}{otherFilters.length > 0 ? <details className="task-more task-filter-more"><summary aria-label="更多项目状态筛选"><SlidersHorizontal aria-hidden="true" />更多筛选</summary><div className="task-more-menu">{otherFilters.map(filterButton)}</div></details> : null}</div> : null}
    </div>
    {!q.members.length ? <div className="task-project-empty">尚未关联项目。添加项目并选择工作目录，即可继续这项工作。</div> : null}
    {q.members.length > 0 && !members.length ? <p className="task-project-empty">没有符合此状态的项目。<Action action="task-project-filter" id={q.id} data-filter="all">查看全部项目</Action></p> : null}
    <div className="task-project-list" aria-label="任务关联项目">{members.map(m => {
      const t = m.worktree
      const usable = canOpenMember(m)
      const active = usable && editable
      const issue = memberSignals(m).issues
      const retryable = ["failed", "pending", "removed"].includes(m.state)
      const notice = m.error || t?.error || (t?.missing ? "工作目录已丢失。请选择其他目录继续工作。" : t?.prunable ? "Worktree 登记需要修复，可先更换工作目录。" : t?.bare ? "此目录是裸仓库，请选择可工作的目录。" : m.state === "removed" ? "此工作目录已清理，可以恢复或更换目录。" : m.state === "failed" ? "工作目录准备失败，请重试或更换目录。" : m.state === "pending" ? "工作目录尚未创建。" : m.state === "creating" ? "正在准备工作目录…" : !usable ? "正在检查工作目录…" : "")
      const expected = m.branch || (!reusesDirectory(m) ? q.branch : "")
      const drifted = !!t && !!expected && t.branch !== expected
      const creationRef = m.base_ref?.replace(/^refs\/(heads|remotes)\//, "") || "已有工作目录"
      const baseline = t?.comparison_ref || creationRef
      const difference = t?.compare_available ? [t.ahead ? `领先 ${t.ahead}` : "", t.behind ? `落后 ${t.behind}` : ""].filter(Boolean).join(" · ") || "与基线一致" : "暂不可比较"
      return <article key={m.project_id} className={`task-project${issue ? " task-project-has-issue" : ""}`} data-project-id={m.project_id} aria-label={m.project_name}>
        <div className="task-project-main"><div className="task-project-heading"><strong>{m.project_name}</strong><span className="task-directory-kind">{{project: "项目原目录", worktree: "已有 Worktree", new: "新建 Worktree", existing: "新建 Worktree（已有分支）"}[m.mode || "new"]}</span></div>
          <div className="task-project-state">{t ? <Action className="task-current-branch" variant="ghost" action="git-open" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active} aria-label={`查看 ${m.project_name} 的分支`} title={t.branch || "detached HEAD"}><GitBranch aria-hidden="true" /><span>{t.branch || "detached HEAD"}</span></Action> : <span className="quiet">尚未读取分支</span>}{m.state === "ready" ? m.error ? <StatusBadge kind="failed">目录不可用</StatusBadge> : <TreeStatus tree={t} pending={pending(m)} compact /> : <StatusBadge kind={m.state} />}{m.state === "ready" && !m.error ? <GitSyncStatus tree={t} compact /> : null}</div>
          <button type="button" className="task-project-path path" data-action="copy-path" data-path={m.path} title={`${m.path}\n点击复制完整路径`} aria-label={`复制工作目录路径 ${m.path}`}>{compactWorkspacePath(m.path)}<Copy aria-hidden="true" /></button>
        </div>
        <div className="workspace-project-actions task-project-primary-actions">
          <TaskOpenActions project={m.project_id} path={m.path} disabled={!usable} tool={openTool} primary />
          <Action action="changes-open" id={m.project_id} data-path={m.path} disabled={!usable}>查看改动</Action>
          <details className="task-more task-project-more" data-workspace-detail={`menu:${m.project_id}`}><summary aria-label={`${m.project_name} 更多操作`}><MoreHorizontal aria-hidden="true" /></summary><div className="task-more-menu">
            <Action action="workspace-terminal" id={m.project_id} data-path={m.path} disabled={!usable}><Terminal aria-hidden="true" />打开终端</Action>
            <Action action="git-open" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active}>Git 操作</Action>
            <hr />
            <Action action="git-task-pull" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active || !!t?.detached || !!t?.operation || !!t?.dirty}>拉取</Action>
            <Action action="git-task-push" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active || !!t?.detached || !!t?.operation}>推送</Action>
            <hr />
            <Action action="change-task-directory" id={q.id} data-project={m.project_id} disabled={!editable}>更换工作目录</Action>
            <Action action="remove-task-project" id={q.id} data-project={m.project_id} disabled={!editable} className="text-destructive">从任务移除</Action>
          </div></details>
        </div>
        {drifted ? <div className="table-message task-project-notice">分支已变化，原记录为 {expected}<Action action="git-task-adopt" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active || !!t?.detached}>采用当前分支</Action></div> : null}
        {notice ? <div className={`task-project-notice task-directory-notice${issue ? " has-issue" : ""}`} role="status">{issue ? <CircleAlert aria-hidden="true" /> : null}<span>{notice}</span>{issue ? <div className="task-recovery-actions">{retryable ? <Action action="retry" id={q.id} data-project={m.project_id} disabled={!editable}>{m.state === "removed" ? "恢复此目录" : "重试此项目"}</Action> : null}<Action action="change-task-directory" id={q.id} data-project={m.project_id} disabled={!editable || !projects.some(p => p.id === m.project_id)}>更换工作目录</Action>{!editable ? <span className="task-recovery-help">{q.state === "archived" ? "取消归档后可处理目录。" : "任务创建完成后可处理目录。"}</span> : null}</div> : null}</div> : null}
        {t?.operation === "merge" ? <div className="task-project-notice"><Action action="git-task-ai" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active}>让 AI 完成合并</Action></div> : null}
        <details className="task-project-details" data-workspace-detail={`project:${m.project_id}`}><summary>详细信息</summary><div className="task-project-details-body">
          <div className="task-full-path">工作目录 <code>{m.path}</code></div>
          <div>创建来源 <code>{creationRef}</code>{m.base_commit ? <> · <code>{m.base_commit.slice(0,8)}</code></> : null}</div>
          <div className="task-baseline" title={`创建来源：${creationRef}${m.base_commit ? `；创建提交：${m.base_commit}` : ""}`}>基线 <code>{baseline}</code> · {difference}</div>
          {t?.status_updated_at ? <div>上次检查 <time data-status-path={t.path} dateTime={t.status_updated_at}>{new Date(t.status_updated_at).toLocaleTimeString("zh-CN", { hour12: false })}</time></div> : null}
        </div></details>
      </article>
    })}</div>
    <section className="task-review-entry" aria-label="收尾检查"><div><h2><ClipboardCheck aria-hidden="true" />收尾检查</h2><p>检查未提交改动、未推送提交和目录占用，确认哪些 Worktree 可以清理。</p></div><Action action="task-review" id={q.id} disabled={q.state === "creating"} aria-label="开始收尾检查">开始检查</Action></section>
  </Card>
}
