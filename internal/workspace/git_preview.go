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

const GitPreviewLimit = 256 << 10

type GitPreview struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

type previewBuffer struct {
	buffer    bytes.Buffer
	truncated bool
}

func (b *previewBuffer) String() string { return b.buffer.String() }

func (b *previewBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if len(p) > GitPreviewLimit-b.buffer.Len() {
		p = p[:GitPreviewLimit-b.buffer.Len()]
		b.truncated = true
	}
	_, _ = b.buffer.Write(p)
	return n, nil
}

// RunGitPreview discards excess output while draining the process. It never
// invokes external diff/textconv programs and works through the WSL helper.
func RunGitPreview(ctx context.Context, path string, args ...string) (GitPreview, error) {
	if c := RemoteClient(ctx); c != nil {
		var result GitPreview
		err := c.Call(ctx, Request{Op: "git-preview", Path: path, Args: args}, &result)
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-c", "core.quotePath=false", "-C", path}, args...)...)
	platform.HideCommand(cmd)
	for _, v := range os.Environ() {
		k := strings.SplitN(v, "=", 2)[0]
		if k != "GIT_DIR" && k != "GIT_WORK_TREE" && k != "GIT_INDEX_FILE" && k != "GIT_COMMON_DIR" {
			cmd.Env = append(cmd.Env, v)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	var out, stderr previewBuffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return GitPreview{}, fmt.Errorf("读取改动超时或已取消")
		}
		return GitPreview{}, fmt.Errorf("%s", strings.TrimSpace(stderr.String()))
	}
	return GitPreview{Text: strings.ToValidUTF8(out.String(), "�"), Truncated: out.truncated}, nil
}
