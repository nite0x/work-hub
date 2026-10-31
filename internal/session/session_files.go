package session

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

func (a *Service) SessionExternalLinkHandler(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requestSession(w, r); !ok {
		return
	}
	var input struct {
		URL string `json:"url"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	u, err := url.Parse(input.URL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || len(input.URL) > 8192 {
		httpx.WriteError(w, 400, "网页链接无效")
		return
	}
	if err := a.openExternal(u.String()); err != nil {
		httpx.WriteError(w, 503, "无法打开浏览器："+err.Error())
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"message": "已在浏览器打开链接"})
}

func (a *Service) SessionFileHandler(w http.ResponseWriter, r *http.Request) {
	record, ok := a.requestSession(w, r)
	if !ok {
		return
	}
	line := 1
	if raw := r.URL.Query().Get("line"); raw != "" {
		var err error
		line, err = strconv.Atoi(raw)
		if err != nil || line < 1 || line > 10000000 {
			httpx.WriteError(w, 400, "文件行号无效")
			return
		}
	}
	ctx := workspace.WithClient(r.Context(), a.Workspace.Remote)
	file, err := workspace.ReadWorkspaceText(ctx, r.URL.Query().Get("path"), append([]string{record.Cwd}, record.AdditionalDirectories...))
	if err != nil {
		httpx.WriteError(w, 400, err.Error())
		return
	}
	lines := strings.Split(strings.ReplaceAll(file.Text, "\r\n", "\n"), "\n")
	total := len(lines)
	selected := min(line, total)
	start := max(0, selected-201)
	end := min(total, start+401)
	httpx.WriteJSON(w, 200, map[string]any{"path": file.Path, "lines": lines[start:end], "start_line": start + 1, "total_lines": total, "line": selected, "requested_line": line})
}

// SessionFilesHandler limits browsing to a saved conversation's approved roots.
func (a *Service) SessionFilesHandler(w http.ResponseWriter, r *http.Request) {
	record, ok := a.requestSession(w, r)
	if !ok {
		return
	}
	root := r.URL.Query().Get("path")
	if root == "" {
		root = record.Cwd
	}
	allowed := false
	for _, candidate := range append([]string{record.Cwd}, record.AdditionalDirectories...) {
		if platform.SameWorkspacePath(root, candidate) {
			root = candidate
			allowed = true
			break
		}
	}
	if !allowed {
		httpx.WriteError(w, 400, "只能浏览此对话的工作目录及附加目录")
		return
	}
	relative, file := r.URL.Query().Get("dir"), r.URL.Query().Has("file")
	if file {
		relative = r.URL.Query().Get("file")
	}
	ctx := workspace.WithClient(r.Context(), a.Workspace.Remote)
	result, err := workspace.BrowseWorkspace(ctx, root, relative, file)
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	httpx.WriteJSON(w, 200, result)
}
