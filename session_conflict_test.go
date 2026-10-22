package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in real tool turn, isolated from existing user threads and projects.
func TestInstalledCodexToolTurnDoesNotConflict(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_TEST_CODEX_TOOL") != "1" {
		t.Skip("opt-in tool execution")
	}
	a := testApp(t)
	p := register(t, a, "Probe", repo(t, "probe", "master"))
	_, q, _ := create(t, a, p, nil, "probe")
	a.terminalConflict = terminalSessionConflict
	code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/new", map[string]string{"text": "这是工具执行回归测试。请调用 shell 工具执行 pwd; sleep 3; printf WORKTREE_HUB_TOOL_OK。不修改文件，然后回复 WORKTREE_HUB_TOOL_OK。", "request_id": "tool-probe"})
	if code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	var result struct {
		Session CodexSession `json:"session"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		c, err := a.openLive(ctx)
		if err == nil {
			defer c.close()
			_ = c.call(ctx, "thread/delete", map[string]any{"threadId": result.Session.ID}, nil)
		}
	}()
	run := a.chatFor(result.Session.ID)
	select {
	case <-run.finished:
	case <-time.After(90 * time.Second):
		t.Fatal("tool turn timed out")
	}
	s := run.snapshot()
	if s.Status != "completed" {
		t.Fatalf("tool turn: %s %s", s.Status, s.Error)
	}
	for _, e := range s.Entries {
		if e.Kind == "command" && e.Status == "completed" && e.Output != nil && strings.Contains(*e.Output, "WORKTREE_HUB_TOOL_OK") {
			return
		}
	}
	t.Fatal("no completed command output in real tool turn")
}

func TestTerminalDetectionDistinguishesSandboxFromInteractiveCLI(t *testing.T) {
	cwd, other := t.TempDir(), t.TempDir()
	for _, tc := range []struct {
		name, id, dir string
		args          []string
		conflict      bool
	}{
		{"sandbox tool", "session", cwd, []string{"codex-linux-sandbox", "--command-cwd", cwd, "--", "/bin/bash", "-c", "sleep 3"}, false},
		{"sandbox absolute path", "session", cwd, []string{"/usr/bin/codex-linux-sandbox", "--", "/bin/bash"}, false},
		{"app server", "session", cwd, []string{"codex", "app-server", "--listen", "unix://"}, false},
		{"exec server", "session", cwd, []string{"codex", "exec-server"}, false},
		{"plain CLI same cwd", "session", cwd, []string{"codex"}, true},
		{"plain CLI unrelated cwd", "", other, []string{"codex"}, false},
		{"plain CLI new session same cwd", "", cwd, []string{"codex"}, true},
		{"resumed session other cwd", "session", other, []string{"codex", "resume", "session"}, true},
		{"CLI explicit cwd", "session", other, []string{"codex", "--cd", cwd}, true},
		{"exited process", "session", cwd, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proc := t.TempDir()
			base := filepath.Join(proc, "123")
			if err := os.Mkdir(base, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(base, "comm"), []byte("codex\n"), 0600); err != nil {
				t.Fatal(err)
			}
			command := ""
			if len(tc.args) > 0 {
				command = strings.Join(tc.args, "\x00") + "\x00"
			}
			if err := os.WriteFile(filepath.Join(base, "cmdline"), []byte(command), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(tc.dir, filepath.Join(base, "cwd")); err != nil {
				t.Fatal(err)
			}
			err := scanTerminalSessions(proc, tc.id, cwd)
			if (err != nil) != tc.conflict {
				t.Fatalf("conflict=%t: %v", tc.conflict, err)
			}
		})
	}
}
