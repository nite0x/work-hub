package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"time"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/httpx"
)

// Only displayable, bounded snapshots cross the workspace and HTTP boundaries.
// Snapshots can be coalesced when a reader is slow without losing text deltas.
type HistoryPush struct {
	Connected     bool                  `json:"connected"`
	Entries       []HistoryEntry        `json:"entries"`
	Sync          uint64                `json:"sync"`
	Message       string                `json:"message,omitempty"`
	Waiting       bool                  `json:"waiting"`
	Confirmations []HistoryConfirmation `json:"confirmations"`
}

// Display only: no RPC routing or response capability crosses this boundary.
type HistoryConfirmation struct {
	ID        string         `json:"id"`
	Title     string         `json:"title"`
	Details   string         `json:"details,omitempty"`
	Questions []ChatQuestion `json:"questions,omitempty"`
}

type historyThreadStatus struct {
	Type        string   `json:"type"`
	ActiveFlags []string `json:"activeFlags"`
}

func (s *HistoryPush) setStatus(status historyThreadStatus) {
	s.Waiting = slices.Contains(status.ActiveFlags, "waitingOnApproval") || slices.Contains(status.ActiveFlags, "waitingOnUserInput")
	if status.Type == "idle" || status.Type == "notLoaded" || status.Type == "systemError" {
		s.Confirmations = nil
	}
}

type orderedLiveClient interface {
	codex.LiveClient
	CallOrdered(context.Context, string, any, any) (uint64, error)
}

func openHistoryObserver(ctx context.Context) (orderedLiveClient, error) {
	conn, err := codex.DialDaemon(ctx)
	if err != nil {
		return nil, err
	}
	c, err := codex.StartWebSocketWithCapabilities(ctx, conn, map[string]any{"experimentalApi": true})
	if err != nil {
		return nil, err
	}
	return c.(orderedLiveClient), nil
}

func WatchCodexHistory(ctx context.Context, session string, emit func(HistoryPush) error) error {
	c, err := openHistoryObserver(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	return observeHistory(ctx, c, session, emit)
}

func observeHistory(ctx context.Context, c orderedLiveClient, session string, emit func(HistoryPush) error) error {
	state := HistoryPush{Entries: []HistoryEntry{}, Message: "等待终端加载会话"}
	if err := emit(state); err != nil {
		return err
	}
	check := time.NewTicker(2 * time.Second)
	defer check.Stop()
	// Never load an inactive stored thread just to view it. Rejoin only a thread
	// already loaded by another client, without any configuration overrides.
	for {
		var metadata struct {
			Thread struct {
				Status struct {
					Type string `json:"type"`
				} `json:"status"`
			} `json:"thread"`
		}
		callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := c.Call(callCtx, "thread/read", map[string]any{"threadId": session, "includeTurns": false}, &metadata)
		cancel()
		if err != nil {
			return err
		}
		if metadata.Thread.Status.Type != "" && metadata.Thread.Status.Type != "notLoaded" {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case _, ok := <-c.Events():
			if !ok {
				return fmt.Errorf("Codex 实时连接已断开")
			}
		case <-check.C:
		}
	}
	var resumed struct {
		Thread struct {
			Status historyThreadStatus `json:"status"`
		} `json:"thread"`
		InitialTurnsPage *struct {
			Data []struct {
				ID     string             `json:"id"`
				Status string             `json:"status"`
				Items  []codexHistoryItem `json:"items"`
			} `json:"data"`
		} `json:"initialTurnsPage"`
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	boundary, err := c.CallOrdered(callCtx, "thread/resume", map[string]any{
		"threadId": session, "excludeTurns": true,
		"initialTurnsPage": map[string]any{"limit": 1, "sortDirection": "desc", "itemsView": "full"},
	}, &resumed)
	cancel()
	if err != nil {
		return err
	}
	defer func() {
		endCtx, done := context.WithTimeout(context.Background(), 2*time.Second)
		defer done()
		_ = c.Call(endCtx, "thread/unsubscribe", map[string]any{"threadId": session}, nil)
	}()
	state.Connected, state.Message = true, ""
	state.setStatus(resumed.Thread.Status)
	if resumed.InitialTurnsPage != nil {
		for _, turn := range resumed.InitialTurnsPage.Data {
			for _, item := range turn.Items {
				if entry, ok := visibleHistoryEntry(codexHistoryEntry{TurnID: turn.ID, Item: item}); ok {
					if entry.Kind == "assistant" {
						entry.Status = turn.Status
					}
					state.upsert(entry)
				}
			}
		}
	}
	if err := emit(state); err != nil {
		return err
	}
	flush := time.NewTicker(50 * time.Millisecond)
	defer flush.Stop()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	dirty := false
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, ok := <-c.Events():
			if !ok {
				return fmt.Errorf("Codex 实时连接已断开")
			}
			// The resume snapshot includes everything before its response. Do not
			// append those queued deltas again when opening halfway through a turn.
			// Pending requests can be replayed before the resume response. Their
			// matching resolution/status events must also be processed in order.
			control := len(event.ID) != 0 || event.Method == "serverRequest/resolved" || event.Method == "thread/status/changed"
			if event.Sequence <= boundary && !control {
				continue
			}
			if state.apply(session, event) {
				dirty = true
			}
		case <-flush.C:
			if dirty {
				if err := emit(state); err != nil {
					return err
				}
				dirty = false
				if !state.Connected {
					return nil
				}
			}
		case <-heartbeat.C:
			if err := emit(state); err != nil {
				return err
			}
		}
	}
}

