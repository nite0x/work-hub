package session

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"worktree-hub/internal/workspace"
)

func TestChatRetriesOwnershipCheckFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"helper busy", fmt.Errorf("ownership probe: %w", workspace.ErrBusy)},
		{"probe timeout", fmt.Errorf("ownership probe: %w", context.DeadlineExceeded)},
		{"invalid process arguments", errors.New("无法读取 Codex 终端参数：invalid argument")},
		{"permission denied", errors.New("无法读取 Codex 终端参数：permission denied")},
		{"helper disconnected", errors.New("WSL 辅助程序连接已断开，请重新连接后检查操作结果")},
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
					return fmt.Errorf("ownership probe: %w", &workspace.SessionConflictError{Message: "terminal appeared"})
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
			c.mu.Lock()
			defer c.mu.Unlock()
			interrupts := 0
			for _, method := range c.methods {
				if method == "turn/interrupt" {
					interrupts++
				}
			}
			if interrupts != 1 {
				t.Fatalf("confirmed conflict must interrupt exactly once, got %d", interrupts)
			}
		})
	}
}

func TestChatDoesNotMisclassifyFailedOwnershipCheckBeforeStart(t *testing.T) {
	for _, probeErr := range []error{workspace.ErrBusy, errors.New("无法读取 Codex 终端参数：invalid argument")} {
		for _, failAt := range []int{1, 2} {
			t.Run(fmt.Sprintf("%s/check-%d", probeErr, failAt), func(t *testing.T) {
				a, _, c, endpoint := chatFixture(t)
				checks := 0
				a.terminalConflict = func(string, string) error {
					checks++
					if checks == failAt {
						return probeErr
					}
					return nil
				}
				if code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "hello", "request_id": "probe-failure"}); code != 202 {
					t.Fatalf("%d %s", code, raw)
				}
				state := awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
				if state.Status != "failed" || !strings.Contains(state.Error, "无法完成会话占用检查") || !strings.Contains(state.Error, probeErr.Error()) {
					t.Fatalf("probe failure was classified as occupancy: %+v", state)
				}
				c.mu.Lock()
				defer c.mu.Unlock()
				for _, method := range c.methods {
					if method == "turn/start" || method == "turn/interrupt" || failAt == 1 && method == "thread/resume" {
						t.Fatalf("failed ownership check triggered %s", method)
					}
				}
			})
		}
	}
}
