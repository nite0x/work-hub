package app

import (
	"io"

	"worktree-hub/internal/session"
	"worktree-hub/internal/workspace"
)

func runWorkspaceAgent(input io.Reader, output io.Writer) error {
	return workspace.RunAgent(input, output, workspace.AgentHooks{WatchHistory: session.WatchCodexHistoryRaw, TerminalConflict: session.TerminalSessionConflict})
}
