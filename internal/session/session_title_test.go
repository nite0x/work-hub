package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"worktree-hub/internal/codex"
)

type titleLiveClient struct {
	*fakeLiveClient
	name              string
	writes            []string
	failWrite         bool
	summary           string
	summaryStatus     string
	summaryParams     map[string]any
	summaryTurnParams map[string]any
	summaryCount      int
	summaryStarted    chan struct{}
	summaryRelease    chan struct{}
	summaryEvents     chan codex.Event
	summaryClosed     chan struct{}
}

// Naming has a different event stream from the main conversation, while both
// connections see the same Codex thread names.
type titleConnection struct{ *titleLiveClient }

func (c *titleConnection) Events() <-chan codex.Event { return c.summaryEvents }
func (c *titleConnection) Close()                     { close(c.summaryClosed) }

func useTitleClient(a *App, c *titleLiveClient) {
	c.summaryEvents = make(chan codex.Event, 16)
	c.summaryClosed = make(chan struct{})
	a.openLive = func(context.Context) (codex.LiveClient, error) { return c, nil }
	a.openTitleLive = func(context.Context) (codex.LiveClient, error) { return &titleConnection{c}, nil }
}

func (c *titleLiveClient) summaryEvent(method string, params map[string]any) {
	raw, _ := json.Marshal(params)
	c.summaryEvents <- codex.Event{Method: method, Params: raw}
}

func (c *titleLiveClient) Call(ctx context.Context, method string, params, out any) error {
	p, _ := params.(map[string]any)
	if method == "thread/start" && p["ephemeral"] == true {
		c.mu.Lock()
		c.summaryCount++
		c.summaryParams = p
		c.mu.Unlock()
		raw := []byte(`{"thread":{"id":"title-generator"}}`)
		return json.Unmarshal(raw, out)
	}
	if p["threadId"] == "title-generator" {
		if method == "turn/start" {
			c.mu.Lock()
			c.summaryTurnParams = p
			c.mu.Unlock()
			if c.summaryStarted != nil {
				close(c.summaryStarted)
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-c.summaryRelease:
				}
			}
			if c.summary == "error" {
				return fmt.Errorf("generation unavailable")
			}
			status := c.summaryStatus
			if status == "" {
				status = "completed"
			}
			c.summaryEvent("item/completed", map[string]any{"threadId": "unrelated", "turnId": "summary-turn", "item": map[string]any{"id": "other", "type": "agentMessage", "text": `{"title":"错误的线程"}`}})
			c.summaryEvent("item/completed", map[string]any{"threadId": "title-generator", "turnId": "summary-turn", "item": map[string]any{"id": "summary", "type": "agentMessage", "text": c.summary}})
			c.summaryEvent("turn/completed", map[string]any{"threadId": "title-generator", "turn": map[string]any{"id": "summary-turn", "status": status}})
			return json.Unmarshal([]byte(`{"turn":{"id":"summary-turn"}}`), out)
		}
		return nil
	}
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

func finishTitleChat(t *testing.T, c *fakeLiveClient) {
	t.Helper()
	c.event("item/completed", map[string]any{"turnId": "turn", "item": map[string]any{"id": "answer", "type": "agentMessage", "text": "已找到标题未自动更新的原因，并修复命名流程。"}})
	c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
}

