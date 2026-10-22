package project

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

func manualWorktree(t *testing.T, a *App, id string, in CreateWorktree) (int, []byte) {
	t.Helper()
	return call(t, a, "POST", "/api/projects/"+id+"/worktrees", in)
}

func TestManualNewWorktreeUsesSelectedRemoteCommitAndKeepsDirtyCheckout(t *testing.T) {
	a := testApp(t)
	seed, remote, clone := remoteClone(t)
	id := register(t, a, "App", clone)
	advanceRemote(t, seed, remote, "remote-new.txt")
	if code, raw := gitAction(t, a, id, GitAction{Action: "fetch", Remote: "origin"}); code != 200 {
		t.Fatalf("fixture fetch failed %d %s", code, raw)
	}
	_ = os.WriteFile(filepath.Join(clone, "README.md"), []byte("keep original edits"), 0644)
	before := testGit(t, clone, "rev-parse", "HEAD")
	code, raw := manualWorktree(t, a, id, CreateWorktree{Slug: "manual-fix", Mode: "new", Source: "refs/remotes/origin/master"})
	if code != 201 {
		t.Fatalf("create failed %d %s", code, raw)
	}
	var result map[string]string
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	v := gitView(t, a, id)
	target := filepath.Join(a.Workspace.Root, "manual-fix", v.Project.Folder)
	if result["path"] != target || result["branch"] != "codex/manual-fix" || result["base_commit"] != testGit(t, seed, "rev-parse", "master") {
		t.Fatalf("incorrect result %s", raw)
	}
	if testGit(t, target, "branch", "--show-current") != "codex/manual-fix" || testGit(t, target, "rev-parse", "HEAD") != result["base_commit"] {
		t.Fatal("new worktree used wrong branch or baseline")
	}
	if testGit(t, clone, "branch", "--show-current") != "codex/wsl-startup" || testGit(t, clone, "rev-parse", "HEAD") != before {
		t.Fatal("original checkout was changed")
	}
	if content, _ := os.ReadFile(filepath.Join(clone, "README.md")); string(content) != "keep original edits" {
		t.Fatal("original edits were overwritten")
	}
	if len(v.Project.Worktrees) != 2 || v.Project.HasMaster {
		t.Fatalf("manual creation should work without local master: %+v", v.Project)
	}
	code, state := settledState(t, a)
	if code != 200 {
		t.Fatal(string(state))
	}
	var snapshot struct {
		Projects     []model.Project     `json:"projects"`
		Requirements []model.Requirement `json:"requirements"`
	}
	if err := json.Unmarshal(state, &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Requirements) != 0 {
		t.Fatal("manual creation unexpectedly created a requirement")
	}
	found := false
	for _, tree := range snapshot.Projects[0].Worktrees {
		if tree.Path == target {
			found = tree.Branch == "codex/manual-fix" && tree.RequirementID == ""
		}
	}
	if !found {
		t.Fatal("manual worktree is not visible as unassociated")
	}
}

func TestManualExistingBranchKeepsUpstreamAndRejectsOccupiedBranch(t *testing.T) {
	a := testApp(t)
	_, _, clone := remoteClone(t)
	id := register(t, a, "App", clone)
	gitAction(t, a, id, GitAction{Action: "fetch", Remote: "origin"})
	if code, raw := gitAction(t, a, id, GitAction{Action: "create_branch", Name: "reuse", Source: "refs/remotes/origin/master", Track: true}); code != 200 {
		t.Fatalf("fixture branch: %d %s", code, raw)
	}
	code, raw := manualWorktree(t, a, id, CreateWorktree{Slug: "existing-fix", Mode: "existing", Branch: "reuse"})
	if code != 201 {
		t.Fatalf("existing branch failed %d %s", code, raw)
	}
	if testGit(t, clone, "rev-parse", "--abbrev-ref", "reuse@{upstream}") != "origin/master" {
		t.Fatal("existing upstream was changed")
	}
	for _, branch := range []string{"reuse", "codex/wsl-startup"} {
		if code, raw := manualWorktree(t, a, id, CreateWorktree{Slug: "occupied", Mode: "existing", Branch: branch}); code != 409 || !strings.Contains(string(raw), "占用") {
			t.Fatalf("occupied branch accepted %d %s", code, raw)
		}
	}
	if _, err := os.Stat(filepath.Join(a.Workspace.Root, "occupied")); !os.IsNotExist(err) {
		t.Fatal("occupied branch rejection created directories")
	}
}

