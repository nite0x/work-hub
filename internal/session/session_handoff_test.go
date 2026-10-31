//go:build linux

package session

import (
	"context"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"worktree-hub/internal/codex"
)

func managedFixture(t *testing.T) (*App, *fakeLiveClient, *terminalBridge, string) {
	a, q, c, endpoint := chatFixture(t)
	// This process belongs only to this test; production never signals an
	// unverified process discovered by cwd or command-line guesses.
	child := exec.Command("sleep", "60")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	b := &terminalBridge{app: a.Service, requirement: q.ID, session: "session", cwd: q.Members[0].Path, connected: true, bound: true, active: true, peer: child.Process, pending: map[string]bridgeCall{}}
	a.bridges["fixture"] = b
	return a, c, b, endpoint
}
func TestHandoffWaitsWithoutInterruptingAndThenEnablesSidebar(t *testing.T) {
	a, c, b, endpoint := managedFixture(t)
	if code, raw := call(t, a, "POST", endpoint+"/handoff", map[string]string{"request_id": "handoff"}); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	time.Sleep(100 * time.Millisecond)
	if s := a.ChatFor("session").snapshot(); s.Status != "handoff" || !s.Busy {
		t.Fatal(s)
	}
	if code, _ := call(t, a, "POST", endpoint, map[string]string{"text": "next", "request_id": "too-early"}); code != 409 {
		t.Fatal("concurrent send accepted")
	}
	b.mu.Lock()
	b.active = false
	b.mu.Unlock()
	s := awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	if s.Status != "idle" {
		t.Fatal(s)
	}
	c.mu.Lock()
	methods := strings.Join(c.methods, ",")
	c.mu.Unlock()
	if strings.Contains(methods, "turn/interrupt") || strings.Contains(methods, "turn/start") {
		t.Fatal("handoff interrupted or added a turn", methods)
	}
	b.mu.Lock()
	revoked := b.revoked
	b.mu.Unlock()
	if !revoked {
		t.Fatal("terminal still owns connection")
	}
}
func TestCancelHandoffLeavesTerminalRunning(t *testing.T) {
	a, c, b, endpoint := managedFixture(t)
	if code, _ := call(t, a, "POST", endpoint+"/handoff", map[string]string{"request_id": "cancel"}); code != 202 {
		t.Fatal(code)
	}
	if code, _ := call(t, a, "POST", endpoint+"/stop", map[string]string{"run_id": "cancel"}); code != 200 {
		t.Fatal(code)
	}
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	b.mu.Lock()
	revoked, draining := b.revoked, b.draining
	b.mu.Unlock()
	if revoked || draining {
		t.Fatal("cancel revoked the terminal")
	}
	if err := b.peer.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("cancel terminated the terminal", err)
	}
	c.mu.Lock()
	methods := strings.Join(c.methods, ",")
	c.mu.Unlock()
	if strings.Contains(methods, "interrupt") {
		t.Fatal(methods)
	}
}
func TestUnmanagedHandoffIsRejectedWithoutOpeningCodex(t *testing.T) {
	a, _, _, endpoint := chatFixture(t)
	a.openLive = func(context.Context) (codex.LiveClient, error) {
		t.Fatal("unmanaged process was touched")
		return nil, nil
	}
	if code, raw := call(t, a, "POST", endpoint+"/handoff", map[string]string{"request_id": "manual"}); code != 409 || !strings.Contains(string(raw), "无法准确识别") {
		t.Fatalf("%d %s", code, raw)
	}
}
