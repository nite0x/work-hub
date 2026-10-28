package session

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"worktree-hub/internal/httpx"
)

type titleSettings struct {
	Model string `json:"model"`
}

func (a *Service) sessionTitleSettings() (titleSettings, error) {
	var settings titleSettings
	var raw string
	err := a.Workspace.Store.DB.QueryRow(`SELECT value FROM settings WHERE key='session_title'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return settings, nil
	}
	if err != nil {
		return settings, err
	}
	err = json.Unmarshal([]byte(raw), &settings)
	return settings, err
}

func (a *Service) SessionTitleSettingsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		settings, err := a.sessionTitleSettings()
		if err != nil {
			httpx.DbError(w, err)
			return
		}
		c, err := a.openSessions(r.Context())
		if err != nil {
			httpx.WriteError(w, 503, "无法读取标题模型："+err.Error())
			return
		}
		defer c.Close()
		models, err := listChatModels(c.Call)
		if err != nil {
			httpx.WriteError(w, 503, "无法读取标题模型："+err.Error())
			return
		}
		httpx.WriteJSON(w, 200, map[string]any{"settings": settings, "models": models})
		return
	}
	var settings titleSettings
	if !httpx.Decode(w, r, &settings) {
		return
	}
	settings.Model = strings.TrimSpace(settings.Model)
	if len(settings.Model) > 200 {
		httpx.WriteError(w, 400, "模型名称过长")
		return
	}
	if settings.Model != "" {
		c, err := a.openSessions(r.Context())
		if err != nil {
			httpx.WriteError(w, 503, "无法核对标题模型："+err.Error())
			return
		}
		defer c.Close()
		models, err := listChatModels(c.Call)
		if err != nil {
			httpx.WriteError(w, 503, "无法核对标题模型："+err.Error())
			return
		}
		found := false
		for _, model := range models {
			found = found || model.Model == settings.Model
		}
		if !found {
			httpx.WriteError(w, 400, "请选择当前 Codex 可用的模型")
			return
		}
	}
	raw, _ := json.Marshal(settings)
	if _, err := a.Workspace.Store.DB.Exec(`INSERT INTO settings(key,value) VALUES('session_title',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, string(raw)); err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]any{"settings": settings})
}
