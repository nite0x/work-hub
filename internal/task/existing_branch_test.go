package task

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"worktree-hub/internal/model"
)

func TestTaskCreatesWorktreeFromExistingBranchAndRetries(t *testing.T) {
	a := testApp(t)
	path := repo(t, "repo", "main")
	id := register(t, a, "Repo", path)
	testGit(t, path, "switch", "-c", "feature/existing")
	if err := os.WriteFile(filepath.Join(path, "feature.txt"), []byte("existing work"), 0644); err != nil {
		t.Fatal(err)
	}
	testGit(t, path, "add", ".")
	testGit(t, path, "commit", "-m", "existing work")
	commit := testGit(t, path, "rev-parse", "HEAD")
	testGit(t, path, "switch", "main")
	before := testGit(t, path, "for-each-ref", "--format=%(refname):%(objectname)")
	code, q, raw := createSelected(t, a, "existing-branch", id, MemberSelection{ProjectID: id, Mode: "existing", Branch: "feature/existing"})
	if code != 201 || q.State != "ready" || !q.HasWorkspace {
		t.Fatalf("create: %d %s", code, raw)
	}
	m := q.Members[0]
	if m.Mode != "existing" || m.Branch != "feature/existing" || m.BaseRef != "refs/heads/feature/existing" || m.BaseCommit != commit || m.Path != filepath.Join(q.Path, "repo") {
		t.Fatalf("incorrect member: %+v", m)
	}
	if testGit(t, m.Path, "branch", "--show-current") != m.Branch || testGit(t, m.Path, "rev-parse", "HEAD") != commit {
		t.Fatal("wrong checkout")
	}
	if testGit(t, path, "branch", "--show-current") != "main" || testGit(t, path, "for-each-ref", "--format=%(refname):%(objectname)") != before {
		t.Fatal("existing branches changed")
	}
	brief, err := os.ReadFile(filepath.Join(q.Path, "BRIEF.md"))
	if err != nil || !strings.Contains(string(brief), "使用已有分支 feature/existing 新建 Worktree") {
		t.Fatalf("brief: %s %v", brief, err)
	}
	if _, err := a.Workspace.Store.DB.Exec(`UPDATE members SET state='failed' WHERE requirement_id=?`, q.ID); err != nil {
		t.Fatal(err)
	}
	code, raw = call(t, a, "POST", "/api/requirements/"+q.ID+"/retry", nil)
	if code != 200 {
		t.Fatalf("retry: %d %s", code, raw)
	}
	saved, err := a.Workspace.Store.Requirement(q.ID)
	if err != nil || saved.State != "ready" || saved.Members[0].Mode != "existing" {
		t.Fatalf("saved: %+v %v", saved, err)
	}
	if _, err := a.MakeLaunchPlan(context.Background(), q.ID); err != nil {
		t.Fatal(err)
	}
}

func TestTaskExistingBranchRejectsUnavailableBranchesBeforeMutation(t *testing.T) {
	a := testApp(t)
	path := repo(t, "repo", "main")
	id := register(t, a, "Repo", path)
	testGit(t, path, "update-ref", "refs/remotes/origin/remote-only", "HEAD")
	external := filepath.Join(t.TempDir(), "occupied")
	testGit(t, path, "worktree", "add", "-b", "occupied", "--", external)
	for i, branch := range []string{"", "missing", "main", "occupied", "origin/remote-only", "--force", "main~1"} {
		slug := "invalid-" + string(rune('a'+i))
		code, _, raw := createSelected(t, a, slug, id, MemberSelection{ProjectID: id, Mode: "existing", Branch: branch})
		if code != 422 {
			t.Fatalf("accepted %q: %d %s", branch, code, raw)
		}
		if _, err := os.Stat(filepath.Join(a.Workspace.Root, slug)); !os.IsNotExist(err) {
			t.Fatal("created workspace before validation")
		}
	}
}

func TestTaskAddsAndReplacesWorktreesUsingExistingBranches(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(map[bool]string{false: "add", true: "replace"}[replace], func(t *testing.T) {
			a := testApp(t)
			path := repo(t, "original", "main")
			id := register(t, a, "Original", path)
			_, q, _ := createSelected(t, a, "task", id, MemberSelection{ProjectID: id, Mode: "project"})
			target, targetID := path, id
			if !replace {
				target = repo(t, "added", "main")
				targetID = register(t, a, "Added", target)
			}
			testGit(t, target, "branch", "feature/existing")
			selection := MemberSelection{ProjectID: targetID, Mode: "existing", Branch: "feature/existing"}
			endpoint := "/api/requirements/" + q.ID + "/projects"
			method := "POST"
			var body any = map[string]any{"members": []MemberSelection{selection}}
			if replace {
				method, endpoint, body = "PUT", endpoint+"/"+targetID, selection
			}
			code, raw := call(t, a, method, endpoint, body)
			var saved model.Requirement
			if err := json.Unmarshal(raw, &saved); err != nil || code != 200 || saved.State != "ready" || !saved.HasWorkspace {
				t.Fatalf("%d %s %v", code, raw, err)
			}
			m := saved.Members[len(saved.Members)-1]
			if m.Mode != "existing" || m.Path == target || testGit(t, m.Path, "branch", "--show-current") != "feature/existing" {
				t.Fatal(m)
			}
			if _, err := os.Stat(filepath.Join(saved.Path, "BRIEF.md")); err != nil {
				t.Fatal(err)
			}
			if testGit(t, target, "branch", "--show-current") != "main" {
				t.Fatal("original checkout changed")
			}
		})
	}
}
