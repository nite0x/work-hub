import { Button } from "@/components/ui/button"
import { Feedback, ModalHeader } from "./shared"

export interface CleanupCandidate {
  project_id: string; project_name: string; path: string; branch: string; head: string;
  current: boolean; dirty: number; unpushed: number; ignored: boolean; shared: string[];
  reasons: string[]; cleanable: boolean; fingerprint: string;
}
export interface ChangedFile { path: string; previous?: string; index: string; working: string; untracked: boolean }

export function TaskReviewDialog() {
  return <><ModalHeader id="taskReviewTitle" title="任务收尾检查" eyebrow="TASK REVIEW" />
    <p className="dialog-description" id="taskReviewDescription">检查当前项目及任务工作区中保留的旧 Worktree。清理前会重新检查修改、提交、引用和活动会话。</p>
    <div className="flex flex-wrap gap-2 mb-3"><Button type="button" variant="outline" id="taskReviewRefresh">重新检查</Button><Button type="button" variant="outline" id="taskReviewArchive">归档任务并重新检查</Button></div>
    <div id="taskReviewItems" aria-live="polite" />
    <Feedback id="taskReviewError" variant="destructive" hidden />
    <p className="text-sm text-muted-foreground mt-4">只移除选中的 Worktree 目录，分支与会话记录保留。原项目目录、共享目录及存在未确认内容的目录不可清理。</p>
    <div className="dialog-footer"><Button type="button" variant="outline" className="close-dialog">关闭</Button><Button type="button" id="taskReviewClean" disabled>清理所选目录</Button></div>
  </>
}
export function TaskReviewItems({items}: {items: CleanupCandidate[]}) {
  if (!items.length) return <p className="task-project-empty">没有需要检查的工作目录。</p>
  return <div className="task-review-items">{items.map((item,i) => <article className="task-review-item" key={`${item.project_id}:${item.path}`}>
    <label className="flex items-start gap-3"><input type="checkbox" data-cleanup-index={i} disabled={!item.cleanable} aria-label={`选择清理 ${item.path}`} /><span className="min-w-0"><strong>{item.project_name}</strong><span className="quiet"> · {item.current ? "当前关联目录" : "任务工作区中的旧目录"}</span><code className="block break-all mt-1">{item.path}</code></span></label>
    <div className="text-sm mt-2">分支 {item.branch || "未检出"} · {item.dirty || 0} 项改动 · {item.unpushed || 0} 个待推送提交</div>
    {item.cleanable ? <p className="text-sm text-emerald-700">检查通过，可选择清理；执行前会再次核实。</p> : <ul className="text-sm text-amber-800 list-disc pl-5">{item.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
  </article>)}</div>
}
export function ChangesDialog() {
  return <><ModalHeader id="changesTitle" title="项目文件与改动" eyebrow="FILES & CHANGES" />
    <div id="changesBrowser" />
    <div className="dialog-footer"><Button type="button" variant="outline" className="close-dialog">关闭</Button></div>
  </>
}
