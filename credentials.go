package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

type CredentialSupport struct {
	Available bool   `json:"available"`
	Message   string `json:"message"`
}

func windowsCredentialManager() string {
	if os.Getenv("WSL_DISTRO_NAME") == "" {
		return ""
	}
	for _, path := range []string{
		"/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe",
		"/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager-core.exe",
	} {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path
		}
	}
	return ""
}

func credentialHelperCommand() string {
	if windowsCredentialManager() == "" {
		return ""
	}
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	// Git passes get/store/erase after this shell fragment. No credential is
	// included in argv: the helper protocol travels exclusively through pipes.
	return "!" + shellQuote(executable) + " credential-helper"
}

func (a *App) credentialSupport() CredentialSupport {
	if a.credentialHelper == "" {
		return CredentialSupport{Message: "使用现有 Git 凭证助手配置；未检测到可共享的 Windows 凭证助手。"}
	}
	return CredentialSupport{Available: true, Message: "已接入 Windows 凭据管理器：终端登录后安全保存凭证，页面获取与快进拉取自动复用；已保存的 Windows Git 凭证也可直接使用。凭证失效时需重新登录。"}
}

func (a *App) credentialOptions() []string {
	if a.credentialHelper == "" {
		return nil
	}
	// Append a helper for this command only. Keep existing helpers and never
	// rewrite repository or global Git configuration.
	return []string{"-c", "credential.helper=" + a.credentialHelper}
}

func (a *App) gitNetwork(ctx context.Context, dir string, args ...string) (string, error) {
	return gitOperation(ctx, dir, append(a.credentialOptions(), args...)...)
}

func credentialBridge(manager, operation string, input io.Reader, output, diagnostic io.Writer) error {
	if operation != "get" && operation != "store" && operation != "erase" {
		return fmt.Errorf("不支持的凭证操作")
	}
	if manager == "" {
		return fmt.Errorf("未找到 Windows Git Credential Manager")
	}
	data, err := io.ReadAll(io.LimitReader(input, 128*1024+1))
	if err != nil || len(data) > 128*1024 {
		return fmt.Errorf("无法读取 Git 凭证请求")
	}
	protocol := ""
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "protocol=") {
			protocol = strings.TrimSuffix(strings.TrimPrefix(line, "protocol="), "\r")
		}
	}
	if protocol != "http" && protocol != "https" {
		return nil // SSH keeps using its own agent/key configuration.
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, manager, operation)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = bytes.NewReader(data), output, diagnostic
	cmd.Env = credentialBridgeEnv(os.Environ(), protocol)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("Windows 凭证助手操作失败，请在终端重新登录或检查凭据管理器")
	}
	return nil
}

func credentialBridgeEnv(base []string, protocol string) []string {
	values := map[string]string{
		// Git itself prompts in the WSL terminal on first use. The helper only
		// reads/writes the OS store, so page requests never open login dialogs.
		"GCM_INTERACTIVE": "false", "GCM_TRACE": "false", "GCM_TRACE_SECRETS": "false",
		"GIT_TRACE": "0", "GIT_TRACE_CURL": "0", "GIT_CURL_VERBOSE": "0",
	}
	if protocol == "http" {
		// Preserve the existing HTTP remote protocol for this invocation only.
		// Generic Basic/PAT storage avoids assuming OAuth on private GitLab hosts.
		values["GCM_PROVIDER"] = "generic"
		values["GCM_ALLOW_UNSAFE_REMOTES"] = "true"
	}
	var env []string
	forward := ""
	for _, item := range base {
		key := strings.SplitN(item, "=", 2)[0]
		if key == "WSLENV" {
			forward = strings.TrimPrefix(item, "WSLENV=")
			continue
		}
		if _, replaced := values[key]; !replaced {
			env = append(env, item)
		}
	}
	// Windows executables receive explicit WSLENV forwarding, rather than
	// accidentally consulting different interactivity settings on Windows.
	for key, value := range values {
		env = append(env, key+"="+value)
		forward += ":" + key
	}
	return append(env, "WSLENV="+strings.TrimPrefix(forward, ":"))
}
