package project

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

// mergeIntoTarget revalidates both the branch and its checkout before publishing
// a merge. The source worktree never switches branches or changes its index.
func mergeIntoTarget(ctx context.Context, p model.Project, v GitOverview, ref, source string) (GitBranch, string, error) {
	b, err := findBranch(v, ref, "local")
	if err != nil {
		return b, "", err
	}
	if b.Name == source {
		return b, "", fmt.Errorf("目标分支不能是当前分支")
	}
	if len(b.Worktrees) > 1 {
		return b, "", fmt.Errorf("目标分支在多个工作目录检出，请先处理重复检出")
	}
	if len(b.Worktrees) == 0 {
		return b, "", nil
	}
	t, err := selectedWorktree(ctx, p, b.Worktrees[0])
	if err != nil {
		return b, "", err
	}
	if t.Branch != b.Name || t.Head != b.Commit || t.Detached || t.Dirty > 0 || t.Operation != "" {
		return b, "", fmt.Errorf("目标分支目录有未提交修改、未结束的 Git 操作或状态已变化，请先处理：%s", t.Path)
	}
	return b, t.Path, nil
}

func (a *Service) mergeIntoHandler(w http.ResponseWriter, r *http.Request, p model.Project, v GitOverview, in GitAction) {
	ctx := r.Context()
	source, err := selectedWorktree(ctx, p, in.Path)
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	if source.Detached || source.Branch == "" || source.Head == "" || source.Operation != "" {
		httpx.WriteError(w, 409, "请先完成当前 Git 操作并检出来源分支")
		return
	}
	target, targetPath, err := mergeIntoTarget(ctx, p, v, in.Target, source.Branch)
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	if in.Action == "merge_into_preview" {
		log, err := workspace.Git(ctx, source.Path, "log", "--format=%h %s", "-20", target.Commit+".."+source.Head)
		if err != nil {
			writeGitActionError(w, in.Action, err)
			return
		}
		httpx.WriteJSON(w, 200, map[string]string{
			"message": source.Branch + " → " + target.Name, "output": log,
			"expected_head": source.Head, "expected_branch": source.Branch,
			"target_commit": target.Commit, "target_path": targetPath,
		})
		return
	}
	if in.ExpectedBranch != source.Branch || in.ExpectedHead != source.Head || in.TargetCommit != target.Commit {
		httpx.WriteError(w, 409, "合并预览已过期，请重新预览")
		return
	}

	// Compute the merge in a detached, private worktree. Conflicts and failed
	// commit hooks cannot leave either user's checkout in a partial merge.
	commit, output, err := a.prepareMergeInto(ctx, p, source, target)
	if err != nil {
		writeGitActionError(w, in.Action, err)
		return
	}
	v, err = InspectGit(ctx, p)
	if err == nil {
		var latest GitBranch
		latest, targetPath, err = mergeIntoTarget(ctx, p, v, target.Ref, source.Branch)
		if err == nil && latest.Commit != target.Commit {
			err = fmt.Errorf("目标分支已变化，请重新预览")
		}
	}
	if err == nil {
		if targetPath != "" {
			_, err = workspace.GitOperation(ctx, targetPath, "-c", "merge.autoStash=false", "merge", "--ff-only", "--commit", "--no-squash", "--no-edit", "--no-autostash", "--no-overwrite-ignore", "--", commit)
		} else {
			// Compare-and-swap protects an unoccupied branch from concurrent updates.
			_, err = workspace.Git(ctx, p.Path, "update-ref", "-m", "worktree-hub: merge "+source.Branch+" into "+target.Name, target.Ref, commit, target.Commit)
		}
	}
	if err != nil {
		writeGitActionError(w, in.Action, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{
		"message": "已合并 " + source.Branch + " → " + target.Name + "，当前目录保留在 " + source.Branch,
		"output":  RedactGitOutput(output),
	})
}

func (a *Service) prepareMergeInto(ctx context.Context, p model.Project, source model.Worktree, target GitBranch) (commit, output string, resultErr error) {
	path := platform.JoinWorkspacePath(p.CommonDir, "work-hub-merge-"+model.NewID())
	if err := workspace.Mkdir(ctx, path, 0700, false); err != nil {
		return "", "", err
	}
	defer func() {
		// Keep the environment client, even if the HTTP request was canceled.
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_, err := workspace.Git(cleanupCtx, p.Path, "worktree", "remove", "--force", "--", path)
		if err != nil {
			// An add failure can leave only the empty directory we reserved.
			if removeErr := workspace.Remove(cleanupCtx, path); removeErr != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("临时合并目录清理失败，请检查 %s：%w", path, err))
			}
		}
	}()
	if _, err := workspace.GitOperation(ctx, p.Path, "worktree", "add", "--detach", "--", path, target.Commit); err != nil {
		return "", "", err
	}
	message := "Merge branch '" + source.Branch + "' into " + target.Name
	output, err := workspace.GitOperation(ctx, path, "-c", "merge.autoStash=false", "-c", "rerere.enabled=false", "merge", "--ff", "--commit", "--no-squash", "--no-edit", "--no-autostash", "--no-overwrite-ignore", "-m", message, "--", source.Head)
	if err != nil {
		state, inspectErr := workspace.ReadGitState(ctx, path)
		if inspectErr == nil && len(state.Conflicts) > 0 {
			return "", "", fmt.Errorf("合并存在冲突，目标分支未更新。请在终端处理后重试。冲突文件：\n%s", strings.Join(state.Conflicts, "\n"))
		}
		return "", "", err
	}
	head, err := workspace.Git(ctx, path, "rev-parse", "--verify", "HEAD^{commit}")
	return strings.TrimSpace(head), output, err
}
