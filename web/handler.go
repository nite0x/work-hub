package web

import (
	"net/http"
	"strings"
)

func Handler(token string, readOnly bool) http.Handler {
	static := http.FileServer(http.FS(Assets))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			static.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		pageName := "workspace.html"
		if r.URL.Query().Get("workspace-tab") != "" {
			pageName = "index.html"
			// Only the internal workspace page may be framed by this origin.
			// The outer window retains frame-ancestors 'none'.
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'")
		}
		b, _ := Assets.ReadFile(pageName)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		page := strings.ReplaceAll(string(b), "__CSRF_TOKEN__", token)
		mode := "interactive"
		if readOnly {
			mode = "read-only"
			page = strings.ReplaceAll(page, `<script src="/features/sessions/session-chat.js" defer></script>`, "")
			page = strings.ReplaceAll(page, `<script src="/features/sessions/session-create.js" defer></script>`, "")
		}
		_, _ = w.Write([]byte(strings.ReplaceAll(page, "__SESSION_MODE__", mode)))
	})
}
