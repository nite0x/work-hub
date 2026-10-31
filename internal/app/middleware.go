package app

import (
	"net/http"
	"strings"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/workspace"
)

func (a *App) secureHandler(next http.Handler) http.Handler {
	return httpx.LocalHandler(a.token, func() bool { return a.Workspace.ReadOnlySessions }, func() bool { return a.Workspace.Closing.Load() }, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.Workspace.Remote != nil {
			r = r.WithContext(workspace.WithClient(r.Context(), a.Workspace.Remote))
		}
		if a.environments != nil && strings.HasPrefix(r.URL.Path, "/api/") && !strings.HasPrefix(r.URL.Path, "/api/environments") && r.URL.Path != "/api/task-inventory" && r.URL.Path != "/api/dialogs/directory" && r.URL.Path != "/api/shortcut-pins" && r.URL.Path != "/api/workspace-tabs" {
			if id := r.Header.Get("X-Environment-ID"); id != "" && id != "local" {
				app, err := a.environments.get(id)
				if err != nil {
					httpx.WriteError(w, 503, err.Error())
					return
				}
				app.handler().ServeHTTP(w, r)
				return
			}
		}
		next.ServeHTTP(w, r)
	}))
}
