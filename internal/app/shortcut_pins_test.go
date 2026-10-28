package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func readShortcutPins(t *testing.T, a *App, environment string) shortcutPins {
	t.Helper()
	code, raw := call(t, a, "GET", "/api/shortcut-pins?environment="+environment, nil)
	var pins shortcutPins
	if code != 200 || json.Unmarshal(raw, &pins) != nil {
		t.Fatalf("read pins: %d %s", code, raw)
	}
	return pins
}

func TestShortcutPinsSurviveRestartAndStayPartitionedOnHost(t *testing.T) {
	a := testApp(t)
	if pins := readShortcutPins(t, a, "local"); pins.Initialized || len(pins.Tasks) != 0 || len(pins.Directories) != 0 {
		t.Fatalf("initial pins: %+v", pins)
	}
	want := shortcutPins{Tasks: []string{"same-task"}, Directories: []string{`C:\Repos\App`, "/repo/app"}, Initialized: true}
	if code, raw := call(t, a, "PUT", "/api/shortcut-pins", map[string]any{"tasks": []string{"same-task", "same-task", ""}, "directories": []string{`C:\Repos\App`, "c:/repos/app/", "/repo/app", "/repo/app/"}}); code != 200 {
		t.Fatalf("save pins: %d %s", code, raw)
	}
	if _, err := newEnvironmentHub(a); err != nil {
		t.Fatal(err)
	}
	// Preferences for an offline environment must not start a workspace helper.
	r := httptest.NewRequest("PUT", "http://localhost:58923/api/shortcut-pins?environment=wsl-offline", bytes.NewBufferString(`{"tasks":["same-task"],"directories":["/remote/app"]}`))
	r.Header.Set("X-CSRF-Token", a.token)
	r.Header.Set("X-Environment-ID", "wsl-offline")
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("offline pins: %d %s", w.Code, w.Body.String())
	}
	dataDir, root := a.Workspace.DataDir, a.Workspace.Root
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := openApp(dataDir, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { restarted.Close() })
	if got := readShortcutPins(t, restarted, "local"); !reflect.DeepEqual(got, want) {
		t.Fatalf("restart lost pins: %+v", got)
	}
	if got := readShortcutPins(t, restarted, "wsl-offline"); !reflect.DeepEqual(got.Directories, []string{"/remote/app"}) {
		t.Fatalf("environment pins mixed: %+v", got)
	}
	if got := readShortcutPins(t, testApp(t), "local"); got.Initialized {
		t.Fatal("pins leaked into another data directory")
	}
}

func TestShortcutPinMigrationNeverOverwritesSavedOrRemovedPins(t *testing.T) {
	a := testApp(t)
	url := "/api/shortcut-pins?environment=local"
	legacy := map[string]any{"tasks": []string{"legacy"}, "directories": []string{"/old"}, "initialize": true}
	if code, raw := call(t, a, "PUT", url, legacy); code != 200 {
		t.Fatalf("import: %d %s", code, raw)
	}
	if got := readShortcutPins(t, a, "local"); !reflect.DeepEqual(got.Tasks, []string{"legacy"}) {
		t.Fatalf("missing imported pins: %+v", got)
	}
	for _, tasks := range [][]string{{"new"}, {}} {
		if code, raw := call(t, a, "PUT", url, map[string]any{"tasks": tasks, "directories": []string{}}); code != 200 {
			t.Fatalf("save: %d %s", code, raw)
		}
		if code, raw := call(t, a, "PUT", url, legacy); code != 200 {
			t.Fatalf("repeat import: %d %s", code, raw)
		}
		if got := readShortcutPins(t, a, "local"); !got.Initialized || !reflect.DeepEqual(got.Tasks, tasks) || len(got.Directories) != 0 {
			t.Fatalf("stale origin resurrected pins: %+v", got)
		}
	}
	for _, scenario := range []struct{ token, origin string }{{"", ""}, {a.token, "https://example.invalid"}} {
		r := httptest.NewRequest("PUT", "http://localhost:4317"+url, bytes.NewBufferString(`{"tasks":["untrusted"]}`))
		r.Header.Set("X-CSRF-Token", scenario.token)
		r.Header.Set("Origin", scenario.origin)
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("untrusted write: %d %s", w.Code, w.Body.String())
		}
	}
}
