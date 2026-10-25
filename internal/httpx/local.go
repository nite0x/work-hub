package httpx

import (
	"crypto/subtle"
	"net"
	"net/http"
	"net/url"
	"strings"
)

func LocalHandler(token string, readOnly func() bool, closing func() bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		h := r.Host
		if host, _, err := net.SplitHostPort(h); err == nil {
			h = host
		}
		if h != "localhost" && (net.ParseIP(h) == nil || !net.ParseIP(h).IsLoopback()) {
			WriteError(w, 403, "仅允许本地访问")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(token)) != 1 {
				WriteError(w, 403, "页面已过期，请刷新后重试")
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != r.Host || u.Scheme != "http" {
					WriteError(w, 403, "拒绝跨站请求")
					return
				}
			}
			if readOnly() && (strings.Contains(r.URL.Path, "/chat") || strings.HasSuffix(r.URL.Path, "/sessions/new") || strings.HasSuffix(r.URL.Path, "/manage") || r.Method == "POST" && r.URL.Path == "/api/conversation-drafts") {
				WriteError(w, 405, "会话内容仅供查看，请在终端中对话")
				return
			}
			if closing() {
				WriteError(w, 503, "后台正在退出，请稍后重新打开应用")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
