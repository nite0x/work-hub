import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import { Action, Branch, Check, DataTable, Feedback, Field, GitSyncStatus, NativeSelect, Option, ProjectOpenActions, SourceOptions, StatusBadge, TreeStatus, branchSummary, canOpenMember, expectedBranch, reusesDirectory } from "./shared"
import type { PickerRow, Project, Task } from "./types"

export function TaskList({ tasks }: { tasks: Task[] }) {
  return <div className="shadcn-scope divide-y divide-border">{tasks.map(q => {
    const primary = q.members.find(m => m.project_id === q.primary_project_id)
    return <Card key={`${q.environment_id}:${q.id}`} className="gap-0 rounded-none border-0 p-0 shadow-none"><a className="list-row focus-visible:outline-ring" href={`?environment=${encodeURIComponent(q.environment_id)}#/requirements/${encodeURIComponent(q.id)}`} data-action="open-requirement" data-id={q.id} data-environment={q.environment_id} aria-label={`打开任务 ${q.name}`}><div className="row-main"><div className="row-title">{q.name} <StatusBadge kind={q.state} /><StatusBadge kind="neutral">{q.environment_name}</StatusBadge></div><div className="row-subtitle"><span>{q.members.length} 个项目 · 主项目 {primary?.project_name}</span><code>⑂ {branchSummary(q)}</code></div></div><div className="row-meta"><span>{!q.connected ? "环境未连接" : q.members.some(m => !m.worktree?.status_updated_at) ? "等待检查工作目录" : `${q.members.filter(m => (m.worktree?.dirty || 0) > 0).length} 个项目有修改`}</span><span className="row-time">{new Date(q.created_at).toLocaleDateString("zh-CN")}</span></div><span className="chevron" aria-hidden="true">›</span></a></Card>
  })}</div>
}

export function TaskDetail({ task: q, projects, environment }: { task: Task; projects: Project[]; environment: string }) {
  const pending = (m: Task["members"][number]) => !m.worktree?.status_updated_at && !!projects.find(p => p.id === m.project_id)?.refreshing
  const ready = q.state === "ready" && q.members.every(m => canOpenMember(m) && (reusesDirectory(m) || (!m.worktree?.detached && m.worktree?.branch === expectedBranch(m, q))))
  const checking = q.state === "ready" && !ready
  const primary = q.members.find(m => m.project_id === q.primary_project_id)
  return <Card className="shadcn-scope requirement-workspace gap-5 rounded-none border-0 p-5 shadow-none sm:p-6">
    <div className="detail-top"><div className="min-w-0"><h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">关联项目 <StatusBadge kind={checking ? q.members.some(pending) ? "neutral" : "warning" : q.state}>{checking ? q.members.some(pending) ? "状态检查中" : "工作区需检查" : undefined}</StatusBadge></h2><div className="detail-path">{q.path}</div></div><div className="detail-actions">
      <Action action="add-requirement-projects" id={q.id} disabled={q.state === "archived" || q.state === "creating" || q.members.length >= 30}>＋ 添加项目</Action>
      {q.state === "partial" ? <Action action="retry" id={q.id} variant="secondary">↻ 重试失败项</Action> : null}
      <Action action="command" id={q.id} disabled={!ready}>复制启动命令</Action>
      <Action action="launch" id={q.id} variant="default" disabled={!ready}>↗ 打开终端 · Codex</Action>
      <Action action="archive" id={q.id}>{q.state === "archived" ? "取消归档" : "归档"}</Action>
    </div></div>
    {q.description ? <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{q.description}</p> : null}
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground"><span>执行环境 <b className="font-medium text-foreground">{environment}</b></span><span>关联项目 <b className="font-medium text-foreground">{q.members.length} 个</b></span><span>主目录 <b className="font-medium text-foreground">{primary?.project_name}</b></span></div>
    <DataTable label="任务关联项目" headers={["项目 / 工作目录", "实际分支", "创建基线", "状态", "进入工作目录"]}>{[...q.members].sort((a, b) => Number(b.project_id === q.primary_project_id) - Number(a.project_id === q.primary_project_id)).map(m => {
      const t = m.worktree
      const usable = canOpenMember(m)
      const expected = m.branch || (!reusesDirectory(m) ? q.branch : "")
      const drifted = !!t && !!expected && t.branch !== expected
      const active = usable && q.state === "ready"
      return <TableRow key={m.project_id}>
        <TableCell className="align-top whitespace-normal"><strong className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">{m.project_name}{m.project_id === q.primary_project_id ? <StatusBadge kind="primary-tag">主项目</StatusBadge> : null}</strong><div className="path">{m.path}</div><ProjectOpenActions project={m.project_id} path={m.path} disabled={!usable} /></TableCell>
        <TableCell className="align-top whitespace-normal">{t ? <Action action="git-open" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active} aria-label={`切换 ${m.project_name} 的分支`}>⑂ {t.branch || "detached HEAD"}</Action> : <span className="quiet">尚未读取</span>}{drifted ? <div className="table-message">分支已变化，预期 {expected}<Action action="git-task-adopt" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active || !!t?.detached}>采用当前分支</Action></div> : null}<GitSyncStatus tree={t} />{t?.compare_available ? <div className="comparison">相对基线 {t.comparison_ref || "master"}：↑ {t.ahead} ↓ {t.behind}</div> : null}</TableCell>
        <TableCell className="align-top whitespace-normal"><Branch>{reusesDirectory(m) ? "已有工作目录" : (m.base_ref || "refs/heads/master").replace(/^refs\/(heads|remotes)\//, "")}</Branch><div className="comparison">{(m.base_commit || "").slice(0, 8)}</div></TableCell>
        <TableCell className="align-top whitespace-normal">{m.state === "ready" ? <TreeStatus tree={t} pending={pending(m)} /> : <StatusBadge kind={m.state} />}{m.error ? <div className="table-message">{m.error}</div> : null}{t?.error ? <div className="table-message">{t.error}</div> : null}</TableCell>
        <TableCell className="align-top whitespace-normal"><div className="workspace-project-actions"><Action action="git-task-pull" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active || !!t?.detached || !!t?.operation || !!t?.dirty}>拉取</Action><Action action="git-task-push" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active || !!t?.detached || !!t?.operation}>推送</Action><Action action="workspace-terminal" id={m.project_id} data-path={m.path} aria-label={`打开 ${m.project_name} 的终端`} disabled={!usable}>打开终端 ↗</Action><Action action="git-open" id={m.project_id} data-path={m.path} data-requirement={q.id} aria-label={`打开 ${m.project_name} 的 Git 操作`} disabled={!active} variant="secondary">Git 操作</Action>{t?.operation === "merge" ? <Action action="git-task-ai" id={m.project_id} data-path={m.path} data-requirement={q.id} disabled={!active}>让 AI 完成合并</Action> : null}</div>{!usable ? <div className="table-message">{pending(m) ? "正在检查工作目录…" : "工作目录不可用"}</div> : null}</TableCell>
      </TableRow>
    })}</DataTable>
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
