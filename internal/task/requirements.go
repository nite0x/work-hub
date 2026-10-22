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
	Name             string   `json:"name"`
	Slug             string   `json:"slug"`
	Description      string   `json:"description"`
	Branch           string   `json:"branch"`
	PrimaryProjectID string   `json:"primary_project_id"`
	ProjectIDs       []string `json:"project_ids"`
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
	if len(in.Branch) > 160 || strings.Contains(in.Branch, "@{") {
		httpx.WriteError(w, 400, "分支名无效")
		return
	}
	if _, err := workspace.Git(r.Context(), a.Workspace.Root, "check-ref-format", "refs/heads/"+in.Branch); err != nil {
		httpx.WriteError(w, 400, "分支名无效："+err.Error())
		return
	}
	ps, err := a.Workspace.Store.ProjectMap()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	if _, ok := ps[in.PrimaryProjectID]; !ok {
		httpx.WriteError(w, 400, "请选择已登记的主项目")
		return
	}
	ids := []string{in.PrimaryProjectID}
	seen := map[string]bool{in.PrimaryProjectID: true}
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
	if len(ids) > 30 {
		httpx.WriteError(w, 400, "单个任务最多包含 30 个项目")
		return
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
		path := platform.JoinWorkspacePath(directory, p.Folder)
		base, err := preflight(r.Context(), p, in.Branch)
		if err != nil {
			problems = append(problems, p.Name+"："+err.Error())
			continue
		}
		q.Members = append(q.Members, model.Member{ProjectID: id, ProjectName: p.Name, Path: path, BaseCommit: base, State: "pending"})
	}
	if len(problems) > 0 {
		httpx.WriteJSON(w, 422, map[string]any{"error": "创建前检查未通过，未创建任何 worktree", "details": problems})
		return
	}
	if err := workspace.Mkdir(r.Context(), directory, 0755, false); err != nil {
		httpx.WriteError(w, 409, "无法创建工作区目录："+err.Error())
		return
	}
	tx, err := a.Workspace.Store.DB.Begin()
	if err != nil {
		_ = workspace.Remove(r.Context(), directory)
		httpx.DbError(w, err)
		return
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO requirements(id,name,slug,description,branch,path,primary_project_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, q.ID, q.Name, q.Slug, q.Description, q.Branch, q.Path, q.PrimaryProjectID, q.State, q.CreatedAt)
	if err == nil {
		for _, m := range q.Members {
			_, err = tx.Exec(`INSERT INTO members(requirement_id,project_id,path,base_commit,state) VALUES(?,?,?,?,?)`, q.ID, m.ProjectID, m.Path, m.BaseCommit, m.State)
			if err != nil {
				break
			}
		}
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		_ = workspace.Remove(r.Context(), directory)
		httpx.DbError(w, err)
		return
	}
	if err := a.Prepare(r.Context(), &q, ps); err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 201, q)
}

func preflight(ctx context.Context, p model.Project, branch string) (string, error) {
	common, err := workspace.Git(ctx, p.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return "", err
	}
	resolved, err := workspace.Eval(ctx, strings.TrimSpace(common))
	if err != nil || resolved != p.CommonDir {
		return "", fmt.Errorf("仓库位置已变更，请检查登记路径")
	}
	base, err := workspace.Git(ctx, p.Path, "rev-parse", "--verify", "refs/heads/master^{commit}")
	if err != nil {
		return "", fmt.Errorf("缺少本地 master 分支，请先准备 master；不会自动使用 main 或其他分支")
	}
	if _, err := workspace.Git(ctx, p.Path, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch); err == nil {
		return "", fmt.Errorf("分支 %s 已存在，请使用新分支名", branch)
	}
	return strings.TrimSpace(base), nil
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
	actual, err := workspace.Git(ctx, m.Path, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || strings.TrimSpace(actual) != branch {
		return fmt.Errorf("实际分支与任务分支 %s 不一致，请恢复后再启动", branch)
	}
	if _, err := workspace.Git(ctx, m.Path, "merge-base", "--is-ancestor", m.BaseCommit, "HEAD"); err != nil {
		return fmt.Errorf("worktree 已偏离创建时的 master 基线，请检查后处理")
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
		} else if !platform.Within(q.Path, m.Path) {
			createErr = fmt.Errorf("worktree 路径越过工作区目录")
		} else if _, err := workspace.Stat(ctx, m.Path, false); err == nil {
			// Recover only the exact persisted repository/path/branch combination, never overwrite it.
			createErr = VerifyMember(ctx, p, *m, q.Branch)
		} else if !errors.Is(err, os.ErrNotExist) {
			createErr = err
		} else if _, err := workspace.Git(ctx, p.Path, "rev-parse", "--verify", "--quiet", "refs/heads/"+q.Branch); err == nil {
			createErr = fmt.Errorf("分支 %s 已存在但 worktree 不存在，请先检查残留分支", q.Branch)
		} else {
			_, createErr = workspace.Git(ctx, p.Path, "worktree", "add", "-b", q.Branch, "--", m.Path, m.BaseCommit)
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
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n%s\n\n## 项目与工作目录\n\n任务分支：%s\n所有项目基线：本地 master（创建时提交已记录）\n\n", q.Name, q.Description, q.Branch)
	for _, m := range q.Members {
		role := "参与项目"
		if m.ProjectID == q.PrimaryProjectID {
			role = "主项目"
		}
		fmt.Fprintf(&b, "- %s（%s）：%s\n", m.ProjectName, role, m.Path)
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
	resolved, err := workspace.Eval(r.Context(), q.Path)
	// Existing requirements retain their persisted location when --root changes.
	if err != nil || !platform.SameWorkspacePath(resolved, q.Path) || !platform.AbsoluteWorkspacePath(q.Path) || platform.BaseWorkspacePath(q.Path) != q.Slug {
		httpx.WriteError(w, 422, "工作区目录丢失或被移动，请先恢复原目录")
		return
	}
	ps, err := a.Workspace.Store.ProjectMap()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	if err := a.Prepare(r.Context(), &q, ps); err != nil {
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
