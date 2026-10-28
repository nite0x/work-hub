package session

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"worktree-hub/internal/codex"
)

func TestTitleSettingsPersistAndValidateCodexModels(t *testing.T) {
	a := testApp(t)
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, params map[string]any) (any, error) {
			if method != "model/list" {
				t.Fatalf("unexpected request: %s", method)
			}
			if params["cursor"] == nil {
				return map[string]any{"data": []any{map[string]any{"id": "body", "model": "body-model"}}, "nextCursor": "next"}, nil
			}
			return map[string]any{"data": []any{map[string]any{"id": "title", "model": "title-model", "displayName": "Title model"}}}, nil
		}}, nil
	}
	path := "/api/settings/session-title"
	code, raw := call(t, a, "GET", path, nil)
	var result struct {
		Settings titleSettings `json:"settings"`
		Models   []chatModel   `json:"models"`
	}
	if code != 200 || json.Unmarshal(raw, &result) != nil || result.Settings.Model != "" || len(result.Models) != 2 {
		t.Fatalf("%d %s", code, raw)
	}
	if code, raw = call(t, a, "PUT", path, map[string]string{"model": " title-model "}); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	settings, err := a.sessionTitleSettings()
	if err != nil || settings.Model != "title-model" {
		t.Fatal(settings, err)
	}
	if code, _ = call(t, a, "PUT", path, map[string]string{"model": "missing-model"}); code != 400 {
		t.Fatal(code)
	}
	settings, _ = a.sessionTitleSettings()
	if settings.Model != "title-model" {
		t.Fatal("invalid choice replaced saved model", settings)
	}
	a.openSessions = func(context.Context) (codex.SessionClient, error) { return nil, fmt.Errorf("offline") }
	if code, _ = call(t, a, "PUT", path, map[string]string{"model": "body-model"}); code != 503 {
		t.Fatal(code)
	}
	if code, raw = call(t, a, "PUT", path, map[string]string{"model": ""}); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	settings, err = a.sessionTitleSettings()
	if err != nil || settings.Model != "" {
		t.Fatal(settings, err)
	}
}
