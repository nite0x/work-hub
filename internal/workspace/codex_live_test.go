package workspace

import (
	"context"
	"os"
	"runtime"
	"testing"
	"time"
)

// This validates the actual Windows -> wsl.exe -> installed helper -> Codex
// daemon path without creating a thread or starting a model turn.
func TestInstalledWSLCodexTransport(t *testing.T) {
	distro := os.Getenv("WORKTREE_HUB_TEST_WSL_CHAT")
	if runtime.GOOS != "windows" || distro == "" {
		t.Skip("opt in with a Windows host and WORKTREE_HUB_TEST_WSL_CHAT")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	client, err := StartWSL(ctx, distro, "")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	live, err := client.OpenCodex(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	var result struct {
		Data []any `json:"data"`
	}
	if err := live.Call(ctx, "thread/list", map[string]any{"limit": 1}, &result); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, Request{Op: "session-conflict", Path: "/tmp/workhub-unowned-transport-test"}, nil); err != nil {
		t.Fatal(err)
	}
}