func awaitTitleFinished(t *testing.T, a *App) {
	t.Helper()
	select {
	case <-a.ChatFor("session").finished:
	case <-time.After(5 * time.Second):
		t.Fatal("main conversation did not finish")
	}
	end := time.Now().Add(5 * time.Second)
	for time.Now().Before(end) {
		a.chatMu.Lock()
		pending := len(a.titleRuns)
		a.chatMu.Unlock()
		if pending == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("title generation did not finish")
}

func TestFirstInputGeneratesTitleWhileReplyIsRunning(t *testing.T) {
	a, q, base, endpoint := chatFixture(t)
	if _, err := a.Workspace.Store.DB.Exec(`INSERT INTO settings(key,value) VALUES('session_title','{"model":"title-model"}')`); err != nil {
		t.Fatal(err)
	}
	c := &titleLiveClient{fakeLiveClient: base, summary: `{"title":"修复对话标题自动更新"}`}
	useTitleClient(a, c)
	create := "/api/requirements/" + q.ID + "/sessions/new"
	input := map[string]string{"text": "检查一下标题", "request_id": "summary-create"}
	if code, raw := call(t, a, "POST", create, input); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	state := awaitChat(t, a, func(s ChatState) bool {
		return s.Status == "running" && s.SessionName == "修复对话标题自动更新"
	})
	if !state.Busy || len(state.Entries) != 0 {
		t.Fatal("title generation waited for or polluted the main reply", state)
	}
	// The independent title connection must not consume main-turn output.
	base.event("item/agentMessage/delta", map[string]any{"turnId": "turn", "itemId": "answer", "delta": "正文继续运行"})
	awaitChat(t, a, func(s ChatState) bool { return len(s.Entries) == 1 && s.Entries[0].Text == "正文继续运行" })
	finishTitleChat(t, base)
	awaitTitleFinished(t, a)
	stored, _ := a.Workspace.Store.Session("session")
	state = a.ChatFor("session").snapshot()
	if stored.Name != "修复对话标题自动更新" || stored.TitleSource != "generated" || state.SessionName != stored.Name || state.Busy || state.Status != "completed" || len(state.Entries) != 1 {
		t.Fatal(stored, state)
	}
	c.mu.Lock()
	if c.summaryCount != 1 || c.summaryParams["ephemeral"] != true || c.summaryParams["sandbox"] != "read-only" || c.summaryParams["model"] != "title-model" || len(c.writes) != 2 {
		t.Error(c.summaryParams, c.writes)
	}
	if base.threadParams["thread/start"]["model"] != "gpt-6.1-sol" {
		t.Error("title model leaked into the main conversation", base.threadParams)
	}
	if c.summaryTurnParams["effort"] != "low" || c.summaryTurnParams["outputSchema"] == nil {
		t.Error(c.summaryTurnParams)
	}
	inputJSON, _ := json.Marshal(c.summaryTurnParams["input"])
	if !strings.Contains(string(inputJSON), "检查一下标题") || strings.Contains(string(inputJSON), "assistant") {
		t.Error("title input must only contain the first user message", string(inputJSON))
	}
	c.mu.Unlock()
	if code, _ := call(t, a, "POST", create, input); code != 200 {
		t.Fatal(code)
	}
	if code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "后续换个主题", "request_id": "summary-next"}); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	awaitChat(t, a, func(s ChatState) bool { return s.ID == "summary-next" && s.Status == "running" })
	finishTitleChat(t, base)
	awaitTitleFinished(t, a)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.summaryCount != 1 || len(c.writes) != 2 {
		t.Fatal(c.summaryCount, c.writes)
	}
}

func TestManualRenameDuringTitleGenerationWins(t *testing.T) {
	a, q, base, _ := chatFixture(t)
	c := &titleLiveClient{fakeLiveClient: base, summary: `{"title":"自动主题"}`, summaryStarted: make(chan struct{}), summaryRelease: make(chan struct{})}
	useTitleClient(a, c)
	if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/new", map[string]string{"text": "检查标题", "request_id": "manual-summary"}); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
	select {
	case <-c.summaryStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("generation did not start")
	}
	if !a.ChatFor("session").snapshot().Busy {
		t.Fatal("main conversation should still be running")
	}
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(string, map[string]any) (any, error) { return map[string]any{}, nil }}, nil
	}
	if code, raw := call(t, a, "POST", "/api/sessions/session/manage", map[string]string{"action": "rename", "name": "我的标题"}); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	close(c.summaryRelease)
	finishTitleChat(t, base)
	awaitTitleFinished(t, a)
	stored, _ := a.Workspace.Store.Session("session")
	if stored.Name != "我的标题" || stored.TitleSource != "manual" || a.ChatFor("session").snapshot().SessionName != "我的标题" {
		t.Fatal(stored)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.writes) != 1 {
		t.Fatal("automatic write replaced manual title", c.writes)
	}
}

func TestTitleGenerationContinuesAcrossFirstTurnCompletion(t *testing.T) {
	for _, status := range []string{"completed", "interrupted", "failed"} {
		t.Run(status, func(t *testing.T) {
			a, q, base, endpoint := chatFixture(t)
			c := &titleLiveClient{fakeLiveClient: base, summary: `{"title":"首次输入的主题"}`, summaryStarted: make(chan struct{}), summaryRelease: make(chan struct{})}
			useTitleClient(a, c)
			if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/new", map[string]string{"text": "首次输入", "request_id": "first"}); code != 202 {
				t.Fatalf("%d %s", code, raw)
			}
			select {
			case <-c.summaryStarted:
			case <-time.After(5 * time.Second):
				t.Fatal("title generation did not start with the first input")
			}
			first := a.ChatFor("session")
			base.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": status}})
			select {
			case <-first.finished:
			case <-time.After(5 * time.Second):
				t.Fatal("main conversation waited for the title")
			}
			if code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "后续换话题", "request_id": "second"}); code != 202 {
				t.Fatalf("%d %s", code, raw)
			}
			awaitChat(t, a, func(s ChatState) bool { return s.ID == "second" && s.Status == "running" })
			close(c.summaryRelease)
			state := awaitChat(t, a, func(s ChatState) bool { return s.SessionName == "首次输入的主题" })
			if !state.Busy || first.snapshot().SessionName != state.SessionName {
				t.Fatal("title result was not published independently of the main turn", state)
			}
			finishTitleChat(t, base)
			awaitTitleFinished(t, a)
			c.mu.Lock()
			defer c.mu.Unlock()
			if c.summaryCount != 1 {
				t.Fatal("title was generated more than once", c.summaryCount)
			}
		})
	}
}

