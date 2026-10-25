package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// PickDirectory opens a host folder picker. An empty path means cancellation.
func PickDirectory(ctx context.Context) (string, error) {
	cmd, cancelCode, err := directoryDialogCommand(ctx, runtime.GOOS, exec.LookPath, os.Getenv)
	if err != nil {
		return "", err
	}
	HideCommand(cmd)
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("文件夹选择已结束，请重试：%w", ctx.Err())
		}
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == cancelCode {
			return "", nil
		}
		return "", fmt.Errorf("无法打开文件夹选择窗口，请手动填写绝对路径：%w", err)
	}
	path := strings.TrimRight(string(out), "\r\n")
	if path == "" {
		return "", nil
	}
	info, err := os.Stat(path)
	if !filepath.IsAbs(path) || err != nil || !info.IsDir() {
		return "", fmt.Errorf("所选文件夹不可用，请重新选择或手动填写绝对路径。")
	}
	return filepath.Clean(path), nil
}

func directoryDialogCommand(ctx context.Context, system string, lookPath func(string) (string, error), getenv func(string) string) (*exec.Cmd, int, error) {
	switch system {
	case "darwin":
		return exec.CommandContext(ctx, "/usr/bin/osascript", "-e", `with timeout of 600 seconds
try
  return POSIX path of (choose folder with prompt "选择 Git 仓库主目录")
on error number -128
  return ""
end try
end timeout`), -1, nil
	case "windows":
		return exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 Git 仓库主目录'
$dialog.ShowNewFolderButton = $false
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }
} finally { $dialog.Dispose() }`), -1, nil
	case "linux":
		if getenv("DISPLAY") == "" && getenv("WAYLAND_DISPLAY") == "" {
			return nil, -1, fmt.Errorf("当前环境没有图形桌面，请手动填写仓库的绝对路径。")
		}
		if executable, err := lookPath("zenity"); err == nil {
			return exec.CommandContext(ctx, executable, "--file-selection", "--directory", "--title=选择 Git 仓库主目录"), 1, nil
		}
		if executable, err := lookPath("kdialog"); err == nil {
			return exec.CommandContext(ctx, executable, "--getexistingdirectory", getenv("HOME"), "--title", "选择 Git 仓库主目录"), 1, nil
		}
		return nil, -1, fmt.Errorf("未找到文件夹选择工具，请安装 zenity 或 kdialog，或手动填写绝对路径。")
	default:
		return nil, -1, fmt.Errorf("当前系统不支持文件夹选择，请手动填写绝对路径。")
	}
}
