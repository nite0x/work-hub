package session

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"worktree-hub/internal/codex"
)

func TestCatalogCoalescesPaginationAndReturnsIndependentMaps(t *testing.T) {
	a := testApp(t)
	var opens, lists atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		opens.Add(1)
		return &fakeSessionClient{request: func(method string, params map[string]any) (any, error) {
			if method != "thread/list" {
				return nil, fmt.Errorf("unexpected %s", method)
			}
			if lists.Add(1) == 1 {
				close(entered)
				<-release
			}
			return codex.SessionPage{Data: []codex.Session{{ID: "s", Name: "Title", Cwd: "/repo"}}}, nil
		}}, nil
	}
	first := make(chan map[string]codex.Session, 1)
	go func() {
		found, _ := a.sessionCatalog(context.Background(), sessionScope{}, false, false)
		first <- found
	}()
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.sessionCatalog(ctx, sessionScope{}, false, false); err == nil {
		t.Fatal("cancelled waiter did not leave")
	}
	second := make(chan map[string]codex.Session, 1)
	go func() {
		found, _ := a.sessionCatalog(context.Background(), sessionScope{}, false, false)
		second <- found
	}()
	close(release)
	one, two := <-first, <-second
	one["injected"] = codex.Session{ID: "injected"}
	if _, ok := two["injected"]; ok {
		t.Fatal("request maps alias shared cache")
	}
	if opens.Load() != 1 || lists.Load() != 1 {
		t.Fatalf("open=%d list=%d", opens.Load(), lists.Load())
	}
	if _, err := a.sessionCatalog(context.Background(), sessionScope{}, false, true); err != nil {
		t.Fatal(err)
	}
	if lists.Load() != 2 {
		t.Fatal("force did not refresh")
	}
	a.invalidateSessionCatalog()
	if _, err := a.sessionCatalog(context.Background(), sessionScope{}, false, false); err != nil {
		t.Fatal(err)
	}
	if lists.Load() != 3 {
		t.Fatal("mutation did not invalidate")
	}
}

func TestWorktreeReservationRejectsLiveChatAndAllowsGitOnlyInstall(t *testing.T) {
	a, q, _, endpoint := chatFixture(t)
	startFakeChat(t, a, endpoint)
	if release, err := a.ReserveWorktree(context.Background(), q.Members[0].Path); err == nil {
		release()
		t.Fatal("active chat accepted")
	}
	b := testApp(t)
	b.openSessions = func(context.Context) (codex.SessionClient, error) {
		return nil, fmt.Errorf("not installed: %w", exec.ErrNotFound)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	release, err := b.ReserveWorktree(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if b.controlMu.TryLock() {
		b.controlMu.Unlock()
		t.Fatal("reservation not held")
	}
	release()
	if !b.controlMu.TryLock() {
		t.Fatal("reservation not released")
	}
	b.controlMu.Unlock()
}

func TestWorktreeReservationFindsNativeSessionInSubdirectory(t *testing.T) {
	a := testApp(t)
	root := t.TempDir()
	native := codex.Session{ID: "native-child", Cwd: filepath.Join(root, "src")}
	native.Status.Type = "active"
	fakeSessions(a, map[string]codex.Session{native.ID: native})
	if release, err := a.ReserveWorktree(context.Background(), root); err == nil {
		release()
		t.Fatal("native subdirectory session missed")
	}
	if !a.controlMu.TryLock() {
		t.Fatal("failed reservation leaked lock")
	}
	a.controlMu.Unlock()
}
