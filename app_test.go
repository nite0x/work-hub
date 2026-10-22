package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func testApp(t *testing.T) *App {
	t.Helper()
	root := t.TempDir()
	a, err := openApp(filepath.Join(root, "data"), filepath.Join(root, "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	// Tests use isolated helpers and never access the user's Windows store.
	a.credentialHelper = ""
	t.Cleanup(func() { a.closeChats(); a.closeBridges(); a.stateCache.close(); a.db.Close() })
	return a
}
func testGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	v, err := git(context.Background(), dir, args...)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(v)
}
func repo(t *testing.T, name, branch string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.Mkdir(path, 0755); err != nil {
		t.Fatal(err)
	}
	testGit(t, path, "init", "-b", branch)
	testGit(t, path, "config", "user.name", "Worktree Hub Test")
	testGit(t, path, "config", "user.email", "test@example.invalid")
	if err := os.WriteFile(filepath.Join(path, "README.md"), []byte("baseline\n"), 0644); err != nil {
		t.Fatal(err)
	}
	testGit(t, path, "add", "README.md")
	testGit(t, path, "commit", "-m", "baseline")
	return path
}
func call(t *testing.T, a *App, method, path string, body any) (int, []byte) {
	t.Helper()
	data, _ := json.Marshal(body)
	r := httptest.NewRequest(method, "http://localhost:4317"+path, strings.NewReader(string(data)))
	r.Header.Set("X-CSRF-Token", a.token)
	r.Header.Set("Origin", "http://localhost:4317")
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	return w.Code, w.Body.Bytes()
}
func register(t *testing.T, a *App, name, path string) string {
	t.Helper()
	code, raw := call(t, a, "POST", "/api/projects", map[string]string{"name": name, "path": path})
	if code != 201 {
		t.Fatalf("register %d: %s", code, raw)
	}
	var v map[string]string
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v["id"]
}
func create(t *testing.T, a *App, primary string, others []string, slug string) (int, Requirement, []byte) {
	t.Helper()
	code, raw := call(t, a, "POST", "/api/requirements", CreateRequirement{Name: "订单审批 '$(touch SHOULD_NOT_EXIST)'", Slug: slug, Description: "前后端联调", PrimaryProjectID: primary, ProjectIDs: others})
	var q Requirement
	_ = json.Unmarshal(raw, &q)
	return code, q, raw
}

func TestCreateFromMasterAndDiscoverExternalWorktree(t *testing.T) {
	a := testApp(t)
	front := repo(t, "front end", "master")
	back := repo(t, "backend", "master")
	master := testGit(t, front, "rev-parse", "master")
	testGit(t, front, "switch", "-c", "feature/current")
	_ = os.WriteFile(filepath.Join(front, "feature.txt"), []byte("current branch\n"), 0644)
	testGit(t, front, "add", "feature.txt")
	testGit(t, front, "commit", "-m", "feature only")
	external := filepath.Join(t.TempDir(), "external 工作树")
	testGit(t, front, "worktree", "add", "-b", "external", "--", external, "master")
	p1 := register(t, a, "Frontend", front)
	p2 := register(t, a, "Backend", back)
	if code, raw := call(t, a, "POST", "/api/projects", map[string]string{"name": "Same repository", "path": external}); code != 409 {
		t.Fatalf("duplicate repository accepted %d %s", code, raw)
	}
	code, q, raw := create(t, a, p1, []string{p2}, "order-approval")
	if code != 201 || q.State != "ready" {
		t.Fatalf("create %d: %s", code, raw)
	}
	if len(q.Members) != 2 {
		t.Fatalf("members: %+v", q)
	}
	for _, m := range q.Members {
		if m.ProjectID == p1 && testGit(t, m.Path, "rev-parse", "HEAD") != master {
			t.Fatal("worktree not created from master")
		}
		if got := testGit(t, m.Path, "branch", "--show-current"); got != "codex/order-approval" {
			t.Fatalf("wrong branch %s", got)
		}
	}
	if got := testGit(t, front, "branch", "--show-current"); got != "feature/current" {
		t.Fatal("original checkout changed")
	}
	_ = os.WriteFile(filepath.Join(external, "untracked file.txt"), []byte("dirty\n"), 0644)
	code, raw = settledState(t, a)
	if code != 200 {
		t.Fatal(string(raw))
	}
	var snapshot struct {
		Projects     []Project     `json:"projects"`
		Requirements []Requirement `json:"requirements"`
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatal(err)
	}
	var discovered, linked bool
	for _, p := range snapshot.Projects {
		for _, w := range p.Worktrees {
			if w.Path == external {
				discovered = w.Dirty == 1
			}
			if w.RequirementID == q.ID {
				linked = true
			}
		}
	}
	if !discovered || !linked {
		t.Fatalf("external or linked worktree missing: %s", raw)
	}
	if len(snapshot.Requirements[0].Members) != 2 || snapshot.Requirements[0].Members[0].Worktree == nil {
		t.Fatal("requirement view missing observed worktree")
	}
	if _, err := os.Stat(filepath.Join(q.Path, "BRIEF.md")); err != nil {
		t.Fatal(err)
	}
}

func TestPreflightAllRepositoriesBeforeCreatingAnything(t *testing.T) {
	a := testApp(t)
	good := repo(t, "good", "master")
	bad := repo(t, "main-only", "main")
	p1 := register(t, a, "Good", good)
	p2 := register(t, a, "Main only", bad)
	code, _, raw := create(t, a, p1, []string{p2}, "missing-master")
	if code != 422 || !strings.Contains(string(raw), "master") {
		t.Fatalf("expected missing-master failure: %d %s", code, raw)
	}
	if _, err := os.Stat(filepath.Join(a.root, "missing-master")); !os.IsNotExist(err) {
		t.Fatal("workspace created before full preflight")
	}
	if _, err := git(context.Background(), good, "rev-parse", "--verify", "refs/heads/codex/missing-master"); err == nil {
		t.Fatal("branch created despite failed preflight")
	}
	qs, _ := a.requirements()
	if len(qs) != 0 {
		t.Fatal("invalid requirement saved")
	}
}

func TestPathAndBranchConflictsDoNotOverwrite(t *testing.T) {
	a := testApp(t)
	path := repo(t, "project", "master")
	id := register(t, a, "Project", path)
	for _, slug := range []string{"../escape", "../../outside", "x/y", "."} {
		code, _, _ := create(t, a, id, nil, slug)
		if code != 400 {
			t.Fatalf("accepted unsafe slug %q", slug)
		}
	}
	testGit(t, path, "branch", "codex/existing")
	if code, _, raw := create(t, a, id, nil, "existing"); code != 422 {
		t.Fatalf("accepted existing branch %d %s", code, raw)
	}
	reserved := filepath.Join(a.root, "reserved")
	_ = os.Mkdir(reserved, 0755)
	_ = os.WriteFile(filepath.Join(reserved, "keep"), []byte("keep"), 0644)
	if code, _, raw := create(t, a, id, nil, "reserved"); code != 409 {
		t.Fatalf("accepted existing directory %d %s", code, raw)
	}
	if b, err := os.ReadFile(filepath.Join(reserved, "keep")); err != nil || string(b) != "keep" {
		t.Fatal("existing files overwritten")
	}
}

func TestPartialCreationRetryAndRestart(t *testing.T) {
	a := testApp(t)
	front := repo(t, "front", "master")
	back := repo(t, "back", "master")
	p1 := register(t, a, "Front", front)
	p2 := register(t, a, "Back", back)
	hook := filepath.Join(back, ".git", "hooks", "post-checkout")
	_ = os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0755)
	code, q, raw := create(t, a, p1, []string{p2}, "partial")
	if code != 201 || q.State != "partial" {
		t.Fatalf("expected partial: %d %s", code, raw)
	}
	var successful string
	for _, m := range q.Members {
		if m.State == "ready" {
			successful = m.Path
		}
	}
	if successful == "" {
		t.Fatal("successful worktree not preserved")
	}
	_ = os.WriteFile(filepath.Join(successful, "unsaved.txt"), []byte("preserve me"), 0644)
	_ = os.WriteFile(filepath.Join(q.Path, "BRIEF.md"), []byte("User's edited requirement notes"), 0644)
	dataDir, root := a.dataDir, a.root
	if err := a.db.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := openApp(dataDir, root)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.db.Close()
	_ = os.Remove(hook)
	code, raw = call(t, restarted, "POST", "/api/requirements/"+q.ID+"/retry", nil)
	if code != 200 {
		t.Fatalf("retry %d %s", code, raw)
	}
	if err := json.Unmarshal(raw, &q); err != nil {
		t.Fatal(err)
	}
	if q.State != "ready" {
		t.Fatalf("retry not recovered: %s", raw)
	}
	if b, err := os.ReadFile(filepath.Join(successful, "unsaved.txt")); err != nil || string(b) != "preserve me" {
		t.Fatal("retry touched successful worktree")
	}
	if b, err := os.ReadFile(filepath.Join(q.Path, "BRIEF.md")); err != nil || string(b) != "User's edited requirement notes" {
		t.Fatal("retry overwrote requirement notes")
	}
}

