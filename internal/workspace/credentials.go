package workspace

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"worktree-hub/internal/platform"
)

func WindowsCredentialManager() string {
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

func CredentialHelperCommand() string {
	if WindowsCredentialManager() == "" {
		return ""
	}
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	// Git passes get/store/erase after this shell fragment. No credential is
	// included in argv: the helper protocol travels exclusively through pipes.
	return "!" + platform.ShellQuote(executable) + " credential-helper"
}

func CredentialBridge(manager, operation string, input io.Reader, output, diagnostic io.Writer) error {
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
	cmd.Env = CredentialBridgeEnv(os.Environ(), protocol)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("Windows 凭证助手操作失败，请在终端重新登录或检查凭据管理器")
	}
	return nil
}

func CredentialBridgeEnv(base []string, protocol string) []string {
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
