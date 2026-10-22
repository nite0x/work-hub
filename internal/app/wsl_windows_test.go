package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/task"
	"worktree-hub/internal/workspace"
)

// Opt in: only temporary repositories are created. No Codex turn is started.
func TestInstalledWSLWorkspaceCore(t *testing.T) {
	distro := os.Getenv("WORKTREE_HUB_TEST_WSL")
	if distro == "" {
		t.Skip("set WORKTREE_HUB_TEST_WSL to an installed distro")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := workspace.StartWSL(ctx, distro, "")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("wsl.exe", workspace.WSLArgs(distro, c.Identity.User, "mktemp", "-d", "/tmp/worktree-hub-native-smoke.XXXXXX")...)
	platform.HideCommand(cmd)
	raw, err := cmd.Output()
	if err != nil {
		c.Close()
		t.Fatal(err)
	}
	root := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(root, "/tmp/worktree-hub-native-smoke.") || strings.ContainsAny(root, "\r\n") {
		c.Close()
		t.Fatal("invalid fixture root")
	}
	remoteCtx := workspace.WithClient(context.Background(), c)
	a, err := openAppForWorkspace(filepath.Join(t.TempDir(), "host-metadata"), root+"/workspaces", c)
	if err != nil {
		c.Close()
		t.Fatal(err)
	}
	a.Workspace.ReadOnlySessions = true
	t.Cleanup(func() {
		a.Projects.Close()
		a.Workspace.Store.DB.Close()
		c.Close()
		cleanup := exec.Command("wsl.exe", workspace.WSLArgs(distro, c.Identity.User, "rm", "-rf", "--", root)...)
		platform.HideCommand(cleanup)
		_ = cleanup.Run()
	})
	ids := []string{}
	for _, name := range []string{"frontend", "backend"} {
		dir := root + "/" + name
		if err := workspace.Mkdir(remoteCtx, dir, 0755, false); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][]string{{"init", "-b", "master"}, {"config", "user.name", "Smoke Test"}, {"config", "user.email", "smoke@example.invalid"}} {
			if _, err := workspace.Git(remoteCtx, dir, args...); err != nil {
				t.Fatal(err)
			}
		}
		if err := workspace.Write(remoteCtx, dir+"/README.md", []byte(name), os.O_CREATE|os.O_WRONLY, 0644); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][]string{{"add", "README.md"}, {"commit", "-m", "baseline"}} {
			if _, err := workspace.Git(remoteCtx, dir, args...); err != nil {
				t.Fatal(err)
			}
		}
		ids = append(ids, register(t, a, name, dir))
	}
	code, body := call(t, a, "POST", "/api/requirements", task.CreateRequirement{Name: "Windows to WSL", Slug: "wsl-task", PrimaryProjectID: ids[0], ProjectIDs: ids[1:]})
	if code != 201 {
		t.Fatalf("create: %d %s", code, body)
	}
	var q model.Requirement
	_ = json.Unmarshal(body, &q)
	if q.State != "ready" || len(q.Members) != 2 || q.Path != root+"/workspaces/wsl-task" {
		t.Fatalf("task: %+v", q)
	}
	for _, m := range q.Members {
		if !strings.HasPrefix(m.Path, q.Path+"/") || strings.Contains(m.Path, `\`) {
			t.Fatal("Linux path was interpreted by Windows", m.Path)
		}
	}
	if err := workspace.Write(remoteCtx, q.Members[0].Path+"/changed.txt", []byte("dirty"), os.O_CREATE|os.O_WRONLY, 0644); err != nil {
		t.Fatal(err)
	}
	code, body = call(t, a, "GET", "/api/projects/"+q.Members[0].ProjectID+"/git", nil)
	if code != 200 || !strings.Contains(string(body), `"dirty":1`) {
		t.Fatalf("status: %d %s", code, body)
	}
	if _, err := os.Stat(filepath.Join(a.Workspace.DataDir, "worktree-hub.db")); err != nil {
		t.Fatal("metadata was not stored on Windows", err)
	}
}
