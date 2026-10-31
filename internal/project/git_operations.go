package project

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

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
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
	Project      model.Project     `json:"project"`
	Branches     []GitBranch       `json:"branches"`
	Remotes      []GitRemote       `json:"remotes"`
	Current      string            `json:"current"`
	MasterSource string            `json:"master_source"`
	MasterHint   string            `json:"master_hint"`
	Credentials  CredentialSupport `json:"credentials"`
}
type GitAction struct {
	Action         string `json:"action"`
	Remote         string `json:"remote"`
	Name           string `json:"name"`
	Source         string `json:"source"`
	Path           string `json:"path"`
	Track          bool   `json:"track"`
	RequirementID  string `json:"requirement_id"`
	ExpectedBranch string `json:"expected_branch"`
	ExpectedHead   string `json:"expected_head"`
	SourceCommit   string `json:"source_commit"`
	Target         string `json:"target"`
	TargetCommit   string `json:"target_commit"`
	AllowShared    bool   `json:"allow_shared"`
}

func (a *Service) RegisteredProject(ctx context.Context, id string) (model.Project, error) {
	return LookupProject(ctx, a.Workspace, id)
}

// LookupProject validates the registered repository without starting a status cache.
func LookupProject(ctx context.Context, environment *workspace.Service, id string) (model.Project, error) {
	ps, err := environment.Store.ProjectMap()
	if err != nil {
		return model.Project{}, err
	}
	p, ok := ps[id]
	if !ok {
		return model.Project{}, sql.ErrNoRows
	}
	common, err := workspace.Git(ctx, p.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return model.Project{}, err
	}
	resolved, err := workspace.Eval(ctx, strings.TrimSpace(common))
	if err != nil || resolved != p.CommonDir {
		return model.Project{}, fmt.Errorf("仓库路径已变更，请检查登记目录")
	}
	return p, nil
}

func InspectGit(ctx context.Context, p model.Project) (GitOverview, error) {
	v := GitOverview{Project: p, Branches: []GitBranch{}, Remotes: []GitRemote{}}
	trees, err := ScanWorktrees(ctx, p.Path)
	if err != nil {
		return v, err
	}
	v.Project.Worktrees = trees
	for _, t := range trees {
		if t.Path == p.Path {
			v.Current = t.Branch
		}
	}
	raw, err := workspace.Git(ctx, p.Path, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(upstream:short)%09%(symref)", "refs/heads", "refs/remotes")
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
	remotes, err := workspace.Git(ctx, p.Path, "remote")
	if err != nil {
		return v, err
	}
	for _, name := range strings.Fields(remotes) {
		u, _ := workspace.Git(ctx, p.Path, "remote", "get-url", name)
		v.Remotes = append(v.Remotes, GitRemote{Name: name, URL: RedactRemote(strings.TrimSpace(u))})
	}
	v.MasterHint = "创建新分支时可选择任意本地或远端来源；任务也可以直接使用已有工作目录。"
	return v, nil
}

func RedactRemote(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.Host != "" {
		u.User = nil
		u.RawQuery = ""
		u.Fragment = ""
		return u.String()
	}
	return raw
}
func (a *Service) GitOverviewHandler(w http.ResponseWriter, r *http.Request) {
	p, err := a.RegisteredProject(r.Context(), r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "项目不存在")
		return
	}
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	unlock := a.lockGit(p.CommonDir)
	defer unlock()
	v, err := InspectGit(r.Context(), p)
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	v.Credentials = a.CredentialSupport()
	qs, err := a.Workspace.Store.Requirements()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	for i := range v.Project.Worktrees {
		for _, q := range qs {
			for _, m := range q.Members {
				if m.ProjectID == p.ID && m.Path == v.Project.Worktrees[i].Path {
					v.Project.Worktrees[i].Requirements = append(v.Project.Worktrees[i].Requirements, model.TaskLink{ID: q.ID, Name: q.Name})
				}
			}
		}
	}
	httpx.WriteJSON(w, 200, v)
}
func findBranch(v GitOverview, ref string, kind string) (GitBranch, error) {
	for _, b := range v.Branches {
		if b.Ref == ref && (kind == "" || b.Kind == kind) {
			return b, nil
		}
	}
	return GitBranch{}, fmt.Errorf("分支已不存在，请刷新后重新选择")
}
func selectedWorktree(ctx context.Context, p model.Project, path string) (model.Worktree, error) {
	if path == "" {
		path = p.Path
	}
	path = platform.CleanWorkspacePath(path)
	// Resolve directory aliases at the API boundary, but never follow a
	// substituted worktree entry. Git reports canonical paths on macOS.
	st, err := workspace.Stat(ctx, path, false)
	if err != nil || st.Mode()&os.ModeSymlink != 0 {
		return model.Worktree{}, fmt.Errorf("所选 worktree 路径不可用或是符号链接")
	}
	path, err = workspace.Normalize(ctx, path)
	if err != nil {
		return model.Worktree{}, err
	}
	raw, err := workspace.Git(ctx, p.Path, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return model.Worktree{}, err
	}
	for _, t := range ParseWorktrees(raw) {
		if platform.SameWorkspacePath(t.Path, path) {
			t = ScanWorktreeStatus(ctx, t)
			if t.Bare || t.Missing || t.Prunable || t.Error != "" {
				return model.Worktree{}, fmt.Errorf("所选 worktree 不可用，请先修复")
			}
			common, err := workspace.Git(ctx, path, "rev-parse", "--path-format=absolute", "--git-common-dir")
			if err != nil {
				return model.Worktree{}, err
			}
			resolved, err := workspace.Eval(ctx, strings.TrimSpace(common))
			if err != nil || !platform.SameWorkspacePath(resolved, p.CommonDir) {
				return model.Worktree{}, fmt.Errorf("所选目录已不属于该仓库")
			}
			return t, nil
		}
	}
	return model.Worktree{}, fmt.Errorf("请从该项目的已发现 worktree 中选择目录")
}

