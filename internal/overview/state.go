// Package overview composes the workbench read model without owning business state.
package overview

import (
	"net/http"
	"time"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/workspace"
)

type ProjectStatus interface {
	Snapshot([]model.Project, bool) (bool, string)
	MasterSyncState(time.Time) (model.MasterSyncState, error)
}
type Service struct {
	workspace *workspace.Service
	projects  ProjectStatus
}

func New(environment *workspace.Service, projects ProjectStatus) *Service {
	return &Service{workspace: environment, projects: projects}
}
func (a *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	projects, err := a.workspace.Store.Projects()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	reqs, err := a.workspace.Store.Requirements()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	settings, err := a.workspace.TerminalSettings()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	force := r.URL.Query().Get("refresh") == "1"
	refreshing, updatedAt := a.projects.Snapshot(projects, force)
	terminal, terminalRefreshing := a.workspace.TerminalSnapshot(settings, force)
	refreshing = refreshing || terminalRefreshing
	masterSync, err := a.projects.MasterSyncState(time.Now())
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	index := map[string]*model.Worktree{}
	for i := range projects {
		for j := range projects[i].Worktrees {
			t := &projects[i].Worktrees[j]
			index[t.Path] = t
		}
	}
	for i := range reqs {
		for j := range reqs[i].Members {
			m := &reqs[i].Members[j]
			if t, ok := index[m.Path]; ok {
				t.RequirementID = reqs[i].ID
				t.RequirementName = reqs[i].Name
				t.ExpectedBranch = reqs[i].Branch
				m.Worktree = t
			}
		}
	}
	httpx.WriteJSON(w, 200, map[string]any{"projects": projects, "requirements": reqs, "root": a.workspace.Root, "refreshed_at": updatedAt, "status_refreshing": refreshing, "terminal": terminal, "master_sync": masterSync})
}
