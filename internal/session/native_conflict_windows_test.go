package session

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"worktree-hub/internal/workspace"
)

func TestWindowsTerminalCommandConflict(t *testing.T) {
	for _, tc := range []struct {
		name     string
		args     []string
		conflict bool
	}{
		{"empty process", nil, false},
		{"other session", []string{"codex.exe", "resume", "other-session"}, false},
		{"exact session", []string{"codex.exe", "resume", "session"}, true},
		{"session substring", []string{"codex.exe", "resume", "session-longer"}, false},
		{"server", []string{"codex.exe", "app-server", "session"}, false},
		{"tool worker", []string{"codex.exe", "exec-server", "session"}, false},
		{"exec", []string{"codex.exe", "exec", "session"}, false},
		{"quoted path", []string{`C:\开发 工具\codex.exe`, "resume", "session", "--cd", `C:\任务 目录`}, true},
		{"directory only", []string{"codex.exe", "--cd", `C:\任务 目录`}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := windowsTerminalCommandConflict("session", windows.ComposeCommandLine(tc.args))
			if (err != nil) != tc.conflict || workspace.IsSessionConflict(err) != tc.conflict {
				t.Fatalf("conflict = %t: %v", tc.conflict, err)
			}
		})
	}
}

func TestWindowsProcessCommandLine(t *testing.T) {
	line, err := windowsProcessCommandLine(uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	args, err := windows.DecomposeCommandLine(line)
	if err != nil || !reflect.DeepEqual(args, os.Args) {
		t.Fatalf("command line did not round trip: %q, %v", args, err)
	}
}

func TestWindowsNativeTerminalConflictWithoutPowerShell(t *testing.T) {
	// Run the real Windows APIs with a live, disposable codex.exe process.
	// An empty PATH also catches any reintroduction of a PowerShell/WMI query.
	t.Setenv("PATH", t.TempDir())
	id := fmt.Sprintf("work-hub-conflict-probe-%d", os.Getpid())
	if err := nativeTerminalConflict(id, ""); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "终端 空格")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(dir, "codex.exe")
	data, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, data, 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, helper, "-test.run=^TestWindowsTerminalProcessHelper$", "--", "resume", id)
	cmd.Env = append(os.Environ(), "WORKTREE_HUB_WINDOWS_CONFLICT_HELPER=1")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { input.Close(); cancel(); _ = cmd.Wait() })
	if ready, err := bufio.NewReader(output).ReadString('\n'); err != nil || strings.TrimSpace(ready) != "ready" {
		t.Fatalf("helper failed to start: %q, %v", ready, err)
	}
	start := time.Now()
	if err := nativeTerminalConflict(id, ""); err == nil || !strings.Contains(err.Error(), "仍有 Codex 终端打开") {
		t.Fatalf("live terminal was not detected: %v", err)
	}
	t.Logf("native ownership scan: %s", time.Since(start))
	if err := nativeTerminalConflict(id+"-other", ""); err != nil {
		t.Fatalf("independent conversation blocked: %v", err)
	}
	line, err := windowsProcessCommandLine(uint32(cmd.Process.Pid))
	if err != nil || !strings.Contains(line, "终端 空格") {
		t.Fatalf("Unicode process command line: %q, %v", line, err)
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := nativeTerminalConflict(id, ""); err != nil {
		t.Fatalf("exited terminal still blocks the conversation: %v", err)
	}
}

func TestWindowsTerminalProcessHelper(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_WINDOWS_CONFLICT_HELPER") != "1" {
		t.Skip("subprocess helper")
	}
	fmt.Println("ready")
	_, _ = io.Copy(io.Discard, os.Stdin)
}
