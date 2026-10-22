package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
)

func (a *App) addRequirementProjectsHandler(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ProjectIDs []string `json:"project_ids"`
	}
	if !decode(w, r, &in) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	q, err := a.requirement(r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, 404, "任务不存在")
		return
	}
	if err != nil {
		dbError(w, err)
		return
	}
	if q.State == "archived" || q.State == "creating" {
		writeError(w, 409, "请先取消归档或等待任务创建完成，再添加项目")
		return
	}
	// Use the persisted workspace even when the service now runs with a different --root.
	resolved, err := workspaceEval(r.Context(), q.Path)
	if err != nil || !sameWorkspacePath(resolved, q.Path) || !absoluteWorkspacePath(q.Path) || baseWorkspacePath(q.Path) != q.Slug {
		writeError(w, 422, "工作区目录丢失或被移动，请先恢复原目录")
		return
	}
	ps, err := projectMap(r.Context(), a)
	if err != nil {
		dbError(w, err)
		return
	}
	existing := map[string]bool{}
	for _, m := range q.Members {
		existing[m.ProjectID] = true
	}
	selected := map[string]bool{}
	added := []Member{}
	problems := []string{}
	for _, id := range in.ProjectIDs {
		if selected[id] {
			continue
		}
		p, ok := ps[id]
		if !ok {
			writeError(w, 400, "参与项目不存在，请刷新页面")
			return
		}
		if existing[id] {
			writeError(w, 409, "项目已关联当前任务："+p.Name)
			return
		}
		selected[id] = true
		path := joinWorkspacePath(q.Path, p.Folder)
		if !within(q.Path, path) {
			writeError(w, 422, "worktree 路径越过工作区目录")
			return
		}
		if _, err := workspaceStat(r.Context(), path, false); !errors.Is(err, os.ErrNotExist) {
			problems = append(problems, p.Name+"：工作目录已存在或无法检查，不能覆盖："+path)
			continue
		}
		base, err := preflight(r.Context(), p, q.Branch)
		if err != nil {
			problems = append(problems, p.Name+"："+err.Error())
			continue
		}
		added = append(added, Member{ProjectID: id, ProjectName: p.Name, Path: path, BaseCommit: base, State: "pending"})
	}
	if len(selected) == 0 || len(q.Members)+len(selected) > 30 {
		writeError(w, 400, "请选择要添加的项目，单个任务最多包含 30 个项目")
		return
	}
	if len(problems) > 0 {
		writeJSON(w, 422, map[string]any{"error": "添加前检查未通过，未添加任何项目", "details": problems})
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback()
	for _, m := range added {
		if _, err := tx.Exec(`INSERT INTO members(requirement_id,project_id,path,base_commit,state) VALUES(?,?,?,?,?)`, q.ID, m.ProjectID, m.Path, m.BaseCommit, m.State); err != nil {
			dbError(w, err)
			return
		}
	}
	if _, err := tx.Exec(`UPDATE requirements SET state='creating' WHERE id=?`, q.ID); err != nil {
		dbError(w, err)
		return
	}
	// Append the new scope while preserving all existing task notes.
	if err := appendProjectsBriefContext(r.Context(), q, added); err != nil {
		writeError(w, 422, "无法更新任务说明，未添加项目："+err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		dbError(w, err)
		return
	}
	q.Members = append(q.Members, added...)
	if err := a.prepareMembers(r.Context(), &q, ps, selected); err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, 200, q)
}

func appendProjectsBrief(q Requirement, added []Member) error {
	return appendProjectsBriefContext(context.Background(), q, added)
}
func appendProjectsBriefContext(ctx context.Context, q Requirement, added []Member) error {
	if err := writeBriefContext(ctx, q); err != nil {
		return err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\n\n## 新增参与项目\n\n任务分支：%s\n基线：各项目添加时的本地 master\n\n", q.Branch)
	for _, m := range added {
		fmt.Fprintf(&b, "- %s（参与项目）：%s\n", m.ProjectName, m.Path)
	}
	return workspaceWrite(ctx, joinWorkspacePath(q.Path, "BRIEF.md"), []byte(b.String()), os.O_WRONLY|os.O_APPEND, 0)
}
