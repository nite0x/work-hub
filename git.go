package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Worktree struct {
	Path             string `json:"path"`
	Branch           string `json:"branch"`
	Head             string `json:"head"`
	Bare             bool   `json:"bare"`
	Detached         bool   `json:"detached"`
	Locked           bool   `json:"locked"`
	Prunable         bool   `json:"prunable"`
	Missing          bool   `json:"missing"`
	Dirty            int    `json:"dirty"`
	Ahead            int    `json:"ahead"`
	Behind           int    `json:"behind"`
	CompareAvailable bool   `json:"compare_available"`
	Error            string `json:"error,omitempty"`
	RequirementID    string `json:"requirement_id,omitempty"`
	RequirementName  string `json:"requirement_name,omitempty"`
	ExpectedBranch   string `json:"expected_branch,omitempty"`
	StatusUpdatedAt  string `json:"status_updated_at,omitempty"`
	Refreshing       bool   `json:"refreshing"`
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	return runGit(ctx, dir, 25*time.Second, false, args...)
}

func gitOperation(ctx context.Context, dir string, args ...string) (string, error) {
	return runGit(ctx, dir, 90*time.Second, true, args...)
}

func runGit(ctx context.Context, dir string, timeout time.Duration, includeMessages bool, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if c := remoteWorkspace(ctx); c != nil {
		var output string
		err := c.call(ctx, workspaceRequest{Op: "git", Path: dir, Args: args, Messages: includeMessages}, &output)
		return output, err
	}
	argv := append([]string{"-c", "core.quotePath=false", "-C", dir}, args...)
	cmd := exec.CommandContext(ctx, "git", argv...)
	hideCommand(cmd)
	for _, v := range os.Environ() {
		k := strings.SplitN(v, "=", 2)[0]
		if k != "GIT_DIR" && k != "GIT_WORK_TREE" && k != "GIT_INDEX_FILE" && k != "GIT_COMMON_DIR" {
			cmd.Env = append(cmd.Env, v)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("Git 操作超时或已取消")
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("%s", msg)
	}
	if includeMessages {
		return strings.TrimSpace(out.String() + "\n" + stderr.String()), nil
	}
	return out.String(), nil
}
func parseWorktrees(raw string) []Worktree {
	out := []Worktree{}
	var current *Worktree
	for _, field := range strings.Split(raw, "\x00") {
		if strings.HasPrefix(field, "worktree ") {
			if current != nil {
				out = append(out, *current)
			}
			current = &Worktree{Path: cleanWorkspacePath(strings.TrimPrefix(field, "worktree "))}
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
func dirtyCount(raw string) int {
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
func scanWorktrees(ctx context.Context, dir string) ([]Worktree, error) {
	raw, err := git(ctx, dir, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	out := parseWorktrees(raw)
	for i := range out {
		out[i] = scanWorktreeStatus(ctx, out[i])
	}
	return out, nil
}

func scanWorktreeStatus(ctx context.Context, v Worktree) Worktree {
	if _, err := workspaceStat(ctx, v.Path, true); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			v.Error = err.Error()
			return v
		}
		v.Missing = true
		v.StatusUpdatedAt = now()
		return v
	}
	if v.Bare {
		v.StatusUpdatedAt = now()
		return v
	}
	s, err := git(ctx, v.Path, "status", "--porcelain=v1", "-z", "--untracked-files=normal")
	if err != nil {
		v.Error = err.Error()
		return v
	}
	v.Dirty = dirtyCount(s)
	comparison, err := git(ctx, v.Path, "rev-list", "--left-right", "--count", "refs/heads/master...HEAD")
	if err == nil {
		parts := strings.Fields(comparison)
		if len(parts) == 2 {
			v.Behind, _ = strconv.Atoi(parts[0])
			v.Ahead, _ = strconv.Atoi(parts[1])
			v.CompareAvailable = true
		}
	}
	v.StatusUpdatedAt = now()
	return v
}

var invalidSlug = regexp.MustCompile(`[^a-z0-9_-]+`)
var validSlug = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

func slugify(s string) string {
	out := strings.Trim(invalidSlug.ReplaceAllString(strings.ToLower(s), "-"), "-_")
	if len(out) > 55 {
		out = strings.TrimRight(out[:55], "-_")
	}
	return out
}
func within(root, path string) bool {
	if strings.HasPrefix(root, "/") {
		root, path = cleanWorkspacePath(root), cleanWorkspacePath(path)
		return strings.HasPrefix(path, strings.TrimSuffix(root, "/")+"/") && path != root
	}
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
