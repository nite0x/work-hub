export interface Worktree {
  path: string; branch?: string; head?: string; bare?: boolean; missing?: boolean;
  prunable?: boolean; locked?: boolean; detached?: boolean; error?: string;
  dirty?: number; status_updated_at?: string; compare_available?: boolean;
  comparison_ref?: string; ahead?: number; behind?: number;
  upstream?: string; sync_available?: boolean; sync_ahead?: number; sync_behind?: number;
  operation?: string; merge_head?: string; conflicts?: string[];
  requirement_id?: string; requirement_name?: string;
  requirements?: { id: string; name: string }[];
}
export interface Project {
  id: string; name: string; path: string; folder?: string; error?: string;
  worktrees: Worktree[]; status_updated_at?: string; refreshing?: boolean;
}
export interface Member {
  project_id: string; project_name: string; path: string; state: string;
  mode?: string; branch?: string; base_ref?: string; base_commit?: string;
  worktree?: Worktree; error?: string;
}
export interface Task {
  id: string; name: string; slug: string; description?: string; branch: string;
  path: string; state: string; primary_project_id: string; members: Member[]; has_workspace?: boolean;
  created_at: string; environment_id: string; environment_name: string; connected: boolean;
}
export interface GitBranch {
  name: string; ref: string; kind: string; commit: string; upstream?: string; worktrees: string[];
}
export interface GitOverview {
  project: Project; branches: GitBranch[]; current?: string; master_source?: string;
  remotes: { name: string; url: string }[];
  credentials?: { available?: boolean; message?: string };
}
export interface Choice {
  mode: string; path: string; source: string; branch: string; existingBranch?: string; error?: string;
}
export interface PickerRow {
  project: Project; checked: boolean; choice: Choice; overview?: GitOverview;
  trees: Worktree[]; prefix: string;
}