func TestLaunchUsesPrimaryAndAllWorktreesWithoutShellInjection(t *testing.T) {
	a := testApp(t)
	a.readOnlySessions = true
	p1 := register(t, a, "Main", repo(t, "main", "master"))
	p2 := register(t, a, "Other", repo(t, "other", "master"))
	_, q, raw := create(t, a, p1, []string{p2}, "launch")
	if q.State != "ready" {
		t.Fatal(string(raw))
	}
	var captured LaunchPlan
	a.launch = func(p LaunchPlan) error { captured = p; return nil }
	code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/launch", nil)
	if code != 200 {
		t.Fatalf("launch %d %s", code, raw)
	}
	if len(captured.AdditionalDirectories) != 1 || !strings.HasSuffix(captured.Cwd, "/main") {
		t.Fatalf("incorrect launch plan: %+v", captured)
	}
	for _, m := range q.Members {
		if m.Path != captured.Cwd && !slices.Contains(captured.AdditionalDirectories, m.Path) {
			t.Fatal("launch did not include participant worktree")
		}
	}
	if err := exec.Command("bash", "-n", captured.Script).Run(); err != nil {
		t.Fatal("invalid launcher shell script", err)
	}
	// Exercise quoting with shell metacharacters, without invoking any real agent.
	unsafe := "abc'; touch SHOULD_NOT_EXIST; $(echo unexpected)"
	cmd := exec.Command("bash", "-c", "printf '%s' "+shellQuote(unsafe))
	out, err := cmd.Output()
	if err != nil || string(out) != unsafe {
		t.Fatalf("quoting failed %s %v", out, err)
	}
	testGit(t, captured.Cwd, "switch", "-c", "changed-branch")
	if code, _ := call(t, a, "POST", "/api/requirements/"+q.ID+"/launch", nil); code != 409 {
		t.Fatal("launch allowed branch drift")
	}
}

