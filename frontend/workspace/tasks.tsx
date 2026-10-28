import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Action, Check, Feedback, Field, GitSyncStatus, NativeSelect, Option, TaskOpenActions, SourceOptions, StatusBadge, TreeStatus, canOpenMember, reusesDirectory } from "./shared"
import type { ProjectOpenTool } from "./shared"
import type { PickerRow, Project, Task } from "./types"
import { memberSignals, taskSignals, taskFilterLabels, type TaskFilter } from "./task-signals"

export function TaskList({ tasks }: { tasks: Task[] }) {
  return <div className="shadcn-scope divide-y divide-border">{tasks.map(q => {
    const {issues,dirty,push,conflicts,checking} = taskSignals(q)
    const status = !q.connected ? "环境未连接" : !q.members.length ? "待关联项目" : [issues ? `${issues} 个目录异常` : "", conflicts ? `${conflicts} 个 Git 操作待处理` : "", dirty ? `${dirty} 个项目有修改` : "", push ? `${push} 个项目待推送` : ""].filter(Boolean).join(" · ") || (checking ? "等待检查工作目录" : "工作目录无修改")
    return <Card key={`${q.environment_id}:${q.id}`} className="gap-0 rounded-none border-0 p-0 shadow-none"><a className="list-row focus-visible:outline-ring" href={`?environment=${encodeURIComponent(q.environment_id)}#/requirements/${encodeURIComponent(q.id)}`} data-action="open-requirement" data-id={q.id} data-environment={q.environment_id} aria-label={`打开任务 ${q.name}`}><div className="row-main"><div className="row-title">{q.name}{q.state === "archived" ? <StatusBadge kind="archived" /> : null}</div><div className="task-list-description">{q.description || "尚未填写任务说明"}</div><div className="row-subtitle">{q.members.length} 个项目 · {q.environment_name}</div></div><div className="row-meta"><span>{status}</span><span className="row-time">{new Date(q.created_at).toLocaleDateString("zh-CN")}</span></div><span className="chevron" aria-hidden="true">›</span></a></Card>
  })}</div>
}

export function TaskActions({ task: q, environment }: { task: Task; environment: string }) {
  return <div className="task-page-actions shadcn-scope">
    <span className="task-environment">{environment}</span>{q.state === "archived" ? <StatusBadge kind="archived" /> : null}
    <Action action="task-conversations" id={q.id}>相关会话</Action>
    <Action action="task-review" id={q.id} disabled={q.state === "creating"}>收尾检查</Action>
    <details className="task-more" data-workspace-detail="task-actions"><summary>更多</summary><div className="task-more-menu">
      <Action action="edit-task" id={q.id} disabled={q.state === "creating"}>编辑任务信息</Action>
      <Action action="archive" id={q.id}>{q.state === "archived" ? "取消归档" : "归档任务"}</Action>
    </div></details>
  </div>
}

