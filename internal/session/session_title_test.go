package session

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"worktree-hub/internal/codex"
)

type titleLiveClient struct {
	*fakeLiveClient
	name      string
	writes    []string
	failWrite bool
}

func (c *titleLiveClient) Call(ctx context.Context, method string, params, out any) error {
	if err := c.fakeLiveClient.Call(ctx, method, params, out); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if method == "thread/name/set" {
		c.writes = append(c.writes, params.(map[string]any)["name"].(string))
		if c.failWrite {
			return fmt.Errorf("uncertain name write")
		}
		c.name = c.writes[len(c.writes)-1]
	}
	if (method == "thread/start" || method == "thread/read") && out != nil {
		raw, _ := json.Marshal(map[string]any{"thread": map[string]any{"name": c.name}})
		return json.Unmarshal(raw, out)
	}
	return nil
}

func TestCodexTitleUpdatesInitialNameAndPreservesItWithoutName(t *testing.T) {
	a, q, c, _ := chatFixture(t)
	endpoint := "/api/requirements/" + q.ID + "/sessions/new"
	text := "这是一条很长的第一条消息，后面还有详细的背景说明和更多处理步骤。"
	code, raw := call(t, a, "POST", endpoint, map[string]string{"text": text, "request_id": "title-create"})
	if code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	var result struct {
		Session RequirementSession `json:"session"`
	}
	_ = json.Unmarshal(raw, &result)
	if result.Session.Name != initialSessionTitle(text) || result.Session.Name == text {
		t.Fatal(result.Session.Name)
	}
	awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
	c.event("thread/name/updated", map[string]any{"threadName": "修复消息回显"})
	awaitChat(t, a, func(s ChatState) bool { return s.SessionName == "修复消息回显" })
	stored, err := a.Workspace.Store.Session("session")
	if err != nil || stored.Name != "修复消息回显" {
		t.Fatalf("%+v %v", stored, err)
	}
	if err := a.SaveSession("", codex.Session{ID: stored.ID, Cwd: stored.Cwd, Preview: "第一条消息仍在 preview 中"}, "codex"); err != nil {
		t.Fatal(err)
	}
	stored, _ = a.Workspace.Store.Session("session")
	if stored.Name != "修复消息回显" {
		t.Fatal(stored.Name)
	}
	c.event("thread/name/updated", map[string]any{"threadId": "another-thread", "threadName": "别的标题"})
	c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	if a.ChatFor("session").snapshot().SessionName != "修复消息回显" {
		t.Fatal("another thread changed the title")
	}
}

func TestSessionNameUsesCodexNameOnly(t *testing.T) {
	if got := sessionName(codex.Session{Name: "Codex 生成标题", Preview: "第一条输入"}); got != "Codex 生成标题" {
		t.Fatal(got)
	}
	if got := sessionName(codex.Session{Preview: "第一条输入"}); got != "" {
		t.Fatal(got)
	}
	if got := sessionName(codex.Session{Name: strings.Repeat("字", 170)}); len([]rune(got)) != 160 {
		t.Fatal("unbounded title")
	}
}

func TestInitialSessionTitleExtractsOnlyShortProse(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"\n## **修复** `标题` 同步\n完整细节", "修复 标题 同步"},
		{"- [ ] 修复 [会话](https://example.com) 名称", "修复 会话 名称"},
		{"![截图](data:image/png;base64,xxx)\n检查图片展示", "检查图片展示"},
		{"```go\nsecret := 1\n```\n修复问题", "修复问题"},
		{"<environment_context>\n秘密上下文\n</environment_context>\n修复问题", "修复问题"},
		{"<environment_context cwd=\"/repo\">\n秘密上下文\n</environment_context>\n修复问题", "修复问题"},
		{"\n---\nhttps://example.com\n继续排查", "继续排查"},
		{"只有图片之前没有正文", "只有图片之前没有正文"},
		{strings.Repeat("字", 40), strings.Repeat("字", 27) + "…"},
		{"\x00修复\u200b标题\x1b", "修复标题"},
		{"```\ncode only\n```", ""},
		{"![图片](path)", ""},
		{"", ""},
	} {
		if got := initialSessionTitle(tc.input); got != tc.want {
			t.Errorf("%q: got %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestNewSessionTitleSyncedOnceAndNeverRecomputed(t *testing.T) {
	a, q, base, endpoint := chatFixture(t)
	c := &titleLiveClient{fakeLiveClient: base}
	a.openLive = func(context.Context) (codex.LiveClient, error) { return c, nil }
	input := map[string]string{"text": "## **修复标题同步**\n后面是很长的具体说明", "request_id": "short-title"}
	create := "/api/requirements/" + q.ID + "/sessions/new"
	if code, raw := call(t, a, "POST", create, input); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
	stored, _ := a.Workspace.Store.Session("session")
	if stored.Name != "修复标题同步" || stored.TitleSource != "initial" {
		t.Fatal(stored)
	}
	if code, _ := call(t, a, "POST", create, input); code != 200 {
		t.Fatal(code)
	}
	base.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	if code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "换一个话题", "request_id": "next-turn"}); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" && s.ID == "next-turn" })
	c.mu.Lock()
	if len(c.writes) != 1 || c.writes[0] != "修复标题同步" {
		t.Error(c.writes)
	}
	c.mu.Unlock()
	base.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
}

func TestNewSessionKeepsCodexNameAndTitleFailureDoesNotBlockChat(t *testing.T) {
	for _, mode := range []string{"existing", "failed", "image"} {
		t.Run(mode, func(t *testing.T) {
			a, q, base, _ := chatFixture(t)
			c := &titleLiveClient{fakeLiveClient: base, failWrite: mode == "failed"}
			if mode == "existing" {
				c.name = "Codex 手动名称"
			}
			a.openLive = func(context.Context) (codex.LiveClient, error) { return c, nil }
			input := map[string]any{"text": "新消息", "request_id": "title-" + mode}
			if mode == "image" {
				input["text"] = ""
				input["images"] = []string{testChatPNG}
			}
			if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/new", input); code != 202 {
				t.Fatalf("%d %s", code, raw)
			}
			state := awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
			stored, _ := a.Workspace.Store.Session("session")
			if mode == "existing" && stored.Name != c.name || mode != "existing" && stored.Name != "" {
				t.Fatal(stored)
			}
			c.mu.Lock()
			writes := len(c.writes)
			c.mu.Unlock()
			if mode == "failed" && (writes != 1 || state.Notice == "") || mode != "failed" && writes != 0 {
				t.Fatal(writes, state.Notice)
			}
			base.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
			awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
		})
	}
}

func TestManualRenameSurvivesDelayedEventsAndEmptyMetadata(t *testing.T) {
	a, _, c, endpoint := chatFixture(t)
	startFakeChat(t, a, endpoint)
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, p map[string]any) (any, error) {
			if method != "thread/name/set" || p["name"] != "我的名称" {
				t.Fatalf("unexpected rename %s %+v", method, p)
			}
			return map[string]any{}, nil
		}}, nil
	}
	if code, raw := call(t, a, "POST", "/api/sessions/session/manage", map[string]string{"action": "rename", "name": "我的名称"}); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	c.event("thread/name/updated", map[string]any{"threadName": "延迟的旧标题"})
	c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	if err := a.SaveSession("", codex.Session{ID: "session", Cwd: c.cwd}, "codex"); err != nil {
		t.Fatal(err)
	}
	stored, _ := a.Workspace.Store.Session("session")
	if stored.Name != "我的名称" || stored.TitleSource != "manual" || a.ChatFor("session").snapshot().SessionName != "我的名称" {
		t.Fatal(stored)
	}
}
