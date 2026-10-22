package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type App struct {
	db                   *sql.DB
	root, dataDir, token string
	mu                   sync.Mutex
	stateCache           *stateCache
	launch               func(LaunchPlan) error
	credentialHelper     string
	openSessions         func(context.Context) (sessionClient, error)
	openLive             func(context.Context) (liveClient, error)
	watchHistory         func(context.Context, string, func(HistoryPush) error) error
	terminalConflict     func(string, string) error
	chatMu               sync.Mutex
	chats                map[string]*ChatRun
	createChatMu         sync.Mutex
	bridgeMu             sync.Mutex
	controlMu            sync.Mutex
	bridges              map[string]*terminalBridge
	masterSyncMu         sync.Mutex
	readOnlySessions     bool
	workspace            *workspaceClient
	environments         *environmentHub
	shutdown             func()
	closing              atomic.Bool
}

func newID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func openApp(dataDir, root string) (*App, error) {
	return openAppForWorkspace(dataDir, root, nil)
}

func openAppForWorkspace(dataDir, root string, workspace *workspaceClient) (*App, error) {
	var err error
	if dataDir, err = filepath.Abs(dataDir); err != nil {
		return nil, err
	}
	ctx := context.Background()
	if workspace != nil {
		ctx = withWorkspace(ctx, workspace)
		if root == "~" {
			root = workspace.identity.Home
		} else if strings.HasPrefix(root, "~/") {
			root = joinWorkspacePath(workspace.identity.Home, root[2:])
		}
		if !strings.HasPrefix(root, "/") {
			return nil, fmt.Errorf("WSL 工作区根目录必须是 Linux 绝对路径或 ~/ 开头的路径")
		}
		root = cleanWorkspacePath(root)
	} else if root, err = filepath.Abs(root); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, err
	}
	if err := workspaceMkdir(ctx, root, 0700, true); err != nil {
		return nil, err
	}
	if root, err = workspaceEval(ctx, root); err != nil {
		return nil, err
	}
	dbPath := filepath.ToSlash(filepath.Join(dataDir, "worktree-hub.db"))
	if !strings.HasPrefix(dbPath, "/") {
		dbPath = "/" + dbPath
	}
	dbURL := &url.URL{Scheme: "file", Path: dbPath}
	db, err := sql.Open("sqlite", dbURL.String()+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	a := &App{db: db, root: root, dataDir: dataDir, token: newID() + newID(), credentialHelper: credentialHelperCommand(), workspace: workspace}
	a.launch = a.launchTerminal
	a.openSessions = openCodexClient
	a.openLive = openLiveCodex
	a.watchHistory = watchCodexHistory
	a.terminalConflict = terminalSessionConflict
	a.chats = map[string]*ChatRun{}
	a.bridges = map[string]*terminalBridge{}
	if err := a.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	// A crash can interrupt filesystem work. Preserve the records and require explicit retry.
	_, err = db.Exec(`UPDATE requirements SET state='partial' WHERE state='creating'; UPDATE members SET state='failed', error='上次创建被中断，请检查后重试' WHERE state='creating'; UPDATE master_sync_runs SET status='interrupted' WHERE status='running'`)
	if err != nil {
		db.Close()
		return nil, err
	}
	a.stateCache = newStateCache()
	if workspace != nil {
		a.watchHistory = workspace.watchHistory
		a.credentialHelper = workspace.identity.CredentialHelper
		a.openSessions = func(ctx context.Context) (sessionClient, error) {
			return &workspaceSessions{ctx: ctx, client: workspace}, nil
		}
		a.stateCache.ctx = withWorkspace(a.stateCache.ctx, workspace)
		a.stateCache.resolve = func(settings TerminalSettings) TerminalAvailability {
			var result TerminalAvailability
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := workspace.call(ctx, workspaceRequest{Op: "terminal-availability", Settings: settings}, &result); err != nil {
				return TerminalAvailability{Settings: settings, Message: err.Error()}
			}
			return result
		}
	}
	return a, nil
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }
