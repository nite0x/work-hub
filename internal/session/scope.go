package session

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/project"
	"worktree-hub/internal/workspace"
)

// A scope is a query, never an owner of a session. A nil directory set lists all
// sessions in this environment; an empty set lists none.
type sessionScope struct {
	paths      []string
	pins       map[string]bool
	linkedOnly bool
	cwd        string
}

type invalidSessionTarget string

func (e invalidSessionTarget) Error() string { return string(e) }

func (s sessionScope) includes(id, cwd string) bool {
	if s.cwd != "" && !platform.SameWorkspacePath(s.cwd, cwd) {
		return false
	}
	if s.paths == nil || s.pins[id] {
		return true
	}
	if s.linkedOnly {
		return false
	}
	for _, p := range s.paths {
		if platform.SameWorkspacePath(p, cwd) {
			return true
		}
	}
	return false
}

func uniqueDirectories(paths []string) []string {
	out := []string{}
	for _, p := range paths {
		if p == "" {
			continue
		}
		p = platform.CleanWorkspacePath(p)
		found := false
		for _, old := range out {
			if platform.SameWorkspacePath(old, p) {
				found = true
				break
			}
		}
		if !found {
			out = append(out, p)
		}
	}
	return out
}

func (a *Service) taskScope(id string) (sessionScope, error) {
	q, err := a.Workspace.Store.Requirement(id)
	if err != nil {
		return sessionScope{}, err
	}
	pins, err := a.Workspace.Store.PinnedSessionIDs(id)
	return sessionScope{paths: uniqueDirectories(requirementSessionPaths(q)), pins: pins}, err
}

func (a *Service) projectScope(ctx context.Context, id string) (sessionScope, error) {
	p, err := project.LookupProject(ctx, a.Workspace, id)
	if err != nil {
		return sessionScope{}, err
	}
	return projectDirectoryScope(ctx, p)
}

func projectDirectoryScope(ctx context.Context, p model.Project) (sessionScope, error) {
	raw, err := workspace.Git(ctx, p.Path, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return sessionScope{}, err
	}
	paths := []string{}
	for _, tree := range project.ParseWorktrees(raw) {
		if !tree.Bare {
			paths = append(paths, tree.Path)
		}
	}
	return sessionScope{paths: uniqueDirectories(paths)}, nil
}

func (a *Service) queryScope(r *http.Request) (sessionScope, error) {
	taskID, projectID, cwd := r.URL.Query().Get("task_id"), r.URL.Query().Get("project_id"), r.URL.Query().Get("cwd")
	if legacy := r.PathValue("id"); legacy != "" {
		taskID = legacy
	}
	if taskID != "" && projectID != "" {
		return sessionScope{}, fmt.Errorf("请选择任务范围或项目范围")
	}
	scope := sessionScope{}
	var err error
	if taskID != "" {
		scope, err = a.taskScope(taskID)
		scope.linkedOnly = r.URL.Query().Get("linked") == "true"
	}
	if projectID != "" {
		scope, err = a.projectScope(r.Context(), projectID)
	}
	if err != nil {
		return scope, err
	}
	if cwd != "" {
		if !platform.AbsoluteWorkspacePath(cwd) {
			return scope, fmt.Errorf("工作目录必须是绝对路径")
		}
		directoryScope := scope
		directoryScope.linkedOnly = false
		if !directoryScope.includes("", cwd) {
			linkedDirectory := false
			for id := range scope.pins {
				s, readErr := a.Workspace.Store.Session(id)
				if readErr == nil && platform.SameWorkspacePath(s.Cwd, cwd) {
					linkedDirectory = true
					break
				}
			}
			if !linkedDirectory {
				return scope, fmt.Errorf("工作目录不在所选范围内")
			}
		}
		scope.cwd = cwd
		scope.paths = uniqueDirectories([]string{cwd})
		if !scope.linkedOnly {
			scope.pins = nil
		}
	}
	return scope, nil
}

func (a *Service) cachedScope(scope sessionScope) ([]model.Session, error) {
	all, err := a.Workspace.Store.Sessions()
	if err != nil {
		return nil, err
	}
	out := []model.Session{}
	for _, s := range all {
		if scope.includes(s.ID, s.Cwd) {
			if scope.pins[s.ID] {
				s.Source = "manual"
			}
			out = append(out, s)
		}
	}
	return out, nil
}

// Global operations identify a thread only by the environment's Store plus
// session ID, with no task readiness requirement.
func (a *Service) requestSession(w http.ResponseWriter, r *http.Request) (model.Session, bool) {
	id := r.PathValue("session")
	s, err := a.Workspace.Store.Session(id)
	if errors.Is(err, sql.ErrNoRows) {
		c, openErr := a.openSessions(r.Context())
		if openErr != nil {
			httpx.WriteError(w, 503, openErr.Error())
			return s, false
		}
		defer c.Close()
		var current codex.Session
		titleObservedAt := time.Now().UnixNano()
		current, err = readSession(c, id)
		if err == nil {
			err = a.SaveSession("", current, "codex", titleObservedAt)
			if err == nil {
				s, err = a.Workspace.Store.Session(id)
			}
		}
	}
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpx.WriteError(w, 404, "会话不存在")
		} else {
			httpx.WriteError(w, 503, err.Error())
		}
		return s, false
	}
	return s, true
}

// SessionTarget selects the initial execution directory. Task/project fields are
// resolved at the HTTP boundary and are not persisted as session ownership.
type SessionTarget struct {
	TaskID                string    `json:"task_id,omitempty"`
	ProjectID             string    `json:"project_id,omitempty"`
	Cwd                   string    `json:"cwd,omitempty"`
	AdditionalDirectories *[]string `json:"additional_directories,omitempty"`
}

