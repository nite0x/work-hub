package task

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

// A task reserves its workspace path, but only materializes it for new worktrees.
// Existing tasks always retain their saved path, including after --root changes.
func ensureTaskWorkspace(ctx context.Context, q model.Requirement) error {
	needed := q.HasWorkspace
	for _, m := range q.Members {
		needed = needed || (m.Mode != "project" && m.Mode != "worktree")
	}
	if !needed {
		return nil
	}
	if !platform.AbsoluteWorkspacePath(q.Path) || platform.BaseWorkspacePath(q.Path) != q.Slug {
		return fmt.Errorf("任务工作区路径无效")
	}
	if info, err := workspace.Stat(ctx, q.Path, false); err == nil {
		resolved, evalErr := workspace.Eval(ctx, q.Path)
		if !info.IsDir() || evalErr != nil || !platform.SameWorkspacePath(resolved, q.Path) {
			return fmt.Errorf("工作区目录已移动或不是普通目录")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if q.HasWorkspace {
		return fmt.Errorf("工作区目录丢失，请先恢复原目录")
	}
	parent := platform.JoinWorkspacePath(q.Path, "..")
	resolved, err := workspace.Eval(ctx, parent)
	if err != nil || !platform.SameWorkspacePath(resolved, parent) {
		return fmt.Errorf("工作区父目录不可用，请先恢复原位置")
	}
	return workspace.Mkdir(ctx, q.Path, 0755, false)
}

func (a *Service) editableTask(w http.ResponseWriter, r *http.Request) (model.Requirement, bool) {
	q, err := a.Workspace.Store.Requirement(r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "任务不存在")
		return q, false
	}
	if err != nil {
		httpx.DbError(w, err)
		return q, false
	}
	if q.State == "creating" {
		httpx.WriteError(w, 409, "请等待工作目录准备完成")
		return q, false
	}
	return q, true
}

func (a *Service) UpdateRequirementHandler(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len([]rune(in.Name)) > 100 || len(in.Description) > 20000 {
		httpx.WriteError(w, 400, "请填写任务名称（最多 100 字），说明最多 20000 字节")
		return
	}
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	q, ok := a.editableTask(w, r)
	if !ok {
		return
	}
	if _, err := a.Workspace.Store.DB.Exec(`UPDATE requirements SET name=?,description=? WHERE id=?`, in.Name, in.Description, q.ID); err != nil {
		httpx.DbError(w, err)
		return
	}
	q.Name, q.Description = in.Name, in.Description
	httpx.WriteJSON(w, 200, q)
}

func (a *Service) RemoveRequirementProjectHandler(w http.ResponseWriter, r *http.Request) {
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	q, ok := a.editableTask(w, r)
	if !ok {
		return
	}
	if q.State == "archived" {
		httpx.WriteError(w, 409, "请先取消归档")
		return
	}
	id := r.PathValue("project")
	members := []model.Member{}
	found := false
	for _, m := range q.Members {
		if m.ProjectID == id {
			found = true
		} else {
			members = append(members, m)
		}
	}
	if !found {
		httpx.WriteError(w, 404, "项目未关联当前任务")
		return
	}
	q.Members = members
	if q.PrimaryProjectID == id && len(members) > 0 {
		q.PrimaryProjectID = members[0].ProjectID
	}
	q.State = "ready"
	for _, m := range members {
		if m.State != "ready" {
			q.State = "partial"
		}
	}
	tx, err := a.Workspace.Store.DB.Begin()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM members WHERE requirement_id=? AND project_id=?`, q.ID, id); err == nil {
		_, err = tx.Exec(`UPDATE requirements SET primary_project_id=?,state=? WHERE id=?`, q.PrimaryProjectID, q.State, q.ID)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, q)
}

func (a *Service) ReplaceRequirementProjectHandler(w http.ResponseWriter, r *http.Request) {
	var in MemberSelection
	if !httpx.Decode(w, r, &in) {
		return
	}
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	q, ok := a.editableTask(w, r)
	if !ok {
		return
	}
	if q.State == "archived" {
		httpx.WriteError(w, 409, "请先取消归档")
		return
	}
	id := r.PathValue("project")
	index := -1
	for i, m := range q.Members {
		if m.ProjectID == id {
			index = i
		}
	}
	if index < 0 {
		httpx.WriteError(w, 404, "项目未关联当前任务")
		return
	}
	ps, err := a.Workspace.Store.ProjectMap()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	p, exists := ps[id]
	if !exists {
		httpx.WriteError(w, 404, "项目不存在")
		return
	}
	// Replacing a managed checkout never reuses or removes the old path.
	if in.Mode == "new" {
		p.Folder = p.Folder[:min(48, len(p.Folder))]
		if in.Path != "" {
			folder := platform.BaseWorkspacePath(in.Path)
			if !workspace.ValidSlug.MatchString(folder) || !strings.HasPrefix(folder, p.Folder+"-") || !platform.SameWorkspacePath(platform.JoinWorkspacePath(q.Path, folder), in.Path) {
				httpx.WriteError(w, 400, "新目录必须位于任务工作区中")
				return
			}
			p.Folder = folder
		} else {
			p.Folder += "-" + model.NewID()[:8]
		}
	}
	m, err := selectedMember(r.Context(), p, q.Path, "codex/"+q.Slug, in)
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	q.Members[index] = m
	if m.Mode == "new" {
		err = ensureTaskWorkspace(r.Context(), q)
	}
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	q.HasWorkspace = q.HasWorkspace || m.Mode == "new"
	tx, err := a.Workspace.Store.DB.Begin()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	defer tx.Rollback()
	_, err = tx.Exec(`UPDATE members SET path=?,base_commit=?,base_ref=?,branch=?,mode=?,state='pending',error='' WHERE requirement_id=? AND project_id=?`, m.Path, m.BaseCommit, m.BaseRef, m.Branch, m.Mode, q.ID, id)
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	if _, err = tx.Exec(`UPDATE requirements SET has_workspace=?,state='creating' WHERE id=?`, q.HasWorkspace, q.ID); err != nil {
		httpx.DbError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		httpx.DbError(w, err)
		return
	}
	if err = a.PrepareMembers(r.Context(), &q, ps, map[string]bool{id: true}); err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, q)
}
