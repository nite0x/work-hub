package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestMetadataSnapshotPreservesPathsAndImportsTransactionally(t *testing.T) {
	source := testApp(t)
	_, err := source.db.Exec(`INSERT INTO projects VALUES('p','Project','/original/repo','/original/repo/.git','project','now');
INSERT INTO requirements VALUES('r','Task','task','notes','codex/task','/saved/workspace/task','p','creating','now');
INSERT INTO members VALUES('r','p','/saved/workspace/task/project','baseline','creating','');
INSERT INTO settings VALUES('terminal','{"kind":"windows-terminal"}');
INSERT INTO requirement_sessions VALUES('r','session','Title','/saved/workspace/task/project',123,456,'manual')`)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := exportMetadata(context.Background(), filepath.Join(source.dataDir, "worktree-hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	// Round trip through JSON, as the actual WSL transport does.
	raw, _ := json.Marshal(snapshot)
	var transferred metadataSnapshot
	if err := json.Unmarshal(raw, &transferred); err != nil {
		t.Fatal(err)
	}
	target := testApp(t)
	if err := target.importMetadata(transferred); err != nil {
		t.Fatal(err)
	}
	q, err := target.requirement("r")
	if err != nil {
		t.Fatal(err)
	}
	if q.Path != "/saved/workspace/task" || q.State != "partial" || len(q.Members) != 1 || q.Members[0].State != "failed" {
		t.Fatalf("import changed workspace or lost interrupted operation: %+v", q)
	}
	sessions, err := target.storedSessions("r")
	if err != nil || len(sessions) != 1 || sessions[0].UpdatedAt != 456 {
		t.Fatalf("sessions: %+v %v", sessions, err)
	}
	if err := target.importMetadata(transferred); err == nil {
		t.Fatal("import overwrote an existing environment")
	}
	var state string
	if err := source.db.QueryRow("SELECT state FROM requirements WHERE id='r'").Scan(&state); err != nil || state != "creating" {
		t.Fatalf("source database modified: %s %v", state, err)
	}
	broken := testApp(t)
	transferred.Tables["members"][0] = []any{"invalid"}
	if err := broken.importMetadata(transferred); err == nil {
		t.Fatal("invalid import succeeded")
	}
	var count int
	if err := broken.db.QueryRow("SELECT count(*) FROM projects").Scan(&count); err != nil || count != 0 {
		t.Fatal("failed import left partial metadata")
	}
}
