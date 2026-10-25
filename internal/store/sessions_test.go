package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"worktree-hub/internal/model"
)

func TestSessionTitlesPreserveManualNamesAgainstStaleReads(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	if err := s.SaveSession(model.Session{ID: "thread", Cwd: "/repo", Name: "初始标题", TitleSource: "initial"}); err != nil {
		t.Fatal(err)
	}
	staleRead := time.Now().UnixNano()
	if err := s.SetSessionTitle("thread", "手动名称", "manual"); err != nil {
		t.Fatal(err)
	}
	manual, _ := s.Session("thread")
	if err := s.SaveSession(model.Session{ID: "thread", Cwd: "/repo", Name: "初始标题"}, staleRead); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveSession(model.Session{ID: "thread", Cwd: "/repo"}); err != nil {
		t.Fatal(err)
	}
	if updated, err := s.ObserveSessionTitle("thread", "初始标题"); err != nil || updated {
		current, _ := s.Session("thread")
		t.Fatalf("delayed notification replaced manual title: %v %v stale=%d manual=%+v current=%+v", updated, err, staleRead, manual, current)
	}
	if updated, err := s.ObserveSessionTitle("thread", "手动名称"); err != nil || !updated {
		t.Fatal(updated, err)
	}
	v, _ := s.Session("thread")
	if v.Name != "手动名称" || v.TitleSource != "manual" {
		t.Fatal(v)
	}
	// A later explicit rename from another Codex client must still synchronize.
	if err := s.SaveSession(model.Session{ID: "thread", Cwd: "/repo", Name: "Codex 中的新名称"}, v.TitleChangedAt+1); err != nil {
		t.Fatal(err)
	}
	v, _ = s.Session("thread")
	if v.Name != "Codex 中的新名称" || v.TitleSource != "codex" {
		t.Fatal(v)
	}
}