func (a *Service) GitActionHandler(w http.ResponseWriter, r *http.Request) {
	var in GitAction
	if !httpx.Decode(w, r, &in) {
		return
	}
	a.Workspace.GitActivity.RLock()
	defer a.Workspace.GitActivity.RUnlock()
	if a.Workspace.Closing.Load() {
		httpx.WriteError(w, 503, "后台正在退出")
		return
	}
	p, err := a.RegisteredProject(r.Context(), r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "项目不存在")
		return
	}
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	unlock := a.lockGit(p.CommonDir)
	defer unlock()
	// Only Git actions for this repository serialize; network waits never hold
	// the environment's metadata lock.
	v, err := InspectGit(r.Context(), p)
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	var output, message string
	if in.RequirementID != "" {
		if err := a.validateGitTask(p.ID, in); err != nil {
			httpx.WriteError(w, 409, err.Error())
			return
		}
	}
	if in.Path != "" && in.ExpectedBranch != "" {
		t, e := selectedWorktree(r.Context(), p, in.Path)
		if e != nil || t.Branch != in.ExpectedBranch {
			httpx.WriteError(w, 409, "当前分支已变化，请刷新后重新操作")
			return
		}
	}
	switch in.Action {
	case "fetch", "fetch_terminal":
		found := false
		for _, remote := range v.Remotes {
			if remote.Name == in.Remote {
				found = true
			}
		}
		if !found {
			httpx.WriteError(w, 400, "请选择已配置的远端")
			return
		}
		if in.Action == "fetch_terminal" {
			plan, e := a.LaunchGitTerminal(p, p.Path, in.Remote)
			if e != nil {
				httpx.WriteJSON(w, 503, map[string]string{"error": e.Error(), "command": plan.Command})
				return
			}
			httpx.WriteJSON(w, 200, map[string]string{"message": "已发送终端打开请求，请在终端完成登录和获取；完成后点击“刷新列表”", "output": a.CredentialSupport().Message + " 终端中的 Git 获取结果为准。"})
			return
		}
		// Explicitly fetch all branch heads, even if the repository was cloned with a narrow refspec.
		output, err = a.GitNetwork(r.Context(), p.Path, "fetch", "--prune", "--", in.Remote, "+refs/heads/*:refs/remotes/"+in.Remote+"/*")
		message = "已获取远端全部分支，本地工作文件与当前分支保留"
	case "create_branch":
		in.Name = strings.TrimSpace(in.Name)
		if in.Name == "" || len(in.Name) > 160 || strings.HasPrefix(in.Name, "-") || strings.Contains(in.Name, "@{") {
			httpx.WriteError(w, 400, "分支名无效")
			return
		}
		if _, e := workspace.Git(r.Context(), p.Path, "check-ref-format", "refs/heads/"+in.Name); e != nil {
			httpx.WriteError(w, 400, "分支名无效")
			return
		}
		for _, b := range v.Branches {
			if b.Ref == "refs/heads/"+in.Name {
				httpx.WriteError(w, 409, "本地分支已存在，不会覆盖")
				return
			}
		}
		if in.Source == "HEAD" {
			if in.Track {
				httpx.WriteError(w, 400, "当前 HEAD 不能设为远端跟踪来源")
				return
			}
			path := p.Path
			if in.Path != "" {
				t, e := selectedWorktree(r.Context(), p, in.Path)
				if e != nil {
					httpx.WriteError(w, 409, e.Error())
					return
				}
				path = t.Path
			}
			var commit string
			commit, err = workspace.Git(r.Context(), path, "rev-parse", "--verify", "HEAD^{commit}")
			in.Source = strings.TrimSpace(commit)
		} else {
			var source GitBranch
			source, err = findBranch(v, in.Source, "")
			if err == nil && in.Track && source.Kind != "remote" {
				err = fmt.Errorf("只能跟踪远端分支")
			}
		}
		if err != nil {
			httpx.WriteError(w, 409, err.Error())
			return
		}
		tracking := "--no-track"
		if in.Track {
			// Single-branch clones may have the ref after an explicit fetch, while
			// remote.<name>.fetch still excludes it. Add just this branch's mapping
			// so Git can resolve and later pull its upstream; retain other mappings.
			if e := EnsureTrackingRefspec(r.Context(), p, v, in.Source); e != nil {
				httpx.WriteError(w, 409, RedactGitOutput(e.Error()))
				return
			}
			tracking = "--track"
		}
		output, err = workspace.Git(r.Context(), p.Path, "branch", tracking, "--", in.Name, in.Source)
		message = "已创建本地分支 " + in.Name + "，当前工作目录未切换"
	case "switch":
		a.Workspace.Mu.Lock()
		defer a.Workspace.Mu.Unlock()
		if in.RequirementID != "" {
			if e := a.validateGitTask(p.ID, in); e != nil {
				httpx.WriteError(w, 409, e.Error())
				return
			}
		}
		if e := a.checkSharedSwitch(p.ID, in); e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		t, e := selectedWorktree(r.Context(), p, in.Path)
		if e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		if t.Dirty > 0 || t.Operation != "" {
			httpx.WriteError(w, 409, "所选目录有未提交修改或未结束的 Git 操作，请先在终端或编辑器处理后再切换分支")
			return
		}
		b, e := findBranch(v, in.Source, "")
		if e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		for _, path := range b.Worktrees {
			if path != t.Path {
				httpx.WriteError(w, 409, "该分支正被另一个 worktree 使用："+path)
				return
			}
		}
		if b.Kind == "remote" {
			if e := validBranchName(r.Context(), p.Path, in.Name); e != nil {
				httpx.WriteError(w, 400, e.Error())
				return
			}
			if e := EnsureTrackingRefspec(r.Context(), p, v, b.Ref); e != nil {
				httpx.WriteError(w, 409, e.Error())
				return
			}
			output, err = workspace.Git(r.Context(), t.Path, "switch", "--track", "-c", in.Name, b.Ref)
			b.Name = in.Name
		} else {
			output, err = workspace.Git(r.Context(), t.Path, "switch", "--no-guess", "--", b.Name)
		}
		message = "所选工作目录已切换到 " + b.Name
		if err == nil && in.RequirementID != "" {
			_, err = a.Workspace.Store.DB.Exec(`UPDATE members SET branch=? WHERE requirement_id=? AND project_id=? AND path=?`, b.Name, in.RequirementID, p.ID, t.Path)
			if err != nil {
				err = fmt.Errorf("分支已切换，但任务关联更新失败，请刷新后采用当前分支：%w", err)
			}
		}
	case "adopt_branch":
		a.Workspace.Mu.Lock()
		defer a.Workspace.Mu.Unlock()
		if in.RequirementID == "" {
			httpx.WriteError(w, 400, "请从任务内采用当前分支")
			return
		}
		if e := a.validateGitTask(p.ID, in); e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		t, e := selectedWorktree(r.Context(), p, in.Path)
		if e != nil || t.Detached || t.Branch == "" {
			httpx.WriteError(w, 409, "当前目录未检出可关联的分支")
			return
		}
		_, err = a.Workspace.Store.DB.Exec(`UPDATE members SET branch=? WHERE requirement_id=? AND project_id=? AND path=?`, t.Branch, in.RequirementID, p.ID, t.Path)
		message = "任务已采用当前分支 " + t.Branch
	case "pull":
		t, e := selectedWorktree(r.Context(), p, in.Path)
		if e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		if t.Dirty > 0 || t.Detached || t.Operation != "" {
			httpx.WriteError(w, 409, "快进拉取需要干净且已检出分支的工作目录")
			return
		}
		if _, e := workspace.Git(r.Context(), t.Path, "rev-parse", "--verify", "@{upstream}"); e != nil {
			httpx.WriteError(w, 409, "当前分支尚未设置远端跟踪，请先创建跟踪分支或在 Git 终端配置 upstream")
			return
		}
		output, err = a.GitNetwork(r.Context(), t.Path, "pull", "--ff-only", "--no-rebase", "--no-autostash")
		message = "已完成快进拉取"
	case "push":
		t, e := selectedWorktree(r.Context(), p, in.Path)
		if e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		if t.Detached || t.Branch == "" || t.Operation != "" {
			httpx.WriteError(w, 409, "请先完成进行中的 Git 操作并检出分支")
			return
		}
		if !hasRemote(v, in.Remote) {
			httpx.WriteError(w, 400, "请选择已配置的远端")
			return
		}
		if e := validBranchName(r.Context(), p.Path, in.Name); e != nil {
			httpx.WriteError(w, 400, e.Error())
			return
		}
		args := []string{"push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no"}
		if in.Track {
			if e := EnsureTrackingRefspec(r.Context(), p, v, "refs/remotes/"+in.Remote+"/"+in.Name); e != nil {
				httpx.WriteError(w, 409, RedactGitOutput(e.Error()))
				return
			}
			args = append(args, "--set-upstream")
		}
		args = append(args, "--", in.Remote, "HEAD:refs/heads/"+in.Name)
		output, err = a.GitNetwork(r.Context(), t.Path, args...)
		message = "已推送 " + t.Branch + " → " + in.Remote + "/" + in.Name
	case "merge_into_preview", "merge_into":
		a.mergeIntoHandler(w, r, p, v, in)
		return
	case "merge_preview", "merge":
		t, e := selectedWorktree(r.Context(), p, in.Path)
		if e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		if t.Dirty > 0 || t.Detached || t.Operation != "" {
			httpx.WriteError(w, 409, "合并需要干净且没有未结束 Git 操作的分支目录")
			return
		}
		b, e := findBranch(v, in.Source, "")
		if e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		if in.Action == "merge_preview" {
			log, e := workspace.Git(r.Context(), t.Path, "log", "--format=%h %s", "-20", t.Head+".."+b.Commit)
			if e != nil {
				writeGitActionError(w, in.Action, e)
				return
			}
			httpx.WriteJSON(w, 200, map[string]string{"message": b.Name + " → " + t.Branch, "output": log, "source_commit": b.Commit, "expected_head": t.Head})
			return
		}
		if in.ExpectedHead == "" || in.ExpectedHead != t.Head || in.SourceCommit != b.Commit {
			httpx.WriteError(w, 409, "合并预览已过期，请重新预览")
			return
		}
		output, err = workspace.GitOperation(r.Context(), t.Path, "-c", "merge.autoStash=false", "-c", "rerere.enabled=false", "merge", "--ff", "--commit", "--no-edit", "--no-autostash", "--no-overwrite-ignore", "--", b.Commit)
		if err != nil {
			after, inspectErr := workspace.ReadGitState(r.Context(), t.Path)
			if inspectErr == nil && after.Operation == "merge" && len(after.Conflicts) > 0 {
				httpx.WriteJSON(w, 200, map[string]any{"message": "合并出现冲突，将打开 AI 会话完成合并", "conflict": true, "conflicts": after.Conflicts, "merge_head": after.MergeHead})
				return
			}
		}
		message = "已合并 " + b.Name + " → " + t.Branch
	case "merge_abort":
		t, e := selectedWorktree(r.Context(), p, in.Path)
		if e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		if t.Operation != "merge" {
			httpx.WriteError(w, 409, "当前没有进行中的合并")
			return
		}
		output, err = workspace.GitOperation(r.Context(), t.Path, "merge", "--abort")
		message = "已中止合并"
	case "fast_forward":
		b, e := findBranch(v, "refs/heads/"+in.Name, "local")
		if e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		source, e := findBranch(v, in.Source, "remote")
		if e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		if len(b.Worktrees) > 0 {
			httpx.WriteError(w, 409, "该分支已在 worktree 检出，请选择对应目录使用“快进拉取”")
			return
		}
		if _, e := workspace.Git(r.Context(), p.Path, "merge-base", "--is-ancestor", b.Commit, source.Commit); e != nil {
			httpx.WriteError(w, 409, "分支存在分歧，不能快进；请在终端检查，不会覆盖本地提交")
			return
		}
		// Expected-old-value prevents overwriting a concurrently updated branch.
		output, err = workspace.Git(r.Context(), p.Path, "update-ref", "-m", "worktree-hub: fast-forward", b.Ref, source.Commit, b.Commit)
		message = "已快进更新 " + b.Name + " 到 " + source.Name
	case "terminal":
		t, e := selectedWorktree(r.Context(), p, in.Path)
		if e != nil {
			httpx.WriteError(w, 409, e.Error())
			return
		}
		if plan, e := a.LaunchGitTerminal(p, t.Path, ""); e != nil {
			httpx.WriteJSON(w, 503, map[string]string{"error": e.Error(), "command": plan.Command})
			return
		}
		message = "已向系统终端发送打开请求"
	default:
		httpx.WriteError(w, 400, "不支持的 Git 操作")
		return
	}
	if err != nil {
		writeGitActionError(w, in.Action, err)
		return
	}
	if in.RequirementID != "" && (in.Action == "switch" || in.Action == "adopt_branch") && a.TaskContextUpdated != nil {
		if q, e := a.Workspace.Store.Requirement(in.RequirementID); e == nil {
			if e := a.TaskContextUpdated(r.Context(), q); e != nil {
				message += "；自动任务上下文更新失败：" + e.Error()
			}
		}
	}
	httpx.WriteJSON(w, 200, map[string]string{"message": message, "output": RedactGitOutput(output)})
}

