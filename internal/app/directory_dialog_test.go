package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDirectoryDialogResultsAndBusyGuard(t *testing.T) {
	a := testApp(t)
	for _, selected := range []string{"/repo/中文 项目", ""} {
		a.pickDirectory = func(context.Context) (string, error) {
			// A second request must not open another native dialog.
			code, _ := call(t, a, "POST", "/api/dialogs/directory", nil)
			if code != http.StatusConflict {
				t.Fatalf("concurrent picker: %d", code)
			}
			return selected, nil
		}
		code, raw := call(t, a, "POST", "/api/dialogs/directory", nil)
		var result map[string]string
		if err := json.Unmarshal(raw, &result); err != nil || code != 200 || result["path"] != selected {
			t.Fatalf("selection: %d %s %v", code, raw, err)
		}
	}
	a.pickDirectory = func(context.Context) (string, error) { return "", fmt.Errorf("picker unavailable") }
	if code, _ := call(t, a, "POST", "/api/dialogs/directory", nil); code != 422 {
		t.Fatalf("picker failure: %d", code)
	}
	if a.directoryPickerBusy.Load() {
		t.Fatal("picker remains busy after failure")
	}
}

func TestDirectoryDialogRejectsUntrustedAndRemoteRequests(t *testing.T) {
	a := testApp(t)
	if _, err := newEnvironmentHub(a); err != nil {
		t.Fatal(err)
	}
	a.pickDirectory = func(context.Context) (string, error) {
		t.Fatal("unauthorized request opened a dialog")
		return "", nil
	}
	for _, scenario := range []struct {
		name, token, origin, environment string
		code                             int
	}{
		{"missing-token", "", "", "local", 403},
		{"cross-site", a.token, "https://example.invalid", "local", 403},
		{"remote", a.token, "", "wsl-unconnected", 422},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "http://localhost:4317/api/dialogs/directory", nil)
			r.Header.Set("X-CSRF-Token", scenario.token)
			r.Header.Set("Origin", scenario.origin)
			r.Header.Set("X-Environment-ID", scenario.environment)
			w := httptest.NewRecorder()
			a.handler().ServeHTTP(w, r)
			if w.Code != scenario.code {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
		})
	}
}
