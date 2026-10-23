import type { ComponentProps } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { TableCell, TableRow } from "@/components/ui/table"
import { Action, DataTable, Feedback, Field, ModalHeader, NativeSelect, StatusBadge } from "./shared"
import type { Task } from "./types"

export interface Session {
  id: string; name: string; cwd: string; updated_at?: number; updatedAt?: number;
  source?: string; error?: string; available?: boolean;
  chat_status?: string; completed_run?: string; unread?: boolean;
}
export interface SessionsData { sessions: Session[]; loading?: boolean; error?: string }
export const sessionTime = (value?: number) => value ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }) : "暂无活动记录"
function SessionAction({ action, session, requirement, children, ...props }: ComponentProps<typeof Button> & { action: string; session?: string; requirement?: string }) {
  return <Button type="button" variant="outline" size="sm" data-session-action={action} data-session={session} data-requirement={requirement} {...props}>{children}</Button>
}
function SessionActivity({ session: s }: { session: Session }) {
  const active = ["starting", "running", "waiting", "stopping", "handoff"].includes(s.chat_status || "")
  return <>{active ? <StatusBadge kind={s.chat_status === "waiting" ? "warning" : "primary-tag"}>{s.chat_status === "waiting" ? "待确认" : "对话中"}</StatusBadge> : null}{s.unread ? <StatusBadge kind="warning">未读</StatusBadge> : null}</>
}
export function SessionList({ task: q, data, readOnly }: { task: Task; data?: SessionsData; readOnly: boolean }) {
  const sessions = data?.sessions || []
  return <section id="requirementSessions" className="requirement-sessions shadcn-scope" aria-labelledby="sessionsTitle"><div className="detail-top"><div><h2 id="sessionsTitle" className="m-0 flex items-center gap-2 text-lg font-semibold">关联会话 {data ? <StatusBadge kind="neutral">{String(sessions.length)}</StatusBadge> : null}</h2><p className="session-description">{readOnly ? "在终端中对话，在这里查看已保存的会话内容。任务工作区及各项目根目录中的会话会自动关联。" : "新建会话直接在侧栏开始并自动关联任务。直接在工作区总目录或项目工作目录启动的本地会话也会自动关联。"}</p></div><div className="detail-actions">{readOnly ? <Action action="launch" id={q.id} variant="default" disabled={q.state !== "ready"}>在终端新建会话 ↗</Action> : <SessionAction action="new" requirement={q.id} variant="default" disabled={q.state !== "ready"}>＋ 新建会话</SessionAction>}<SessionAction action="refresh" requirement={q.id}>刷新会话</SessionAction><SessionAction action="picker" requirement={q.id}>＋ 关联已有会话</SessionAction></div></div>
    {data?.error ? <Feedback variant="destructive" className="my-4">{data.error} <span>可点击“刷新会话”重试。</span></Feedback> : null}
    {sessions.length ? <DataTable label="关联会话" headers={["会话", "继续时的工作目录", "最近活动 / 来源", "操作"]}>{sessions.map(s => <TableRow key={s.id}><TableCell className="align-top whitespace-normal"><div className="flex flex-wrap items-center gap-2"><strong>{s.name}</strong><span data-session-indicators={s.id} className="inline-flex gap-2"><SessionActivity session={s} /></span></div><div className="path">{s.id}</div></TableCell><TableCell className="align-top whitespace-normal"><div className="path">{s.cwd}</div>{!q.members.some(m => m.path === s.cwd) && s.cwd !== q.path ? <div className="table-message">任务工作目录之外的会话</div> : null}</TableCell><TableCell className="align-top whitespace-normal">{sessionTime(s.updated_at)}<div className="comparison">{s.source === "manual" ? "手动关联" : "自动关联"}</div>{s.error ? <div className="table-message">{s.error}</div> : null}</TableCell><TableCell className="align-top whitespace-normal"><div className="session-row-actions"><SessionAction action="details" session={s.id} requirement={q.id}>查看详情</SessionAction><SessionAction action={readOnly ? "resume" : "details"} session={s.id} requirement={q.id} variant="default" disabled={!s.available || q.state !== "ready"}>{readOnly ? "在终端继续 ↗" : "继续对话"}</SessionAction></div></TableCell></TableRow>)}</DataTable> : <p className="session-empty" role="status">{!data || data.loading ? "正在读取 Codex 会话…" : data.error ? "暂时无法读取会话。" : "暂无关联会话。可在终端新建会话，或关联已有会话。"}</p>}
    <p className="session-description">{readOnly ? "会话列表每 10 秒刷新；详情手动刷新显示已保存的消息和执行记录。" : "直接在任务中发送消息、查看实时回复和确认操作。会话列表每 10 秒刷新。"}</p>
  </section>
}
export function SessionPicker({ sessions, linked }: { sessions: Session[]; linked: string[] }) {
  if (!sessions.length) return <p className="session-empty">没有找到会话。可换一个标题搜索，或填写会话 ID。</p>
  return <div className="grid gap-3">{sessions.map(s => <Card key={s.id} className="session-picker-row flex-row gap-4 rounded-lg p-4 shadow-none"><div><strong>{s.name}</strong><div className="path">{s.cwd}</div><small>{sessionTime(s.updatedAt)} · {s.id}</small></div><SessionAction action="link" session={s.id} disabled={linked.includes(s.id)}>{linked.includes(s.id) ? "已关联" : "关联"}</SessionAction></Card>)}</div>
}
export function SessionPickerDialog() {
  return <><ModalHeader id="sessionDialogTitle" title="关联已有会话" eyebrow="CODEX SESSIONS" /><p className="dialog-description">选择当前 WSL 用户的本地 Codex 会话，或填写会话 ID。继续时会进入会话原工作目录，并加入本任务的各项目目录。</p>
    <form id="sessionLinkForm" className="session-search"><Field id="sessionLinkID" label="会话 ID"><Input id="sessionLinkID" name="session_id" required maxLength={200} autoComplete="off" placeholder="粘贴会话 ID" /></Field><Button variant="outline" type="submit">关联 ID</Button></form>
    <form id="sessionSearchForm" className="session-search"><Field id="sessionSearch" label="按标题查找"><Input id="sessionSearch" name="search" autoComplete="off" placeholder="搜索本地会话标题" /></Field><Button variant="outline" type="submit">搜索</Button></form>
    <Feedback id="sessionPickerError" variant="destructive" hidden /><div id="sessionPickerResults" aria-live="polite" />
    <div className="dialog-footer"><Button type="button" variant="outline" id="sessionPickerMore" hidden>加载更多</Button><Button type="button" variant="outline" className="close-dialog">关闭</Button></div>
  </>
}
export function CommandOutputDialog() {
  return <><div className="dialog-header"><div><Badge variant="secondary" className="mb-3 rounded-md text-xs tracking-wider">COMMAND OUTPUT</Badge><h2 id="sessionCommandOutputTitle" className="m-0 text-xl font-semibold">命令输出</h2></div><Button type="button" variant="ghost" size="icon" id="closeSessionCommandOutput" aria-label="关闭命令输出" autoFocus>×</Button></div>
    <pre id="sessionCommandOutputCommand" className="history-command-line" /><div id="sessionCommandOutputMeta" className="session-command-output-meta" />
    <Card className="session-command-output-text gap-0 bg-muted p-4 shadow-none" id="sessionCommandOutputText" tabIndex={0} role="region" aria-label="命令输出内容" />
    <p className="session-command-output-hint">Esc 关闭 · 输出独立滚动，保留对话位置</p>
  </>
}
export function SessionHistoryPanel() {
  return <><div id="assistantChatRoot" /><header className="session-history-header">
    <div className="dialog-header"><div><Badge variant="secondary" id="sessionHistoryEyebrow" className="mb-3 rounded-md text-xs tracking-wider">SESSION HISTORY</Badge><h2 id="sessionHistoryTitle" className="m-0 text-lg font-semibold" tabIndex={-1}>会话详情</h2></div><Button type="button" variant="ghost" size="icon" id="closeSessionHistory" aria-label="关闭会话详情">×</Button></div>
    <div id="sessionHistoryMeta" className="session-history-meta" />
    <div id="newSessionProjectField" className="mt-4" hidden><Field id="newSessionProject" label="工作项目"><NativeSelect id="newSessionProject" aria-label="工作项目" /></Field></div>
    <div className="session-history-toolbar"><span id="sessionHistoryStatus" role="status" aria-live="polite" /><div><Button type="button" variant="outline" size="sm" id="refreshSessionHistory">刷新详情</Button><SessionAction action="resume" id="resumeHistorySession" variant="default">在终端继续 ↗</SessionAction></div></div>
    <Feedback id="sessionHistoryAttention" className="session-history-attention" role="alert" aria-live="polite" tabIndex={0} aria-label="终端待确认事项" hidden />
  </header>
  <div id="sessionHistoryScroll" className="session-history-scroll" tabIndex={0} aria-label="会话历史记录"><Feedback id="sessionHistoryError" variant="destructive" hidden /><Button type="button" variant="outline" size="sm" id="loadOlderHistory" className="history-more mx-auto mb-5 flex w-fit" hidden>加载更早记录</Button><div id="sessionHistoryEntries" /><div id="sessionChatLiveEntries" /></div>
  <div id="sessionChatApprovals" className="session-chat-approvals" aria-live="polite" />
  <form id="sessionChatForm" className="session-chat-form"><div id="sessionChatStatus" role="status" aria-live="polite" /><p id="sessionHandoffNotice" className="session-description" role="status" hidden /><Button type="button" variant="outline" size="sm" id="handoffSessionChat" hidden>切换到侧栏（等本轮结束）</Button><Feedback id="sessionChatError" variant="destructive" hidden />
    <Label htmlFor="sessionChatInput" id="sessionChatLabel" className="text-xs text-muted-foreground">继续这个会话</Label><Textarea id="sessionChatInput" rows={2} maxLength={32000} placeholder="补充说明、询问进展，或交代下一步…" aria-label="会话消息" />
    <div className="session-chat-actions"><small>Ctrl+Enter 发送 · 关闭侧栏后仍会继续运行</small><div><Button type="button" variant="outline" size="sm" id="stopSessionChat" disabled>停止</Button><Button type="submit" size="sm" id="sendSessionChat" disabled>发送</Button></div></div>
  </form></>
}
export function NewSession({ name }: { name: string }) {
  return <Card className="session-new-empty gap-3 border-0 bg-transparent shadow-none"><Badge variant="secondary" className="w-fit rounded-md text-xs tracking-wider">LET’S GET STARTED</Badge><h3 className="m-0 text-xl font-semibold">从这里开始对话</h3><p className="m-0 text-sm leading-relaxed text-muted-foreground">描述你想完成的工作，Codex 将在所选项目中开始。会话会自动关联「{name}」。</p></Card>
}
