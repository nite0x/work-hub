package main

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
)

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
