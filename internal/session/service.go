// Package session owns session links, history, chat runs and terminal handoff.
package session

import (
	"context"
	"strings"
	"sync"
	"time"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

type LaunchPlanner interface {
	MakeLaunchPlan(context.Context, string) (model.LaunchPlan, error)
}

type Service struct {
	Workspace        *workspace.Service
	plans            LaunchPlanner
	openSessions     func(context.Context) (codex.SessionClient, error)
	openLive         func(context.Context) (codex.LiveClient, error)
	watchHistory     func(context.Context, string, func(HistoryPush) error) error
	terminalConflict func(string, string) error
	openExternal     func(string) error
	chatMu           sync.Mutex
	chats            map[string]*ChatRun
	createChatMu     sync.Mutex
	bridgeMu         sync.Mutex
	controlMu        sync.Mutex
	bridges          map[string]*terminalBridge
}

func New(environment *workspace.Service, plans LaunchPlanner) *Service {
	s := &Service{Workspace: environment, plans: plans, openSessions: codex.OpenSessionClient, openLive: codex.OpenLive, watchHistory: WatchCodexHistory, terminalConflict: terminalSessionConflict, openExternal: platform.OpenExternal, chats: map[string]*ChatRun{}, bridges: map[string]*terminalBridge{}}
	if environment.Remote != nil {
		s.openLive = environment.Remote.OpenCodex
		s.terminalConflict = func(id, cwd string) error {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			return environment.Remote.Call(ctx, workspace.Request{Op: "session-conflict", Path: cwd, Method: id}, nil)
		}
		s.openSessions = func(ctx context.Context) (codex.SessionClient, error) {
			return &workspace.Sessions{Context: ctx, Client: environment.Remote}, nil
		}
		s.watchHistory = func(ctx context.Context, id string, emit func(HistoryPush) error) error {
			return watchRemoteHistory(ctx, environment.Remote, id, emit)
		}
	}
	return s
}

// A launcher can exit after accepting the request. Only release an unused
// reservation; an already connected terminal retains its ownership.
func (s *Service) releaseUnconnectedBridge(plan model.LaunchPlan) {
	if len(plan.Args) == 0 {
		return
	}
	s.bridgeMu.Lock()
	b := s.bridges[strings.TrimPrefix(plan.Args[len(plan.Args)-1], "unix://")]
	s.bridgeMu.Unlock()
	if b == nil {
		return
	}
	b.mu.Lock()
	unused := !b.connected
	if unused {
		b.revoked = true
	}
	b.mu.Unlock()
	if unused {
		b.Close()
	}
}

func (s *Service) Close() { s.CloseChats(); s.CloseBridges() }
