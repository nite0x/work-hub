package session

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"worktree-hub/internal/httpx"
)

// Drafts belong to the execution environment and target/session, not the random
// HTTP port used by the desktop sidecar. This survives both page and app restarts.
func (a *Service) DraftHandler(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if len(key) == 0 || len(key) > 2000 {
		httpx.WriteError(w, 400, "草稿标识无效")
		return
	}
	if r.Method == "GET" {
		var payload string
		err := a.Workspace.Store.DB.QueryRow(`SELECT payload FROM conversation_drafts WHERE key=?`, key).Scan(&payload)
		if errors.Is(err, sql.ErrNoRows) {
			httpx.WriteJSON(w, 200, nil)
			return
		}
		if err != nil {
			httpx.DbError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(payload))
		return
	}
	var draft struct {
		Text   string `json:"text"`
		Images []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Type string `json:"contentType"`
			URL  string `json:"url"`
		} `json:"images"`
		Files []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Type string `json:"contentType"`
			Text string `json:"text"`
		} `json:"files,omitempty"`
		Settings TurnSettings `json:"settings"`
		Reading  struct {
			Top    float64 `json:"top"`
			Bottom bool    `json:"bottom"`
			Anchor string  `json:"anchor"`
			Offset float64 `json:"offset"`
			Latest string  `json:"latest,omitempty"`
		} `json:"reading"`
		Project   string `json:"project"`
		Updated   int64  `json:"updated"`
		Questions map[string]map[string]struct {
			Choice string `json:"choice,omitempty"`
			Text   string `json:"text"`
		} `json:"questions,omitempty"`
	}
	if !httpx.DecodeLimit(w, r, &draft, chatRequestLimit) {
		return
	}
	if len(draft.Text) > 128000 || len(draft.Project) > 200 || len(draft.Reading.Anchor) > 1000 || len(draft.Reading.Latest) > 2000 || draft.Updated <= 0 {
		httpx.WriteError(w, 400, "草稿内容无效")
		return
	}
	images := []string{}
	for _, image := range draft.Images {
		if len(image.Name) > 1000 || len(image.ID) > 200 {
			httpx.WriteError(w, 400, "图片标识无效")
			return
		}
		images = append(images, image.URL)
	}
	if err := validateChatImages(images); err != nil {
		httpx.WriteError(w, 400, err.Error())
		return
	}
	fileTextSize := 0
	for _, file := range draft.Files {
		fileTextSize += len(file.Text)
		if len(file.ID) > 200 || len(file.Name) > 1000 || len(file.Type) > 200 || file.Text == "" || fileTextSize > 64000 {
			httpx.WriteError(w, 400, "文件附件草稿无效或过长")
			return
		}
	}
	if err := draft.Settings.validate(); err != nil {
		httpx.WriteError(w, 400, err.Error())
		return
	}
	if len(draft.Questions) > 100 {
		httpx.WriteError(w, 400, "问询草稿过多")
		return
	}
	for key, answers := range draft.Questions {
		if !strings.HasPrefix(key, `["async",`) || len(key) > 1000 || len(answers) > 10 {
			httpx.WriteError(w, 400, "问询草稿标识无效")
			return
		}
		for id, answer := range answers {
			if len(id) > 200 || len(answer.Choice) > 8000 || len(answer.Text) > 8000 {
				httpx.WriteError(w, 400, "问询回答过长")
				return
			}
		}
	}
	raw, _ := json.Marshal(draft)
	if _, err := a.Workspace.Store.DB.Exec(`INSERT INTO conversation_drafts(key,payload,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at WHERE excluded.updated_at>=conversation_drafts.updated_at`, key, string(raw), draft.Updated); err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]bool{"saved": true})
}
