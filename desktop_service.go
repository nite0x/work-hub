package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type desktopServiceInfo struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
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
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil {
		return info, fmt.Errorf("本机服务地址无效")
	}
	client := &http.Client{Timeout: time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
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
	return info, nil
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
		hideCommand(cmd)
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
	return showDesktop(info.URL, dataDir)
}
func stopDesktopService(dataDir string) error {
	info, err := readDesktopService(dataDir)
	if err != nil {
		return fmt.Errorf("没有可连接的后台服务：%w", err)
	}
	r, _ := http.NewRequest("POST", info.URL+"/api/service/stop", nil)
	r.Header.Set("X-CSRF-Token", info.Token)
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
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
		if _, err := readDesktopService(dataDir); err != nil {
			return nil
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
			app.mu.Unlock()
		}
	}()
	for _, app := range apps {
		if !app.mu.TryLock() {
			writeError(w, 409, "有项目操作正在执行，请完成后重试")
			return
		}
		locked = append(locked, app)
	}
	for _, app := range apps {
		app.closing.Store(true)
	}
	writeJSON(w, 200, map[string]string{"message": "后台正在退出"})
	time.AfterFunc(100*time.Millisecond, a.shutdown)
}
