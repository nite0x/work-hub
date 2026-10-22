package app

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/testutil"
)

func testApp(t *testing.T) *App {
	t.Helper()
	root := t.TempDir()
	a, err := openApp(filepath.Join(root, "data"), filepath.Join(root, "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	a.Projects.CredentialHelper = ""
	t.Cleanup(func() { a.Close() })
	return a
}
func TestLaunchUsesPrimaryAndAllWorktreesWithoutShellInjection(t *testing.T) {
	a := testApp(t)
	a.Workspace.ReadOnlySessions = true
	p1 := register(t, a, "Main", repo(t, "main", "master"))
	p2 := register(t, a, "Other", repo(t, "other", "master"))
	_, q, raw := create(t, a, p1, []string{p2}, "launch")
	if q.State != "ready" {
		t.Fatal(string(raw))
	}
	var captured model.LaunchPlan
	a.Workspace.Launch = func(p model.LaunchPlan, _ func()) error { captured = p; return nil }
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
	cmd := exec.Command("bash", "-c", "printf '%s' "+platform.ShellQuote(unsafe))
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

var (
	testGit       = testutil.Git
	repo          = testutil.Repo
	call          = testutil.Call
	register      = testutil.Register
	create        = testutil.Create
	remoteClone   = testutil.RemoteClone
	advanceRemote = testutil.AdvanceRemote
)
var settledState = testutil.SettledState

func (a *App) TestHandler() http.Handler { return a.handler() }
func (a *App) TestToken() string         { return a.token }
