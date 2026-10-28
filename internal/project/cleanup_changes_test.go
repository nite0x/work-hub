package project

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"worktree-hub/internal/workspace"
)

func reviewItems(t *testing.T, a *App, id string) []CleanupCandidate {
	t.Helper()
	code, raw := call(t, a, "GET", "/api/requirements/"+id+"/review", nil)
	var result struct {
		Items []CleanupCandidate `json:"items"`
	}
	if err := json.Unmarshal(raw, &result); err != nil || code != 200 {
		t.Fatalf("review %d %s %v", code, raw, err)
	}
	return result.Items
}

func TestCleanupChecksArchiveDirtySharedIgnoredAndExpiredPreview(t *testing.T) {
	a := testApp(t)
	id := register(t, a, "Repo", repo(t, "repo", "main"))
	_, q, _ := create(t, a, id, nil, "cleanup")
	endpoint := "/api/requirements/" + q.ID + "/cleanup/" + id
	if items := reviewItems(t, a, q.ID); len(items) != 1 || items[0].Cleanable {
		t.Fatal(items)
	}
	call(t, a, "POST", "/api/requirements/"+q.ID+"/archive", map[string]bool{"archived": true})
	clean := reviewItems(t, a, q.ID)[0]
	if !clean.Cleanable {
		t.Fatal(clean)
	}
	path := q.Members[0].Path
	if err := os.WriteFile(filepath.Join(path, "keep.txt"), []byte("unsaved"), 0600); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, a, "POST", endpoint, map[string]string{"path": path, "fingerprint": clean.Fingerprint}); code != 409 {
		t.Fatal("dirty removed", code)
	}
	os.Remove(filepath.Join(path, "keep.txt"))
	// Ignored files are also preserved, even though Git status reports clean.
	testGit(t, path, "config", "core.excludesFile", filepath.Join(t.TempDir(), "ignore"))
	ignore := testGit(t, path, "config", "--get", "core.excludesFile")
	os.WriteFile(ignore, []byte("ignored.txt\n"), 0600)
	os.WriteFile(filepath.Join(path, "ignored.txt"), []byte("keep ignored"), 0600)
	if item := reviewItems(t, a, q.ID)[0]; item.Cleanable || !item.Ignored {
		t.Fatal(item)
	}
	os.Remove(filepath.Join(path, "ignored.txt"))
	// Shared directories cannot be removed, including references from archived tasks.
	code, raw := call(t, a, "POST", "/api/requirements", map[string]any{"name": "Shared", "slug": "shared", "members": []map[string]string{{"project_id": id, "mode": "worktree", "path": path}}})
	if code != 201 {
		t.Fatalf("shared %d %s", code, raw)
	}
	if item := reviewItems(t, a, q.ID)[0]; item.Cleanable || len(item.Shared) != 1 {
		t.Fatal(item)
	}
	var shared struct {
		ID string `json:"id"`
	}
	json.Unmarshal(raw, &shared)
	call(t, a, "DELETE", "/api/requirements/"+shared.ID+"/projects/"+id, nil)
	current := reviewItems(t, a, q.ID)[0]
	if !current.Cleanable {
		t.Fatal(current)
	}
	if code, _ := call(t, a, "POST", endpoint, map[string]string{"path": path, "fingerprint": "old-preview"}); code != 409 {
		t.Fatal("expired preview accepted", code)
	}
	a.ReserveWorktree = func(context.Context, string) (func(), error) { return nil, fmt.Errorf("active conversation") }
	if code, _ := call(t, a, "POST", endpoint, map[string]string{"path": path, "fingerprint": current.Fingerprint}); code != 409 {
		t.Fatal("active removed", code)
	}
	a.ReserveWorktree = nil
	if code, raw := call(t, a, "POST", endpoint, map[string]string{"path": path, "fingerprint": current.Fingerprint}); code != 200 {
		t.Fatalf("cleanup %d %s", code, raw)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("directory retained", err)
	}
	ps, _ := a.Workspace.Store.ProjectMap()
	testGit(t, ps[id].Path, "show-ref", "--verify", "refs/heads/"+q.Branch)
	saved, _ := a.Workspace.Store.Requirement(q.ID)
	if saved.Members[0].State != "removed" {
		t.Fatal(saved)
	}
	call(t, a, "POST", "/api/requirements/"+q.ID+"/archive", map[string]bool{"archived": false})
	if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/retry", map[string]string{"project_id": id}); code != 200 {
		t.Fatalf("restore %d %s", code, raw)
	}
	saved, _ = a.Workspace.Store.Requirement(q.ID)
	if saved.State != "ready" {
		t.Fatal(saved)
	}
}

