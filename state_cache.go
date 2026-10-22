package main

import (
	"context"
	"net/http"
	"os"
	"sync"
	"time"
)

const stateRefreshInterval = 10 * time.Second
const stateScanConcurrency = 4

type cachedWorktree struct {
	value      Worktree
	checkedAt  time.Time
	refreshing bool
}

type cachedProject struct {
	path       string
	trees      []Worktree
	worktrees  map[string]*cachedWorktree
	hasMaster  bool
	error      string
	updatedAt  string
	checkedAt  time.Time
	refreshing bool
}

type cachedTerminal struct {
	value      TerminalAvailability
	checkedAt  time.Time
	refreshing bool
}

// Only in-memory scheduling/publication holds mu. Git and executable discovery
// run outside both this mutex and App.mu. No goroutines wait for worker slots:
// the queue is deduplicated by the per-entry refreshing flags.
type stateCache struct {
	mu         sync.Mutex
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	closed     bool
	active     int
	queue      []func(context.Context)
	generation uint64
	projects   map[string]*cachedProject
	terminal   *cachedTerminal
	updatedAt  string
	discover   func(context.Context, string) ([]Worktree, bool, error)
	inspect    func(context.Context, Worktree) Worktree
	resolve    func(TerminalSettings) TerminalAvailability
}

func newStateCache() *stateCache {
	ctx, cancel := context.WithCancel(context.Background())
	return &stateCache{
		ctx: ctx, cancel: cancel, projects: map[string]*cachedProject{},
		discover: discoverProjectState, inspect: scanWorktreeStatus, resolve: terminalAvailability,
	}
}

func discoverProjectState(ctx context.Context, path string) ([]Worktree, bool, error) {
	raw, err := git(ctx, path, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, false, err
	}
	_, err = git(ctx, path, "rev-parse", "--verify", "refs/heads/master^{commit}")
	return parseWorktrees(raw), err == nil, nil
}

func (c *stateCache) close() {
	c.mu.Lock()
	c.closed = true
	c.queue = nil
	c.cancel()
	c.mu.Unlock()
	c.wg.Wait()
}

func (c *stateCache) enqueueLocked(job func(context.Context)) {
	if c.closed {
		return
	}
	c.queue = append(c.queue, job)
	c.dispatchLocked()
}

func (c *stateCache) dispatchLocked() {
	for !c.closed && c.active < stateScanConcurrency && len(c.queue) > 0 {
		job := c.queue[0]
		c.queue[0] = nil
		c.queue = c.queue[1:]
		c.active++
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			ctx, cancel := context.WithTimeout(c.ctx, 25*time.Second)
			defer cancel()
			job(ctx)
			c.mu.Lock()
			c.active--
			c.dispatchLocked()
			c.mu.Unlock()
		}()
	}
}

func (c *stateCache) refreshProjectLocked(id string, p *cachedProject) {
	p.refreshing = true
	generation := c.generation
	c.enqueueLocked(func(ctx context.Context) {
		c.mu.Lock()
		valid := !c.closed && c.projects[id] == p && generation == c.generation
		if !valid {
			p.refreshing = false
		}
		c.mu.Unlock()
		if !valid {
			return
		}
		trees, master, err := c.discover(ctx, p.path)
		c.mu.Lock()
		defer c.mu.Unlock()
		p.refreshing = false
		if c.closed || c.projects[id] != p || generation != c.generation {
			return
		}
		p.checkedAt = time.Now()
		if err != nil {
			// Keep the last inventory on transient errors.
			p.error = err.Error()
			return
		}
		p.error, p.hasMaster, p.trees = "", master, trees
		p.updatedAt = now()
		c.updatedAt = p.updatedAt
		current := make(map[string]*cachedWorktree, len(trees))
		for _, tree := range trees {
			entry := p.worktrees[tree.Path]
			if entry == nil || !sameWorktree(entry.value, tree) {
				entry = &cachedWorktree{value: tree}
			}
			current[tree.Path] = entry
		}
		p.worktrees = current
		for _, tree := range trees {
			entry := current[tree.Path]
			if !entry.refreshing && time.Since(entry.checkedAt) >= stateRefreshInterval {
				c.refreshWorktreeLocked(id, p, entry)
			}
		}
	})
}

