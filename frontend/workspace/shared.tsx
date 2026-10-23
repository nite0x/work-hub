import type { ComponentProps, ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert } from "@/components/ui/alert"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption as Option, NativeSelectOptGroup } from "@/components/ui/native-select"
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { GitOverview, Member, Task, Worktree } from "./types"

export const statusLabels: Record<string, string> = { ready: "已就绪", partial: "部分就绪", archived: "已归档", creating: "创建中", pending: "待创建", failed: "创建失败" }
const tones: Record<string, string> = {
  ready: "border-emerald-200 bg-emerald-50 text-emerald-800",
  partial: "border-amber-200 bg-amber-50 text-amber-800", warning: "border-amber-200 bg-amber-50 text-amber-800",
  failed: "border-red-200 bg-red-50 text-red-800", "primary-tag": "border-indigo-200 bg-indigo-50 text-indigo-800",
}
export function StatusBadge({ kind, children }: { kind: string; children?: ReactNode }) {
  return <Badge variant="outline" className={cn("shrink-0 rounded-md px-2 py-1 text-xs", tones[kind] || "border-border bg-secondary text-muted-foreground")}>{children || statusLabels[kind] || kind}</Badge>
}
export function Branch({ children }: { children?: ReactNode }) {
  return <Badge variant="secondary" className="branch rounded-md font-mono text-xs font-normal">{children || "detached HEAD"}</Badge>
}
export function TreeStatus({ tree: t, pending = false }: { tree?: Worktree; pending?: boolean }) {
  if (!t) return <StatusBadge kind={pending ? "neutral" : "failed"}>{pending ? "正在发现目录" : "目录未发现"}</StatusBadge>
  if (t.missing) return <StatusBadge kind="failed">目录丢失</StatusBadge>
  if (t.error) return <StatusBadge kind="failed">读取失败</StatusBadge>
  if (t.prunable) return <StatusBadge kind="warning">待修复登记</StatusBadge>
  if (!t.status_updated_at) return <StatusBadge kind="neutral">正在检查</StatusBadge>
  return <><StatusBadge kind={t.dirty ? "warning" : "ready"}>{t.dirty ? `${t.dirty} 项修改` : "干净"}</StatusBadge><div className="comparison status-checked-at">上次检查 <time data-status-path={t.path} dateTime={t.status_updated_at}>{new Date(t.status_updated_at).toLocaleTimeString("zh-CN", { hour12: false })}</time></div></>
}
export const reusesDirectory = (m: Member) => m.mode === "project" || m.mode === "worktree"
export const expectedBranch = (m: Member, q: Task) => m.branch || q.branch
export const canOpenMember = (m: Member) => m.state === "ready" && !!m.worktree?.status_updated_at && !m.worktree.bare && !m.worktree.missing && !m.worktree.prunable && !m.worktree.error
export const branchSummary = (q: Task) => [...new Set(q.members.map(m => m.worktree?.branch || m.branch || (reusesDirectory(m) ? "detached HEAD" : q.branch)).filter(Boolean))].join(" · ") || "使用已有工作目录"

export function GitSyncStatus({ tree: t }: { tree?: Worktree }) {
  if (!t?.status_updated_at) return null
  return <div className="comparison space-y-1" title="同步数量基于本地最近获取的上游记录；获取远端后更新。">
    <div>{t.detached ? "游离 HEAD" : !t.upstream ? "尚未设置上游 · 推送时发布分支" : !t.sync_available ? `上游 ${t.upstream} 不可用，请获取远端` : <>上游 {t.upstream}<br />待推送 {t.sync_ahead || 0} · 待拉取 {t.sync_behind || 0}{t.sync_ahead && t.sync_behind ? " · 已分歧" : ""}</>}</div>
    {t.operation ? <div className="font-medium text-amber-800">{t.operation === "merge" ? `合并进行中${t.conflicts?.length ? ` · ${t.conflicts.length} 个冲突文件` : " · 等待完成提交"}` : `${t.operation} 进行中`}</div> : null}
  </div>
}

export function Action({ action, id, children, ...props }: ComponentProps<typeof Button> & { action: string; id?: string }) {
  return <Button type="button" variant="outline" size="sm" data-action={action} data-id={id} {...props}>{children}</Button>
}

