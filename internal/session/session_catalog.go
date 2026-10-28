package session

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"sort"
	"time"

	"worktree-hub/internal/codex"
)

type catalogEntry struct {
	done    chan struct{}
	updated time.Time
	found   map[string]codex.Session
	err     error
}

// Share pagination and index writes across simultaneous sidebar/list requests.
// Runtime state is decorated by each caller and never cached in this catalog.
func (a *Service) sessionCatalog(ctx context.Context, scope sessionScope, archived, force bool) (map[string]codex.Session, error) {
	paths := append([]string(nil), scope.paths...)
	sort.Strings(paths)
	keyBytes, _ := json.Marshal([]any{archived, paths})
	key := string(keyBytes)
	a.catalogMu.Lock()
	if a.catalogs == nil {
		a.catalogs = map[string]*catalogEntry{}
	}
	if entry := a.catalogs[key]; entry != nil {
		select {
		case <-entry.done:
			if !force && entry.err == nil && time.Since(entry.updated) < 10*time.Second {
				a.catalogMu.Unlock()
				return maps.Clone(entry.found), nil
			}
		default:
			a.catalogMu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-entry.done:
				return maps.Clone(entry.found), entry.err
			}
		}
	}
	for key, entry := range a.catalogs {
		select {
		case <-entry.done:
			if time.Since(entry.updated) > 10*time.Second {
				delete(a.catalogs, key)
			}
		default:
		}
	}
	entry := &catalogEntry{done: make(chan struct{})}
	a.catalogs[key] = entry
	a.catalogMu.Unlock()
	entry.found, entry.err = a.scanSessionCatalog(ctx, scope, archived)
	a.catalogMu.Lock()
	entry.updated = time.Now()
	close(entry.done)
	a.catalogMu.Unlock()
	return maps.Clone(entry.found), entry.err
}

func (a *Service) invalidateSessionCatalog() {
	a.catalogMu.Lock()
	a.catalogs = nil
	a.catalogMu.Unlock()
}

func (a *Service) scanSessionCatalog(ctx context.Context, scope sessionScope, archived bool) (map[string]codex.Session, error) {
	c, err := a.openSessions(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	started, observed := time.Now().UnixMilli(), time.Now().UnixNano()
	params := map[string]any{"archived": archived}
	if scope.paths != nil {
		params["cwd"] = scope.paths
	}
	found := map[string]codex.Session{}
	seen := map[string]bool{}
	for {
		page, err := sessionList(c, params)
		if err != nil {
			return nil, err
		}
		for _, s := range page.Data {
			if s.ID == "" || !scope.includes(s.ID, s.Cwd) {
				continue
			}
			found[s.ID] = s
			if err := a.SaveSession("", s, "workspace", observed); err != nil {
				return nil, err
			}
			if err := a.Workspace.Store.ObserveSessionArchive(s.ID, archived, started); err != nil {
				return nil, err
			}
		}
		if page.NextCursor == nil {
			return found, nil
		}
		if seen[*page.NextCursor] {
			return nil, fmt.Errorf("Codex 会话分页未前进，请重试")
		}
		seen[*page.NextCursor] = true
		params["cursor"] = *page.NextCursor
	}
}
