package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed web/*
var assets embed.FS

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

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--workspace-agent" {
		if home, err := os.UserHomeDir(); err == nil {
			_ = os.Setenv("PATH", filepath.Join(home, ".local", "bin")+string(os.PathListSeparator)+os.Getenv("PATH"))
		}
		if err := runWorkspaceAgent(os.Stdin, os.Stdout); err != nil {
			log.Print(err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "credential-helper" {
		if len(os.Args) != 3 {
			fmt.Fprintln(os.Stderr, "凭证助手需要 get/store/erase 操作")
			os.Exit(1)
		}
		if err := credentialBridge(windowsCredentialManager(), os.Args[2], os.Stdin, os.Stdout, os.Stderr); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	home, _ := os.UserHomeDir()
	defaultRoot := filepath.Join(home, "workspaces")
	defaultAddress := "127.0.0.1:4317"
	if runtime.GOOS == "windows" {
		defaultAddress = "127.0.0.1:0"
	}
	addr := flag.String("listen", defaultAddress, "local HTTP address")
	data := flag.String("data", defaultDataDir(), "SQLite and launcher directory")
	root := flag.String("root", defaultRoot, "parent directory for workspaces")
	headless := flag.Bool("headless", runtime.GOOS != "windows", "run without the desktop window")
	interactive := flag.Bool("interactive-sessions", false, "enable legacy sidebar chat (Linux only)")
	stopService := flag.Bool("stop", false, "stop the background service when no Git operation is running")
	flag.Parse()
	if *stopService {
		if err := stopDesktopService(*data); err != nil {
			log.Fatal(err)
		}
		return
	}
	if runtime.GOOS == "windows" && !*headless {
		if err := runDesktopHost(*data, *root, *addr); err != nil {
			showDesktopError(err)
			os.Exit(1)
		}
		return
	}
	host, _, err := net.SplitHostPort(*addr)
	if err != nil || (host != "localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback())) {
		log.Fatal("listen 必须是本地回环地址")
	}
	if err := os.MkdirAll(*data, 0700); err != nil {
		log.Fatal(err)
	}
	unlock, err := lockDataDirectory(*data)
	if err != nil {
		if !*headless {
			if saved, readErr := os.ReadFile(filepath.Join(*data, "instance-url")); readErr == nil {
				if err := showDesktop(strings.TrimSpace(string(saved)), *data); err == nil {
					return
				}
			}
		}
		log.Fatal("当前数据目录已由另一个实例使用：", err)
	}
	defer unlock()
	a, err := openApp(*data, *root)
	if err != nil {
		log.Fatal(err)
	}
	defer a.db.Close()
	defer a.stateCache.close()
	defer a.closeChats()
	defer a.closeBridges()
	a.readOnlySessions = !*interactive || runtime.GOOS == "windows"
	hub, err := newEnvironmentHub(a)
	if err != nil {
		log.Fatal(err)
	}
	defer hub.close()
	srv := &http.Server{Addr: *addr, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a.shutdown = stop
	srv.Handler = a.handler()
	stopMasterSync := a.startMasterSync(ctx)
	defer stopMasterSync()
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	address := "http://" + listener.Addr().String()
	_ = os.WriteFile(filepath.Join(*data, "instance-url"), []byte(address), 0600)
	defer os.Remove(filepath.Join(*data, "instance-url"))
	info, _ := json.Marshal(desktopServiceInfo{URL: address, Token: a.token, PID: os.Getpid()})
	if err := os.WriteFile(filepath.Join(*data, "service.json"), info, 0600); err != nil {
		log.Fatal(err)
	}
	defer os.Remove(filepath.Join(*data, "service.json"))
	log.Printf("Work Hub: %s | SQLite: %s | worktrees: %s", address, *data, a.root)
	go func() {
		if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Print(err)
			stop()
		}
	}()
	if !*headless {
		if err := showDesktop(address, *data); err != nil {
			log.Print(err)
		}
		stop()
	}
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		_ = srv.Close()
	}
}

func (a *App) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/state", a.stateHandler)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Worktree-Hub-Instance")), []byte(a.token)) != 1 {
			writeError(w, 403, "实例认证失败")
			return
		}
		writeJSON(w, 200, map[string]any{"name": "worktree-hub", "pid": os.Getpid()})
	})
	if a.shutdown != nil {
		mux.HandleFunc("POST /api/service/stop", a.stopServiceHandler)
	}
	if a.environments != nil {
		mux.HandleFunc("GET /api/environments", a.environments.listHandler)
		mux.HandleFunc("POST /api/environments", a.environments.addHandler)
		mux.HandleFunc("POST /api/environments/{environment}/reconnect", a.environments.reconnectHandler)
	}
	mux.HandleFunc("PUT /api/settings/terminal", a.terminalSettingsHandler)
	mux.HandleFunc("PUT /api/settings/master-sync", a.masterSyncSettingsHandler)
	mux.HandleFunc("POST /api/projects", a.invalidateStateAfter(a.addProjectHandler))
	mux.HandleFunc("DELETE /api/projects/{id}", a.invalidateStateAfter(a.removeProjectHandler))
	mux.HandleFunc("GET /api/projects/{id}/git", a.gitOverviewHandler)
	mux.HandleFunc("POST /api/projects/{id}/git", a.invalidateStateAfter(a.gitActionHandler))
	mux.HandleFunc("POST /api/projects/{id}/worktrees", a.invalidateStateAfter(a.createWorktreeHandler))
	mux.HandleFunc("POST /api/requirements", a.invalidateStateAfter(a.createRequirementHandler))
	mux.HandleFunc("POST /api/requirements/{id}/projects", a.invalidateStateAfter(a.addRequirementProjectsHandler))
	mux.HandleFunc("POST /api/requirements/{id}/retry", a.invalidateStateAfter(a.retryHandler))
	mux.HandleFunc("POST /api/requirements/{id}/archive", a.archiveHandler)
	mux.HandleFunc("GET /api/requirements/{id}/launch", a.launchPlanHandler)
	mux.HandleFunc("POST /api/requirements/{id}/launch", a.launchHandler)
	mux.HandleFunc("GET /api/codex/sessions", a.codexSessionsHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions", a.requirementSessionsHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions", a.linkSessionHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/new", a.newSessionHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/resume", a.resumeSessionHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/history", a.sessionHistoryHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/history/events", a.sessionHistoryEventsHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/chat", a.chatStateHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat", a.chatStartHandler)
	mux.HandleFunc("GET /api/requirements/{id}/sessions/{session}/chat/events", a.chatEventsHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat/stop", a.chatStopHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat/approval", a.chatApprovalHandler)
	mux.HandleFunc("POST /api/requirements/{id}/sessions/{session}/chat/handoff", a.chatHandoffHandler)
	web, _ := fs.Sub(assets, "web")
	static := http.FileServer(http.FS(web))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			static.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		b, _ := assets.ReadFile("web/index.html")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		page := strings.ReplaceAll(string(b), "__CSRF_TOKEN__", a.token)
		mode := "interactive"
		if a.readOnlySessions {
			mode = "read-only"
			page = strings.ReplaceAll(page, `<script src="/session-chat.js" defer></script>`, "")
			page = strings.ReplaceAll(page, `<script src="/session-create.js" defer></script>`, "")
		}
		_, _ = w.Write([]byte(strings.ReplaceAll(page, "__SESSION_MODE__", mode)))
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		h := r.Host
		if host, _, err := net.SplitHostPort(h); err == nil {
			h = host
		}
		if h != "localhost" && (net.ParseIP(h) == nil || !net.ParseIP(h).IsLoopback()) {
			writeError(w, 403, "仅允许本地访问")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(a.token)) != 1 {
				writeError(w, 403, "页面已过期，请刷新后重试")
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != r.Host || u.Scheme != "http" {
					writeError(w, 403, "拒绝跨站请求")
					return
				}
			}
			if a.readOnlySessions && (strings.Contains(r.URL.Path, "/chat") || strings.HasSuffix(r.URL.Path, "/sessions/new")) {
				writeError(w, 405, "会话内容仅供查看，请在终端中对话")
				return
			}
			if a.closing.Load() {
				writeError(w, 503, "后台正在退出，请稍后重新打开应用")
				return
			}
		}
		if a.workspace != nil {
			r = r.WithContext(withWorkspace(r.Context(), a.workspace))
		}
		if a.environments != nil && strings.HasPrefix(r.URL.Path, "/api/") && !strings.HasPrefix(r.URL.Path, "/api/environments") {
			if id := r.Header.Get("X-Environment-ID"); id != "" && id != "local" {
				app, err := a.environments.get(id)
				if err != nil {
					writeError(w, 503, err.Error())
					return
				}
				app.handler().ServeHTTP(w, r)
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		writeError(w, 400, "请求格式不正确："+err.Error())
		return false
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		writeError(w, 400, "请求只能包含一个 JSON 对象")
		return false
	}
	return true
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
func dbError(w http.ResponseWriter, err error) {
	log.Print(err)
	writeError(w, 500, "保存数据失败，请查看服务日志")
}
func now() string { return time.Now().UTC().Format(time.RFC3339) }
func mustAffected(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("记录不存在")
	}
	return nil
}
