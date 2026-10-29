import { ChevronDown, FolderGit2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { Check, Feedback, Field, NativeSelect, Option, SourceOptions, StatusBadge } from "./shared"
import type { Choice, PickerRow } from "./types"

const directoryModes = [
  { value: "new", title: "新建分支与目录", description: "从来源分支开始独立工作" },
  { value: "project", title: "项目原目录", description: "继续使用当前分支和修改" },
  { value: "worktree", title: "已有 Worktree", description: "关联已经存在的工作现场" },
  { value: "existing", title: "已有分支，新建目录", description: "检出未被占用的本地分支" },
] as const

type PickerChoice = Choice & { expanded?: boolean }

export function projectChoiceReady({ choice, overview, trees }: PickerRow) {
  if (choice.error) return false
  if (choice.mode === "project") return true
  if (choice.mode === "worktree") return !!choice.path && trees.some(tree => tree.path === choice.path)
  if (choice.mode === "existing") return !!overview?.branches.some(branch => branch.kind === "local" && branch.name === choice.existingBranch && !branch.worktrees.length)
  return !!choice.branch.trim() && !!choice.source && !!overview
}

export function projectChoiceSummary(row: PickerRow) {
  const { choice, project } = row
  if (choice.error) return "配置读取失败，请重试"
  if (choice.mode === "project") return "项目原目录 · 保留当前分支与修改"
  if (choice.mode === "worktree") {
    const tree = row.trees.find(tree => tree.path === choice.path)
    return tree ? `已有 Worktree · ${tree.branch || "detached HEAD"}` : "已有 Worktree · 请选择目录"
  }
  if (choice.mode === "existing") return choice.existingBranch ? `新建目录 · ${choice.existingBranch}` : "新建目录 · 请选择已有分支"
  return choice.source ? `新建目录 · ${choice.branch || "请填写分支"} · 从 ${choice.source.replace(/^refs\/(heads|remotes)\//, "")} 开始` : `新建目录 · ${project.name} · 正在读取来源分支…`
}

// The native controls stay owned by the task controller. Each selected project
// retains its configuration even when collapsed or filtered out of the list.
export function ProjectPicker({ rows }: { rows: PickerRow[] }) {
  if (!rows.length) return <p className="dialog-description">暂无可选择的项目，可先登记新项目。</p>
  return <>{rows.map(row => {
    const { project: p, checked, choice, overview: v, trees, prefix } = row
    const ready = projectChoiceReady(row)
    const expanded = (choice as PickerChoice).expanded ?? !ready
    return <Card key={p.id} className="task-project-option task-picker-project gap-0 rounded-lg p-0 shadow-none" data-project-id={p.id} data-picker-search-text={`${p.name} ${p.path}`}>
      <div className="task-picker-project-heading"><Check id={`${prefix}-selected`} name="project_ids" value={p.id} defaultChecked={!p.error && checked} disabled={!!p.error} label={<span className="task-picker-project-label"><span><FolderGit2 aria-hidden="true" /><strong>{p.name}</strong>{p.error ? <StatusBadge kind="failed">不可用</StatusBadge> : null}</span><small title={p.path}>{p.path}</small></span>} /></div>
      {checked ? <details className="task-picker-configuration" data-picker-project={p.id} data-picker-default-expanded={String(expanded)} open={expanded}>
        <summary><span className="task-picker-choice-summary" data-choice-summary={p.id}>{projectChoiceSummary(row)}</span><span className="task-picker-configure">配置<ChevronDown aria-hidden="true" /></span></summary>
        <div className="task-project-choice">
          <fieldset className="task-directory-modes"><legend>工作目录方式</legend>
            <select id={`${prefix}-mode`} data-choice="mode" defaultValue={choice.mode} hidden aria-hidden="true" tabIndex={-1}>{directoryModes.map(mode => <option key={mode.value} value={mode.value}>{mode.title}</option>)}</select>
            <div>{directoryModes.map(mode => <label key={mode.value} className="task-directory-mode"><input id={`${prefix}-mode-${mode.value}`} type="radio" name={`${prefix}-directory-mode`} value={mode.value} data-choice="mode" defaultChecked={choice.mode === mode.value} /><span><strong>{mode.title}</strong><small>{mode.description}</small></span></label>)}</div>
          </fieldset>
          {choice.mode === "existing" ? <><Field id={`${prefix}-existingBranch`} label="已有本地分支"><NativeSelect id={`${prefix}-existingBranch`} data-choice="existingBranch" data-searchable-select required disabled={!v} defaultValue={choice.existingBranch || ""}><Option value="">{v ? "请选择未被占用的本地分支" : "正在读取分支…"}</Option>{v?.branches.filter(b => b.kind === "local").map(b => <Option key={b.ref} value={b.name} disabled={!!b.worktrees.length}>{b.name}{b.worktrees.length ? "（已被 Worktree 占用）" : ""}</Option>)}</NativeSelect></Field><small>已被占用的分支，请通过“已有 Worktree”关联。</small></> : null}
          {choice.mode === "project" ? <p className="task-picker-mode-note">将直接使用 <code>{p.path}</code>，保留已有分支和修改。</p> : choice.mode === "worktree" ? <Field id={`${prefix}-path`} label="已有 Worktree" help="保留所选目录中的分支与修改。"><NativeSelect id={`${prefix}-path`} data-choice="path" data-searchable-select required defaultValue={choice.path}><Option value="">请选择已有工作目录</Option>{trees.map(t => <Option key={t.path} value={t.path}>{t.branch || "detached HEAD"} · {t.path}</Option>)}</NativeSelect></Field> : choice.mode === "new" ? <><div className="form-grid"><Field id={`${prefix}-branch`} label="新分支名称"><Input id={`${prefix}-branch`} data-choice="branch" defaultValue={choice.branch} maxLength={160} required /></Field><Field id={`${prefix}-source`} label="来源分支"><NativeSelect id={`${prefix}-source`} data-choice="source" data-searchable-select required disabled={!v} defaultValue={choice.source}>{v ? <SourceOptions overview={v} /> : <Option value="">正在读取分支…</Option>}</NativeSelect></Field></div><small>默认从本地 master 或 main 开始，可改选其他来源；不会自动拉取远端。</small></> : null}
          {choice.error ? <Feedback variant="destructive">{choice.error} <Button type="button" variant="outline" size="sm" data-choice-retry={p.id}>重试读取</Button></Feedback> : null}
        </div>
      </details> : null}
    </Card>
  })}<p className="task-picker-search-empty" data-picker-empty hidden role="status">没有匹配的项目。试试其他项目名或路径；已选项目仍会保留。</p></>
}