func writeGitActionError(w http.ResponseWriter, action string, err error) {
	raw := RedactGitOutput(err.Error())
	message, code := raw, "git_failed"
	if action == "fetch" || action == "pull" || action == "push" {
		lower := strings.ToLower(raw)
		switch {
		case strings.Contains(lower, "could not read username"), strings.Contains(lower, "could not read password"), strings.Contains(lower, "authentication failed"), strings.Contains(lower, "terminal prompts disabled"), strings.Contains(lower, "permission denied (publickey"), strings.Contains(lower, "http basic: access denied"):
			code = "authentication_required"
			message = "远端凭证不存在或已失效。请在终端完成一次登录和获取；接入 Windows 凭据管理器后，页面获取与快进拉取会自动复用保存的凭证。"
		case strings.Contains(lower, "could not resolve host"), strings.Contains(lower, "failed to connect"), strings.Contains(lower, "network is unreachable"), strings.Contains(raw, "超时"):
			code = "network_error"
			message = "无法连接远端仓库，请检查当前执行环境的网络、VPN 或代理，也可在终端重试。"
		case action == "pull" && (strings.Contains(lower, "fast-forward") || strings.Contains(lower, "diverg")):
			code, message = "diverged", "本地与远端已分歧，无法快进拉取。请在合并区域选择上游分支合并；若发生冲突会交给 AI 处理。"
		case action == "push" && (strings.Contains(lower, "rejected") || strings.Contains(lower, "fetch first")):
			code, message = "push_rejected", "推送被远端拒绝，请获取远端并检查分歧或仓库权限后重试。"
		}
	}
	details := []string{}
	if message != raw {
		details = append(details, raw)
	}
	httpx.WriteJSON(w, 409, map[string]any{"error": message, "code": code, "details": details})
}