type executionContext struct {
	plan         model.LaunchPlan
	instructions string
}

func (a *Service) resolveCreation(ctx context.Context, target SessionTarget) (executionContext, error) {
	var out executionContext
	if target.TaskID != "" {
		q, err := a.Workspace.Store.Requirement(target.TaskID)
		if err != nil {
			return out, err
		}
		if q.State == "archived" {
			return out, fmt.Errorf("请先取消归档再新建任务会话")
		}
		selected := target.Cwd
		if selected == "" {
			projectID := target.ProjectID
			if projectID == "" {
				projectID = q.PrimaryProjectID
			}
			for _, m := range q.Members {
				if m.ProjectID == projectID {
					selected = m.Path
					break
				}
			}
		}
		allowed := map[string]bool{}
		for _, m := range q.Members {
			if m.State == "ready" {
				allowed[platform.CleanWorkspacePath(m.Path)] = true
			}
		}
		// A materialized task workspace is also a valid explicit target.
		if info, statErr := workspace.Stat(ctx, q.Path, false); statErr == nil && info.IsDir() && q.HasWorkspace {
			allowed[platform.CleanWorkspacePath(q.Path)] = true
		}
		selected = platform.CleanWorkspacePath(selected)
		if !allowed[selected] {
			return out, invalidSessionTarget("请选择任务中可用的工作目录")
		}
		if target.ProjectID != "" {
			found := false
			for _, m := range q.Members {
				if m.ProjectID == target.ProjectID && platform.SameWorkspacePath(m.Path, selected) {
					found = true
				}
			}
			if !found {
				return out, invalidSessionTarget("工作目录与所选项目不匹配")
			}
		}
		dirs := []string{}
		for _, m := range q.Members {
			if m.State == "ready" {
				dirs = append(dirs, m.Path)
			}
		}
		if target.AdditionalDirectories != nil {
			dirs = *target.AdditionalDirectories
		}
		out.plan = model.LaunchPlan{Cwd: selected, Title: "Codex", AdditionalDirectories: []string{}}
		for _, dir := range uniqueDirectories(append([]string{selected}, dirs...)) {
			if !allowed[platform.CleanWorkspacePath(dir)] {
				return out, invalidSessionTarget("附加目录不属于任务的可用工作目录")
			}
			info, statErr := workspace.Stat(ctx, dir, false)
			if statErr != nil || !info.IsDir() {
				return out, fmt.Errorf("工作目录不可用：%s", dir)
			}
			for _, m := range q.Members {
				if !platform.SameWorkspacePath(m.Path, dir) {
					continue
				}
				p, lookupErr := project.LookupProject(ctx, a.Workspace, m.ProjectID)
				if lookupErr != nil {
					return out, lookupErr
				}
				common, gitErr := workspace.Git(ctx, dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
				if gitErr != nil {
					return out, gitErr
				}
				resolved, evalErr := workspace.Eval(ctx, strings.TrimSpace(common))
				if evalErr != nil || !platform.SameWorkspacePath(resolved, p.CommonDir) {
					return out, fmt.Errorf("工作目录的仓库归属已变化")
				}
				if m.Mode != "project" && m.Mode != "worktree" {
					branch, branchErr := workspace.Git(ctx, dir, "symbolic-ref", "--quiet", "--short", "HEAD")
					expected := m.Branch
					if expected == "" {
						expected = q.Branch
					}
					if branchErr != nil || strings.TrimSpace(branch) != expected {
						return out, fmt.Errorf("实际分支与任务记录不一致，请先核对 %s", m.ProjectName)
					}
				}
			}
			if !platform.SameWorkspacePath(dir, selected) {
				out.plan.AdditionalDirectories = append(out.plan.AdditionalDirectories, dir)
			}
		}
		out.instructions = "当前工作属于任务 " + q.Name + "。任务说明：\n" + q.Description + "\n请遵循各工作目录适用的 AGENTS.md；各项目的 Git、构建及测试在对应仓库执行。"
		if allowed[platform.CleanWorkspacePath(q.Path)] {
			out.instructions += " 可参考任务目录中的 " + platform.JoinWorkspacePath(q.Path, "BRIEF.md") + "。任务目标以本次提供的说明为准。"
		}
	} else {
		if target.ProjectID == "" {
			return out, invalidSessionTarget("请选择项目及工作目录，或任务")
		}
		p, err := project.LookupProject(ctx, a.Workspace, target.ProjectID)
		if err != nil {
			return out, err
		}
		scope, err := projectDirectoryScope(ctx, p)
		if err != nil {
			return out, err
		}
		if target.Cwd == "" || !scope.includes("", target.Cwd) {
			return out, invalidSessionTarget("请选择项目实际存在的 worktree 工作目录")
		}
		out.plan = model.LaunchPlan{Cwd: platform.CleanWorkspacePath(target.Cwd), Title: "Codex", AdditionalDirectories: []string{}}
		out.instructions = "开始修改前先阅读当前工作目录下适用的 AGENTS.md；Git、构建及测试在对应仓库执行。"
		// Verify the selected worktree still belongs to the registered repository.
		common, err := workspace.Git(ctx, out.plan.Cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if err != nil {
			return out, err
		}
		resolved, err := workspace.Eval(ctx, strings.TrimSpace(common))
		if err != nil || !platform.SameWorkspacePath(resolved, p.CommonDir) {
			return out, fmt.Errorf("工作目录的仓库归属已变化")
		}
	}
	info, err := workspace.Stat(ctx, out.plan.Cwd, true)
	if err != nil || !info.IsDir() {
		return out, fmt.Errorf("工作目录不可用")
	}
	return out, nil
}
