package codex_test

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"

	"worktree-hub/internal/codex"
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
	c, err := codex.StartWire(ctx, exec.CommandContext(ctx, bin, "-test.run=TestLiveWireHelper"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var result struct {
		Method string `json:"method"`
	}
	if err := c.Call(ctx, "thread/resume", map[string]any{}, &result); err != nil || result.Method != "thread/resume" {
		t.Fatal(result, err)
	}
	for {
		select {
		case event := <-c.Events():
			if event.Method == "item/commandExecution/requestApproval" {
				if string(event.ID) != `"string-request"` {
					t.Fatal(string(event.ID))
				}
				if err := c.Reply(event.ID, map[string]string{"decision": "decline"}); err != nil {
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
	c, err := codex.OpenLive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var page codex.SessionPage
	if err := c.Call(ctx, "thread/list", map[string]any{"limit": 1}, &page); err != nil {
		t.Fatal(err)
	}
}
