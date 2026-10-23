package project

import (
	"strings"
	"testing"
)

func TestRemoteWebURL(t *testing.T) {
	for raw, want := range map[string]string{
		"git@github.com:org/repo.git":                                    "https://github.com/org/repo",
		"ssh://git@gitlab.example:2222/group/sub/repo.git":               "https://gitlab.example/group/sub/repo",
		"https://user:secret@git.example:8443/org/repo.git?token=secret": "https://git.example:8443/org/repo",
	} {
		got, err := RemoteWebURL(raw)
		if err != nil || got != want {
			t.Fatalf("%q -> %q %v", raw, got, err)
		}
	}
	for _, raw := range []string{"/tmp/remote.git", "file:///tmp/remote.git", "javascript:alert(1)", "ext::command", `C:\repo.git`} {
		if got, err := RemoteWebURL(raw); err == nil {
			t.Fatalf("accepted %s -> %s", raw, got)
		}
	}
}

func TestProjectOpenIsScopedToWorktreeAndRemoteCredentialsAreRemoved(t *testing.T) {
	a := testApp(t)
	path := repo(t, "open", "master")
	id := register(t, a, "App", path)
	_, q, _ := create(t, a, id, nil, "open-task")
	var tool, opened, distro, remote string
	a.OpenEditor = func(t, p, d string) error { tool, opened, distro = t, p, d; return nil }
	a.OpenExternal = func(u string) error { remote = u; return nil }
	endpoint := "/api/projects/" + id + "/open"
	for _, editor := range []string{"vscode", "idea"} {
		if code, raw := call(t, a, "POST", endpoint, map[string]string{"tool": editor, "path": q.Members[0].Path}); code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		if tool != editor || opened != q.Members[0].Path || distro != "" {
			t.Fatal(tool, opened, distro)
		}
	}
	opened = ""
	if code, _ := call(t, a, "POST", endpoint, map[string]string{"tool": "idea", "path": t.TempDir()}); code != 409 || opened != "" {
		t.Fatal("arbitrary directory launched")
	}
	testGit(t, path, "remote", "add", "origin", "https://user:secret@example.invalid/org/repo.git?token=hidden")
	if code, raw := call(t, a, "POST", endpoint, map[string]string{"tool": "remote", "path": q.Members[0].Path}); code != 200 || strings.Contains(string(raw), "secret") {
		t.Fatalf("%d %s", code, raw)
	}
	if remote != "https://example.invalid/org/repo" {
		t.Fatal(remote)
	}
}
