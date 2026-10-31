package project

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"worktree-hub/internal/workspace"
)

func TestProjectFilesRequiresRegisteredWorktreeAndReadsUnchangedFiles(t *testing.T) {
	a := testApp(t)
	root := repo(t, "browser", "main")
	id := register(t, a, "Browser", root)
	os.MkdirAll(filepath.Join(root, "nested"), 0700)
	os.WriteFile(filepath.Join(root, "nested", "unchanged.ts"), []byte("export const answer = 42\n"), 0600)
	testGit(t, root, "add", "nested/unchanged.ts")
	testGit(t, root, "commit", "-m", "unchanged file")
	os.WriteFile(filepath.Join(root, ".hidden"), []byte("hidden text\n"), 0600)
	base := "/api/projects/" + id + "/files?path=" + url.QueryEscape(root)
	code, raw := call(t, a, "GET", base, nil)
	var listing workspace.DirectoryPreview
	json.Unmarshal(raw, &listing)
	if code != 200 || len(listing.Entries) < 2 || strings.Contains(string(raw), `"name":".git"`) {
		t.Fatalf("list %d %s", code, raw)
	}
	code, raw = call(t, a, "GET", base+"&dir=nested", nil)
	if code != 200 || !strings.Contains(string(raw), "nested/unchanged.ts") {
		t.Fatalf("nested %d %s", code, raw)
	}
	code, raw = call(t, a, "GET", base+"&file=nested/unchanged.ts", nil)
	var file workspace.TextFile
	json.Unmarshal(raw, &file)
	if code != 200 || file.Text != "export const answer = 42\n" {
		t.Fatalf("content %d %s", code, raw)
	}
	for _, file := range []string{"../outside", ".git/config", "nested/../../outside"} {
		if code, _ := call(t, a, "GET", base+"&file="+url.QueryEscape(file), nil); code != 422 {
			t.Errorf("invalid %s returned %d", file, code)
		}
	}
	if code, _ := call(t, a, "GET", "/api/projects/"+id+"/files?path="+url.QueryEscape(t.TempDir()), nil); code != 409 {
		t.Fatalf("foreign worktree accepted: %d", code)
	}
}
