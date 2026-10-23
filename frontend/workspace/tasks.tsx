import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ChevronDown } from "lucide-react"
import { Action, Check, Feedback, Field, GitSyncStatus, NativeSelect, Option, TaskOpenActions, SourceOptions, StatusBadge, TreeStatus, branchSummary, canOpenMember, expectedBranch, reusesDirectory } from "./shared"
import type { ProjectOpenTool } from "./shared"
import type { PickerRow, Project, Task } from "./types"

export function TaskList({ tasks }: { tasks: Task[] }) {
  return <div className="shadcn-scope divide-y divide-border">{tasks.map(q => {
    const primary = q.members.find(m => m.project_id === q.primary_project_id)
    return <Card key={`${q.environment_id}:${q.id}`} className="gap-0 rounded-none border-0 p-0 shadow-none"><a className="list-row focus-visible:outline-ring" href={`?environment=${encodeURIComponent(q.environment_id)}#/requirements/${encodeURIComponent(q.id)}`} data-action="open-requirement" data-id={q.id} data-environment={q.environment_id} aria-label={`打开任务 ${q.name}`}><div className="row-main"><div className="row-title">{q.name} <StatusBadge kind={q.state} /><StatusBadge kind="neutral">{q.environment_name}</StatusBadge></div><div className="row-subtitle"><span>{q.members.length} 个项目 · 主项目 {primary?.project_name}</span><code>⑂ {branchSummary(q)}</code></div></div><div className="row-meta"><span>{!q.connected ? "环境未连接" : q.members.some(m => !m.worktree?.status_updated_at) ? "等待检查工作目录" : `${q.members.filter(m => (m.worktree?.dirty || 0) > 0).length} 个项目有修改`}</span><span className="row-time">{new Date(q.created_at).toLocaleDateString("zh-CN")}</span></div><span className="chevron" aria-hidden="true">›</span></a></Card>
  })}</div>
}

export function TaskActions({ task: q, environment }: { task: Task; environment: string }) {
  const ready = q.state === "ready" && q.members.every(m => canOpenMember(m) && (reusesDirectory(m) || (!m.worktree?.detached && m.worktree?.branch === expectedBranch(m, q))))
  return <div className="task-page-actions shadcn-scope">
    <StatusBadge kind="neutral">{environment}</StatusBadge><StatusBadge kind={q.state === "ready" && !ready ? "warning" : q.state}>{q.state === "ready" && !ready ? "工作区需检查" : undefined}</StatusBadge>
    <Action action="launch" id={q.id} disabled={!ready}>终端 · Codex ↗</Action>
    <details className="task-more" data-workspace-detail="task-actions"><summary>更多操作</summary><div className="task-more-menu">
      <Action action="command" id={q.id} disabled={!ready}>复制启动命令</Action>
      {q.state === "partial" ? <Action action="retry" id={q.id}>重试失败项</Action> : null}
      <Action action="archive" id={q.id}>{q.state === "archived" ? "取消归档" : "归档任务"}</Action>
    </div></details>
  </div>
}

export function TaskDetail({ task: q, projects, openTool = "vscode" }: { task: Task; projects: Project[]; environment: string; openTool?: ProjectOpenTool }) {
  const pending = (m: Task["members"][number]) => !m.worktree?.status_updated_at && !!projects.find(p => p.id === m.project_id)?.refreshing
  const ready = q.state === "ready" && q.members.every(m => canOpenMember(m) && (reusesDirectory(m) || (!m.worktree?.detached && m.worktree?.branch === expectedBranch(m, q))))
  const checking = q.state === "ready" && !ready
  return <Card className="shadcn-scope requirement-workspace gap-5 rounded-none border-0 p-5 shadow-none">
    <section className="task-info" aria-label="任务信息"><div className="task-info-heading"><strong>任务信息</strong>{q.description ? <button type="button" className="task-info-toggle" data-action="task-info-toggle" aria-controls="taskDescription" aria-expanded="false" hidden>查看全部</button> : null}</div>
      {q.description ? <p id="taskDescription" className="task-description task-description-clamped">{q.description}</p> : null}
      <div className="detail-path">工作区：{q.path}</div>
    </section>
    <div className="detail-top"><div className="min-w-0"><h2 className="m-0 flex items-center gap-2 text-base font-semibold">项目工作区 <StatusBadge kind="neutral">{q.members.length} 个</StatusBadge></h2><p className="task-project-summary">{q.members.filter(m => !!m.worktree?.dirty).length} 个项目有修改{checking ? " · 工作目录需检查" : ""}</p></div><div className="detail-actions">
      <Action action="add-requirement-projects" id={q.id} disabled={q.state === "archived" || q.state === "creating" || q.members.length >= 30}>＋ 添加项目</Action>
    </div></div>
    <div className="task-project-list" aria-label="任务关联项目">{[...q.members].sort((a, b) => Number(b.project_id === q.primary_project_id) - Number(a.project_id === q.primary_project_id)).map(m => {
      const t = m.worktree
      const usable = canOpenMember(m)
      const expected = m.branch || (!reusesDirectory(m) ? q.branch : "")
      const drifted = !!t && !!expected && t.branch !== expected
      const active = usable && q.state === "ready"
      const creationRef = m.base_ref?.replace(/^refs\/(heads|remotes)\//, "") || (reusesDirectory(m) ? "已有工作目录" : "master")
      const baseline = t?.compare_available ? t.comparison_ref || "master" : creationRef
      const baselineDifference = t?.compare_available ? [t.ahead ? `领先 ${t.ahead}` : "", t.behind ? `落后 ${t.behind}` : ""].filter(Boolean).join(" · ") || "与基线一致" : "暂不可比较"
      return <article key={m.project_id} className="task-project" aria-label={m.project_name}>
        <div className="task-project-heading"><strong>{m.project_name}</strong>{m.project_id === q.primary_project_id ? <StatusBadge kind="primary-tag">主项目</StatusBadge> : null}</div>
        <button type="button" className="task-project-path path" data-action="copy-path" data-path={m.path} title="点击复制完整路径" aria-label={`复制工作目录路径 ${m.path}`}>{m.path}</button>
        <div className="task-project-state">{t ? <Action action="git-open" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active} aria-label={`切换 ${m.project_name} 的分支`}>⑂ {t.branch || "detached HEAD"}</Action> : <span className="quiet">尚未读取分支</span>}{m.state === "ready" ? <TreeStatus tree={t} pending={pending(m)} compact /> : <StatusBadge kind={m.state} />}</div>
        <GitSyncStatus tree={t} compact />
        <div className="comparison task-baseline" title={`创建来源：${creationRef}${m.base_commit ? `；创建提交：${m.base_commit}` : ""}；差异相对当前 ${baseline} 分支`}>基线 <code>{baseline}</code> · {baselineDifference}</div>
        {drifted ? <div className="table-message">分支已变化，预期 {expected}<Action action="git-task-adopt" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active || !!t?.detached}>采用当前分支</Action></div> : null}
        {m.error || t?.error || !usable ? <div className="table-message">{m.error || t?.error || (pending(m) ? "正在检查工作目录…" : "工作目录不可用")}</div> : null}
        <div className="workspace-project-actions task-project-primary-actions">
          <TaskOpenActions project={m.project_id} path={m.path} disabled={!usable} tool={openTool} />
          <div className="task-split-action"><Action className="task-split-primary rounded-r-none" action="git-open" id={m.project_id} data-path={m.path} data-requirement={q.id} aria-label={`打开 ${m.project_name} 的 Git 操作`} disabled={!active}>Git 操作</Action>
            {active ? <details className="task-action-menu"><summary aria-label="更多 Git 操作"><ChevronDown aria-hidden="true" /></summary><div className="task-action-menu-body">
              <Action variant="ghost" className="justify-start font-normal" action="git-task-pull" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!!t?.detached || !!t?.operation || !!t?.dirty}>拉取</Action><Action variant="ghost" className="justify-start font-normal" action="git-task-push" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!!t?.detached || !!t?.operation}>推送</Action>
            </div></details> : <Button className="task-split-toggle rounded-l-none border-l-0" size="icon-sm" variant="outline" disabled aria-label="更多 Git 操作"><ChevronDown aria-hidden="true" /></Button>}
          </div>
          {t?.operation === "merge" ? <Action action="git-task-ai" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active}>让 AI 完成合并</Action> : null}
          <details className="task-project-details" data-workspace-detail={`project:${m.project_id}`}><summary>详情</summary><div className="task-project-details-body">
            <div>创建来源 <code>{creationRef}</code>{m.base_commit ? <> · <code title={m.base_commit}>{m.base_commit.slice(0, 8)}</code></> : null}</div>
            {t?.status_updated_at ? <div>上次检查 <time data-status-path={t.path} dateTime={t.status_updated_at}>{new Date(t.status_updated_at).toLocaleTimeString("zh-CN", { hour12: false })}</time></div> : null}
          </div></details>
        </div>
      </article>
    })}</div>
  </Card>
}

export function ProjectPicker({ rows }: { rows: PickerRow[] }) {
  if (!rows.length) return <p className="dialog-description">暂无可选择的项目，可先登记新项目。</p>
  return <>{rows.map(({ project: p, checked, choice, overview: v, trees, prefix }) => <Card key={p.id} className="task-project-option gap-0 rounded-lg p-0 shadow-none"><div className="p-3"><Check id={`${prefix}-selected`} name="project_ids" value={p.id} defaultChecked={!p.error && checked} disabled={!!p.error} label={<span className="flex flex-wrap items-center gap-2"><span>{p.name}<small className="block break-all text-xs font-normal text-muted-foreground">{p.path}</small></span>{p.error ? <StatusBadge kind="failed">不可用</StatusBadge> : null}</span>} /></div>{checked ? <div className="task-project-choice" data-project-id={p.id}>
    <Field id={`${prefix}-mode`} label="工作目录"><NativeSelect id={`${prefix}-mode`} data-choice="mode" defaultValue={choice.mode}><Option value="project">使用项目原目录</Option><Option value="worktree">使用已有 Worktree</Option><Option value="new">新建分支和 Worktree</Option></NativeSelect></Field>
    {choice.mode === "project" ? <small className="text-muted-foreground">直接使用当前目录和分支，保留现有修改。</small> : choice.mode === "worktree" ? <><Field id={`${prefix}-path`} label="已有 Worktree"><NativeSelect id={`${prefix}-path`} data-choice="path" required defaultValue={choice.path}><Option value="">请选择已有工作目录</Option>{trees.map(t => <Option key={t.path} value={t.path}>{t.branch || "detached"} · {t.path}</Option>)}</NativeSelect></Field><small className="text-muted-foreground">直接关联所选目录，保留现有分支和修改。</small></> : <><div className="form-grid"><Field id={`${prefix}-branch`} label="新分支名称"><Input id={`${prefix}-branch`} data-choice="branch" defaultValue={choice.branch} maxLength={160} required /></Field><Field id={`${prefix}-source`} label="来源分支"><NativeSelect id={`${prefix}-source`} data-choice="source" required disabled={!v} defaultValue={choice.source}>{v ? <SourceOptions overview={v} /> : <Option value="">正在读取分支…</Option>}</NativeSelect></Field></div><small className="text-muted-foreground">默认优先使用本地 master 或 main，也可选择其他来源；不会自动拉取远端。</small></>}
    {choice.error ? <Feedback variant="destructive">{choice.error} <Button type="button" variant="outline" size="sm" data-choice-retry={p.id}>重试读取</Button></Feedback> : null}
  </div> : null}</Card>)}</>
}
