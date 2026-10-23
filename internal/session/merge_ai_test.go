package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"worktree-hub/internal/model"
	"worktree-hub/internal/workspace"
)

func conflictForAI(t *testing.T, a *App, q model.Requirement) string {
	t.Helper()
	path := q.Members[0].Path
	ps, _ := a.Workspace.Store.ProjectMap()
	root := ps[q.PrimaryProjectID].Path
	testGit(t, root, "switch", "-c", "source")
	_ = os.WriteFile(filepath.Join(root, "README.md"), []byte("source\n"), 0644)
	testGit(t, root, "add", "README.md")
	testGit(t, root, "commit", "-m", "source")
	_ = os.WriteFile(filepath.Join(path, "README.md"), []byte("target\n"), 0644)
	testGit(t, path, "add", "README.md")
	testGit(t, path, "commit", "-m", "target")
	if _, err := workspace.Git(context.Background(), path, "merge", "source"); err == nil {
		t.Fatal("expected conflict")
	}
	return testGit(t, path, "rev-parse", "MERGE_HEAD")
}

func TestMergeAIStartsScopedSidebarWithServerGeneratedContext(t *testing.T) {
	a, q, c, _ := chatFixture(t)
	head := conflictForAI(t, a, q)
	plan, prompt, err := a.mergeConflictPlan(context.Background(), q.ID, q.PrimaryProjectID, head)
	if err != nil || plan.Cwd != q.Members[0].Path || len(plan.AdditionalDirectories) != 0 || !strings.Contains(prompt, "README.md") || !strings.Contains(prompt, head) || !strings.Contains(prompt, "不要推送") {
		t.Fatalf("%+v %s %v", plan, prompt, err)
	}
	input := map[string]string{"purpose": "merge_conflict", "project_id": q.PrimaryProjectID, "merge_head": head, "request_id": "merge-sidebar"}
	endpoint := "/api/requirements/" + q.ID + "/sessions/new"
	if code, raw := call(t, a, "POST", endpoint, input); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
	c.mu.Lock()
	params := c.startParams
	c.mu.Unlock()
	if params["cwd"] != q.Members[0].Path || !strings.Contains(params["input"].([]any)[0].(map[string]any)["text"].(string), head) {
		t.Fatal(params)
	}
	if code, _ := call(t, a, "POST", endpoint, input); code != 200 {
		t.Fatal("retry duplicated or failed")
	}
	c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
}

func TestReadOnlyMergeAIOpensCorrectTerminalOnce(t *testing.T) {
	a, q, _, _ := chatFixture(t)
	head := conflictForAI(t, a, q)
	a.Workspace.ReadOnlySessions = true
	var plan model.LaunchPlan
	launches := 0
	a.Workspace.Launch = func(p model.LaunchPlan, _ func()) error { plan = p; launches++; return nil }
	input := map[string]string{"project_id": q.PrimaryProjectID, "merge_head": head, "request_id": "merge-terminal"}
	endpoint := "/api/requirements/" + q.ID + "/merge-ai"
	for range 2 {
		if code, raw := call(t, a, "POST", endpoint, input); code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
	}
	if launches != 1 || plan.Cwd != q.Members[0].Path || !strings.Contains(plan.Args[len(plan.Args)-1], head) {
		t.Fatal(plan, launches)
	}
	input["request_id"], input["project_id"] = "foreign", "foreign"
	if code, _ := call(t, a, "POST", endpoint, input); code != 409 || launches != 1 {
		t.Fatal("foreign project launched")
	}
	input["project_id"], input["merge_head"] = q.PrimaryProjectID, "stale"
	if code, _ := call(t, a, "POST", endpoint, input); code != 409 || launches != 1 {
		t.Fatal("stale merge launched")
	}
}
