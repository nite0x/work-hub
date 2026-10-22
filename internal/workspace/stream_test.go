package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestWorkspaceStreamHelper(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_STREAM_HELPER") != "1" {
		return
	}
	err := RunAgent(os.Stdin, os.Stdout, AgentHooks{WatchHistory: func(ctx context.Context, id string, emit func(json.RawMessage) error) error {
		raw, _ := json.Marshal(map[string]any{"session": id, "text": "中文实时输出"})
		if err := emit(raw); err != nil {
			return err
		}
		<-ctx.Done()
		return ctx.Err()
	}})
	if err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}

func streamTestClient(t *testing.T) *Client {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestWorkspaceStreamHelper$")
	cmd.Env = append(os.Environ(), "WORKTREE_HUB_STREAM_HELPER=1")
	c, err := StartClient(cmd)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return c
}

func TestStreamDeliversRawSnapshotAndPreservesOtherRequests(t *testing.T) {
	c := streamTestClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	finished := errors.New("snapshot received")
	err := c.Stream(ctx, Request{Op: "session-watch", Path: "test-session"}, func(raw json.RawMessage) error {
		var state struct{ Session, Text string }
		if err := json.Unmarshal(raw, &state); err != nil {
			return err
		}
		if state.Session != "test-session" || state.Text != "中文实时输出" {
			t.Errorf("incorrect snapshot: %s", raw)
		}
		return finished
	})
	if !errors.Is(err, finished) {
		t.Fatalf("callback result: %v", err)
	}
	var identity Identity
	if err := c.Call(ctx, Request{Op: "identity"}, &identity); err != nil || identity.Protocol != Protocol {
		t.Fatalf("stream cancellation broke the shared connection: %+v %v", identity, err)
	}
}

func TestStreamContextCancellationLeavesClientUsable(t *testing.T) {
	c := streamTestClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := c.Stream(ctx, Request{Op: "session-watch", Path: "cancel-session"}, func(json.RawMessage) error { cancel(); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("stream cancellation: %v", err)
	}
	check, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	if err := c.Call(check, Request{Op: "identity"}, nil); err != nil {
		t.Fatal("connection closed after stream cancellation", err)
	}
}
