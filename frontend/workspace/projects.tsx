import { Fragment } from "react"
import { ArrowLeft, ChevronDown, Circle, CircleAlert, Copy, FolderGit2, MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TableCell, TableRow } from "@/components/ui/table"
import { Action, Branch, DataTable, Feedback, GitSyncStatus, ProjectOpenActions, StatusBadge, TreeStatus } from "./shared"
import type { Project, Task, Worktree } from "./types"
import type { ProjectOpenTool } from "./shared"
import { compactWorkspacePath } from "./workspace-path"

export type ProjectFilter = "all" | "dirty" | "error"
export type DirectoryFilter = "all" | "issues"
const directoryHasIssue = (t: Worktree) => !!(t.missing || t.prunable || t.error)
const directoryBranch = (t: Worktree) => t.branch || (t.detached ? "detached HEAD" : t.bare ? "裸仓库" : "尚未读取分支")
const hasIssue = (p: Project) => !!p.error || p.worktrees.some(directoryHasIssue)
const hasChanges = (p: Project) => p.worktrees.some(t => (t.dirty || 0) > 0)
const directoryTasks = (t: Worktree) => t.requirements?.length ? t.requirements : t.requirement_id ? [{ id: t.requirement_id, name: t.requirement_name || t.requirement_id }] : []

function DirectoryRecovery({ tree, project, tasks }: { tree: Worktree; project: Project; tasks: Task[] }) {
  if (!directoryHasIssue(tree)) return null
  const linked = directoryTasks(tree)
  const message = tree.error || (tree.missing ? linked.length ? "目录已丢失，可更换关联任务的工作目录，或检查原路径后重试。" : "目录已丢失，请检查原路径，或创建新的工作目录。" : "Worktree 登记需要修复，请检查目录是否仍在原位置。")
  return <div className="project-directory-recovery" role="status" aria-label={`处理 ${tree.path} 的目录异常`}><p><CircleAlert aria-hidden="true" />{message}</p><div className="project-recovery-actions">
    <Action action="project-refresh" id={project.id}>重新检查</Action>
    {linked.map(link => {
      const task = tasks.find(task => task.id === link.id)
      const editable = task && task.state !== "archived" && task.state !== "creating"
      return <div className="project-task-recovery" key={link.id}><Action action="change-task-directory" id={link.id} data-project={project.id} disabled={!editable}>{linked.length === 1 ? "更换工作目录" : `更换「${link.name || link.id}」的目录`}</Action>{!editable ? <span>{task?.state === "archived" ? "取消归档后可更换目录" : task?.state === "creating" ? "任务创建完成后可更换目录" : "任务信息暂不可用，请重新检查"}</span> : null}</div>
    })}
    {!linked.length ? <><Action action="new-worktree" id={project.id}>创建 Worktree</Action><span>此目录未关联任务，可创建新目录继续工作。</span></> : null}
  </div></div>
}

function DirectoryDetails({ tree: t }: { tree: Worktree }) {
  return <details className="project-row-details"><summary>详情<ChevronDown aria-hidden="true" /></summary><div>
    <p>完整路径 <code>{t.path}</code></p>
    <p>当前分支 <code>{directoryBranch(t)}</code></p>
    {t.compare_available ? <p>相对基线 <code>{t.comparison_ref || "master"}</code> · {t.ahead || t.behind ? `领先 ${t.ahead || 0} · 落后 ${t.behind || 0}` : "与基线一致"}</p> : null}
    {t.upstream ? <p>上游 <code>{t.upstream}</code></p> : null}
    {t.locked ? <p>工作目录已锁定</p> : null}
    {t.status_updated_at ? <p>上次检查 <time data-status-path={t.path} dateTime={t.status_updated_at}>{new Date(t.status_updated_at).toLocaleTimeString("zh-CN", { hour12: false })}</time></p> : <p>{directoryHasIssue(t) ? "目录不可用，暂无法读取最新状态" : "正在检查目录状态"}</p>}
  </div></details>
}

