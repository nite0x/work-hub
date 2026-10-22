package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type LaunchPlan struct {
	Tool                  string   `json:"tool,omitempty"`
	Title                 string   `json:"title"`
	Cwd                   string   `json:"cwd"`
	Args                  []string `json:"args"`
	Command               string   `json:"command"`
	AdditionalDirectories []string `json:"additional_directories"`
	Script                string   `json:"-"`
	Requirement           string   `json:"-"`
	Session               string   `json:"-"`
}
type TerminalAvailability struct {
	Settings  TerminalSettings `json:"settings"`
	Available bool             `json:"available"`
	Codex     bool             `json:"codex"`
	Launcher  string           `json:"launcher"`
	Distro    string           `json:"distro"`
	Message   string           `json:"message"`
}

func terminalAvailability(settings TerminalSettings) TerminalAvailability {
	v := TerminalAvailability{Settings: settings, Distro: os.Getenv("WSL_DISTRO_NAME")}
	_, err := exec.LookPath("codex")
	v.Codex = err == nil
	v.Launcher, err = resolveTerminal(settings)
	v.Available = v.Launcher != ""
	if err != nil {
		v.Message = err.Error()
	} else if !v.Codex {
		v.Message = "终端可用；未找到 Codex CLI，可继续使用 Git 终端，安装 Codex 后可在终端对话"
	} else {
		v.Message = "将使用" + settings.label() + "打开独立终端；首次使用 Codex 时可能需要登录"
	}
	return v
}
func shellQuote(v string) string { return "'" + strings.ReplaceAll(v, "'", "'\"'\"'") + "'" }
func (a *App) makeLaunchPlan(r *http.Request, id string) (LaunchPlan, error) {
	q, err := a.requirement(id)
	if err != nil {
		return LaunchPlan{}, err
	}
	if q.State != "ready" {
		return LaunchPlan{}, fmt.Errorf("任务未就绪或已归档，不能启动 Codex")
	}
	ps, err := projectMap(r.Context(), a)
	if err != nil {
		return LaunchPlan{}, err
	}
	p := LaunchPlan{Title: "Codex · " + q.Name, Requirement: q.ID, Args: []string{}, AdditionalDirectories: []string{}}
	for _, m := range q.Members {
		if err := verifyMember(r.Context(), ps[m.ProjectID], m, q.Branch); err != nil {
			return LaunchPlan{}, fmt.Errorf("%s：%w", m.ProjectName, err)
		}
		if m.ProjectID == q.PrimaryProjectID {
			p.Cwd = m.Path
		} else {
			p.AdditionalDirectories = append(p.AdditionalDirectories, m.Path)
		}
	}
	if p.Cwd == "" {
		return LaunchPlan{}, fmt.Errorf("主项目 worktree 不存在")
	}
	p.Args = append(p.Args, "--cd", p.Cwd)
	for _, dir := range p.AdditionalDirectories {
		p.Args = append(p.Args, "--add-dir", dir)
	}
	parts := []string{"codex"}
	for _, v := range p.Args {
		parts = append(parts, shellQuote(v))
	}
	p.Command = strings.Join(parts, " ")
	if runtime.GOOS == "windows" && a.workspace == nil {
		p.Command = displayCommand("codex", p.Args, true)
	}
	return p, nil
}
func (a *App) launchPlanHandler(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, err := a.makeLaunchPlan(r, r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, 404, "任务不存在")
		return
	}
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, p)
}
func (a *App) launchHandler(w http.ResponseWriter, r *http.Request) {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	p, err := a.makeLaunchPlan(r, r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, 404, "任务不存在")
		return
	}
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
	if !a.readOnlySessions && a.busyWorkspace("", p.Cwd) {
		writeError(w, 409, "此目录正在侧栏运行，请等待完成或停止后再打开终端")
		return
	}
	if err := a.launchConflict("", p.Cwd); err != nil {
		writeError(w, 409, err.Error())
		return
	}
	a.launchCodexPlan(w, p)
}

