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

type CreateRequirement struct {
	Name             string            `json:"name"`
	Slug             string            `json:"slug"`
	Description      string            `json:"description"`
	Branch           string            `json:"branch"`
	PrimaryProjectID string            `json:"primary_project_id"`
	ProjectIDs       []string          `json:"project_ids"`
	Members          []MemberSelection `json:"members"`
}

func (a *Service) CreateRequirementHandler(w http.ResponseWriter, r *http.Request) {
	var in CreateRequirement
	if !httpx.Decode(w, r, &in) {
		return
	}
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	in.Name = strings.TrimSpace(in.Name)
	in.Slug = strings.TrimSpace(in.Slug)
	if in.Slug == "" {
		in.Slug = "task-" + model.NewID()[:12]
	}
	in.Branch = strings.TrimSpace(in.Branch)
	if in.Name == "" || len([]rune(in.Name)) > 100 || len(in.Description) > 20000 {
		httpx.WriteError(w, 400, "请填写任务名称（最多 100 字），说明最多 20000 字节")
		return
	}
	if !workspace.ValidSlug.MatchString(in.Slug) {
		httpx.WriteError(w, 400, "目录标识应为 1–64 位英文字母、数字、短横线或下划线，以字母或数字开头")
		return
	}
	if in.Branch == "" {
		in.Branch = "codex/" + in.Slug
	}
	ps, err := a.Workspace.Store.ProjectMap()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	if in.PrimaryProjectID != "" {
		if _, ok := ps[in.PrimaryProjectID]; !ok {
			httpx.WriteError(w, 400, "请选择已登记的主项目")
			return
		}
	}
	ids := []string{}
	seen := map[string]bool{}
	if in.PrimaryProjectID != "" {
		ids = append(ids, in.PrimaryProjectID)
		seen[in.PrimaryProjectID] = true
	}
	for _, id := range in.ProjectIDs {
		if !seen[id] {
			if _, ok := ps[id]; !ok {
				httpx.WriteError(w, 400, "参与项目不存在，请刷新页面")
				return
			}
			ids = append(ids, id)
			seen[id] = true
		}
	}
	selections, err := selectionsByProject(in.Members)
	if err != nil {
		httpx.WriteError(w, 400, err.Error())
		return
	}
	for _, selection := range in.Members {
		if _, ok := ps[selection.ProjectID]; !ok {
			httpx.WriteError(w, 400, "参与项目不存在，请刷新页面")
			return
		}
		if !seen[selection.ProjectID] {
			ids = append(ids, selection.ProjectID)
			seen[selection.ProjectID] = true
		}
	}
	if len(ids) == 0 || len(ids) > 30 {
		httpx.WriteError(w, 400, "请选择 1–30 个项目")
		return
	}
	if in.PrimaryProjectID == "" {
		in.PrimaryProjectID = ids[0]
	}
	var count int
	if err := a.Workspace.Store.DB.QueryRow(`SELECT count(*) FROM requirements WHERE slug=? COLLATE NOCASE`, in.Slug).Scan(&count); err != nil {
		httpx.DbError(w, err)
		return
	}
	if count > 0 {
		httpx.WriteError(w, 409, "任务目录标识已使用，请换一个标识")
		return
	}
	directory := platform.JoinWorkspacePath(a.Workspace.Root, in.Slug)
	resolved, err := workspace.Eval(r.Context(), a.Workspace.Root)
	if err != nil || resolved != a.Workspace.Root || !platform.Within(a.Workspace.Root, directory) {
		httpx.WriteError(w, 422, "工作区根目录已移动或不可用，请检查服务配置")
		return
	}
	if _, err := workspace.Stat(r.Context(), directory, false); !errors.Is(err, os.ErrNotExist) {
		httpx.WriteError(w, 409, "工作区目录已存在或无法检查，不能覆盖："+directory)
		return
	}
	q := model.Requirement{ID: model.NewID(), Name: in.Name, Slug: in.Slug, Description: in.Description, Branch: in.Branch, Path: directory, PrimaryProjectID: in.PrimaryProjectID, State: "creating", CreatedAt: model.Now(), Members: []model.Member{}}
	problems := []string{}
	for _, id := range ids {
		p := ps[id]
		m, err := selectedMember(r.Context(), p, directory, in.Branch, selections[id])
		if err != nil {
			problems = append(problems, p.Name+"："+err.Error())
			continue
		}
		q.Members = append(q.Members, m)
	}
	if len(problems) > 0 {
		httpx.WriteJSON(w, 422, map[string]any{"error": "创建前检查未通过，未创建任何 worktree", "details": problems})
		return
	}
	hasNew := false
	for _, m := range q.Members {
		hasNew = hasNew || m.Mode == "new"
	}
	q.HasWorkspace = hasNew
	if !hasNew {
		q.Branch = ""
	}
	if hasNew {
		if err := workspace.Mkdir(r.Context(), directory, 0755, false); err != nil {
			httpx.WriteError(w, 409, "无法创建工作区目录："+err.Error())
			return
		}
	}
	tx, err := a.Workspace.Store.DB.Begin()
	if err != nil {
		if hasNew {
			_ = workspace.Remove(r.Context(), directory)
		}
		httpx.DbError(w, err)
		return
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO requirements(id,name,slug,description,branch,path,primary_project_id,state,created_at,has_workspace) VALUES(?,?,?,?,?,?,?,?,?,?)`, q.ID, q.Name, q.Slug, q.Description, q.Branch, q.Path, q.PrimaryProjectID, q.State, q.CreatedAt, q.HasWorkspace)
	if err == nil {
		for _, m := range q.Members {
			_, err = tx.Exec(`INSERT INTO members(requirement_id,project_id,path,base_commit,state,mode,base_ref,branch) VALUES(?,?,?,?,?,?,?,?)`, q.ID, m.ProjectID, m.Path, m.BaseCommit, m.State, m.Mode, m.BaseRef, m.Branch)
			if err != nil {
				break
			}
		}
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		if hasNew {
			_ = workspace.Remove(r.Context(), directory)
		}
		httpx.DbError(w, err)
		return
	}
	if err := a.Prepare(r.Context(), &q, ps); err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 201, q)
}

func VerifyMember(ctx context.Context, p model.Project, m model.Member, branch string) error {
	st, err := workspace.Stat(ctx, m.Path, false)
	if err != nil {
		return err
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("worktree 路径是符号链接，拒绝使用")
	}
	top, err := workspace.Git(ctx, m.Path, "rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	if !platform.SameWorkspacePath(strings.TrimSpace(top), m.Path) {
		return fmt.Errorf("该路径已不再是独立 worktree")
	}
	common, err := workspace.Git(ctx, m.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return err
	}
	commonPath, err := workspace.Eval(ctx, strings.TrimSpace(common))
	if err != nil || commonPath != p.CommonDir {
		return fmt.Errorf("该路径属于其他仓库")
	}
	if m.Mode == "project" || m.Mode == "worktree" {
		raw, err := workspace.Git(ctx, p.Path, "worktree", "list", "--porcelain", "-z")
		if err != nil {
			return err
		}
		for _, field := range strings.Split(raw, "\x00") {
			if strings.HasPrefix(field, "worktree ") && platform.SameWorkspacePath(strings.TrimPrefix(field, "worktree "), m.Path) {
				return nil
			}
		}
		return fmt.Errorf("该目录不是此项目的已登记 worktree")
	}
	branch = memberBranch(m, branch)
	actual, err := workspace.Git(ctx, m.Path, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || strings.TrimSpace(actual) != branch {
		return fmt.Errorf("实际分支与任务分支 %s 不一致，请恢复后再启动", branch)
	}
	// The creation baseline is a recovery guard, not a restriction on later
	// explicit branch switches. Keep it intact as historical task metadata.
	if m.State != "ready" {
		if _, err := workspace.Git(ctx, m.Path, "merge-base", "--is-ancestor", m.BaseCommit, "HEAD"); err != nil {
			return fmt.Errorf("worktree 已偏离创建时记录的基线，请检查后处理")
		}
	}
	return nil
}
func (a *Service) Prepare(ctx context.Context, q *model.Requirement, ps map[string]model.Project) error {
	return a.PrepareMembers(ctx, q, ps, nil)
}

// selected limits an addition to its new members; existing failures remain available for explicit retry.
func (a *Service) PrepareMembers(ctx context.Context, q *model.Requirement, ps map[string]model.Project, selected map[string]bool) error {
	q.State = "creating"
	if _, err := a.Workspace.Store.DB.Exec(`UPDATE requirements SET state='creating' WHERE id=?`, q.ID); err != nil {
		return err
	}
	briefErr := WriteBriefContext(ctx, *q)
	for i := range q.Members {
		m := &q.Members[i]
		if m.State == "ready" || (selected != nil && !selected[m.ProjectID]) {
			continue
		}
		m.State = "creating"
		m.Error = ""
		if _, err := a.Workspace.Store.DB.Exec(`UPDATE members SET state='creating',error='' WHERE requirement_id=? AND project_id=?`, q.ID, m.ProjectID); err != nil {
			return err
		}
		p := ps[m.ProjectID]
		var createErr error
		if briefErr != nil {
			createErr = briefErr
		} else if m.Mode == "project" || m.Mode == "worktree" {
			createErr = VerifyMember(ctx, p, *m, "")
		} else if !platform.Within(q.Path, m.Path) {
			createErr = fmt.Errorf("worktree 路径越过工作区目录")
		} else if _, err := workspace.Stat(ctx, m.Path, false); err == nil {
			// Recover only the exact persisted repository/path/branch combination, never overwrite it.
			createErr = VerifyMember(ctx, p, *m, q.Branch)
		} else if !errors.Is(err, os.ErrNotExist) {
			createErr = err
		} else if _, err := workspace.Git(ctx, p.Path, "rev-parse", "--verify", "--quiet", "refs/heads/"+memberBranch(*m, q.Branch)); err == nil {
			createErr = fmt.Errorf("分支 %s 已存在但 worktree 不存在，请先检查残留分支", memberBranch(*m, q.Branch))
		} else {
			_, createErr = workspace.Git(ctx, p.Path, "worktree", "add", "--no-track", "-b", memberBranch(*m, q.Branch), "--", m.Path, m.BaseCommit)
			if createErr == nil {
				createErr = VerifyMember(ctx, p, *m, q.Branch)
			}
		}
		if createErr != nil {
			m.State = "failed"
			m.Error = createErr.Error()
		} else {
			m.State = "ready"
		}
		if _, err := a.Workspace.Store.DB.Exec(`UPDATE members SET state=?,error=? WHERE requirement_id=? AND project_id=?`, m.State, m.Error, q.ID, m.ProjectID); err != nil {
			return err
		}
	}
	q.State = "ready"
	for _, m := range q.Members {
		if m.State != "ready" {
			q.State = "partial"
			break
		}
	}
	_, err := a.Workspace.Store.DB.Exec(`UPDATE requirements SET state=? WHERE id=?`, q.State, q.ID)
	return err
}
func writeBrief(q model.Requirement) error {
	return WriteBriefContext(context.Background(), q)
}
func WriteBriefContext(ctx context.Context, q model.Requirement) error {
	if !q.HasWorkspace {
		return nil
	}
	if _, err := workspace.Stat(ctx, q.Path, false); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n%s\n\n## 项目与工作目录\n\n各项目使用下列工作目录；新建工作目录的来源与提交分别记录。\n\n", q.Name, q.Description)
	for _, m := range q.Members {
		role := "参与项目"
		if m.ProjectID == q.PrimaryProjectID {
			role = "主项目"
		}
		fmt.Fprintf(&b, "- %s（%s）：%s\n  %s\n", m.ProjectName, role, m.Path, memberDescription(m))
	}
	b.WriteString("\n请分别遵循每个项目内适用的 AGENTS.md。Git、构建和测试命令需在对应项目目录执行。\n")
	path := platform.JoinWorkspacePath(q.Path, "BRIEF.md")
	err := workspace.Write(ctx, path, []byte(b.String()), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if errors.Is(err, os.ErrExist) {
		st, statErr := workspace.Stat(ctx, path, false)
		if statErr != nil || !st.Mode().IsRegular() {
			return fmt.Errorf("任务说明不是普通文件，请检查 BRIEF.md")
		}
		return nil // Preserve user notes when retrying an interrupted creation.
	}
	if err != nil {
		return fmt.Errorf("无法写入任务说明：%w", err)
	}
	return nil
}
func (a *Service) RetryHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ProjectID string `json:"project_id"`
	}
	if r.ContentLength != 0 && !httpx.Decode(w, r, &input) {
		return
	}
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	q, err := a.Workspace.Store.Requirement(r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "任务不存在")
		return
	}
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	if q.State == "archived" {
		httpx.WriteError(w, 409, "请先取消归档")
		return
	}
	var selected map[string]bool
	if input.ProjectID != "" {
		selected = map[string]bool{input.ProjectID: true}
		found := false
		for _, m := range q.Members {
			found = found || m.ProjectID == input.ProjectID
		}
		if !found {
			httpx.WriteError(w, 404, "项目未关联当前任务")
			return
		}
	}
	needsWorkspace := false
	for _, m := range q.Members {
		if (selected == nil || selected[m.ProjectID]) && m.Mode != "project" && m.Mode != "worktree" {
			needsWorkspace = true
		}
	}
	if needsWorkspace {
		if err := ensureTaskWorkspace(r.Context(), q); err != nil {
			httpx.WriteError(w, 422, err.Error())
			return
		}
	}
	ps, err := a.Workspace.Store.ProjectMap()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	if err := a.PrepareMembers(r.Context(), &q, ps, selected); err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, q)
}
func (a *Service) ArchiveHandler(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Archived bool `json:"archived"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	q, err := a.Workspace.Store.Requirement(r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "任务不存在")
		return
	}
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	state := "archived"
	if !in.Archived {
		state = "ready"
		for _, m := range q.Members {
			if m.State != "ready" {
				state = "partial"
			}
		}
	}
	if _, err := a.Workspace.Store.DB.Exec(`UPDATE requirements SET state=? WHERE id=?`, state, q.ID); err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"message": "状态已更新，worktree 和分支均保留"})
}
