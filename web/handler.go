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
		b, _ := Assets.ReadFile("index.html")
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
