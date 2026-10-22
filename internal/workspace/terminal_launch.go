package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
)

func (a *Service) LaunchSimpleTerminal(p model.LaunchPlan) error {
	settings, err := a.TerminalSettings()
	if err != nil {
		return err
	}
	if a.Remote != nil {
		return a.Remote.Call(context.Background(), Request{Op: "terminal", Plan: &p, Settings: settings}, nil)
	}
	if err := WriteTerminalScript(a.DataDir, &p); err != nil {
		return err
	}
	if err := a.Launch(p, nil); err != nil {
		_ = os.Remove(p.Script)
		return err
	}
	return nil
}

func WriteTerminalScript(dataDir string, p *model.LaunchPlan) error {
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
	p.Script = filepath.Join(dir, model.NewID()+ext)
	p.Command = platform.DisplayCommand(p.Tool, p.Args, runtime.GOOS == "windows")
	script := "#!/usr/bin/env bash\nexport PATH=\"$HOME/.local/bin:$PATH\"\ncd -- " + platform.ShellQuote(p.Cwd) + " || exit 1\n" + p.Command + "\nexec bash -i\n"
	if runtime.GOOS == "windows" {
		script = "\ufeff$ErrorActionPreference = 'Stop'\r\nSet-Location -LiteralPath " + platform.PowershellQuote(p.Cwd) + "\r\n$env:GIT_TERMINAL_PROMPT = '1'\r\n" + p.Command + "\r\nWrite-Host '操作结束，可继续在当前项目目录工作。'\r\n"
	}
	return os.WriteFile(p.Script, []byte(script), 0700)
}
