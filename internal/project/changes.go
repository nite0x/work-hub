package project

import (
	"net/http"
	"strings"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

type ChangedFile struct {
	Path      string `json:"path"`
	Previous  string `json:"previous,omitempty"`
	Index     string `json:"index"`
	Working   string `json:"working"`
	Untracked bool   `json:"untracked"`
}

func changedFiles(raw string) []ChangedFile {
	out := []ChangedFile{}
	fields := strings.Split(raw, "\x00")
	for i := 0; i < len(fields); i++ {
		v := fields[i]
		if len(v) < 4 {
			continue
		}
		f := ChangedFile{Path: v[3:], Index: v[:1], Working: v[1:2], Untracked: v[:2] == "??"}
		if strings.ContainsAny(v[:2], "RC") && i+1 < len(fields) {
			i++
			f.Previous = fields[i]
		}
		out = append(out, f)
	}
	return out
}

func (a *Service) ChangesHandler(w http.ResponseWriter, r *http.Request) {
	p, err := a.RegisteredProject(r.Context(), r.PathValue("id"))
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	unlock := a.lockGit(p.CommonDir)
	defer unlock()
	t, err := selectedWorktree(r.Context(), p, r.URL.Query().Get("path"))
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	raw, err := workspace.Git(r.Context(), t.Path, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	files := changedFiles(raw)
	file := r.URL.Query().Get("file")
	if file == "" {
		httpx.WriteJSON(w, 200, map[string]any{"files": files, "branch": t.Branch, "head": t.Head})
		return
	}
	var selected *ChangedFile
	for i := range files {
		if files[i].Path == file {
			selected = &files[i]
			break
		}
	}
	if selected == nil {
		httpx.WriteError(w, 409, "文件改动已变化，请刷新列表")
		return
	}
	mode := r.URL.Query().Get("mode")
	if mode != "" && mode != "working" && mode != "index" {
		httpx.WriteError(w, 400, "请选择工作区或暂存区")
		return
	}
	format := "patch"
	var result workspace.GitPreview
	if selected.Untracked {
		full := platform.JoinWorkspacePath(t.Path, file)
		if !platform.Within(t.Path, full) {
			httpx.WriteError(w, 400, "文件路径无效")
			return
		}
		content, readErr := workspace.ReadWorkspaceText(r.Context(), full, []string{t.Path})
		if readErr != nil {
			httpx.WriteError(w, 422, "无法预览文件："+readErr.Error())
			return
		}
		result.Text = content.Text
		format = "file"
	} else {
		args := []string{"--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color"}
		if mode == "index" {
			args = append(args, "--cached")
		}
		args = append(args, "--", file)
		if selected.Previous != "" {
			args = append(args, selected.Previous)
		}
		result, err = workspace.RunGitPreview(r.Context(), t.Path, args...)
		if err != nil {
			httpx.WriteError(w, 409, err.Error())
			return
		}
		if result.Text == "" {
			result.Text = "此区域没有文本差异。可切换工作区／暂存区查看。"
			format = "text"
		}
	}
	httpx.WriteJSON(w, 200, map[string]any{"text": result.Text, "truncated": result.Truncated, "format": format, "name": file})
}
