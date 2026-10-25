package project

import (
	"context"
	"fmt"
	"strings"

	"worktree-hub/internal/workspace"
)

func hasRemote(v GitOverview, name string) bool {
	for _, remote := range v.Remotes {
		if remote.Name == name && !strings.HasPrefix(name, "-") {
			return true
		}
	}
	return false
}

func validBranchName(ctx context.Context, path, name string) error {
	if name == "" || len(name) > 160 || strings.HasPrefix(name, "-") || strings.Contains(name, "@{") {
		return fmt.Errorf("分支名无效")
	}
	if _, err := workspace.Git(ctx, path, "check-ref-format", "refs/heads/"+name); err != nil {
		return fmt.Errorf("分支名无效")
	}
	return nil
}

func (a *Service) validateGitTask(project string, in GitAction) error {
	q, err := a.Workspace.Store.Requirement(in.RequirementID)
	if err != nil {
		return fmt.Errorf("任务不可用，请刷新")
	}
	if q.State == "archived" || q.State == "creating" {
		return fmt.Errorf("任务尚未就绪或已归档")
	}
	for _, m := range q.Members {
		if m.ProjectID == project && m.Path == in.Path && m.State == "ready" {
			return nil
		}
	}
	return fmt.Errorf("所选目录不是当前任务关联的项目目录")
}

func (a *Service) checkSharedSwitch(project string, in GitAction) error {
	if in.AllowShared {
		return nil
	}
	qs, err := a.Workspace.Store.Requirements()
	if err != nil {
		return err
	}
	var names []string
	for _, q := range qs {
		if q.ID == in.RequirementID {
			continue
		}
		for _, m := range q.Members {
			if m.ProjectID == project && m.Path == in.Path {
				names = append(names, q.Name)
			}
		}
	}
	if len(names) > 0 {
		return fmt.Errorf("该目录还关联任务 %s，请确认影响后再切换", strings.Join(names, "、"))
	}
	return nil
}
