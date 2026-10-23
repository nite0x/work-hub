package session

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"worktree-hub/internal/codex"
)

func TestInstalledCodexSidebarTurn(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_TEST_CODEX_TURN") != "1" {
		t.Skip("opt-in real sidebar round trip")
	}
	a := testApp(t)
	p := register(t, a, "Smoke", repo(t, "smoke", "master"))
	_, q, _ := create(t, a, p, nil, "live-smoke")
	ctx, end := context.WithTimeout(context.Background(), 60*time.Second)
	defer end()
	c, err := codex.OpenLive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var thread struct {
		Thread codex.Session `json:"thread"`
	}
	if err := c.Call(ctx, "thread/start", map[string]any{"cwd": q.Members[0].Path, "sandbox": "read-only", "approvalPolicy": "untrusted"}, &thread); err != nil {
		t.Fatal(err)
	}
	// This test needs a stored thread so another connection can resume it.
	// Remove only the thread created immediately above when the test finishes.
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = c.Call(cleanup, "thread/delete", map[string]any{"threadId": thread.Thread.ID}, nil)
	}()
	var seed struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := c.Call(ctx, "turn/start", map[string]any{"threadId": thread.Thread.ID, "input": []any{map[string]any{"type": "text", "text": "只回复 READY。不要调用工具或读取文件。"}}}, &seed); err != nil {
		t.Fatal(err)
	}
	seeded := false
	for !seeded {
		select {
		case event := <-c.Events():
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
	if err := a.SaveSession(q.ID, thread.Thread, "manual"); err != nil {
		t.Fatal(err)
	}
	endpoint := "/api/requirements/" + q.ID + "/sessions/" + thread.Thread.ID + "/chat"
	if code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "这是侧栏连通性测试。只回复 WORKTREE_HUB_SIDEBAR_OK，不调用工具，不读取文件。", "request_id": "sidebar-smoke"}); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	run := a.ChatFor(thread.Thread.ID)
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

// Explicit opt-in: performs one real, tool-free text turn in an ephemeral
// thread rooted in a temporary directory. Existing user threads are untouched.
func TestInstalledCodexEphemeralTextTurn(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_TEST_CODEX_TURN") != "1" {
		t.Skip("opt-in real model turn")
	}
	c, err := codex.OpenLive(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var started struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	// Windows Codex keeps a directory handle in its shared daemon after an
	// ephemeral turn. This tool-free probe uses the existing temporary root so
	// it creates no directory that testing.T must delete while the daemon lives.
	directory := os.TempDir()
	if runtime.GOOS != "windows" {
		directory = t.TempDir()
	}
	if err := c.Call(ctx, "thread/start", map[string]any{"cwd": directory, "ephemeral": true, "sandbox": "read-only", "approvalPolicy": "untrusted"}, &started); err != nil {
		t.Fatal(err)
	}
	var turn struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := c.Call(ctx, "turn/start", map[string]any{"threadId": started.Thread.ID, "input": []any{map[string]any{"type": "text", "text": "这是 Worktree Hub 连通性测试。只回复 WORKTREE_HUB_OK，不调用工具，不读取文件。"}}}, &turn); err != nil {
		t.Fatal(err)
	}
	completed := false
	defer func() {
		endCtx, end := context.WithTimeout(context.Background(), 3*time.Second)
		defer end()
		if !completed {
			_ = c.Call(endCtx, "turn/interrupt", map[string]any{"threadId": started.Thread.ID, "turnId": turn.Turn.ID}, nil)
		}
		_ = c.Call(endCtx, "thread/unsubscribe", map[string]any{"threadId": started.Thread.ID}, nil)
	}()
	text := ""
	for {
		select {
		case event, ok := <-c.Events():
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
				_ = c.Reply(event.ID, map[string]string{"decision": "decline"})
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
