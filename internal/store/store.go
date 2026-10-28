package store

import (
	"database/sql"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"

	"worktree-hub/internal/model"
)

type Store struct{ DB *sql.DB }

// OpenReadOnly reads saved environment metadata without running migrations or
// marking in-progress work interrupted. Listing tasks must not start an environment.
func OpenReadOnly(dataDir string) (*Store, error) {
	dbPath := filepath.ToSlash(filepath.Join(dataDir, "worktree-hub.db"))
	if !strings.HasPrefix(dbPath, "/") {
		dbPath = "/" + dbPath
	}
	dbURL := &url.URL{Scheme: "file", Path: dbPath}
	db, err := sql.Open("sqlite", dbURL.String()+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{DB: db}, nil
}

// Open initializes the schema and marks work interrupted by a previous process.
func Open(dataDir string) (*Store, error) {
	dbPath := filepath.ToSlash(filepath.Join(dataDir, "worktree-hub.db"))
	if !strings.HasPrefix(dbPath, "/") {
		dbPath = "/" + dbPath
	}
	dbURL := &url.URL{Scheme: "file", Path: dbPath}
	db, err := sql.Open("sqlite", dbURL.String()+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{DB: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	// A crash can interrupt filesystem work. Preserve the records and require explicit retry.
	_, err = db.Exec(`UPDATE requirements SET state='partial' WHERE state='creating'; UPDATE members SET state='failed', error='上次创建被中断，请检查后重试' WHERE state IN ('creating','pending')`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	_, err := s.DB.Exec(`
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
 path TEXT NOT NULL UNIQUE, common_dir TEXT NOT NULL UNIQUE,
 folder TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_async_answers (
 session_id TEXT NOT NULL, item_id TEXT NOT NULL, turn_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, status TEXT NOT NULL, request_id TEXT NOT NULL,
 PRIMARY KEY(session_id,item_id,turn_id));
CREATE TABLE IF NOT EXISTS requirements (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
 description TEXT NOT NULL, branch TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
 primary_project_id TEXT REFERENCES projects(id), state TEXT NOT NULL,
 created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
 requirement_id TEXT NOT NULL REFERENCES requirements(id), project_id TEXT NOT NULL REFERENCES projects(id),
 path TEXT NOT NULL, base_commit TEXT NOT NULL, state TEXT NOT NULL,
 mode TEXT NOT NULL DEFAULT 'new', base_ref TEXT NOT NULL DEFAULT 'refs/heads/master', branch TEXT NOT NULL DEFAULT '',
 error TEXT NOT NULL DEFAULT '', PRIMARY KEY(requirement_id,project_id));
CREATE TABLE IF NOT EXISTS requirement_sessions (
 requirement_id TEXT NOT NULL REFERENCES requirements(id), session_id TEXT NOT NULL,
 name TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 source TEXT NOT NULL, PRIMARY KEY(requirement_id,session_id));
CREATE TABLE IF NOT EXISTS session_create_requests (
 requirement_id TEXT NOT NULL REFERENCES requirements(id), request_id TEXT NOT NULL,
 session_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(requirement_id,request_id));
`)
	if err != nil {
		return err
	}
	requirementColumns, err := tableColumns(s.DB, "requirements")
	if err != nil {
		return err
	}
	if !requirementColumns["has_workspace"] {
		if _, err := s.DB.Exec(`ALTER TABLE requirements ADD COLUMN has_workspace INTEGER NOT NULL DEFAULT 1`); err != nil {
			return err
		}
	}
	columns, err := tableColumns(s.DB, "members")
	if err != nil {
		return err
	}
	if columns["mode"] {
		return s.finishTaskMigration()
	}
	// Existing directories may participate in multiple tasks. Retain every old
	// member while removing the old exclusive-path constraint.
	_, err = s.DB.Exec(`BEGIN;
CREATE TABLE members_v2 (
 requirement_id TEXT NOT NULL REFERENCES requirements(id), project_id TEXT NOT NULL REFERENCES projects(id),
 path TEXT NOT NULL, base_commit TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
 mode TEXT NOT NULL DEFAULT 'new', base_ref TEXT NOT NULL DEFAULT 'refs/heads/master', branch TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(requirement_id,project_id));
INSERT INTO members_v2(requirement_id,project_id,path,base_commit,state,error) SELECT requirement_id,project_id,path,base_commit,state,error FROM members;
DROP TABLE members;
ALTER TABLE members_v2 RENAME TO members;
COMMIT;`)
	if err != nil {
		return err
	}
	return s.finishTaskMigration()
}

func tableColumns(db *sql.DB, name string) (map[string]bool, error) {
	rows, err := db.Query("PRAGMA table_info(" + name + ")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var column, kind string
		var defaultValue any
		if err := rows.Scan(&cid, &column, &kind, &notnull, &defaultValue, &pk); err != nil {
			return nil, err
		}
		columns[column] = true
	}
	return columns, rows.Err()
}
func (s *Store) Projects() ([]model.Project, error) {
	rows, err := s.DB.Query(`SELECT id,name,path,common_dir,folder,created_at FROM projects ORDER BY created_at,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Project{}
	for rows.Next() {
		var p model.Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Path, &p.CommonDir, &p.Folder, &p.CreatedAt); err != nil {
			return nil, err
		}
		p.Worktrees = []model.Worktree{}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Requirements reads tasks and members with two bounded queries, including on
// offline legacy databases. A read transaction keeps both halves consistent.
func (s *Store) Requirements() ([]model.Requirement, error) { return s.requirements("") }
func (s *Store) Requirement(id string) (model.Requirement, error) {
	if id == "" {
		return model.Requirement{}, sql.ErrNoRows
	}
	tasks, err := s.requirements(id)
	if err != nil {
		return model.Requirement{}, err
	}
	if len(tasks) == 0 {
		return model.Requirement{}, sql.ErrNoRows
	}
	return tasks[0], nil
}
func (s *Store) requirements(id string) ([]model.Requirement, error) {
	columns, err := tableColumns(s.DB, "members")
	if err != nil {
		return nil, err
	}
	memberScope := "m.mode,m.base_ref,m.branch"
	if !columns["mode"] {
		memberScope = "'new','refs/heads/master',''"
	}
	requirementColumns, err := tableColumns(s.DB, "requirements")
	if err != nil {
		return nil, err
	}
	workspaceColumn := "1"
	if requirementColumns["has_workspace"] {
		workspaceColumn = "has_workspace"
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	query := `SELECT id,name,slug,description,branch,path,COALESCE(primary_project_id,''),state,created_at,` + workspaceColumn + ` FROM requirements`
	args := []any{}
	if id != "" {
		query += ` WHERE id=?`
		args = append(args, id)
	}
	rows, err := tx.Query(query+` ORDER BY created_at DESC,id`, args...)
	if err != nil {
		return nil, err
	}
	out := []model.Requirement{}
	index := map[string]int{}
	for rows.Next() {
		var v model.Requirement
		if err := rows.Scan(&v.ID, &v.Name, &v.Slug, &v.Description, &v.Branch, &v.Path, &v.PrimaryProjectID, &v.State, &v.CreatedAt, &v.HasWorkspace); err != nil {
			rows.Close()
			return nil, err
		}
		v.Members = []model.Member{}
		index[v.ID] = len(out)
		out = append(out, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, tx.Commit()
	}
	query = `SELECT m.requirement_id,m.project_id,p.name,m.path,m.base_commit,m.state,m.error,` + memberScope + ` FROM members m JOIN projects p ON p.id=m.project_id`
	if id != "" {
		query += ` WHERE m.requirement_id=?`
	}
	rows, err = tx.Query(query+` ORDER BY m.requirement_id,p.name`, args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var taskID string
		var m model.Member
		if err := rows.Scan(&taskID, &m.ProjectID, &m.ProjectName, &m.Path, &m.BaseCommit, &m.State, &m.Error, &m.Mode, &m.BaseRef, &m.Branch); err != nil {
			rows.Close()
			return nil, err
		}
		if i, ok := index[taskID]; ok {
			if m.Mode == "new" && m.Branch == "" {
				m.Branch = out[i].Branch
			}
			out[i].Members = append(out[i].Members, m)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	return out, tx.Commit()
}
func MustAffected(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("记录不存在")
	}
	return nil
}