export function TaskDetail({ task: q, projects, openTool = "vscode", filter = "all" }: { task: Task; projects: Project[]; environment: string; openTool?: ProjectOpenTool; filter?: TaskFilter }) {
  const pending = (m: Task["members"][number]) => !m.worktree?.status_updated_at && !!projects.find(p => p.id === m.project_id)?.refreshing
  const editable = q.state !== "archived" && q.state !== "creating"
  const signals = taskSignals(q)
  const members = q.members.filter(m => filter === "all" || memberSignals(m)[filter])
  return <Card className="shadcn-scope requirement-workspace gap-5 rounded-none border-0 p-5 shadow-none">
    <section className="task-info" aria-label="任务目标"><div className="task-info-heading"><strong>任务目标</strong><div className="flex items-center gap-3">{q.description ? <button type="button" className="task-info-toggle" data-action="task-info-toggle" aria-controls="taskDescription" aria-expanded="false" hidden>查看全部</button> : null}<Action variant="ghost" action="edit-task" id={q.id} disabled={q.state === "creating"}>编辑</Action></div></div>
      {q.description ? <p id="taskDescription" className="task-description task-description-clamped">{q.description}</p> : <p className="task-description">补充这件事的目标和完成标准，方便之后继续。</p>}
    </section>
    <div className="detail-top"><div className="min-w-0"><h2 className="m-0 flex items-center gap-2 text-base font-semibold">项目工作现场 <StatusBadge kind="neutral">{q.members.length} 个</StatusBadge></h2><p className="task-project-summary">{q.members.filter(m => !!m.worktree?.dirty).length} 个项目有修改 · 分别进入对应目录继续工作</p></div><div className="detail-actions"><Action action="add-requirement-projects" id={q.id} disabled={!editable || q.members.length >= 30}>＋ 添加项目</Action></div></div>
    {!q.members.length ? <div className="task-project-empty">尚未关联项目。添加项目并选择工作目录，即可继续这项工作。</div> : null}
    <div className="task-signal-filters" aria-label="按项目状态筛选">{(Object.keys(taskFilterLabels) as TaskFilter[]).map(kind => <Action key={kind} action="task-project-filter" id={q.id} data-filter={kind} aria-pressed={kind === filter} variant={kind === filter ? "secondary" : "outline"}>{taskFilterLabels[kind]} · {kind === "all" ? q.members.length : signals[kind]}</Action>)}</div>
    {q.members.length > 0 && !members.length ? <p className="task-project-empty">没有符合此状态的项目。<Action action="task-project-filter" id={q.id} data-filter="all">查看全部项目</Action></p> : null}
    <div className="task-project-list" aria-label="任务关联项目">{members.map(m => {
      const t = m.worktree
      const usable = canOpenMember(m)
      const active = usable && editable
      const expected = m.branch || (!reusesDirectory(m) ? q.branch : "")
      const drifted = !!t && !!expected && t.branch !== expected
      const creationRef = m.base_ref?.replace(/^refs\/(heads|remotes)\//, "") || "已有工作目录"
      const baseline = t?.comparison_ref || creationRef
      const difference = t?.compare_available ? [t.ahead ? `领先 ${t.ahead}` : "", t.behind ? `落后 ${t.behind}` : ""].filter(Boolean).join(" · ") || "与基线一致" : "暂不可比较"
      return <article key={m.project_id} className="task-project" data-project-id={m.project_id} aria-label={m.project_name}>
        <div className="task-project-main"><div className="task-project-heading"><strong>{m.project_name}</strong><span className="task-directory-kind">{{project: "项目原目录", worktree: "已有 Worktree", new: "新建 Worktree", existing: "新建 Worktree（已有分支）"}[m.mode || "new"]}</span></div>
          <button type="button" className="task-project-path path" data-action="copy-path" data-path={m.path} title="点击复制完整路径" aria-label={`复制工作目录路径 ${m.path}`}>{m.path}</button>
          <div className="task-project-state">{t ? <Action variant="ghost" action="git-open" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active} aria-label={`查看 ${m.project_name} 的分支`}>⑂ {t.branch || "detached HEAD"}</Action> : <span className="quiet">尚未读取分支</span>}{m.state === "ready" ? <TreeStatus tree={t} pending={pending(m)} compact /> : <StatusBadge kind={m.state} />}<GitSyncStatus tree={t} compact /></div>
        </div>
        <div className="workspace-project-actions task-project-primary-actions">
          <TaskOpenActions project={m.project_id} path={m.path} disabled={!usable} tool={openTool} />
          <Action action="changes-open" id={m.project_id} data-path={m.path} disabled={!usable}>查看改动</Action>
          {openTool !== "terminal" ? <Action action="workspace-terminal" id={m.project_id} data-path={m.path} disabled={!usable}>终端</Action> : null}
          <Action action="git-open" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active}>Git 操作</Action>
          <details className="task-more task-project-more" data-workspace-detail={`menu:${m.project_id}`}><summary aria-label={`${m.project_name} 更多操作`}>更多</summary><div className="task-more-menu">
            <Action action="git-task-pull" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active || !!t?.detached || !!t?.operation || !!t?.dirty}>拉取</Action>
            <Action action="git-task-push" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active || !!t?.detached || !!t?.operation}>推送</Action>
            <Action action="change-task-directory" id={q.id} data-project={m.project_id} disabled={!editable}>更换工作目录</Action>
            <Action action="remove-task-project" id={q.id} data-project={m.project_id} disabled={!editable}>从任务移除</Action>
          </div></details>
        </div>
        {drifted ? <div className="table-message task-project-notice">分支已变化，原记录为 {expected}<Action action="git-task-adopt" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active || !!t?.detached}>采用当前分支</Action></div> : null}
        {m.error || t?.error || !usable ? <div className="table-message task-project-notice" role="status">{m.error || t?.error || (pending(m) ? "正在检查工作目录…" : "工作目录暂不可用")}{["failed","pending","removed"].includes(m.state) ? <Action action="retry" id={q.id} data-project={m.project_id} disabled={!editable}>{m.state === "removed" ? "恢复此目录" : "重试此项目"}</Action> : null}</div> : null}
        {t?.operation === "merge" ? <div className="task-project-notice"><Action action="git-task-ai" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active}>让 AI 完成合并</Action></div> : null}
        <details className="task-project-details" data-workspace-detail={`project:${m.project_id}`}><summary>详细信息</summary><div className="task-project-details-body">
          <div>创建来源 <code>{creationRef}</code>{m.base_commit ? <> · <code>{m.base_commit.slice(0,8)}</code></> : null}</div>
          <div className="task-baseline" title={`创建来源：${creationRef}${m.base_commit ? `；创建提交：${m.base_commit}` : ""}`}>基线 <code>{baseline}</code> · {difference}</div>
          {t?.status_updated_at ? <div>上次检查 <time data-status-path={t.path} dateTime={t.status_updated_at}>{new Date(t.status_updated_at).toLocaleTimeString("zh-CN", { hour12: false })}</time></div> : null}
        </div></details>
      </article>
    })}</div>
  </Card>
}

