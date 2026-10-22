package project

import (
	"context"
	"runtime"

	"worktree-hub/internal/workspace"
)

type CredentialSupport struct {
	Available bool   `json:"available"`
	Message   string `json:"message"`
}

func (a *Service) CredentialSupport() CredentialSupport {
	if a.CredentialHelper == "" {
		if runtime.GOOS == "darwin" {
			return CredentialSupport{Message: "使用当前 Git 的凭证助手配置；如需认证，请在该项目的终端中完成登录。"}
		}
		return CredentialSupport{Message: "使用现有 Git 凭证助手配置；未检测到可共享的 Windows 凭证助手。"}
	}
	return CredentialSupport{Available: true, Message: "已接入 Windows 凭据管理器：终端登录后安全保存凭证，页面获取与快进拉取自动复用；已保存的 Windows Git 凭证也可直接使用。凭证失效时需重新登录。"}
}

func (a *Service) CredentialOptions() []string {
	if a.CredentialHelper == "" {
		return nil
	}
	// Append a helper for this command only. Keep existing helpers and never
	// rewrite repository or global Git configuration.
	return []string{"-c", "credential.helper=" + a.CredentialHelper}
}

func (a *Service) GitNetwork(ctx context.Context, dir string, args ...string) (string, error) {
	return workspace.GitOperation(ctx, dir, append(a.CredentialOptions(), args...)...)
}
