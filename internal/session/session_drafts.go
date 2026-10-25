package session

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"

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
		Settings TurnSettings `json:"settings"`
		Reading  struct {
			Top    float64 `json:"top"`
			Bottom bool    `json:"bottom"`
			Anchor string  `json:"anchor"`
			Offset float64 `json:"offset"`
		} `json:"reading"`
		Project string `json:"project"`
		Updated int64  `json:"updated"`
	}
	if !httpx.DecodeLimit(w, r, &draft, chatRequestLimit) {
		return
	}
	if len(draft.Text) > 128000 || len(draft.Project) > 200 || len(draft.Reading.Anchor) > 1000 || draft.Updated <= 0 {
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
	if err := draft.Settings.validate(); err != nil {
		httpx.WriteError(w, 400, err.Error())
		return
	}
	raw, _ := json.Marshal(draft)
	if _, err := a.Workspace.Store.DB.Exec(`INSERT INTO conversation_drafts(key,payload,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at WHERE excluded.updated_at>=conversation_drafts.updated_at`, key, string(raw), draft.Updated); err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]bool{"saved": true})
}
