package session

import "net/http"

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/requirements/{id}/launch", s.LaunchHandler)
	mux.HandleFunc("GET /api/codex/sessions", s.CodexSessionsHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions", s.RequirementSessionsHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions", s.LinkSessionHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/new", s.NewSessionHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/resume", s.ResumeSessionHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/history", s.SessionHistoryHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/history/events", s.SessionHistoryEventsHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/chat", s.ChatStateHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat", s.ChatStartHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/chat/events", s.ChatEventsHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat/stop", s.ChatStopHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat/approval", s.ChatApprovalHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat/handoff", s.ChatHandoffHandler)
}