func sameWorktree(a, b Worktree) bool {
	return a.Path == b.Path && a.Head == b.Head && a.Branch == b.Branch &&
		a.Bare == b.Bare && a.Detached == b.Detached && a.Locked == b.Locked && a.Prunable == b.Prunable
}

func (c *stateCache) refreshWorktreeLocked(id string, p *cachedProject, entry *cachedWorktree) {
	entry.refreshing = true
	generation := c.generation
	// Inventory fields are copied; status fields are rebuilt by the scanner.
	tree := entry.value
	tree.Dirty, tree.Ahead, tree.Behind = 0, 0, 0
	tree.Missing, tree.CompareAvailable, tree.Refreshing = false, false, false
	tree.Error, tree.StatusUpdatedAt = "", ""
	c.enqueueLocked(func(ctx context.Context) {
		c.mu.Lock()
		valid := !c.closed && c.projects[id] == p && p.worktrees[tree.Path] == entry && generation == c.generation
		if !valid {
			entry.refreshing = false
		}
		c.mu.Unlock()
		if !valid {
			return
		}
		value := c.inspect(ctx, tree)
		c.mu.Lock()
		defer c.mu.Unlock()
		entry.refreshing = false
		if c.closed || c.projects[id] != p || p.worktrees[tree.Path] != entry || generation != c.generation {
			return
		}
		entry.checkedAt = time.Now()
		if value.Error != "" {
			// An unsuccessful refresh must not erase the previous dirty count.
			entry.value.Error = value.Error
			return
		}
		entry.value = value
		c.updatedAt = value.StatusUpdatedAt
	})
}

// Mutations expire results without dropping them. Results started before a
// mutation cannot overwrite the subsequent state, even if they finish later.
func (c *stateCache) invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.generation++
	for _, p := range c.projects {
		p.checkedAt = time.Time{}
		for _, tree := range p.worktrees {
			tree.checkedAt = time.Time{}
		}
	}
}

func (a *App) invalidateStateAfter(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer a.stateCache.invalidate()
		next(w, r)
	}
}

// A request reads metadata from SQLite and calls snapshot; neither step waits
// for App.mu or a Git scan. Multiple browsers share the same cache and queue.
func (c *stateCache) snapshot(projects []Project, settings TerminalSettings, force bool) (TerminalAvailability, bool, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	live := make(map[string]bool, len(projects))
	refreshing := false
	for i := range projects {
		project := &projects[i]
		live[project.ID] = true
		p := c.projects[project.ID]
		if p == nil || p.path != project.Path {
			p = &cachedProject{path: project.Path, worktrees: map[string]*cachedWorktree{}}
			c.projects[project.ID] = p
		}
		if !p.refreshing && (force || time.Since(p.checkedAt) >= stateRefreshInterval) {
			c.refreshProjectLocked(project.ID, p)
		}
		project.HasMaster, project.Error, project.StatusUpdatedAt = p.hasMaster, p.error, p.updatedAt
		project.Refreshing = p.refreshing
		for _, metadata := range p.trees {
			entry := p.worktrees[metadata.Path]
			if !entry.refreshing && (force || time.Since(entry.checkedAt) >= stateRefreshInterval) {
				c.refreshWorktreeLocked(project.ID, p, entry)
			}
			tree := entry.value
			tree.Refreshing = entry.refreshing
			project.Worktrees = append(project.Worktrees, tree)
			project.Refreshing = project.Refreshing || tree.Refreshing
		}
		refreshing = refreshing || project.Refreshing
	}
	for id := range c.projects {
		if !live[id] {
			delete(c.projects, id)
		}
	}
	if c.terminal == nil || c.terminal.value.Settings != settings {
		c.terminal = &cachedTerminal{value: TerminalAvailability{
			Settings: settings, Distro: os.Getenv("WSL_DISTRO_NAME"), Message: "正在检查终端可用性…",
		}}
	}
	t := c.terminal
	if !t.refreshing && (force || time.Since(t.checkedAt) >= time.Minute) {
		t.refreshing = true
		c.enqueueLocked(func(ctx context.Context) {
			value := c.resolve(settings)
			c.mu.Lock()
			defer c.mu.Unlock()
			if !c.closed && c.terminal == t {
				t.value, t.checkedAt, t.refreshing = value, time.Now(), false
			}
		})
	}
	return t.value, refreshing || t.refreshing, c.updatedAt
}
