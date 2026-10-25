package session

import (
	"database/sql"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
)

func (a *Service) LaunchHandler(w http.ResponseWriter, r *http.Request) {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	p, err := a.plans.MakeLaunchPlan(r.Context(), r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "任务不存在")
		return
	}
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	if !a.Workspace.ReadOnlySessions && a.BusyWorkspace("", p.Cwd) {
		httpx.WriteError(w, 409, "此目录正在侧栏运行，请等待完成或停止后再打开终端")
		return
	}
	if err := a.LaunchConflict("", p.Cwd); err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	a.LaunchCodexPlan(w, p)
}

func (a *Service) LaunchCodexPlan(w http.ResponseWriter, p model.LaunchPlan) {
	// The managed terminal relay verifies peers through Linux /proc. Other
	// platforms use the normal terminal launcher while in-app chat stays enabled.
	if a.Workspace.ReadOnlySessions || runtime.GOOS != "linux" || a.Workspace.Remote != nil {
		if err := a.Workspace.LaunchSimpleTerminal(p); err != nil {
			httpx.WriteJSON(w, 503, map[string]string{"error": err.Error(), "command": p.Command})
			return
		}
		httpx.WriteJSON(w, 200, map[string]string{"message": "已向终端发送启动请求，请在终端中对话", "command": p.Command})
		return
	}
	if err := os.MkdirAll(filepath.Join(a.Workspace.DataDir, "launches"), 0700); err != nil {
		httpx.DbError(w, err)
		return
	}
	p.Script = filepath.Join(a.Workspace.DataDir, "launches", model.NewID()+".sh")
	b, err := a.NewTerminalBridge(p.Requirement, p.Cwd)
	if err != nil {
		httpx.WriteError(w, 503, "无法准备可交接终端："+err.Error())
		return
	}
	b.mu.Lock()
	b.session = p.Session
	b.additionalDirectories = append([]string{}, p.AdditionalDirectories...)
	b.mu.Unlock()
	// A private bridge identifies the live thread even when the TUI initially
	// creates it without a session ID in its command line.
	// Remote TUIs reject --add-dir; the bridge adds these roots to the server's
	// workspace-write policy when the TUI starts a turn instead.
	args := make([]string, 0, len(p.Args))
	for i := 0; i < len(p.Args); i++ {
		if p.Args[i] == "--add-dir" && i+1 < len(p.Args) {
			i++
			continue
		}
		args = append(args, p.Args[i])
	}
	p.Args = args
	p.Args = append(p.Args, "--remote", "unix://"+b.socket)
	p.Command = platform.DisplayCommand("codex", p.Args, false)
	// Every argument is shell-quoted. No project or requirement text is evaluated as shell code.
	finishLaunch := "if [ -d " + platform.ShellQuote(b.dir) + " ]; then : > " + platform.ShellQuote(filepath.Join(b.dir, "launch-finished")) + "; fi"
	script := "#!/usr/bin/env bash\nexport PATH=\"$HOME/.local/bin:$PATH\"\n" +
		"finish_launch() { " + finishLaunch + "; }\ntrap finish_launch EXIT\n" +
		"cd -- " + platform.ShellQuote(p.Cwd) + " || exit 1\n" +
		"if ! codex login status >/dev/null 2>&1; then\n" +
		"  printf '%s\\n' 'WSL 中的 Codex 尚未登录。请先执行 codex login，登录完成后回工作台重新打开终端。'\n" +
		"  finish_launch\n  exec bash -i\nfi\n" + p.Command +
		"\nresult=$?\nfinish_launch\nstty sane 2>/dev/null || true\nprintf '\\nCodex 已退出或已交接到侧栏（%s）。当前终端保留在主项目目录。\\n' \"$result\"\nexec bash -i\n"
	if err := os.WriteFile(p.Script, []byte(script), 0700); err != nil {
		b.Close()
		httpx.DbError(w, err)
		return
	}
	if err := a.Workspace.Launch(p, func() { a.releaseUnconnectedBridge(p) }); err != nil {
		b.Close()
		_ = os.Remove(p.Script)
		httpx.WriteJSON(w, 503, map[string]string{"error": err.Error(), "command": p.Command})
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"message": "已向系统终端发送启动请求；可在终端内查看 Codex 状态", "command": p.Command})
}
func (a *Service) LaunchConflict(session, cwd string) error {
	if a.Workspace.ReadOnlySessions {
		return nil
	}
	return a.AppTerminalConflict(session, cwd)
}
