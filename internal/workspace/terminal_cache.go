package workspace

import (
	"context"
	"sync"
	"time"

	"worktree-hub/internal/model"
)

type terminalEntry struct {
	value      model.TerminalAvailability
	checkedAt  time.Time
	refreshing bool
}

// Availability discovery belongs to the execution environment. It runs
// independently of repository scans and never blocks a state request.
type terminalCache struct {
	mu      sync.Mutex
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	closed  bool
	running bool
	entry   *terminalEntry
	resolve func(context.Context, model.TerminalSettings) model.TerminalAvailability
}

func newTerminalCache(resolve func(context.Context, model.TerminalSettings) model.TerminalAvailability) *terminalCache {
	ctx, cancel := context.WithCancel(context.Background())
	return &terminalCache{ctx: ctx, cancel: cancel, resolve: resolve}
}

func (c *terminalCache) snapshot(settings model.TerminalSettings, force bool) (model.TerminalAvailability, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entry == nil || c.entry.value.Settings != settings {
		value := terminalPlatformInfo(settings)
		value.Message = "正在检查终端可用性…"
		c.entry = &terminalEntry{value: value}
	}
	entry := c.entry
	if !c.closed && !entry.refreshing && (force || time.Since(entry.checkedAt) >= time.Minute) {
		entry.refreshing = true
		if !c.running {
			c.running = true
			c.wg.Add(1)
			go c.refresh(entry)
		}
	}
	return entry.value, entry.refreshing
}

// Keep one resolver per environment. Preference changes replace the pending
// entry, so a slow discovery cannot publish old settings or spawn a backlog.
func (c *terminalCache) refresh(entry *terminalEntry) {
	defer c.wg.Done()
	for {
		value := c.resolve(c.ctx, entry.value.Settings)
		c.mu.Lock()
		if c.closed {
			c.running = false
			c.mu.Unlock()
			return
		}
		if c.entry == entry {
			entry.value, entry.checkedAt, entry.refreshing = value, time.Now(), false
			c.running = false
			c.mu.Unlock()
			return
		}
		entry = c.entry
		c.mu.Unlock()
	}
}

func (c *terminalCache) Close() {
	c.mu.Lock()
	c.closed = true
	c.cancel()
	c.mu.Unlock()
	c.wg.Wait()
}
