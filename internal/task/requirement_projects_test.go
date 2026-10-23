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

func addTaskProjects(t *testing.T, a *App, id string, ids ...string) (int, model.Requirement, []byte) {
	t.Helper()
	code, raw := call(t, a, "POST", "/api/requirements/"+id+"/projects", map[string]any{"project_ids": ids})
	var q model.Requirement
	_ = json.Unmarshal(raw, &q)
	return code, q, raw
}

func TestAddTaskProjectsUsesSavedWorkspaceAndPreservesExistingWork(t *testing.T) {
	a := testApp(t)
	primary := register(t, a, "Primary", repo(t, "primary", "master"))
	code, q, raw := create(t, a, primary, nil, "add-projects")
	if code != 201 || q.State != "ready" {
		t.Fatalf("create: %d %s", code, raw)
	}
	original := q.Members[0]
	dirty := filepath.Join(original.Path, "unsaved.txt")
	_ = os.WriteFile(dirty, []byte("unfinished work"), 0644)
	notes := "# My task notes\nKeep this text exactly.\n"
	_ = os.WriteFile(filepath.Join(q.Path, "BRIEF.md"), []byte(notes), 0644)
	backend := repo(t, "backend", "master")
	base := testGit(t, backend, "rev-parse", "master")
	testGit(t, backend, "switch", "-c", "feature/current")
	_ = os.WriteFile(filepath.Join(backend, "feature.txt"), []byte("feature"), 0644)
	testGit(t, backend, "add", ".")
	testGit(t, backend, "commit", "-m", "feature")
	added := register(t, a, "Backend", backend)
	// Changing the configured root must not move or split the existing task.
	a.Workspace.Root = t.TempDir()
	code, result, raw := addTaskProjects(t, a, q.ID, added, added)
	if code != 200 || result.State != "ready" || len(result.Members) != 2 || result.PrimaryProjectID != primary || result.Path != q.Path {
		t.Fatalf("add: %d %s", code, raw)
	}
	path := filepath.Join(q.Path, "backend")
	if testGit(t, path, "rev-parse", "HEAD") != base || testGit(t, path, "branch", "--show-current") != q.Branch {
		t.Fatal("new worktree did not use task branch and local master")
	}
	if testGit(t, backend, "branch", "--show-current") != "feature/current" {
		t.Fatal("changed original checkout")
	}
	if content, _ := os.ReadFile(dirty); string(content) != "unfinished work" {
		t.Fatal("existing work was changed")
	}
	brief, _ := os.ReadFile(filepath.Join(q.Path, "BRIEF.md"))
	if !strings.HasPrefix(string(brief), notes) || !strings.Contains(string(brief), path) {
		t.Fatalf("notes or new project missing: %s", brief)
	}
	code, raw = settledState(t, a)
	var snapshot struct {
		Requirements []model.Requirement `json:"requirements"`
	}
	_ = json.Unmarshal(raw, &snapshot)
	if code != 200 || len(snapshot.Requirements[0].Members) != 2 {
		t.Fatalf("added project not persisted: %d %s", code, raw)
	}
	for _, m := range snapshot.Requirements[0].Members {
		if m.Worktree == nil || m.Worktree.RequirementID != q.ID {
			t.Fatalf("added worktree not linked in state: %+v", m)
		}
	}
	code, raw = call(t, a, "GET", "/api/requirements/"+q.ID+"/launch", nil)
	var plan model.LaunchPlan
	_ = json.Unmarshal(raw, &plan)
	if code != 200 || !strings.Contains(strings.Join(plan.Args, " "), path) {
		t.Fatalf("new project missing from Codex launch: %d %s", code, raw)
	}
}