func (s *HistoryPush) upsert(entry HistoryEntry) {
	entry.Text = boundedChatText(entry.Text)
	if entry.Output != nil {
		out := boundedChatText(*entry.Output)
		entry.Output = &out
	}
	index := slices.IndexFunc(s.Entries, func(old HistoryEntry) bool { return old.ID == entry.ID && old.TurnID == entry.TurnID })
	if index >= 0 {
		old := s.Entries[index]
		if entry.Output == nil {
			entry.Output = old.Output
		}
		if entry.StartedAtMs == nil {
			entry.StartedAtMs = old.StartedAtMs
		}
		s.Entries[index] = entry
	} else {
		s.Entries = append(s.Entries, entry)
	}
	// Keep the transport bounded; the ordinary history endpoint retains full
	// records. Removing an old preview never removes it from the browser timeline.
	size := 0
	first := len(s.Entries)
	for first > 0 && len(s.Entries)-first < 100 {
		e := s.Entries[first-1]
		size += len(e.Text) + len(e.Command)
		if e.Output != nil {
			size += len(*e.Output)
		}
		if size > 2<<20 {
			break
		}
		first--
	}
	s.Entries = s.Entries[first:]
}

func (s *HistoryPush) apply(session string, event codex.Event) bool {
	var p struct {
		ThreadID  string              `json:"threadId"`
		TurnID    string              `json:"turnId"`
		ItemID    string              `json:"itemId"`
		Delta     string              `json:"delta"`
		Item      codexHistoryItem    `json:"item"`
		RequestID json.RawMessage     `json:"requestId"`
		Status    historyThreadStatus `json:"status"`
	}
	if json.Unmarshal(event.Params, &p) != nil || p.ThreadID != session {
		return false
	}
	if len(event.ID) != 0 && string(event.ID) != "null" {
		approval, err := makeChatApproval(event)
		if err != nil {
			return false
		}
		confirmation := HistoryConfirmation{ID: string(event.ID), Title: approval.Title, Details: boundedChatText(approval.Details), Questions: approval.Questions}
		// Command text is optional in an approval event; recover its display
		// context from the command item already observed on this connection.
		if event.Method == "item/commandExecution/requestApproval" {
			for _, entry := range s.Entries {
				if entry.Kind == "command" && entry.ID == p.ItemID && entry.TurnID == p.TurnID {
					confirmation.Details = boundedChatText(entry.Command + "\n" + entry.Cwd + "\n" + confirmation.Details)
					break
				}
			}
		}
		if event.Method == "mcpServer/elicitation/request" {
			confirmation.Details = "外部工具正在等待交互，请在原终端查看并处理。"
		}
		index := slices.IndexFunc(s.Confirmations, func(c HistoryConfirmation) bool { return c.ID == confirmation.ID })
		if index >= 0 {
			s.Confirmations[index] = confirmation
		} else {
			s.Confirmations = append(s.Confirmations, confirmation)
		}
		return true
	}
	switch event.Method {
	case "serverRequest/resolved":
		s.Confirmations = slices.DeleteFunc(s.Confirmations, func(c HistoryConfirmation) bool { return c.ID == string(p.RequestID) })
		if len(s.Confirmations) == 0 {
			s.Waiting = false
		}
	case "thread/status/changed":
		s.setStatus(p.Status)
	case "turn/started":
		s.Confirmations, s.Waiting = nil, false
	case "item/started", "item/completed":
		entry, ok := visibleHistoryEntry(codexHistoryEntry{TurnID: p.TurnID, Item: p.Item})
		if !ok {
			return false
		}
		if entry.Kind == "assistant" || entry.Kind == "activity" && entry.Status == "" {
			entry.Status = "completed"
			if event.Method == "item/started" {
				entry.Status = "inProgress"
			}
		}
		s.upsert(entry)
	case "item/agentMessage/delta", "item/commandExecution/outputDelta", "item/plan/delta":
		index := slices.IndexFunc(s.Entries, func(e HistoryEntry) bool { return e.ID == p.ItemID && e.TurnID == p.TurnID })
		entry := HistoryEntry{ID: p.ItemID, TurnID: p.TurnID, Status: "inProgress"}
		if index >= 0 {
			entry = s.Entries[index]
		}
		if event.Method == "item/plan/delta" {
			entry.Kind, entry.Tool, entry.Text = "activity", "计划", entry.Text+p.Delta
		} else if event.Method == "item/agentMessage/delta" {
			entry.Kind, entry.Text = "assistant", entry.Text+p.Delta
		} else {
			entry.Kind = "command"
			out := p.Delta
			if entry.Output != nil {
				out = *entry.Output + out
			}
			entry.Output = &out
		}
		s.upsert(entry)
	case "turn/completed", "thread/reverted":
		s.Confirmations, s.Waiting = nil, false
		s.Sync++
	case "thread/closed":
		s.Confirmations, s.Waiting = nil, false
		s.Connected, s.Message = false, "终端会话已卸载，正在重连"
	default:
		return false
	}
	return true
}

func (a *Service) SessionHistoryEventsHandler(w http.ResponseWriter, r *http.Request) {
	if !a.HistorySessionAllowed(w, r) {
		return
	}
	if _, ok := w.(http.Flusher); !ok {
		httpx.WriteError(w, 500, "连接不支持实时输出")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	emit := func(state HistoryPush) error {
		_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
		a.prepareHistoryMedia(r.PathValue("session"), state.Entries)
		raw, err := json.Marshal(state)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
			return err
		}
		return controller.Flush()
	}
	_ = emit(HistoryPush{Entries: []HistoryEntry{}, Message: "正在连接终端实时输出"})
	if err := a.watchHistory(r.Context(), r.PathValue("session"), emit); err != nil && r.Context().Err() == nil {
		_ = emit(HistoryPush{Entries: []HistoryEntry{}, Message: "实时连接暂不可用：" + err.Error()})
	}
}
