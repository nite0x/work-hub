import { renderToStaticMarkup } from "react-dom/server"
import { Card } from "@/components/ui/card"
import { TaskDetail, TaskList, ProjectPicker } from "./tasks"
import { Projects } from "./projects"
import { GitView } from "./git"
import { SyncResults, type SyncRun } from "./settings"
import { SessionList, SessionPicker, NewSession, type Session, type SessionsData } from "./sessions"
import { HistoryMessage, FileChange, ChatApprovals, HistoryAttention, type HistoryEntry, type Approval } from "./session-timeline"
import { Branch, EmptyState, SourceOptions, StatusBadge, TreeStatus, canOpenMember, branchSummary, expectedBranch, reusesDirectory } from "./shared"
import type { GitOverview, PickerRow, Project, Task, Worktree } from "./types"
import {readElicitation} from "../chat/approval"

// Components render inert markup. The existing controllers keep ownership of
// events, form state, native dialog lifecycle, polling and API requests.
export const workspaceUI = {
  readElicitation,
  tasks: (tasks: Task[]) => renderToStaticMarkup(<TaskList tasks={tasks} />),
  taskDetail: (task: Task, projects: Project[], environment: string) => renderToStaticMarkup(<TaskDetail task={task} projects={projects} environment={environment} />),
  projects: (projects: Project[], selectedID: string | null) => renderToStaticMarkup(<Projects projects={projects} selectedID={selectedID} />),
  git: (overview: GitOverview) => renderToStaticMarkup(<GitView overview={overview} />),
  projectPicker: (rows: PickerRow[]) => renderToStaticMarkup(<ProjectPicker rows={rows} />),
  badge: (kind: string, text?: string) => renderToStaticMarkup(<span className="shadcn-scope"><StatusBadge kind={kind}>{text}</StatusBadge></span>),
  branch: (value: string) => renderToStaticMarkup(<span className="shadcn-scope"><Branch>⑂ {value || "detached HEAD"}</Branch></span>),
  treeState: (tree?: Worktree, pending?: boolean) => renderToStaticMarkup(<div className="shadcn-scope"><TreeStatus tree={tree} pending={pending} /></div>),
  stat: (label: string, value: number, caption: string, symbol: string) => renderToStaticMarkup(<Card title={caption} className="shadcn-scope flex-row items-center justify-between gap-3 rounded-lg px-4 py-3 shadow-none"><div className="flex items-center gap-2 text-sm text-muted-foreground"><span aria-hidden="true">{symbol}</span>{label}</div><strong className="text-2xl font-semibold">{value}</strong></Card>),
  empty: (title: string, description: string, action?: string, button?: string) => renderToStaticMarkup(<EmptyState title={title} description={description} action={action} button={button} />),
  offline: () => renderToStaticMarkup(<EmptyState title="暂时无法连接执行环境" description="请检查本机服务；WSL 环境可在设置页重新连接恢复。" href="#/settings" button="打开设置" />),
  sourceOptions: (overview: GitOverview, includeHead = true) => renderToStaticMarkup(<SourceOptions overview={overview} includeHead={includeHead} />),
  syncResults: (run?: SyncRun | null) => renderToStaticMarkup(<SyncResults run={run} />),
  sessions: (task: Task, data: SessionsData | undefined, readOnly: boolean) => renderToStaticMarkup(<SessionList task={task} data={data} readOnly={readOnly} />),
  sessionPicker: (sessions: Session[], linked: string[]) => renderToStaticMarkup(<SessionPicker sessions={sessions} linked={linked} />),
  newSession: (name: string) => renderToStaticMarkup(<NewSession name={name} />),
  historyEntry: (entry: HistoryEntry, metadata: string) => renderToStaticMarkup(<HistoryMessage entry={entry} metadata={metadata} />),
  fileChange: (text?: string, status?: string) => renderToStaticMarkup(<FileChange text={text} status={status} />),
  chatApprovals: (approvals: Approval[]) => renderToStaticMarkup(<ChatApprovals approvals={approvals} />),
  historyAttention: (connected: boolean, confirmations: Approval[]) => renderToStaticMarkup(<HistoryAttention connected={connected} confirmations={confirmations} />),
  canOpenMember, branchSummary, expectedBranch, reusesDirectory,
}

declare global { interface Window { WorkHubUI: typeof workspaceUI } }
