package session

import (
	"context"
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"worktree-hub/internal/codex"
)

func TestBrowserTaskProjectsFixture(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_BROWSER_PROJECTS") != "1" {
		t.Skip("opt-in browser fixture")
	}
	a := testApp(t)
	primary := register(t, a, "Frontend", repo(t, "frontend", "master"))
	register(t, a, "Backend", repo(t, "backend", "master"))
	unregistered := repo(t, "worker", "master")
	_, q, _ := create(t, a, primary, nil, "task-projects")
	_, _ = a.Workspace.Store.DB.Exec(`UPDATE requirements SET name='添加项目验证' WHERE id=?`, q.ID)
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(string, map[string]any) (any, error) {
			return codex.SessionPage{Data: []codex.Session{}}, nil
		}}, nil
	}
	server := httptest.NewUnstartedServer(a.handler())
	listener, err := net.Listen("tcp", "127.0.0.1:44318")
	if err != nil {
		t.Fatal(err)
	}
	server.Listener = listener
	server.Start()
	defer server.Close()
	fmt.Printf("PROJECTS_FIXTURE_READY http://localhost:44318/#/requirements/%s\nUNREGISTERED_PROJECT %s\n", q.ID, unregistered)
	time.Sleep(10 * time.Minute)
}