func TestSessionTitleProvenanceSurvivesBackupAndOldSnapshotImport(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	if err := s.SaveSession(model.Session{ID: "thread", Cwd: "/repo"}); err != nil {
		t.Fatal(err)
	}
	v, _ := s.Session("thread")
	if v.Name != "" || v.TitleSource != "" {
		t.Fatal("empty title was materialized", v)
	}
	if err := s.SetSessionTitle("thread", "用户名称", "manual"); err != nil {
		t.Fatal(err)
	}
	snapshot, err := ExportMetadata(context.Background(), filepath.Join(dir, "worktree-hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, legacy := range []bool{false, true} {
		target, err := Open(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		if legacy {
			snapshot.Tables["sessions"][0] = snapshot.Tables["sessions"][0][:8]
		}
		if err := target.ImportMetadata(snapshot); err != nil {
			t.Fatal(err)
		}
		v, _ := target.Session("thread")
		want := "manual"
		if legacy {
			want = "legacy"
		}
		if v.Name != "用户名称" || v.TitleSource != want {
			t.Fatal(v)
		}
		target.DB.Close()
	}
}

func TestOldSessionTitleMigrationPreservesAmbiguousPlaceholder(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec(`ALTER TABLE sessions DROP COLUMN title_source;
ALTER TABLE sessions DROP COLUMN title_changed_at;
INSERT INTO sessions(id,name,cwd,created_at,updated_at,source) VALUES('legacy','未命名对话','/repo',1,1,'workbench');`)
	if err != nil {
		t.Fatal(err)
	}
	// Exporting an old database is read-only and also preserves its provenance.
	snapshot, err := ExportMetadata(context.Background(), filepath.Join(dir, "worktree-hub.db"))
	if err != nil || snapshot.Tables["sessions"][0][8] != "legacy" {
		t.Fatal(snapshot, err)
	}
	s.DB.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	v, err := s.Session("legacy")
	if err != nil || v.Name != "未命名对话" || v.TitleSource != "legacy" {
		t.Fatal(v, err)
	}
}

func TestSessionMigrationSeparatesDiscoveryFromManualPins(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec(`INSERT INTO projects VALUES('p','Repo','/repo','/repo/.git','repo','now');
INSERT INTO requirements(id,name,slug,description,branch,path,primary_project_id,state,created_at) VALUES('a','A','a','','','/tasks/a','p','ready','now'),('b','B','b','','','/tasks/b','p','ready','now');
INSERT INTO requirement_sessions VALUES('a','shared','Older','/repo',1,10,'workspace'),('b','shared','Newest','/repo',1,20,'workspace'),('a','outside','Manual','/outside',2,30,'manual');
INSERT INTO session_create_requests VALUES('a','uncertain',''),('b','finished','shared');
DELETE FROM schema_migrations WHERE version='sessions_index_v1';`)
	if err != nil {
		t.Fatal(err)
	}
	s.DB.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	all, err := s.Sessions()
	if err != nil || len(all) != 2 {
		t.Fatalf("index: %+v %v", all, err)
	}
	shared, err := s.Session("shared")
	if err != nil || shared.Name != "Newest" {
		t.Fatalf("latest metadata: %+v %v", shared, err)
	}
	pins, err := s.PinnedSessionIDs("a")
	if err != nil || len(pins) != 1 || !pins["outside"] {
		t.Fatalf("pins: %+v %v", pins, err)
	}
	var pending string
	if err := s.DB.QueryRow(`SELECT session_id FROM conversation_create_requests WHERE request_id='task:a:uncertain'`).Scan(&pending); err != nil || pending != "" {
		t.Fatalf("pending reservation lost: %q %v", pending, err)
	}
	if _, err := s.DB.Exec(`UPDATE sessions SET name='Refreshed' WHERE id='shared'`); err != nil {
		t.Fatal(err)
	}
	if err := s.migrateSessions(); err != nil {
		t.Fatal(err)
	}
	shared, _ = s.Session("shared")
	if shared.Name != "Refreshed" {
		t.Fatal("migration replayed stale legacy metadata")
	}
}

func TestStandaloneSessionsSurviveMetadataTransferAndRemainEnvironmentLocal(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	if err := s.SaveSession(model.Session{ID: "thread", Name: "Standalone", Cwd: "/repo/../repo", Source: "workbench", UpdatedAt: 20}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveSessionDirectories("thread", []string{"/extra"}); err != nil {
		t.Fatal(err)
	}
	// Discovery refreshes metadata without erasing the creation-time directory set.
	if err := s.SaveSession(model.Session{ID: "thread", Name: "Updated", Cwd: "/repo", Source: "workspace", UpdatedAt: 30}); err != nil {
		t.Fatal(err)
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
	v, err := target.Session("thread")
	if err != nil || v.Name != "Updated" || v.Cwd != "/repo" || v.Source != "workbench" || len(v.AdditionalDirectories) != 1 || v.AdditionalDirectories[0] != "/extra" {
		t.Fatalf("round trip: %+v %v", v, err)
	}
	if err := target.SaveSession(model.Session{ID: "thread", Name: "Other environment", Cwd: "/other", Source: "codex"}); err != nil {
		t.Fatal(err)
	}
	original, _ := s.Session("thread")
	if original.Cwd != "/repo" {
		t.Fatal("another environment changed the original session")
	}
}

func TestConversationOrganizationAndDraftsSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SaveSession(model.Session{ID: "thread", Cwd: "/repo", Name: "Name"}); err != nil {
		t.Fatal(err)
	}
	if err := s.OrganizeSession("thread", true, true); err != nil {
		t.Fatal(err)
	}
	if err := s.ObserveSessionArchive("thread", false, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`INSERT INTO conversation_drafts(key,payload,updated_at) VALUES('draft','{"text":"keep"}',1)`); err != nil {
		t.Fatal(err)
	}
	s.DB.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	record, err := s.Session("thread")
	if err != nil || !record.Pinned || !record.Archived {
		t.Fatal(record, err)
	}
	snapshot, err := ExportMetadata(context.Background(), filepath.Join(dir, "worktree-hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Tables["conversation_drafts"]) != 1 || len(snapshot.Tables["session_organization"]) != 1 {
		t.Fatal("draft/organization missing from backup")
	}
}