export function ProjectPicker({ rows }: { rows: PickerRow[] }) {
  if (!rows.length) return <p className="dialog-description">暂无可选择的项目，可先登记新项目。</p>
  return <>{rows.map(({ project: p, checked, choice, overview: v, trees, prefix }) => <Card key={p.id} className="task-project-option gap-0 rounded-lg p-0 shadow-none"><div className="p-3"><Check id={`${prefix}-selected`} name="project_ids" value={p.id} defaultChecked={!p.error && checked} disabled={!!p.error} label={<span className="flex flex-wrap items-center gap-2"><span>{p.name}<small className="block break-all text-xs font-normal text-muted-foreground">{p.path}</small></span>{p.error ? <StatusBadge kind="failed">不可用</StatusBadge> : null}</span>} /></div>{checked ? <div className="task-project-choice" data-project-id={p.id}>
    <Field id={`${prefix}-mode`} label="工作目录"><NativeSelect id={`${prefix}-mode`} data-choice="mode" defaultValue={choice.mode}><Option value="project">使用项目原目录</Option><Option value="worktree">使用已有 Worktree</Option><Option value="new">新建分支和 Worktree</Option><Option value="existing">使用已有分支创建 Worktree</Option></NativeSelect></Field>
    {choice.mode === "existing" ? <><Field id={`${prefix}-existingBranch`} label="已有本地分支"><NativeSelect id={`${prefix}-existingBranch`} data-choice="existingBranch" required disabled={!v} defaultValue={choice.existingBranch || ""}><Option value="">{v ? "请选择未被占用的本地分支" : "正在读取分支…"}</Option>{v?.branches.filter(b => b.kind === "local").map(b => <Option key={b.ref} value={b.name} disabled={!!b.worktrees.length}>{b.name}{b.worktrees.length ? "（已被 Worktree 占用）" : ""}</Option>)}</NativeSelect></Field><small className="text-muted-foreground">在任务工作区创建新目录，检出所选分支；已被占用的分支可通过“使用已有 Worktree”关联。</small></> : null}
    {choice.mode === "project" ? <small className="text-muted-foreground">直接使用当前目录和分支，保留现有修改。</small> : choice.mode === "worktree" ? <><Field id={`${prefix}-path`} label="已有 Worktree"><NativeSelect id={`${prefix}-path`} data-choice="path" required defaultValue={choice.path}><Option value="">请选择已有工作目录</Option>{trees.map(t => <Option key={t.path} value={t.path}>{t.branch || "detached"} · {t.path}</Option>)}</NativeSelect></Field><small className="text-muted-foreground">直接关联所选目录，保留现有分支和修改。</small></> : choice.mode === "new" ? <><div className="form-grid"><Field id={`${prefix}-branch`} label="新分支名称"><Input id={`${prefix}-branch`} data-choice="branch" defaultValue={choice.branch} maxLength={160} required /></Field><Field id={`${prefix}-source`} label="来源分支"><NativeSelect id={`${prefix}-source`} data-choice="source" required disabled={!v} defaultValue={choice.source}>{v ? <SourceOptions overview={v} /> : <Option value="">正在读取分支…</Option>}</NativeSelect></Field></div><small className="text-muted-foreground">默认优先使用本地 master 或 main，也可选择其他来源；不会自动拉取远端。</small></> : null}
    {choice.error ? <Feedback variant="destructive">{choice.error} <Button type="button" variant="outline" size="sm" data-choice-retry={p.id}>重试读取</Button></Feedback> : null}
  </div> : null}</Card>)}</>
}