func (a *Service) LaunchGitTerminal(p model.Project, path, remote string) (model.LaunchPlan, error) {
	if a.Workspace.ReadOnlySessions || runtime.GOOS == "windows" || a.Workspace.Remote != nil {
		plan := model.LaunchPlan{Tool: "git", Title: "Git · " + p.Name, Cwd: path, Args: []string{"status", "--short", "--branch"}}
		if remote != "" {
			plan.Args = append(a.CredentialOptions(), "fetch", "--prune", "--", remote, "+refs/heads/*:refs/remotes/"+remote+"/*")
		}
		plan.Command = platform.DisplayCommand("git", plan.Args, runtime.GOOS == "windows" && a.Workspace.Remote == nil)
		return plan, a.Workspace.LaunchSimpleTerminal(plan)
	}
	plan := model.LaunchPlan{Title: "Git · " + p.Name, Cwd: path, Script: filepath.Join(a.Workspace.DataDir, "launches", model.NewID()+".sh")}
	command := "git status --short --branch"
	if remote != "" {
		parts := []string{"GIT_TERMINAL_PROMPT=1 git"}
		for _, arg := range a.CredentialOptions() {
			parts = append(parts, platform.ShellQuote(arg))
		}
		command = strings.Join(parts, " ") + " fetch --prune -- " + platform.ShellQuote(remote) + " " + platform.ShellQuote("+refs/heads/*:refs/remotes/"+remote+"/*")
	}
	plan.Command = "cd -- " + platform.ShellQuote(path) + " && " + command
	if err := os.MkdirAll(filepath.Dir(plan.Script), 0700); err != nil {
		return plan, err
	}
	script := "#!/usr/bin/env bash\nexport PATH=\"$HOME/.local/bin:$PATH\"\ncd -- " + platform.ShellQuote(path) + " || exit 1\n"
	if remote != "" {
		script += "printf '%s\\n' " + platform.ShellQuote(a.CredentialSupport().Message) + " '正在获取远端全部分支。如需认证，请根据 Git 提示在此终端输入用户名和密码或访问令牌。'\n" + command + "\nresult=$?\n" +
			"if [ \"$result\" -eq 0 ]; then\n  printf '%s\\n' '获取完成，请返回 Work Hub 点击“刷新列表”。'\nelse\n  printf '获取失败（退出码 %s），请查看上方 Git 错误。\\n' \"$result\"\nfi\n"
	} else {
		script += command + "\n"
	}
	script += "exec bash -i\n"
	if err := os.WriteFile(plan.Script, []byte(script), 0700); err != nil {
		return plan, err
	}
	if err := a.Workspace.Launch(plan, nil); err != nil {
		_ = os.Remove(plan.Script)
		return plan, err
	}
	return plan, nil
}

func RedactGitOutput(s string) string {
	// Never echo credentials embedded in configured HTTP remote URLs.
	for _, word := range strings.Fields(s) {
		candidate := strings.Trim(word, "'\"()")
		if u, err := url.Parse(candidate); err == nil && u.Host != "" && (u.User != nil || u.RawQuery != "") {
			s = strings.ReplaceAll(s, candidate, RedactRemote(candidate))
		}
	}
	return s
}

func EnsureTrackingRefspec(ctx context.Context, p model.Project, v GitOverview, source string) error {
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
	configured, _ := workspace.Git(ctx, p.Path, "config", "--get-all", key)
	for _, line := range strings.Split(configured, "\n") {
		rule := strings.TrimPrefix(line, "+")
		if rule == exact || rule == broad {
			return nil
		}
	}
	_, err := workspace.Git(ctx, p.Path, "config", "--local", "--add", key, "+"+exact)
	return err
}
