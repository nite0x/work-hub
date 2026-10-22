package session

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"worktree-hub/internal/codex"
)

func TestSessionHistoryIsReadOnlyScopedAndChronological(t *testing.T) {
	a := testApp(t)
	p := register(t, a, "Repo", repo(t, "repo", "master"))
	_, q, _ := create(t, a, p, nil, "history")
	s := codex.Session{ID: "linked", Name: "工作记录", Cwd: q.Members[0].Path, HistoryMode: "paginated"}
	if err := a.SaveSession(q.ID, s, "workspace"); err != nil {
		t.Fatal(err)
	}
	requests := []string{}
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, params map[string]any) (any, error) {
			requests = append(requests, method)
			if params["threadId"] != "linked" {
				t.Fatal(params)
			}
			switch method {
			case "thread/read":
				if params["includeTurns"] != false {
					t.Fatal("metadata read loaded turns")
				}
				return map[string]any{"thread": s}, nil
			case "thread/items/list":
				if params["sortDirection"] != "desc" || params["limit"] != 50 || params["cursor"] != "opaque cursor" {
					t.Fatal(params)
				}
				return map[string]any{"nextCursor": "older", "data": []any{
					map[string]any{"turnId": "turn1", "startedAtMs": 1700000003000, "item": map[string]any{"id": "reply", "type": "agentMessage", "text": "修改已完成。"}},
					map[string]any{"turnId": "turn1", "item": map[string]any{"id": "command", "type": "commandExecution", "command": "go test ./...", "cwd": s.Cwd, "status": "completed", "aggregatedOutput": "ok <test>", "exitCode": 0, "durationMs": 1234}},
					map[string]any{"turnId": "turn1", "item": map[string]any{"id": "private", "type": "reasoning", "content": []string{"PRIVATE_REASONING"}, "summary": []string{"INTERNAL_SUMMARY"}}},
					map[string]any{"turnId": "turn1", "item": map[string]any{"id": "user", "type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "请修复问题"}, map[string]any{"type": "image", "url": "data:image/png;base64,PRIVATE_IMAGE"}}}},
				}}, nil
			default:
				return nil, fmt.Errorf("must not run or resume a session: %s", method)
			}
		}}, nil
	}
	code, raw := call(t, a, "GET", "/api/requirements/"+q.ID+"/sessions/linked/history?cursor=opaque%20cursor", nil)
	if code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	var history SessionHistory
	if err := json.Unmarshal(raw, &history); err != nil {
		t.Fatal(err)
	}
	if len(history.Entries) != 3 || history.Entries[0].Kind != "user" || history.Entries[1].Kind != "command" || history.Entries[2].Kind != "assistant" {
		t.Fatalf("wrong sequence %+v", history.Entries)
	}
	command := history.Entries[1]
	if command.ExitCode == nil || *command.ExitCode != 0 || command.Output == nil || *command.Output != "ok <test>" || command.DurationMs == nil || *command.DurationMs != 1234 {
		t.Fatalf("incomplete command %+v", command)
	}
	if history.Entries[2].StartedAtMs == nil || *history.Entries[2].StartedAtMs != 1700000003000 || history.NextCursor == nil || *history.NextCursor != "older" {
		t.Fatal(history)
	}
	if strings.Contains(string(raw), "PRIVATE_") || strings.Contains(string(raw), "INTERNAL_SUMMARY") {
		t.Fatal("internal content forwarded to browser")
	}
	if !reflect.DeepEqual(requests, []string{"thread/read", "thread/items/list"}) {
		t.Fatal(requests)
	}
	requests = nil
	if code, _ := call(t, a, "GET", "/api/requirements/"+q.ID+"/sessions/unlinked/history", nil); code != 404 || len(requests) != 0 {
		t.Fatal("unlinked history queried Codex")
	}
	_, other, _ := create(t, a, p, nil, "other-history")
	if code, _ := call(t, a, "GET", "/api/requirements/"+other.ID+"/sessions/linked/history", nil); code != 404 || len(requests) != 0 {
		t.Fatal("cross-requirement history exposed")
	}
	if code, _ := call(t, a, "GET", "/api/requirements/missing/sessions/linked/history", nil); code != 404 {
		t.Fatal(code)
	}
}

func TestLegacySessionHistoryPaginationAndEmptyPages(t *testing.T) {
	c := &fakeSessionClient{request: func(method string, params map[string]any) (any, error) {
		if method != "thread/turns/list" || params["itemsView"] != "full" || params["limit"] != 5 || params["cursor"] != "older-turn" {
			t.Fatal(method, params)
		}
		return map[string]any{"data": []any{
			map[string]any{"id": "newer", "items": []any{map[string]any{"id": "command", "type": "commandExecution", "command": "false", "status": "failed", "exitCode": 1}, map[string]any{"id": "reply", "type": "agentMessage", "text": "执行失败"}}},
			map[string]any{"id": "older", "items": []any{map[string]any{"id": "user", "type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "检查项目"}}}}},
		}}, nil
	}}
	history, err := readSessionHistory(c, codex.Session{ID: "legacy", HistoryMode: "legacy"}, "older-turn")
	if err != nil || len(history.Entries) != 3 || history.Entries[0].TurnID != "older" || history.Entries[1].ID != "command" || history.Entries[2].ID != "reply" || history.NextCursor != nil {
		t.Fatal(history, err)
	}
	if history.Entries[1].Output != nil || history.Entries[1].ExitCode == nil || *history.Entries[1].ExitCode != 1 {
		t.Fatal(history.Entries[1])
	}
	c.request = func(string, map[string]any) (any, error) {
		return map[string]any{"data": []any{}, "nextCursor": "next"}, nil
	}
	history, err = readSessionHistory(c, codex.Session{HistoryMode: "paginated"}, "")
	if err != nil || history.Entries == nil || len(history.Entries) != 0 || history.NextCursor == nil {
		t.Fatal(history, err)
	}
}

func TestSessionHistoryFailurePreservesAssociation(t *testing.T) {
	a := testApp(t)
	p := register(t, a, "Repo", repo(t, "repo", "master"))
	_, q, _ := create(t, a, p, nil, "history-error")
	if err := a.SaveSession(q.ID, codex.Session{ID: "missing", Cwd: q.Path}, "manual"); err != nil {
		t.Fatal(err)
	}
	fakeSessions(a, map[string]codex.Session{})
	endpoint := "/api/requirements/" + q.ID + "/sessions/missing/history"
	if code, raw := call(t, a, "GET", endpoint, nil); code != 503 || !strings.Contains(string(raw), "无法读取会话详情") {
		t.Fatalf("%d %s", code, raw)
	}
	stored, err := a.StoredSessions(q.ID)
	if err != nil || len(stored) != 1 {
		t.Fatal(stored, err)
	}
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, params map[string]any) (any, error) {
			if method == "thread/read" {
				return map[string]any{"thread": codex.Session{ID: "missing", Cwd: q.Path, HistoryMode: "paginated"}}, nil
			}
			return nil, fmt.Errorf("history unavailable")
		}}, nil
	}
	if code, raw := call(t, a, "GET", endpoint, nil); code != 503 || !strings.Contains(string(raw), "history unavailable") {
		t.Fatalf("%d %s", code, raw)
	}
}
