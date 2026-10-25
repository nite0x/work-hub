package task

import "net/http"

func (s *Service) RegisterRoutes(mux *http.ServeMux, invalidate func(http.HandlerFunc) http.HandlerFunc) {
	mux.HandleFunc("POST /api/requirements", invalidate(s.CreateRequirementHandler))
	mux.HandleFunc("PATCH /api/requirements/{id}", s.UpdateRequirementHandler)
	mux.HandleFunc("PUT /api/requirements/{id}/projects/{project}", invalidate(s.ReplaceRequirementProjectHandler))
	mux.HandleFunc("DELETE /api/requirements/{id}/projects/{project}", invalidate(s.RemoveRequirementProjectHandler))
	mux.HandleFunc("POST /api/requirements/{id}/projects", invalidate(s.AddRequirementProjectsHandler))
	mux.HandleFunc("POST /api/requirements/{id}/retry", invalidate(s.RetryHandler))
	mux.HandleFunc("POST /api/requirements/{id}/archive", s.ArchiveHandler)
	mux.HandleFunc("GET /api/requirements/{id}/launch", s.LaunchPlanHandler)
}
