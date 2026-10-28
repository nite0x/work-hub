package session

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"worktree-hub/internal/workspace"
)

// A separate process exercises the same dedicated stdio channel used by the
// Windows host and WSL helper. No real account, model or user thread is used.
func TestRemoteChatHelper(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_REMOTE_CHAT_HELPER") != "1" {
		return
	}
	if os.Args[len(os.Args)-1] == "--workspace-agent" {
		var checks atomic.Int32
		err := workspace.RunAgent(os.Stdin, os.Stdout, workspace.AgentHooks{TerminalConflict: func(string, string) error {
			if os.Getenv("WORKTREE_HUB_REMOTE_CHAT_BUSY") == "1" && checks.Add(1) <= 2 {
				return workspace.ErrBusy
			}
			return nil
		}})
		if err != nil {
			os.Exit(2)
		}
		os.Exit(0)
	}
	if os.Args[len(os.Args)-1] != "--codex-live" {
		os.Exit(3)
	}
	enc := json.NewEncoder(os.Stdout)
	emit := func(value any) {
		if err := enc.Encode(value); err != nil {
			os.Exit(4)
		}
	}
	event := func(method string, params map[string]any) {
		params["threadId"] = "remote-session"
		params["turnId"] = "remote-turn"
		emit(map[string]any{"method": method, "params": params})
	}
	scan := bufio.NewScanner(os.Stdin)
	for scan.Scan() {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(scan.Bytes(), &req) != nil {
			os.Exit(5)
		}
		if req.Method == "initialized" {
			continue
		}
		if req.Method == "" {
			if string(req.ID) != `"remote-approval"` || !strings.Contains(string(req.Result), `"accept"`) {
				os.Exit(6)
			}
			event("item/completed", map[string]any{"item": map[string]any{"id": "reply", "type": "agentMessage", "text": "审批已回传"}})
			event("turn/completed", map[string]any{"turn": map[string]any{"id": "remote-turn", "status": "completed"}})
			continue
		}
		var result any = map[string]any{}
		switch req.Method {
		case "model/list":
			result = map[string]any{"data": []any{map[string]any{"id": "gpt-6.1-sol", "model": "gpt-6.1-sol", "supportedReasoningEfforts": []any{map[string]any{"reasoningEffort": "high"}}}}}
		case "thread/start", "thread/read":
			result = map[string]any{"thread": map[string]any{"id": "remote-session", "cwd": os.Getenv("WORKTREE_HUB_REMOTE_CHAT_CWD"), "status": map[string]any{"type": "idle"}}}
		case "thread/resume":
			result = map[string]any{"thread": map[string]any{"status": map[string]any{"type": "idle"}}, "sandbox": map[string]any{"type": "workspaceWrite", "writableRoots": []string{os.Getenv("WORKTREE_HUB_REMOTE_CHAT_CWD")}}}
		case "turn/start":
			result = map[string]any{"turn": map[string]any{"id": "remote-turn"}}
		}
		emit(map[string]any{"id": req.ID, "result": result})
		if req.Method == "turn/start" {
			for i := 0; i < 512; i++ {
				event("item/agentMessage/delta", map[string]any{"itemId": "reply", "delta": "片"})
			}
			emit(map[string]any{"id": "remote-approval", "method": "item/commandExecution/requestApproval", "params": map[string]any{"threadId": "remote-session", "turnId": "remote-turn", "command": "pwd", "availableDecisions": []string{"accept", "decline"}}})
		}
		if req.Method == "turn/interrupt" {
			event("turn/completed", map[string]any{"turn": map[string]any{"id": "remote-turn", "status": "interrupted"}})
		}
	}
	os.Exit(0)
}
func TestRemoteTaskChatCreatesStreamsApprovesContinuesAndStops(t *testing.T) {
	a, q, _, _ := chatFixture(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestRemoteChatHelper$", "--", "--workspace-agent")
	cmd.Env = append(os.Environ(), "WORKTREE_HUB_REMOTE_CHAT_HELPER=1", "WORKTREE_HUB_REMOTE_CHAT_CWD="+q.Members[0].Path, "WORKTREE_HUB_REMOTE_CHAT_BUSY=1")
	remote, err := workspace.StartClient(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	a.Workspace.Remote = remote
	a.Service = New(a.Workspace, a.Tasks)
	endpoint := "/api/requirements/" + q.ID + "/sessions/remote-session/chat"
	wait := func(predicate func(ChatState) bool) ChatState {
		t.Helper()
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			if run := a.ChatFor("remote-session"); run != nil {
				s := run.snapshot()
				if predicate(s) {
					return s
				}
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatal("remote turn did not reach expected state")
		return ChatState{}
	}
	if code, body := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/new", map[string]string{"text": "测试远程对话", "request_id": "new-remote"}); code != 202 {
		t.Fatalf("create: %d %s", code, body)
	}
	waiting := wait(func(s ChatState) bool { return len(s.Approvals) == 1 })
	if len(waiting.Entries) != 1 || waiting.Entries[0].Text != strings.Repeat("片", 512) {
		t.Fatal("remote protocol dropped deltas")
	}
	if code, body := call(t, a, "POST", endpoint+"/approval", map[string]any{"run_id": waiting.ID, "approval_id": waiting.Approvals[0].ID, "decision": "accept"}); code != 200 {
		t.Fatalf("approval: %d %s", code, body)
	}
	done := wait(func(s ChatState) bool { return s.Status == "completed" && !s.Busy })
	if done.Entries[0].Text != "审批已回传" {
		t.Fatal(done)
	}
	if code, body := call(t, a, "POST", endpoint, map[string]string{"text": "继续这次对话", "request_id": "continue-remote"}); code != 202 {
		t.Fatalf("continue: %d %s", code, body)
	}
	waiting = wait(func(s ChatState) bool { return s.ID == "continue-remote" && len(s.Approvals) == 1 })
	if code, body := call(t, a, "POST", endpoint+"/stop", map[string]string{"run_id": waiting.ID}); code != 200 {
		t.Fatalf("stop: %d %s", code, body)
	}
	wait(func(s ChatState) bool { return s.Status == "interrupted" && !s.Busy })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var identity workspace.Identity
	if err := remote.Call(ctx, workspace.Request{Op: "identity"}, &identity); err != nil {
		t.Fatal(fmt.Errorf("chat blocked workspace RPC: %w", err))
	}
}
