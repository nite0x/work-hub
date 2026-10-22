package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type GitBranch struct {
	Name      string   `json:"name"`
	Ref       string   `json:"ref"`
	Kind      string   `json:"kind"`
	Commit    string   `json:"commit"`
	Upstream  string   `json:"upstream"`
	Worktrees []string `json:"worktrees"`
}
type GitRemote struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}
type GitOverview struct {
	Project      Project           `json:"project"`
	Branches     []GitBranch       `json:"branches"`
	Remotes      []GitRemote       `json:"remotes"`
	Current      string            `json:"current"`
	MasterSource string            `json:"master_source"`
	MasterHint   string            `json:"master_hint"`
	Credentials  CredentialSupport `json:"credentials"`
}
type GitAction struct {
	Action string `json:"action"`
	Remote string `json:"remote"`
	Name   string `json:"name"`
	Source string `json:"source"`
	Path   string `json:"path"`
	Track  bool   `json:"track"`
}

func (a *App) registeredProject(ctx context.Context, id string) (Project, error) {
	ps, err := projectMap(ctx, a)
	if err != nil {
		return Project{}, err
	}
	p, ok := ps[id]
	if !ok {
		return Project{}, sql.ErrNoRows
	}
	common, err := git(ctx, p.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return Project{}, err
	}
	resolved, err := workspaceEval(ctx, strings.TrimSpace(common))
	if err != nil || resolved != p.CommonDir {
		return Project{}, fmt.Errorf("仓库路径已变更，请检查登记目录")
	}
	return p, nil
}

func inspectGit(ctx context.Context, p Project) (GitOverview, error) {
	v := GitOverview{Project: p, Branches: []GitBranch{}, Remotes: []GitRemote{}}
	trees, err := scanWorktrees(ctx, p.Path)
	if err != nil {
		return v, err
	}
	v.Project.Worktrees = trees
	for _, t := range trees {
		if t.Path == p.Path {
			v.Current = t.Branch
		}
	}
	raw, err := git(ctx, p.Path, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(upstream:short)%09%(symref)", "refs/heads", "refs/remotes")
	if err != nil {
		return v, err
	}
	for _, line := range strings.Split(strings.TrimSuffix(raw, "\n"), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 3 {
			continue
		}
		if len(fields) > 3 && fields[3] != "" {
			continue
		}
		b := GitBranch{Ref: fields[0], Commit: fields[1], Upstream: fields[2], Kind: "local", Worktrees: []string{}}
		if strings.HasPrefix(b.Ref, "refs/remotes/") {
			b.Kind = "remote"
			b.Name = strings.TrimPrefix(b.Ref, "refs/remotes/")
		} else {
			b.Name = strings.TrimPrefix(b.Ref, "refs/heads/")
		}
		for _, t := range trees {
			if b.Kind == "local" && t.Branch == b.Name {
				b.Worktrees = append(b.Worktrees, t.Path)
			}
		}
		if b.Ref == "refs/heads/master" {
			v.Project.HasMaster = true
		}
		if b.Kind == "remote" && strings.HasSuffix(b.Name, "/master") && (v.MasterSource == "" || b.Name == "origin/master") {
			v.MasterSource = b.Ref
		}
		v.Branches = append(v.Branches, b)
	}
	remotes, err := git(ctx, p.Path, "remote")
	if err != nil {
		return v, err
	}
	for _, name := range strings.Fields(remotes) {
		u, _ := git(ctx, p.Path, "remote", "get-url", name)
		v.Remotes = append(v.Remotes, GitRemote{Name: name, URL: redactRemote(strings.TrimSpace(u))})
	}
	switch {
	case v.Project.HasMaster:
		v.MasterHint = "本地 master 已准备好，可以创建任务。"
	case v.MasterSource != "":
		v.MasterHint = "已找到 " + strings.TrimPrefix(v.MasterSource, "refs/remotes/") + "，可创建本地 master 跟踪分支；不会切换当前工作目录。"
	case len(v.Remotes) > 0:
		v.MasterHint = "缺少本地 master；请先获取远端分支，再从远端 master 创建本地跟踪分支。如果远端仅有 main，需要明确选择基线，不会自动替代。"
	default:
		v.MasterHint = "缺少本地 master，且尚未配置远端。可在 Git 终端配置远端，或明确选择一个已有提交来创建 master。"
	}
	return v, nil
}

func redactRemote(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.Host != "" {
		u.User = nil
		u.RawQuery = ""
		u.Fragment = ""
		return u.String()
	}
	return raw
}
func (a *App) gitOverviewHandler(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, err := a.registeredProject(r.Context(), r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, 404, "项目不存在")
		return
	}
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	v, err := inspectGit(r.Context(), p)
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	v.Credentials = a.credentialSupport()
	writeJSON(w, 200, v)
}
func findBranch(v GitOverview, ref string, kind string) (GitBranch, error) {
	for _, b := range v.Branches {
		if b.Ref == ref && (kind == "" || b.Kind == kind) {
			return b, nil
		}
	}
	return GitBranch{}, fmt.Errorf("分支已不存在，请刷新后重新选择")
}
func selectedWorktree(ctx context.Context, p Project, path string) (Worktree, error) {
	if path == "" {
		path = p.Path
	}
	trees, err := scanWorktrees(ctx, p.Path)
	if err != nil {
		return Worktree{}, err
	}
	for _, t := range trees {
		if t.Path == path {
			if t.Bare || t.Missing || t.Prunable || t.Error != "" {
				return Worktree{}, fmt.Errorf("所选 worktree 不可用，请先修复")
			}
			common, err := git(ctx, path, "rev-parse", "--path-format=absolute", "--git-common-dir")
			if err != nil {
				return Worktree{}, err
			}
			resolved, err := workspaceEval(ctx, strings.TrimSpace(common))
			if err != nil || resolved != p.CommonDir {
				return Worktree{}, fmt.Errorf("所选目录已不属于该仓库")
			}
			return t, nil
		}
	}
	return Worktree{}, fmt.Errorf("请从该项目的已发现 worktree 中选择目录")
}

