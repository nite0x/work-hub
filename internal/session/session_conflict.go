package session

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

func (a *Service) AppTerminalConflict(id, cwd string) error {
	if id == "" {
		return nil // A new conversation cannot be owned by an existing terminal.
	}
	if b := a.TerminalOwner(id, cwd); b != nil {
		b.mu.Lock()
		connected, revoked := b.connected, b.revoked
		b.mu.Unlock()
		if !revoked {
			if !connected {
				return fmt.Errorf("终端正在启动，尚未连接；请稍候。启动失败后会自动释放占用（最多 30 秒）")
			}
			return fmt.Errorf("工作台终端保有此会话的控制权，请使用“切换到侧栏”等待交接完成")
		}
	}
	return a.terminalConflict(id, cwd)
}

func (a *Service) TerminalOwner(id, cwd string) *terminalBridge {
	a.bridgeMu.Lock()
	defer a.bridgeMu.Unlock()
	for _, b := range a.bridges {
		b.mu.Lock()
		owns := !b.revoked && id != "" && b.session == id
		b.mu.Unlock()
		if owns {
			return b
		}
	}
	return nil
}

// Only an identified conversation is exclusive. Independent conversations may
// share a directory; shared-daemon activity checks also cover CLI-created turns.
func TerminalSessionConflict(id, cwd string) error { return terminalSessionConflict(id, cwd) }
func terminalSessionConflict(id, cwd string) error {
	if id == "" {
		return nil
	}
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return nativeTerminalConflict(id, cwd)
	}
	return scanTerminalSessions("/proc", id, cwd)
}
func scanTerminalSessions(proc, id, cwd string) error {
	return scanTerminalSessionsExcept(proc, id, cwd, 0)
}
func scanTerminalSessionsExcept(proc, id, cwd string, except int) error {
	if id == "" {
		return nil
	}
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
		if len(args) > 1 && isCodexServerCommand(args[1]) {
			continue
		}
		for _, arg := range args[1:] {
			if arg == id {
				return fmt.Errorf("此会话仍有 Codex 终端打开；可对工作台管理的终端使用“切换到侧栏”。手动启动的同会话终端须先退出 Codex")
			}
		}
	}
	return nil
}

func isCodexServerCommand(command string) bool {
	switch command {
	case "app-server", "exec-server", "exec", "review", "login", "logout", "mcp", "plugin", "features", "doctor", "queue", "agents", "cloud", "debug", "sandbox", "completion", "update", "archive", "unarchive", "delete", "migrate-rollouts", "remote-control":
		return true
	}
	return false
}
