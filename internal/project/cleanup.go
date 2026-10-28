package project

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

type CleanupCandidate struct {
	ProjectID   string   `json:"project_id"`
	ProjectName string   `json:"project_name"`
	Path        string   `json:"path"`
	Branch      string   `json:"branch"`
	Head        string   `json:"head"`
	Current     bool     `json:"current"`
	Dirty       int      `json:"dirty"`
	Unpushed    int      `json:"unpushed"`
	Ignored     bool     `json:"ignored"`
	Shared      []string `json:"shared"`
	Reasons     []string `json:"reasons"`
	Cleanable   bool     `json:"cleanable"`
	Fingerprint string   `json:"fingerprint"`
}

func cleanupCurrent(q model.Requirement, project, path string) bool {
	for _, m := range q.Members {
		if m.ProjectID == project && platform.SameWorkspacePath(m.Path, path) {
			return true
		}
	}
	return false
}

func (a *Service) inspectCleanup(ctx context.Context, p model.Project, q model.Requirement, qs []model.Requirement, path string) CleanupCandidate {
	v := CleanupCandidate{ProjectID: p.ID, ProjectName: p.Name, Path: path, Current: cleanupCurrent(q, p.ID, path), Shared: []string{}, Reasons: []string{}}
	if !platform.AbsoluteWorkspacePath(q.Path) || !platform.Within(q.Path, path) || platform.SameWorkspacePath(path, p.Path) {
		v.Reasons = append(v.Reasons, "项目原目录或任务工作区外的目录，仅检查，不提供清理")
	}
	if v.Current && q.State != "archived" {
		v.Reasons = append(v.Reasons, "当前仍关联任务，请先归档任务")
	}
	for _, other := range qs {
		if other.ID == q.ID {
			continue
		}
		for _, m := range other.Members {
			if m.ProjectID == p.ID && platform.SameWorkspacePath(m.Path, path) {
				v.Shared = append(v.Shared, other.Name)
				break
			}
		}
	}
	sort.Strings(v.Shared)
	if len(v.Shared) > 0 {
		v.Reasons = append(v.Reasons, "其他任务仍引用此目录："+strings.Join(v.Shared, "、"))
	}
	t, err := selectedWorktree(ctx, p, path)
	if err != nil {
		v.Reasons = append(v.Reasons, err.Error())
	} else {
		v.Branch, v.Head, v.Dirty, v.Unpushed = t.Branch, t.Head, t.Dirty, t.SyncAhead
		if t.Locked {
			v.Reasons = append(v.Reasons, "Worktree 已锁定")
		}
		if t.Detached {
			v.Reasons = append(v.Reasons, "游离 HEAD，请先为提交保留分支")
		}
		if t.Dirty > 0 {
			v.Reasons = append(v.Reasons, fmt.Sprintf("有 %d 项未提交修改或未跟踪文件", t.Dirty))
		}
		if t.Operation != "" {
			v.Reasons = append(v.Reasons, "有未完成的 Git 操作："+t.Operation)
		}
		if st, e := workspace.Stat(ctx, platform.JoinWorkspacePath(path, ".git"), false); e != nil || st.IsDir() {
			v.Reasons = append(v.Reasons, "不是可清理的附属 Worktree")
		}
		if resolved, e := workspace.Eval(ctx, path); e != nil || !platform.SameWorkspacePath(path, resolved) {
			v.Reasons = append(v.Reasons, "目录真实路径已变化")
		}
		ignored, e := workspace.Git(ctx, path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z")
		v.Ignored = ignored != ""
		if e != nil {
			v.Reasons = append(v.Reasons, "无法检查忽略文件")
		} else if v.Ignored {
			v.Reasons = append(v.Reasons, "存在忽略文件，请先在终端检查并移走需要保留的内容")
		}
		if t.Upstream != "" {
			if !t.SyncAvailable {
				v.Reasons = append(v.Reasons, "无法比较上游，请先获取远端确认提交")
			}
			if t.SyncAhead > 0 {
				v.Reasons = append(v.Reasons, fmt.Sprintf("有 %d 个待推送提交", t.SyncAhead))
			}
		} else {
			// With no upstream, allow only commits reachable from another retained
			// baseline or a remote reference. The branch itself is always retained.
			published, e := workspace.Git(ctx, path, "for-each-ref", "--format=%(refname)", "--contains", t.Head, "refs/remotes")
			if e != nil {
				v.Reasons = append(v.Reasons, "无法检查提交保留状态")
			} else if strings.TrimSpace(published) == "" {
				base := workspace.DefaultBranchSource(ctx, path)
				_, e := workspace.Git(ctx, path, "merge-base", "--is-ancestor", t.Head, base)
				if base == "HEAD" || base == "refs/heads/"+t.Branch || e != nil {
					v.Reasons = append(v.Reasons, "没有上游，且提交尚未包含在其他保留基线中")
				}
			}
		}
	}
	v.Cleanable = len(v.Reasons) == 0
	raw, _ := json.Marshal([]any{q.ID, q.Path, q.State, p.CommonDir, v})
	v.Fingerprint = fmt.Sprintf("%x", sha256.Sum256(raw))
	return v
}

func (a *Service) TaskReviewHandler(w http.ResponseWriter, r *http.Request) {
	q, err := a.Workspace.Store.Requirement(r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "任务不存在")
		return
	}
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	qs, err := a.Workspace.Store.Requirements()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	ps, err := a.Workspace.Store.Projects()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	items := []CleanupCandidate{}
	for _, p := range ps {
		paths := map[string]bool{}
		for _, m := range q.Members {
			if m.ProjectID == p.ID {
				paths[m.Path] = true
			}
		}
		raw, e := workspace.Git(r.Context(), p.Path, "worktree", "list", "--porcelain", "-z")
		if e == nil {
			for _, t := range ParseWorktrees(raw) {
				if platform.Within(q.Path, t.Path) {
					paths[t.Path] = true
				}
			}
		}
		if len(paths) == 0 {
			continue
		}
		unlock := a.lockGit(p.CommonDir)
		valid, lookupErr := a.RegisteredProject(r.Context(), p.ID)
		for path := range paths {
			if lookupErr != nil {
				items = append(items, CleanupCandidate{ProjectID: p.ID, ProjectName: p.Name, Path: path, Current: cleanupCurrent(q, p.ID, path), Reasons: []string{lookupErr.Error()}})
			} else {
				items = append(items, a.inspectCleanup(r.Context(), valid, q, qs, path))
			}
		}
		unlock()
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].ProjectName != items[j].ProjectName {
			return items[i].ProjectName < items[j].ProjectName
		}
		return items[i].Path < items[j].Path
	})
	httpx.WriteJSON(w, 200, map[string]any{"task": q, "items": items})
}

