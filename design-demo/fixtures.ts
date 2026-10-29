import type { Member, Project, Task, Worktree } from "../frontend/workspace/types"

const checked = "2026-10-28T09:30:00+08:00"
function tree(name: string, branch = "codex/workspace-polish", extra: Partial<Worktree> = {}): Worktree {
  return { path: `/home/demo/workspaces/workspace-polish/${name}`, branch, status_updated_at: checked,
    compare_available: true, comparison_ref: "main", ahead: 3, behind: 0,
    upstream: `origin/${branch}`, sync_available: true, sync_ahead: 0, sync_behind: 0, ...extra }
}
function member(id: string, name: string, extra: Partial<Worktree> = {}): Member {
  const worktree = tree(id, undefined, extra)
  return { project_id: id, project_name: name, path: worktree.path, mode: "new", branch: worktree.branch, base_ref: "main", state: "ready", worktree }
}
export function initialTasks(): Task[] {
  const base = { slug: "workspace-polish", branch: "codex/workspace-polish", path: "/home/demo/workspaces/workspace-polish", state: "ready", primary_project_id: "web-app", environment_id: "local", environment_name: "本机 · Ubuntu", connected: true, created_at: checked }
  const tasks: Task[] = [
    { ...base, id: "workspace-polish", name: "跨项目工作台优化", description: "集中核对项目分支、改动和同步状态；从同一任务中进入工作目录继续开发。", members: [member("web-app", "Web 前端", { dirty: 4, sync_ahead: 2 }), member("api-server", "API 服务"), member("shared-ui", "共享组件", { missing: true })] },
    { ...base, id: "directory-recovery", name: "工作目录恢复与提示", description: "完善目录丢失时的提示，让恢复路径更明确。", members: [member("api-server", "API 服务", { dirty: 2 })] },
    { ...base, id: "review-flow", name: "任务收尾流程梳理", description: "在结束开发前，检查所有关联项目的工作状态。", members: [member("web-app", "Web 前端"), member("api-server", "API 服务")] },
    { ...base, id: "empty-task", name: "下一次技术试验", description: "先记录目标，准备好后再关联项目。", members: [] },
    { ...base, id: "archived-task", name: "统一项目打开方式", description: "统一编辑器和终端的打开入口。", state: "archived", members: [member("web-app", "Web 前端")] },
  ]
  return tasks.map(task => ({ ...task, slug: task.id, branch: `codex/${task.id}`, path: `/home/demo/workspaces/${task.id}`,
    members: task.members.map(m => {
      const path = `/home/demo/workspaces/${task.id}/${m.project_id}`
      const branch = `codex/${task.id}`
      return { ...m, path, branch, worktree: { ...m.worktree!, path, branch, upstream: `origin/${branch}` } }
    }),
  }))
}
export function projectsFor(tasks: Task[]): Project[] {
  return [["web-app", "Web 前端"], ["api-server", "API 服务"], ["shared-ui", "共享组件"]].map(([id, name]) => {
    const linked = tasks.flatMap(task => task.members.filter(m => m.project_id === id).map(m => ({ ...m.worktree!, requirement_id: task.id, requirement_name: task.name })))
    // Several fixture tasks intentionally reuse a directory, as real tasks can.
    const unique = [...new Map(linked.map(t => [t.path, { ...t, requirements: linked.filter(v => v.path === t.path).map(v => ({ id: v.requirement_id, name: v.requirement_name })) }])).values()]
    return { id, name, path: `/home/demo/projects/${id}`, status_updated_at: checked, worktrees: [tree(id, "main", { path: `/home/demo/projects/${id}`, ahead: 0 }), ...unique] }
  })
}
