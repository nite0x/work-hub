package session

import (
	"context"
	"errors"
	"fmt"
	"os/exec"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/platform"
)

// ReserveWorktree excludes chat/terminal starts until a directory removal is
// complete. Callers acquire this before the workspace metadata lock.
func (a *Service) ReserveWorktree(ctx context.Context, path string) (func(), error) {
	a.controlMu.Lock()
	ok := false
	defer func() {
		if !ok {
			a.controlMu.Unlock()
		}
	}()
	uses := func(cwd string, extra []string) bool {
		if platform.SameWorkspacePath(path, cwd) || platform.Within(path, cwd) {
			return true
		}
		for _, dir := range extra {
			if platform.SameWorkspacePath(path, dir) || platform.Within(path, dir) {
				return true
			}
		}
		return false
	}
	a.bridgeMu.Lock()
	for _, b := range a.bridges {
		b.mu.Lock()
		busy := !b.revoked && uses(b.cwd, b.additionalDirectories)
		b.mu.Unlock()
		if busy {
			a.bridgeMu.Unlock()
			return nil, fmt.Errorf("该目录仍有工作台终端，请先退出终端会话")
		}
	}
	a.bridgeMu.Unlock()
	records, err := a.Workspace.Store.Sessions()
	if err != nil {
		return nil, err
	}
	known := map[string]bool{}
	for _, s := range records {
		if !uses(s.Cwd, s.AdditionalDirectories) {
			continue
		}
		known[s.ID] = true
		if a.ChatBusy(s.ID) {
			return nil, fmt.Errorf("该目录仍有运行中的会话：%s", s.Name)
		}
		if err := a.AppTerminalConflict(s.ID, s.Cwd); err != nil {
			return nil, err
		}
	}
	c, err := a.openSessions(ctx)
	if err != nil {
		// Git-only installations can clean directories without Codex installed.
		if len(known) == 0 && errors.Is(err, exec.ErrNotFound) {
			ok = true
			return a.controlMu.Unlock, nil
		}
		return nil, fmt.Errorf("无法核实 Codex 会话状态，请检查连接后重试：%w", err)
	}
	defer c.Close()
	check := func(s codex.Session) error {
		activity := a.sessionActivity(ctx, s)
		if activity.Status == "running" || activity.Status == "waiting" {
			return fmt.Errorf("该目录仍有运行中的 Codex 会话：%s", s.ID)
		}
		if activity.Status == "unknown" && s.Status.Type != "idle" {
			return fmt.Errorf("会话状态待核实，请先确认会话已结束：%s", s.ID)
		}
		return nil
	}
	// Native sessions may start in a subdirectory. An exact cwd filter would
	// miss those sessions, so the occasional removal check scans all metadata.
	params := map[string]any{}
	seen := map[string]bool{}
	for {
		page, err := sessionList(c, params)
		if err != nil {
			return nil, err
		}
		for _, s := range page.Data {
			if uses(s.Cwd, nil) {
				if err := check(s); err != nil {
					return nil, err
				}
				delete(known, s.ID)
			}
		}
		if page.NextCursor == nil {
			break
		}
		if seen[*page.NextCursor] {
			return nil, fmt.Errorf("会话分页未前进，无法核实目录占用")
		}
		seen[*page.NextCursor] = true
		params["cursor"] = *page.NextCursor
	}
	for id := range known {
		s, err := readSession(c, id)
		if err != nil {
			return nil, fmt.Errorf("无法核实关联会话 %s，请刷新检查后重试", id)
		}
		if err := check(s); err != nil {
			return nil, err
		}
	}
	ok = true
	return a.controlMu.Unlock, nil
}