func TestAddTaskProjectsPreflightsWholeBatch(t *testing.T) {
	for _, conflict := range []string{"branch", "directory", "symlink", "brief symlink"} {
		t.Run(conflict, func(t *testing.T) {
			a := testApp(t)
			primary := register(t, a, "Primary", repo(t, "primary", "master"))
			_, q, _ := create(t, a, primary, nil, "preflight-add")
			goodPath := repo(t, "good", "master")
			good := register(t, a, "Good", goodPath)
			badPath := repo(t, "bad", "main")
			bad := register(t, a, "Bad", badPath)
			destination := filepath.Join(q.Path, "bad")
			switch conflict {
			case "branch":
				testGit(t, badPath, "branch", q.Branch)
			case "directory":
				_ = os.Mkdir(destination, 0755)
				_ = os.WriteFile(filepath.Join(destination, "keep.txt"), []byte("keep"), 0644)
			case "symlink":
				_ = os.Symlink(t.TempDir(), destination)
			case "brief symlink":
				_ = os.Remove(filepath.Join(q.Path, "BRIEF.md"))
				target := filepath.Join(t.TempDir(), "notes")
				_ = os.WriteFile(target, []byte("keep"), 0644)
				_ = os.Symlink(target, filepath.Join(q.Path, "BRIEF.md"))
			}
			code, _, raw := addTaskProjects(t, a, q.ID, good, bad)
			if code != 422 {
				t.Fatalf("accepted conflict: %d %s", code, raw)
			}
			stored, _ := a.Workspace.Store.Requirement(q.ID)
			if len(stored.Members) != 1 || stored.State != "ready" {
				t.Fatalf("failed batch changed task: %+v", stored)
			}
			if _, err := workspace.Git(context.Background(), goodPath, "rev-parse", "--verify", "refs/heads/"+q.Branch); err == nil {
				t.Fatal("created good branch despite batch failure")
			}
			if _, err := os.Stat(filepath.Join(q.Path, "good")); !os.IsNotExist(err) {
				t.Fatal("created worktree despite batch failure")
			}
		})
	}
}

func TestAddTaskProjectsRejectsInvalidRequests(t *testing.T) {
	a := testApp(t)
	primary := register(t, a, "Primary", repo(t, "primary", "master"))
	_, q, _ := create(t, a, primary, nil, "invalid-add")
	for _, tc := range []struct {
		id   string
		ids  []string
		want int
	}{{q.ID, nil, 400}, {q.ID, []string{"unknown"}, 400}, {q.ID, []string{primary}, 409}, {"unknown", []string{primary}, 404}} {
		if code, _, raw := addTaskProjects(t, a, tc.id, tc.ids...); code != tc.want {
			t.Fatalf("invalid request: got %d want %d: %s", code, tc.want, raw)
		}
	}
	other := register(t, a, "Other", repo(t, "other", "master"))
	_, _ = a.Workspace.Store.DB.Exec(`UPDATE requirements SET state='archived' WHERE id=?`, q.ID)
	if code, _, raw := addTaskProjects(t, a, q.ID, other); code != 409 {
		t.Fatalf("added to archived task: %d %s", code, raw)
	}
	_, _ = a.Workspace.Store.DB.Exec(`UPDATE requirements SET state='ready' WHERE id=?`, q.ID)
	originalPath := q.Path + "-moved"
	if err := os.Rename(q.Path, originalPath); err != nil {
		t.Fatal(err)
	}
	if code, _, raw := addTaskProjects(t, a, q.ID, other); code != 422 {
		t.Fatalf("accepted missing workspace: %d %s", code, raw)
	}
}

func TestAddTaskProjectsFailureCanRetryWithoutTouchingExistingFailures(t *testing.T) {
	a := testApp(t)
	primary := register(t, a, "Primary", repo(t, "primary", "master"))
	_, q, _ := create(t, a, primary, nil, "retry-add")
	_, _ = a.Workspace.Store.DB.Exec(`UPDATE members SET state='failed',error='existing failure' WHERE requirement_id=?`, q.ID)
	_, _ = a.Workspace.Store.DB.Exec(`UPDATE requirements SET state='partial' WHERE id=?`, q.ID)
	newPath := repo(t, "new", "master")
	newProjectID := register(t, a, "New", newPath)
	hook := filepath.Join(newPath, ".git", "hooks", "post-checkout")
	_ = os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0755)
	code, result, raw := addTaskProjects(t, a, q.ID, newProjectID)
	if code != 200 || result.State != "partial" || len(result.Members) != 2 {
		t.Fatalf("failed addition not retained: %d %s", code, raw)
	}
	for _, m := range result.Members {
		if m.State != "failed" || (m.ProjectID == primary && m.Error != "existing failure") {
			t.Fatalf("addition retried old failure or missed new failure: %+v", m)
		}
	}
	_ = os.Remove(hook)
	code, raw = call(t, a, "POST", "/api/requirements/"+q.ID+"/retry", nil)
	_ = json.Unmarshal(raw, &result)
	if code != 200 || result.State != "ready" || len(result.Members) != 2 {
		t.Fatalf("retry addition: %d %s", code, raw)
	}
}