export function ProjectOpenActions({ project, path, disabled }: { project: string; path: string; disabled?: boolean }) {
  return <div className="workspace-project-actions mt-2"><Action action="project-open-remote" id={project} data-path={path} disabled={disabled}>远端仓库 ↗</Action><Action action="project-open-vscode" id={project} data-path={path} disabled={disabled}>VS Code ↗</Action><Action action="project-open-idea" id={project} data-path={path} disabled={disabled}>IDEA ↗</Action></div>
}
export function Field({ id, label, help, required, children, ...props }: ComponentProps<"div"> & { id: string; label: string; help?: string; required?: boolean; children: ReactNode }) {
  return <div {...props} className={cn("field grid gap-2", props.className)}><Label htmlFor={id} className="leading-relaxed">{label}{required ? <span className="text-destructive" aria-hidden="true"> *</span> : null}</Label>{children}{help ? <small className="text-xs leading-relaxed text-muted-foreground">{help}</small> : null}</div>
}
export function Check({ label, ...props }: ComponentProps<"input"> & { label: ReactNode }) {
  return <Label className="flex min-h-9 cursor-pointer items-center gap-2 leading-relaxed"><Input {...props} type="checkbox" className="m-0 size-4 min-w-4 shrink-0 accent-primary shadow-none" /><span>{label}</span></Label>
}
export function Feedback({ variant, className, ...props }: ComponentProps<typeof Alert>) {
  return <Alert variant={variant} {...props} className={cn("block whitespace-pre-wrap text-sm leading-relaxed", className)} />
}
export function Preview({ title, id }: { title: string; id: string }) {
  return <Card className="gap-2 rounded-lg bg-muted p-4 shadow-none"><div className="text-xs text-muted-foreground">{title}</div><pre id={id} className="m-0 whitespace-pre-wrap break-all font-mono text-sm leading-relaxed" /></Card>
}
export function ModalHeader({ id, title, eyebrow }: { id: string; title: string; eyebrow: string }) {
  return <div className="dialog-header mb-4 gap-4"><div><Badge variant="secondary" className="mb-3 rounded-md text-xs tracking-wider">{eyebrow}</Badge><h2 id={id} className="m-0 text-xl font-semibold">{title}</h2></div><Button type="button" variant="ghost" size="icon" className="close-dialog shrink-0" aria-label="关闭">×</Button></div>
}
export function ModalFooter({ children, note }: { children: ReactNode; note?: string }) {
  return <div className="dialog-footer">{note ? <span className="footer-note">{note}</span> : null}<Button type="button" variant="outline" className="close-dialog">取消</Button>{children}</div>
}
export function DataTable({ headers, children, label }: { headers: string[]; children: ReactNode; label: string }) {
  return <Table aria-label={label}><TableHeader><TableRow>{headers.map((title, index) => <TableHead key={index} className="bg-muted px-3 text-xs text-muted-foreground">{title}</TableHead>)}</TableRow></TableHeader><TableBody>{children}</TableBody></Table>
}
export function SourceOptions({ overview: v, includeHead = true }: { overview: GitOverview; includeHead?: boolean }) {
  return <><Option value="">请选择来源分支</Option>{[["远端分支", "remote"], ["本地分支", "local"]].map(([label, kind]) => {
    const branches = v.branches.filter(b => b.kind === kind)
    return branches.length ? <NativeSelectOptGroup key={kind} label={label}>{branches.map(b => <Option key={b.ref} value={b.ref}>{b.name} · {b.commit.slice(0, 8)}</Option>)}</NativeSelectOptGroup> : null
  })}{includeHead ? <Option value="HEAD">当前 HEAD（{v.current || "detached"}，请明确确认基线）</Option> : null}</>
}
export function EmptyState({ title, description, action, button, href }: { title: string; description: string; action?: string; button?: string; href?: string }) {
  return <Card className="shadcn-scope min-h-72 items-center justify-center gap-4 rounded-none border-0 p-8 text-center shadow-none"><h2 className="m-0 text-lg font-semibold">{title}</h2><p className="m-0 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>{action ? <Action action={action} variant="default">＋ {button}</Action> : href ? <Button variant="outline" asChild><a href={href}>{button}</a></Button> : null}</Card>
}
export { NativeSelect, Option }