func TestManualWorktreeGroupsProjectsAndRejectsReservedRequirementDirectory(t *testing.T) {
	a := testApp(t)
	front, back := repo(t, "front", "master"), repo(t, "back", "master")
	p1, p2 := register(t, a, "Front", front), register(t, a, "Back", back)
	for _, id := range []string{p1, p2} {
		if code, raw := manualWorktree(t, a, id, CreateWorktree{Slug: "shared-fix", Mode: "new", Source: "refs/heads/master"}); code != 201 {
			t.Fatalf("shared workspace failed %d %s", code, raw)
		}
	}
	entries, err := os.ReadDir(filepath.Join(a.Workspace.Root, "shared-fix"))
	if err != nil || len(entries) != 2 {
		t.Fatal("project worktrees were not grouped under one directory")
	}
	if code, _, raw := create(t, a, p1, nil, "registered-demand"); code != 201 {
		t.Fatalf("fixture requirement failed %d %s", code, raw)
	}
	if code, raw := manualWorktree(t, a, p2, CreateWorktree{Slug: "registered-demand", Mode: "new", Branch: "codex/separate", Source: "refs/heads/master"}); code != 409 || !strings.Contains(string(raw), "已登记任务") {
		t.Fatalf("reserved requirement directory accepted %d %s", code, raw)
	}
	if _, err := workspace.Git(context.Background(), back, "rev-parse", "--verify", "refs/heads/codex/separate"); err == nil {
		t.Fatal("reserved directory rejection created a branch")
	}
}

func TestManualWorktreeRejectsInvalidInputsAndExistingPathsBeforeMutation(t *testing.T) {
	a := testApp(t)
	path := repo(t, "app", "main")
	id := register(t, a, "App", path)
	for _, in := range []CreateWorktree{
		{Slug: "../escape", Mode: "new", Source: "refs/heads/main"},
		{Slug: "valid", Mode: "detached", Source: "refs/heads/main"},
		{Slug: "valid", Mode: "new", Source: "main;touch bad"},
		{Slug: "valid", Mode: "new", Source: "refs/heads/missing"},
		{Slug: "valid", Mode: "new", Source: ""},
		{Slug: "valid", Mode: "new", Branch: "--force", Source: "refs/heads/main"},
		{Slug: "valid", Mode: "new", Branch: "main", Source: "refs/heads/main"},
		{Slug: "valid", Mode: "existing", Branch: "missing"},
	} {
		if code, raw := manualWorktree(t, a, id, in); code == 201 {
			t.Fatalf("invalid input accepted %+v %s", in, raw)
		}
	}
	if entries, err := os.ReadDir(a.Workspace.Root); err != nil || len(entries) != 0 {
		t.Fatal("invalid requests changed workspace root")
	}
	folder := gitView(t, a, id).Project.Folder
	outside := t.TempDir()
	_ = os.Symlink(outside, filepath.Join(a.Workspace.Root, "linked"))
	_ = os.MkdirAll(filepath.Join(a.Workspace.Root, "empty", folder), 0755)
	_ = os.MkdirAll(filepath.Join(a.Workspace.Root, "occupied"), 0755)
	sentinel := filepath.Join(a.Workspace.Root, "occupied", folder)
	_ = os.WriteFile(sentinel, []byte("keep me"), 0644)
	_ = os.MkdirAll(filepath.Join(a.Workspace.Root, "child-link"), 0755)
	_ = os.Symlink(outside, filepath.Join(a.Workspace.Root, "child-link", folder))
	for _, slug := range []string{"linked", "empty", "occupied", "child-link"} {
		if code, raw := manualWorktree(t, a, id, CreateWorktree{Slug: slug, Mode: "new", Source: "refs/heads/main"}); code != 409 {
			t.Fatalf("existing path accepted: %s %d %s", slug, code, raw)
		}
		if _, err := workspace.Git(context.Background(), path, "rev-parse", "--verify", "refs/heads/codex/"+slug); err == nil {
			t.Fatal("path rejection created a branch")
		}
	}
	if content, _ := os.ReadFile(sentinel); string(content) != "keep me" {
		t.Fatal("existing file was overwritten")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatal("symlink escaped workspace root")
	}
	if code, raw := manualWorktree(t, a, id, CreateWorktree{Slug: "explicit-main", Mode: "new", Source: "refs/heads/main"}); code != 201 {
		t.Fatalf("explicit main should work without master %d %s", code, raw)
	}
}

func TestManualWorktreeHookFailurePreservesPartialResults(t *testing.T) {
	a := testApp(t)
	path := repo(t, "app", "master")
	id := register(t, a, "App", path)
	hook := filepath.Join(path, ".git", "hooks", "post-checkout")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nprintf '%s' 'keep hook output' > hook-note.txt\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	code, raw := manualWorktree(t, a, id, CreateWorktree{Slug: "hook-fail", Mode: "new", Source: "refs/heads/master"})
	if code != 409 || !strings.Contains(string(raw), "保留") {
		t.Fatalf("hook failure was not reported %d %s", code, raw)
	}
	v := gitView(t, a, id)
	target := filepath.Join(a.Workspace.Root, "hook-fail", v.Project.Folder)
	if content, _ := os.ReadFile(filepath.Join(target, "hook-note.txt")); string(content) != "keep hook output" {
		t.Fatal("partial hook files were removed")
	}
	if testGit(t, path, "rev-parse", "codex/hook-fail") != testGit(t, path, "rev-parse", "master") || len(v.Project.Worktrees) != 2 {
		t.Fatal("partial branch or worktree registration was removed")
	}
	if code, _ := manualWorktree(t, a, id, CreateWorktree{Slug: "hook-fail", Mode: "new", Source: "refs/heads/master"}); code != 409 {
		t.Fatal("retry overwrote partial worktree")
	}
}
