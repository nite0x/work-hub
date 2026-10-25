package session

import (
	"context"
	"slices"
	"worktree-hub/internal/codex"
	"worktree-hub/internal/workspace"
)

func (a *Service) sessionActivity(ctx context.Context, s codex.Session) codex.Activity {
	if s.Status.Type == "active" {
		status := "running"
		if slices.Contains(s.Status.ActiveFlags, "waitingOnApproval") || slices.Contains(s.Status.ActiveFlags, "waitingOnUserInput") {
			status = "waiting"
		}
		return codex.Activity{Status: status}
	}
	if s.Path == "" {
		return codex.Activity{Status: "unknown"}
	}
	if a.Workspace.Remote != nil {
		var activity codex.Activity
		if a.Workspace.Remote.Call(ctx, workspace.Request{Op: "rollout-activity", Path: s.Path}, &activity) != nil {
			return codex.Activity{Status: "unknown"}
		}
		return activity
	}
	return codex.RolloutActivity(s.Path)
}
func (a *Service) externalActivity(ctx context.Context, id string) (codex.Activity, bool) {
	c, err := a.openSessions(ctx)
	if err != nil {
		return codex.Activity{Status: "unknown"}, true
	}
	defer c.Close()
	s, err := readSession(c, id)
	if err != nil {
		return codex.Activity{Status: "unknown"}, true
	}
	// Old CLI protocols and test doubles may omit both fields altogether.
	if s.Path == "" && s.Status.Type == "" {
		return codex.Activity{}, false
	}
	return a.sessionActivity(ctx, s), true
}
