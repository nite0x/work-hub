package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRequirementWorkspaceStatusAndTerminalTarget(t *testing.T) {
	a := testApp(t)
	front := register(t, a, "Frontend", repo(t, "frontend", "master"))
	backRepo := repo(t, "backend", "master")
	back := register(t, a, "Backend", backRepo)
	code, q, raw := create(t, a, front, []string{back}, "workspace-page")
	if code != 201 || q.State != "ready" {
		t.Fatalf("create: %d %s", code, raw)
	}
	var backPath string
	for _, m := range q.Members {
		if m.ProjectID == back {
			backPath = m.Path
		}
	}
	if err := os.WriteFile(filepath.Join(backPath, "pending.txt"), []byte("change"), 0644); err != nil {
		t.Fatal(err)
	}
	code, raw = settledState(t, a)
	var state struct {
		Requirements []Requirement `json:"requirements"`
	}
	if err := json.Unmarshal(raw, &state); err != nil || code != 200 || len(state.Requirements) != 1 {
		t.Fatalf("state: %d %s %v", code, raw, err)
	}
	for _, m := range state.Requirements[0].Members {
		if m.Worktree == nil || m.Worktree.Path != m.Path || m.Worktree.Branch != q.Branch {
			t.Fatalf("incorrect requirement worktree: %+v", m)
		}
		if m.ProjectID == back && m.Worktree.Dirty != 1 {
			t.Fatalf("backend changes missing: %+v", m.Worktree)
		}
		if m.ProjectID == front && m.Worktree.Dirty != 0 {
			t.Fatalf("changes attributed to wrong project: %+v", m.Worktree)
		}
	}
	var captured LaunchPlan
	launches := 0
	a.launch = func(p LaunchPlan) error { captured = p; launches++; return nil }
	if code, raw := gitAction(t, a, back, GitAction{Action: "terminal", Path: backPath}); code != 200 {
		t.Fatalf("open member terminal: %d %s", code, raw)
	}
	if captured.Cwd != backPath || launches != 1 {
		t.Fatalf("terminal did not target requirement member: %+v", captured)
	}
	if code, _ := gitAction(t, a, front, GitAction{Action: "terminal", Path: backPath}); code != 409 {
		t.Fatalf("accepted worktree belonging to another project: %d", code)
	}
	// Windows cannot delete a directory that the Git process has entered.
	testGit(t, backRepo, "worktree", "remove", "--force", backPath)
	if code, _ := gitAction(t, a, back, GitAction{Action: "terminal", Path: backPath}); code != 409 || launches != 1 {
		t.Fatalf("missing member fell back to another directory: code=%d launches=%d", code, launches)
	}
}
