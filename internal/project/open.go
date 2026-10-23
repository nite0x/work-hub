package project

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/workspace"
)

func RemoteWebURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "://") {
		// scp-style SSH URL: git@host:group/repository.git
		at, colon := strings.LastIndex(raw, "@"), strings.Index(raw, ":")
		if at < 0 || colon <= at+1 {
			return "", fmt.Errorf("该远端不是可打开的仓库网址")
		}
		raw = "ssh://" + raw[:colon] + "/" + raw[colon+1:]
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.Path == "" {
		return "", fmt.Errorf("远端地址无法转换为仓库网页")
	}
	switch u.Scheme {
	case "http", "https":
	case "ssh", "git":
		u.Scheme, u.Host = "https", u.Hostname()
	default:
		return "", fmt.Errorf("该远端协议没有仓库网页入口")
	}
	u.User, u.RawQuery, u.Fragment = nil, "", ""
	u.Path = strings.TrimSuffix(strings.TrimSuffix(u.Path, "/"), ".git")
	u.RawPath = ""
	return u.String(), nil
}

func (a *Service) ProjectRemoteHandler(w http.ResponseWriter, r *http.Request) {
	p, err := a.RegisteredProject(r.Context(), r.PathValue("id"))
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		path = p.Path
	}
	t, err := selectedWorktree(r.Context(), p, path)
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	link, remote, err := a.projectRemoteURL(r.Context(), p, t)
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"url": link, "remote": remote})
}

func (a *Service) projectRemoteURL(ctx context.Context, p model.Project, t model.Worktree) (string, string, error) {
	raw, err := workspace.Git(ctx, p.Path, "remote")
	if err != nil {
		return "", "", err
	}
	names := strings.Fields(raw)
	remote := ""
	if t.Branch != "" {
		configured, _ := workspace.Git(ctx, t.Path, "config", "--get", "branch."+t.Branch+".remote")
		for _, name := range names {
			if name == strings.TrimSpace(configured) {
				remote = name
			}
		}
	}
	if remote == "" {
		for _, name := range names {
			if name == "origin" || len(names) == 1 {
				remote = name
			}
		}
	}
	if remote == "" {
		return "", "", fmt.Errorf("未配置可确定的远端，请在 Git 中配置 origin 或当前分支的 upstream")
	}
	raw, err = workspace.Git(ctx, t.Path, "remote", "get-url", "--", remote)
	if err != nil {
		return "", "", fmt.Errorf("%s", RedactGitOutput(err.Error()))
	}
	link, err := RemoteWebURL(raw)
	return link, remote, err
}

func (a *Service) OpenProjectHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Tool string `json:"tool"`
		Path string `json:"path"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if input.Tool != "vscode" && input.Tool != "idea" && input.Tool != "remote" {
		httpx.WriteError(w, 400, "请选择远端仓库、VS Code 或 IDEA")
		return
	}
	p, err := a.RegisteredProject(r.Context(), r.PathValue("id"))
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	t, err := selectedWorktree(r.Context(), p, input.Path)
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	if input.Tool == "remote" {
		link, remote, err := a.projectRemoteURL(r.Context(), p, t)
		if err != nil {
			httpx.WriteError(w, 409, err.Error())
			return
		}
		if err := a.OpenExternal(link); err != nil {
			httpx.WriteError(w, 503, "无法打开浏览器："+err.Error())
			return
		}
		httpx.WriteJSON(w, 200, map[string]string{"message": "已打开远端仓库 " + remote, "url": link})
		return
	}
	distro := ""
	if a.Workspace.Remote != nil {
		distro = a.Workspace.Remote.Identity.Distro
	}
	if err := a.OpenEditor(input.Tool, t.Path, distro); err != nil {
		httpx.WriteError(w, 503, err.Error())
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"message": "已发送编辑器打开请求", "path": t.Path})
}
