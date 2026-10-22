package task

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"worktree-hub/internal/model"
	"worktree-hub/internal/workspace"
)

func TestCreateFromMasterAndDiscoverExternalWorktree(t *testing.T) {
	a := testApp(t)
	front := repo(t, "front end", "master")
	back := repo(t, "backend", "master")
	master := testGit(t, front, "rev-parse", "master")
	testGit(t, front, "switch", "-c", "feature/current")
	_ = os.WriteFile(filepath.Join(front, "feature.txt"), []byte("current branch\n"), 0644)
	testGit(t, front, "add", "feature.txt")
	testGit(t, front, "commit", "-m", "feature only")
	external := filepath.Join(t.TempDir(), "external 工作树")
	testGit(t, front, "worktree", "add", "-b", "external", "--", external, "master")
	p1 := register(t, a, "Frontend", front)
	p2 := register(t, a, "Backend", back)
	if code, raw := call(t, a, "POST", "/api/projects", map[string]string{"name": "Same repository", "path": external}); code != 409 {
		t.Fatalf("duplicate repository accepted %d %s", code, raw)
	}
	code, q, raw := create(t, a, p1, []string{p2}, "order-approval")
	if code != 201 || q.State != "ready" {
		t.Fatalf("create %d: %s", code, raw)
	}
	if len(q.Members) != 2 {
		t.Fatalf("members: %+v", q)
	}
	for _, m := range q.Members {
		if m.ProjectID == p1 && testGit(t, m.Path, "rev-parse", "HEAD") != master {
			t.Fatal("worktree not created from master")
		}
		if got := testGit(t, m.Path, "branch", "--show-current"); got != "codex/order-approval" {
			t.Fatalf("wrong branch %s", got)
		}
	}
	if got := testGit(t, front, "branch", "--show-current"); got != "feature/current" {
		t.Fatal("original checkout changed")
	}
	_ = os.WriteFile(filepath.Join(external, "untracked file.txt"), []byte("dirty\n"), 0644)
	code, raw = settledState(t, a)
	if code != 200 {
		t.Fatal(string(raw))
	}
	var snapshot struct {
		Projects     []model.Project     `json:"projects"`
		Requirements []model.Requirement `json:"requirements"`
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatal(err)
	}
	var discovered, linked bool
	for _, p := range snapshot.Projects {
		for _, w := range p.Worktrees {
			if w.Path == external {
				discovered = w.Dirty == 1
			}
			if w.RequirementID == q.ID {
				linked = true
			}
		}
	}
	if !discovered || !linked {
		t.Fatalf("external or linked worktree missing: %s", raw)
	}
	if len(snapshot.Requirements[0].Members) != 2 || snapshot.Requirements[0].Members[0].Worktree == nil {
		t.Fatal("requirement view missing observed worktree")
	}
	if _, err := os.Stat(filepath.Join(q.Path, "BRIEF.md")); err != nil {
		t.Fatal(err)
	}
}

func TestPreflightAllRepositoriesBeforeCreatingAnything(t *testing.T) {
	a := testApp(t)
	good := repo(t, "good", "master")
	bad := repo(t, "main-only", "main")
	p1 := register(t, a, "Good", good)
	p2 := register(t, a, "Main only", bad)
	code, _, raw := create(t, a, p1, []string{p2}, "missing-master")
	if code != 422 || !strings.Contains(string(raw), "master") {
		t.Fatalf("expected missing-master failure: %d %s", code, raw)
	}
	if _, err := os.Stat(filepath.Join(a.Workspace.Root, "missing-master")); !os.IsNotExist(err) {
		t.Fatal("workspace created before full preflight")
	}
	if _, err := workspace.Git(context.Background(), good, "rev-parse", "--verify", "refs/heads/codex/missing-master"); err == nil {
		t.Fatal("branch created despite failed preflight")
	}
	qs, _ := a.Workspace.Store.Requirements()
	if len(qs) != 0 {
		t.Fatal("invalid requirement saved")
	}
}

func TestPathAndBranchConflictsDoNotOverwrite(t *testing.T) {
	a := testApp(t)
	path := repo(t, "project", "master")
	id := register(t, a, "Project", path)
	for _, slug := range []string{"../escape", "../../outside", "x/y", "."} {
		code, _, _ := create(t, a, id, nil, slug)
		if code != 400 {
			t.Fatalf("accepted unsafe slug %q", slug)
		}
	}
	testGit(t, path, "branch", "codex/existing")
	if code, _, raw := create(t, a, id, nil, "existing"); code != 422 {
		t.Fatalf("accepted existing branch %d %s", code, raw)
	}
	reserved := filepath.Join(a.Workspace.Root, "reserved")
	_ = os.Mkdir(reserved, 0755)
	_ = os.WriteFile(filepath.Join(reserved, "keep"), []byte("keep"), 0644)
	if code, _, raw := create(t, a, id, nil, "reserved"); code != 409 {
		t.Fatalf("accepted existing directory %d %s", code, raw)
	}
	if b, err := os.ReadFile(filepath.Join(reserved, "keep")); err != nil || string(b) != "keep" {
		t.Fatal("existing files overwritten")
	}
}

func TestPartialCreationRetryAndRestart(t *testing.T) {
	a := testApp(t)
	front := repo(t, "front", "master")
	back := repo(t, "back", "master")
	p1 := register(t, a, "Front", front)
	p2 := register(t, a, "Back", back)
	hook := filepath.Join(back, ".git", "hooks", "post-checkout")
	_ = os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0755)
	code, q, raw := create(t, a, p1, []string{p2}, "partial")
	if code != 201 || q.State != "partial" {
		t.Fatalf("expected partial: %d %s", code, raw)
	}
	var successful string
	for _, m := range q.Members {
		if m.State == "ready" {
			successful = m.Path
		}
	}
	if successful == "" {
		t.Fatal("successful worktree not preserved")
	}
	_ = os.WriteFile(filepath.Join(successful, "unsaved.txt"), []byte("preserve me"), 0644)
	_ = os.WriteFile(filepath.Join(q.Path, "BRIEF.md"), []byte("User's edited requirement notes"), 0644)
	dataDir, root := a.Workspace.DataDir, a.Workspace.Root
	if err := a.Workspace.Store.DB.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := openApp(dataDir, root)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Workspace.Store.DB.Close()
	_ = os.Remove(hook)
	code, raw = call(t, restarted, "POST", "/api/requirements/"+q.ID+"/retry", nil)
	if code != 200 {
		t.Fatalf("retry %d %s", code, raw)
	}
	if err := json.Unmarshal(raw, &q); err != nil {
		t.Fatal(err)
	}
	if q.State != "ready" {
		t.Fatalf("retry not recovered: %s", raw)
	}
	if b, err := os.ReadFile(filepath.Join(successful, "unsaved.txt")); err != nil || string(b) != "preserve me" {
		t.Fatal("retry touched successful worktree")
	}
	if b, err := os.ReadFile(filepath.Join(q.Path, "BRIEF.md")); err != nil || string(b) != "User's edited requirement notes" {
		t.Fatal("retry overwrote requirement notes")
	}
}
