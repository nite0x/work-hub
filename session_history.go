package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
)

// Only user-visible messages and command records cross the HTTP boundary.
// Do not forward raw thread items (which can contain internal reasoning).
type HistoryEntry struct {
	ID            string  `json:"id"`
	TurnID        string  `json:"turn_id"`
	Kind          string  `json:"kind"`
	Text          string  `json:"text,omitempty"`
	Command       string  `json:"command,omitempty"`
	Cwd           string  `json:"cwd,omitempty"`
	Status        string  `json:"status,omitempty"`
	Output        *string `json:"output"`
	ExitCode      *int    `json:"exit_code"`
	DurationMs    *int64  `json:"duration_ms"`
	StartedAtMs   *int64  `json:"started_at_ms"`
	CompletedAtMs *int64  `json:"completed_at_ms"`
}

type codexHistoryItem struct {
	ID               string          `json:"id"`
	Type             string          `json:"type"`
	Content          json.RawMessage `json:"content"`
	Text             string          `json:"text"`
	Command          string          `json:"command"`
	Cwd              string          `json:"cwd"`
	Status           string          `json:"status"`
	AggregatedOutput *string         `json:"aggregatedOutput"`
	ExitCode         *int            `json:"exitCode"`
	DurationMs       *int64          `json:"durationMs"`
	Changes          []struct {
		Path string `json:"path"`
		Diff string `json:"diff"`
	} `json:"changes"`
}

type codexHistoryEntry struct {
	TurnID        string           `json:"turnId"`
	Item          codexHistoryItem `json:"item"`
	StartedAtMs   *int64           `json:"startedAtMs"`
	CompletedAtMs *int64           `json:"completedAtMs"`
}

type SessionHistory struct {
	Session    CodexSession   `json:"session"`
	Entries    []HistoryEntry `json:"entries"`
	NextCursor *string        `json:"next_cursor"`
}

func visibleHistoryEntry(raw codexHistoryEntry) (HistoryEntry, bool) {
	i := raw.Item
	e := HistoryEntry{ID: i.ID, TurnID: raw.TurnID, StartedAtMs: raw.StartedAtMs, CompletedAtMs: raw.CompletedAtMs}
	switch i.Type {
	case "userMessage":
		e.Kind = "user"
		var inputs []struct {
			Type string `json:"type"`
			Text string `json:"text"`
			Path string `json:"path"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(i.Content, &inputs); err != nil {
			e.Text = "[无法读取此消息内容]"
			return e, true
		}
		parts := []string{}
		for _, input := range inputs {
			switch input.Type {
			case "text":
				parts = append(parts, input.Text)
			case "image":
				parts = append(parts, "[图片附件]")
			case "localImage":
				parts = append(parts, "[图片附件] "+input.Path)
			case "audio", "localAudio":
				parts = append(parts, "[音频附件]")
			case "skill":
				parts = append(parts, "[技能] "+input.Name)
			case "mention":
				parts = append(parts, "[引用] "+input.Name)
			default:
				parts = append(parts, "[附件]")
			}
		}
		e.Text = strings.Join(parts, "\n\n")
	case "agentMessage":
		e.Kind, e.Text = "assistant", i.Text
	case "commandExecution":
		e.Kind, e.Command, e.Cwd, e.Status = "command", i.Command, i.Cwd, i.Status
		e.Output, e.ExitCode, e.DurationMs = i.AggregatedOutput, i.ExitCode, i.DurationMs
	default:
		return e, false
	}
	return e, true
}

func readSessionHistory(c sessionClient, s CodexSession, cursor string) (SessionHistory, error) {
	history := SessionHistory{Session: s, Entries: []HistoryEntry{}}
	// The list endpoint only needs the title. Keep previews out of the history
	// response as well; the actual messages are represented by entries below.
	history.Session.Name = sessionName(s)
	history.Session.Preview = ""
	params := map[string]any{"threadId": s.ID, "sortDirection": "desc"}
	if cursor != "" {
		params["cursor"] = cursor
	}
	if s.HistoryMode == "paginated" {
		params["limit"] = 50
		var page struct {
			Data       []codexHistoryEntry `json:"data"`
			NextCursor *string             `json:"nextCursor"`
		}
		if err := c.call("thread/items/list", params, &page); err != nil {
			return history, err
		}
		slices.Reverse(page.Data)
		for _, raw := range page.Data {
			if e, ok := visibleHistoryEntry(raw); ok {
				history.Entries = append(history.Entries, e)
			}
		}
		history.NextCursor = page.NextCursor
	} else {
		// Legacy threads do not support item pagination. Page a small number of
		// complete turns instead; items inside each turn are already chronological.
		params["limit"], params["itemsView"] = 5, "full"
		var page struct {
			Data []struct {
				ID    string             `json:"id"`
				Items []codexHistoryItem `json:"items"`
			} `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		if err := c.call("thread/turns/list", params, &page); err != nil {
			return history, err
		}
		slices.Reverse(page.Data)
		for _, turn := range page.Data {
			for _, item := range turn.Items {
				if e, ok := visibleHistoryEntry(codexHistoryEntry{TurnID: turn.ID, Item: item}); ok {
					history.Entries = append(history.Entries, e)
				}
			}
		}
		history.NextCursor = page.NextCursor
	}
	return history, nil
}

func (a *App) historySessionAllowed(w http.ResponseWriter, r *http.Request) bool {
	a.mu.Lock()
	_, ok := a.sessionRequirement(w, r)
	if !ok {
		a.mu.Unlock()
		return false
	}
	var id string
	err := a.db.QueryRow(`SELECT session_id FROM requirement_sessions WHERE requirement_id=? AND session_id=?`, r.PathValue("id"), r.PathValue("session")).Scan(&id)
	a.mu.Unlock()
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, 404, "会话未关联到该任务，请先关联")
		return false
	}
	if err != nil {
		dbError(w, err)
		return false
	}
	return true
}

func (a *App) sessionHistoryHandler(w http.ResponseWriter, r *http.Request) {
	if !a.historySessionAllowed(w, r) {
		return
	}
	c, err := a.openSessions(r.Context())
	if err != nil {
		writeError(w, 503, err.Error())
		return
	}
	defer c.close()
	s, err := readSession(c, r.PathValue("session"))
	if err != nil {
		writeError(w, 503, "无法读取会话详情："+err.Error())
		return
	}
	history, err := readSessionHistory(c, s, r.URL.Query().Get("cursor"))
	if err != nil {
		writeError(w, 503, "无法读取会话历史："+err.Error())
		return
	}
	writeJSON(w, 200, history)
}
