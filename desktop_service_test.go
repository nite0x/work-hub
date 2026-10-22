package main

import (
	"os"
	"testing"
)

func TestDataDirectoryLockAndAuthenticatedStop(t *testing.T) {
	dir := t.TempDir()
	unlock, err := lockDataDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	if other, err := lockDataDirectory(dir); err == nil {
		other()
		unlock()
		t.Fatal("second backend acquired the same data directory")
	}
	unlock()
	unlock, err = lockDataDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	a := testApp(t)
	stopped := make(chan struct{})
	a.shutdown = func() { close(stopped) }
	a.mu.Lock()
	code, _ := call(t, a, "POST", "/api/service/stop", nil)
	a.mu.Unlock()
	if code != 409 || a.closing.Load() {
		t.Fatal("stop accepted an active write")
	}
	code, _ = call(t, a, "POST", "/api/service/stop", nil)
	if code != 200 || !a.closing.Load() {
		t.Fatal("stop did not close ingress")
	}
	code, _ = call(t, a, "POST", "/api/projects", map[string]string{"path": os.TempDir()})
	if code != 503 {
		t.Fatal("write accepted during shutdown")
	}
}
