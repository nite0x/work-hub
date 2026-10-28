package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/model"
	"worktree-hub/internal/project"
	"worktree-hub/internal/task"
	"worktree-hub/internal/testutil"
	"worktree-hub/internal/workspace"
)

type App struct {
	*Service
	Projects *project.Service
	Tasks    *task.Service
	token    string
}

func openApp(dataDir, root string) (*App, error) {
	env, err := workspace.Open(dataDir, root, nil)
	if err != nil {
		return nil, err
	}
	tasks := task.New(env)
	return &App{Service: New(env, tasks), Projects: project.New(env), Tasks: tasks, token: model.NewID()}, nil
}

func testApp(t *testing.T) *App {
	t.Helper()
	root := t.TempDir()
	a, err := openApp(filepath.Join(root, "data"), filepath.Join(root, "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	a.Projects.CredentialHelper = ""
	a.openTitleLive = func(context.Context) (codex.LiveClient, error) {
		return nil, fmt.Errorf("title generation is mocked in tests")
	}
	t.Cleanup(func() { a.CloseChats(); a.CloseBridges(); a.Projects.Close(); a.Workspace.Close() })
	return a
}

func (a *App) handler() http.Handler {
	return testutil.Handler(a.Workspace, a.token, a.Projects, a.Projects.RegisterRoutes, func(mux *http.ServeMux) { a.Tasks.RegisterRoutes(mux, a.Projects.InvalidateStateAfter) }, a.RegisterRoutes)
}
func gitView(t *testing.T, a *App, id string) project.GitOverview {
	t.Helper()
	code, raw := call(t, a, "GET", "/api/projects/"+id+"/git", nil)
	if code != 200 {
		t.Fatalf("overview %d %s", code, raw)
	}
	var v project.GitOverview
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func gitAction(t *testing.T, a *App, id string, input project.GitAction) (int, []byte) {
	t.Helper()
	return call(t, a, "POST", "/api/projects/"+id+"/git", input)
}

func TestWorkspaceAgentProcess(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_AGENT_TEST") != "1" {
		return
	}
	err := workspace.RunAgent(os.Stdin, os.Stdout, workspace.AgentHooks{WatchHistory: WatchCodexHistoryRaw})
	if err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}
func testWorkspaceClient(t *testing.T) *workspace.Client {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestWorkspaceAgentProcess$")
	cmd.Env = append(os.Environ(), "WORKTREE_HUB_AGENT_TEST=1")
	c, err := workspace.StartClient(cmd)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return c
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
