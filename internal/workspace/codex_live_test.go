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
	// The settings catalog uses the read-only workspace RPC, not the live pipe.
	// Exercise this boundary too so a live connection cannot hide a missing
	// helper capability for the new-conversation model picker.
	queries := &Sessions{Context: ctx, Client: client}
	for _, method := range []string{"model/list", "collaborationMode/list"} {
		result.Data = nil
		if err := queries.Call(method, map[string]any{}, &result); err != nil || len(result.Data) == 0 {
			t.Fatalf("read-only %s: %d entries, %v", method, len(result.Data), err)
		}
	}
	if err := queries.Call("turn/start", map[string]any{}, nil); err == nil {
		t.Fatal("read-only workspace RPC accepted a model turn")
	}
	if err := client.Call(ctx, Request{Op: "session-conflict", Path: "/tmp/workhub-unowned-transport-test"}, nil); err != nil {
		t.Fatal(err)
	}
}
