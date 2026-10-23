package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"worktree-hub/internal/platform"
)

func nativeTerminalConflict(id, cwd string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	// Fixed command; no project names, paths or user input enter PowerShell code.
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | Select-Object -ExpandProperty CommandLine) | ConvertTo-Json -Compress`)
	platform.HideCommand(cmd)
	raw, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("无法核实 Codex 终端占用：%w", err)
	}
	var lines []string
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, &lines); err != nil {
		var line string
		if err := json.Unmarshal(raw, &line); err != nil {
			return fmt.Errorf("无法读取 Codex 进程信息")
		}
		lines = []string{line}
	}
	for _, line := range lines {
		args, err := windows.DecomposeCommandLine(line)
		if err != nil {
			return fmt.Errorf("无法读取 Codex 终端参数")
		}
		if len(args) > 1 && isCodexServerCommand(args[1]) {
			continue
		}
		for i, arg := range args {
			if id != "" && arg == id {
				return fmt.Errorf("此会话仍有 Codex 终端打开，请先退出终端中的 Codex")
			}
			if (arg == "--cd" || arg == "-C") && i+1 < len(args) && platform.SameWorkspacePath(args[i+1], cwd) || strings.HasPrefix(arg, "--cd=") && platform.SameWorkspacePath(strings.TrimPrefix(arg, "--cd="), cwd) {
				return fmt.Errorf("此目录仍有 Codex 终端打开，请先退出终端中的 Codex")
			}
		}
	}
	return nil
}
