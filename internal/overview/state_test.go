package overview

import (
	"testing"
	"worktree-hub/internal/model"
)

func TestCompletedDiscoveryReportsMissingTaskDirectory(t *testing.T) {
	for _, step := range []struct {
		refreshing bool
		failed     bool
		missing    bool
	}{{true, false, false}, {false, false, true}, {false, true, false}} {
		p := model.Project{ID: "p", StatusUpdatedAt: "checked", Refreshing: step.refreshing}
		if step.failed {
			p.Error = "repository unavailable"
		}
		tasks := []model.Requirement{{ID: "q", Members: []model.Member{{ProjectID: "p", Path: "/missing", State: "ready"}}}}
		LinkWorktrees([]model.Project{p}, tasks)
		observed := tasks[0].Members[0].Worktree
		if step.refreshing {
			if observed != nil {
				t.Fatal("incomplete discovery reported missing")
			}
			continue
		}
		if observed == nil || observed.Missing != step.missing || (observed.Error != "") != step.failed {
			t.Fatalf("observed %+v", observed)
		}
	}
}
