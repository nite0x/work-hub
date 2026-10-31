package task

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"worktree-hub/internal/model"
	"worktree-hub/internal/testutil"
)

func createSelected(t *testing.T, a *App, slug, primary string, selections ...MemberSelection) (int, model.Requirement, []byte) {
	t.Helper()
	code, raw := call(t, a, "POST", "/api/requirements", CreateRequirement{Name: slug, Slug: slug, PrimaryProjectID: primary, Members: selections})
	var q model.Requirement
	if code == 201 {
		if err := json.Unmarshal(raw, &q); err != nil {
			t.Fatal(err)
		}
	}
	return code, q, raw
}

func TestTaskBranchSourcesDefaultAndExplicit(t *testing.T) {
	for _, initial := range []string{"master", "main", "develop"} {
		t.Run(initial, func(t *testing.T) {
			a := testApp(t)
			path := repo(t, "repo", initial)
			base := testGit(t, path, "rev-parse", "HEAD")
			id := register(t, a, "Repo", path)
			testGit(t, path, "switch", "-c", "feature/source")
			if err := os.WriteFile(filepath.Join(path, "feature.txt"), []byte("feature"), 0644); err != nil {
				t.Fatal(err)
			}
			testGit(t, path, "add", ".")
			testGit(t, path, "commit", "-m", "feature")
			feature := testGit(t, path, "rev-parse", "HEAD")
			code, q, raw := createSelected(t, a, "default", id, MemberSelection{ProjectID: id, Mode: "new"})
			if code != 201 || q.State != "ready" {
				t.Fatalf("default: %d %s", code, raw)
			}
			want, ref := base, "refs/heads/"+initial
			if initial == "develop" {
				want, ref = feature, "HEAD"
			}
			if q.Members[0].BaseRef != ref || testGit(t, q.Members[0].Path, "rev-parse", "HEAD") != want {
				t.Fatalf("wrong default: %+v", q.Members[0])
			}
			code, q, raw = createSelected(t, a, "explicit", id, MemberSelection{ProjectID: id, Mode: "new", Branch: "custom/task", Source: "refs/heads/feature/source"})
			if code != 201 || q.State != "ready" || q.Members[0].BaseCommit != feature || q.Members[0].Branch != "custom/task" {
				t.Fatalf("explicit: %d %s", code, raw)
			}
			if _, err := a.MakeLaunchPlan(context.Background(), q.ID); err != nil {
				t.Fatal(err)
			}
			brief, _ := os.ReadFile(filepath.Join(q.Path, "BRIEF.md"))
			if !strings.Contains(string(brief), "refs/heads/feature/source") || !strings.Contains(string(brief), "custom/task") {
				t.Fatalf("incorrect brief: %s", brief)
			}
		})
	}
}

