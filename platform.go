package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

func defaultDataDir() string {
	if runtime.GOOS == "windows" {
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			return filepath.Join(dir, "WorktreeHub")
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "worktree-hub")
}

// Remote Linux paths must not be interpreted using Windows filepath semantics.
func cleanWorkspacePath(p string) string {
	if strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "//") {
		return path.Clean(p)
	}
	return filepath.Clean(p)
}
func joinWorkspacePath(root string, parts ...string) string {
	if strings.HasPrefix(root, "/") && !strings.HasPrefix(root, "//") {
		return path.Join(append([]string{root}, parts...)...)
	}
	return filepath.Join(append([]string{root}, parts...)...)
}
func baseWorkspacePath(p string) string {
	if strings.HasPrefix(p, "/") {
		return path.Base(p)
	}
	return filepath.Base(p)
}
func absoluteWorkspacePath(p string) bool { return strings.HasPrefix(p, "/") || filepath.IsAbs(p) }
func sameWorkspacePath(a, b string) bool {
	a, b = cleanWorkspacePath(a), cleanWorkspacePath(b)
	if runtime.GOOS == "windows" && !strings.HasPrefix(a, "/") {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func powershellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
func nativeWindows() bool             { return runtime.GOOS == "windows" }
func displayCommand(tool string, args []string, windows bool) string {
	quote := shellQuote
	if windows {
		quote = powershellQuote
	}
	parts := []string{tool}
	for _, arg := range args {
		parts = append(parts, quote(arg))
	}
	if windows {
		return "& " + strings.Join(parts, " ")
	}
	return strings.Join(parts, " ")
}

// npm's Windows shim is a .cmd file. Start its JS entry point directly so
// app-server JSONL travels over pipes without shell argument interpretation.
func codexCommand(ctx context.Context, args ...string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		if executable, err := exec.LookPath("codex.exe"); err == nil {
			return exec.CommandContext(ctx, executable, args...)
		}
		if shim, err := exec.LookPath("codex.cmd"); err == nil {
			entry := filepath.Join(filepath.Dir(shim), "node_modules", "@openai", "codex", "bin", "codex.js")
			if _, err := os.Stat(entry); err == nil {
				return exec.CommandContext(ctx, "node.exe", append([]string{entry}, args...)...)
			}
		}
	}
	return exec.CommandContext(ctx, "codex", args...)
}

func (a *App) launchConflict(session, cwd string) error {
	if a.readOnlySessions {
		return nil
	}
	return a.appTerminalConflict(session, cwd)
}

func (a *App) launchSimpleTerminal(p LaunchPlan) error {
	settings, err := a.terminalSettings()
	if err != nil {
		return err
	}
	if a.workspace != nil {
		return a.workspace.call(context.Background(), workspaceRequest{Op: "terminal", Plan: &p, Settings: settings}, nil)
	}
	if err := writeTerminalScript(a.dataDir, &p); err != nil {
		return err
	}
	if err := a.launch(p); err != nil {
		_ = os.Remove(p.Script)
		return err
	}
	return nil
}

func writeTerminalScript(dataDir string, p *LaunchPlan) error {
	if p.Tool == "" {
		p.Tool = "codex"
	}
	if p.Tool != "codex" && p.Tool != "git" {
		return fmt.Errorf("不支持的终端程序")
	}
	dir := filepath.Join(dataDir, "launches")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	ext := ".sh"
	if runtime.GOOS == "windows" {
		ext = ".ps1"
	}
	p.Script = filepath.Join(dir, newID()+ext)
	p.Command = displayCommand(p.Tool, p.Args, runtime.GOOS == "windows")
	script := "#!/usr/bin/env bash\nexport PATH=\"$HOME/.local/bin:$PATH\"\ncd -- " + shellQuote(p.Cwd) + " || exit 1\n" + p.Command + "\nexec bash -i\n"
	if runtime.GOOS == "windows" {
		script = "\ufeff$ErrorActionPreference = 'Stop'\r\nSet-Location -LiteralPath " + powershellQuote(p.Cwd) + "\r\n$env:GIT_TERMINAL_PROMPT = '1'\r\n" + p.Command + "\r\nWrite-Host '操作结束，可继续在当前项目目录工作。'\r\n"
	}
	return os.WriteFile(p.Script, []byte(script), 0700)
}
