// Package task manages task membership, worktree creation and saved task scope.
package task

import "worktree-hub/internal/workspace"

type Service struct{ Workspace *workspace.Service }

func New(environment *workspace.Service) *Service { return &Service{Workspace: environment} }
