package session

import (
	"context"
	"encoding/json"
	"net/url"
	"testing"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/model"
)

func TestTaskLinksAreExplicitAndSurviveDirectoryChanges(t *testing.T) {
	a, q, _, _ := chatFixture(t)
	_, other, _ := create(t, a, q.PrimaryProjectID, nil, "shared-links")
	fakeSessions(a, map[string]codex.Session{
		"directory-only": {ID: "directory-only", Cwd: q.Members[0].Path},
		"linked":         {ID: "linked", Cwd: q.Members[0].Path},
		"outside":        {ID: "outside", Cwd: other.Members[0].Path},
	})
	list := func(task, extra string) []model.Session {
		t.Helper()
		code, raw := call(t, a, "GET", "/api/sessions?task_id="+task+"&linked=true"+extra, nil)
		var result struct {
			Sessions []model.Session `json:"sessions"`
		}
		if err := json.Unmarshal(raw, &result); err != nil || code != 200 {
			t.Fatalf("list %d %s %v", code, raw, err)
		}
		return result.Sessions
	}
	if got := list(q.ID, ""); len(got) != 0 {
		t.Fatal("directory discovery appeared as an explicit reference", got)
	}
	for _, id := range []string{"linked", "outside"} {
		if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions", map[string]string{"session_id": id}); code != 200 {
			t.Fatalf("link %d %s", code, raw)
		}
	}
	if got := list(q.ID, ""); len(got) != 2 {
		t.Fatal(got)
	}
	if got := list(q.ID, "&cwd="+url.QueryEscape(q.Members[0].Path)); len(got) != 1 || got[0].ID != "linked" {
		t.Fatal("directory filter widened explicit references", got)
	}
	if code, _ := call(t, a, "POST", "/api/requirements/"+other.ID+"/sessions", map[string]string{"session_id": "linked"}); code != 200 {
		t.Fatal(code)
	}
	_, err := a.Workspace.Store.DB.Exec(`UPDATE members SET path=? WHERE requirement_id=?`, other.Members[0].Path, q.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := list(q.ID, ""); len(got) != 2 {
		t.Fatal("changing directory lost references", got)
	}
	if code, raw := call(t, a, "DELETE", "/api/requirements/"+q.ID+"/sessions/linked", nil); code != 200 {
		t.Fatalf("unlink %d %s", code, raw)
	}
	if got := list(q.ID, ""); len(got) != 1 || got[0].ID != "outside" {
		t.Fatal(got)
	}
	if got := list(other.ID, ""); len(got) != 1 || got[0].ID != "linked" {
		t.Fatal("unlink affected another task", got)
	}
	saved, err := a.Workspace.Store.Session("linked")
	if err != nil || saved.Cwd != q.Members[0].Path {
		t.Fatal("unlink changed session", saved, err)
	}
}

func TestNewTaskConversationReferencesTheTaskAndSkipsFailedMembers(t *testing.T) {
	a, q, c, _ := chatFixture(t)
	other := register(t, a, "Other", repo(t, "other", "master"))
	if _, err := a.Workspace.Store.DB.Exec(`INSERT INTO members(requirement_id,project_id,path,base_commit,state,mode,error) VALUES(?,?,?,'','failed','project','not ready');UPDATE requirements SET state='partial' WHERE id=?`, q.ID, other, "/missing-checkout", q.ID); err != nil {
		t.Fatal(err)
	}
	empty := []string{}
	plan, err := a.resolveCreation(context.Background(), SessionTarget{TaskID: q.ID, ProjectID: q.PrimaryProjectID, AdditionalDirectories: &empty})
	if err != nil || plan.plan.Cwd != q.Members[0].Path || len(plan.plan.AdditionalDirectories) != 0 {
		t.Fatalf("ready member blocked: %+v %v", plan, err)
	}
	outside := []string{"/not-a-task-directory"}
	if _, err := a.resolveCreation(context.Background(), SessionTarget{TaskID: q.ID, ProjectID: q.PrimaryProjectID, AdditionalDirectories: &outside}); err == nil {
		t.Fatal("accepted foreign additional directory")
	}
	code, raw := call(t, a, "POST", "/api/sessions/new", map[string]any{"task_id": q.ID, "project_id": q.PrimaryProjectID, "additional_directories": []string{}, "text": "continue", "request_id": "partial-task"})
	if code != 202 {
		t.Fatalf("create %d %s", code, raw)
	}
	awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
	pins, err := a.Workspace.Store.PinnedSessionIDs(q.ID)
	if err != nil || !pins["session"] {
		t.Fatal("new task conversation was not explicitly referenced", pins, err)
	}
	saved, err := a.Workspace.Store.Session("session")
	if err != nil || len(saved.AdditionalDirectories) != 0 {
		t.Fatal(saved, err)
	}
	if code, raw := call(t, a, "DELETE", "/api/requirements/"+q.ID+"/sessions/session", nil); code != 200 {
		t.Fatalf("unlink running %d %s", code, raw)
	}
	if run := a.ChatFor("session"); run == nil || !run.snapshot().Busy {
		t.Fatal("unlink stopped the session")
	}
	c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
}
