package project

import (
	"net/http"
	"strings"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

func (a *Service) AddProjectHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	path, err := workspace.Normalize(r.Context(), input.Path)
	if err != nil {
		httpx.WriteError(w, 400, err.Error())
		return
	}
	root, err := workspace.Git(r.Context(), path, "rev-parse", "--show-toplevel")
	if err != nil {
		httpx.WriteError(w, 422, "该目录不是可用的 Git 工作目录："+err.Error())
		return
	}
	root, err = workspace.Eval(r.Context(), strings.TrimSpace(root))
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	common, err := workspace.Git(r.Context(), root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	common, err = workspace.Eval(r.Context(), strings.TrimSpace(common))
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = platform.BaseWorkspacePath(root)
	}
	if len([]rune(name)) > 80 {
		httpx.WriteError(w, 400, "项目名称不能超过 80 字")
		return
	}
	id := model.NewID()
	folder := workspace.Slugify(name)
	if folder == "" {
		folder = "project-" + id[:6]
	}
	var exists int
	err = a.Workspace.Store.DB.QueryRow(`SELECT count(*) FROM projects WHERE common_dir=? OR name=? COLLATE NOCASE OR folder=? COLLATE NOCASE`, common, name, folder).Scan(&exists)
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	if exists > 0 {
		httpx.WriteError(w, 409, "仓库已登记，或项目名称/目录名重复，请使用不同的项目名称")
		return
	}
	_, err = a.Workspace.Store.DB.Exec(`INSERT INTO projects(id,name,path,common_dir,folder,created_at) VALUES(?,?,?,?,?,?)`, id, name, root, common, folder, model.Now())
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 201, map[string]string{"id": id})
}
func (a *Service) RemoveProjectHandler(w http.ResponseWriter, r *http.Request) {
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	var count int
	if err := a.Workspace.Store.DB.QueryRow(`SELECT count(*) FROM members WHERE project_id=?`, r.PathValue("id")).Scan(&count); err != nil {
		httpx.DbError(w, err)
		return
	}
	if count > 0 {
		httpx.WriteError(w, 409, "项目仍有关联任务，请保留登记以便追溯")
		return
	}
	result, err := a.Workspace.Store.DB.Exec(`DELETE FROM projects WHERE id=?`, r.PathValue("id"))
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	if n, err := result.RowsAffected(); err != nil {
		httpx.DbError(w, err)
		return
	} else if n == 0 {
		httpx.WriteError(w, 404, "项目不存在")
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"message": "已移除项目登记；仓库和 worktree 文件未删除"})
}
