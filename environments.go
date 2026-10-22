package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

type Environment struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Distro         string `json:"distro,omitempty"`
	User           string `json:"user,omitempty"`
	Root           string `json:"root"`
	Connected      bool   `json:"connected"`
	ImportExisting bool   `json:"import_existing,omitempty"`
}
type environmentHub struct {
	mu      sync.Mutex
	local   *App
	entries []Environment
	apps    map[string]*App
	stops   map[string]func()
}

func newEnvironmentHub(a *App) (*environmentHub, error) {
	h := &environmentHub{local: a, apps: map[string]*App{}, stops: map[string]func(){}}
	raw, err := os.ReadFile(filepath.Join(a.dataDir, "environments.json"))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &h.entries); err != nil {
			return nil, fmt.Errorf("无法读取执行环境配置：%w", err)
		}
	}
	for _, e := range h.entries {
		if e.ID != environmentID(e.Distro, e.User) {
			return nil, fmt.Errorf("执行环境标识无效")
		}
	}
	a.environments = h
	return h, nil
}
func environmentID(distro, user string) string {
	sum := sha256.Sum256([]byte(distro + "\x00" + user))
	return "wsl-" + hex.EncodeToString(sum[:8])
}
func (h *environmentHub) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, a := range h.apps {
		if stop := h.stops[id]; stop != nil {
			stop()
		}
		a.stateCache.close()
		a.closeChats()
		a.closeBridges()
		a.workspace.close()
		_ = a.db.Close()
	}
}
func (h *environmentHub) get(id string) (*App, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if a := h.apps[id]; a != nil {
		select {
		case <-a.workspace.done:
			return nil, fmt.Errorf("WSL 连接已断开，请在执行环境设置中重新连接")
		default:
			return a, nil
		}
	}
	for _, entry := range h.entries {
		if entry.ID == id {
			return h.connectLocked(entry)
		}
	}
	return nil, fmt.Errorf("执行环境不存在，请重新选择")
}
func (h *environmentHub) connectLocked(e Environment) (*App, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := startWSLWorkspace(ctx, e.Distro, e.User)
	if err != nil {
		return nil, err
	}
	if e.User != "" && e.User != c.identity.User {
		c.close()
		return nil, fmt.Errorf("WSL 用户与已登记环境不一致")
	}
	if e.Root == "" {
		e.Root = joinWorkspacePath(c.identity.Home, "workspaces")
	}
	// Metadata is partitioned by environment, but all databases live on the
	// Windows host. The helper never stores project/task records.
	a, err := openAppForWorkspace(filepath.Join(h.local.dataDir, "environments", e.ID), e.Root, c)
	if err != nil {
		c.close()
		return nil, err
	}
	a.token = h.local.token
	a.readOnlySessions = true
	h.apps[e.ID] = a
	h.stops[e.ID] = a.startMasterSync(context.Background())
	return a, nil
}
func (h *environmentHub) listHandler(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	entries := []Environment{{ID: "local", Name: "本机 · " + runtime.GOOS, Root: h.local.root, Connected: true}}
	for _, e := range h.entries {
		if a := h.apps[e.ID]; a != nil {
			select {
			case <-a.workspace.done:
			default:
				e.Connected = true
			}
		}
		entries = append(entries, e)
	}
	h.mu.Unlock()
	distros, err := listWSLDistributions(r.Context())
	message := ""
	if err != nil {
		message = err.Error()
	}
	writeJSON(w, 200, map[string]any{"environments": entries, "distributions": distros, "wsl_message": message})
}
func (h *environmentHub) addHandler(w http.ResponseWriter, r *http.Request) {
	var e Environment
	if !decode(w, r, &e) {
		return
	}
	e.Distro = strings.TrimSpace(e.Distro)
	e.User = strings.TrimSpace(e.User)
	distros, err := listWSLDistributions(r.Context())
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	found := false
	for _, d := range distros {
		if d == e.Distro {
			found = true
		}
	}
	if !found {
		writeError(w, 400, "请选择已安装的 WSL 发行版")
		return
	}
	if strings.ContainsAny(e.User, "\x00\r\n") || strings.HasPrefix(e.User, "-") {
		writeError(w, 400, "WSL 用户名无效")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	c, err := startWSLWorkspace(ctx, e.Distro, e.User)
	if err != nil {
		writeError(w, 503, err.Error())
		return
	}
	e.User = c.identity.User
	e.ID = environmentID(e.Distro, e.User)
	e.Name = "WSL · " + e.Distro + " / " + e.User
	if e.Root == "" {
		e.Root = joinWorkspacePath(c.identity.Home, "workspaces")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, old := range h.entries {
		if old.ID == e.ID {
			c.close()
			writeError(w, 409, "该 WSL 用户已经登记，请直接选择或重新连接")
			return
		}
	}
	a, err := openAppForWorkspace(filepath.Join(h.local.dataDir, "environments", e.ID), e.Root, c)
	if err != nil {
		c.close()
		writeError(w, 422, err.Error())
		return
	}
	if e.ImportExisting {
		var snapshot metadataSnapshot
		err := c.call(r.Context(), workspaceRequest{Op: "export-metadata"}, &snapshot)
		if err == nil {
			err = a.importMetadata(snapshot)
		}
		if err != nil {
			a.stateCache.close()
			a.db.Close()
			c.close()
			writeError(w, 422, "导入原有 WSL 记录失败："+err.Error())
			return
		}
		e.ImportExisting = false
	}
	entries := append(append([]Environment{}, h.entries...), e)
	raw, _ := json.MarshalIndent(entries, "", "  ")
	config := filepath.Join(h.local.dataDir, "environments.json")
	if err := os.WriteFile(config+".tmp", raw, 0600); err != nil {
		a.stateCache.close()
		a.db.Close()
		c.close()
		dbError(w, err)
		return
	}
	if err := os.Rename(config+".tmp", config); err != nil {
		a.stateCache.close()
		a.db.Close()
		c.close()
		dbError(w, err)
		return
	}
	h.entries = entries
	a.token = h.local.token
	a.readOnlySessions = true
	h.apps[e.ID] = a
	h.stops[e.ID] = a.startMasterSync(context.Background())
	e.Connected = true
	e.Root = a.root
	writeJSON(w, 201, e)
}
func (h *environmentHub) reconnectHandler(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	id := r.PathValue("environment")
	for _, e := range h.entries {
		if e.ID != id {
			continue
		}
		if old := h.apps[id]; old != nil {
			old.closing.Store(true)
			old.workspace.close()
			h.stops[id]()
			old.stateCache.close()
			old.mu.Lock()
			old.db.Close()
			old.mu.Unlock()
			delete(h.apps, id)
			delete(h.stops, id)
		}
		a, err := h.connectLocked(e)
		if err != nil {
			writeError(w, 503, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"id": id, "root": a.root})
		return
	}
	writeError(w, 404, "执行环境不存在")
}

func listWSLDistributions(parent context.Context) ([]string, error) {
	if runtime.GOOS != "windows" {
		return []string{}, fmt.Errorf("当前环境原生运行 Linux；WSL 接入在 Windows 桌面端提供")
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wsl.exe", "--list", "--quiet")
	hideCommand(cmd)
	raw, err := cmd.Output()
	if err != nil {
		return []string{}, fmt.Errorf("未检测到可用 WSL；本机项目可正常使用")
	}
	text := decodeWSLOutput(raw)
	out := []string{}
	for _, line := range strings.Split(text, "\n") {
		if name := strings.TrimSpace(line); name != "" {
			out = append(out, name)
		}
	}
	return out, nil
}
func decodeWSLOutput(raw []byte) string {
	if bytes.Contains(raw, []byte{0}) {
		u := make([]uint16, 0, len(raw)/2)
		for i := 0; i+1 < len(raw); i += 2 {
			u = append(u, uint16(raw[i])|uint16(raw[i+1])<<8)
		}
		return strings.TrimPrefix(string(utf16.Decode(u)), "\ufeff")
	}
	return string(raw)
}
func wslArgs(distro, user string, args ...string) []string {
	out := []string{"-d", distro}
	if user != "" {
		out = append(out, "-u", user)
	}
	return append(append(out, "--exec"), args...)
}
func startWSLWorkspace(parent context.Context, distro, user string) (*workspaceClient, error) {
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
	install := exec.CommandContext(parent, "wsl.exe", wslArgs(distro, user, "sh", "-c", script)...)
	install.Stdin = bytes.NewReader(payload)
	hideCommand(install)
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
	cmd := exec.Command("wsl.exe", wslArgs(distro, user, remote, "--workspace-agent")...)
	c, err := startWorkspaceClient(cmd)
	if err != nil {
		return nil, fmt.Errorf("连接 WSL 辅助程序失败：%w", err)
	}
	if c.identity.Distro != distro {
		c.close()
		return nil, fmt.Errorf("辅助程序返回了不同的发行版")
	}
	return c, nil
}
