package session

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"time"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/httpx"
)

// Only user-visible messages and command records cross the HTTP boundary.
// Do not forward raw thread items (which can contain internal reasoning).
type HistoryEntry struct {
	LocalImages     map[string]string `json:"local_images,omitempty"`
	LocalImagePaths []string          `json:"-"`
	ID              string            `json:"id"`
	TurnID          string            `json:"turn_id"`
	Kind            string            `json:"kind"`
	Text            string            `json:"text,omitempty"`
	Command         string            `json:"command,omitempty"`
	Cwd             string            `json:"cwd,omitempty"`
	Status          string            `json:"status,omitempty"`
	Output          *string           `json:"output"`
	ExitCode        *int              `json:"exit_code"`
	DurationMs      *int64            `json:"duration_ms"`
	StartedAtMs     *int64            `json:"started_at_ms"`
	CompletedAtMs   *int64            `json:"completed_at_ms"`
	Tool            string            `json:"tool,omitempty"`
	Images          []string          `json:"images,omitempty"`
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
	Server           string          `json:"server"`
	Tool             string          `json:"tool"`
	Query            string          `json:"query"`
	Path             string          `json:"path"`
	Review           string          `json:"review"`
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
	Session    codex.Session  `json:"session"`
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
			URL  string `json:"url"`
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
				// Only validated inline images cross this boundary. Never fetch an
				// arbitrary URL or expose local files through a history preview.
				if len(e.Images) < 4 && validateChatImages([]string{input.URL}) == nil {
					e.Images = append(e.Images, input.URL)
				} else {
					parts = append(parts, "[图片附件]")
				}
			case "localImage":
				e.LocalImagePaths = append(e.LocalImagePaths, input.Path)
				e.Images = append(e.Images, input.Path)
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
	case "fileChange":
		e.Kind, e.Status = "change", i.Status
		for _, change := range i.Changes {
			e.Text += change.Path + "\n" + change.Diff + "\n"
		}
	case "plan":
		e.Kind, e.Text, e.Tool = "activity", i.Text, "计划"
	case "mcpToolCall", "dynamicToolCall", "collabAgentToolCall":
		// Tool names/status are useful progress. Raw arguments/results may
		// contain credentials or internal payloads and stay with Codex.
		e.Kind, e.Tool, e.Status, e.DurationMs = "activity", i.Tool, i.Status, i.DurationMs
		if i.Server != "" {
			e.Tool = i.Server + " · " + i.Tool
		}
	case "webSearch":
		e.Kind, e.Tool, e.Text = "activity", "网页搜索", i.Query
	case "imageView":
		e.Kind, e.Tool, e.Text = "activity", "查看图片", i.Path
	case "contextCompaction":
		e.Kind, e.Tool, e.Text = "activity", "上下文整理", "Codex 已整理会话上下文"
	case "enteredReviewMode", "exitedReviewMode":
		e.Kind, e.Tool, e.Text = "activity", "代码审查", i.Review
	default:
		return e, false
	}
	e.Text = boundedChatText(e.Text)
	if e.Output != nil {
		out := boundedChatText(*e.Output)
		e.Output = &out
	}
	return e, true
}

func readSessionHistory(c codex.SessionClient, s codex.Session, cursor string) (SessionHistory, error) {
	history := SessionHistory{Session: s, Entries: []HistoryEntry{}}
	// The list endpoint only needs the title. Keep previews out of the history
	// response as well; the actual messages are represented by entries below.
	history.Session.Name = sessionName(s)
	history.Session.Preview = ""
	history.Session.Path = ""
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
		if err := c.Call("thread/items/list", params, &page); err != nil {
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
		if err := c.Call("thread/turns/list", params, &page); err != nil {
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

func (a *Service) HistorySessionAllowed(w http.ResponseWriter, r *http.Request) bool {
	_, ok := a.requestSession(w, r)
	return ok
}
func (a *Service) SessionHistoryHandler(w http.ResponseWriter, r *http.Request) {
	if !a.HistorySessionAllowed(w, r) {
		return
	}
	c, err := a.openSessions(r.Context())
	if err != nil {
		httpx.WriteError(w, 503, err.Error())
		return
	}
	defer c.Close()
	titleObservedAt := time.Now().UnixNano()
	s, err := readSession(c, r.PathValue("session"))
	if err != nil {
		httpx.WriteError(w, 503, "无法读取会话详情："+err.Error())
		return
	}
	if err := a.SaveSession("", s, "codex", titleObservedAt); err != nil {
		httpx.DbError(w, err)
		return
	}
	if cached, err := a.Workspace.Store.Session(s.ID); err == nil {
		s.Name = cached.Name
	}
	history, err := readSessionHistory(c, s, r.URL.Query().Get("cursor"))
	if err != nil {
		httpx.WriteError(w, 503, "无法读取会话历史："+err.Error())
		return
	}
	a.prepareHistoryMedia(s.ID, history.Entries)
	httpx.WriteJSON(w, 200, history)
}
