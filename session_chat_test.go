package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeLiveClient struct {
	mu          sync.Mutex
	updates     chan liveEvent
	methods     []string
	replies     []string
	cwd         string
	session     string
	active      bool
	startParams map[string]any
}

func (c *fakeLiveClient) events() <-chan liveEvent { return c.updates }
func (c *fakeLiveClient) close()                   {}
func (c *fakeLiveClient) sessionID() string {
	if c.session != "" {
		return c.session
	}
	return "session"
}
func (c *fakeLiveClient) event(method string, params map[string]any) {
	if params["threadId"] == nil {
		params["threadId"] = c.sessionID()
	}
	raw, _ := json.Marshal(params)
	c.updates <- liveEvent{Method: method, Params: raw}
}
func (c *fakeLiveClient) request(method string, id any, params map[string]any) {
	params["threadId"] = c.sessionID()
	params["turnId"] = "turn"
	raw, _ := json.Marshal(params)
	rpcID, _ := json.Marshal(id)
	c.updates <- liveEvent{ID: rpcID, Method: method, Params: raw}
}
func (c *fakeLiveClient) call(ctx context.Context, method string, params any, out any) error {
	c.mu.Lock()
	c.methods = append(c.methods, method)
	c.mu.Unlock()
	var result any = map[string]any{}
	switch method {
	case "thread/start":
		result = map[string]any{"thread": map[string]any{"id": c.sessionID(), "cwd": c.cwd, "status": map[string]any{"type": "idle"}}}
	case "thread/read":
		status := "idle"
		if c.active {
			status = "active"
		}
		result = map[string]any{"thread": map[string]any{"id": c.sessionID(), "cwd": c.cwd, "status": map[string]any{"type": status}}}
	case "thread/resume":
		result = map[string]any{"thread": map[string]any{"status": map[string]any{"type": "idle"}}, "sandbox": map[string]any{"type": "workspaceWrite", "writableRoots": []any{c.cwd}, "networkAccess": false}}
	case "turn/start":
		c.mu.Lock()
		c.startParams = params.(map[string]any)
		c.mu.Unlock()
		result = map[string]any{"turn": map[string]any{"id": "turn"}}
	case "turn/interrupt":
		c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "interrupted"}})
	}
	if out != nil {
		raw, _ := json.Marshal(result)
		return json.Unmarshal(raw, out)
	}
	return nil
}
func (c *fakeLiveClient) reply(id json.RawMessage, result any) error {
	raw, _ := json.Marshal(result)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.replies = append(c.replies, string(id)+":"+string(raw))
	return nil
}
func chatFixture(t *testing.T) (*App, Requirement, *fakeLiveClient, string) {
	t.Helper()
	a := testApp(t)
	p := register(t, a, "Repo", repo(t, "repo", "master"))
	_, q, _ := create(t, a, p, nil, "chat")
	if err := a.saveSession(q.ID, CodexSession{ID: "session", Cwd: q.Members[0].Path}, "workspace"); err != nil {
		t.Fatal(err)
	}
	c := &fakeLiveClient{updates: make(chan liveEvent, 256), cwd: q.Members[0].Path}
	a.openLive = func(context.Context) (liveClient, error) { return c, nil }
	a.terminalConflict = func(string, string) error { return nil }
	return a, q, c, "/api/requirements/" + q.ID + "/sessions/session/chat"
}
func awaitChat(t *testing.T, a *App, condition func(ChatState) bool) ChatState {
	t.Helper()
	end := time.Now().Add(5 * time.Second)
	for time.Now().Before(end) {
		if run := a.chatFor("session"); run != nil {
			s := run.snapshot()
			if condition(s) {
				return s
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("chat state did not arrive: %+v", a.chatFor("session").snapshot())
	return ChatState{}
}
func startFakeChat(t *testing.T, a *App, endpoint string) {
	t.Helper()
	if code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "运行测试", "request_id": "request1"}); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
}
func TestChatStreamsRecordsApprovalsAndPreventsDuplicates(t *testing.T) {
	a, q, c, endpoint := chatFixture(t)
	startFakeChat(t, a, endpoint)
	if code, _ := call(t, a, "POST", endpoint, map[string]string{"text": "运行测试", "request_id": "request1"}); code != 200 {
		t.Fatal("idempotent retry failed")
	}
	if code, _ := call(t, a, "POST", endpoint, map[string]string{"text": "another", "request_id": "request2"}); code != 409 {
		t.Fatal("concurrent send accepted")
	}
	if code, _ := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/session/resume", nil); code != 409 {
		t.Fatal("terminal launched during page turn")
	}
	c.event("item/started", map[string]any{"turnId": "turn", "item": map[string]any{"type": "agentMessage", "id": "reply", "text": ""}})
	c.event("item/agentMessage/delta", map[string]any{"turnId": "turn", "itemId": "reply", "delta": "正在检查"})
	c.event("item/agentMessage/delta", map[string]any{"turnId": "turn", "itemId": "reply", "delta": "测试。"})
	c.event("item/started", map[string]any{"turnId": "turn", "item": map[string]any{"type": "commandExecution", "id": "cmd", "command": "go test ./...", "cwd": c.cwd, "status": "inProgress"}})
	c.request("item/commandExecution/requestApproval", "rpc-approval", map[string]any{"command": "go test ./...", "cwd": c.cwd, "availableDecisions": []string{"accept", "decline"}})
	waiting := awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
	if len(waiting.Entries) != 2 || waiting.Entries[0].Text != "正在检查测试。" || !waiting.Approvals[0].CanAccept {
		t.Fatal(waiting)
	}
	approval := map[string]any{"run_id": "request1", "approval_id": waiting.Approvals[0].ID, "decision": "accept"}
	if code, raw := call(t, a, "POST", endpoint+"/approval", approval); code != 200 {
		t.Fatalf("approval %d %s", code, raw)
	}
	if code, _ := call(t, a, "POST", endpoint+"/approval", approval); code != 409 {
		t.Fatal("stale approval accepted")
	}
	c.event("item/commandExecution/outputDelta", map[string]any{"turnId": "turn", "itemId": "cmd", "delta": "ok\n"})
	c.event("item/completed", map[string]any{"turnId": "turn", "item": map[string]any{"type": "commandExecution", "id": "cmd", "command": "go test ./...", "cwd": c.cwd, "status": "completed", "exitCode": 0}})
	c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	finished := awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	if finished.Status != "completed" || finished.Entries[1].Output == nil || *finished.Entries[1].Output != "ok\n" {
		t.Fatal(finished)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.replies) != 1 || !strings.Contains(c.replies[0], `"decision":"accept"`) || strings.Contains(c.replies[0], "acceptForSession") {
		t.Fatal(c.replies)
	}
	starts := 0
	for _, method := range c.methods {
		if method == "turn/start" {
			starts++
		}
	}
	if starts != 1 {
		t.Fatal(c.methods)
	}
	if _, overridden := c.startParams["approvalPolicy"]; overridden {
		t.Fatal("session approval policy overridden")
	}
}
func TestChatStopAndStaleRunCannotControlAnotherTurn(t *testing.T) {
	a, _, c, endpoint := chatFixture(t)
	startFakeChat(t, a, endpoint)
	c.request("item/permissions/requestApproval", 123, map[string]any{"permissions": map[string]any{"network": map[string]any{"enabled": true}}, "reason": "需要访问测试服务"})
	s := awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
	if code, raw := call(t, a, "POST", endpoint+"/approval", map[string]any{"run_id": s.ID, "approval_id": s.Approvals[0].ID, "decision": "accept"}); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	c.mu.Lock()
	reply := c.replies[0]
	c.mu.Unlock()
	if !strings.Contains(reply, `"scope":"turn"`) || !strings.Contains(reply, `"enabled":true`) {
		t.Fatal(reply)
	}
	if code, _ := call(t, a, "POST", endpoint+"/stop", map[string]string{"run_id": "old"}); code != 409 {
		t.Fatal("wrong run interrupted")
	}
	if code, raw := call(t, a, "POST", endpoint+"/stop", map[string]string{"run_id": "request1"}); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	s = awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	if s.Status != "interrupted" || len(s.Approvals) != 0 {
		t.Fatal(s)
	}
}
func TestChatRejectsTerminalAndActiveRuntimeWithoutStarting(t *testing.T) {
	for _, mode := range []string{"terminal", "active"} {
		t.Run(mode, func(t *testing.T) {
			a, _, c, endpoint := chatFixture(t)
			if mode == "terminal" {
				a.terminalConflict = func(string, string) error { return fmt.Errorf("terminal busy") }
			} else {
				c.active = true
			}
			if code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "hello", "request_id": "blocked"}); code != 202 {
				t.Fatalf("%d %s", code, raw)
			}
			s := awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
			if s.Status != "conflict" {
				t.Fatal(s)
			}
			c.mu.Lock()
			defer c.mu.Unlock()
			for _, method := range c.methods {
				if method == "turn/start" || method == "thread/resume" {
					t.Fatal("occupied session resumed")
				}
			}
		})
	}
}
func TestChatScopeErrorsAndSSESnapshot(t *testing.T) {
	a, q, c, endpoint := chatFixture(t)
	if code, _ := call(t, a, "POST", strings.Replace(endpoint, "/session/", "/unlinked/", 1), map[string]string{"text": "x", "request_id": "r"}); code != 404 {
		t.Fatal(code)
	}
	startFakeChat(t, a, endpoint)
	c.event("item/agentMessage/delta", map[string]any{"turnId": "other-turn", "itemId": "other", "delta": "DO_NOT_SHOW"})
	c.event("item/agentMessage/delta", map[string]any{"turnId": "turn", "itemId": "reply", "delta": "hello"})
	c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	request := httptest.NewRequest("GET", "http://localhost:4317"+endpoint+"/events?run=request1", nil)
	request.Header.Set("X-CSRF-Token", a.token)
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, request)
	if w.Code != 200 || !strings.HasPrefix(w.Body.String(), "data: ") || strings.Contains(w.Body.String(), "DO_NOT_SHOW") || !strings.Contains(w.Body.String(), "hello") {
		t.Fatal(w.Code, w.Body.String())
	}
	if code, _ := call(t, a, "POST", "/api/requirements/"+q.ID+"/archive", map[string]bool{"archived": true}); code != 200 {
		t.Fatal(code)
	}
	if code, _ := call(t, a, "POST", endpoint, map[string]string{"text": "x", "request_id": "archived"}); code != 409 {
		t.Fatal("archived requirement started chat")
	}
}
func TestManualTerminalDetection(t *testing.T) {
	proc := t.TempDir()
	cwd := t.TempDir()
	id := "session"
	add := func(pid, args, dir string) {
		p := filepath.Join(proc, pid)
		_ = os.Mkdir(p, 0700)
		_ = os.WriteFile(filepath.Join(p, "comm"), []byte("codex\n"), 0600)
		_ = os.WriteFile(filepath.Join(p, "cmdline"), []byte(args), 0600)
		_ = os.Symlink(dir, filepath.Join(p, "cwd"))
	}
	add("1", "codex\x00app-server\x00proxy\x00", cwd)
	if err := scanTerminalSessions(proc, id, cwd); err != nil {
		t.Fatal(err)
	}
	add("2", "codex\x00--cd\x00"+cwd+"\x00prompt\x00", t.TempDir())
	if err := scanTerminalSessions(proc, id, cwd); err == nil {
		t.Fatal("initial CLI not detected")
	}
	other := t.TempDir()
	add("3", "codex\x00resume\x00"+id+"\x00", other)
	if err := scanTerminalSessions(proc, id, other+"-unrelated"); err == nil {
		t.Fatal("resumed session not detected")
	}
}

