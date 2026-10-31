import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
import { Copy, Search, X, RotateCw } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Check, Feedback, NativeSelect, Option } from "./workspace/shared"
import { ProjectForm, TaskForm, TaskProjectsForm, TaskEditForm, TaskDirectoryForm, WorktreeForm, GitDialog } from "./workspace/forms"
import { workspaceUI } from "./workspace/renderers"
import { SettingsPage, EnvironmentForm } from "./workspace/settings"
import { SessionPickerDialog, CommandOutputDialog } from "./workspace/sessions"
import { SessionBrowser } from "./workspace/session-browser"
import "./styles.css"
import "./workspace/interactions.css"
import { TaskReviewDialog, ChangesDialog } from "./workspace/task-review"
import { setupWorkspaceInteractions, mountWorkspaceToaster } from "./workspace/interactions"
import { mountWorkspaceSidebar } from "./workspace/sidebar"
import { setupWorkspacePanels } from "./workspace/resizable"

function SearchField() {
  return (
    <div className="relative">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input id="search" type="search" placeholder="搜索任务名称、分支…" aria-label="搜索" className="h-9 w-56 pl-9 text-sm max-sm:w-44 [.tasks-page_&]:w-full" />
    </div>
  )
}

function CommandDialog() {
  return (
    <>
      <div className="dialog-header">
        <div className="space-y-3">
          <Badge variant="secondary" className="eyebrow m-0 text-xs tracking-wider">TERMINAL COMMAND</Badge>
          <h2 id="commandTitle" className="text-xl font-semibold">终端命令</h2>
        </div>
        <Button type="button" variant="ghost" size="icon" className="close-dialog shrink-0" aria-label="关闭">
          <X aria-hidden="true" />
        </Button>
      </div>
      <p id="commandDescription" className="dialog-description">在当前执行环境的终端执行以下命令；Windows 本机使用 PowerShell。</p>
      <Textarea id="commandText" rows={7} readOnly aria-label="终端命令" className="min-h-44 resize-y bg-muted p-3 font-mono text-sm leading-relaxed" />
      <div className="dialog-footer">
        <Button type="button" variant="outline" className="close-dialog">关闭</Button>
        <Button type="button" id="copyCommand"><Copy aria-hidden="true" />复制命令</Button>
      </div>
    </>
  )
}

function ToastContent() {
  return <Alert role="presentation" className="border-0 bg-transparent p-0 text-inherit"><AlertDescription id="toastMessage" className="whitespace-pre-wrap text-inherit" /></Alert>
}

// Mount the static form boundaries before deferred controllers attach listeners.
// Interactive islands below keep their own roots and bridge native controls.
function mount(id: string, content: ReactNode) {
  const container = document.getElementById(id)
  if (!container) throw new Error(`Missing UI mount: ${id}`)
  container.innerHTML = renderToStaticMarkup(content)
}

window.WorkHubUI = workspaceUI
mount("searchField", <SearchField />)
mount("commandDialog", <CommandDialog />)
mount("toast", <ToastContent />)
mount("newTaskButton", <Button type="button" id="newButton">＋ 创建任务</Button>)
mount("projectAddButton", <Button type="button" size="sm" data-action="new-project">＋ 添加项目</Button>)
mount("refreshControl", <Button type="button" id="refreshButton" variant="ghost" size="icon-sm" title="刷新 Git 状态" aria-label="刷新 Git 状态"><RotateCw aria-hidden="true" /></Button>)
mount("archiveFilterWrap", <Check id="archiveFilter" label="显示归档" />)
mount("taskStatusFilterWrap", <label className="flex items-center gap-2 text-sm"><span className="sr-only">筛选工作目录状态</span><NativeSelect id="taskStatusFilter" aria-label="筛选工作目录状态"><Option value="all">全部状态</Option><Option value="issues">目录异常</Option><Option value="dirty">有改动</Option><Option value="push">待推送</Option><Option value="conflicts">Git 操作待处理</Option></NativeSelect></label>)
mount("projectEnvironmentWrap", <label className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"><span className="shrink-0 whitespace-nowrap">项目环境</span><NativeSelect id="projectEnvironment" aria-label="项目环境"><Option value="local">本机</Option></NativeSelect></label>)
mount("offlineFeedback", <Feedback id="offlineBanner" variant="destructive" className="mb-4" hidden />)
mount("projectDialog", <ProjectForm />)
mount("requirementDialog", <TaskForm />)
mount("requirementProjectsDialog", <TaskProjectsForm />)
mount("taskEditDialog", <TaskEditForm />)
mount("taskDirectoryDialog", <TaskDirectoryForm />)
mount("worktreeDialog", <WorktreeForm />)
mount("gitDialog", <GitDialog />)
mount("settingsPage", <SettingsPage />)
mount("environmentDialog", <EnvironmentForm />)
mount("sessionDialog", <SessionPickerDialog />)
mount("sessionCommandOutputDialog", <CommandOutputDialog />)
mount("sessionPageMount", <SessionBrowser />)
mount("taskReviewDialog", <TaskReviewDialog />)
mount("changesDialog", <ChangesDialog />)
setupWorkspaceInteractions()
mountWorkspaceToaster()
mountWorkspaceSidebar()
setupWorkspacePanels()
