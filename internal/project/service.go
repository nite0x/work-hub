// Package project manages registered repositories, Git operations and status.
package project

import (
	"context"
	"sync"

	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

type Service struct {
	Workspace          *workspace.Service
	cache              *stateCache
	CredentialHelper   string
	gitLocks           sync.Map // common Git directory -> *sync.Mutex
	OpenEditor         func(tool, path, distro string) error
	OpenExternal       func(string) error
	ReserveWorktree    func(context.Context, string) (func(), error)
	TaskContextUpdated func(context.Context, model.Requirement) error
}

func New(environment *workspace.Service) *Service {
	s := &Service{Workspace: environment, cache: newStateCache(), CredentialHelper: workspace.CredentialHelperCommand(), OpenEditor: platform.OpenEditor, OpenExternal: platform.OpenExternal}
	if environment.Remote != nil {
		s.CredentialHelper = environment.Remote.Identity.CredentialHelper
		s.cache.ctx = workspace.WithClient(s.cache.ctx, environment.Remote)
	}
	return s
}

func (s *Service) Close() { s.cache.Close() }

func (s *Service) lockGit(common string) func() {
	value, _ := s.gitLocks.LoadOrStore(common, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}
func (s *Service) Snapshot(projects []model.Project, force bool) (bool, string) {
	return s.cache.snapshot(projects, force)
}
