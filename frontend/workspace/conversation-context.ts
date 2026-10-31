// Directory membership is shared by the list and conversation header. A thread
// can belong to several task scopes; it does not have a single task owner.
export interface ConversationWorkspace {
  tasks: {id: string; name: string; path?: string; members: {project_id: string; project_name: string; path: string; worktree?: {branch?: string; detached?: boolean}}[]}[];
  projects: {id: string; name: string; path: string; worktrees: {path: string; branch?: string; detached?: boolean; missing?: boolean}[]}[];
}
export const directoryKey = (path: string) => {
  let key = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (/^[a-z]:/i.test(key) || key.startsWith("//")) key = key.toLowerCase();
  return key;
};
export function conversationContext(cwd: string, workspace?: ConversationWorkspace, taskID?: string) {
  const key = directoryKey(cwd);
  const matches = (path?: string) => !!cwd && !!path && directoryKey(path) === key;
  const tasks = workspace?.tasks.filter(t => t.id === taskID || matches(t.path) || t.members.some(m => matches(m.path))) || [];
  const project = workspace?.projects.find(p => matches(p.path) || p.worktrees.some(t => matches(t.path)));
  const tree = project?.worktrees.find(t => matches(t.path));
  const member = tasks.flatMap(t => t.members).find(m => matches(m.path));
  const branch = tree?.branch || member?.worktree?.branch;
  const kind = project ? matches(project.path) ? "项目目录" : "Worktree" : member ? "工作目录" : tasks.length ? "任务目录" : "外部目录";
  return {tasks: tasks.map(t => ({id: t.id, name: t.name})), project: project?.name || member?.project_name, projectID: project?.id || member?.project_id, branch: tree?.detached || member?.worktree?.detached ? "detached HEAD" : branch, kind, cwd};
}
