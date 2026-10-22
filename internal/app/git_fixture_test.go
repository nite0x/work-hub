package app

import (
	"encoding/json"
	"testing"

	"worktree-hub/internal/project"
)

func gitView(t *testing.T, a *App, id string) project.GitOverview {
	t.Helper()
	code, raw := call(t, a, "GET", "/api/projects/"+id+"/git", nil)
	if code != 200 {
		t.Fatalf("overview %d %s", code, raw)
	}
	var v project.GitOverview
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func gitAction(t *testing.T, a *App, id string, input project.GitAction) (int, []byte) {
	t.Helper()
	return call(t, a, "POST", "/api/projects/"+id+"/git", input)
}