func (a *App) gitActionHandler(w http.ResponseWriter, r *http.Request) {
	var in GitAction
	if !decode(w, r, &in) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	p, err := a.registeredProject(r.Context(), r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, 404, "项目不存在")
		return
	}
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	v, err := inspectGit(r.Context(), p)
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	var output, message string
	switch in.Action {
	case "fetch", "fetch_terminal":
		found := false
		for _, remote := range v.Remotes {
			if remote.Name == in.Remote {
				found = true
			}
		}
		if !found {
			writeError(w, 400, "请选择已配置的远端")
			return
		}
		if in.Action == "fetch_terminal" {
			plan, e := a.launchGitTerminal(p, p.Path, in.Remote)
			if e != nil {
				writeJSON(w, 503, map[string]string{"error": e.Error(), "command": plan.Command})
				return
			}
			writeJSON(w, 200, map[string]string{"message": "已发送终端打开请求，请在终端完成登录和获取；完成后点击“刷新列表”", "output": a.credentialSupport().Message + " 终端中的 Git 获取结果为准。"})
			return
		}
		// Explicitly fetch all branch heads, even if the repository was cloned with a narrow refspec.
		output, err = a.gitNetwork(r.Context(), p.Path, "fetch", "--prune", "--", in.Remote, "+refs/heads/*:refs/remotes/"+in.Remote+"/*")
		message = "已获取远端全部分支，本地工作文件与当前分支保留"
	case "create_branch":
		in.Name = strings.TrimSpace(in.Name)
		if in.Name == "" || len(in.Name) > 160 || strings.HasPrefix(in.Name, "-") || strings.Contains(in.Name, "@{") {
			writeError(w, 400, "分支名无效")
			return
		}
		if _, e := git(r.Context(), p.Path, "check-ref-format", "refs/heads/"+in.Name); e != nil {
			writeError(w, 400, "分支名无效")
			return
		}
		for _, b := range v.Branches {
			if b.Ref == "refs/heads/"+in.Name {
				writeError(w, 409, "本地分支已存在，不会覆盖")
				return
			}
		}
		if in.Source == "HEAD" {
			if in.Track {
				writeError(w, 400, "当前 HEAD 不能设为远端跟踪来源")
				return
			}
			_, err = git(r.Context(), p.Path, "rev-parse", "--verify", "HEAD^{commit}")
		} else {
			var source GitBranch
			source, err = findBranch(v, in.Source, "")
			if err == nil && in.Track && source.Kind != "remote" {
				err = fmt.Errorf("只能跟踪远端分支")
			}
		}
		if err != nil {
			writeError(w, 409, err.Error())
			return
		}
		tracking := "--no-track"
		if in.Track {
			// Single-branch clones may have the ref after an explicit fetch, while
			// remote.<name>.fetch still excludes it. Add just this branch's mapping
			// so Git can resolve and later pull its upstream; retain other mappings.
			if e := ensureTrackingRefspec(r.Context(), p, v, in.Source); e != nil {
				writeError(w, 409, redactGitOutput(e.Error()))
				return
			}
			tracking = "--track"
		}
		output, err = git(r.Context(), p.Path, "branch", tracking, "--", in.Name, in.Source)
		message = "已创建本地分支 " + in.Name + "，当前工作目录未切换"
	case "switch":
		t, e := selectedWorktree(r.Context(), p, in.Path)
		if e != nil {
			writeError(w, 409, e.Error())
			return
		}
		if t.Dirty > 0 {
			writeError(w, 409, "所选目录有未提交修改，请先提交或在终端暂存后再切换分支")
			return
		}
		b, e := findBranch(v, in.Source, "local")
		if e != nil {
			writeError(w, 409, e.Error())
			return
		}
		for _, path := range b.Worktrees {
			if path != t.Path {
				writeError(w, 409, "该分支正被另一个 worktree 使用："+path)
				return
			}
		}
		output, err = git(r.Context(), t.Path, "switch", "--no-guess", "--", b.Name)
		message = "所选工作目录已切换到 " + b.Name
	case "pull":
		t, e := selectedWorktree(r.Context(), p, in.Path)
		if e != nil {
			writeError(w, 409, e.Error())
			return
		}
		if t.Dirty > 0 || t.Detached {
			writeError(w, 409, "快进拉取需要干净且已检出分支的工作目录")
			return
		}
		if _, e := git(r.Context(), t.Path, "rev-parse", "--verify", "@{upstream}"); e != nil {
			writeError(w, 409, "当前分支尚未设置远端跟踪，请先创建跟踪分支或在 Git 终端配置 upstream")
			return
		}
		output, err = a.gitNetwork(r.Context(), t.Path, "pull", "--ff-only", "--no-rebase", "--no-autostash")
		message = "已完成快进拉取"
	case "fast_forward":
		b, e := findBranch(v, "refs/heads/"+in.Name, "local")
		if e != nil {
			writeError(w, 409, e.Error())
			return
		}
		source, e := findBranch(v, in.Source, "remote")
		if e != nil {
			writeError(w, 409, e.Error())
			return
		}
		if len(b.Worktrees) > 0 {
			writeError(w, 409, "该分支已在 worktree 检出，请选择对应目录使用“快进拉取”")
			return
		}
		if _, e := git(r.Context(), p.Path, "merge-base", "--is-ancestor", b.Commit, source.Commit); e != nil {
			writeError(w, 409, "分支存在分歧，不能快进；请在终端检查，不会覆盖本地提交")
			return
		}
		// Expected-old-value prevents overwriting a concurrently updated branch.
		output, err = git(r.Context(), p.Path, "update-ref", "-m", "worktree-hub: fast-forward", b.Ref, source.Commit, b.Commit)
		message = "已快进更新 " + b.Name + " 到 " + source.Name
	case "terminal":
		t, e := selectedWorktree(r.Context(), p, in.Path)
		if e != nil {
			writeError(w, 409, e.Error())
			return
		}
		if plan, e := a.launchGitTerminal(p, t.Path, ""); e != nil {
			writeJSON(w, 503, map[string]string{"error": e.Error(), "command": plan.Command})
			return
		}
		message = "已向系统终端发送打开请求"
	default:
		writeError(w, 400, "不支持的 Git 操作")
		return
	}
	if err != nil {
		writeGitActionError(w, in.Action, err)
		return
	}
	writeJSON(w, 200, map[string]string{"message": message, "output": redactGitOutput(output)})
}

