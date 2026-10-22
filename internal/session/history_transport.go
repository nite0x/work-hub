package session

import (
	"context"
	"encoding/json"

	"worktree-hub/internal/workspace"
)

// WatchCodexHistoryRaw adapts display snapshots to the workspace wire format.
// Transport and agent hosts never need to know the history model.
func WatchCodexHistoryRaw(ctx context.Context, id string, emit func(json.RawMessage) error) error {
	return WatchCodexHistory(ctx, id, func(state HistoryPush) error {
		raw, err := json.Marshal(state)
		if err != nil {
			return err
		}
		return emit(raw)
	})
}

func watchRemoteHistory(ctx context.Context, client *workspace.Client, id string, emit func(HistoryPush) error) error {
	return client.Stream(ctx, workspace.Request{Op: "session-watch", Path: id}, func(raw json.RawMessage) error {
		var state HistoryPush
		if err := json.Unmarshal(raw, &state); err != nil {
			return err
		}
		return emit(state)
	})
}
