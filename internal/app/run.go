package app

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

// Run starts the desktop host, HTTP service, or workspace helper.
func Run() {
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
		if err := workspace.CredentialBridge(workspace.WindowsCredentialManager(), os.Args[2], os.Stdin, os.Stdout, os.Stderr); err != nil {
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
	data := flag.String("data", platform.DefaultDataDir(), "SQLite and launcher directory")
	root := flag.String("root", defaultRoot, "parent directory for workspaces")
	headless := flag.Bool("headless", runtime.GOOS != "windows", "run without the desktop window")
	interactive := flag.Bool("interactive-sessions", false, "enable legacy sidebar chat (Linux only)")
	stopService := flag.Bool("stop", false, "stop the background service when no Git operation is running")
	prepareUpgrade := flag.Bool("prepare-upgrade", false, "safely stop an existing backend before replacing installed files; succeed when already stopped")
	desktopStart := flag.Bool("desktop-start", false, "start or reuse the desktop backend and print its JSON handshake")
	flag.Parse()
	if *prepareUpgrade {
		if *desktopStart || *stopService || *interactive {
			log.Fatal("prepare-upgrade 不能与其他运行模式同时使用")
		}
		if err := prepareDesktopUpgrade(*data); err != nil {
			log.Fatal(err)
		}
		return
	}
	rootExplicit, listenExplicit := false, false
	flag.Visit(func(f *flag.Flag) {
		rootExplicit = rootExplicit || f.Name == "root"
		listenExplicit = listenExplicit || f.Name == "listen"
	})
	if *desktopStart {
		if *stopService || *interactive {
			log.Fatal("desktop-start 不能与 stop 或 interactive-sessions 同时使用")
		}
		if !listenExplicit {
			*addr = "127.0.0.1:0"
		}
		info, err := ensureDesktopService(*data, *root, *addr, rootExplicit)
		if err != nil {
			log.Fatal(err)
		}
		if err := json.NewEncoder(os.Stdout).Encode(info); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *stopService {
		if err := stopDesktopService(*data); err != nil {
			log.Fatal(err)
		}
		return
	}
	if runtime.GOOS == "windows" && !*headless {
		if err := runDesktopHost(*data, *root, *addr); err != nil {
			platform.ShowDesktopError(err)
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
	unlock, err := platform.LockDataDirectory(*data)
	if err != nil {
		if !*headless {
			if saved, readErr := os.ReadFile(filepath.Join(*data, "instance-url")); readErr == nil {
				if err := platform.ShowDesktop(strings.TrimSpace(string(saved)), *data); err == nil {
					return
				}
			}
		}
		log.Fatal("当前数据目录已由另一个实例使用：", err)
	}
	defer unlock()
	platform.ConfigureCommandEnvironment()
	a, err := openApp(*data, *root)
	if err != nil {
		log.Fatal(err)
	}
	defer a.Close()
	a.Workspace.ReadOnlySessions = !*interactive || runtime.GOOS != "linux"
	hub, err := newEnvironmentHub(a)
	if err != nil {
		log.Fatal(err)
	}
	defer hub.Close()
	srv := &http.Server{Addr: *addr, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a.shutdown = stop
	srv.Handler = a.handler()
	stopMasterSync := a.Projects.StartMasterSync(ctx)
	defer stopMasterSync()
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	address := "http://" + listener.Addr().String()
	_ = os.WriteFile(filepath.Join(*data, "instance-url"), []byte(address), 0600)
	defer os.Remove(filepath.Join(*data, "instance-url"))
	if err := writeDesktopService(*data, a.desktopInfo(address)); err != nil {
		log.Fatal(err)
	}
	defer os.Remove(filepath.Join(*data, "service.json"))
	log.Printf("Work Hub: %s | SQLite: %s | worktrees: %s", address, *data, a.Workspace.Root)
	go func() {
		if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Print(err)
			stop()
		}
	}()
	if !*headless {
		if err := platform.ShowDesktop(address, *data); err != nil {
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
