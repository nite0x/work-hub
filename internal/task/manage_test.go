package task

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"worktree-hub/internal/model"
)

func TestTaskWithoutPrimaryOrWorkspaceCanBeEditedAndPreparedLater(t *testing.T) {
	a := testApp(t)
	path := repo(t, "backend", "main")
	id := register(t, a, "Backend", path)
	code, raw := call(t, a, "POST", "/api/requirements", map[string]any{"name": "订单审批", "description": "原目标", "members": []MemberSelection{{ProjectID: id, Mode: "project"}}})
	var q model.Requirement
	if err := json.Unmarshal(raw, &q); err != nil || code != 201 || q.HasWorkspace || q.State != "ready" {
		t.Fatalf("create %d %s %v", code, raw, err)
	}
	if _, err := os.Stat(q.Path); !os.IsNotExist(err) {
		t.Fatalf("reuse created a task directory: %v", err)
	}
	if q.PrimaryProjectID != id {
		t.Fatal("legacy launch compatibility lost")
	}
	code, raw = call(t, a, "PATCH", "/api/requirements/"+q.ID, map[string]string{"name": "审批与审计", "description": "新目标"})
	if code != 200 {
		t.Fatalf("edit %d %s", code, raw)
	}
	saved, _ := a.Workspace.Store.Requirement(q.ID)
	if saved.Name != "审批与审计" || saved.Description != "新目标" || saved.Path != q.Path || saved.Members[0].Path != q.Members[0].Path {
		t.Fatalf("edit changed working site: %+v", saved)
	}
	other := register(t, a, "Frontend", repo(t, "frontend", "main"))
	code, raw = call(t, a, "POST", "/api/requirements/"+q.ID+"/projects", map[string]any{"members": []MemberSelection{{ProjectID: other, Mode: "new", Branch: "feature/frontend", Source: "refs/heads/main"}}})
	if code != 200 {
		t.Fatalf("add %d %s", code, raw)
	}
	saved, _ = a.Workspace.Store.Requirement(q.ID)
	if !saved.HasWorkspace || saved.State != "ready" || len(saved.Members) != 2 {
		t.Fatalf("not prepared: %+v", saved)
	}
	if _, err := os.Stat(filepath.Join(saved.Path, "BRIEF.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("original checkout lost", err)
	}
}

func TestTaskDirectoryReplacementAndRemovalPreserveEveryCheckout(t *testing.T) {
	a := testApp(t)
	id := register(t, a, "App", repo(t, "app", "main"))
	code, q, raw := create(t, a, id, nil, "change-directory")
	if code != 201 {
		t.Fatalf("%d %s", code, raw)
	}
	old := q.Members[0].Path
	note := filepath.Join(old, "uncommitted.txt")
	if err := os.WriteFile(note, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	endpoint := "/api/requirements/" + q.ID + "/projects/" + id
	code, raw = call(t, a, "PUT", endpoint, MemberSelection{Mode: "project"})
	if code != 200 {
		t.Fatalf("replace %d %s", code, raw)
	}
	saved, _ := a.Workspace.Store.Requirement(q.ID)
	ps, _ := a.Workspace.Store.ProjectMap()
	if saved.Members[0].Path != ps[id].Path || saved.Members[0].Mode != "project" {
		t.Fatal(saved)
	}
	if text, err := os.ReadFile(note); err != nil || string(text) != "keep" {
		t.Fatalf("old checkout altered: %s %v", text, err)
	}
	code, raw = call(t, a, "PUT", endpoint, MemberSelection{Mode: "new", Branch: "feature/replacement", Source: "refs/heads/main"})
	if code != 200 {
		t.Fatalf("new replacement %d %s", code, raw)
	}
	saved, _ = a.Workspace.Store.Requirement(q.ID)
	if saved.State != "ready" || saved.Members[0].Path == old {
		t.Fatal(saved)
	}
	replacement := saved.Members[0].Path
	if code, raw = call(t, a, "DELETE", endpoint, nil); code != 200 {
		t.Fatalf("remove %d %s", code, raw)
	}
	saved, _ = a.Workspace.Store.Requirement(q.ID)
	if len(saved.Members) != 0 {
		t.Fatal("last member was not detached", saved)
	}
	for _, p := range []string{old, ps[id].Path, replacement} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("checkout removed: %s %v", p, err)
		}
	}
	if code, _ = call(t, a, "PUT", endpoint, MemberSelection{Mode: "project"}); code != 404 {
		t.Fatal("replaced an unlinked member", code)
	}
}

func TestTaskReplacementValidatesBeforeChangingTheAssociation(t *testing.T) {
	a := testApp(t)
	id := register(t, a, "App", repo(t, "app", "main"))
	_, q, _ := create(t, a, id, nil, "validate-replacement")
	endpoint := "/api/requirements/" + q.ID + "/projects/" + id
	for _, in := range []MemberSelection{{Mode: "worktree", Path: repo(t, "other", "main")}, {Mode: "new", Branch: "feature/safe", Path: filepath.Join(t.TempDir(), "outside"), Source: "refs/heads/main"}} {
		code, raw := call(t, a, "PUT", endpoint, in)
		if code < 400 {
			t.Fatalf("accepted invalid directory %d %s", code, raw)
		}
		saved, _ := a.Workspace.Store.Requirement(q.ID)
		if saved.Members[0].Path != q.Members[0].Path {
			t.Fatal("invalid selection replaced old site")
		}
	}
	if code, _ := call(t, a, "PATCH", "/api/requirements/"+q.ID, map[string]string{"name": "  "}); code != 400 {
		t.Fatal(code)
	}
}

func TestRetryOnlySelectedProjectAndKeepOtherFailure(t *testing.T) {
	a := testApp(t)
	first := register(t, a, "First", repo(t, "first", "main"))
	second := register(t, a, "Second", repo(t, "second", "main"))
	_, q, _ := create(t, a, first, []string{second}, "retry-one")
	_, err := a.Workspace.Store.DB.Exec(`UPDATE members SET state='failed',error='retry fixture' WHERE requirement_id=?; UPDATE requirements SET state='partial' WHERE id=?`, q.ID, q.ID)
	if err != nil {
		t.Fatal(err)
	}
	code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/retry", map[string]string{"project_id": first})
	if code != 200 {
		t.Fatalf("retry %d %s", code, raw)
	}
	saved, _ := a.Workspace.Store.Requirement(q.ID)
	for _, m := range saved.Members {
		if m.ProjectID == first && m.State != "ready" || m.ProjectID == second && m.State != "failed" {
			t.Fatal(saved)
		}
	}
	if saved.State != "partial" {
		t.Fatal(saved)
	}
}