func TestCloseChatsCancelsIndependentTitleGeneration(t *testing.T) {
	a, q, base, _ := chatFixture(t)
	c := &titleLiveClient{fakeLiveClient: base, summary: `{"title":"不应写入"}`, summaryStarted: make(chan struct{}), summaryRelease: make(chan struct{})}
	useTitleClient(a, c)
	if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/new", map[string]string{"text": "初始标题", "request_id": "closing"}); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	select {
	case <-c.summaryStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("title generation did not start")
	}
	finishTitleChat(t, base)
	select {
	case <-a.ChatFor("session").finished:
	case <-time.After(5 * time.Second):
		t.Fatal("main conversation waited for title generation")
	}
	a.CloseChats()
	select {
	case <-c.summaryClosed:
	default:
		t.Fatal("title connection was not closed on shutdown")
	}
	a.chatMu.Lock()
	pending := len(a.titleRuns)
	a.chatMu.Unlock()
	stored, _ := a.Workspace.Store.Session("session")
	if pending != 0 || stored.Name != "初始标题" {
		t.Fatal("shutdown did not clean up naming", pending, stored)
	}
}

func TestTitleGenerationFailureKeepsInitialNameAndCompletedReply(t *testing.T) {
	for _, summary := range []string{"error", `not json`, `{"title":""}`, `{"title":"https://example.com"}`, `{"title":"第一行\n第二行"}`} {
		t.Run(summary, func(t *testing.T) {
			a, q, base, _ := chatFixture(t)
			c := &titleLiveClient{fakeLiveClient: base, summary: summary}
			useTitleClient(a, c)
			if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/new", map[string]string{"text": "初始标题", "request_id": "failed-summary"}); code != 202 {
				t.Fatalf("%d %s", code, raw)
			}
			awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
			finishTitleChat(t, base)
			awaitTitleFinished(t, a)
			stored, _ := a.Workspace.Store.Session("session")
			state := a.ChatFor("session").snapshot()
			if stored.Name != "初始标题" || stored.TitleSource != "initial" || state.Status != "completed" || state.Error != "" || state.Notice == "" {
				t.Fatal(stored, state)
			}
			c.mu.Lock()
			defer c.mu.Unlock()
			if len(c.writes) != 1 {
				t.Fatal(c.writes)
			}
		})
	}
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
	useTitleClient(a, c)
	// A failed generation is attempted once; later messages never retry it.
	c.summary = "error"
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
			useTitleClient(a, c)
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

func TestTitleGenerationSkipsProtectedNamesAndInputsWithoutProse(t *testing.T) {
	for _, mode := range []string{"codex", "manual", "image", "context"} {
		t.Run(mode, func(t *testing.T) {
			a, q, base, _ := chatFixture(t)
			c := &titleLiveClient{fakeLiveClient: base, summary: `{"title":"不能覆盖"}`}
			if mode == "codex" {
				c.name = "已有名称"
			}
			if mode == "manual" {
				c.name = "用户标题"
			}
			useTitleClient(a, c)
			input := map[string]any{"text": "初始标题", "request_id": "protected"}
			if mode == "image" {
				input["text"], input["images"] = "", []string{testChatPNG}
			}
			if mode == "context" {
				input["text"] = "<environment_context>\n上下文\n</environment_context>"
			}
			if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/new", input); code != 202 {
				t.Fatalf("%d %s", code, raw)
			}
			awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
			if mode == "manual" {
				if err := a.Workspace.Store.SetSessionTitle("session", "用户标题", "manual"); err != nil {
					t.Fatal(err)
				}
			}
			base.event("item/completed", map[string]any{"turnId": "turn", "item": map[string]any{"id": "answer", "type": "agentMessage", "text": "回复"}})
			base.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
			awaitTitleFinished(t, a)
			c.mu.Lock()
			defer c.mu.Unlock()
			if c.summaryCount != 0 {
				t.Fatal("unexpected title generation", c.summaryCount)
			}
		})
	}
}

func TestInstalledCodexTitleGeneration(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_TEST_TITLE_GENERATION") != "1" {
		t.Skip("opt-in: performs one ephemeral model request through installed Codex")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	c, err := codex.OpenLive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	name, err := generateTitle(ctx, c, t.TempDir(), "", "检查对话标题为什么不会自动更新")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(name) == "" || len([]rune(name)) > 28 {
		t.Fatal(name)
	}
	t.Logf("generated title: %s", name)
}
