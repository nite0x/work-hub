package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type TerminalSettings struct {
	Kind  string `json:"kind"`
	Path  string `json:"path"`
	Style string `json:"style"`
}

func defaultTerminalSettings() TerminalSettings {
	if runtime.GOOS == "windows" {
		if _, err := exec.LookPath("wt.exe"); err == nil {
			return TerminalSettings{Kind: "windows-terminal", Style: "windows-terminal"}
		}
		return TerminalSettings{Kind: "powershell", Style: "powershell"}
	}
	if os.Getenv("WSL_DISTRO_NAME") != "" {
		return TerminalSettings{Kind: "windows-terminal", Style: "windows-terminal"}
	}
	return TerminalSettings{Kind: "auto", Style: "command"}
}

func (s TerminalSettings) label() string {
	switch s.Kind {
	case "windows-terminal":
		return " Windows Terminal "
	case "otty":
		return " Otty "
	case "powershell":
		return " PowerShell "
	case "custom":
		return "自定义终端"
	default:
		return "系统终端"
	}
}

func (a *App) terminalSettings() (TerminalSettings, error) {
	var raw string
	err := a.db.QueryRow(`SELECT value FROM settings WHERE key='terminal'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultTerminalSettings(), nil
	}
	if err != nil {
		return TerminalSettings{}, err
	}
	var settings TerminalSettings
	err = json.Unmarshal([]byte(raw), &settings)
	return settings, err
}

func (a *App) terminalSettingsHandler(w http.ResponseWriter, r *http.Request) {
	var settings TerminalSettings
	if !decode(w, r, &settings) {
		return
	}
	settings.Path = strings.TrimSpace(settings.Path)
	switch settings.Kind {
	case "windows-terminal", "otty", "powershell":
		settings.Path = ""
		settings.Style = settings.Kind
	case "custom":
		if settings.Style != "windows-terminal" && settings.Style != "otty" && settings.Style != "command" {
			writeError(w, 400, "请选择自定义终端的启动方式")
			return
		}
		var err error
		if a.workspace != nil {
			err = a.workspace.call(r.Context(), workspaceRequest{Op: "validate-terminal", Path: settings.Path}, nil)
		} else {
			_, err = customTerminalPath(settings.Path)
		}
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
	case "auto":
		settings.Path, settings.Style = "", "command"
	default:
		writeError(w, 400, "请选择 Windows Terminal、Otty 或自定义终端")
		return
	}
	// Save valid preferences even if an app is temporarily unavailable (e.g. before installation).
	a.mu.Lock()
	raw, err := json.Marshal(settings)
	if err == nil {
		_, err = a.db.Exec(`INSERT INTO settings(key,value) VALUES('terminal',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, string(raw))
	}
	a.mu.Unlock()
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, 200, a.stateCache.resolve(settings))
}

// Paths are executable names only; never evaluate them as a shell command.
func customTerminalPath(raw string) (string, error) {
	if raw == "" || strings.ContainsAny(raw, "\x00\r\n\"") {
		return "", fmt.Errorf("请输入终端程序的绝对路径，不要添加引号或命令参数")
	}
	if len(raw) >= 3 && raw[1] == ':' && (raw[2] == '\\' || raw[2] == '/') {
		if runtime.GOOS != "windows" {
			raw = "/mnt/" + strings.ToLower(raw[:1]) + "/" + strings.ReplaceAll(raw[3:], "\\", "/")
		}
	}
	if !filepath.IsAbs(raw) {
		return "", fmt.Errorf("请输入终端程序的绝对路径，例如 C:\\Program Files\\Otty\\bin\\otty.exe 或 /mnt/c/...")
	}
	return filepath.Clean(raw), nil
}

func resolveTerminal(settings TerminalSettings) (string, error) {
	if settings.Kind == "powershell" {
		if runtime.GOOS != "windows" {
			return "", fmt.Errorf("独立 PowerShell 终端仅用于 Windows 本机")
		}
		return exec.LookPath("powershell.exe")
	}
	switch settings.Kind {
	case "windows-terminal":
		if path, err := exec.LookPath("wt.exe"); err == nil {
			return path, nil
		}
	case "otty":
		if path, err := exec.LookPath("otty.exe"); err == nil {
			return ottyCLIPath(path), nil
		}
		for _, base := range []string{windowsLocalAppData(), "/mnt/c/Program Files", "/mnt/c/Program Files (x86)"} {
			if base == "" {
				continue
			}
			for _, rel := range []string{"Programs/otty/bin/otty.exe", "Programs/otty/otty.exe", "Otty/bin/otty.exe", "Otty/otty.exe"} {
				if path, err := exec.LookPath(filepath.Join(base, rel)); err == nil {
					return ottyCLIPath(path), nil
				}
			}
		}
	case "custom":
		path, err := customTerminalPath(settings.Path)
		if err != nil {
			return "", err
		}
		if path, err = exec.LookPath(path); err == nil {
			if st, err := os.Stat(path); err == nil && !st.IsDir() {
				if settings.Style == "otty" {
					return ottyCLIPath(path), nil
				}
				return path, nil
			}
		}
		return "", fmt.Errorf("自定义终端程序不存在或不可执行，请在“终端设置”检查路径")
	case "auto":
		for _, name := range []string{"x-terminal-emulator", "gnome-terminal", "konsole"} {
			if path, err := exec.LookPath(name); err == nil {
				return path, nil
			}
		}
	}
	return "", fmt.Errorf("未找到%s，请安装后重试，或在“终端设置”指定程序路径", settings.label())
}

func ottyCLIPath(path string) string {
	// Windows ships both a GUI executable and a control CLI under bin/.
	if cli, err := exec.LookPath(filepath.Join(filepath.Dir(path), "bin", "otty.exe")); err == nil {
		return cli
	}
	return path
}

