package project

import (
	"database/sql"
	"errors"
	"net/http"
	"os"
	"strings"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

type CreateWorktree struct {
	Slug   string `json:"slug"`
	Mode   string `json:"mode"`
	Branch string `json:"branch"`
	Source string `json:"source"`
}

func (a *Service) CreateWorktreeHandler(w http.ResponseWriter, r *http.Request) {
	var in CreateWorktree
	if !httpx.Decode(w, r, &in) {
		return
	}
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	p, err := a.RegisteredProject(r.Context(), r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "项目不存在")
		return
	}
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	in.Slug, in.Branch = strings.TrimSpace(in.Slug), strings.TrimSpace(in.Branch)
	if !workspace.ValidSlug.MatchString(in.Slug) {
		httpx.WriteError(w, 400, "工作标识应为 1–64 位字母、数字、短横线或下划线，以字母或数字开头")
		return
	}
	if in.Mode != "new" && in.Mode != "existing" {
		httpx.WriteError(w, 400, "请选择新建分支或使用已有本地分支")
		return
	}
	if in.Branch == "" && in.Mode == "new" {
		in.Branch = "codex/" + in.Slug
	}
	if in.Branch == "" || len(in.Branch) > 160 || strings.HasPrefix(in.Branch, "-") || strings.Contains(in.Branch, "@{") {
		httpx.WriteError(w, 400, "分支名无效")
		return
	}
	if _, err := workspace.Git(r.Context(), p.Path, "check-ref-format", "--branch", in.Branch); err != nil {
		httpx.WriteError(w, 400, "分支名无效")
		return
	}
	v, err := InspectGit(r.Context(), p)
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	source, commit := in.Source, ""
	if in.Mode == "existing" {
		b, err := findBranch(v, "refs/heads/"+in.Branch, "local")
		if err != nil {
			httpx.WriteError(w, 409, "本地分支不存在，请刷新后重新选择")
			return
		}
		if len(b.Worktrees) > 0 {
			httpx.WriteError(w, 409, "该分支已被 worktree 占用："+strings.Join(b.Worktrees, "、"))
			return
		}
		source, commit = b.Ref, b.Commit
	} else {
		for _, b := range v.Branches {
			if b.Ref == "refs/heads/"+in.Branch {
				httpx.WriteError(w, 409, "本地分支已存在，请选择“使用已有分支”或换一个新分支名")
				return
			}
		}
		if source == "HEAD" {
			commit, err = workspace.Git(r.Context(), p.Path, "rev-parse", "--verify", "HEAD^{commit}")
			commit = strings.TrimSpace(commit)
		} else {
			var b GitBranch
			b, err = findBranch(v, source, "")
			commit = b.Commit
		}
		if err != nil || commit == "" {
			httpx.WriteError(w, 409, "请选择仍然存在的来源分支或明确选择当前 HEAD，不会自动替换来源")
			return
		}
	}
	directory := platform.JoinWorkspacePath(a.Workspace.Root, in.Slug)
	target := platform.JoinWorkspacePath(directory, p.Folder)
	resolved, err := workspace.Eval(r.Context(), a.Workspace.Root)
	if err != nil || resolved != a.Workspace.Root || !platform.Within(a.Workspace.Root, directory) || !platform.Within(directory, target) {
		httpx.WriteError(w, 422, "工作区根目录已变化或路径无效，请检查服务配置")
		return
	}
	var reserved int
	if err := a.Workspace.Store.DB.QueryRow(`SELECT count(*) FROM requirements WHERE slug=? COLLATE NOCASE OR path=?`, in.Slug, directory).Scan(&reserved); err != nil {
		httpx.DbError(w, err)
		return
	}
	if reserved > 0 {
		httpx.WriteError(w, 409, "该目录属于已登记任务，请在对应任务页面管理；独立 worktree 请换一个工作标识")
		return
	}
	if info, err := workspace.Stat(r.Context(), directory, false); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			httpx.WriteError(w, 409, "工作目录不是普通目录，拒绝使用符号链接或文件")
			return
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		httpx.WriteError(w, 409, "无法检查工作目录："+err.Error())
		return
	}
	if _, err := workspace.Stat(r.Context(), target, false); !errors.Is(err, os.ErrNotExist) {
		httpx.WriteError(w, 409, "目标目录已存在或无法检查，不会覆盖："+target)
		return
	}
	for _, t := range v.Project.Worktrees {
		if t.Path == target {
			httpx.WriteError(w, 409, "该路径仍有 Git worktree 登记，请先在 Git 终端检查或修复")
			return
		}
	}
	if err := workspace.Mkdir(r.Context(), directory, 0755, false); err != nil && !errors.Is(err, os.ErrExist) {
		httpx.WriteError(w, 409, "无法创建工作目录："+err.Error())
		return
	}
	// Recheck after mkdir; a pre-existing workspace may be shared by projects.
	if resolved, err := workspace.Eval(r.Context(), directory); err != nil || !platform.SameWorkspacePath(resolved, directory) {
		httpx.WriteError(w, 409, "工作目录已变化，停止创建")
		return
	}
	args := []string{"worktree", "add"}
	if in.Mode == "new" {
		// Use the inspected commit rather than letting Git guess a remote branch.
		args = append(args, "--no-track", "-b", in.Branch, "--", target, commit)
	} else {
		args = append(args, "--", target, in.Branch)
	}
	if _, err := workspace.GitOperation(r.Context(), p.Path, args...); err != nil {
		// Hooks can fail after Git has created a branch or files. Preserve all
		// partial results for inspection rather than removing user work.
		httpx.WriteJSON(w, 409, map[string]any{"error": "Worktree 创建未完成，请刷新列表并检查现场；已有文件和分支均保留", "details": []string{RedactGitOutput(err.Error()), "目标目录：" + target, "分支：" + in.Branch}})
		return
	}
	httpx.WriteJSON(w, 201, map[string]string{"message": "Worktree 已创建，已加入项目列表（未关联任务）", "path": target, "branch": in.Branch, "source": source, "base_commit": commit})
}
