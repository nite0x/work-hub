package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestLiveWireHelper(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_LIVE_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	encode := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
		}
		_ = json.Unmarshal(scanner.Bytes(), &req)
		if req.Method == "initialized" {
			continue
		}
		if req.Method == "" {
			_ = encode.Encode(map[string]any{"method": "reply/received", "params": map[string]any{"id": req.ID, "result": req.Result}})
			continue
		}
		_ = encode.Encode(map[string]any{"method": "progress", "params": map[string]any{"threadId": "session"}})
		_ = encode.Encode(map[string]any{"id": req.ID, "result": map[string]any{"method": req.Method}})
		if req.Method == "thread/resume" {
			_ = encode.Encode(map[string]any{"method": "item/commandExecution/requestApproval", "id": "string-request", "params": map[string]any{"threadId": "session", "turnId": "turn", "command": "pwd"}})
		}
	}
	os.Exit(0)
}
func TestLiveWireDispatchesRepliesNotificationsAndServerRequests(t *testing.T) {
	t.Setenv("WORKTREE_HUB_LIVE_HELPER", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	c, err := startLiveWire(ctx, exec.CommandContext(ctx, bin, "-test.run=TestLiveWireHelper"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	var result struct {
		Method string `json:"method"`
	}
	if err := c.call(ctx, "thread/resume", map[string]any{}, &result); err != nil || result.Method != "thread/resume" {
		t.Fatal(result, err)
	}
	for {
		select {
		case event := <-c.events():
			if event.Method == "item/commandExecution/requestApproval" {
				if string(event.ID) != `"string-request"` {
					t.Fatal(string(event.ID))
				}
				if err := c.reply(event.ID, map[string]string{"decision": "decline"}); err != nil {
					t.Fatal(err)
				}
			}
			if event.Method == "reply/received" {
				return
			}
		case <-ctx.Done():
			t.Fatal("wire dispatch blocked")
		}
	}
}
func TestInstalledCodexLiveReadOnly(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_TEST_INSTALLED_CODEX") != "1" {
		t.Skip("opt-in shared daemon check")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := openLiveCodex(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	var page CodexSessionPage
	if err := c.call(ctx, "thread/list", map[string]any{"limit": 1}, &page); err != nil {
		t.Fatal(err)
	}
}

// Explicit opt-in: performs one real, tool-free text turn in an ephemeral
// thread rooted in a temporary directory. Existing user threads are untouched.
func TestInstalledCodexEphemeralTextTurn(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_TEST_CODEX_TURN") != "1" {
		t.Skip("opt-in real model turn")
	}
	c, err := openLiveCodex(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var started struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := c.call(ctx, "thread/start", map[string]any{"cwd": t.TempDir(), "ephemeral": true, "sandbox": "read-only", "approvalPolicy": "untrusted"}, &started); err != nil {
		t.Fatal(err)
	}
	var turn struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := c.call(ctx, "turn/start", map[string]any{"threadId": started.Thread.ID, "input": []any{map[string]any{"type": "text", "text": "这是 Worktree Hub 连通性测试。只回复 WORKTREE_HUB_OK，不调用工具，不读取文件。"}}}, &turn); err != nil {
		t.Fatal(err)
	}
	completed := false
	defer func() {
		endCtx, end := context.WithTimeout(context.Background(), 3*time.Second)
		defer end()
		if !completed {
			_ = c.call(endCtx, "turn/interrupt", map[string]any{"threadId": started.Thread.ID, "turnId": turn.Turn.ID}, nil)
		}
		_ = c.call(endCtx, "thread/unsubscribe", map[string]any{"threadId": started.Thread.ID}, nil)
	}()
	text := ""
	for {
		select {
		case event, ok := <-c.events():
			if !ok {
				t.Fatal("model connection ended")
			}
			var p struct {
				ThreadID string           `json:"threadId"`
				Delta    string           `json:"delta"`
				Item     codexHistoryItem `json:"item"`
				Turn     struct {
					ID     string `json:"id"`
					Status string `json:"status"`
					Error  *struct {
						Message string `json:"message"`
					} `json:"error"`
				} `json:"turn"`
			}
			_ = json.Unmarshal(event.Params, &p)
			if p.ThreadID != started.Thread.ID {
				continue
			}
			if len(event.ID) > 0 {
				_ = c.reply(event.ID, map[string]string{"decision": "decline"})
				t.Fatal("unexpected tool request in text-only test")
			}
			if event.Method == "item/agentMessage/delta" {
				text += p.Delta
			}
			if event.Method == "item/completed" && p.Item.Type == "agentMessage" {
				text = p.Item.Text
			}
			if event.Method == "turn/completed" && p.Turn.ID == turn.Turn.ID {
				completed = true
				if p.Turn.Error != nil {
					t.Fatal(p.Turn.Error.Message)
				}
				if p.Turn.Status != "completed" || !strings.Contains(text, "WORKTREE_HUB_OK") {
					t.Fatalf("unexpected text turn result: %s", p.Turn.Status)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("text turn timed out")
		}
	}
}

func TestInstalledCodexSidebarTurn(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_TEST_CODEX_TURN") != "1" {
		t.Skip("opt-in real sidebar round trip")
	}
	a := testApp(t)
	p := register(t, a, "Smoke", repo(t, "smoke", "master"))
	_, q, _ := create(t, a, p, nil, "live-smoke")
	ctx, end := context.WithTimeout(context.Background(), 60*time.Second)
	defer end()
	c, err := openLiveCodex(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	var thread struct {
		Thread CodexSession `json:"thread"`
	}
	if err := c.call(ctx, "thread/start", map[string]any{"cwd": q.Members[0].Path, "sandbox": "read-only", "approvalPolicy": "untrusted"}, &thread); err != nil {
		t.Fatal(err)
	}
	// This test needs a stored thread so another connection can resume it.
	// Remove only the thread created immediately above when the test finishes.
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = c.call(cleanup, "thread/delete", map[string]any{"threadId": thread.Thread.ID}, nil)
	}()
	var seed struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := c.call(ctx, "turn/start", map[string]any{"threadId": thread.Thread.ID, "input": []any{map[string]any{"type": "text", "text": "只回复 READY。不要调用工具或读取文件。"}}}, &seed); err != nil {
		t.Fatal(err)
	}
	seeded := false
	for !seeded {
		select {
		case event := <-c.events():
			var p struct {
				ThreadID string `json:"threadId"`
				Turn     struct {
					ID     string `json:"id"`
					Status string `json:"status"`
				} `json:"turn"`
			}
			_ = json.Unmarshal(event.Params, &p)
			if p.ThreadID == thread.Thread.ID && event.Method == "turn/completed" && p.Turn.ID == seed.Turn.ID {
				if p.Turn.Status != "completed" {
					t.Fatal("seed turn did not complete")
				}
				seeded = true
			}
		case <-ctx.Done():
			t.Fatal("seed turn timed out")
		}
	}
	if err := a.saveSession(q.ID, thread.Thread, "manual"); err != nil {
		t.Fatal(err)
	}
	endpoint := "/api/requirements/" + q.ID + "/sessions/" + thread.Thread.ID + "/chat"
	if code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "这是侧栏连通性测试。只回复 WORKTREE_HUB_SIDEBAR_OK，不调用工具，不读取文件。", "request_id": "sidebar-smoke"}); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	run := a.chatFor(thread.Thread.ID)
	select {
	case <-run.finished:
	case <-ctx.Done():
		t.Fatal("sidebar turn timed out")
	}
	s := run.snapshot()
	if s.Status != "completed" {
		t.Fatalf("sidebar turn did not complete: %s %s", s.Status, s.Error)
	}
	text := ""
	for _, entry := range s.Entries {
		if entry.Kind == "assistant" {
			text += entry.Text
		}
	}
	if !strings.Contains(text, "WORKTREE_HUB_SIDEBAR_OK") {
		t.Fatal("sidebar reply missing")
	}
}
