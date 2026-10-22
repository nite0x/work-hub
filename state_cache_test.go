package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type stateSnapshot struct {
	Projects   []Project `json:"projects"`
	Refreshing bool      `json:"status_refreshing"`
}

func awaitState(t *testing.T, a *App, accept func(stateSnapshot) bool) []byte {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, raw := call(t, a, "GET", "/api/state", nil)
		var state stateSnapshot
		if code != 200 || json.Unmarshal(raw, &state) != nil {
			t.Fatalf("state: %d %s", code, raw)
		}
		if accept(state) {
			return raw
		}
		if time.Now().After(deadline) {
			t.Fatalf("state did not converge: %s", raw)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func settledState(t *testing.T, a *App) (int, []byte) {
	t.Helper()
	return 200, awaitState(t, a, func(s stateSnapshot) bool { return !s.Refreshing })
}

func cachedTestProject(t *testing.T, a *App) {
	t.Helper()
	_, err := a.db.Exec(`INSERT INTO projects VALUES('project','Project','/project','/project/.git','project','2026-01-01T00:00:00Z')`)
	if err != nil {
		t.Fatal(err)
	}
	a.stateCache.resolve = func(s TerminalSettings) TerminalAvailability { return TerminalAvailability{Settings: s} }
}

func TestStatePublishesFastWorktreesWithoutWaitingForSlowScanOrGlobalLock(t *testing.T) {
	a := testApp(t)
	cachedTestProject(t, a)
	started, release := make(chan struct{}), make(chan struct{})
	var slowScans atomic.Int32
	a.stateCache.discover = func(context.Context, string) ([]Worktree, bool, error) {
		return []Worktree{{Path: "/slow"}, {Path: "/fast"}}, true, nil
	}
	a.stateCache.inspect = func(ctx context.Context, w Worktree) Worktree {
		if w.Path == "/slow" {
			if slowScans.Add(1) == 1 {
				close(started)
			}
			select {
			case <-release:
			case <-ctx.Done():
				return w
			}
		}
		w.Dirty, w.StatusUpdatedAt = 3, now()
		return w
	}
	// Cancellation of the triggering browser request must not cancel shared work.
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("GET", "/api/state", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	a.stateHandler(w, r)
	cancel()
	if w.Code != 200 {
		t.Fatalf("cold response: %d", w.Code)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("scan did not start")
	}
	awaitState(t, a, func(s stateSnapshot) bool {
		if len(s.Projects[0].Worktrees) != 2 {
			return false
		}
		slow, fast := s.Projects[0].Worktrees[0], s.Projects[0].Worktrees[1]
		return slow.Refreshing && slow.StatusUpdatedAt == "" && fast.Dirty == 3 && fast.StatusUpdatedAt != ""
	})
	// Simulate a long mutation holding App.mu and eight browsers reading state.
	a.mu.Lock()
	responses := make(chan int, 8)
	for i := 0; i < cap(responses); i++ {
		go func() { code, _ := call(t, a, "GET", "/api/state", nil); responses <- code }()
	}
	for i := 0; i < cap(responses); i++ {
		select {
		case code := <-responses:
			if code != 200 {
				a.mu.Unlock()
				t.Fatalf("state: %d", code)
			}
		case <-time.After(time.Second):
			a.mu.Unlock()
			t.Fatal("state waited for the global lock or slow scanner")
		}
	}
	a.mu.Unlock()
	if slowScans.Load() != 1 {
		t.Fatalf("duplicate slow scans: %d", slowScans.Load())
	}
	close(release)
	settledState(t, a)
}

func TestStateScanConcurrencyIsBoundedAndCachedAcrossRequests(t *testing.T) {
	a := testApp(t)
	cachedTestProject(t, a)
	var scans, active, peak atomic.Int32
	started, release := make(chan struct{}, 12), make(chan struct{})
	a.stateCache.discover = func(context.Context, string) ([]Worktree, bool, error) {
		trees := make([]Worktree, 12)
		for i := range trees {
			trees[i].Path = fmt.Sprintf("/tree/%d", i)
		}
		return trees, true, nil
	}
	a.stateCache.inspect = func(ctx context.Context, w Worktree) Worktree {
		scans.Add(1)
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old; old = peak.Load() {
			if peak.CompareAndSwap(old, n) {
				break
			}
		}
		started <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
			return w
		}
		w.StatusUpdatedAt = now()
		return w
	}
	call(t, a, "GET", "/api/state", nil)
	for i := 0; i < stateScanConcurrency; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("workers did not start")
		}
	}
	for i := 0; i < 20; i++ {
		call(t, a, "GET", "/api/state", nil)
	}
	if scans.Load() != stateScanConcurrency {
		t.Fatalf("unbounded/duplicate scans: %d", scans.Load())
	}
	close(release)
	settledState(t, a)
	for i := 0; i < 20; i++ {
		call(t, a, "GET", "/api/state", nil)
	}
	if peak.Load() > stateScanConcurrency || scans.Load() != 12 {
		t.Fatalf("peak=%d scans=%d", peak.Load(), scans.Load())
	}
}

