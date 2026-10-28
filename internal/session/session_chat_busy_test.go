package session

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"worktree-hub/internal/workspace"
)

func TestChatRetriesTemporaryOwnershipCheckFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"helper busy", fmt.Errorf("ownership probe: %w", workspace.ErrBusy)},
		{"probe timeout", fmt.Errorf("ownership probe: %w", context.DeadlineExceeded)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, _, c, endpoint := chatFixture(t)
			var phase, failures, recovered atomic.Int32
			a.terminalConflict = func(string, string) error {
				switch phase.Load() {
				case 1:
					failures.Add(1)
					return tc.err
				case 2:
					recovered.Add(1)
				case 3:
					return fmt.Errorf("terminal appeared")
				}
				return nil
			}
			startFakeChat(t, a, endpoint)
			phase.Store(1)
			state := awaitChat(t, a, func(s ChatState) bool { return failures.Load() >= 2 || !s.Busy })
			if !state.Busy || state.Status != "running" || state.Error != "" {
				t.Fatalf("temporary probe failure interrupted turn: %+v", state)
			}
			phase.Store(2)
			awaitChat(t, a, func(s ChatState) bool { return recovered.Load() > 0 || !s.Busy })
			c.mu.Lock()
			interrupted := false
			for _, method := range c.methods {
				interrupted = interrupted || method == "turn/interrupt"
			}
			c.mu.Unlock()
			if interrupted || !a.ChatBusy("session") {
				t.Fatal("healthy turn interrupted after ownership check recovered")
			}
			phase.Store(3)
			state = awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
			if state.Status != "conflict" || !strings.Contains(state.Error, "terminal appeared") {
				t.Fatalf("real conflict no longer stops the turn: %+v", state)
			}
		})
	}
}

func TestChatDoesNotStartWhenOwnershipCheckIsBusy(t *testing.T) {
	a, _, c, endpoint := chatFixture(t)
	a.terminalConflict = func(string, string) error { return workspace.ErrBusy }
	if code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "hello", "request_id": "busy"}); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	state := awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	if state.Status != "conflict" {
		t.Fatalf("start without verified ownership: %+v", state)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, method := range c.methods {
		if method == "turn/start" || method == "thread/resume" {
			t.Fatal("busy ownership check allowed a new turn")
		}
	}
}
