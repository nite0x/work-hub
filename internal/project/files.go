package project

import (
	"net/http"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/workspace"
)

func (a *Service) FilesHandler(w http.ResponseWriter, r *http.Request) {
	p, err := a.RegisteredProject(r.Context(), r.PathValue("id"))
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	unlock := a.lockGit(p.CommonDir)
	defer unlock()
	tree, err := selectedWorktree(r.Context(), p, r.URL.Query().Get("path"))
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	relative := r.URL.Query().Get("dir")
	file := r.URL.Query().Has("file")
	if file {
		relative = r.URL.Query().Get("file")
	}
	result, err := workspace.BrowseWorkspace(r.Context(), tree.Path, relative, file)
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	httpx.WriteJSON(w, 200, result)
}
