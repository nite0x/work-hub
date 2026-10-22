package app

import (
	"crypto/subtle"
	"net/http"
	"os"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/overview"
	"worktree-hub/web"
)

func (a *App) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Worktree-Hub-Instance")), []byte(a.token)) != 1 {
			httpx.WriteError(w, 403, "实例认证失败")
			return
		}
		httpx.WriteJSON(w, 200, map[string]any{"name": "worktree-hub", "pid": os.Getpid()})
	})
	if a.shutdown != nil {
		mux.HandleFunc("POST /api/service/stop", a.stopServiceHandler)
	}
	if a.environments != nil {
		mux.HandleFunc("GET /api/environments", a.environments.listHandler)
		mux.HandleFunc("POST /api/environments", a.environments.addHandler)
		mux.HandleFunc("POST /api/environments/{environment}/reconnect", a.environments.reconnectHandler)
	}
	mux.Handle("GET /api/state", overview.New(a.Workspace, a.Projects))
	mux.HandleFunc("GET /api/task-inventory", a.taskInventoryHandler)
	a.Projects.RegisterRoutes(mux)
	a.Tasks.RegisterRoutes(mux, a.Projects.InvalidateStateAfter)
	a.Sessions.RegisterRoutes(mux)
	a.Workspace.RegisterRoutes(mux)
	mux.Handle("/", a.assetsHandler())
	return a.secureHandler(mux)
}

func (a *App) assetsHandler() http.Handler { return web.Handler(a.token, a.Workspace.ReadOnlySessions) }
