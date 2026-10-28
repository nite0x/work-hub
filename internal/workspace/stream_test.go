package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"
)

func TestWorkspaceStreamHelper(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_STREAM_HELPER") != "1" {
		return
	}
	err := RunAgent(os.Stdin, os.Stdout, AgentHooks{TerminalConflict: func(string, string) error { return nil }, WatchHistory: func(ctx context.Context, id string, emit func(json.RawMessage) error) error {
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

func TestSubscriptionsHaveSeparateCapacityAndReturnTypedBusyErrors(t *testing.T) {
	c := streamTestClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	var wg sync.WaitGroup
	defer func() { cancel(); wg.Wait() }()
	ready := make(chan struct{}, agentWatchLimit)
	var cancelFirst context.CancelFunc
	for i := 0; i < agentWatchLimit; i++ {
		streamCtx, stop := context.WithCancel(ctx)
		defer stop()
		if i == 0 {
			cancelFirst = stop
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			first := true
			err := c.Stream(streamCtx, Request{Op: "session-watch", Path: "capacity-test"}, func(json.RawMessage) error {
				if first {
					ready <- struct{}{}
					first = false
				}
				return nil
			})
			if !errors.Is(err, context.Canceled) {
				t.Errorf("subscription ended unexpectedly: %v", err)
			}
		}()
	}
	for i := 0; i < agentWatchLimit; i++ {
		select {
		case <-ready:
		case <-ctx.Done():
			t.Fatal("subscriptions failed to start")
		}
	}
	if err := c.Stream(ctx, Request{Op: "session-watch"}, func(json.RawMessage) error { return nil }); !errors.Is(err, ErrBusy) {
		t.Fatalf("stream busy response lost error type: %v", err)
	}
	busyCtx, stopBusy := context.WithTimeout(ctx, 120*time.Millisecond)
	defer stopBusy()
	if err := c.Call(busyCtx, Request{Op: "session-watch"}, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("busy call did not respect its deadline: %v", err)
	}
	for _, op := range []string{"identity", "session-conflict"} {
		if err := c.Call(ctx, Request{Op: op}, nil); err != nil {
			t.Fatalf("subscriptions blocked %s: %v", op, err)
		}
	}
	cancelFirst()
	finished := errors.New("replacement subscription started")
	for {
		err := c.Stream(ctx, Request{Op: "session-watch"}, func(json.RawMessage) error { return finished })
		if errors.Is(err, finished) {
			break
		}
		if !errors.Is(err, ErrBusy) {
			t.Fatalf("cancelled subscription did not release capacity: %v", err)
		}
		select {
		case <-ctx.Done():
			t.Fatal("subscription capacity not released after cancellation")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestLegacyHelperBusyResponseIsRetryable(t *testing.T) {
	if err := (Response{Error: "辅助程序繁忙，请稍后重试"}).err(); !errors.Is(err, ErrBusy) {
		t.Fatalf("legacy helper busy response: %v", err)
	}
}
