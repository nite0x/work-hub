package task

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"worktree-hub/internal/store"
)

func TestInterruptedPendingMemberCanRetryAfterRestart(t *testing.T) {
	a := testApp(t)
	id := register(t, a, "Repo", repo(t, "repo", "main"))
	_, q, _ := create(t, a, id, nil, "interrupted-pending")
	_, err := a.Workspace.Store.DB.Exec(`UPDATE requirements SET state='creating' WHERE id=?; UPDATE members SET state='pending',error='' WHERE requirement_id=?`, q.ID, q.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Workspace.Store.DB.Close(); err != nil {
		t.Fatal(err)
	}
	a.Workspace.Store, err = store.Open(a.Workspace.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := a.Workspace.Store.Requirement(q.ID)
	if err != nil || saved.State != "partial" || saved.Members[0].State != "failed" || saved.Members[0].Error == "" {
		t.Fatalf("recovery: %+v %v", saved, err)
	}
	if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/retry", map[string]string{"project_id": id}); code != 200 {
		t.Fatalf("retry %d %s", code, raw)
	}
	saved, _ = a.Workspace.Store.Requirement(q.ID)
	if saved.State != "ready" {
		t.Fatal(saved)
	}
}

func TestEmptyTaskCanDeregisterOldProjectAndChooseNewLaunchDefault(t *testing.T) {
	a := testApp(t)
	first := register(t, a, "First", repo(t, "first", "main"))
	_, q, _ := create(t, a, first, nil, "empty-task")
	if code, raw := call(t, a, "DELETE", "/api/requirements/"+q.ID+"/projects/"+first, nil); code != 200 {
		t.Fatalf("unlink %d %s", code, raw)
	}
	saved, _ := a.Workspace.Store.Requirement(q.ID)
	if saved.PrimaryProjectID != "" || len(saved.Members) != 0 {
		t.Fatal(saved)
	}
	if code, raw := call(t, a, "DELETE", "/api/projects/"+first, nil); code != 200 {
		t.Fatalf("deregister %d %s", code, raw)
	}
	second := register(t, a, "Second", repo(t, "second", "main"))
	if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/projects", map[string]any{"members": []MemberSelection{{ProjectID: second, Mode: "project"}}}); code != 200 {
		t.Fatalf("add %d %s", code, raw)
	}
	saved, _ = a.Workspace.Store.Requirement(q.ID)
	if saved.PrimaryProjectID != second {
		t.Fatal(saved)
	}
	if code, raw := call(t, a, "GET", "/api/requirements/"+q.ID+"/launch", nil); code != 200 {
		t.Fatalf("launch %d %s", code, raw)
	}
}

func TestGeneratedContextTracksChangesAndPreservesNotes(t *testing.T) {
	a := testApp(t)
	id := register(t, a, "Repo", repo(t, "repo", "main"))
	_, q, _ := create(t, a, id, nil, "context")
	brief := filepath.Join(q.Path, "BRIEF.md")
	notes := "handwritten notes\n旧目录仅供历史参考"
	if err := os.WriteFile(brief, []byte(notes), 0600); err != nil {
		t.Fatal(err)
	}
	if code, raw := call(t, a, "PATCH", "/api/requirements/"+q.ID, map[string]string{"name": "新任务目标", "description": "新的完成标准"}); code != 200 {
		t.Fatalf("edit %d %s", code, raw)
	}
	contextFile := filepath.Join(q.Path, "WORK_HUB_CONTEXT.md")
	text, err := os.ReadFile(contextFile)
	if err != nil || !strings.Contains(string(text), "新的完成标准") {
		t.Fatalf("context %s %v", text, err)
	}
	if code, raw := call(t, a, "PUT", "/api/requirements/"+q.ID+"/projects/"+id, MemberSelection{Mode: "project"}); code != 200 {
		t.Fatalf("replace %d %s", code, raw)
	}
	text, _ = os.ReadFile(contextFile)
	if strings.Contains(string(text), q.Members[0].Path) {
		t.Fatal("context retained old checkout", string(text))
	}
	if code, raw := call(t, a, "DELETE", "/api/requirements/"+q.ID+"/projects/"+id, nil); code != 200 {
		t.Fatalf("remove %d %s", code, raw)
	}
	text, _ = os.ReadFile(contextFile)
	if strings.Contains(string(text), "（主项目）") {
		t.Fatal("context retained removed member")
	}
	actual, _ := os.ReadFile(brief)
	if string(actual) != notes {
		t.Fatal("user notes overwritten", string(actual))
	}
}