func TestCleanupFindsReplacedWorktreeAndRejectsUnpublishedCommit(t *testing.T) {
	a := testApp(t)
	id := register(t, a, "Repo", repo(t, "repo", "main"))
	_, q, _ := create(t, a, id, nil, "old-directory")
	path := q.Members[0].Path
	call(t, a, "PUT", "/api/requirements/"+q.ID+"/projects/"+id, map[string]string{"mode": "project"})
	items := reviewItems(t, a, q.ID)
	var orphan CleanupCandidate
	for _, item := range items {
		if item.Path == path {
			orphan = item
		}
	}
	if !orphan.Cleanable || orphan.Current {
		t.Fatal(items)
	}
	os.WriteFile(filepath.Join(path, "commit.txt"), []byte("keep commit"), 0600)
	testGit(t, path, "add", "commit.txt")
	testGit(t, path, "commit", "-m", "not published")
	for _, item := range reviewItems(t, a, q.ID) {
		if item.Path == path && item.Cleanable {
			t.Fatal("unpublished commit accepted")
		}
	}
}

func TestChangesPreviewIndexWorkingUntrackedAndTraversal(t *testing.T) {
	a := testApp(t)
	path := repo(t, "repo", "main")
	id := register(t, a, "Repo", path)
	os.WriteFile(filepath.Join(path, "file.txt"), []byte("original\n"), 0600)
	testGit(t, path, "add", "file.txt")
	testGit(t, path, "commit", "-m", "baseline")
	os.WriteFile(filepath.Join(path, "file.txt"), []byte("staged\n"), 0600)
	testGit(t, path, "add", "file.txt")
	os.WriteFile(filepath.Join(path, "file.txt"), []byte("working\n"), 0600)
	os.WriteFile(filepath.Join(path, "新文件.txt"), []byte("<script>inert</script>\n"), 0600)
	base := "/api/projects/" + id + "/changes?path=" + url.QueryEscape(path)
	code, raw := call(t, a, "GET", base, nil)
	if code != 200 || !strings.Contains(string(raw), "新文件.txt") {
		t.Fatalf("list %d %s", code, raw)
	}
	for _, mode := range []string{"working", "index"} {
		code, raw := call(t, a, "GET", base+"&file=file.txt&mode="+mode, nil)
		if code != 200 || !strings.Contains(string(raw), "+"+map[string]string{"working": "working", "index": "staged"}[mode]) {
			t.Fatalf("preview %s %d %s", mode, code, raw)
		}
	}
	code, raw = call(t, a, "GET", base+"&file="+url.QueryEscape("新文件.txt"), nil)
	var text workspace.GitPreview
	json.Unmarshal(raw, &text)
	if code != 200 || !strings.Contains(text.Text, "<script>inert</script>") {
		t.Fatalf("text %d %s", code, raw)
	}
	if code, _ := call(t, a, "GET", base+"&file=../outside", nil); code != 409 {
		t.Fatal("traversal accepted", code)
	}
	if err := os.Symlink(filepath.Join(t.TempDir(), "outside"), filepath.Join(path, "link")); err == nil {
		if code, _ := call(t, a, "GET", base+"&file=link", nil); code != 422 {
			t.Fatal("symlink accepted", code)
		}
	}
}
