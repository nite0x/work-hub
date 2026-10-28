// Package overview composes the workbench read model without owning business state.
package overview

import (
	"net/http"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/workspace"
)

type ProjectStatus interface {
	Snapshot([]model.Project, bool) (bool, string)
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
	LinkWorktrees(projects, reqs)
	httpx.WriteJSON(w, 200, map[string]any{"projects": projects, "requirements": reqs, "root": a.workspace.Root, "refreshed_at": updatedAt, "status_refreshing": refreshing, "terminal": terminal, "read_only_sessions": a.workspace.ReadOnlySessions})
}

// LinkWorktrees attaches the current environment's cached Git state to its tasks.
func LinkWorktrees(projects []model.Project, reqs []model.Requirement) {
	index := map[string]*model.Worktree{}
	projectStatus := map[string]model.Project{}
	for i := range projects {
		projectStatus[projects[i].ID] = projects[i]
		for j := range projects[i].Worktrees {
			t := &projects[i].Worktrees[j]
			index[t.Path] = t
		}
	}
	for i := range reqs {
		for j := range reqs[i].Members {
			m := &reqs[i].Members[j]
			if t, ok := index[m.Path]; ok {
				t.Requirements = append(t.Requirements, model.TaskLink{ID: reqs[i].ID, Name: reqs[i].Name})
				if t.RequirementID == "" {
					t.RequirementID = reqs[i].ID
					t.RequirementName = reqs[i].Name
				}
				observed := *t
				observed.RequirementID, observed.RequirementName = reqs[i].ID, reqs[i].Name
				observed.ExpectedBranch = m.Branch
				if m.Mode == "new" && observed.ExpectedBranch == "" {
					observed.ExpectedBranch = reqs[i].Branch
				}
				m.Worktree = &observed
			} else if p, ok := projectStatus[m.ProjectID]; ok && (p.Error != "" || (p.StatusUpdatedAt != "" && !p.Refreshing)) {
				m.Worktree = &model.Worktree{Path: m.Path, Missing: p.Error == "", Error: p.Error, StatusUpdatedAt: p.StatusUpdatedAt}
			}
		}
	}
}
