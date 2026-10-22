package task

import (
	"net/http"
	"path/filepath"
	"testing"

	"worktree-hub/internal/model"
	"worktree-hub/internal/project"
	"worktree-hub/internal/testutil"
	"worktree-hub/internal/workspace"
)

type App struct {
	*Service
	Projects *project.Service
	token    string
}

func openApp(dataDir, root string) (*App, error) {
	env, err := workspace.Open(dataDir, root, nil)
	if err != nil {
		return nil, err
	}
	projects := project.New(env)
	return &App{Service: New(env), Projects: projects, token: model.NewID()}, nil
}

func testApp(t *testing.T) *App {
	t.Helper()
	root := t.TempDir()
	a, err := openApp(filepath.Join(root, "data"), filepath.Join(root, "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	a.Projects.CredentialHelper = ""
	t.Cleanup(func() { a.Projects.Close(); a.Workspace.Close() })
	return a
}

func (a *App) handler() http.Handler {
	return testutil.Handler(a.Workspace, a.token, a.Projects, a.Projects.RegisterRoutes, func(mux *http.ServeMux) { a.RegisterRoutes(mux, a.Projects.InvalidateStateAfter) })
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
