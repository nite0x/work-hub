package project

import (
	"net/http"
	"path/filepath"
	"testing"

	"worktree-hub/internal/model"
	"worktree-hub/internal/overview"
	"worktree-hub/internal/task"
	"worktree-hub/internal/testutil"
	"worktree-hub/internal/workspace"
)

type App struct {
	*Service
	Tasks *task.Service
	token string
}

func openApp(dataDir, root string) (*App, error) {
	env, err := workspace.Open(dataDir, root, nil)
	if err != nil {
		return nil, err
	}
	tasks := task.New(env)
	return &App{Service: New(env), Tasks: tasks, token: model.NewID()}, nil
}

func testApp(t *testing.T) *App {
	t.Helper()
	root := t.TempDir()
	a, err := openApp(filepath.Join(root, "data"), filepath.Join(root, "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	a.CredentialHelper = ""
	t.Cleanup(func() { a.cache.Close(); a.Workspace.Close() })
	return a
}

func (a *App) handler() http.Handler {
	return testutil.Handler(a.Workspace, a.token, a.Service, a.RegisterRoutes, func(mux *http.ServeMux) { a.Tasks.RegisterRoutes(mux, a.Service.InvalidateStateAfter) })
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

func (a *App) TestHandler() http.Handler { return a.handler() }
func (a *App) TestToken() string         { return a.token }

func (a *App) StateHandler(w http.ResponseWriter, r *http.Request) {
	overview.New(a.Workspace, a.Service).ServeHTTP(w, r)
}
