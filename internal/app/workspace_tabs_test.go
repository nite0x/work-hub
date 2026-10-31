package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWorkspaceTabsPersistAcrossOriginsAndKeepConversationScopesSeparate(t *testing.T) {
	a := testApp(t)
	input := map[string]any{
		"selected": "second",
		"tabs": []any{
			map[string]any{"id": "first", "snapshot": map[string]any{"route": "/sessions", "environment": "local", "conversation": map[string]any{"scope": map[string]string{"kind": "task", "id": "same-task"}, "selected": "front"}}},
			map[string]any{"id": "second", "snapshot": map[string]any{"route": "/sessions", "environment": "local", "conversation": map[string]any{"scope": map[string]string{"kind": "task", "id": "same-task"}, "selected": "back"}}},
		},
	}
	if code, raw := call(t, a, "PUT", "/api/workspace-tabs", input); code != http.StatusOK {
		t.Fatalf("save tabs: %d %s", code, raw)
	}
	r := httptest.NewRequest("GET", "http://localhost:58923/api/workspace-tabs", nil)
	r.Header.Set("X-CSRF-Token", a.token)
	r.Header.Set("X-Environment-ID", "wsl-offline")
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	var got workspaceTabs
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &got) != nil || !got.Initialized || got.Selected != "second" || len(got.Tabs) != 2 {
		t.Fatalf("restore on another origin: %d %s", w.Code, w.Body.String())
	}
	if bytes.Equal(got.Tabs[0].Snapshot, got.Tabs[1].Snapshot) {
		t.Fatal("distinct conversations were collapsed")
	}
	for _, body := range []string{
		`{"selected":"missing","tabs":[{"id":"first","snapshot":{}}]}`,
		`{"selected":"first","tabs":[{"id":"first","snapshot":{}},{"id":"first","snapshot":{}}]}`,
		`{"selected":"first","tabs":[{"id":"first","snapshot":null}]}`,
	} {
		r := httptest.NewRequest("PUT", "http://localhost:4317/api/workspace-tabs", bytes.NewBufferString(body))
		r.Header.Set("X-CSRF-Token", a.token)
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid state accepted: %d %s", w.Code, body)
		}
	}
	r = httptest.NewRequest("PUT", "http://localhost:4317/api/workspace-tabs", bytes.NewBufferString(`{"selected":"","tabs":[]}`))
	w = httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("unauthenticated write accepted: %d", w.Code)
	}
}
