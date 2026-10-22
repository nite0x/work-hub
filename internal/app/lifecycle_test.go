package app

import (
	"sync"
	"testing"
)

func TestConcurrentCloseRejectsRequestsAndReleasesStorage(t *testing.T) {
	a := testApp(t)
	var closing sync.WaitGroup
	for i := 0; i < 8; i++ {
		closing.Add(1)
		go func() {
			defer closing.Done()
			if err := a.Close(); err != nil {
				t.Error(err)
			}
		}()
	}
	closing.Wait()
	if code, _ := call(t, a, "GET", "/api/state", nil); code != 503 {
		t.Fatalf("request accepted after close: %d", code)
	}
	if err := a.Workspace.Store.DB.Ping(); err == nil {
		t.Fatal("database remains open after close")
	}
}
