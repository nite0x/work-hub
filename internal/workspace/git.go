package workspace

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"worktree-hub/internal/platform"
)

func Git(ctx context.Context, dir string, args ...string) (string, error) {
	return RunGit(ctx, dir, 25*time.Second, false, args...)
}

func GitOperation(ctx context.Context, dir string, args ...string) (string, error) {
	return RunGit(ctx, dir, 90*time.Second, true, args...)
}

func RunGit(ctx context.Context, dir string, timeout time.Duration, includeMessages bool, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if c := RemoteClient(ctx); c != nil {
		var output string
		err := c.Call(ctx, Request{Op: "git", Path: dir, Args: args, Messages: includeMessages}, &output)
		return output, err
	}
	argv := append([]string{"-c", "core.quotePath=false", "-C", dir}, args...)
	cmd := exec.CommandContext(ctx, "git", argv...)
	platform.HideCommand(cmd)
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
		if includeMessages {
			// Porcelain commands can report failure details on stdout (for
			// example push rejections); stderr may contain only a summary.
			msg = strings.TrimSpace(out.String() + "\n" + stderr.String())
		}
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
