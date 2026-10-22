package workspace

import "net/http"

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("PUT /api/settings/terminal", s.TerminalSettingsHandler)
}
