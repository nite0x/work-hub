package platform

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

func DefaultDataDir() string {
	if runtime.GOOS == "windows" {
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			return filepath.Join(dir, "WorktreeHub")
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "worktree-hub")
}

// Remote Linux paths must not be interpreted using Windows filepath semantics.
func CleanWorkspacePath(p string) string {
	if strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "//") {
		return path.Clean(p)
	}
	return filepath.Clean(p)
}
func JoinWorkspacePath(root string, parts ...string) string {
	if strings.HasPrefix(root, "/") && !strings.HasPrefix(root, "//") {
		return path.Join(append([]string{root}, parts...)...)
	}
	return filepath.Join(append([]string{root}, parts...)...)
}
func BaseWorkspacePath(p string) string {
	if strings.HasPrefix(p, "/") {
		return path.Base(p)
	}
	return filepath.Base(p)
}
func AbsoluteWorkspacePath(p string) bool { return strings.HasPrefix(p, "/") || filepath.IsAbs(p) }
func SameWorkspacePath(a, b string) bool {
	a, b = CleanWorkspacePath(a), CleanWorkspacePath(b)
	if runtime.GOOS == "windows" && !strings.HasPrefix(a, "/") {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func NormalizePath(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if runtime.GOOS == "windows" {
		lower := strings.ToLower(strings.ReplaceAll(raw, "/", `\`))
		if strings.HasPrefix(lower, `\\wsl.localhost\`) || strings.HasPrefix(lower, `\\wsl$\`) {
			return "", fmt.Errorf("请先选择对应 WSL 执行环境，再填写 /home/... 路径")
		}
	}
	if runtime.GOOS != "windows" && len(raw) >= 3 && raw[1] == ':' && (raw[2] == '\\' || raw[2] == '/') {
		raw = "/mnt/" + strings.ToLower(raw[:1]) + "/" + strings.ReplaceAll(raw[3:], "\\", "/")
	}
	if strings.HasPrefix(raw, "~/") {
		home, _ := os.UserHomeDir()
		raw = filepath.Join(home, raw[2:])
	}
	if !filepath.IsAbs(raw) {
		return "", fmt.Errorf("请输入当前执行环境中的绝对目录路径")
	}
	path, err := filepath.EvalSymlinks(filepath.Clean(raw))
	if err != nil {
		return "", err
	}
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !st.IsDir() {
		return "", fmt.Errorf("路径必须是文件夹")
	}
	return path, nil
}
func Within(root, path string) bool {
	if strings.HasPrefix(root, "/") {
		root, path = CleanWorkspacePath(root), CleanWorkspacePath(path)
		return strings.HasPrefix(path, strings.TrimSuffix(root, "/")+"/") && path != root
	}
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