func TestArchivePreservesFilesAndProtectsProjectReference(t *testing.T) {
	a := testApp(t)
	id := register(t, a, "Keep", repo(t, "keep", "master"))
	_, q, _ := create(t, a, id, nil, "archive")
	code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/archive", map[string]bool{"archived": true})
	if code != 200 {
		t.Fatal(string(raw))
	}
	for _, m := range q.Members {
		if _, err := os.Stat(m.Path); err != nil {
			t.Fatal("archive removed worktree")
		}
	}
	if code, _ := call(t, a, "DELETE", "/api/projects/"+id, nil); code != 409 {
		t.Fatal("removed referenced project")
	}
	if code, _ := call(t, a, "POST", "/api/requirements/"+q.ID+"/launch", nil); code != 409 {
		t.Fatal("archived requirement launched")
	}
}

func TestLocalAPIRejectsCrossSiteAndStaleToken(t *testing.T) {
	a := testApp(t)
	for _, scenario := range []string{"missing-token", "foreign-origin", "foreign-host"} {
		r := httptest.NewRequest("GET", "http://localhost:4317/api/state", nil)
		r.Header.Set("X-CSRF-Token", a.token)
		switch scenario {
		case "missing-token":
			r.Header.Del("X-CSRF-Token")
		case "foreign-origin":
			r.Header.Set("Origin", "https://example.invalid")
		case "foreign-host":
			r.Host = "example.invalid:4317"
		}
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("accepted %s", scenario)
		}
	}
}
func TestNulParsingAndRenameCounts(t *testing.T) {
	raw := "worktree /tmp/with space\x00HEAD abc\x00branch refs/heads/master\x00\x00worktree /tmp/line\nbreak\x00HEAD def\x00detached\x00locked reason\x00\x00"
	trees := parseWorktrees(raw)
	if len(trees) != 2 || trees[0].Path != "/tmp/with space" || !trees[1].Detached || !trees[1].Locked || trees[1].Path != "/tmp/line\nbreak" {
		t.Fatalf("parse failure %+v", trees)
	}
	if n := dirtyCount("R  new name\x00old name\x00?? untracked\x00"); n != 2 {
		t.Fatalf("rename counted incorrectly: %d", n)
	}
}
