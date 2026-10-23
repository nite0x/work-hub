import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Field, NativeSelect, Option } from "./shared"
import {ApprovalActions, ElicitationFields} from "../chat/approval-fields"
import type {ApprovalChoice, Elicitation} from "../chat/approval"

export interface HistoryEntry {
  id: string; turn_id?: string; kind: string; status?: string; text?: string;
  command?: string; cwd?: string; started_at_ms?: number; completed_at_ms?: number;
}
export interface Question {
  id: string; header?: string; question?: string; isSecret?: boolean;
  options?: { label: string; description?: string }[];
}
export interface Approval {
  id: string; title: string; details?: string; kind?: string; can_accept?: boolean;
  questions?: Question[];
  choices?: ApprovalChoice[]; elicitation?: Elicitation;
}
const commandLabels: Record<string, string> = { completed: "已完成", failed: "失败", declined: "已拒绝", inProgress: "执行中", interrupted: "已停止" }
export function HistoryMessage({ entry, metadata }: { entry: HistoryEntry; metadata: string }) {
  const time = entry.started_at_ms || entry.completed_at_ms
  const when = time ? <time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleString("zh-CN", { hour12: false })}</time> : null
  if (entry.kind === "user" || entry.kind === "assistant") return <Card role="article" className={`history-entry history-${entry.kind} gap-0 p-5 shadow-none ${entry.kind === "user" ? "bg-secondary" : ""}`}><div className="history-entry-heading"><strong>{entry.kind === "user" ? "你" : "Codex"}</strong>{when}</div><div className="history-message">{entry.text || <span className="text-muted-foreground">{entry.status === "inProgress" ? "正在回复…" : "（空消息）"}</span>}</div></Card>
  const status = entry.status && commandLabels[entry.status] ? entry.status : "unknown"
  const preview = (entry.command || "命令未记录").replace(/\s+/g, " ").trim()
  const statusColor = status === "completed" ? "text-emerald-700" : status === "failed" || status === "declined" ? "text-red-700" : status === "inProgress" ? "text-primary" : "text-muted-foreground"
  return <Card role="article" className="history-entry history-command gap-0 bg-muted/50 p-0 shadow-none" data-history-entry={JSON.stringify([entry.turn_id, entry.id])}>
    <details className="history-command-details"><summary><span className="history-command-icon" aria-hidden="true">›_</span><code className="history-command-preview" title={preview}>{preview}</code><Badge variant="outline" className={`history-command-badge ${status} ${statusColor} rounded-md border-0 bg-transparent px-1 py-0 text-[11px]`}>{commandLabels[status] || "状态未记录"}</Badge><span className="history-command-chevron" aria-hidden="true">›</span></summary><div className="history-command-body"><div className="history-entry-heading"><strong>命令执行</strong>{when}</div><pre className="history-command-line">{entry.command || "命令未记录"}</pre><div className="history-command-cwd">工作目录 · {entry.cwd || "未记录"}</div><div className={`history-command-status ${status}`}>{metadata}</div></div></details>
    <Button type="button" variant="ghost" size="sm" className="history-output-button h-7 rounded-md px-2 text-xs text-primary" data-command-output="" aria-label="查看命令输出" aria-haspopup="dialog">输出 ↗</Button>
  </Card>
}
export function FileChange({ text, status }: { text?: string; status?: string }) {
  return <Card role="article" className="history-entry gap-0 p-5 shadow-none"><div className="history-entry-heading"><strong>文件修改</strong><Badge variant="secondary">{status}</Badge></div><pre className="history-command-line">{text}</pre></Card>
}
export function ChatApprovals({ approvals }: { approvals: Approval[] }) {
  return <>{approvals.map(a => <form key={a.id} className="chat-approval" data-chat-approval={a.id}><Card className="gap-3 rounded-lg bg-background p-4 shadow-none"><strong>{a.title}</strong>{a.details ? <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{a.details}</pre> : null}<ElicitationFields elicitation={a.elicitation} />{(a.questions || []).map(q => <div key={q.id} className="chat-question"><Field id={`approval-${a.id}-${q.id}-answer`} label={`${q.header || ""} · ${q.question || ""}`}>{q.options?.length ? <NativeSelect data-answer-for={q.id} aria-label={`${q.header || q.question || "问题"}的选项`}><Option value="">选择一个回答，或在下方补充</Option>{q.options.map(o => <Option key={o.label} value={o.label}>{o.label}{o.description ? ` — ${o.description}` : ""}</Option>)}</NativeSelect> : null}<Input id={`approval-${a.id}-${q.id}-answer`} type={q.isSecret ? "password" : "text"} data-free-answer-for={q.id} autoComplete="off" placeholder="输入回答或补充说明" /></Field></div>)}<div className="detail-actions"><ApprovalActions approval={a} /></div></Card></form>)}</>
}
export function HistoryAttention({ connected, confirmations }: { connected?: boolean; confirmations: Approval[] }) {
  return <><strong>{connected ? "需要你处理" : "待确认状态尚未核实"}{confirmations.length ? ` · ${confirmations.length} 项` : ""}</strong><p>{connected ? "请回到原终端回答或确认，处理后此提醒会自动消失。" : "实时连接已断开，以下提示可能已处理；重连后会重新核实，请以原终端为准。"}</p>{confirmations.map((item, index) => <Card key={index} className="session-confirmation gap-2 rounded-md border-0 bg-transparent p-2 shadow-none"><strong>{item.title}</strong>{item.details ? <pre>{item.details}</pre> : null}{(item.questions || []).map((question, index) => <div key={index}><p><strong>{question.header}</strong>{question.header ? " · " : ""}{question.question}</p>{question.options?.length ? <ul>{question.options.map((option, index) => <li key={index}>{option.label}{option.description ? `：${option.description}` : ""}</li>)}</ul> : null}</div>)}</Card>)}{!confirmations.length ? <p>终端正在等待审批或回答，请在终端查看具体问题。</p> : null}</>
}
