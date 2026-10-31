package workspace

import (
	"errors"
	"fmt"
	"testing"
)

func TestAgentPreservesConfirmedSessionConflict(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		conflict bool
	}{
		{"confirmed owner", &SessionConflictError{Message: "terminal owns session"}, true},
		{"wrapped owner", fmt.Errorf("ownership probe: %w", &SessionConflictError{Message: "terminal owns session"}), true},
		{"invalid arguments", errors.New("无法读取 Codex 终端参数：invalid argument"), false},
		{"untyped error", errors.New("terminal owns session"), false},
		{"no owner", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			send, receive := agentTestPipe(t, AgentHooks{TerminalConflict: func(string, string) error { return tc.err }})
			send(Request{ID: 1, Op: "session-conflict", Method: "session"})
			response := receive()
			if (response.Code == "session_conflict") != tc.conflict {
				t.Fatalf("incorrect ownership code: %+v", response)
			}
			err := response.err()
			if IsSessionConflict(err) != tc.conflict || (err == nil) != (tc.err == nil) {
				t.Fatalf("ownership classification lost across transport: %v", err)
			}
			if tc.err != nil && err.Error() != tc.err.Error() {
				t.Fatalf("ownership message changed: %v", err)
			}
		})
	}
}