export function Projects({ projects, selectedID, openTool = "vscode", filter = "all", detailOpen = false, tasks = [], directoryFilter = "all", searching = false }: {
  projects: Project[]; selectedID: string | null; openTool?: ProjectOpenTool; filter?: ProjectFilter; detailOpen?: boolean; tasks?: Task[]; directoryFilter?: DirectoryFilter; searching?: boolean
}) {
  const visible = projects.filter(p => filter === "dirty" ? hasChanges(p) : filter === "error" ? hasIssue(p) : true)
  const p = visible.find(p => p.id === selectedID) || visible[0]
  const filters = [{ value: "all", label: "全部", count: projects.length }, { value: "error", label: "异常", count: projects.filter(hasIssue).length }, { value: "dirty", label: "有改动", count: projects.filter(hasChanges).length }]
  const issues = p?.worktrees.filter(directoryHasIssue).length || 0
  const directories = p?.worktrees.filter(t => directoryFilter === "all" || directoryHasIssue(t)) || []
  return <div className="project-workspace shadcn-scope" data-pane={detailOpen && p ? "detail" : "list"}>
    <aside id="projectListPane" className="project-browser" aria-label="项目列表">
      <div className="project-filters" role="group" aria-label="筛选项目">{filters.map(f => <Action key={f.value} action="project-filter" data-filter={f.value} variant={filter === f.value ? "secondary" : "ghost"} aria-pressed={filter === f.value}>{f.label}<span>{f.count}</span></Action>)}</div>
      <div className="project-list-scroll">{visible.map(project => {
        const dirty = project.worktrees.filter(t => (t.dirty || 0) > 0).length
        return <Button key={project.id} type="button" variant="ghost" className="project-list-item flex h-auto w-full min-w-0 flex-col items-stretch gap-2 whitespace-normal p-3 text-left font-normal" data-action="select-project" data-id={project.id} aria-pressed={p?.id === project.id} aria-controls="projectDetail" aria-label={`打开 ${project.name} 的工作目录`}>
          <span className={`project-list-name${hasIssue(project) ? " has-issue" : ""}`}>{hasIssue(project) ? <CircleAlert aria-hidden="true" /> : <FolderGit2 aria-hidden="true" />}<strong>{project.name}</strong></span>
          <span className="project-list-path" title={project.path}>{project.path}</span>
          <span className="project-list-meta"><span>{project.worktrees.length} 个目录</span>{hasIssue(project) ? <StatusBadge kind="failed">{project.error ? "读取失败" : `${project.worktrees.filter(directoryHasIssue).length} 个异常`}</StatusBadge> : null}{dirty ? <span className="project-change-indicator" title={`${dirty} 个工作目录有未提交改动`} aria-label={`${dirty} 个工作目录有未提交改动`}><Circle className="project-change-dot size-1.5" aria-hidden="true" />{dirty} 个目录有改动</span> : !project.status_updated_at && project.refreshing ? <span>正在检查</span> : null}<span className="project-list-enter">查看目录 →</span></span>
        </Button>
      })}{!visible.length ? <div className="project-list-empty">没有匹配的项目{searching ? <Action action="clear-project-search" variant="link">清除搜索</Action> : null}{filter !== "all" ? <Action action="project-filter" data-filter="all" variant="link">查看全部项目</Action> : null}{!searching && filter === "all" ? <span>试试其他名称或路径</span> : null}</div> : null}</div>
    </aside>
    <div className="project-resize-handle" role="separator" aria-label="调整项目列表宽度" aria-orientation="vertical" aria-controls="projectListPane projectDetail" aria-valuemin={200} aria-valuemax={640} aria-valuenow={248} tabIndex={0} data-project-resize title="拖动调整两栏宽度，也可使用左右方向键" />
    <section id="projectDetail" className="project-detail" aria-label={p ? `${p.name} 项目详情` : "项目详情"}>
      {p ? <>
        <div className="project-list-back"><Action action="project-list" variant="ghost" className="pl-0 text-muted-foreground"><ArrowLeft aria-hidden="true" />返回项目列表</Action></div>
        <header className="project-detail-heading"><div><h2 tabIndex={-1}>{p.name}</h2><button type="button" className="project-directory-path" data-action="copy-path" data-path={p.path} title={`${p.path}\n复制项目路径`} aria-label={`复制项目路径 ${p.path}`}>{compactWorkspacePath(p.path)}<Copy aria-hidden="true" /></button></div>
          <div className="project-detail-actions"><Action action="project-conversations" id={p.id}>相关会话</Action><Action action="new-worktree" id={p.id} disabled={!!p.error}>创建 Worktree</Action>
            <details className="task-project-details project-more"><summary aria-label="更多项目操作"><MoreHorizontal aria-hidden="true" /></summary><div className="task-project-details-body"><Action action="git-open" id={p.id} variant="ghost">Git 操作 · 分支管理</Action><Action action="project-open-remote" id={p.id} data-path={p.path} variant="ghost" disabled={!!p.error}>打开远端仓库</Action><hr /><Action action="remove-project" id={p.id} variant="ghost" className="text-destructive">移除登记</Action></div></details>
          </div>
        </header>
        <div className="project-directories-heading"><h3>工作目录 <span>{p.worktrees.length}</span></h3><span>自动发现并更新本地状态</span></div>
        {p.worktrees.length ? <div className="project-directory-filters" aria-label="筛选工作目录"><Action action="project-directory-filter" id={p.id} data-filter="all" aria-pressed={directoryFilter === "all"} variant={directoryFilter === "all" ? "secondary" : "outline"}>全部目录 · {p.worktrees.length}</Action>{issues || directoryFilter === "issues" ? <Action action="project-directory-filter" id={p.id} data-filter="issues" aria-pressed={directoryFilter === "issues"} variant={directoryFilter === "issues" ? "secondary" : "outline"} className={issues ? "project-issue-filter" : undefined}><CircleAlert aria-hidden="true" />需要处理 · {issues}</Action> : null}</div> : null}
        {p.error ? <Feedback variant="destructive"><p className="m-0">项目读取失败：{p.error}</p><Action action="project-refresh" id={p.id}>重新检查</Action></Feedback> : directories.length ? <div className="project-directory-table"><DataTable label="项目工作目录" headers={["工作目录", "远程同步", "关联任务", "本地改动", "操作"]}>{directories.map(t => {
          const linked = directoryTasks(t)
          const usable = !t.bare && !directoryHasIssue(t) && !!t.status_updated_at
          const title = t.path === p.path ? "主工作目录" : linked.length ? linked.map(q => q.name || q.id).join("、") : t.branch || t.path.split(/[\\/]/).filter(Boolean).pop()
          return <Fragment key={t.path}><TableRow data-project-id={p.id} data-directory-path={t.path} className={directoryHasIssue(t) ? "project-directory-has-issue" : undefined}>
          <TableCell className="project-directory-cell p-[var(--project-cell-padding)] align-top whitespace-normal"><div className="project-directory-heading"><strong className="project-directory-name">{title}{t.bare ? <StatusBadge kind="neutral">裸仓库</StatusBadge> : null}</strong><DirectoryDetails tree={t} /></div><Branch>⑂ {directoryBranch(t)}</Branch><button type="button" className="project-directory-path" data-action="copy-path" data-path={t.path} title={`${t.path}\n复制目录路径`} aria-label={`复制目录路径 ${t.path}`}><span>{compactWorkspacePath(t.path)}</span><Copy aria-hidden="true" /></button></TableCell>
          <TableCell className="project-branch-cell p-[var(--project-cell-padding)] align-top whitespace-normal"><span className="project-cell-label">远程同步</span><GitSyncStatus tree={t} compact />{!usable ? <span className="quiet">{directoryHasIssue(t) ? "目录不可用，暂无法确认" : t.bare ? "不适用" : "正在检查"}</span> : null}</TableCell>
          <TableCell className="project-task-cell p-[var(--project-cell-padding)] align-top whitespace-normal"><span className="project-cell-label">关联任务</span><div className="project-linked-tasks">{linked.map(q => <Action key={q.id} action="jump-requirement" id={q.id} variant="link">{q.name || q.id} ↗</Action>)}</div>{!linked.length ? <span className="quiet">未关联任务</span> : null}</TableCell>
          <TableCell className="project-status-cell p-[var(--project-cell-padding)] align-top whitespace-normal">{usable && t.dirty ? <Action action="changes-open" id={p.id} data-path={t.path} variant="ghost" className="project-changes-link" aria-label={`查看 ${title} 的 ${t.dirty} 项改动`}><TreeStatus tree={t} compact /></Action> : <TreeStatus tree={t} compact />}</TableCell>
          <TableCell className="project-actions-cell p-[var(--project-cell-padding)] align-top"><div className="project-directory-actions"><ProjectOpenActions project={p.id} path={t.path} tool={openTool} disabled={t.bare || t.missing || t.prunable || !!t.error || !t.status_updated_at} /><Action action="changes-open" id={p.id} data-path={t.path} disabled={t.bare || t.missing || t.prunable || !!t.error || !t.status_updated_at}>查看改动</Action><details className="task-more project-directory-more"><summary aria-label={`${t.branch || "当前目录"} 更多操作`}><MoreHorizontal aria-hidden="true" /></summary><div className="task-more-menu"><Action action="git-open" id={p.id} data-path={t.path} disabled={t.bare || t.missing || t.prunable || !!t.error || !t.status_updated_at}>Git 操作</Action><Action action="workspace-terminal" id={p.id} data-path={t.path} disabled={t.bare || t.missing || t.prunable || !!t.error || !t.status_updated_at}>打开终端</Action><Action action="project-open-remote" id={p.id} data-path={t.path} disabled={t.bare || t.missing || t.prunable || !!t.error || !t.status_updated_at}>打开远端仓库</Action></div></details></div></TableCell>
        </TableRow>{directoryHasIssue(t) ? <TableRow className="project-directory-recovery-row" data-project-id={p.id}><TableCell colSpan={5}><DirectoryRecovery tree={t} project={p} tasks={tasks} /></TableCell></TableRow> : null}</Fragment>})}</DataTable></div> : directoryFilter === "issues" && p.worktrees.length ? <div className="project-detail-empty">没有需要处理的工作目录。<Action action="project-directory-filter" id={p.id} data-filter="all">查看全部目录</Action></div> : <div className="project-detail-empty">{p.refreshing ? "正在发现工作目录…" : "尚未发现工作目录，请检查项目路径后重新扫描。"}{!p.refreshing ? <Action action="project-refresh" id={p.id}>重新检查</Action> : null}</div>}
      </> : <div className="project-detail-empty">没有匹配的项目，请调整搜索或筛选条件。</div>}
    </section>
  </div>
}
