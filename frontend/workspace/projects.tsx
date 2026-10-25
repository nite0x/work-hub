import { ArrowLeft, ChevronDown, Circle, Copy, FolderGit2, MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TableCell, TableRow } from "@/components/ui/table"
import { Action, Branch, DataTable, Feedback, GitSyncStatus, ProjectOpenActions, StatusBadge, TreeStatus } from "./shared"
import type { Project, Worktree } from "./types"
import type { ProjectOpenTool } from "./shared"

export type ProjectFilter = "all" | "dirty" | "error"
const hasIssue = (p: Project) => !!p.error || p.worktrees.some(t => t.missing || t.prunable || t.error)
const hasChanges = (p: Project) => p.worktrees.some(t => (t.dirty || 0) > 0)

function DirectoryDetails({ tree: t }: { tree: Worktree }) {
  return <details className="project-row-details"><summary>详情<ChevronDown aria-hidden="true" /></summary><div>
    {t.compare_available ? <p>相对基线 <code>{t.comparison_ref || "master"}</code> · {t.ahead || t.behind ? `领先 ${t.ahead || 0} · 落后 ${t.behind || 0}` : "与基线一致"}</p> : null}
    {t.upstream ? <p>上游 <code>{t.upstream}</code></p> : null}
    {t.locked ? <p>工作目录已锁定</p> : null}
    {t.status_updated_at ? <p>上次检查 <time data-status-path={t.path} dateTime={t.status_updated_at}>{new Date(t.status_updated_at).toLocaleTimeString("zh-CN", { hour12: false })}</time></p> : <p>正在检查目录状态</p>}
  </div></details>
}

