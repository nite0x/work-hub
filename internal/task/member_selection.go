package task

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

// MemberSelection describes how a project participates without changing its
// existing checkout. Omitted selections preserve the original new-worktree API.
type MemberSelection struct {
	ProjectID string `json:"project_id"`
	Mode      string `json:"mode"`
	Path      string `json:"path"`
	Source    string `json:"source"`
	Branch    string `json:"branch"`
}

func selectionsByProject(selections []MemberSelection) (map[string]MemberSelection, error) {
	out := map[string]MemberSelection{}
	for _, selection := range selections {
		if _, exists := out[selection.ProjectID]; exists || selection.ProjectID == "" {
			return nil, fmt.Errorf("项目工作目录选择重复或无效")
		}
		out[selection.ProjectID] = selection
	}
	return out, nil
}

func selectedMember(ctx context.Context, p model.Project, directory, branch string, selection MemberSelection) (model.Member, error) {
	m := model.Member{ProjectID: p.ID, ProjectName: p.Name, Mode: selection.Mode, State: "pending"}
	if m.Mode == "" {
		m.Mode = "new"
	}
	if err := verifyRepository(ctx, p); err != nil {
		return m, err
	}
	switch m.Mode {
	case "new":
		m.Branch = strings.TrimSpace(selection.Branch)
		if m.Branch == "" {
			m.Branch = branch
		}
		if m.Branch == "" || len(m.Branch) > 160 || strings.HasPrefix(m.Branch, "-") || strings.Contains(m.Branch, "@{") {
			return m, fmt.Errorf("分支名无效")
		}
		if _, err := workspace.Git(ctx, p.Path, "check-ref-format", "--branch", m.Branch); err != nil {
			return m, fmt.Errorf("分支名无效")
		}
		if _, err := workspace.Git(ctx, p.Path, "rev-parse", "--verify", "--quiet", "refs/heads/"+m.Branch); err == nil {
			return m, fmt.Errorf("分支 %s 已存在，请使用新分支名或选择已有工作目录", m.Branch)
		}
		m.Path = platform.JoinWorkspacePath(directory, p.Folder)
		if !platform.Within(directory, m.Path) {
			return m, fmt.Errorf("worktree 路径越过工作区目录")
		}
		if _, err := workspace.Stat(ctx, m.Path, false); !errors.Is(err, os.ErrNotExist) {
			return m, fmt.Errorf("工作目录已存在或无法检查，不能覆盖：%s", m.Path)
		}
		m.BaseRef = strings.TrimSpace(selection.Source)
		if m.BaseRef == "" {
			m.BaseRef = workspace.DefaultBranchSource(ctx, p.Path)
		}
		if m.BaseRef != "HEAD" {
			if !strings.HasPrefix(m.BaseRef, "refs/heads/") && !strings.HasPrefix(m.BaseRef, "refs/remotes/") {
				return m, fmt.Errorf("请选择本地或远端来源分支")
			}
			if _, err := workspace.Git(ctx, p.Path, "check-ref-format", m.BaseRef); err != nil {
				return m, fmt.Errorf("来源分支无效")
			}
		}
		commit, err := workspace.Git(ctx, p.Path, "rev-parse", "--verify", m.BaseRef+"^{commit}")
		if err != nil {
			return m, fmt.Errorf("来源分支不存在或尚无提交，请重新选择：%s", m.BaseRef)
		}
		m.BaseCommit = strings.TrimSpace(commit)
	case "project", "worktree":
		m.Path = p.Path
		if m.Mode == "worktree" {
			if !platform.AbsoluteWorkspacePath(selection.Path) {
				return m, fmt.Errorf("请选择已有 worktree 的绝对路径")
			}
			m.Path = platform.CleanWorkspacePath(selection.Path)
		}
		if err := VerifyMember(ctx, p, m, ""); err != nil {
			return m, err
		}
		m.Branch, _ = workspace.Git(ctx, m.Path, "symbolic-ref", "--quiet", "--short", "HEAD")
		m.Branch = strings.TrimSpace(m.Branch)
		commit, _ := workspace.Git(ctx, m.Path, "rev-parse", "--verify", "HEAD^{commit}")
		m.BaseCommit = strings.TrimSpace(commit)
	default:
		return m, fmt.Errorf("请选择新建工作目录、项目原目录或已有 worktree")
	}
	return m, nil
}

func verifyRepository(ctx context.Context, p model.Project) error {
	common, err := workspace.Git(ctx, p.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return err
	}
	resolved, err := workspace.Eval(ctx, strings.TrimSpace(common))
	if err != nil || !platform.SameWorkspacePath(resolved, p.CommonDir) {
		return fmt.Errorf("仓库位置已变更，请检查登记路径")
	}
	return nil
}

func memberBranch(m model.Member, fallback string) string {
	if m.Branch != "" {
		return m.Branch
	}
	return fallback
}

func memberDescription(m model.Member) string {
	if m.Mode == "project" || m.Mode == "worktree" {
		return "使用已有工作目录"
	}
	return "新建分支 " + m.Branch + "；来源 " + m.BaseRef + "；提交 " + m.BaseCommit
}