func TestTaskReusesDirectoriesAcrossTasksAndAddsMixedMembers(t *testing.T) {
	a := testApp(t)
	path := repo(t, "repo", "main")
	id := register(t, a, "Repo", path)
	external := filepath.Join(testutil.TempDir(t), "已有 worktree")
	testGit(t, path, "worktree", "add", "-b", "existing", "--", external)
	dirty := filepath.Join(external, "keep.txt")
	if err := os.WriteFile(dirty, []byte("unsaved"), 0644); err != nil {
		t.Fatal(err)
	}
	before := testGit(t, path, "for-each-ref", "--format=%(refname)")
	var q model.Requirement
	for _, slug := range []string{"reuse-first", "reuse-second"} {
		code, result, raw := createSelected(t, a, slug, id, MemberSelection{ProjectID: id, Mode: "worktree", Path: external})
		if code != 201 || result.State != "ready" || result.Branch != "" || result.Members[0].Path != external {
			t.Fatalf("reuse: %d %s", code, raw)
		}
		q = result
	}
	if got := testGit(t, path, "for-each-ref", "--format=%(refname)"); got != before {
		t.Fatal("reuse created branches")
	}
	// Branch changes and detached HEAD in reused workspaces are valid work, not task drift.
	testGit(t, external, "switch", "--detach")
	plan, err := a.MakeLaunchPlan(context.Background(), q.ID)
	if err != nil || plan.Cwd != external {
		t.Fatalf("launch: %+v %v", plan, err)
	}
	original := repo(t, "original", "develop")
	originalID := register(t, a, "Original", original)
	newPath := repo(t, "new", "main")
	newID := register(t, a, "New", newPath)
	code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/projects", map[string]any{"members": []MemberSelection{
		{ProjectID: originalID, Mode: "project"},
		{ProjectID: newID, Mode: "new", Source: "refs/heads/main", Branch: "feature/added"},
	}})
	if code != 200 {
		t.Fatalf("add: %d %s", code, raw)
	}
	stored, err := a.Workspace.Store.Requirement(q.ID)
	if err != nil || stored.State != "ready" || len(stored.Members) != 3 {
		t.Fatalf("stored: %+v %v", stored, err)
	}
	plan, err = a.MakeLaunchPlan(context.Background(), q.ID)
	if err != nil || len(plan.AdditionalDirectories) != 2 {
		t.Fatalf("mixed launch: %+v %v", plan, err)
	}
	if got, _ := os.ReadFile(dirty); string(got) != "unsaved" {
		t.Fatal("reused directory modified")
	}
	if testGit(t, original, "branch", "--show-current") != "develop" {
		t.Fatal("original checkout changed")
	}
	if _, err := os.Stat(filepath.Join(q.Path, "original")); !os.IsNotExist(err) {
		t.Fatal("created worktree for reused project")
	}
	// Reload from disk, preserving choices and launch behavior.
	restarted, err := openApp(a.Workspace.DataDir, a.Workspace.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Workspace.Close()
	defer restarted.Projects.Close()
	if _, err := restarted.MakeLaunchPlan(context.Background(), q.ID); err != nil {
		t.Fatal(err)
	}
}

func TestTaskSelectionRejectsOtherRepositoriesAndInvalidSourceBeforeMutation(t *testing.T) {
	a := testApp(t)
	path := repo(t, "repo", "main")
	id := register(t, a, "Repo", path)
	other := repo(t, "other", "main")
	for i, selection := range []MemberSelection{
		{ProjectID: id, Mode: "worktree", Path: other},
		{ProjectID: id, Mode: "worktree", Path: filepath.Join(path, ".git")},
		{ProjectID: id, Mode: "new", Source: "refs/heads/missing"},
		{ProjectID: id, Mode: "new", Source: "HEAD~1"},
		{ProjectID: id, Mode: "unknown"},
	} {
		slug := []string{"foreign", "subdir", "missing", "expression", "unknown"}[i]
		code, _, raw := createSelected(t, a, slug, id, selection)
		if code != 422 {
			t.Fatalf("accepted invalid selection: %d %s", code, raw)
		}
		if _, err := os.Stat(filepath.Join(a.Workspace.Root, slug)); !os.IsNotExist(err) {
			t.Fatal("created workspace before validation")
		}
	}
}

func TestReusedWorktreeStoresCanonicalPathAndRejectsLinkedEntry(t *testing.T) {
	a := testApp(t)
	path := repo(t, "repo", "main")
	id := register(t, a, "Repo", path)
	root := testutil.TempDir(t)
	external := filepath.Join(root, "existing worktree")
	testGit(t, path, "worktree", "add", "-b", "existing", "--", external)
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Skipf("directory symlinks unavailable: %v", err)
	}
	code, q, raw := createSelected(t, a, "alias", id, MemberSelection{ProjectID: id, Mode: "worktree", Path: filepath.Join(alias, "existing worktree")})
	if code != 201 || q.State != "ready" || q.Members[0].Path != external {
		t.Fatalf("reuse alias: %d %s", code, raw)
	}
	if _, err := a.MakeLaunchPlan(context.Background(), q.ID); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(root, "linked-entry")
	if err := os.Symlink(external, linked); err != nil {
		t.Fatal(err)
	}
	if code, _, raw := createSelected(t, a, "linked", id, MemberSelection{ProjectID: id, Mode: "worktree", Path: linked}); code != 422 {
		t.Fatalf("accepted linked entry: %d %s", code, raw)
	}
}