var localAppDataOnce sync.Once
var localAppDataPath string

func windowsLocalAppData() string {
	localAppDataOnce.Do(func() {
		raw := os.Getenv("LOCALAPPDATA")
		if raw == "" && os.Getenv("WSL_DISTRO_NAME") != "" {
			// Query the current Windows user only; do not scan other users' installations.
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			out, err := exec.CommandContext(ctx, "cmd.exe", "/d", "/c", "echo", "%LOCALAPPDATA%").Output()
			if err == nil {
				raw = strings.TrimSpace(string(out))
			}
		}
		localAppDataPath, _ = customTerminalPath(raw)
	})
	return localAppDataPath
}

func terminalCommand(settings TerminalSettings, launcher, distro string, p LaunchPlan) (*exec.Cmd, error) {
	command := []string{"bash", p.Script}
	if runtime.GOOS == "windows" {
		command = []string{"powershell.exe", "-NoLogo", "-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", p.Script}
	} else if strings.EqualFold(filepath.Ext(launcher), ".exe") {
		if distro == "" {
			return nil, fmt.Errorf("Windows 终端需要从 WSL 服务启动，请检查 WSL_DISTRO_NAME")
		}
		command = append([]string{"wsl.exe", "-d", distro, "--cd", p.Cwd, "--exec"}, command...)
	}
	style := settings.Style
	if settings.Kind != "custom" {
		style = settings.Kind
	}
	var args []string
	switch style {
	case "powershell":
		if runtime.GOOS != "windows" {
			return nil, fmt.Errorf("PowerShell 终端仅用于 Windows 本机")
		}
		args = command[1:]
	case "windows-terminal":
		args = append([]string{"-w", "new", "new-tab", "--title", p.Title}, command...)
	case "otty":
		parts := make([]string, len(command))
		for i, arg := range command {
			if strings.EqualFold(filepath.Ext(launcher), ".exe") {
				parts[i] = windowsQuoteArg(arg)
			} else {
				parts[i] = shellQuote(arg)
			}
		}
		args = []string{"tab", "new", "--json", "--title", p.Title, "--command", strings.Join(parts, " ")}
	case "command":
		args = append([]string{"-e"}, command...)
	case "auto":
		flag := "-e"
		if filepath.Base(launcher) == "gnome-terminal" {
			flag = "--"
		}
		args = append([]string{flag}, command...)
	default:
		return nil, fmt.Errorf("不支持的终端启动方式，请重新保存终端设置")
	}
	return exec.Command(launcher, args...), nil
}

// Quote a Windows argv element for CreateProcess / CommandLineToArgvW, including
// embedded quotes and trailing backslashes. This string is never a shell script.
func windowsQuoteArg(arg string) string {
	var out strings.Builder
	out.WriteByte('"')
	backslashes := 0
	for _, c := range arg {
		if c == '\\' {
			backslashes++
			continue
		}
		if c == '"' {
			out.WriteString(strings.Repeat("\\", backslashes*2+1))
		} else {
			out.WriteString(strings.Repeat("\\", backslashes))
		}
		backslashes = 0
		out.WriteRune(c)
	}
	out.WriteString(strings.Repeat("\\", backslashes*2))
	out.WriteByte('"')
	return out.String()
}

func launchOtty(launcher string, args []string, cwd string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return launchOttyContext(ctx, launcher, args, cwd)
}

func launchOttyContext(ctx context.Context, launcher string, args []string, cwd string) error {
	run := func(args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, launcher, args...)
		cmd.Dir = cwd
		return cmd.CombinedOutput()
	}
	out, err := run(args...)
	if err != nil && strings.Contains(string(out), "Cannot connect to Otty") {
		// The CLI needs a running GUI. Start it, then create our own new tab;
		// never send commands into an existing user pane.
		// The GUI can inherit the CLI's output handles. Do not capture its output
		// or wait for EOF: those handles may stay open for the GUI's lifetime.
		start := exec.Command(launcher, "open", "--json")
		start.Dir = cwd
		if startErr := start.Start(); startErr != nil {
			return fmt.Errorf("无法启动 Otty，请检查终端程序路径：%w", startErr)
		}
		go func() { _ = start.Wait() }()
		for {
			select {
			case <-ctx.Done():
				return fmt.Errorf("等待 Otty 初始化超时或已取消，请稍后重试：%w", ctx.Err())
			case <-time.After(200 * time.Millisecond):
			}
			out, err = run(args...)
			// On cold start the IPC server accepts requests before the GUI has
			// registered tab.new. Retry that explicit rejection too; never retry
			// a timed-out creation whose outcome is unknown (it could duplicate tabs).
			if err == nil || (!strings.Contains(string(out), "Cannot connect to Otty") &&
				!strings.Contains(string(out), "unknown command: tab.new")) {
				break
			}
		}
	}
	if ctx.Err() != nil {
		return fmt.Errorf("等待 Otty 响应超时或已取消，请稍后重试：%w", ctx.Err())
	}
	if err != nil {
		if strings.Contains(string(out), "unknown command: tab.new") {
			return fmt.Errorf("当前运行中的 Otty 不支持新建标签页并执行 WSL 命令。请完全退出并重新打开 Otty 后重试；仍失败时请更新 Otty，或在“终端设置”选择 Windows Terminal")
		}
		return fmt.Errorf("无法打开 Otty：%w；%s", err, strings.TrimSpace(string(out)))
	}
	var result struct {
		OK   bool `json:"ok"`
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(out, &result) != nil || !result.OK || result.Data.ID == "" {
		return fmt.Errorf("Otty 未确认标签页创建，请将程序路径指向安装目录下的 bin/otty.exe 命令行程序")
	}
	return nil
}
