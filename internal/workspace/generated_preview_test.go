package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGeneratedFilePreservesUserContentAndRejectsSymlinks(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "context.md")
	ctx := context.Background()
	if err := WriteGenerated(ctx, path, []byte("marker\nfirst"), "marker\n"); err != nil {
		t.Fatal(err)
	}
	if err := WriteGenerated(ctx, path, []byte("marker\nsecond"), "marker\n"); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, []byte("my notes"), 0600)
	if err := WriteGenerated(ctx, path, []byte("marker\nreplace"), "marker\n"); err == nil {
		t.Fatal("user file overwritten")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "my notes" {
		t.Fatal(string(raw))
	}
	link := filepath.Join(root, "link.md")
	if err := os.Symlink(path, link); err == nil {
		if err := WriteGenerated(ctx, link, []byte("marker\nreplace"), "marker\n"); err == nil {
			t.Fatal("symlink accepted")
		}
	}
}

func TestGitPreviewDrainsAndBoundsLargeOutput(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s %v", args, out, err)
		}
	}
	git("init")
	git("config", "user.name", "Test")
	git("config", "user.email", "test@example.test")
	file := filepath.Join(root, "large.txt")
	os.WriteFile(file, []byte("base\n"), 0600)
	git("add", "large.txt")
	git("commit", "-m", "base")
	os.WriteFile(file, []byte(strings.Repeat("a long changed line\n", GitPreviewLimit)), 0600)
	preview, err := RunGitPreview(context.Background(), root, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", "large.txt")
	if err != nil || !preview.Truncated || len(preview.Text) > GitPreviewLimit {
		t.Fatalf("len=%d truncated=%v err=%v", len(preview.Text), preview.Truncated, err)
	}
	remote := WithClient(context.Background(), streamTestClient(t))
	preview, err = RunGitPreview(remote, root, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", "large.txt")
	if err != nil || !preview.Truncated || len(preview.Text) > GitPreviewLimit {
		t.Fatalf("remote len=%d truncated=%v err=%v", len(preview.Text), preview.Truncated, err)
	}
	generated := filepath.Join(root, "remote-context.md")
	if err := WriteGenerated(remote, generated, []byte("marker\n中文上下文"), "marker\n"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(generated)
	if err != nil || string(raw) != "marker\n中文上下文" {
		t.Fatalf("remote context %s %v", raw, err)
	}
}
