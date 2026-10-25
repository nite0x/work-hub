package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"worktree-hub/internal/codex"
)

func TestNativeActivityIsObservedWithoutTakingOver(t *testing.T) {
	a, q, client, _ := chatFixture(t)
	p := filepath.Join(t.TempDir(), "rollout.jsonl")
	start := `{"type":"event_msg","payload":{"type":"task_started","turn_id":"native"}}` + "\n"
	os.WriteFile(p, []byte(start), 0600)
	native := codex.Session{ID: "session", Cwd: q.Members[0].Path, Path: p}
	native.Status.Type = "notLoaded"
	a.chats["session"] = &ChatRun{state: ChatState{ID: "old-owned-run", TurnID: "old-turn", Status: "completed"}}
	defer delete(a.chats, "session")
	fakeSessions(a, map[string]codex.Session{"session": native})
	code, raw := call(t, a, "GET", "/api/sessions/session/chat", nil)
	var state ChatState
	json.Unmarshal(raw, &state)
	if code != 200 || !state.Busy || !state.External || state.Status != "running" || state.ID != "" {
		t.Fatalf("%d %s", code, raw)
	}
	code, raw = call(t, a, "GET", "/api/sessions", nil)
	if code != 200 || !strings.Contains(string(raw), `"chat_status":"running"`) {
		t.Fatalf("%d %s", code, raw)
	}
	code, _ = call(t, a, "POST", "/api/sessions/session/chat", map[string]string{"text": "duplicate", "request_id": "new"})
	if code != 409 {
		t.Fatal(code)
	}
	if len(client.methods) != 0 {
		t.Fatal("observer controlled native run", client.methods)
	}
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString(`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"native"}}` + "\n")
	f.Close()
	code, raw = call(t, a, "GET", "/api/sessions/session/chat", nil)
	json.Unmarshal(raw, &state)
	if code != 200 || state.Busy || state.Status != "completed" {
		t.Fatalf("%d %s", code, raw)
	}
}
func TestSessionImageReferencesAreAuthenticatedBoundedAndScoped(t *testing.T) {
	a, q, _, _ := chatFixture(t)
	image := filepath.Join(t.TempDir(), "截图 (1).png")
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=")
	os.WriteFile(image, png, 0600)
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, p map[string]any) (any, error) {
			switch method {
			case "thread/read":
				return map[string]any{"thread": codex.Session{ID: "session", Cwd: q.Members[0].Path, HistoryMode: "paginated"}}, nil
			case "thread/items/list":
				return map[string]any{"data": []any{map[string]any{"turnId": "turn", "item": map[string]any{"id": "answer", "type": "agentMessage", "text": fmt.Sprintf("![结果](<%s>)", image)}}}}, nil
			}
			return nil, fmt.Errorf("unexpected call %s", method)
		}}, nil
	}
	code, raw := call(t, a, "GET", "/api/sessions/session/history", nil)
	var history SessionHistory
	json.Unmarshal(raw, &history)
	if code != 200 || len(history.Entries) != 1 {
		t.Fatalf("%d %s", code, raw)
	}
	ref := history.Entries[0].LocalImages[image]
	if ref == "" {
		t.Fatal("image reference missing")
	}
	endpoint := "/api/sessions/session/image?ref=" + url.QueryEscape(ref)
	code, raw = call(t, a, "GET", endpoint, nil)
	if code != 200 || !strings.Contains(string(raw), "data:image/png;base64,") {
		t.Fatalf("%d %s", code, raw)
	}
	code, _ = call(t, a, "GET", endpoint+"tampered", nil)
	if code != 403 {
		t.Fatal(code)
	}
	a.SaveSession("", codex.Session{ID: "other", Cwd: q.Members[0].Path}, "workspace")
	code, _ = call(t, a, "GET", strings.Replace(endpoint, "/session/image", "/other/image", 1), nil)
	if code != 403 {
		t.Fatal("cross-session token accepted", code)
	}
	os.WriteFile(image, []byte("not an image"), 0600)
	code, _ = call(t, a, "GET", endpoint, nil)
	if code != 404 {
		t.Fatal(code)
	}
	os.Remove(image)
	code, _ = call(t, a, "GET", endpoint, nil)
	if code != 404 {
		t.Fatal(code)
	}
}
