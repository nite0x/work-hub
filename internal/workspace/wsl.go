package workspace

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf16"

	"worktree-hub/internal/platform"
)

func ListWSLDistributions(parent context.Context) ([]string, error) {
	if runtime.GOOS != "windows" {
		return []string{}, fmt.Errorf("当前环境原生运行 Linux；WSL 接入在 Windows 桌面端提供")
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wsl.exe", "--list", "--quiet")
	platform.HideCommand(cmd)
	raw, err := cmd.Output()
	if err != nil {
		return []string{}, fmt.Errorf("未检测到可用 WSL；本机项目可正常使用")
	}
	text := DecodeWSLOutput(raw)
	out := []string{}
	for _, line := range strings.Split(text, "\n") {
		if name := strings.TrimSpace(line); name != "" {
			out = append(out, name)
		}
	}
	return out, nil
}
func DecodeWSLOutput(raw []byte) string {
	if bytes.Contains(raw, []byte{0}) {
		u := make([]uint16, 0, len(raw)/2)
		for i := 0; i+1 < len(raw); i += 2 {
			u = append(u, uint16(raw[i])|uint16(raw[i+1])<<8)
		}
		return strings.TrimPrefix(string(utf16.Decode(u)), "\ufeff")
	}
	return string(raw)
}
func WSLArgs(distro, user string, args ...string) []string {
	out := []string{"-d", distro}
	if user != "" {
		out = append(out, "-u", user)
	}
	return append(append(out, "--exec"), args...)
}
func StartWSL(parent context.Context, distro, user string) (*Client, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	agent := os.Getenv("WORKTREE_HUB_AGENT")
	if agent == "" {
		agent = filepath.Join(filepath.Dir(executable), "agents", "worktree-hub-linux-"+runtime.GOARCH)
	}
	payload, err := os.ReadFile(agent)
	if err != nil {
		return nil, fmt.Errorf("未找到随安装包提供的 Linux 辅助程序：%w", err)
	}
	sum := sha256.Sum256(payload)
	digest := hex.EncodeToString(sum[:])
	// Only a generated hex digest enters this fixed bootstrap script. The
	// selected distro/user are separate wsl.exe arguments; binary bytes use stdin.
	script := `set -eu
dir="$HOME/.local/share/worktree-hub/agents/` + digest + `"
mkdir -p "$dir"
chmod 700 "$dir"
target="$dir/worktree-hub"
if [ -f "$target" ] && printf '%s  %s\n' '` + digest + `' "$target" | sha256sum -c - >/dev/null 2>&1; then
  cat >/dev/null
else
  tmp=$(mktemp "$dir/.install.XXXXXX")
  trap 'rm -f -- "$tmp"' EXIT
  cat > "$tmp"
  printf '%s  %s\n' '` + digest + `' "$tmp" | sha256sum -c - >/dev/null
  chmod 700 "$tmp"
  mv -f -- "$tmp" "$target"
fi
printf '%s\n' "$target"
`
	install := exec.CommandContext(parent, "wsl.exe", WSLArgs(distro, user, "sh", "-c", script)...)
	install.Stdin = bytes.NewReader(payload)
	platform.HideCommand(install)
	var diagnostic bytes.Buffer
	install.Stderr = &diagnostic
	raw, err := install.Output()
	if err != nil {
		return nil, fmt.Errorf("部署 WSL 辅助程序失败：%s", strings.TrimSpace(diagnostic.String()))
	}
	remote := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(remote, "/") || strings.ContainsAny(remote, "\r\n") {
		return nil, fmt.Errorf("辅助程序路径无效")
	}
	cmd := exec.Command("wsl.exe", WSLArgs(distro, user, remote, "--workspace-agent")...)
	c, err := StartClient(cmd)
	if err != nil {
		return nil, fmt.Errorf("连接 WSL 辅助程序失败：%w", err)
	}
	if c.Identity.Distro != distro {
		c.Close()
		return nil, fmt.Errorf("辅助程序返回了不同的发行版")
	}
	return c, nil
}
