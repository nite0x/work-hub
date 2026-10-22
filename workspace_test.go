package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceAgentProcess(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_AGENT_TEST") != "1" {
		return
	}
	if err := runWorkspaceAgent(os.Stdin, os.Stdout); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}
func testWorkspaceClient(t *testing.T) *workspaceClient {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestWorkspaceAgentProcess$")
	cmd.Env = append(os.Environ(), "WORKTREE_HUB_AGENT_TEST=1")
	c, err := startWorkspaceClient(cmd)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.close)
	return c
}
func TestRemoteWorkspaceTaskCoreFlow(t *testing.T) {
	c := testWorkspaceClient(t)
	data := filepath.Join(t.TempDir(), "host-metadata")
	root := filepath.Join(t.TempDir(), "remote-workspaces")
	a, err := openAppForWorkspace(data, root, c)
	if err != nil {
		t.Fatal(err)
	}
	a.readOnlySessions = true
	t.Cleanup(func() { a.stateCache.close(); a.db.Close() })
	first, second := repo(t, "first", "master"), repo(t, "second", "master")
	p1, p2 := register(t, a, "first", first), register(t, a, "second", second)
	code, raw := call(t, a, "POST", "/api/requirements", CreateRequirement{Name: "Remote task", Slug: "remote-task", PrimaryProjectID: p1, ProjectIDs: []string{p2}})
	if code != 201 {
		t.Fatalf("create: %d %s", code, raw)
	}
	var q Requirement
	if err := json.Unmarshal(raw, &q); err != nil {
		t.Fatal(err)
	}
	if q.State != "ready" || len(q.Members) != 2 {
		t.Fatalf("task: %+v", q)
	}
	for _, m := range q.Members {
		if filepath.Dir(m.Path) != q.Path {
			t.Fatalf("worktree escaped task: %s", m.Path)
		}
		if got := testGit(t, m.Path, "branch", "--show-current"); got != q.Branch {
			t.Fatalf("branch: %s", got)
		}
	}
	if _, err := os.Stat(filepath.Join(data, "worktree-hub.db")); err != nil {
		t.Fatal("host metadata missing", err)
	}
	if _, err := os.Stat(filepath.Join(root, "worktree-hub.db")); !os.IsNotExist(err) {
		t.Fatal("helper must not create a business database")
	}
	if err := os.WriteFile(filepath.Join(q.Members[0].Path, "changed.txt"), []byte("dirty"), 0644); err != nil {
		t.Fatal(err)
	}
	code, raw = call(t, a, "GET", "/api/projects/"+q.Members[0].ProjectID+"/git", nil)
	if code != 200 || !strings.Contains(string(raw), `"dirty":1`) {
		t.Fatalf("remote status: %d %s", code, raw)
	}
	third := register(t, a, "third", repo(t, "third", "master"))
	a.root = filepath.Join(t.TempDir(), "different-root")
	code, raw = call(t, a, "POST", "/api/requirements/"+q.ID+"/projects", map[string]any{"project_ids": []string{third}})
	if code != 200 {
		t.Fatalf("add project: %d %s", code, raw)
	}
	var updated Requirement
	_ = json.Unmarshal(raw, &updated)
	if updated.Path != q.Path || len(updated.Members) != 3 || updated.State != "ready" {
		t.Fatalf("persisted workspace changed: %+v", updated)
	}
	if err := c.call(context.Background(), workspaceRequest{Op: "session", Method: "turn/start"}, nil); err == nil {
		t.Fatal("helper accepted a model turn")
	}
}
func TestRemoteWorkspaceErrorsCancellationAndExclusiveBrief(t *testing.T) {
	c := testWorkspaceClient(t)
	ctx := withWorkspace(context.Background(), c)
	root := t.TempDir()
	missing := filepath.Join(root, "missing")
	if _, err := workspaceStat(ctx, missing, false); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing error lost: %v", err)
	}
	q := Requirement{Name: "Notes", Path: root, Branch: "codex/notes"}
	if err := writeBriefContext(ctx, q); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "BRIEF.md")
	if err := os.WriteFile(file, []byte("user notes"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := writeBriefContext(ctx, q); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(file); string(raw) != "user notes" {
		t.Fatal("retry overwrote user notes")
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if err := workspaceMkdir(canceled, missing, 0755, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("canceled operation was executed")
	}
}

func TestRemoteWorkspaceRejectsRelativeAndWindowsRoots(t *testing.T) {
	// An unconnected client proves invalid roots are rejected before any RPC.
	c := &workspaceClient{identity: workspaceIdentity{Home: "/home/nite"}}
	for _, root := range []string{"relative", `C:\workspaces`} {
		if a, err := openAppForWorkspace(t.TempDir(), root, c); err == nil {
			a.db.Close()
			t.Fatalf("accepted non-Linux root %q", root)
		}
	}
}
func TestReadOnlySessionModeKeepsHistoryAndRejectsControl(t *testing.T) {
	a := testApp(t)
	a.readOnlySessions = true
	_, body := call(t, a, "GET", "/", nil)
	raw := string(body)
	if !strings.Contains(raw, `content="read-only"`) || strings.Contains(raw, `src="/session-chat.js"`) || strings.Contains(raw, `src="/session-create.js"`) {
		t.Fatal("read-only page still loads interactive controls")
	}
	for _, path := range []string{"/api/requirements/task/sessions/new", "/api/requirements/task/sessions/session/chat", "/api/requirements/task/sessions/session/chat/handoff"} {
		code, _ := call(t, a, "POST", path, map[string]string{})
		if code != 405 {
			t.Fatalf("control %s returned %d", path, code)
		}
	}
}
