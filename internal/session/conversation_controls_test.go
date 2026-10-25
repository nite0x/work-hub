package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"worktree-hub/internal/codex"
)

type controlsLive struct {
	*fakeLiveClient
	steers    int
	failSteer bool
}

func (c *controlsLive) Call(ctx context.Context, method string, params any, out any) error {
	var result any
	switch method {
	case "turn/steer":
		c.steers++
		p := params.(map[string]any)
		if p["expectedTurnId"] != "turn" || p["clientUserMessageId"] == nil {
			return fmt.Errorf("missing turn guard or client identity")
		}
		if c.failSteer {
			return fmt.Errorf("connection lost after write")
		}
		result = map[string]any{"turnId": "turn"}
	case "model/list":
		result = map[string]any{"data": []any{map[string]any{"id": "model", "model": "model", "displayName": "Fixture model", "isDefault": true, "defaultReasoningEffort": "medium", "supportedReasoningEfforts": []any{map[string]any{"reasoningEffort": "medium"}, map[string]any{"reasoningEffort": "high"}}}}}
	case "collaborationMode/list":
		result = map[string]any{"data": []any{map[string]any{"mode": "default"}, map[string]any{"mode": "plan"}}}
	default:
		return c.fakeLiveClient.Call(ctx, method, params, out)
	}
	if out != nil {
		raw, _ := json.Marshal(result)
		return json.Unmarshal(raw, out)
	}
	return nil
}
func TestSteeringUsesExactTurnAndPersistsReceipts(t *testing.T) {
	a, _, base, endpoint := chatFixture(t)
	c := &controlsLive{fakeLiveClient: base}
	a.openLive = func(context.Context) (codex.LiveClient, error) { return c, nil }
	startFakeChat(t, a, endpoint)
	payload := map[string]any{"text": "先检查失败的测试", "request_id": "steer-1", "turn_id": "turn"}
	path := "/api/sessions/session/chat/steer"
	for i := 0; i < 2; i++ {
		code, raw := call(t, a, "POST", path, payload)
		if code != 200 || !strings.Contains(string(raw), `"accepted":"steer-1"`) {
			t.Fatalf("%d %s", code, raw)
		}
	}
	if c.steers != 1 {
		t.Fatal("duplicate input", c.steers)
	}
	payload["text"] = "不同内容"
	if code, _ := call(t, a, "POST", path, payload); code != 409 {
		t.Fatal(code)
	}
	payload["request_id"] = "stale"
	payload["turn_id"] = "old-turn"
	if code, _ := call(t, a, "POST", path, payload); code != 409 {
		t.Fatal(code)
	}
	if c.steers != 1 {
		t.Fatal("stale steer sent")
	}
	payload["turn_id"] = "turn"
	payload["request_id"] = "uncertain"
	c.failSteer = true
	for i := 0; i < 2; i++ {
		if code, _ := call(t, a, "POST", path, payload); code != 409 {
			t.Fatal(code)
		}
	}
	if c.steers != 2 {
		t.Fatal("ambiguous steer was repeated")
	}
	base.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	payload["request_id"] = "finished"
	if code, _ := call(t, a, "POST", path, payload); code != 409 {
		t.Fatal("steer started a new turn", code)
	}
}
func TestHistoryAndLiveShareDisplayableToolRecords(t *testing.T) {
	items := []string{
		`{"id":"mcp","type":"mcpToolCall","server":"repo","tool":"search","status":"completed","arguments":{"secret":"SECRET"},"result":{"secret":"SECRET"}}`,
		`{"id":"dynamic","type":"dynamicToolCall","tool":"inspect","status":"failed"}`,
		`{"id":"search","type":"webSearch","query":"Go docs"}`,
		`{"id":"plan","type":"plan","text":"检查并运行测试"}`,
		`{"id":"compact","type":"contextCompaction"}`,
		`{"id":"change","type":"fileChange","status":"completed","changes":[{"path":"a.go","diff":"+ok"}]}`,
	}
	for _, raw := range items {
		var item codexHistoryItem
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			t.Fatal(err)
		}
		saved, ok := visibleHistoryEntry(codexHistoryEntry{TurnID: "turn", Item: item})
		if !ok {
			t.Fatal(item.Type)
		}
		run := &ChatRun{session: "s", state: ChatState{TurnID: "turn"}, notify: make(chan struct{}, 1)}
		params, _ := json.Marshal(map[string]any{"threadId": "s", "turnId": "turn", "item": json.RawMessage(raw)})
		run.handle(codex.Event{Method: "item/completed", Params: params})
		entries := run.snapshot().Entries
		if len(entries) != 1 {
			t.Fatal(entries)
		}
		if saved.Status == "" {
			saved.Status = "completed"
		}
		if !reflect.DeepEqual(entries[0], saved) {
			t.Fatalf("live and saved disagree: %+v / %+v", entries[0], saved)
		}
		wire, _ := json.Marshal(entries)
		if strings.Contains(string(wire), "SECRET") {
			t.Fatal("raw tool payload leaked")
		}
	}
	var reasoning codexHistoryItem
	_ = json.Unmarshal([]byte(`{"id":"internal","type":"reasoning","content":["PRIVATE"]}`), &reasoning)
	if _, ok := visibleHistoryEntry(codexHistoryEntry{Item: reasoning}); ok {
		t.Fatal("internal reasoning rendered")
	}
}
func TestTurnSettingsValidateModelCapabilitiesAndBuildNativeMode(t *testing.T) {
	a, _, base, _ := chatFixture(t)
	c := &controlsLive{fakeLiveClient: base}
	params := map[string]any{}
	if err := a.applyTurnSettings(context.Background(), c, params, TurnSettings{Model: "model", Effort: "high", Mode: "plan"}, "", ""); err != nil {
		t.Fatal(err)
	}
	mode := params["collaborationMode"].(map[string]any)
	settings := mode["settings"].(map[string]any)
	if mode["mode"] != "plan" || settings["model"] != "model" || settings["reasoning_effort"] != "high" || settings["developer_instructions"] != nil {
		t.Fatal(params)
	}
	for _, s := range []TurnSettings{{Model: "unknown"}, {Model: "model", Effort: "ultra"}, {Mode: "invalid"}} {
		if err := a.applyTurnSettings(context.Background(), c, map[string]any{}, s, "", ""); err == nil {
			t.Fatal("invalid settings accepted", s)
		}
	}
}
func TestContextReadNeverResumesOrChangesNativeThread(t *testing.T) {
	a, _, _, _ := chatFixture(t)
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, p map[string]any) (any, error) {
			if method != "thread/read" {
				t.Fatal(method)
			}
			return map[string]any{"thread": map[string]any{"id": "session", "cwd": "/original", "model": "actual-model", "reasoningEffort": "high"}}, nil
		}}, nil
	}
	code, raw := call(t, a, "GET", "/api/sessions/session/context", nil)
	if code != 200 || !strings.Contains(string(raw), "actual-model") || !strings.Contains(string(raw), "/original") {
		t.Fatalf("%d %s", code, raw)
	}
}
func TestDraftStoragePreservesImagesAndRejectsOlderWrites(t *testing.T) {
	a, _, _, _ := chatFixture(t)
	path := "/api/conversation-drafts?key=environment-session"
	draft := map[string]any{"text": "尚未发送", "updated": 20, "settings": map[string]any{"model": "model", "mode": "plan"}, "reading": map[string]any{"top": 230, "bottom": false, "anchor": "message", "offset": 3}, "images": []any{map[string]any{"id": "png", "name": "screen.png", "contentType": "image/png", "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII="}}}
	if code, raw := call(t, a, "POST", path, draft); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	draft["text"] = "old"
	draft["updated"] = 10
	if code, _ := call(t, a, "POST", path, draft); code != 200 {
		t.Fatal(code)
	}
	code, raw := call(t, a, "GET", path, nil)
	if code != 200 || !strings.Contains(string(raw), "尚未发送") || !strings.Contains(string(raw), "image/png;base64") {
		t.Fatalf("%d %s", code, raw)
	}
	if code, raw := call(t, a, "GET", "/api/conversation-drafts?key=other-session", nil); code != 200 || strings.TrimSpace(string(raw)) != "null" {
		t.Fatalf("draft isolation: %d %s", code, raw)
	}
	draft["images"] = []any{map[string]any{"url": "file:///private"}}
	if code, _ := call(t, a, "POST", path, draft); code != 400 {
		t.Fatal(code)
	}
}
func TestManageSessionsRenamesPinsArchivesAndRestores(t *testing.T) {
	a, _, _, _ := chatFixture(t)
	archived := false
	name := "initial"
	nativeCalls := []string{}
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, p map[string]any) (any, error) {
			nativeCalls = append(nativeCalls, method)
			s := codex.Session{ID: "session", Name: name, Cwd: "/repo"}
			switch method {
			case "thread/name/set":
				name = p["name"].(string)
			case "thread/archive":
				archived = true
			case "thread/unarchive":
				archived = false
			case "thread/read":
				return map[string]any{"thread": s}, nil
			case "thread/list":
				rows := []codex.Session{}
				if p["archived"] == archived {
					rows = append(rows, s)
				}
				return codex.SessionPage{Data: rows}, nil
			default:
				return nil, fmt.Errorf("unexpected %s", method)
			}
			return map[string]any{}, nil
		}}, nil
	}
	for _, input := range []map[string]any{{"action": "rename", "name": "新名称"}, {"action": "pin"}, {"action": "archive"}} {
		if code, raw := call(t, a, "POST", "/api/sessions/session/manage", input); code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
	}
	if !archived || name != "新名称" {
		t.Fatal(name, archived)
	}
	record, _ := a.Workspace.Store.Session("session")
	if !record.Pinned || !record.Archived {
		t.Fatal(record)
	}
	code, raw := call(t, a, "GET", "/api/sessions", nil)
	if code != 200 || strings.Contains(string(raw), `"id":"session"`) {
		t.Fatalf("archive still in active list %d %s", code, raw)
	}
	code, raw = call(t, a, "GET", "/api/sessions?archived=true", nil)
	if code != 200 || !strings.Contains(string(raw), `"id":"session"`) {
		t.Fatalf("archive missing %d %s", code, raw)
	}
	if code, raw := call(t, a, "POST", "/api/sessions/session/manage", map[string]any{"action": "restore"}); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	record, _ = a.Workspace.Store.Session("session")
	if record.Archived || !record.Pinned {
		t.Fatal(record)
	}
	if len(nativeCalls) == 0 {
		t.Fatal("organization never reached Codex")
	}
}

