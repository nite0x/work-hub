package app

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

func TestWindowsNativePathsAndPowerShellArguments(t *testing.T) {
	root := filepath.Join(t.TempDir(), "项目 with 'quotes' & spaces")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	got, err := platform.NormalizePath(root)
	if err != nil || !platform.SameWorkspacePath(got, root) {
		t.Fatalf("native path: %s %v", got, err)
	}
	if strings.HasPrefix(got, "/mnt/") {
		t.Fatal("Windows project was converted to a WSL path")
	}
	if got := platform.JoinWorkspacePath("/home/nite/workspaces", "task", "project"); got != "/home/nite/workspaces/task/project" {
		t.Fatal(got)
	}
	p := model.LaunchPlan{Tool: "codex", Cwd: root, Args: []string{"--cd", root, "--add-dir", `D:\other project`, "引号 ' 和 \"，$() & ; | ` 都是文字"}}
	if err := workspace.WriteTerminalScript(t.TempDir(), &p); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(t.TempDir(), "args.json")
	code := `function codex { $args | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:WORKTREE_HUB_TERMINAL_ARGS -Encoding UTF8 }; & ` + platform.PowershellQuote(p.Script)
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", code)
	cmd.Env = append(os.Environ(), "WORKTREE_HUB_TERMINAL_ARGS="+output)
	platform.HideCommand(cmd)
	if raw, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("PowerShell script: %v %s", err, raw)
	}
	raw, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var args []string
	if err := json.Unmarshal(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf}), &args); err != nil {
		t.Fatal(err)
	}
	if len(args) != len(p.Args) {
		t.Fatalf("args changed: %#v", args)
	}
	for i, arg := range args {
		if arg != p.Args[i] {
			t.Fatalf("argument %d changed: %q != %q", i, arg, p.Args[i])
		}
	}
	command, err := workspace.TerminalCommand(model.TerminalSettings{Kind: "powershell", Style: "powershell"}, "powershell.exe", "", p)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(command.Args, " ")
	if strings.Contains(joined, "wsl.exe") || strings.Contains(joined, "bash") || !strings.Contains(joined, "-File "+p.Script) {
		t.Fatalf("not native: %s", joined)
	}
}
