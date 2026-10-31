package testutil

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"worktree-hub/internal/model"
	"worktree-hub/internal/workspace"
)

type Server interface {
	TestHandler() http.Handler
	TestToken() string
}

// TempDir uses the same canonical directory spelling as Git and workspace.Open.
// macOS's default temporary root contains a /var -> /private/var alias.
func TempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func Git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	v, err := workspace.Git(context.Background(), dir, args...)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(v)
}

func Repo(t *testing.T, name, branch string) string {
	t.Helper()
	path := filepath.Join(TempDir(t), name)
	if err := os.Mkdir(path, 0755); err != nil {
		t.Fatal(err)
	}
	Git(t, path, "init", "-b", branch)
	Git(t, path, "config", "user.name", "Worktree Hub Test")
	Git(t, path, "config", "user.email", "test@example.invalid")
	if err := os.WriteFile(filepath.Join(path, "README.md"), []byte("baseline\n"), 0644); err != nil {
		t.Fatal(err)
	}
	Git(t, path, "add", "README.md")
	Git(t, path, "commit", "-m", "baseline")
	return path
}

func Call(t *testing.T, a Server, method, path string, body any) (int, []byte) {
	t.Helper()
	data, _ := json.Marshal(body)
	r := httptest.NewRequest(method, "http://localhost:4317"+path, strings.NewReader(string(data)))
	r.Header.Set("X-CSRF-Token", a.TestToken())
	r.Header.Set("Origin", "http://localhost:4317")
	w := httptest.NewRecorder()
	a.TestHandler().ServeHTTP(w, r)
	return w.Code, w.Body.Bytes()
}

func Register(t *testing.T, a Server, name, path string) string {
	t.Helper()
	code, raw := Call(t, a, "POST", "/api/projects", map[string]string{"name": name, "path": path})
	if code != 201 {
		t.Fatalf("register %d: %s", code, raw)
	}
	var v map[string]string
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v["id"]
}

func Create(t *testing.T, a Server, primary string, others []string, slug string) (int, model.Requirement, []byte) {
	t.Helper()
	code, raw := Call(t, a, "POST", "/api/requirements", map[string]any{"name": "订单审批 '$(touch SHOULD_NOT_EXIST)'", "slug": slug, "description": "前后端联调", "primary_project_id": primary, "project_ids": others})
	var q model.Requirement
	_ = json.Unmarshal(raw, &q)
	return code, q, raw
}

func RemoteClone(t *testing.T) (seed, remote, clone string) {
	t.Helper()
	seed = Repo(t, "seed", "master")
	root := TempDir(t)
	remote = filepath.Join(root, "origin.git")
	clone = filepath.Join(root, "checkout")
	Git(t, seed, "branch", "codex/wsl-startup")
	Git(t, root, "clone", "--bare", seed, remote)
	Git(t, root, "clone", "--single-branch", "--branch", "codex/wsl-startup", remote, clone)
	Git(t, clone, "config", "user.name", "Worktree Hub Test")
	Git(t, clone, "config", "user.email", "test@example.invalid")
	return
}

func AdvanceRemote(t *testing.T, seed, remote, name string) {
	t.Helper()
	_ = os.WriteFile(filepath.Join(seed, name), []byte(name), 0644)
	Git(t, seed, "add", name)
	Git(t, seed, "commit", "-m", name)
	Git(t, seed, "push", remote, "master")
}

type stateSnapshot struct {
	Projects   []model.Project `json:"projects"`
	Refreshing bool            `json:"status_refreshing"`
}

func awaitState(t *testing.T, a Server, accept func(stateSnapshot) bool) []byte {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, raw := Call(t, a, "GET", "/api/state", nil)
		var state stateSnapshot
		if code != 200 || json.Unmarshal(raw, &state) != nil {
			t.Fatalf("state: %d %s", code, raw)
		}
		if accept(state) {
			return raw
		}
		if time.Now().After(deadline) {
			t.Fatalf("state did not converge: %s", raw)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func SettledState(t *testing.T, a Server) (int, []byte) {
	t.Helper()
	return 200, awaitState(t, a, func(s stateSnapshot) bool { return !s.Refreshing })
}
