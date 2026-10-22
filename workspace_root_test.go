package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestExistingRequirementSurvivesRootChange(t *testing.T) {
	a := testApp(t)
	projectID := register(t, a, "App", repo(t, "app", "master"))
	code, original, raw := create(t, a, projectID, nil, "old-root")
	if code != 201 || original.State != "ready" {
		t.Fatalf("create existing: %d %s", code, raw)
	}
	newRoot := filepath.Join(t.TempDir(), "workspaces")
	restarted, err := openApp(a.dataDir, newRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.db.Close()
	code, raw = call(t, restarted, "POST", "/api/requirements/"+original.ID+"/retry", nil)
	var existing Requirement
	if err := json.Unmarshal(raw, &existing); err != nil || code != 200 || existing.State != "ready" || existing.Path != original.Path {
		t.Fatalf("existing requirement changed or became unusable: %d %s %v", code, raw, err)
	}
	code, raw = call(t, restarted, "GET", "/api/requirements/"+original.ID+"/launch", nil)
	var plan LaunchPlan
	if err := json.Unmarshal(raw, &plan); err != nil || code != 200 || plan.Cwd != original.Members[0].Path {
		t.Fatalf("existing launch target changed: %d %s %v", code, raw, err)
	}
	code, created, raw := create(t, restarted, projectID, nil, "new-root")
	if code != 201 || created.State != "ready" || created.Path != filepath.Join(newRoot, "new-root") {
		t.Fatalf("new requirement did not use new root: %d %s", code, raw)
	}
}
