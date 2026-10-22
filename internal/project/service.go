// Package project manages registered repositories, Git operations and status.
package project

import (
	"sync"

	"worktree-hub/internal/model"
	"worktree-hub/internal/workspace"
)

type Service struct {
	Workspace        *workspace.Service
	cache            *stateCache
	CredentialHelper string
	masterSyncMu     sync.Mutex
}

func New(environment *workspace.Service) *Service {
	s := &Service{Workspace: environment, cache: newStateCache(), CredentialHelper: workspace.CredentialHelperCommand()}
	if environment.Remote != nil {
		s.CredentialHelper = environment.Remote.Identity.CredentialHelper
		s.cache.ctx = workspace.WithClient(s.cache.ctx, environment.Remote)
	}
	return s
}

func (s *Service) Close() { s.cache.Close() }
func (s *Service) Snapshot(projects []model.Project, force bool) (bool, string) {
	return s.cache.snapshot(projects, force)
}
