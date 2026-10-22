package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// Opt-in local UI fixture: exercises the production HTTP/SSE path with an
// in-memory Codex stand-in. It never submits a model request or uses user data.
type browserLive struct {
	*fakeLiveClient
	decision chan string
	stop     chan struct{}
	once     sync.Once
}

func (c *browserLive) close() { c.once.Do(func() { close(c.stop) }) }
func (c *browserLive) reply(id json.RawMessage, result any) error {
	raw, _ := json.Marshal(result)
	c.decision <- string(raw)
	return nil
}
func (c *browserLive) call(ctx context.Context, method string, params any, out any) error {
	if method == "thread/start" {
		c.session = "browser-" + newID()
	}
	if method == "thread/read" || method == "thread/resume" {
		c.session = params.(map[string]any)["threadId"].(string)
	}
	err := c.fakeLiveClient.call(ctx, method, params, out)
	if method == "turn/interrupt" {
		c.close()
	}
	if method == "turn/start" {
		p := params.(map[string]any)
		input := p["input"].([]any)[0].(map[string]any)["text"].(string)
		go func() {
			c.event("item/started", map[string]any{"turnId": "turn", "item": map[string]any{"type": "userMessage", "id": "new-user", "content": []any{map[string]any{"type": "text", "text": input}}}})
			c.event("item/started", map[string]any{"turnId": "turn", "item": map[string]any{"type": "agentMessage", "id": "new-reply", "text": ""}})
			for _, text := range []string{"已收到补充说明。", "我会先检查当前项目，", "然后运行相关测试。"} {
				select {
				case <-time.After(200 * time.Millisecond):
				case <-c.stop:
					return
				}
				c.event("item/agentMessage/delta", map[string]any{"turnId": "turn", "itemId": "new-reply", "delta": text})
			}
			if strings.Contains(input, "停止") {
				select {
				case <-time.After(20 * time.Second):
				case <-c.stop:
					return
				}
			}
			c.event("item/started", map[string]any{"turnId": "turn", "item": map[string]any{"id": "new-command", "type": "commandExecution", "command": "go test ./...", "cwd": c.cwd, "status": "inProgress"}})
			c.request("item/commandExecution/requestApproval", "browser-approval", map[string]any{"itemId": "new-command", "command": "go test ./...", "cwd": c.cwd, "reason": "验证当前修改需要执行测试", "availableDecisions": []string{"accept", "decline"}})
			select {
			case decision := <-c.decision:
				status, output, exit := "completed", "ok  example/project  0.04s\n", 0
				if strings.Contains(decision, "decline") {
					status, output, exit = "declined", "用户拒绝执行命令", 1
				}
				c.event("item/commandExecution/outputDelta", map[string]any{"turnId": "turn", "itemId": "new-command", "delta": output})
				c.event("item/completed", map[string]any{"turnId": "turn", "item": map[string]any{"id": "new-command", "type": "commandExecution", "command": "go test ./...", "cwd": c.cwd, "status": status, "aggregatedOutput": output, "exitCode": exit, "durationMs": 40}})
			case <-c.stop:
				return
			}
			c.event("item/completed", map[string]any{"turnId": "turn", "item": map[string]any{"id": "new-reply", "type": "agentMessage", "text": "已完成本轮检查，你可以继续补充要求。"}})
			c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
		}()
	}
	return err
}
func TestBrowserChatFixture(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_BROWSER_CHAT") != "1" {
		t.Skip("opt-in browser fixture")
	}
	a, q, _, _ := chatFixture(t)
	_, _ = a.db.Exec(`UPDATE requirements SET name='侧栏对话验证',description='验证文字输入、实时回复、审批和停止' WHERE id=?`, q.ID)
	a.openLive = func(context.Context) (liveClient, error) {
		return &browserLive{fakeLiveClient: &fakeLiveClient{updates: make(chan liveEvent, 256), cwd: q.Members[0].Path}, decision: make(chan string, 2), stop: make(chan struct{})}, nil
	}
	a.openSessions = func(context.Context) (sessionClient, error) {
		return &fakeSessionClient{request: func(method string, p map[string]any) (any, error) {
			s := CodexSession{ID: "session", Name: "功能实现与测试", Cwd: q.Members[0].Path, UpdatedAt: time.Now().Unix(), HistoryMode: "paginated"}
			if method == "thread/list" {
				stored, _ := a.storedSessions(q.ID)
				all := []CodexSession{}
				for _, entry := range stored {
					all = append(all, CodexSession{ID: entry.ID, Name: entry.Name, Cwd: entry.Cwd, CreatedAt: entry.CreatedAt, UpdatedAt: entry.UpdatedAt, HistoryMode: "paginated"})
				}
				return CodexSessionPage{Data: all}, nil
			}
			if method == "thread/read" {
				s.ID = p["threadId"].(string)
				return map[string]any{"thread": s}, nil
			}
			return map[string]any{"data": []any{map[string]any{"turnId": "saved", "item": map[string]any{"id": "saved-reply", "type": "agentMessage", "text": "已阅读任务说明，准备继续实现。"}}, map[string]any{"turnId": "saved", "item": map[string]any{"id": "saved-user", "type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "请先阅读任务说明并检查当前项目。"}}}}}}, nil
		}}, nil
	}
	a.launch = func(plan LaunchPlan) error {
		child := exec.Command("sleep", "1800")
		if err := child.Start(); err != nil {
			return err
		}
		t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
		a.bridgeMu.Lock()
		b := a.bridges[strings.TrimPrefix(plan.Args[len(plan.Args)-1], "unix://")]
		a.bridgeMu.Unlock()
		b.mu.Lock()
		b.connected = true
		b.bound = true
		b.active = true
		b.peer = child.Process
		b.mu.Unlock()
		go func() {
			tick := time.NewTicker(200 * time.Millisecond)
			defer tick.Stop()
			for range tick.C {
				if _, err := os.Stat("/tmp/worktree-hub-finish-terminal-turn"); err == nil {
					b.mu.Lock()
					b.active = false
					b.mu.Unlock()
					return
				}
			}
		}()
		return nil
	}
	a.terminalConflict = func(string, string) error {
		if _, err := os.Stat("/tmp/worktree-hub-chat-terminal-busy"); err == nil {
			return fmt.Errorf("此工作目录仍有 Codex 终端打开，请先退出终端中的 Codex")
		}
		return nil
	}
	server := httptest.NewUnstartedServer(a.handler())
	listener, err := net.Listen("tcp", "127.0.0.1:44317")
	if err != nil {
		t.Fatal(err)
	}
	server.Listener = listener
	server.Start()
	defer server.Close()
	fmt.Println("CHAT_FIXTURE_READY http://localhost:44317/#/requirements/" + q.ID)
	time.Sleep(30 * time.Minute)
}