func writeGitActionError(w http.ResponseWriter, action string, err error) {
	raw := redactGitOutput(err.Error())
	message, code := raw, "git_failed"
	if action == "fetch" || action == "pull" {
		lower := strings.ToLower(raw)
		switch {
		case strings.Contains(lower, "could not read username"), strings.Contains(lower, "could not read password"), strings.Contains(lower, "authentication failed"), strings.Contains(lower, "terminal prompts disabled"), strings.Contains(lower, "permission denied (publickey"), strings.Contains(lower, "http basic: access denied"):
			code = "authentication_required"
			message = "远端凭证不存在或已失效。请在终端完成一次登录和获取；接入 Windows 凭据管理器后，页面获取与快进拉取会自动复用保存的凭证。"
		case strings.Contains(lower, "could not resolve host"), strings.Contains(lower, "failed to connect"), strings.Contains(lower, "network is unreachable"), strings.Contains(raw, "超时"):
			code = "network_error"
			message = "无法连接远端仓库，请检查当前执行环境的网络、VPN 或代理，也可在终端重试。"
		}
	}
	details := []string{}
	if message != raw {
		details = append(details, raw)
	}
	writeJSON(w, 409, map[string]any{"error": message, "code": code, "details": details})
}

func (a *App) launchGitTerminal(p Project, path, remote string) (LaunchPlan, error) {
	if a.readOnlySessions || runtime.GOOS == "windows" || a.workspace != nil {
		plan := LaunchPlan{Tool: "git", Title: "Git · " + p.Name, Cwd: path, Args: []string{"status", "--short", "--branch"}}
		if remote != "" {
			plan.Args = append(a.credentialOptions(), "fetch", "--prune", "--", remote, "+refs/heads/*:refs/remotes/"+remote+"/*")
		}
		plan.Command = displayCommand("git", plan.Args, runtime.GOOS == "windows" && a.workspace == nil)
		return plan, a.launchSimpleTerminal(plan)
	}
	plan := LaunchPlan{Title: "Git · " + p.Name, Cwd: path, Script: filepath.Join(a.dataDir, "launches", newID()+".sh")}
	command := "git status --short --branch"
	if remote != "" {
		parts := []string{"GIT_TERMINAL_PROMPT=1 git"}
		for _, arg := range a.credentialOptions() {
			parts = append(parts, shellQuote(arg))
		}
		command = strings.Join(parts, " ") + " fetch --prune -- " + shellQuote(remote) + " " + shellQuote("+refs/heads/*:refs/remotes/"+remote+"/*")
	}
	plan.Command = "cd -- " + shellQuote(path) + " && " + command
	if err := os.MkdirAll(filepath.Dir(plan.Script), 0700); err != nil {
		return plan, err
	}
	script := "#!/usr/bin/env bash\nexport PATH=\"$HOME/.local/bin:$PATH\"\ncd -- " + shellQuote(path) + " || exit 1\n"
	if remote != "" {
		script += "printf '%s\\n' " + shellQuote(a.credentialSupport().Message) + " '正在获取远端全部分支。如需认证，请根据 Git 提示在此终端输入用户名和密码或访问令牌。'\n" + command + "\nresult=$?\n" +
			"if [ \"$result\" -eq 0 ]; then\n  printf '%s\\n' '获取完成，请返回 Work Hub 点击“刷新列表”。'\nelse\n  printf '获取失败（退出码 %s），请查看上方 Git 错误。\\n' \"$result\"\nfi\n"
	} else {
		script += command + "\n"
	}
	script += "exec bash -i\n"
	if err := os.WriteFile(plan.Script, []byte(script), 0700); err != nil {
		return plan, err
	}
	if err := a.launch(plan); err != nil {
		_ = os.Remove(plan.Script)
		return plan, err
	}
	return plan, nil
}

