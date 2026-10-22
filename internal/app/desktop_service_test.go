package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"worktree-hub/internal/platform"
)

func TestDataDirectoryLockAndAuthenticatedStop(t *testing.T) {
	dir := t.TempDir()
	unlock, err := platform.LockDataDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	if other, err := platform.LockDataDirectory(dir); err == nil {
		other()
		unlock()
		t.Fatal("second backend acquired the same data directory")
	}
	unlock()
	unlock, err = platform.LockDataDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	a := testApp(t)
	stopped := make(chan struct{})
	a.shutdown = func() { close(stopped) }
	a.Workspace.Mu.Lock()
	code, _ := call(t, a, "POST", "/api/service/stop", nil)
	a.Workspace.Mu.Unlock()
	if code != 409 || a.Workspace.Closing.Load() {
		t.Fatal("stop accepted an active write")
	}
	code, _ = call(t, a, "POST", "/api/service/stop", nil)
	if code != 200 || !a.Workspace.Closing.Load() {
		t.Fatal("stop did not close ingress")
	}
	code, _ = call(t, a, "POST", "/api/projects", map[string]string{"path": os.TempDir()})
	if code != 503 {
		t.Fatal("write accepted during shutdown")
	}
}

func TestDesktopHandshakeAuthenticatesAndChecksLiveIdentity(t *testing.T) {
	a := testApp(t)
	a.Workspace.ReadOnlySessions = true
	server := httptest.NewServer(a.handler())
	defer server.Close()
	info := a.desktopInfo(server.URL)
	if err := writeDesktopService(a.Workspace.DataDir, info); err != nil {
		t.Fatal(err)
	}
	got, err := readDesktopService(a.Workspace.DataDir)
	if err != nil || got != info {
		t.Fatalf("handshake: %+v %v", got, err)
	}
	if err := compatibleDesktopService(got, got.DataDir, got.Root, true); err != nil {
		t.Fatal(err)
	}
	r, _ := http.NewRequest("GET", server.URL+"/healthz", nil)
	r.Header.Set("X-Worktree-Hub-Instance", a.token)
	response, err := desktopHTTPClient(2e9).Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var health map[string]any
	if err := json.NewDecoder(response.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	if _, leaked := health["token"]; leaked {
		t.Fatal("health leaked the instance token")
	}
	info.Token = "wrong-token"
	if err := writeDesktopService(info.DataDir, info); err != nil {
		t.Fatal(err)
	}
	if _, err := readDesktopService(info.DataDir); err == nil {
		t.Fatal("accepted stale token")
	}
	info.Token, info.PID = a.token, info.PID+1
	if err := writeDesktopService(info.DataDir, info); err != nil {
		t.Fatal(err)
	}
	if _, err := readDesktopService(info.DataDir); err == nil {
		t.Fatal("accepted another process identity")
	}
}

func TestDesktopReuseRejectsDifferentVersionRootAndSessionMode(t *testing.T) {
	a := testApp(t)
	a.Workspace.ReadOnlySessions = true
	info := a.desktopInfo("http://127.0.0.1:4317")
	data, err := filepath.EvalSymlinks(info.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"version", "protocol", "interactive", "closing", "data", "root"} {
		t.Run(scenario, func(t *testing.T) {
			candidate := info
			root := info.Root
			switch scenario {
			case "version":
				candidate.Version += "-old"
			case "protocol":
				candidate.Protocol = 0
			case "interactive":
				candidate.ReadOnly = false
			case "closing":
				candidate.Ready = false
			case "data":
				candidate.DataDir = t.TempDir()
			case "root":
				root = t.TempDir()
			}
			if err := compatibleDesktopService(candidate, data, root, true); !errors.Is(err, errDesktopConflict) {
				t.Fatalf("accepted %s: %v", scenario, err)
			}
		})
	}
	if err := compatibleDesktopService(info, data, "/ignored-default-root", false); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopDescriptorRejectsNonLocalAndDecoratedURLs(t *testing.T) {
	a := testApp(t)
	for _, address := range []string{"https://127.0.0.1:4317", "http://example.com:4317", "http://127.0.0.1:4317/path", "http://127.0.0.1:4317?token=x", "http://user@127.0.0.1:4317"} {
		info := a.desktopInfo(address)
		if err := writeDesktopService(info.DataDir, info); err != nil {
			t.Fatal(err)
		}
		if _, err := readDesktopService(info.DataDir); err == nil || !strings.Contains(err.Error(), "地址无效") {
			t.Fatalf("accepted %s: %v", address, err)
		}
	}
}

func TestPrepareUpgradeIsIdempotentAndDoesNotTrustStaleDescriptors(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not-created")
	if err := prepareDesktopUpgrade(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("installer created a profile before first launch")
	}
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	descriptor := filepath.Join(dir, "service.json")
	if err := os.WriteFile(descriptor, []byte("stale"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareDesktopUpgrade(dir); err != nil {
		t.Fatal("unlocked stale profile must not block installation", err)
	}
	unlock, err := platform.LockDataDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if err := prepareDesktopUpgrade(dir); err == nil {
		t.Fatal("locked unauthenticated profile was accepted")
	}
	if raw, _ := os.ReadFile(descriptor); string(raw) != "stale" {
		t.Fatal("installer modified an unverified descriptor")
	}
}

func TestPrepareUpgradeRejectsBusyBackend(t *testing.T) {
	a := testApp(t)
	unlock, err := platform.LockDataDirectory(a.Workspace.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	server := httptest.NewServer(a.handler())
	defer server.Close()
	info := a.desktopInfo(server.URL)
	if err := writeDesktopService(info.DataDir, info); err != nil {
		t.Fatal(err)
	}
	a.Workspace.Mu.Lock()
	err = prepareDesktopUpgrade(info.DataDir)
	a.Workspace.Mu.Unlock()
	if err == nil || a.Workspace.Closing.Load() {
		t.Fatal("installer interrupted an active operation", err)
	}
	if _, err := readDesktopService(info.DataDir); err != nil {
		t.Fatal("backend no longer healthy", err)
	}
}
