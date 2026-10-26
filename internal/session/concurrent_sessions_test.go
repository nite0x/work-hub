package session

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"worktree-hub/internal/codex"
)

func awaitSessionRun(t *testing.T, a *App, id string, condition func(ChatState) bool) ChatState {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if run := a.ChatFor(id); run != nil {
			state := run.snapshot()
			if condition(state) {
				return state
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("conversation %s did not reach expected state", id)
	return ChatState{}
}

func TestIndependentConversationsRunInSameDirectory(t *testing.T) {
	for _, createNew := range []bool{false, true} {
		name := "continue"
		if createNew {
			name = "create"
		}
		t.Run(name, func(t *testing.T) {
			a, q, _, firstEndpoint := chatFixture(t)
			startFakeChat(t, a, firstEndpoint)
			cwd := q.Members[0].Path
			// A third conversation owns a managed terminal in this directory.
			a.bridgeMu.Lock()
			a.bridges["other-terminal"] = &terminalBridge{session: "terminal-session", cwd: cwd, connected: true}
			a.bridgeMu.Unlock()
			second := &fakeLiveClient{session: "second", cwd: cwd, updates: make(chan codex.Event, 256)}
			a.openLive = func(context.Context) (codex.LiveClient, error) { return second, nil }
			endpoint := "/api/sessions/second/chat"
			if createNew {
				code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/new", map[string]string{
					"text": "parallel work", "project_id": q.PrimaryProjectID, "request_id": "second-create",
				})
				if code != 202 {
					t.Fatalf("new conversation blocked: %d %s", code, raw)
				}
				var result struct {
					Session codex.Session `json:"session"`
				}
				if err := json.Unmarshal(raw, &result); err != nil || result.Session.ID != "second" {
					t.Fatalf("unexpected conversation: %s (%v)", raw, err)
				}
			} else {
				// Refreshing stale metadata must also allow the actual shared cwd.
				if err := a.SaveSession("", codex.Session{ID: "second", Cwd: q.Path}, "workspace"); err != nil {
					t.Fatal(err)
				}
				if code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "parallel work", "request_id": "second-start"}); code != 202 {
					t.Fatalf("existing conversation blocked: %d %s", code, raw)
				}
			}
			running := awaitSessionRun(t, a, "second", func(s ChatState) bool { return s.Status == "running" })
			if !a.ChatBusy("session") || !running.Busy {
				t.Fatal("both conversations must remain active")
			}
			if code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "duplicate turn", "request_id": "duplicate"}); code != 409 {
				t.Fatalf("same conversation started twice: %d %s", code, raw)
			}
			if code, raw := call(t, a, "POST", "/api/sessions/second/resume", nil); code != 409 {
				t.Fatalf("same conversation resumed in terminal: %d %s", code, raw)
			}
			if code, raw := call(t, a, "POST", endpoint+"/stop", map[string]string{"run_id": running.ID}); code != 200 {
				t.Fatalf("stop: %d %s", code, raw)
			}
			stopped := awaitSessionRun(t, a, "second", func(s ChatState) bool { return !s.Busy })
			if stopped.Status != "interrupted" || !a.ChatBusy("session") {
				t.Fatal("stopping one conversation affected another")
			}
		})
	}
}

func TestTerminalOwnershipIsScopedToConversation(t *testing.T) {
	a, q, _, _ := chatFixture(t)
	cwd := q.Members[0].Path
	a.bridges["terminal"] = &terminalBridge{session: "session", cwd: cwd, connected: true}
	for _, id := range []string{"", "other"} {
		if err := a.AppTerminalConflict(id, cwd); err != nil {
			t.Fatalf("independent conversation %q blocked: %v", id, err)
		}
	}
	if err := a.AppTerminalConflict("session", t.TempDir()); err == nil || !strings.Contains(err.Error(), "保有此会话") {
		t.Fatalf("same conversation lost terminal ownership: %v", err)
	}
}

func TestBridgeOnlyBlocksTheConversationRunningInSidebar(t *testing.T) {
	a, q, _, endpoint := chatFixture(t)
	startFakeChat(t, a, endpoint)
	for _, id := range []string{"other", "session"} {
		t.Run(id, func(t *testing.T) {
			upstream, server := socketPair(t)
			client, terminal := socketPair(t)
			server.SetReadDeadline(time.Now().Add(2 * time.Second))
			terminal.SetReadDeadline(time.Now().Add(2 * time.Second))
			bridge := &terminalBridge{app: a.Service, session: id, cwd: q.Members[0].Path, upstream: upstream, client: client, pending: map[string]bridgeCall{}}
			raw := []byte(`{"id":1,"method":"turn/start","params":{"threadId":"` + id + `"}}`)
			if err := bridge.forward(raw); err != nil {
				t.Fatal(err)
			}
			if id == "session" {
				_, response, err := terminal.ReadMessage()
				if err != nil || !strings.Contains(string(response), "会话正在侧栏运行") {
					t.Fatalf("same conversation was not blocked: %s %v", response, err)
				}
			} else {
				_, response, err := server.ReadMessage()
				if err != nil || string(response) != string(raw) {
					t.Fatalf("independent terminal was not forwarded: %s %v", response, err)
				}
			}
		})
	}
}