func redactGitOutput(s string) string {
	// Never echo credentials embedded in configured HTTP remote URLs.
	for _, word := range strings.Fields(s) {
		candidate := strings.Trim(word, "'\"()")
		if u, err := url.Parse(candidate); err == nil && u.Host != "" && (u.User != nil || u.RawQuery != "") {
			s = strings.ReplaceAll(s, candidate, redactRemote(candidate))
		}
	}
	return s
}

func ensureTrackingRefspec(ctx context.Context, p Project, v GitOverview, source string) error {
	name := strings.TrimPrefix(source, "refs/remotes/")
	remote := ""
	for _, candidate := range v.Remotes {
		if strings.HasPrefix(name, candidate.Name+"/") && len(candidate.Name) > len(remote) {
			remote = candidate.Name
		}
	}
	if remote == "" {
		return fmt.Errorf("来源分支没有对应的远端配置")
	}
	branchName := strings.TrimPrefix(name, remote+"/")
	exact := "refs/heads/" + branchName + ":refs/remotes/" + name
	broad := "refs/heads/*:refs/remotes/" + remote + "/*"
	key := "remote." + remote + ".fetch"
	configured, _ := git(ctx, p.Path, "config", "--get-all", key)
	for _, line := range strings.Split(configured, "\n") {
		rule := strings.TrimPrefix(line, "+")
		if rule == exact || rule == broad {
			return nil
		}
	}
	_, err := git(ctx, p.Path, "config", "--local", "--add", key, "+"+exact)
	return err
}
