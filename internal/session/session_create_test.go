package session

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"worktree-hub/internal/codex"
)

func TestNewSessionStartsFirstTurnOnCreatingConnectionAndIsIdempotent(t *testing.T) {
	a, q, c, _ := chatFixture(t)
	_, _ = a.Workspace.Store.DB.Exec(`DELETE FROM requirement_sessions WHERE requirement_id=?`, q.ID)
	endpoint := "/api/requirements/" + q.ID + "/sessions/new"
	input := map[string]string{"text": "检查任务说明并继续实现", "project_id": q.PrimaryProjectID, "request_id": "create-once"}
	code, raw := call(t, a, "POST", endpoint, input)
	if code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	var result struct {
		Session RequirementSession `json:"session"`
	}
	_ = json.Unmarshal(raw, &result)
	if result.Session.ID != "session" || result.Session.Source != "workbench" {
		t.Fatal(string(raw))
	}
	awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
	if code, _ := call(t, a, "POST", endpoint, input); code != 200 {
		t.Fatal("retry was not recovered")
	}
	c.mu.Lock()
	methods := strings.Join(c.methods, ",")
	params := c.startParams
	c.mu.Unlock()
	if strings.Count(methods, "thread/start") != 1 || strings.Contains(methods, "thread/read") || strings.Contains(methods, "thread/resume") {
		t.Fatal(methods)
	}
	if params["cwd"] != q.Members[0].Path {
		t.Fatal(params)
	}
	if code, _ := call(t, a, "POST", "/api/requirements/"+q.ID+"/launch", nil); code != 409 {
		t.Fatal("terminal launched during first sidebar turn")
	}
	c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
}

type failingCreateClient struct{ *fakeLiveClient }

func (c *failingCreateClient) Call(ctx context.Context, method string, params, out any) error {
	if method == "thread/start" {
		c.mu.Lock()
		c.methods = append(c.methods, method)
		c.mu.Unlock()
		return fmt.Errorf("uncertain transport")
	}
	return c.fakeLiveClient.Call(ctx, method, params, out)
}
func TestUncertainNewSessionNeverCreatesAgainOnRetry(t *testing.T) {
	a, q, c, _ := chatFixture(t)
	a.openLive = func(context.Context) (codex.LiveClient, error) { return &failingCreateClient{c}, nil }
	endpoint := "/api/requirements/" + q.ID + "/sessions/new"
	input := map[string]string{"text": "hello", "request_id": "uncertain"}
	if code, _ := call(t, a, "POST", endpoint, input); code != 503 {
		t.Fatal(code)
	}
	if code, _ := call(t, a, "POST", endpoint, input); code != 409 {
		t.Fatal(code)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if strings.Count(strings.Join(c.methods, ","), "thread/start") != 1 {
		t.Fatal(c.methods)
	}
}
func TestNewSessionRejectsForeignProjectsAndArchivedRequirements(t *testing.T) {
	a, q, c, _ := chatFixture(t)
	endpoint := "/api/requirements/" + q.ID + "/sessions/new"
	if code, _ := call(t, a, "POST", endpoint, map[string]string{"text": "hello", "request_id": "foreign", "project_id": "foreign"}); code != 400 {
		t.Fatal(code)
	}
	_, _ = a.Workspace.Store.DB.Exec(`UPDATE requirements SET state='archived' WHERE id=?`, q.ID)
	if code, _ := call(t, a, "POST", endpoint, map[string]string{"text": "hello", "request_id": "archived"}); code != 409 {
		t.Fatal(code)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.methods) != 0 {
		t.Fatal(c.methods)
	}
}
