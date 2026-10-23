package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/model"
)

// Opt-in local UI fixture: exercises the production HTTP/SSE path with an
// in-memory Codex stand-in. It never submits a model request or uses user data.
type browserLive struct {
	*fakeLiveClient
	decision chan string
	stop     chan struct{}
	once     sync.Once
}

func (c *browserLive) Close() { c.once.Do(func() { close(c.stop) }) }
func (c *browserLive) Reply(id json.RawMessage, result any) error {
	raw, _ := json.Marshal(result)
	c.decision <- string(raw)
	return nil
}
func (c *browserLive) Call(ctx context.Context, method string, params any, out any) error {
	if method == "thread/start" {
		c.session = "browser-" + model.NewID()
	}
	if method == "thread/read" || method == "thread/resume" {
		c.session = params.(map[string]any)["threadId"].(string)
	}
	err := c.fakeLiveClient.Call(ctx, method, params, out)
	if method == "turn/interrupt" {
		c.Close()
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
			if strings.Contains(input, "MCP") {
				for index, request := range []map[string]any{
					{"serverName": "apix", "mode": "form", "message": `Allow the apix MCP server to run tool "list_mcp_servers"?`, "requestedSchema": map[string]any{"type": "object", "properties": map[string]any{}}, "_meta": map[string]any{"codex_approval_kind": "mcp_tool_call", "persist": []string{"session", "always"}}},
					{"serverName": "fixture", "mode": "form", "message": "请选择测试环境和检查项目", "requestedSchema": map[string]any{"type": "object", "required": []string{"environment", "count", "enabled", "projects"}, "properties": map[string]any{
						"environment": map[string]any{"type": "string", "title": "测试环境", "oneOf": []any{map[string]any{"const": "test", "title": "测试环境"}, map[string]any{"const": "staging", "title": "预发布环境"}}},
						"count":       map[string]any{"type": "integer", "title": "执行次数", "minimum": 1, "maximum": 5, "default": 1},
						"enabled":     map[string]any{"type": "boolean", "title": "运行检查", "default": false},
						"projects":    map[string]any{"type": "array", "title": "检查项目", "minItems": 1, "items": map[string]any{"type": "string", "enum": []string{"frontend", "backend"}}},
					}}},
					{"serverName": "fixture", "mode": "url", "message": "在浏览器中完成操作后回到侧栏确认", "url": "https://example.com/fixture-login", "elicitationId": "fixture-login"},
				} {
					c.request("mcpServer/elicitation/request", fmt.Sprintf("browser-mcp-%d", index), request)
					select {
					case <-c.decision:
					case <-c.stop:
						return
					}
				}
				c.event("item/completed", map[string]any{"turnId": "turn", "item": map[string]any{"id": "new-reply", "type": "agentMessage", "text": "侧栏已完成工具授权、表单填写和 URL 流程确认。"}})
				c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
				return
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
	_, _ = a.Workspace.Store.DB.Exec(`UPDATE requirements SET name='侧栏对话验证',description='验证文字输入、实时回复、审批和停止' WHERE id=?`, q.ID)
	a.openLive = func(context.Context) (codex.LiveClient, error) {
		return &browserLive{fakeLiveClient: &fakeLiveClient{updates: make(chan codex.Event, 256), cwd: q.Members[0].Path}, decision: make(chan string, 2), stop: make(chan struct{})}, nil
	}
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, p map[string]any) (any, error) {
			s := codex.Session{ID: "session", Name: "功能实现与测试", Cwd: q.Members[0].Path, UpdatedAt: time.Now().Unix(), HistoryMode: "paginated"}
			if method == "thread/list" {
				stored, _ := a.StoredSessions(q.ID)
				all := []codex.Session{}
				for _, entry := range stored {
					all = append(all, codex.Session{ID: entry.ID, Name: entry.Name, Cwd: entry.Cwd, CreatedAt: entry.CreatedAt, UpdatedAt: entry.UpdatedAt, HistoryMode: "paginated"})
				}
				return codex.SessionPage{Data: all}, nil
			}
			if method == "thread/read" {
				s.ID = p["threadId"].(string)
				return map[string]any{"thread": s}, nil
			}
			return map[string]any{"data": []any{map[string]any{"turnId": "saved", "item": map[string]any{"id": "saved-reply", "type": "agentMessage", "text": "已阅读任务说明，准备继续实现。"}}, map[string]any{"turnId": "saved", "item": map[string]any{"id": "saved-user", "type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "请先阅读任务说明并检查当前项目。"}}}}}}, nil
		}}, nil
	}
	a.Workspace.Launch = func(plan model.LaunchPlan, _ func()) error {
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
	production := a.handler()
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/task-inventory" {
			task, _ := a.Workspace.Store.Requirement(q.ID)
			raw, _ := json.Marshal(task)
			var row map[string]any
			_ = json.Unmarshal(raw, &row)
			row["environment_id"] = "local"
			row["environment_name"] = "本机"
			row["connected"] = true
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"requirements": []any{row}, "environments": []any{map[string]any{"id": "local", "name": "本机", "connected": true}}, "project_count": 1})
			return
		}
		if r.URL.Path == "/api/environments" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"environments": []any{map[string]any{"id": "local", "name": "本机", "connected": true}}, "distributions": []string{}, "wsl_supported": false})
			return
		}
		production.ServeHTTP(w, r)
	}))
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