export function Projects({ projects, selectedID, openTool = "vscode", filter = "all", detailOpen = false }: {
  projects: Project[]; selectedID: string | null; openTool?: ProjectOpenTool; filter?: ProjectFilter; detailOpen?: boolean
}) {
  const visible = projects.filter(p => filter === "dirty" ? hasChanges(p) : filter === "error" ? hasIssue(p) : true)
  const p = visible.find(p => p.id === selectedID) || visible[0]
  const filters = [{ value: "all", label: "全部", count: projects.length }, { value: "dirty", label: "有修改", count: projects.filter(hasChanges).length }, { value: "error", label: "异常", count: projects.filter(hasIssue).length }]
  return <div className="project-workspace shadcn-scope" data-pane={detailOpen && p ? "detail" : "list"}>
    <aside id="projectListPane" className="project-browser" aria-label="项目列表">
      <div className="project-filters" role="group" aria-label="筛选项目">{filters.map(f => <Action key={f.value} action="project-filter" data-filter={f.value} variant={filter === f.value ? "secondary" : "ghost"} aria-pressed={filter === f.value}>{f.label}<span>{f.count}</span></Action>)}</div>
      <div className="project-list-scroll">{visible.map(project => {
        const dirty = project.worktrees.filter(t => (t.dirty || 0) > 0).length
        return <Button key={project.id} type="button" variant="ghost" className="project-list-item flex h-auto w-full min-w-0 flex-col items-stretch gap-2 whitespace-normal p-3 text-left font-normal" data-action="select-project" data-id={project.id} aria-pressed={p?.id === project.id} aria-controls="projectDetail">
          <span className="project-list-name"><FolderGit2 aria-hidden="true" /><strong>{project.name}</strong></span>
          <span className="project-list-path" title={project.path}>{project.path}</span>
          <span className="project-list-meta"><span>{project.worktrees.length} 个目录</span>{hasIssue(project) ? <StatusBadge kind="failed">异常</StatusBadge> : dirty ? <span className="project-change-indicator" title={`${dirty} 个工作目录有未提交修改`} aria-label={`${dirty} 个工作目录有未提交修改`}><Circle className="project-change-dot size-1.5" aria-hidden="true" />有修改</span> : !project.status_updated_at && project.refreshing ? <span>正在检查</span> : null}</span>
        </Button>
      })}{!visible.length ? <div className="project-list-empty">没有匹配的项目{filter !== "all" ? <Action action="project-filter" data-filter="all" variant="link">查看全部项目</Action> : <span>试试其他名称或路径</span>}</div> : null}</div>
    </aside>
    <div className="project-resize-handle" role="separator" aria-label="调整项目列表宽度" aria-orientation="vertical" aria-controls="projectListPane projectDetail" aria-valuemin={200} aria-valuemax={640} aria-valuenow={248} tabIndex={0} data-project-resize title="拖动调整两栏宽度，也可使用左右方向键" />
    <section id="projectDetail" className="project-detail" aria-label={p ? `${p.name} 项目详情` : "项目详情"}>
      {p ? <>
        <div className="project-list-back"><Action action="project-list" variant="ghost" className="pl-0 text-muted-foreground"><ArrowLeft aria-hidden="true" />返回项目列表</Action></div>
        <header className="project-detail-heading"><div><h2 tabIndex={-1}>{p.name}</h2><button type="button" className="project-directory-path" data-action="copy-path" data-path={p.path} title="复制项目路径">{p.path}<Copy aria-hidden="true" /></button></div>
          <div className="project-detail-actions"><Action action="project-conversations" id={p.id}>项目对话</Action><Action action="new-worktree" id={p.id} disabled={!!p.error}>创建 Worktree</Action>
            <details className="task-project-details project-more"><summary aria-label="更多项目操作"><MoreHorizontal aria-hidden="true" /></summary><div className="task-project-details-body"><Action action="git-open" id={p.id} variant="ghost">Git 操作 · 分支管理</Action><Action action="project-open-remote" id={p.id} data-path={p.path} variant="ghost" disabled={!!p.error}>打开远端仓库</Action><hr /><Action action="remove-project" id={p.id} variant="ghost" className="text-destructive">移除登记</Action></div></details>
          </div>
        </header>
        <div className="project-directories-heading"><h3>工作目录 <span>{p.worktrees.length}</span></h3><span>自动发现并更新本地状态</span></div>
        {p.error ? <Feedback variant="destructive">{p.error}</Feedback> : p.worktrees.length ? <DataTable label="项目工作目录" headers={["工作目录", "分支 / 同步", "关联任务", "修改状态", "操作"]}>{p.worktrees.map(t => <TableRow key={t.path}>
          <TableCell className="align-top whitespace-normal"><strong className="project-directory-name">{t.path.split(/[\\/]/).pop()}{t.path === p.path ? <StatusBadge kind="primary-tag">登记目录</StatusBadge> : null}{t.bare ? <StatusBadge kind="neutral">裸仓库</StatusBadge> : null}</strong><button type="button" className="project-directory-path" data-action="copy-path" data-path={t.path} title="复制目录路径">{t.path}<Copy aria-hidden="true" /></button></TableCell>
          <TableCell className="align-top whitespace-normal"><Branch>⑂ {t.branch || "detached HEAD"}</Branch><GitSyncStatus tree={t} compact /></TableCell>
          <TableCell className="align-top whitespace-normal"><div className="project-linked-tasks">{(t.requirements?.length ? t.requirements : t.requirement_id ? [{ id: t.requirement_id, name: t.requirement_name }] : []).map(q => <Action key={q.id} action="jump-requirement" id={q.id} variant="link">{q.name} ↗</Action>)}</div>{!t.requirements?.length && !t.requirement_id ? <span className="quiet">未关联任务</span> : null}</TableCell>
          <TableCell className="align-top whitespace-normal"><TreeStatus tree={t} compact />{t.error ? <div className="table-message">{t.error}</div> : null}<DirectoryDetails tree={t} /></TableCell>
          <TableCell className="align-top"><div className="project-directory-actions"><ProjectOpenActions project={p.id} path={t.path} tool={openTool} disabled={t.bare || t.missing || t.prunable || !!t.error || !t.status_updated_at} /><Action action="git-open" id={p.id} data-path={t.path} className="h-auto border-0 bg-transparent p-0 text-xs text-muted-foreground shadow-none" disabled={t.bare || t.missing || t.prunable || !!t.error || !t.status_updated_at}>Git 操作</Action></div></TableCell>
        </TableRow>)}</DataTable> : <p className="project-detail-empty">正在发现工作目录…</p>}
      </> : <div className="project-detail-empty">没有匹配的项目，请调整搜索或筛选条件。</div>}
    </section>
  </div>
}
