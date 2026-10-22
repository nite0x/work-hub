package main

import (
	"crypto/subtle"
	"net"
	"net/http"
	"net/url"
	"strings"
)

func (a *App) secureHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		h := r.Host
		if host, _, err := net.SplitHostPort(h); err == nil {
			h = host
		}
		if h != "localhost" && (net.ParseIP(h) == nil || !net.ParseIP(h).IsLoopback()) {
			writeError(w, 403, "仅允许本地访问")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(a.token)) != 1 {
				writeError(w, 403, "页面已过期，请刷新后重试")
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != r.Host || u.Scheme != "http" {
					writeError(w, 403, "拒绝跨站请求")
					return
				}
			}
			if a.readOnlySessions && (strings.Contains(r.URL.Path, "/chat") || strings.HasSuffix(r.URL.Path, "/sessions/new")) {
				writeError(w, 405, "会话内容仅供查看，请在终端中对话")
				return
			}
			if a.closing.Load() {
				writeError(w, 503, "后台正在退出，请稍后重新打开应用")
				return
			}
		}
		if a.workspace != nil {
			r = r.WithContext(withWorkspace(r.Context(), a.workspace))
		}
		if a.environments != nil && strings.HasPrefix(r.URL.Path, "/api/") && !strings.HasPrefix(r.URL.Path, "/api/environments") {
			if id := r.Header.Get("X-Environment-ID"); id != "" && id != "local" {
				app, err := a.environments.get(id)
				if err != nil {
					writeError(w, 503, err.Error())
					return
				}
				app.handler().ServeHTTP(w, r)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
