package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func (a *App) appTerminalConflict(id, cwd string) error {
	if b := a.terminalOwner(id, cwd); b != nil {
		b.mu.Lock()
		connected, revoked := b.connected, b.revoked
		b.mu.Unlock()
		if !revoked {
			if !connected {
				return fmt.Errorf("终端正在启动，尚未连接；请稍候。启动失败后会自动释放占用（最多 30 秒）")
			}
			return fmt.Errorf("工作台终端保有此会话或目录的控制权，请使用“切换到侧栏”等待交接完成")
		}
	}
	return a.terminalConflict(id, cwd)
}

func (a *App) terminalOwner(id, cwd string) *terminalBridge {
	a.bridgeMu.Lock()
	defer a.bridgeMu.Unlock()
	for _, b := range a.bridges {
		b.mu.Lock()
		owns := !b.revoked && ((id != "" && b.session == id) || b.cwd == cwd)
		b.mu.Unlock()
		if owns {
			return b
		}
	}
	return nil
}

// Conservatively treat any interactive Codex in the session's directory as
// an owner, even if its initial command line doesn't contain its session ID.
// This also covers manually launched CLI sessions outside Hub's launchers.
func terminalSessionConflict(id, cwd string) error { return scanTerminalSessions("/proc", id, cwd) }
func scanTerminalSessions(proc, id, cwd string) error {
	return scanTerminalSessionsExcept(proc, id, cwd, 0)
}
func scanTerminalSessionsExcept(proc, id, cwd string, except int) error {
	processes, err := os.ReadDir(proc)
	if err != nil {
		return fmt.Errorf("无法核实终端占用，暂不能发送：%w", err)
	}
	for _, process := range processes {
		if process.Name() == strconv.Itoa(except) {
			continue
		}
		if _, err := strconv.Atoi(process.Name()); err != nil {
			continue
		}
		base := filepath.Join(proc, process.Name())
		if stat, err := os.ReadFile(filepath.Join(base, "stat")); err == nil {
			if i := strings.LastIndex(string(stat), ") "); i >= 0 && strings.HasPrefix(string(stat)[i+2:], "Z ") {
				continue
			}
		}
		name, err := os.ReadFile(filepath.Join(base, "comm"))
		if err != nil || strings.TrimSpace(string(name)) != "codex" {
			continue
		}
		command, err := os.ReadFile(filepath.Join(base, "cmdline"))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return fmt.Errorf("无法核实 Codex 终端占用")
		}
		args := strings.Split(strings.TrimRight(string(command), "\x00"), "\x00")
		if len(args) == 0 || args[0] == "" {
			continue // The process may have exited since comm was read.
		}
		// The CLI binary also runs the Linux sandbox under a different argv[0],
		// while /proc/comm still says "codex". It is a tool worker, not a TUI.
		if filepath.Base(args[0]) == "codex-linux-sandbox" {
			continue
		}
		// These are tools and servers, not an interactive terminal composer.
		subcommands := map[string]bool{"app-server": true, "exec-server": true, "exec": true, "review": true, "login": true, "logout": true, "mcp": true, "plugin": true, "features": true, "doctor": true, "queue": true, "agents": true, "cloud": true, "debug": true, "sandbox": true, "completion": true, "update": true, "archive": true, "unarchive": true, "delete": true, "migrate-rollouts": true, "remote-control": true}
		if len(args) > 1 && subcommands[args[1]] {
			continue
		}
		match, dir := false, ""
		for i, arg := range args[1:] {
			if id != "" && arg == id {
				match = true
			}
			if (arg == "--cd" || arg == "-C") && i+2 < len(args) {
				dir = args[i+2]
			}
			if strings.HasPrefix(arg, "--cd=") {
				dir = strings.TrimPrefix(arg, "--cd=")
			}
		}
		processCwd, err := os.Readlink(filepath.Join(base, "cwd"))
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("无法核实 Codex 终端的工作目录")
		}
		if dir == "" {
			dir = processCwd
		} else if !filepath.IsAbs(dir) {
			dir = filepath.Join(processCwd, dir)
		}
		if canonical, err := filepath.EvalSymlinks(dir); err == nil {
			dir = canonical
		}
		if match || (dir != "" && filepath.Clean(dir) == filepath.Clean(cwd)) {
			return fmt.Errorf("此会话或工作目录仍有 Codex 终端打开；可对工作台管理的终端使用“切换到侧栏”。手动启动且无法核实归属的终端须先退出 Codex")
		}
	}
	return nil
}
