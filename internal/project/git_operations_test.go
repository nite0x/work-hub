package project

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"worktree-hub/internal/model"
)

func TestFetchAuthenticationFailureExplainsTerminalRecovery(t *testing.T) {
	t.Setenv("GIT_ASKPASS", "/bin/false")
	a := testApp(t)
	path := repo(t, "auth-required", "master")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Basic realm="Git test"`)
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, "Authentication required")
	}))
	defer server.Close()
	testGit(t, path, "config", "credential.helper", "")
	testGit(t, path, "remote", "add", "origin", server.URL+"/repo.git")
	id := register(t, a, "Auth", path)
	before := testGit(t, path, "rev-parse", "HEAD")
	code, raw := gitAction(t, a, id, GitAction{Action: "fetch", Remote: "origin"})
	var result struct {
		Error   string   `json:"error"`
		Code    string   `json:"code"`
		Details []string `json:"details"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if code != 409 || result.Code != "authentication_required" || !strings.Contains(result.Error, "终端") || len(result.Details) == 0 {
		t.Fatalf("missing actionable authentication error: %d %s", code, raw)
	}
	if got := testGit(t, path, "rev-parse", "HEAD"); got != before {
		t.Fatal("authentication failure changed checkout")
	}
}

func TestTerminalFetchUsesSelectedRemoteAndPreservesCheckout(t *testing.T) {
	a := testApp(t)
	_, _, clone := remoteClone(t)
	remote := "origin'quoted"
	testGit(t, clone, "remote", "rename", "origin", remote)
	id := register(t, a, "Terminal fetch", clone)
	sentinel := filepath.Join(clone, "unsaved.txt")
	_ = os.WriteFile(sentinel, []byte("keep this"), 0644)
	var captured model.LaunchPlan
	a.Workspace.Launch = func(p model.LaunchPlan, _ func()) error { captured = p; return nil }
	if code, raw := gitAction(t, a, id, GitAction{Action: "fetch_terminal", Remote: "other"}); code != 400 {
		t.Fatalf("unregistered remote accepted: %d %s", code, raw)
	}
	if captured.Script != "" {
		t.Fatal("launched terminal for invalid remote")
	}
	if code, raw := gitAction(t, a, id, GitAction{Action: "fetch_terminal", Remote: remote}); code != 200 || !strings.Contains(string(raw), "刷新列表") {
		t.Fatalf("terminal fetch failed: %d %s", code, raw)
	}
	if captured.Cwd != clone || !strings.Contains(captured.Command, "GIT_TERMINAL_PROMPT=1") {
		t.Fatalf("wrong terminal plan: %+v", captured)
	}
	// Run the generated script against a real bare remote, including its quoting
	// and wildcard mapping; no terminal credentials are involved in this fixture.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bash", captured.Script)
	cmd.Stdin = strings.NewReader("exit\n")
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "获取完成") {
		t.Fatalf("generated terminal script failed: %v %s", err, out)
	}
	v := gitView(t, a, id)
	if v.MasterSource != "refs/remotes/"+remote+"/master" || v.Current != "codex/wsl-startup" || v.Project.HasMaster {
		t.Fatalf("incorrect fetched state: %+v", v)
	}
	if content, _ := os.ReadFile(sentinel); string(content) != "keep this" {
		t.Fatal("terminal fetch changed unsaved files")
	}
	if mode, err := os.Stat(captured.Script); err != nil || mode.Mode().Perm() != 0700 {
		t.Fatal("terminal script must remain private")
	}
	a.Workspace.Launch = func(model.LaunchPlan, func()) error { return fmt.Errorf("terminal unavailable") }
	if code, raw := gitAction(t, a, id, GitAction{Action: "fetch_terminal", Remote: remote}); code != 503 || !strings.Contains(string(raw), "command") {
		t.Fatalf("missing terminal fallback command: %d %s", code, raw)
	}
}
func gitView(t *testing.T, a *App, id string) GitOverview {
	t.Helper()
	code, raw := call(t, a, "GET", "/api/projects/"+id+"/git", nil)
	if code != 200 {
		t.Fatalf("overview %d %s", code, raw)
	}
	var v GitOverview
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func gitAction(t *testing.T, a *App, id string, input GitAction) (int, []byte) {
	t.Helper()
	return call(t, a, "POST", "/api/projects/"+id+"/git", input)
}
func TestFetchNarrowCloneAndPrepareMasterWithoutChangingCheckout(t *testing.T) {
	a := testApp(t)
	_, _, clone := remoteClone(t)
	id := register(t, a, "App", clone)
	v := gitView(t, a, id)
	if v.Project.HasMaster || v.MasterSource != "" || len(v.Remotes) != 1 || v.Current != "codex/wsl-startup" {
		t.Fatalf("incorrect initial state %+v", v)
	}
	_ = os.WriteFile(filepath.Join(clone, "user-unsaved.txt"), []byte("preserve"), 0644)
	if code, raw := gitAction(t, a, id, GitAction{Action: "fetch", Remote: "origin"}); code != 200 {
		t.Fatalf("fetch %d %s", code, raw)
	}
	v = gitView(t, a, id)
	if v.MasterSource != "refs/remotes/origin/master" || v.Project.HasMaster {
		t.Fatalf("did not discover remote master %+v", v)
	}
	if code, raw := gitAction(t, a, id, GitAction{Action: "create_branch", Name: "master", Source: v.MasterSource, Track: true}); code != 200 {
		t.Fatalf("create master %d %s", code, raw)
	}
	if testGit(t, clone, "branch", "--show-current") != "codex/wsl-startup" {
		t.Fatal("preparing master switched original checkout")
	}
	if testGit(t, clone, "rev-parse", "master") != testGit(t, clone, "rev-parse", "origin/master") {
		t.Fatal("master points to wrong baseline")
	}
	if testGit(t, clone, "rev-parse", "--abbrev-ref", "master@{upstream}") != "origin/master" {
		t.Fatal("tracking not configured")
	}
	if b, err := os.ReadFile(filepath.Join(clone, "user-unsaved.txt")); err != nil || string(b) != "preserve" {
		t.Fatal("fetch or branch creation changed local files")
	}
	code, q, raw := create(t, a, id, nil, "after-prepare")
	if code != 201 || q.State != "ready" {
		t.Fatalf("requirement still blocked %d %s", code, raw)
	}
}

func TestGitSwitchProtectsDirtyAndOccupiedWorktrees(t *testing.T) {
	a := testApp(t)
	path := repo(t, "app", "master")
	id := register(t, a, "App", path)
	testGit(t, path, "branch", "feature/unused")
	sentinel := filepath.Join(path, "notes.txt")
	_ = os.WriteFile(sentinel, []byte("unsaved"), 0644)
	if code, raw := gitAction(t, a, id, GitAction{Action: "switch", Source: "refs/heads/feature/unused", Path: path}); code != 409 {
		t.Fatalf("switched dirty checkout %d %s", code, raw)
	}
	if testGit(t, path, "branch", "--show-current") != "master" {
		t.Fatal("dirty branch changed")
	}
	_ = os.Remove(sentinel)
	if code, raw := gitAction(t, a, id, GitAction{Action: "switch", Source: "refs/heads/feature/unused", Path: path}); code != 200 {
		t.Fatalf("clean switch failed %d %s", code, raw)
	}
	other := filepath.Join(t.TempDir(), "occupied")
	testGit(t, path, "worktree", "add", other, "master")
	if code, raw := gitAction(t, a, id, GitAction{Action: "switch", Source: "refs/heads/master", Path: path}); code != 409 || !strings.Contains(string(raw), "worktree") {
		t.Fatalf("occupied branch switch allowed %d %s", code, raw)
	}
	if code, _ := gitAction(t, a, id, GitAction{Action: "terminal", Path: t.TempDir()}); code != 409 {
		t.Fatal("arbitrary terminal directory accepted")
	}
}

func TestFastForwardUnoccupiedMasterAndRejectDivergence(t *testing.T) {
	a := testApp(t)
	seed, remote, clone := remoteClone(t)
	id := register(t, a, "App", clone)
	if code, raw := gitAction(t, a, id, GitAction{Action: "fetch", Remote: "origin"}); code != 200 {
		t.Fatal(string(raw))
	}
	if code, raw := gitAction(t, a, id, GitAction{Action: "create_branch", Name: "master", Source: "refs/remotes/origin/master", Track: true}); code != 200 {
		t.Fatal(string(raw))
	}
	advanceRemote(t, seed, remote, "remote-one.txt")
	if code, raw := gitAction(t, a, id, GitAction{Action: "fetch", Remote: "origin"}); code != 200 {
		t.Fatal(string(raw))
	}
	if code, raw := gitAction(t, a, id, GitAction{Action: "fast_forward", Name: "master", Source: "refs/remotes/origin/master"}); code != 200 {
		t.Fatalf("fast forward failed %d %s", code, raw)
	}
	if testGit(t, clone, "rev-parse", "master") != testGit(t, seed, "rev-parse", "master") {
		t.Fatal("did not update master")
	}
	if testGit(t, clone, "branch", "--show-current") != "codex/wsl-startup" {
		t.Fatal("fast forward switched original worktree")
	}
	if code, raw := gitAction(t, a, id, GitAction{Action: "switch", Path: clone, Source: "refs/heads/master"}); code != 200 {
		t.Fatal(string(raw))
	}
	if code, _ := gitAction(t, a, id, GitAction{Action: "fast_forward", Name: "master", Source: "refs/remotes/origin/master"}); code != 409 {
		t.Fatal("fast forward allowed checked-out branch")
	}
	_ = os.WriteFile(filepath.Join(clone, "local.txt"), []byte("local commit"), 0644)
	testGit(t, clone, "add", "local.txt")
	testGit(t, clone, "commit", "-m", "local divergence")
	localCommit := testGit(t, clone, "rev-parse", "HEAD")
	testGit(t, clone, "switch", "codex/wsl-startup")
	advanceRemote(t, seed, remote, "remote-two.txt")
	if code, raw := gitAction(t, a, id, GitAction{Action: "fetch", Remote: "origin"}); code != 200 {
		t.Fatal(string(raw))
	}
	if code, _ := gitAction(t, a, id, GitAction{Action: "fast_forward", Name: "master", Source: "refs/remotes/origin/master"}); code != 409 {
		t.Fatal("fast forward overwrote divergent commit")
	}
	if testGit(t, clone, "rev-parse", "master") != localCommit {
		t.Fatal("local commit lost")
	}
}

func TestPullOnlyFastForwardAndPreserveDirtyFiles(t *testing.T) {
	a := testApp(t)
	seed, remote, clone := remoteClone(t)
	id := register(t, a, "App", clone)
	gitAction(t, a, id, GitAction{Action: "fetch", Remote: "origin"})
	gitAction(t, a, id, GitAction{Action: "create_branch", Name: "master", Source: "refs/remotes/origin/master", Track: true})
	if code, raw := gitAction(t, a, id, GitAction{Action: "switch", Path: clone, Source: "refs/heads/master"}); code != 200 {
		t.Fatal(string(raw))
	}
	advanceRemote(t, seed, remote, "remote-pull.txt")
	if code, raw := gitAction(t, a, id, GitAction{Action: "pull", Path: clone}); code != 200 {
		t.Fatalf("pull failed %d %s", code, raw)
	}
	if testGit(t, clone, "rev-parse", "HEAD") != testGit(t, seed, "rev-parse", "HEAD") {
		t.Fatal("pull did not advance HEAD")
	}
	_ = os.WriteFile(filepath.Join(clone, "README.md"), []byte("do not discard"), 0644)
	if code, _ := gitAction(t, a, id, GitAction{Action: "pull", Path: clone}); code != 409 {
		t.Fatal("dirty pull accepted")
	}
	if b, _ := os.ReadFile(filepath.Join(clone, "README.md")); string(b) != "do not discard" {
		t.Fatal("dirty files changed")
	}
	testGit(t, clone, "add", "README.md")
	testGit(t, clone, "commit", "-m", "local edit")
	before := testGit(t, clone, "rev-parse", "HEAD")
	advanceRemote(t, seed, remote, "remote-divergence.txt")
	if code, _ := gitAction(t, a, id, GitAction{Action: "pull", Path: clone}); code != 409 {
		t.Fatal("divergent pull merged automatically")
	}
	if testGit(t, clone, "rev-parse", "HEAD") != before {
		t.Fatal("pull altered divergent branch")
	}
}

func TestGitInputsAndTerminalAreScopedToRegisteredRepository(t *testing.T) {
	a := testApp(t)
	path := repo(t, "app", "master")
	id := register(t, a, "App", path)
	for _, in := range []GitAction{{Action: "fetch", Remote: "origin;touch bad"}, {Action: "create_branch", Name: "--force", Source: "HEAD"}, {Action: "create_branch", Name: "valid", Source: "HEAD;touch bad"}, {Action: "create_branch", Name: "master", Source: "HEAD"}, {Action: "reset"}} {
		if code, _ := gitAction(t, a, id, in); code == 200 {
			t.Fatalf("accepted invalid input %+v", in)
		}
	}
	var captured model.LaunchPlan
	a.Workspace.Launch = func(p model.LaunchPlan, _ func()) error { captured = p; return nil }
	if code, raw := gitAction(t, a, id, GitAction{Action: "terminal", Path: path}); code != 200 {
		t.Fatalf("terminal %d %s", code, raw)
	}
	if captured.Cwd != path || !strings.HasPrefix(captured.Title, "Git · ") {
		t.Fatalf("wrong terminal plan %+v", captured)
	}
	if testGit(t, path, "rev-parse", "master") == "" {
		t.Fatal("master was lost")
	}
}
func TestRemoteCredentialsAreNotReturned(t *testing.T) {
	if got := RedactRemote("https://user:password@example.invalid/org/repo.git?access_token=secret"); got != "https://example.invalid/org/repo.git" {
		t.Fatalf("unredacted remote %s", got)
	}
	if got := RedactGitOutput("fatal: 'https://user:password@example.invalid/repo?token=secret'"); strings.Contains(got, "password") || strings.Contains(got, "token=") {
		t.Fatal("credential leak", got)
	}
}
