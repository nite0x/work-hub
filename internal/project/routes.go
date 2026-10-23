package project

import "net/http"

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("PUT /api/settings/master-sync", s.MasterSyncSettingsHandler)
	mux.HandleFunc("POST /api/projects", s.InvalidateStateAfter(s.AddProjectHandler))
	mux.HandleFunc("DELETE /api/projects/{id}", s.InvalidateStateAfter(s.RemoveProjectHandler))
	mux.HandleFunc("GET /api/projects/{id}/git", s.GitOverviewHandler)
	mux.HandleFunc("GET /api/projects/{id}/remote", s.ProjectRemoteHandler)
	mux.HandleFunc("POST /api/projects/{id}/open", s.OpenProjectHandler)
	mux.HandleFunc("POST /api/projects/{id}/git", s.InvalidateStateAfter(s.GitActionHandler))
	mux.HandleFunc("POST /api/projects/{id}/worktrees", s.InvalidateStateAfter(s.CreateWorktreeHandler))
}
