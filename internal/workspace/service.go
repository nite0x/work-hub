package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/store"
)

// Service is one execution environment. Every business service in an
// environment shares its storage and mutation lock, including background Git.
type Service struct {
	Store            *store.Store
	Root, DataDir    string
	Mu               sync.Mutex
	Remote           *Client
	ReadOnlySessions bool
	Closing          atomic.Bool
	Launch           func(model.LaunchPlan, func()) error
	terminal         *terminalCache
	closeOnce        sync.Once
	closeErr         error
}

func Open(dataDir, root string, remote *Client) (*Service, error) {
	var err error
	if dataDir, err = filepath.Abs(dataDir); err != nil {
		return nil, err
	}
	ctx := context.Background()
	if remote != nil {
		ctx = WithClient(ctx, remote)
		if root == "~" {
			root = remote.Identity.Home
		} else if strings.HasPrefix(root, "~/") {
			root = platform.JoinWorkspacePath(remote.Identity.Home, root[2:])
		}
		if !strings.HasPrefix(root, "/") {
			return nil, fmt.Errorf("WSL 工作区根目录必须是 Linux 绝对路径或 ~/ 开头的路径")
		}
		root = platform.CleanWorkspacePath(root)
	} else if root, err = filepath.Abs(root); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, err
	}
	if err := Mkdir(ctx, root, 0700, true); err != nil {
		return nil, err
	}
	if root, err = Eval(ctx, root); err != nil {
		return nil, err
	}
	db, err := store.Open(dataDir)
	if err != nil {
		return nil, err
	}
	s := &Service{Store: db, Root: root, DataDir: dataDir, Remote: remote}
	s.terminal = newTerminalCache(s.resolveTerminal)
	s.Launch = s.LaunchTerminal
	return s, nil
}

func (s *Service) ResolveTerminal(settings model.TerminalSettings) model.TerminalAvailability {
	return s.resolveTerminal(context.Background(), settings)
}
func (s *Service) resolveTerminal(ctx context.Context, settings model.TerminalSettings) model.TerminalAvailability {
	if s.Remote == nil {
		return Availability(settings)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var result model.TerminalAvailability
	if err := s.Remote.Call(ctx, Request{Op: "terminal-availability", Settings: settings}, &result); err != nil {
		return model.TerminalAvailability{Settings: settings, Message: err.Error()}
	}
	return result
}

func (s *Service) Close() error {
	s.closeOnce.Do(func() {
		s.Closing.Store(true)
		if s.Remote != nil {
			s.Remote.Close()
		}
		if s.terminal != nil {
			s.terminal.Close()
		}
		s.Mu.Lock()
		defer s.Mu.Unlock()
		if s.Store != nil {
			s.closeErr = s.Store.DB.Close()
		}
	})
	return s.closeErr
}
func (s *Service) TerminalSnapshot(settings model.TerminalSettings, force bool) (model.TerminalAvailability, bool) {
	return s.terminal.snapshot(settings, force)
}
