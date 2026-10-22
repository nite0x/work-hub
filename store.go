package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Project struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Path            string     `json:"path"`
	CommonDir       string     `json:"common_dir"`
	Folder          string     `json:"folder"`
	CreatedAt       string     `json:"created_at"`
	HasMaster       bool       `json:"has_master"`
	Error           string     `json:"error,omitempty"`
	Worktrees       []Worktree `json:"worktrees"`
	StatusUpdatedAt string     `json:"status_updated_at,omitempty"`
	Refreshing      bool       `json:"refreshing"`
}
type Requirement struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Slug             string   `json:"slug"`
	Description      string   `json:"description"`
	Branch           string   `json:"branch"`
	Path             string   `json:"path"`
	PrimaryProjectID string   `json:"primary_project_id"`
	State            string   `json:"state"`
	CreatedAt        string   `json:"created_at"`
	Members          []Member `json:"members"`
}
type Member struct {
	ProjectID   string    `json:"project_id"`
	ProjectName string    `json:"project_name"`
	Path        string    `json:"path"`
	BaseCommit  string    `json:"base_commit"`
	State       string    `json:"state"`
	Error       string    `json:"error,omitempty"`
	Worktree    *Worktree `json:"worktree,omitempty"`
}

func (a *App) migrate() error {
	_, err := a.db.Exec(`
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
 path TEXT NOT NULL UNIQUE, common_dir TEXT NOT NULL UNIQUE,
 folder TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS master_sync_runs (
 date TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
 status TEXT NOT NULL, results TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requirements (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
 description TEXT NOT NULL, branch TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
 primary_project_id TEXT NOT NULL REFERENCES projects(id), state TEXT NOT NULL,
 created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
 requirement_id TEXT NOT NULL REFERENCES requirements(id), project_id TEXT NOT NULL REFERENCES projects(id),
 path TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, state TEXT NOT NULL,
 error TEXT NOT NULL DEFAULT '', PRIMARY KEY(requirement_id,project_id));
CREATE TABLE IF NOT EXISTS requirement_sessions (
 requirement_id TEXT NOT NULL REFERENCES requirements(id), session_id TEXT NOT NULL,
 name TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 source TEXT NOT NULL, PRIMARY KEY(requirement_id,session_id));
CREATE TABLE IF NOT EXISTS session_create_requests (
 requirement_id TEXT NOT NULL REFERENCES requirements(id), request_id TEXT NOT NULL,
 session_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(requirement_id,request_id));
`)
	return err
}
func (a *App) projects() ([]Project, error) {
	rows, err := a.db.Query(`SELECT id,name,path,common_dir,folder,created_at FROM projects ORDER BY created_at,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Path, &p.CommonDir, &p.Folder, &p.CreatedAt); err != nil {
			return nil, err
		}
		p.Worktrees = []Worktree{}
		out = append(out, p)
	}
	return out, rows.Err()
}
func (a *App) requirements() ([]Requirement, error) {
	rows, err := a.db.Query(`SELECT id,name,slug,description,branch,path,primary_project_id,state,created_at FROM requirements ORDER BY created_at DESC,id`)
	if err != nil {
		return nil, err
	}
	out := []Requirement{}
	for rows.Next() {
		var v Requirement
		if err := rows.Scan(&v.ID, &v.Name, &v.Slug, &v.Description, &v.Branch, &v.Path, &v.PrimaryProjectID, &v.State, &v.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		v.Members = []Member{}
		out = append(out, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range out {
		rows, err := a.db.Query(`SELECT m.project_id,p.name,m.path,m.base_commit,m.state,m.error FROM members m JOIN projects p ON p.id=m.project_id WHERE m.requirement_id=? ORDER BY p.name`, out[i].ID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var m Member
			if err := rows.Scan(&m.ProjectID, &m.ProjectName, &m.Path, &m.BaseCommit, &m.State, &m.Error); err != nil {
				rows.Close()
				return nil, err
			}
			out[i].Members = append(out[i].Members, m)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}
func (a *App) requirement(id string) (Requirement, error) {
	reqs, err := a.requirements()
	if err != nil {
		return Requirement{}, err
	}
	for _, r := range reqs {
		if r.ID == id {
			return r, nil
		}
	}
	return Requirement{}, sql.ErrNoRows
}
func (a *App) stateHandler(w http.ResponseWriter, r *http.Request) {
	projects, err := a.projects()
	if err != nil {
		dbError(w, err)
		return
	}
	reqs, err := a.requirements()
	if err != nil {
		dbError(w, err)
		return
	}
	settings, err := a.terminalSettings()
	if err != nil {
		dbError(w, err)
		return
	}
	terminal, refreshing, updatedAt := a.stateCache.snapshot(projects, settings, r.URL.Query().Get("refresh") == "1")
	masterSync, err := a.masterSyncState(time.Now())
	if err != nil {
		dbError(w, err)
		return
	}
	index := map[string]*Worktree{}
	for i := range projects {
		for j := range projects[i].Worktrees {
			t := &projects[i].Worktrees[j]
			index[t.Path] = t
		}
	}
	for i := range reqs {
		for j := range reqs[i].Members {
			m := &reqs[i].Members[j]
			if t, ok := index[m.Path]; ok {
				t.RequirementID = reqs[i].ID
				t.RequirementName = reqs[i].Name
				t.ExpectedBranch = reqs[i].Branch
				m.Worktree = t
			}
		}
	}
	writeJSON(w, 200, map[string]any{"projects": projects, "requirements": reqs, "root": a.root, "refreshed_at": updatedAt, "status_refreshing": refreshing, "terminal": terminal, "master_sync": masterSync})
}
func (a *App) addProjectHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	if !decode(w, r, &input) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	path, err := workspaceNormalize(r.Context(), input.Path)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	root, err := git(r.Context(), path, "rev-parse", "--show-toplevel")
	if err != nil {
		writeError(w, 422, "该目录不是可用的 Git 工作目录："+err.Error())
		return
	}
	root, err = workspaceEval(r.Context(), strings.TrimSpace(root))
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	common, err := git(r.Context(), root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	common, err = workspaceEval(r.Context(), strings.TrimSpace(common))
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = baseWorkspacePath(root)
	}
	if len([]rune(name)) > 80 {
		writeError(w, 400, "项目名称不能超过 80 字")
		return
	}
	id := newID()
	folder := slugify(name)
	if folder == "" {
		folder = "project-" + id[:6]
	}
	var exists int
	err = a.db.QueryRow(`SELECT count(*) FROM projects WHERE common_dir=? OR name=? COLLATE NOCASE OR folder=? COLLATE NOCASE`, common, name, folder).Scan(&exists)
	if err != nil {
		dbError(w, err)
		return
	}
	if exists > 0 {
		writeError(w, 409, "仓库已登记，或项目名称/目录名重复，请使用不同的项目名称")
		return
	}
	_, err = a.db.Exec(`INSERT INTO projects(id,name,path,common_dir,folder,created_at) VALUES(?,?,?,?,?,?)`, id, name, root, common, folder, now())
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, 201, map[string]string{"id": id})
}
func (a *App) removeProjectHandler(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var count int
	if err := a.db.QueryRow(`SELECT count(*) FROM members WHERE project_id=?`, r.PathValue("id")).Scan(&count); err != nil {
		dbError(w, err)
		return
	}
	if count > 0 {
		writeError(w, 409, "项目仍有关联任务，请保留登记以便追溯")
		return
	}
	if err := mustAffected(a.db.Exec(`DELETE FROM projects WHERE id=?`, r.PathValue("id"))); err != nil {
		writeError(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"message": "已移除项目登记；仓库和 worktree 文件未删除"})
}
func normalizePath(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if runtime.GOOS == "windows" {
		lower := strings.ToLower(strings.ReplaceAll(raw, "/", `\`))
		if strings.HasPrefix(lower, `\\wsl.localhost\`) || strings.HasPrefix(lower, `\\wsl$\`) {
			return "", fmt.Errorf("请先选择对应 WSL 执行环境，再填写 /home/... 路径")
		}
	}
	if runtime.GOOS != "windows" && len(raw) >= 3 && raw[1] == ':' && (raw[2] == '\\' || raw[2] == '/') {
		raw = "/mnt/" + strings.ToLower(raw[:1]) + "/" + strings.ReplaceAll(raw[3:], "\\", "/")
	}
	if strings.HasPrefix(raw, "~/") {
		home, _ := os.UserHomeDir()
		raw = filepath.Join(home, raw[2:])
	}
	if !filepath.IsAbs(raw) {
		return "", fmt.Errorf("请输入当前执行环境中的绝对目录路径")
	}
	path, err := filepath.EvalSymlinks(filepath.Clean(raw))
	if err != nil {
		return "", err
	}
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !st.IsDir() {
		return "", fmt.Errorf("路径必须是文件夹")
	}
	return path, nil
}
func projectMap(ctx context.Context, a *App) (map[string]Project, error) {
	ps, err := a.projects()
	if err != nil {
		return nil, err
	}
	out := map[string]Project{}
	for _, p := range ps {
		out[p.ID] = p
	}
	return out, nil
}
