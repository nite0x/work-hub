import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Action, Feedback, Field, ModalFooter, ModalHeader, NativeSelect, Option, Preview } from "./shared"

export function ProjectForm() {
  return <form id="projectForm"><ModalHeader id="projectDialogTitle" title="添加项目" eyebrow="ADD PROJECT" /><p className="dialog-description">登记仓库主目录，自动发现它已有的全部 worktree。</p>
    <Field id="projectEnvironmentSelect" label="项目所在环境" help="仓库路径和 Git 操作均在此环境中执行。"><NativeSelect id="projectEnvironmentSelect" required /></Field>
    <Field id="projectPath" label="仓库目录" required help="选择本机 Git 仓库主目录，或填写项目所在环境中的绝对路径。"><div className="flex flex-wrap gap-2"><Input className="min-w-0 flex-1 basis-60" id="projectPath" name="path" required autoComplete="off" placeholder="填写仓库主目录的绝对路径" /><Button type="button" variant="outline" id="chooseProjectDirectory">选择文件夹…</Button></div><small id="projectDirectoryHint" className="text-xs text-muted-foreground" hidden>WSL 项目请手动填写 Linux 绝对路径，例如 /home/用户名/projects/app。</small></Field>
    <Field id="projectName" label="项目名称" help="名称会用于任务中的项目目录，建议使用简短、可辨识的名称。"><Input id="projectName" name="name" maxLength={80} placeholder="留空则使用仓库目录名" /></Field>
    <Feedback id="projectError" variant="destructive" hidden />
    <ModalFooter><Button type="submit">添加并扫描</Button></ModalFooter>
  </form>
}

export function TaskForm() {
  return <form id="requirementForm"><ModalHeader id="requirementDialogTitle" title="创建任务" eyebrow="NEW TASK" /><p className="dialog-description">围绕一项开发目标，选择参与项目，可使用原目录、已有 Worktree，或新建分支和工作目录。</p>
    <Field id="requirementEnvironment" label="任务执行环境" required help="只能关联此环境中的项目，创建后任务环境固定。"><NativeSelect id="requirementEnvironment" required /></Field>
    <div><Field id="requirementName" label="任务名称" required><Input id="requirementName" name="name" required maxLength={100} placeholder="例如：订单审批流程" /></Field></div>
    <Field id="requirementDescription" label="任务说明"><Textarea id="requirementDescription" name="description" rows={3} maxLength={6000} placeholder="描述开发目标、涉及的修改和完成标准，新建任务会话时会提供这份说明。" /></Field>

    <div className="mb-5"><div className="mb-2 flex items-center justify-between gap-3 text-sm font-medium"><span>参与项目</span><Button type="button" variant="outline" size="sm" id="registerNewTaskProject">＋ 登记新项目</Button></div><div id="projectPicker" className="project-picker" /></div>
    <Preview title="项目工作目录预览" id="workspacePreview" /><Feedback id="requirementError" variant="destructive" hidden />
    <ModalFooter note="创建前检查全部仓库，已有目录和分支不会被覆盖。"><Button type="submit" id="requirementSubmit">创建任务</Button></ModalFooter>
  </form>
}

export function TaskProjectsForm() {
  return <form id="requirementProjectsForm"><ModalHeader id="requirementProjectsTitle" title="添加项目" eyebrow="TASK PROJECTS" /><p className="dialog-description" id="requirementProjectsDescription" />
    <div className="mb-5"><div className="mb-2 flex items-center justify-between gap-3 text-sm font-medium"><span>选择尚未关联的项目</span><Button type="button" variant="outline" size="sm" id="registerRequirementProject">＋ 登记新项目</Button></div><div id="requirementProjectPicker" className="project-picker" /></div>
    <Preview title="新增项目的工作目录" id="requirementProjectsPreview" /><Feedback id="requirementProjectsError" variant="destructive" hidden />
    <ModalFooter note="每个项目可分别选择工作目录与来源分支。"><Button type="submit" id="requirementProjectsSubmit" disabled>添加项目</Button></ModalFooter>
  </form>
}