func TestTerminalReappearingInterruptsOnlyPageTurn(t *testing.T) {
	a, _, c, endpoint := chatFixture(t)
	var occupied atomic.Bool
	a.terminalConflict = func(string, string) error {
		if occupied.Load() {
			return fmt.Errorf("terminal appeared")
		}
		return nil
	}
	startFakeChat(t, a, endpoint)
	occupied.Store(true)
	s := awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	if s.Status != "conflict" {
		t.Fatal(s)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	found := false
	for _, method := range c.methods {
		if method == "turn/interrupt" {
			found = true
		}
	}
	if !found {
		t.Fatal("page turn not interrupted")
	}
}

func TestQuestionsAndFileChangeApprovalPayloads(t *testing.T) {
	a, _, c, endpoint := chatFixture(t)
	startFakeChat(t, a, endpoint)
	c.event("item/started", map[string]any{"turnId": "turn", "item": map[string]any{"type": "fileChange", "id": "edit", "status": "inProgress", "changes": []any{map[string]any{"path": "app.go", "diff": "- old\n+ new"}}}})
	c.request("item/fileChange/requestApproval", 99, map[string]any{"itemId": "edit", "reason": "修改回调"})
	s := awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
	if !strings.Contains(s.Approvals[0].Details, "+ new") {
		t.Fatal("file approval missing diff")
	}
	if code, _ := call(t, a, "POST", endpoint+"/approval", map[string]any{"run_id": s.ID, "approval_id": s.Approvals[0].ID, "decision": "decline"}); code != 200 {
		t.Fatal(code)
	}
	c.request("item/tool/requestUserInput", "question", map[string]any{"questions": []any{map[string]any{"id": "q", "header": "范围", "question": "选择范围"}}})
	s = awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
	base := map[string]any{"run_id": s.ID, "approval_id": s.Approvals[0].ID, "decision": "accept"}
	if code, _ := call(t, a, "POST", endpoint+"/approval", base); code != 400 {
		t.Fatal("missing answer accepted")
	}
	base["decision"] = "decline"
	base["answers"] = map[string][]string{"q": {"MUST_NOT_BE_SENT"}}
	if code, _ := call(t, a, "POST", endpoint+"/approval", base); code != 200 {
		t.Fatal(code)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if strings.Contains(c.replies[len(c.replies)-1], "MUST_NOT_BE_SENT") {
		t.Fatal("decline sent drafted answer")
	}
}