func TestStateRetainsCacheOnErrorsAndRejectsPreMutationResults(t *testing.T) {
	a := testApp(t)
	cachedTestProject(t, a)
	var phase atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	a.stateCache.discover = func(context.Context, string) ([]Worktree, bool, error) {
		if phase.Load() == 3 {
			return nil, false, errors.New("inventory failed")
		}
		return []Worktree{{Path: "/tree"}}, true, nil
	}
	a.stateCache.inspect = func(ctx context.Context, w Worktree) Worktree {
		p := phase.Load()
		if p == 1 {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return w
			}
		}
		if p == 2 {
			w.Error = "status failed"
			return w
		}
		w.Dirty = int(p) + 5
		w.StatusUpdatedAt = now()
		return w
	}
	settledState(t, a)
	phase.Store(1)
	call(t, a, "GET", "/api/state?refresh=1", nil)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("refresh did not start")
	}
	// Reads keep the previous successful dirty count during the blocked refresh.
	awaitState(t, a, func(s stateSnapshot) bool { w := s.Projects[0].Worktrees[0]; return w.Refreshing && w.Dirty == 5 })
	a.stateCache.invalidate()
	phase.Store(2)
	close(release)
	raw := awaitState(t, a, func(s stateSnapshot) bool { return !s.Refreshing && s.Projects[0].Worktrees[0].Error != "" })
	var s stateSnapshot
	json.Unmarshal(raw, &s)
	if s.Projects[0].Worktrees[0].Dirty != 5 {
		t.Fatalf("stale result replaced cache: %s", raw)
	}
	phase.Store(3)
	call(t, a, "GET", "/api/state?refresh=1", nil)
	raw = awaitState(t, a, func(s stateSnapshot) bool { return !s.Refreshing && s.Projects[0].Error != "" })
	s = stateSnapshot{}
	json.Unmarshal(raw, &s)
	if len(s.Projects[0].Worktrees) != 1 {
		t.Fatalf("inventory erased on error: %s", raw)
	}
	phase.Store(4)
	call(t, a, "GET", "/api/state?refresh=1", nil)
	raw = awaitState(t, a, func(s stateSnapshot) bool { return !s.Refreshing && s.Projects[0].Worktrees[0].Dirty == 9 })
	s = stateSnapshot{}
	json.Unmarshal(raw, &s)
	if s.Projects[0].Error != "" || s.Projects[0].Worktrees[0].Error != "" {
		t.Fatalf("recovery failed: %s", raw)
	}
}

func TestWorktreeCreationExpiresWarmStateCache(t *testing.T) {
	a := testApp(t)
	id := register(t, a, "Project", repo(t, "project", "master"))
	settledState(t, a)
	code, raw := manualWorktree(t, a, id, CreateWorktree{Slug: "new-directory", Mode: "new", Source: "refs/heads/master"})
	if code != 201 {
		t.Fatalf("create: %d %s", code, raw)
	}
	awaitState(t, a, func(s stateSnapshot) bool {
		return !s.Refreshing && len(s.Projects[0].Worktrees) == 2
	})
}

func TestStateCacheShutdownCancelsActiveJobs(t *testing.T) {
	a := testApp(t)
	cachedTestProject(t, a)
	started := make(chan struct{})
	a.stateCache.discover = func(ctx context.Context, _ string) ([]Worktree, bool, error) {
		close(started)
		<-ctx.Done()
		return nil, false, ctx.Err()
	}
	call(t, a, "GET", "/api/state", nil)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("job did not start")
	}
	closed := make(chan struct{})
	go func() { a.stateCache.close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not cancel scans")
	}
}