export function WorktreeForm() {
  return <><ModalHeader id="worktreeTitle" title="创建 Worktree" eyebrow="NEW WORKTREE" /><p className="dialog-description" id="worktreeProject" /><div id="worktreeLoading" className="loading" role="status">正在读取分支…</div><Feedback id="worktreeError" variant="destructive" hidden />
    <form id="worktreeForm" hidden>
      <Field id="worktreeSlug" label="工作标识" required help="用于总目录名；多个项目使用相同标识可集中到同一目录。已关联任务的目录，请在对应任务页面管理。"><Input id="worktreeSlug" name="slug" required maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}" placeholder="例如：order-approval" /></Field>
      <Field id="worktreeMode" label="分支方式"><NativeSelect id="worktreeMode" name="mode"><Option value="new">新建分支</Option><Option value="existing">使用已有本地分支</Option></NativeSelect></Field>
      <div id="worktreeNewFields" className="form-grid"><Field id="worktreeBranch" label="新分支名称" required help="默认 codex/工作标识，可填写自己的分支名。"><Input id="worktreeBranch" name="branch" required maxLength={160} placeholder="codex/order-approval" /></Field><Field id="worktreeSource" label="来源分支" required><NativeSelect id="worktreeSource" name="source" required /></Field></div>
      <div id="worktreeExistingField" hidden><Field id="worktreeExisting" label="已有本地分支" required help="已被其他 worktree 占用的分支不可重复检出。"><NativeSelect id="worktreeExisting" disabled required /></Field></div>
      <Feedback id="worktreeSourceNote" role="status" className="mb-4 bg-muted text-muted-foreground" /><Preview title="即将创建的 Worktree 目录" id="worktreePath" />
      <p className="dialog-description">独立创建后显示为“未关联任务”。创建新目录会保留原目录的分支和未提交修改。</p>
      <ModalFooter><Button id="worktreeSubmit" type="submit">创建 Worktree</Button></ModalFooter>
    </form>
  </>
}

export function GitDialog() {
  return <><ModalHeader id="gitTitle" title="Git 操作" eyebrow="GIT OPERATIONS" />
    <Feedback id="gitProgress" className="git-progress bg-muted text-muted-foreground" role="status" hidden />
    <Feedback id="gitError" variant="destructive" hidden />
    <Feedback id="gitAuthHelp" className="bg-muted" hidden><span>在终端完成一次登录，接入的凭证助手会保存并供页面复用。</span><Action action="git-fetch-terminal" variant="default">在终端登录并获取分支 ↗</Action></Feedback>
    <Feedback id="gitResult" role="status" className="git-result bg-muted" hidden><strong id="gitResultTitle" /><pre id="gitOutput" /></Feedback>
    <div id="gitContent" />
    <div className="dialog-footer"><Button type="button" variant="outline" className="close-dialog">关闭</Button></div>
  </>
}

export function TaskEditForm() {
  return <form id="taskEditForm"><ModalHeader id="taskEditTitle" title="编辑任务信息" eyebrow="TASK" />
    <Field id="taskEditName" label="任务名称" required><Input id="taskEditName" name="name" required maxLength={100} /></Field>
    <Field id="taskEditDescription" label="目标与说明"><Textarea id="taskEditDescription" name="description" rows={6} maxLength={6000} /></Field>
    <Feedback id="taskEditError" variant="destructive" hidden /><ModalFooter><Button type="submit">保存</Button></ModalFooter>
  </form>
}
export function TaskDirectoryForm() {
  return <form id="taskDirectoryForm"><ModalHeader id="taskDirectoryTitle" title="更换工作目录" eyebrow="WORKING DIRECTORY" />
    <p className="dialog-description" id="taskDirectoryCurrent" /><div id="taskDirectoryPicker" />
    <Preview title="将改为使用" id="taskDirectoryPreview" />
    <Feedback id="taskDirectoryError" variant="destructive" hidden />
    <ModalFooter note="旧目录、分支、代码和已有会话均保留。"><Button type="submit" id="taskDirectorySubmit">确认更换</Button></ModalFooter>
  </form>
}
