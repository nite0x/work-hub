package workspace

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/platform"
)

// A dedicated pipe preserves all events and leaves workspace RPCs free while
// Codex is waiting for approval. Reuse the exact helper, distro and user.
func (c *Client) OpenCodex(parent context.Context) (codex.LiveClient, error) {
	args := append([]string{}, c.cmd.Args[1:]...)
	if len(args) == 0 || args[len(args)-1] != "--workspace-agent" {
		return nil, fmt.Errorf("此辅助程序不支持 Codex 对话，请重新连接执行环境")
	}
	ctx, cancel := context.WithCancel(parent)
	go func() {
		select {
		case <-c.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	args[len(args)-1] = "--codex-live"
	cmd := exec.CommandContext(ctx, c.cmd.Path, args...)
	cmd.Env, cmd.Dir, cmd.Stderr = c.cmd.Env, c.cmd.Dir, os.Stderr
	platform.HideCommand(cmd)
	live, err := codex.StartWire(ctx, cmd)
	if err != nil {
		cancel()
		return nil, err
	}
	return &remoteCodex{LiveClient: live, cancel: cancel}, nil
}

type remoteCodex struct {
	codex.LiveClient
	cancel context.CancelFunc
}

func (c *remoteCodex) Close() { c.cancel(); c.LiveClient.Close() }
