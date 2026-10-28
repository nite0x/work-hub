package app

import (
	"context"
	"sync"
	"sync/atomic"

	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/project"
	"worktree-hub/internal/session"
	"worktree-hub/internal/task"
	"worktree-hub/internal/workspace"
)

type App struct {
	Workspace           *workspace.Service
	Projects            *project.Service
	Tasks               *task.Service
	Sessions            *session.Service
	token               string
	environments        *environmentHub
	shutdown            func()
	closeOnce           sync.Once
	closeErr            error
	pickDirectory       func(context.Context) (string, error)
	directoryPickerBusy atomic.Bool
}

func openApp(dataDir, root string) (*App, error) { return openAppForWorkspace(dataDir, root, nil) }
func openAppForWorkspace(dataDir, root string, remote *workspace.Client) (*App, error) {
	env, err := workspace.Open(dataDir, root, remote)
	if err != nil {
		return nil, err
	}
	tasks := task.New(env)
	sessions := session.New(env, tasks)
	projects := project.New(env)
	projects.ReserveWorktree = sessions.ReserveWorktree
	projects.TaskContextUpdated = task.WriteBriefContext
	return &App{Workspace: env, Tasks: tasks, Projects: projects, Sessions: sessions, token: model.NewID() + model.NewID(), pickDirectory: platform.PickDirectory}, nil
}

// Close releases the resources owned by this application, including partially
// initialized remote environments. Schedulers are stopped by their owner first.
func (a *App) Close() error {
	a.closeOnce.Do(func() {
		a.Workspace.Closing.Store(true)
		if a.Workspace.Remote != nil {
			a.Workspace.Remote.Close()
		}
		a.Sessions.Close()
		a.Projects.Close()
		a.closeErr = a.Workspace.Close()
	})
	return a.closeErr
}
