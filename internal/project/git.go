package project

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"

	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

func ParseWorktrees(raw string) []model.Worktree {
	out := []model.Worktree{}
	var current *model.Worktree
	for _, field := range strings.Split(raw, "\x00") {
		if strings.HasPrefix(field, "worktree ") {
			if current != nil {
				out = append(out, *current)
			}
			current = &model.Worktree{Path: platform.CleanWorkspacePath(strings.TrimPrefix(field, "worktree "))}
			continue
		}
		if current == nil {
			continue
		}
		switch {
		case strings.HasPrefix(field, "HEAD "):
			current.Head = strings.TrimPrefix(field, "HEAD ")
		case strings.HasPrefix(field, "branch "):
			current.Branch = strings.TrimPrefix(strings.TrimPrefix(field, "branch "), "refs/heads/")
		case field == "bare":
			current.Bare = true
		case field == "detached":
			current.Detached = true
		case strings.HasPrefix(field, "locked"):
			current.Locked = true
		case strings.HasPrefix(field, "prunable"):
			current.Prunable = true
		}
	}
	if current != nil {
		out = append(out, *current)
	}
	return out
}
func DirtyCount(raw string) int {
	fields := strings.Split(raw, "\x00")
	count := 0
	for i := 0; i < len(fields); i++ {
		v := fields[i]
		if len(v) < 3 {
			continue
		}
		count++
		if v[0] == 'R' || v[0] == 'C' || v[1] == 'R' || v[1] == 'C' {
			i++
		}
	}
	return count
}
func ScanWorktrees(ctx context.Context, dir string) ([]model.Worktree, error) {
	raw, err := workspace.Git(ctx, dir, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	out := ParseWorktrees(raw)
	for i := range out {
		out[i] = ScanWorktreeStatus(ctx, out[i])
	}
	return out, nil
}

func ScanWorktreeStatus(ctx context.Context, v model.Worktree) model.Worktree {
	if _, err := workspace.Stat(ctx, v.Path, true); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			v.Error = err.Error()
			return v
		}
		v.Missing = true
		v.StatusUpdatedAt = model.Now()
		return v
	}
	if v.Bare {
		v.StatusUpdatedAt = model.Now()
		return v
	}
	s, err := workspace.ReadGitState(ctx, v.Path)
	if err != nil {
		v.Error = err.Error()
		return v
	}
	v.Branch, v.Head, v.Detached, v.Dirty = s.Branch, s.Head, s.Detached, s.Dirty
	v.Upstream, v.SyncAvailable, v.SyncAhead, v.SyncBehind = s.Upstream, s.SyncAvailable, s.SyncAhead, s.SyncBehind
	v.Operation, v.MergeHead, v.Conflicts = s.Operation, s.MergeHead, s.Conflicts
	ref := workspace.DefaultBranchSource(ctx, v.Path)
	if ref == "HEAD" {
		v.StatusUpdatedAt = model.Now()
		return v
	}
	comparison, err := workspace.Git(ctx, v.Path, "rev-list", "--left-right", "--count", ref+"...HEAD")
	if err == nil {
		parts := strings.Fields(comparison)
		if len(parts) == 2 {
			v.Behind, _ = strconv.Atoi(parts[0])
			v.Ahead, _ = strconv.Atoi(parts[1])
			v.CompareAvailable = true
			v.ComparisonRef = strings.TrimPrefix(strings.TrimPrefix(ref, "refs/heads/"), "refs/remotes/")
		}
	}
	v.StatusUpdatedAt = model.Now()
	return v
}
