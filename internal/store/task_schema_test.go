package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func TestOptionalTaskPrimaryMigrationPreservesDependentRows(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "worktree-hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,path TEXT,common_dir TEXT,folder TEXT,created_at TEXT);
CREATE TABLE requirements(id TEXT PRIMARY KEY,name TEXT,slug TEXT,description TEXT,branch TEXT,path TEXT,primary_project_id TEXT NOT NULL REFERENCES projects(id),state TEXT,created_at TEXT);
CREATE TABLE members(requirement_id TEXT REFERENCES requirements(id),project_id TEXT REFERENCES projects(id),path TEXT,base_commit TEXT,state TEXT,error TEXT,PRIMARY KEY(requirement_id,project_id));
CREATE TABLE requirement_sessions(requirement_id TEXT REFERENCES requirements(id),session_id TEXT,name TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,source TEXT,PRIMARY KEY(requirement_id,session_id));
INSERT INTO projects VALUES('p','Repo','/repo','/repo/.git','repo','now');
INSERT INTO requirements VALUES('q','Task','task','notes','feature','/tasks/task','p','ready','now');
INSERT INTO members VALUES('q','p','/repo','base','ready','');
INSERT INTO requirement_sessions VALUES('q','session','Title','/repo',1,2,'manual');`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	q, err := s.Requirement("q")
	if err != nil || q.Path != "/tasks/task" || len(q.Members) != 1 || q.PrimaryProjectID != "p" {
		t.Fatalf("task %+v %v", q, err)
	}
	pins, err := s.PinnedSessionIDs("q")
	if err != nil || !pins["session"] {
		t.Fatalf("pins %v %v", pins, err)
	}
	var enabled int
	s.DB.QueryRow(`PRAGMA foreign_keys`).Scan(&enabled)
	if enabled != 1 {
		t.Fatal("foreign keys disabled")
	}
	rows, err := s.DB.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	invalid := rows.Next()
	rows.Close()
	if invalid {
		t.Fatal("foreign key graph damaged")
	}
	if _, err := s.DB.Exec(`DELETE FROM members WHERE requirement_id='q';` + repairTaskPrimary + `; DELETE FROM projects WHERE id='p'`); err != nil {
		t.Fatal(err)
	}
	q, err = s.Requirement("q")
	if err != nil || q.PrimaryProjectID != "" {
		t.Fatalf("empty task %+v %v", q, err)
	}
	snapshot, err := ExportMetadata(context.Background(), filepath.Join(dir, "worktree-hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	target, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer target.DB.Close()
	if err := target.ImportMetadata(snapshot); err != nil {
		t.Fatal(err)
	}
	q, err = target.Requirement("q")
	if err != nil || q.PrimaryProjectID != "" || q.Path != "/tasks/task" {
		t.Fatalf("roundtrip %+v %v", q, err)
	}
}

func TestTaskQueriesLoadMembersWithoutScanningUnrelatedTasks(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	_, err = s.DB.Exec(`INSERT INTO projects VALUES('p','Repo','/repo','/repo/.git','repo','now');
INSERT INTO requirements(id,name,slug,description,branch,path,primary_project_id,state,created_at) VALUES('a','A','a','','feature/a','/tasks/a','p','ready','1'),('b','B','b','','feature/b','/tasks/b','p','partial','2');
INSERT INTO members(requirement_id,project_id,path,base_commit,state) VALUES('a','p','/repo/a','base','ready'),('b','p','/repo/b','base','failed');`)
	if err != nil {
		t.Fatal(err)
	}
	q, err := s.Requirement("a")
	if err != nil || q.ID != "a" || len(q.Members) != 1 || q.Members[0].Branch != "feature/a" {
		t.Fatalf("single %+v %v", q, err)
	}
	all, err := s.Requirements()
	if err != nil || len(all) != 2 || all[0].ID != "b" || all[1].Members[0].Path != "/repo/a" {
		t.Fatalf("list %+v %v", all, err)
	}
	if _, err := s.Requirement("missing"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
}