func TestForkPreservesDirectorySnapshotAndIsIdempotent(t *testing.T) {
	a, _, _, _ := chatFixture(t)
	forks := 0
	if err := a.Workspace.Store.SaveSessionDirectories("session", []string{"/extra"}); err != nil {
		t.Fatal(err)
	}
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, p map[string]any) (any, error) {
			switch method {
			case "thread/read":
				return map[string]any{"thread": codex.Session{ID: "session", Cwd: "/repo"}}, nil
			case "thread/fork":
				forks++
				if p["lastTurnId"] != "completed-turn" || p["deferGoalContinuation"] != true {
					t.Fatal(p)
				}
				return map[string]any{"thread": codex.Session{ID: "forked", Cwd: "/repo"}}, nil
			case "thread/name/set":
				return map[string]any{}, nil
			default:
				return nil, fmt.Errorf("unexpected call %s", method)
			}
		}}, nil
	}
	payload := map[string]any{"action": "fork", "request_id": "fork-request", "turn_id": "completed-turn"}
	for i := 0; i < 2; i++ {
		if code, raw := call(t, a, "POST", "/api/sessions/session/manage", payload); code != 200 || !strings.Contains(string(raw), "forked") {
			t.Fatalf("%d %s", code, raw)
		}
	}
	if forks != 1 {
		t.Fatal("duplicate fork", forks)
	}
	forked, _ := a.Workspace.Store.Session("forked")
	if !reflect.DeepEqual(forked.AdditionalDirectories, []string{"/extra"}) {
		t.Fatal(forked)
	}
}

// Explicit opt-in: reads only the installed CLI model/mode catalogs. No thread
// is started or resumed and no model request is submitted.
func TestInstalledCodexConversationCatalog(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_TEST_INSTALLED_CODEX") != "1" {
		t.Skip("opt-in installed CLI read-only check")
	}
	ctx, end := context.WithTimeout(context.Background(), 15*time.Second)
	defer end()
	c, err := codex.OpenSessionClient(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	models, err := listChatModels(c.Call)
	if err != nil || len(models) == 0 {
		t.Fatalf("catalog: %d models, %v", len(models), err)
	}
	var modes struct {
		Data []struct {
			Mode string `json:"mode"`
		} `json:"data"`
	}
	if err := c.Call("collaborationMode/list", map[string]any{}, &modes); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range modes.Data {
		found = found || m.Mode == "plan"
	}
	if !found {
		t.Fatal("Plan mode absent from installed CLI")
	}
	t.Logf("installed CLI supports %d models and %d modes", len(models), len(modes.Data))
}
