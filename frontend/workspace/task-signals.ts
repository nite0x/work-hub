import type { Task } from "./types"

export type TaskFilter = "all" | "issues" | "dirty" | "push" | "conflicts"
export function memberSignals(m: Task["members"][number]) {
  const t = m.worktree
  const issues = m.state !== "ready" || !!(m.error || t?.missing || t?.error || t?.prunable || t?.bare)
  return {
    issues,
    dirty: (t?.dirty || 0) > 0,
    push: (t?.sync_ahead || 0) > 0,
    conflicts: !!(t?.conflicts?.length || t?.operation),
    checking: !issues && !t?.status_updated_at,
  }
}
export function taskSignals(task: Task) {
  const values = task.members.map(memberSignals)
  return {issues: values.filter(v => v.issues).length, dirty: values.filter(v => v.dirty).length, push: values.filter(v => v.push).length, conflicts: values.filter(v => v.conflicts).length, checking: values.filter(v => v.checking).length}
}
export function taskMatches(task: Task, filter: TaskFilter) {
  return filter === "all" || (filter === "issues" && task.connected === false) || taskSignals(task)[filter] > 0
}
export const taskFilterLabels: Record<TaskFilter, string> = {all: "全部项目", issues: "目录异常", dirty: "有改动", push: "待推送", conflicts: "Git 操作待处理"}
