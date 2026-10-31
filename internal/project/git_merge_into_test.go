package project

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func previewMergeInto(t *testing.T, a *App, id, path, target string) GitAction {
	t.Helper()
	in := GitAction{Action: "merge_into_preview", Path: path, Target: "refs/heads/" + target}
	code, raw := gitAction(t, a, id, in)
	if code != 200 {
		t.Fatalf("preview: %d %s", code, raw)
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatal(err)
	}
	in.Action = "merge_into"
	return in
}

func assertNoMergeWorktree(t *testing.T, root string) {
	t.Helper()
	if trees := testGit(t, root, "worktree", "list", "--porcelain"); strings.Contains(trees, "work-hub-merge-") {
		t.Fatalf("temporary worktree leaked: %s", trees)
	}
	common := testGit(t, root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	paths, err := filepath.Glob(filepath.Join(common, "work-hub-merge-*"))
	if err != nil || len(paths) != 0 {
		t.Fatalf("temporary directory leaked: %v %v", paths, err)
	}
}

func TestMergeIntoCheckedOutTargetPreservesSourceAndDirtyFiles(t *testing.T) {
	a := testApp(t)
	root := repo(t, "merge-into", "main")
	id := register(t, a, "App", root)
	source := filepath.Join(t.TempDir(), "source")
	testGit(t, root, "worktree", "add", "-b", "feature/task", source)
	commitFile(t, source, "feature.txt", "committed feature")
	head := testGit(t, source, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(source, "feature.txt"), []byte("staged source edit"), 0644); err != nil {
		t.Fatal(err)
	}
	testGit(t, source, "add", "feature.txt")
	if err := os.WriteFile(filepath.Join(source, "feature.txt"), []byte("unsaved source edit"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "notes.txt"), []byte("untracked source"), 0644); err != nil {
		t.Fatal(err)
	}
	in := previewMergeInto(t, a, id, source, "main")
	if code, raw := gitAction(t, a, id, in); code != 200 {
		t.Fatalf("merge: %d %s", code, raw)
	}
	if testGit(t, source, "branch", "--show-current") != "feature/task" || testGit(t, source, "rev-parse", "HEAD") != head {
		t.Fatal("source branch moved")
	}
	if testGit(t, root, "rev-parse", "HEAD") != head || testGit(t, root, "status", "--porcelain") != "" {
		t.Fatal("target checkout did not fast-forward cleanly")
	}
	if got := testGit(t, source, "show", ":feature.txt"); got != "staged source edit" {
		t.Fatalf("source index changed: %s", got)
	}
	for path, expected := range map[string]string{
		filepath.Join(root, "feature.txt"):   "committed feature",
		filepath.Join(source, "feature.txt"): "unsaved source edit",
		filepath.Join(source, "notes.txt"):   "untracked source",
	} {
		if got, err := os.ReadFile(path); err != nil || string(got) != expected {
			t.Fatalf("%s: %q %v", path, got, err)
		}
	}
	assertNoMergeWorktree(t, root)
}

func TestMergeIntoDivergedTargetCreatesMergeCommit(t *testing.T) {
	for _, occupied := range []bool{false, true} {
		t.Run(map[bool]string{false: "unoccupied", true: "occupied"}[occupied], func(t *testing.T) {
			a := testApp(t)
			root := repo(t, "diverged", "main")
			testGit(t, root, "branch", "feature/task")
			commitFile(t, root, "target.txt", "target commit")
			targetHead := testGit(t, root, "rev-parse", "HEAD")
			testGit(t, root, "switch", "feature/task")
			commitFile(t, root, "source.txt", "source commit")
			sourceHead := testGit(t, root, "rev-parse", "HEAD")
			targetPath := ""
			if occupied {
				targetPath = filepath.Join(t.TempDir(), "target")
				testGit(t, root, "worktree", "add", targetPath, "main")
			}
			id := register(t, a, "App", root)
			in := previewMergeInto(t, a, id, root, "main")
			if code, raw := gitAction(t, a, id, in); code != 200 {
				t.Fatalf("merge: %d %s", code, raw)
			}
			if got := testGit(t, root, "rev-list", "--parents", "-1", "main"); !strings.HasSuffix(got, " "+targetHead+" "+sourceHead) {
				t.Fatalf("incorrect merge parents: %s", got)
			}
			if testGit(t, root, "branch", "--show-current") != "feature/task" || testGit(t, root, "rev-parse", "HEAD") != sourceHead {
				t.Fatal("source branch changed")
			}
			if occupied {
				if got, err := os.ReadFile(filepath.Join(targetPath, "source.txt")); err != nil || string(got) != "source commit" {
					t.Fatalf("target checkout not updated: %q %v", got, err)
				}
			}
			assertNoMergeWorktree(t, root)
		})
	}
}

func TestMergeIntoConflictLeavesBothBranchesUntouched(t *testing.T) {
	a := testApp(t)
	root := repo(t, "conflict", "main")
	testGit(t, root, "branch", "feature/task")
	commitFile(t, root, "README.md", "target edit\n")
	targetHead := testGit(t, root, "rev-parse", "HEAD")
	source := filepath.Join(t.TempDir(), "source")
	testGit(t, root, "worktree", "add", source, "feature/task")
	commitFile(t, source, "README.md", "source edit\n")
	sourceHead := testGit(t, source, "rev-parse", "HEAD")
	id := register(t, a, "App", root)
	in := previewMergeInto(t, a, id, source, "main")
	if code, raw := gitAction(t, a, id, in); code != 409 || !strings.Contains(string(raw), "README.md") || !strings.Contains(string(raw), "目标分支未更新") {
		t.Fatalf("conflict: %d %s", code, raw)
	}
	for path, head := range map[string]string{root: targetHead, source: sourceHead} {
		if testGit(t, path, "rev-parse", "HEAD") != head || testGit(t, path, "status", "--porcelain") != "" {
			t.Fatalf("checkout changed: %s", path)
		}
	}
	assertNoMergeWorktree(t, root)
}

func TestMergeIntoRejectsUnsafeOrStaleTargets(t *testing.T) {
	for _, scenario := range []string{"dirty-target", "target-operation", "source-moved", "target-moved", "source-switched", "missing-preview", "same-branch", "remote-target", "detached-source"} {
		t.Run(scenario, func(t *testing.T) {
			a := testApp(t)
			root := repo(t, "guards", "main")
			source := filepath.Join(t.TempDir(), "source")
			testGit(t, root, "worktree", "add", "-b", "feature/task", source)
			commitFile(t, source, "feature.txt", "feature")
			id := register(t, a, "App", root)
			in := previewMergeInto(t, a, id, source, "main")
			switch scenario {
			case "dirty-target":
				_ = os.WriteFile(filepath.Join(root, "notes.txt"), []byte("keep me"), 0644)
			case "target-operation":
				if err := os.WriteFile(filepath.Join(root, ".git", "MERGE_HEAD"), []byte(testGit(t, source, "rev-parse", "HEAD")+"\n"), 0644); err != nil {
					t.Fatal(err)
				}
			case "source-moved":
				commitFile(t, source, "new.txt", "later source commit")
			case "target-moved":
				commitFile(t, root, "new.txt", "later target commit")
			case "source-switched":
				testGit(t, source, "switch", "-c", "another")
			case "missing-preview":
				in.ExpectedHead = ""
			case "same-branch":
				in.Target = "refs/heads/feature/task"
			case "remote-target":
				testGit(t, root, "update-ref", "refs/remotes/origin/main", "main")
				in.Target = "refs/remotes/origin/main"
			case "detached-source":
				testGit(t, source, "switch", "--detach")
			}
			before := testGit(t, root, "rev-parse", "main")
			if code, raw := gitAction(t, a, id, in); code != 409 {
				t.Fatalf("accepted %s: %d %s", scenario, code, raw)
			}
			if testGit(t, root, "rev-parse", "main") != before {
				t.Fatal("rejected operation changed target")
			}
			assertNoMergeWorktree(t, root)
		})
	}
}
