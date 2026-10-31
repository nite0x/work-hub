package app

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func TestEmbeddedPageAssetsInBothSessionModes(t *testing.T) {
	a := testApp(t)
	resources := regexp.MustCompile(`(?:src|href)="(/[^"#]+\.(?:js|css|ico|svg))"`)
	for _, readOnly := range []bool{false, true} {
		name := "interactive"
		if readOnly {
			name = "read-only"
		}
		t.Run(name, func(t *testing.T) {
			a.Workspace.ReadOnlySessions = readOnly
			handler := a.handler()
			page := httptest.NewRecorder()
			handler.ServeHTTP(page, httptest.NewRequest("GET", "http://localhost:4317/?workspace-tab=fixture", nil))
			html := page.Body.String()
			if page.Code != http.StatusOK || strings.Contains(html, "__CSRF_TOKEN__") || !strings.Contains(html, `name="session-mode" content="`+name+`"`) {
				t.Fatalf("invalid page: %d %s", page.Code, html)
			}
			for _, script := range []string{"session-chat.js", "session-create.js"} {
				if included := strings.Contains(html, `/features/sessions/`+script); included == readOnly {
					t.Fatalf("unexpected %s inclusion in %s mode", script, name)
				}
			}
			matches := resources.FindAllStringSubmatch(html, -1)
			if len(matches) == 0 {
				t.Fatal("page has no static resources")
			}
			for _, match := range matches {
				asset := httptest.NewRecorder()
				handler.ServeHTTP(asset, httptest.NewRequest("GET", "http://localhost:4317"+match[1], nil))
				if asset.Code != http.StatusOK || asset.Body.Len() == 0 {
					t.Errorf("missing embedded asset %s: %d", match[1], asset.Code)
				}
			}
		})
	}
}

func TestWorkspaceTabsFramePolicy(t *testing.T) {
	handler := testApp(t).handler()
	for _, tc := range []struct {
		path, contains, ancestors string
	}{
		{"/", `id="workspaceTabBar"`, "frame-ancestors 'none'"},
		{"/?workspace-tab=fixture", `id="sessionPageMount"`, "frame-ancestors 'self'"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "http://localhost:4317"+tc.path, nil))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), tc.contains) {
			t.Fatalf("invalid workspace page %s: %d", tc.path, response.Code)
		}
		if csp := response.Header().Get("Content-Security-Policy"); !strings.Contains(csp, tc.ancestors) || !strings.Contains(csp, "script-src 'self'") {
			t.Fatalf("unexpected frame policy for %s: %s", tc.path, csp)
		}
	}
	for _, path := range []string{"/core/workspace-tabs.js", "/core/workspace-tab.js", "/core/workspace-tabs.css", "/ui/workspace-tabs.js"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "http://localhost:4317"+path, nil))
		if response.Code != http.StatusOK || response.Body.Len() == 0 {
			t.Errorf("missing tab asset %s: %d", path, response.Code)
		}
	}
}