func (a *App) launchCodexPlan(w http.ResponseWriter, p LaunchPlan) {
	if a.readOnlySessions || runtime.GOOS == "windows" || a.workspace != nil {
		if err := a.launchSimpleTerminal(p); err != nil {
			writeJSON(w, 503, map[string]string{"error": err.Error(), "command": p.Command})
			return
		}
		writeJSON(w, 200, map[string]string{"message": "已向终端发送启动请求，请在终端中对话", "command": p.Command})
		return
	}
	if err := os.MkdirAll(filepath.Join(a.dataDir, "launches"), 0700); err != nil {
		dbError(w, err)
		return
	}
	p.Script = filepath.Join(a.dataDir, "launches", newID()+".sh")
	b, err := a.newTerminalBridge(p.Requirement, p.Cwd)
	if err != nil {
		writeError(w, 503, "无法准备可交接终端："+err.Error())
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
	parts := []string{"codex"}
	for _, arg := range p.Args {
		parts = append(parts, shellQuote(arg))
	}
	p.Command = strings.Join(parts, " ")
	// Every argument is shell-quoted. No project or requirement text is evaluated as shell code.
	finishLaunch := "if [ -d " + shellQuote(b.dir) + " ]; then : > " + shellQuote(filepath.Join(b.dir, "launch-finished")) + "; fi"
	script := "#!/usr/bin/env bash\nexport PATH=\"$HOME/.local/bin:$PATH\"\n" +
		"finish_launch() { " + finishLaunch + "; }\ntrap finish_launch EXIT\n" +
		"cd -- " + shellQuote(p.Cwd) + " || exit 1\n" +
		"if ! codex login status >/dev/null 2>&1; then\n" +
		"  printf '%s\\n' 'WSL 中的 Codex 尚未登录。请先执行 codex login，登录完成后回工作台重新打开终端。'\n" +
		"  finish_launch\n  exec bash -i\nfi\n" + p.Command +
		"\nresult=$?\nfinish_launch\nstty sane 2>/dev/null || true\nprintf '\\nCodex 已退出或已交接到侧栏（%s）。当前终端保留在主项目目录。\\n' \"$result\"\nexec bash -i\n"
	if err := os.WriteFile(p.Script, []byte(script), 0700); err != nil {
		b.close()
		dbError(w, err)
		return
	}
	if err := a.launch(p); err != nil {
		b.close()
		_ = os.Remove(p.Script)
		writeJSON(w, 503, map[string]string{"error": err.Error(), "command": p.Command})
		return
	}
	writeJSON(w, 200, map[string]string{"message": "已向系统终端发送启动请求；可在终端内查看 Codex 状态", "command": p.Command})
}
func (a *App) launchTerminal(p LaunchPlan) error {
	settings, err := a.terminalSettings()
	if err != nil {
		return err
	}
	return a.startTerminal(settings, p)
}

func (a *App) startTerminal(settings TerminalSettings, p LaunchPlan) error {
	launcher, err := resolveTerminal(settings)
	if err != nil {
		return err
	}
	cmd, err := terminalCommand(settings, launcher, os.Getenv("WSL_DISTRO_NAME"), p)
	if err != nil {
		return err
	}
	if settings.Kind == "otty" || (settings.Kind == "custom" && settings.Style == "otty") {
		return launchOtty(launcher, cmd.Args[1:], p.Cwd)
	}
	cmd.Dir = p.Cwd
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("无法打开终端：%w", err)
	}
	go func() {
		if err := cmd.Wait(); err != nil && len(p.Args) > 0 {
			// Start can succeed even when the terminal launcher later rejects
			// the request. Release only this launch's unconnected reservation.
			a.bridgeMu.Lock()
			b := a.bridges[strings.TrimPrefix(p.Args[len(p.Args)-1], "unix://")]
			a.bridgeMu.Unlock()
			if b != nil {
				b.mu.Lock()
				unused := !b.connected
				if unused {
					b.revoked = true
				}
				b.mu.Unlock()
				if unused {
					b.close()
				}
			}
		}
	}()
	return nil
}
