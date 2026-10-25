package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestLegacyMembersMigrationAndMetadataPreserveTaskScope(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "worktree-hub.db")
	db, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT,path TEXT,common_dir TEXT,folder TEXT,created_at TEXT);
CREATE TABLE requirements (id TEXT PRIMARY KEY,name TEXT,slug TEXT,description TEXT,branch TEXT,path TEXT,primary_project_id TEXT,state TEXT,created_at TEXT);
CREATE TABLE members (requirement_id TEXT,project_id TEXT,path TEXT NOT NULL UNIQUE,base_commit TEXT,state TEXT,error TEXT,PRIMARY KEY(requirement_id,project_id));
INSERT INTO projects VALUES('p','Repo','/repo','/repo/.git','repo','now');
INSERT INTO requirements(id,name,slug,description,branch,path,primary_project_id,state,created_at) VALUES('r','Task','task','notes','feature/task','/workspace/task','p','ready','now');
INSERT INTO members VALUES('r','p','/workspace/task/repo','baseline','ready','');`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	// An offline environment's old database can be read/exported without mutation.
	readonly, err := OpenReadOnly(dir)
	if err != nil {
		t.Fatal(err)
	}
	q, err := readonly.Requirement("r")
	readonly.DB.Close()
	if err != nil || q.Members[0].Mode != "new" || q.Members[0].Branch != "feature/task" {
		t.Fatalf("legacy read: %+v %v", q, err)
	}
	snapshot, err := ExportMetadata(context.Background(), file)
	if err != nil {
		t.Fatal(err)
	}
	target, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer target.DB.Close()
	snapshot.Tables["members"][0] = snapshot.Tables["members"][0][:6] // Older exporters sent six fields.
	if err := target.ImportMetadata(snapshot); err != nil {
		t.Fatal(err)
	}
	q, err = target.Requirement("r")
	if err != nil || q.Members[0].BaseRef != "refs/heads/master" || q.Members[0].BaseCommit != "baseline" {
		t.Fatalf("legacy import: %+v %v", q, err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	q, err = s.Requirement("r")
	if err != nil || q.Members[0].Branch != "feature/task" || q.Path != "/workspace/task" {
		t.Fatalf("migration: %+v %v", q, err)
	}
	_, err = s.DB.Exec(`INSERT INTO requirements(id,name,slug,description,branch,path,primary_project_id,state,created_at) VALUES('r2','Other','other','notes','','/workspace/other','p','ready','now');
INSERT INTO members(requirement_id,project_id,path,base_commit,state,mode,base_ref,branch) VALUES('r2','p','/workspace/task/repo','baseline','ready','worktree','','feature/task');`)
	if err != nil {
		t.Fatalf("migrated worktree cannot be reused: %v", err)
	}
	snapshot, err = ExportMetadata(context.Background(), file)
	if err != nil {
		t.Fatal(err)
	}
	target2, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer target2.DB.Close()
	if err := target2.ImportMetadata(snapshot); err != nil {
		t.Fatal(err)
	}
	q, err = target2.Requirement("r2")
	if err != nil || q.Members[0].Mode != "worktree" || q.Members[0].Branch != "feature/task" {
		t.Fatalf("new metadata lost selection: %+v %v", q, err)
	}
}

func TestTaskWorkspacePresenceSurvivesMetadataTransfer(t *testing.T) {
	source, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer source.DB.Close()
	_, err = source.DB.Exec(`INSERT INTO projects(id,name,path,common_dir,folder,created_at) VALUES('p','Repo','/repo','/repo/.git','repo','now');
 INSERT INTO requirements(id,name,slug,description,branch,path,primary_project_id,state,created_at,has_workspace) VALUES('task','Task','task','','','/reserved/task','p','ready','now',0);`)
	if err != nil {
		t.Fatal(err)
	}
	var file string
	if err := source.DB.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&file); err != nil {
		t.Fatal(err)
	}
	snapshot, err := ExportMetadata(context.Background(), file)
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
	q, err := target.Requirement("task")
	if err != nil || q.HasWorkspace || q.Path != "/reserved/task" {
		t.Fatalf("workspace-free task changed: %+v %v", q, err)
	}
	legacy, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.DB.Close()
	snapshot.Tables["requirements"][0] = snapshot.Tables["requirements"][0][:9]
	if err := legacy.ImportMetadata(snapshot); err != nil {
		t.Fatal(err)
	}
	q, err = legacy.Requirement("task")
	if err != nil || !q.HasWorkspace {
		t.Fatalf("legacy task lost its workspace: %+v %v", q, err)
	}
}
