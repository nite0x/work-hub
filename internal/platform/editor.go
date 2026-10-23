package platform

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// EditorCommand uses argument arrays throughout; repository paths are never
// interpolated into shell commands. WSL directories are opened on the host.
func EditorCommand(tool, path, distro string) (*exec.Cmd, error) {
	if tool != "vscode" && tool != "idea" {
		return nil, fmt.Errorf("不支持的编辑器")
	}
	if runtime.GOOS == "darwin" {
		app := "Visual Studio Code"
		if tool == "idea" {
			app = "IntelliJ IDEA"
		}
		return exec.Command("open", "-a", app, path), nil
	}
	if runtime.GOOS == "windows" {
		executable, err := windowsEditor(tool)
		if err != nil {
			return nil, err
		}
		return exec.Command(executable, windowsEditorArgs(tool, path, distro)...), nil
	}
	names := []string{"code"}
	if tool == "idea" {
		names = []string{"idea", "idea.sh", "idea64.exe"}
	}
	for _, name := range names {
		if executable, err := exec.LookPath(name); err == nil {
			if strings.HasSuffix(executable, ".exe") && os.Getenv("WSL_DISTRO_NAME") != "" {
				path = `\\wsl.localhost\` + os.Getenv("WSL_DISTRO_NAME") + strings.ReplaceAll(path, "/", `\`)
			}
			if tool == "vscode" {
				return exec.Command(executable, "--new-window", path), nil
			}
			return exec.Command(executable, path), nil
		}
	}
	return nil, fmt.Errorf("未找到 %s，请安装并将 %s 命令加入应用运行环境的 PATH 后重试", map[string]string{"vscode": "VS Code", "idea": "IntelliJ IDEA"}[tool], strings.Join(names, " / "))
}

func windowsEditorArgs(tool, path, distro string) []string {
	if distro != "" {
		if tool == "vscode" {
			uri := (&url.URL{Scheme: "vscode-remote", Host: "wsl+" + distro, Path: path}).String()
			return []string{"--new-window", "--folder-uri", uri}
		}
		path = `\\wsl.localhost\` + distro + strings.ReplaceAll(path, "/", `\`)
	}
	if tool == "vscode" {
		return []string{"--new-window", path}
	}
	return []string{path}
}

func windowsEditor(tool string) (string, error) {
	names := []string{"Code.exe"}
	if tool == "idea" {
		names = []string{"idea64.exe", "idea.exe"}
	}
	for _, name := range names {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	var patterns []string
	local := os.Getenv("LOCALAPPDATA")
	if tool == "vscode" {
		for _, root := range []string{filepath.Join(local, "Programs"), os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
			if root != "" {
				patterns = append(patterns, filepath.Join(root, "Microsoft VS Code", "Code.exe"))
			}
		}
	} else {
		for _, root := range []string{os.Getenv("ProgramFiles"), filepath.Join(local, "Programs")} {
			if root != "" {
				patterns = append(patterns, filepath.Join(root, "JetBrains", "IntelliJ IDEA*", "bin", "idea64.exe"), filepath.Join(root, "IntelliJ IDEA*", "bin", "idea64.exe"))
			}
		}
		patterns = append(patterns, filepath.Join(local, "JetBrains", "Toolbox", "apps", "IDEA-*", "ch-*", "*", "bin", "idea64.exe"))
	}
	for _, pattern := range patterns {
		matches, _ := filepath.Glob(pattern)
		sort.Sort(sort.Reverse(sort.StringSlice(matches)))
		for _, path := range matches {
			if st, err := os.Stat(path); err == nil && st.Mode().IsRegular() {
				return path, nil
			}
		}
	}
	return "", fmt.Errorf("未找到 %s，请安装到标准目录，或将 %s 加入 PATH 后重启工作台", tool, strings.Join(names, " / "))
}

func OpenEditor(tool, path, distro string) error {
	cmd, err := EditorCommand(tool, path, distro)
	if err != nil {
		return err
	}
	return startDesktopCommand(cmd)
}

func OpenExternal(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return fmt.Errorf("仓库网址无效")
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", u.String())
	case "darwin":
		cmd = exec.Command("open", u.String())
	default:
		if path, err := exec.LookPath("wslview"); err == nil {
			cmd = exec.Command(path, u.String())
		} else {
			cmd = exec.Command("xdg-open", u.String())
		}
	}
	return startDesktopCommand(cmd)
}

func startDesktopCommand(cmd *exec.Cmd) error {
	DetachGUICommand(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
