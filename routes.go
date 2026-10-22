package main

import (
	"crypto/subtle"
	"embed"
	"io/fs"
	"net/http"
	"os"
	"strings"
)

//go:embed web/*
var assets embed.FS

func (a *App) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/state", a.stateHandler)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Worktree-Hub-Instance")), []byte(a.token)) != 1 {
			writeError(w, 403, "实例认证失败")
			return
		}
		writeJSON(w, 200, map[string]any{"name": "worktree-hub", "pid": os.Getpid()})
	})
	if a.shutdown != nil {
		mux.HandleFunc("POST /api/service/stop", a.stopServiceHandler)
	}
	if a.environments != nil {
		mux.HandleFunc("GET /api/environments", a.environments.listHandler)
		mux.HandleFunc("POST /api/environments", a.environments.addHandler)
		mux.HandleFunc("POST /api/environments/{environment}/reconnect", a.environments.reconnectHandler)
	}
	mux.HandleFunc("PUT /api/settings/terminal", a.terminalSettingsHandler)
	mux.HandleFunc("PUT /api/settings/master-sync", a.masterSyncSettingsHandler)
	mux.HandleFunc("POST /api/projects", a.invalidateStateAfter(a.addProjectHandler))
	mux.HandleFunc("DELETE /api/projects/{id}", a.invalidateStateAfter(a.removeProjectHandler))
	mux.HandleFunc("GET /api/projects/{id}/git", a.gitOverviewHandler)
	mux.HandleFunc("POST /api/projects/{id}/git", a.invalidateStateAfter(a.gitActionHandler))
	mux.HandleFunc("POST /api/projects/{id}/worktrees", a.invalidateStateAfter(a.createWorktreeHandler))
	mux.HandleFunc("POST /api/requirements", a.invalidateStateAfter(a.createRequirementHandler))
	mux.HandleFunc("POST /api/requirements/{id}/projects", a.invalidateStateAfter(a.addRequirementProjectsHandler))
	mux.HandleFunc("POST /api/requirements/{id}/retry", a.invalidateStateAfter(a.retryHandler))
	mux.HandleFunc("POST /api/requirements/{id}/archive", a.archiveHandler)
	mux.HandleFunc("GET /api/requirements/{id}/launch", a.launchPlanHandler)
	mux.HandleFunc("POST /api/requirements/{id}/launch", a.launchHandler)
	mux.HandleFunc("GET /api/codex/sessions", a.codexSessionsHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions", a.requirementSessionsHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions", a.linkSessionHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/new", a.newSessionHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/resume", a.resumeSessionHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/history", a.sessionHistoryHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/history/events", a.sessionHistoryEventsHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/chat", a.chatStateHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat", a.chatStartHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/chat/events", a.chatEventsHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat/stop", a.chatStopHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat/approval", a.chatApprovalHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat/handoff", a.chatHandoffHandler)
	mux.Handle("/", a.assetsHandler())
	return a.secureHandler(mux)
}

func (a *App) assetsHandler() http.Handler {
	web, _ := fs.Sub(assets, "web")
	static := http.FileServer(http.FS(web))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			static.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		b, _ := assets.ReadFile("web/index.html")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		page := strings.ReplaceAll(string(b), "__CSRF_TOKEN__", a.token)
		mode := "interactive"
		if a.readOnlySessions {
			mode = "read-only"
			page = strings.ReplaceAll(page, `<script src="/session-chat.js" defer></script>`, "")
			page = strings.ReplaceAll(page, `<script src="/session-create.js" defer></script>`, "")
		}
		_, _ = w.Write([]byte(strings.ReplaceAll(page, "__SESSION_MODE__", mode)))
	})
}
