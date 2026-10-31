package workspace

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestBrowseWorkspaceLocalAndRemoteBoundaries(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "src"), 0700)
	os.MkdirAll(filepath.Join(root, ".git"), 0700)
	os.WriteFile(filepath.Join(root, "src", "你好.ts"), []byte("<script>inert</script>\n"), 0600)
	os.WriteFile(filepath.Join(root, "binary"), []byte{0, 1, 2}, 0600)
	os.WriteFile(filepath.Join(root, "large"), make([]byte, TextPreviewLimit+1), 0600)
	outside := filepath.Join(t.TempDir(), "secret")
	os.WriteFile(outside, []byte("outside"), 0600)
	hasLink := os.Symlink(outside, filepath.Join(root, "link")) == nil
	os.Symlink(filepath.Join(root, ".git"), filepath.Join(root, "metadata"))
	contexts := []context.Context{context.Background(), WithClient(context.Background(), streamTestClient(t))}
	for _, ctx := range contexts {
		result, err := BrowseWorkspace(ctx, root, "", false)
		if err != nil {
			t.Fatal(err)
		}
		entries := result.(DirectoryPreview).Entries
		if len(entries) == 0 || !entries[0].Directory {
			t.Fatalf("directories not first: %+v", entries)
		}
		for _, entry := range entries {
			if entry.Name == ".git" {
				t.Fatal("git metadata exposed")
			}
		}
		result, err = BrowseWorkspace(ctx, root, "src/你好.ts", true)
		if err != nil || result.(TextFile).Text != "<script>inert</script>\n" {
			t.Fatalf("file=%+v err=%v", result, err)
		}
		bad := []string{"../secret", outside, ".git", "src/../binary", "metadata", "binary", "large"}
		if hasLink {
			bad = append(bad, "link")
		}
		for _, path := range bad {
			if _, err := BrowseWorkspace(ctx, root, path, true); err == nil {
				t.Errorf("read accepted %q", path)
			}
		}
	}
}