func (a *Service) CleanupWorktreeHandler(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path        string `json:"path"`
		Fingerprint string `json:"fingerprint"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Path == "" || in.Fingerprint == "" {
		httpx.WriteError(w, 400, "请先检查并选择具体目录")
		return
	}
	a.Workspace.GitActivity.RLock()
	defer a.Workspace.GitActivity.RUnlock()
	if a.Workspace.Closing.Load() {
		httpx.WriteError(w, 503, "后台正在退出")
		return
	}
	p, err := a.RegisteredProject(r.Context(), r.PathValue("project"))
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	unlock := a.lockGit(p.CommonDir)
	defer unlock()
	if a.ReserveWorktree != nil {
		release, err := a.ReserveWorktree(r.Context(), in.Path)
		if err != nil {
			httpx.WriteError(w, 409, err.Error())
			return
		}
		defer release()
	}
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	q, err := a.Workspace.Store.Requirement(r.PathValue("id"))
	if err != nil {
		httpx.WriteError(w, 404, "任务不存在")
		return
	}
	qs, err := a.Workspace.Store.Requirements()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	v := a.inspectCleanup(r.Context(), p, q, qs, in.Path)
	if !v.Cleanable {
		httpx.WriteJSON(w, 409, map[string]any{"error": "目录当前不能清理", "details": v.Reasons})
		return
	}
	if v.Fingerprint != in.Fingerprint {
		httpx.WriteError(w, 409, "检查结果已过期，请重新检查后选择目录")
		return
	}
	// No --force, branch deletion, recursive filesystem deletion or prune.
	if _, err := workspace.GitOperation(r.Context(), p.Path, "worktree", "remove", "--", in.Path); err != nil {
		httpx.WriteError(w, 409, "清理未完成，现场已保留："+RedactGitOutput(err.Error()))
		return
	}
	_, err = a.Workspace.Store.DB.Exec(`UPDATE members SET state='removed',branch=?,error='目录已清理；取消归档后可重试恢复，或更换工作目录' WHERE requirement_id=? AND project_id=? AND path=?`, v.Branch, q.ID, p.ID, in.Path)
	if err != nil {
		httpx.WriteError(w, 500, "目录已清理，但任务记录更新失败，请刷新核对："+err.Error())
		return
	}
	message := "已清理 Worktree 目录，分支和会话记录保留"
	warning := ""
	if a.TaskContextUpdated != nil {
		if current, err := a.Workspace.Store.Requirement(q.ID); err == nil {
			if err := a.TaskContextUpdated(r.Context(), current); err != nil {
				warning = "任务上下文更新失败：" + err.Error()
			}
		}
	}
	httpx.WriteJSON(w, 200, map[string]string{"message": message, "context_warning": warning})
}
