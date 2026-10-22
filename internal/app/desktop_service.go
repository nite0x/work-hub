package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/platform"
)

const desktopProtocol = 1

// BuildVersion is set by the sidecar build script. Keep the desktop host and
// backend together when upgrading; protocol compatibility alone is insufficient.
var BuildVersion = "dev"

type desktopServiceInfo struct {
	URL      string `json:"url,omitempty"`
	Token    string `json:"token,omitempty"`
	Name     string `json:"name"`
	PID      int    `json:"pid"`
	Protocol int    `json:"protocol"`
	Version  string `json:"version"`
	DataDir  string `json:"data_dir"`
	Root     string `json:"root"`
	ReadOnly bool   `json:"read_only_sessions"`
	Ready    bool   `json:"ready"`
}

func (a *App) desktopInfo(address string) desktopServiceInfo {
	return desktopServiceInfo{URL: address, Token: a.token, Name: "worktree-hub", PID: os.Getpid(),
		Protocol: desktopProtocol, Version: BuildVersion, DataDir: a.Workspace.DataDir,
		Root: a.Workspace.Root, ReadOnly: a.Workspace.ReadOnlySessions, Ready: !a.Workspace.Closing.Load()}
}

func desktopHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: &http.Transport{Proxy: nil},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
}

// Publish a complete descriptor atomically. A crash must not leave half a JSON
// document for another launcher to read. The directory lock owns this file.
func writeDesktopService(dataDir string, info desktopServiceInfo) error {
	f, err := os.CreateTemp(dataDir, ".service-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := json.NewEncoder(f).Encode(info); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(dataDir, "service.json"))
}

func readDesktopService(dataDir string) (desktopServiceInfo, error) {
	var info desktopServiceInfo
	raw, err := os.ReadFile(filepath.Join(dataDir, "service.json"))
	if err != nil {
		return info, err
	}
	if err := json.Unmarshal(raw, &info); err != nil {
		return info, err
	}
	u, err := url.Parse(info.URL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || info.Token == "" {
		return info, fmt.Errorf("本机服务地址无效")
	}
	client := desktopHTTPClient(time.Second)
	defer client.CloseIdleConnections()
	r, _ := http.NewRequest("GET", info.URL+"/healthz", nil)
	r.Header.Set("X-Worktree-Hub-Instance", info.Token)
	response, err := client.Do(r)
	if err != nil {
		return info, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return info, fmt.Errorf("后台实例认证失败")
	}
	var live desktopServiceInfo
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&live); err != nil {
		return info, err
	}
	if live.Name != "worktree-hub" || live.PID != info.PID {
		return info, fmt.Errorf("后台实例身份不符")
	}
	if live.Protocol != 0 {
		if live.Protocol != info.Protocol || live.Version != info.Version || live.DataDir != info.DataDir || live.Root != info.Root {
			return info, fmt.Errorf("后台实例信息已变化，请重新打开应用")
		}
		info.ReadOnly, info.Ready = live.ReadOnly, live.Ready
	}
	return info, nil
}

var errDesktopConflict = errors.New("后台配置不兼容")

func compatibleDesktopService(info desktopServiceInfo, dataDir, root string, rootExplicit bool) error {
	if info.Protocol != desktopProtocol || info.Version != BuildVersion || !info.ReadOnly {
		return fmt.Errorf("%w：请先通过原版本的 --stop 安全停止后台，再打开桌面端", errDesktopConflict)
	}
	if !info.Ready {
		return fmt.Errorf("%w：后台正在退出，请稍后重试", errDesktopConflict)
	}
	actualData := info.DataDir
	if resolved, err := filepath.EvalSymlinks(actualData); err == nil {
		actualData = resolved
	}
	if resolved, err := filepath.EvalSymlinks(dataDir); err == nil {
		dataDir = resolved
	}
	if !platform.SameWorkspacePath(actualData, dataDir) {
		return fmt.Errorf("%w：数据目录不一致", errDesktopConflict)
	}
	if rootExplicit {
		requested, err := filepath.Abs(root)
		if err != nil {
			return err
		}
		if resolved, err := filepath.EvalSymlinks(requested); err == nil {
			requested = resolved
		}
		if !platform.SameWorkspacePath(info.Root, requested) {
			return fmt.Errorf("%w：已运行后台的工作区为 %s；请先停止后台再更改 --root", errDesktopConflict, info.Root)
		}
	}
	return nil
}

// The short-lived launcher exits after this handshake. Its child is detached,
// with stdin disconnected and logs on disk, so closing Tauri cannot stop it.
func ensureDesktopService(dataDir, root, listen string, rootExplicit bool) (desktopServiceInfo, error) {
	var empty desktopServiceInfo
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return empty, err
	}
	dataDir, err := filepath.EvalSymlinks(dataDir)
	if err != nil {
		return empty, err
	}
	dataDir, err = filepath.Abs(dataDir)
	if err != nil {
		return empty, err
	}
	read := func() (desktopServiceInfo, error) {
		info, err := readDesktopService(dataDir)
		if err == nil {
			err = compatibleDesktopService(info, dataDir, root, rootExplicit)
		}
		return info, err
	}
	if info, err := read(); err == nil || errors.Is(err, errDesktopConflict) {
		return info, err
	}
	executable, err := os.Executable()
	if err != nil {
		return empty, err
	}
	logFile, err := os.OpenFile(filepath.Join(dataDir, "desktop.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return empty, err
	}
	cmd := exec.Command(executable, "--headless", "--data", dataDir, "--root", root, "--listen", listen)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	platform.DetachCommand(cmd)
	err = cmd.Start()
	logFile.Close()
	if err != nil {
		return empty, err
	}
	_ = cmd.Process.Release()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		info, err := read()
		if err == nil || errors.Is(err, errDesktopConflict) {
			return info, err
		}
		time.Sleep(100 * time.Millisecond)
	}
	return empty, fmt.Errorf("本机后台未能启动，请查看 %s", filepath.Join(dataDir, "desktop.log"))
}
func runDesktopHost(dataDir, root, listen string) error {
	info, err := readDesktopService(dataDir)
	if err != nil {
		if err := os.MkdirAll(dataDir, 0700); err != nil {
			return err
		}
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		logFile, err := os.OpenFile(filepath.Join(dataDir, "desktop.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			return err
		}
		cmd := exec.Command(executable, "--headless", "--data", dataDir, "--root", root, "--listen", listen)
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		platform.HideCommand(cmd)
		if err := cmd.Start(); err != nil {
			logFile.Close()
			return err
		}
		_ = cmd.Process.Release()
		logFile.Close()
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			info, err = readDesktopService(dataDir)
			if err == nil {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if err != nil {
			return fmt.Errorf("本机后台未能启动，请查看 %s", filepath.Join(dataDir, "desktop.log"))
		}
	}
	return platform.ShowDesktop(info.URL, dataDir)
}

// Installers run this from a temporary copy before replacing the installed app.
// An absent or unlocked profile is already stopped, even with a stale descriptor.
// A locked profile must stop through the authenticated API; never kill its PID.
func prepareDesktopUpgrade(dataDir string) error {
	if _, err := os.Stat(dataDir); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if unlock, err := platform.LockDataDirectory(dataDir); err == nil {
		unlock()
		return nil
	}
	if err := stopDesktopService(dataDir); err != nil {
		return fmt.Errorf("安装前无法安全停止后台：%w", err)
	}
	return nil
}

func stopDesktopService(dataDir string) error {
	info, err := readDesktopService(dataDir)
	if err != nil {
		return fmt.Errorf("没有可连接的后台服务：%w", err)
	}
	r, _ := http.NewRequest("POST", info.URL+"/api/service/stop", nil)
	r.Header.Set("X-CSRF-Token", info.Token)
	client := desktopHTTPClient(5 * time.Second)
	defer client.CloseIdleConnections()
	response, err := client.Do(r)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		var result struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(response.Body).Decode(&result)
		return fmt.Errorf("无法退出后台：%s", result.Error)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for {
		// The directory lock outlives the descriptor and app.Close. Wait for both
		// descriptor removal and lock release; an HTTP failure alone proves nothing.
		if _, err := os.Stat(filepath.Join(dataDir, "service.json")); errors.Is(err, os.ErrNotExist) {
			if unlock, err := platform.LockDataDirectory(dataDir); err == nil {
				unlock()
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("等待后台退出超时")
		case <-time.After(100 * time.Millisecond):
		}
	}
}
func (a *App) stopServiceHandler(w http.ResponseWriter, r *http.Request) {
	apps := []*App{a}
	if a.environments != nil {
		a.environments.mu.Lock()
		defer a.environments.mu.Unlock()
		for _, remote := range a.environments.apps {
			apps = append(apps, remote)
		}
	}
	locked := []*App{}
	defer func() {
		for _, app := range locked {
			app.Workspace.Mu.Unlock()
		}
	}()
	for _, app := range apps {
		if !app.Workspace.Mu.TryLock() {
			httpx.WriteError(w, 409, "有项目操作正在执行，请完成后重试")
			return
		}
		locked = append(locked, app)
	}
	for _, app := range apps {
		app.Workspace.Closing.Store(true)
	}
	httpx.WriteJSON(w, 200, map[string]string{"message": "后台正在退出"})
	time.AfterFunc(100*time.Millisecond, a.shutdown)
}
