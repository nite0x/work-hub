package workspace

import (
	"context"
	"testing"
	"time"

	"worktree-hub/internal/model"
)

func TestTerminalCacheCoalescesSettingsAndRejectsStaleDiscovery(t *testing.T) {
	started := make(chan string, 3)
	release := make(chan struct{})
	cache := newTerminalCache(func(ctx context.Context, s model.TerminalSettings) model.TerminalAvailability {
		started <- s.Kind
		if s.Kind == "first" {
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
		return model.TerminalAvailability{Settings: s, Available: true, Launcher: s.Kind}
	})
	defer cache.Close()
	cache.snapshot(model.TerminalSettings{Kind: "first"}, false)
	select {
	case name := <-started:
		if name != "first" {
			t.Fatal(name)
		}
	case <-time.After(time.Second):
		t.Fatal("discovery did not start")
	}
	cache.snapshot(model.TerminalSettings{Kind: "discarded"}, false)
	value, busy := cache.snapshot(model.TerminalSettings{Kind: "latest"}, false)
	if value.Settings.Kind != "latest" || !busy {
		t.Fatal("new preferences not reflected immediately")
	}
	select {
	case name := <-started:
		t.Fatal("concurrent terminal discovery", name)
	default:
	}
	close(release)
	select {
	case name := <-started:
		if name != "latest" {
			t.Fatal("obsolete settings were resolved", name)
		}
	case <-time.After(time.Second):
		t.Fatal("latest settings not resolved")
	}
	deadline := time.Now().Add(time.Second)
	for {
		value, busy = cache.snapshot(model.TerminalSettings{Kind: "latest"}, false)
		if !busy {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("discovery did not complete")
		}
		time.Sleep(time.Millisecond)
	}
	if value.Launcher != "latest" || !value.Available {
		t.Fatalf("stale discovery published: %+v", value)
	}
}

func TestTerminalCacheCloseCancelsDiscovery(t *testing.T) {
	started := make(chan struct{})
	cache := newTerminalCache(func(ctx context.Context, s model.TerminalSettings) model.TerminalAvailability {
		close(started)
		<-ctx.Done()
		return model.TerminalAvailability{Settings: s}
	})
	cache.snapshot(model.TerminalSettings{Kind: "custom"}, false)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("discovery did not start")
	}
	closed := make(chan struct{})
	go func() { cache.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("close did not cancel discovery")
	}
}
